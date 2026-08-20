import { extractAccountUserId } from "../auth/token-utils.js";
import { queuedRefresh } from "../refresh-queue.js";
import { logWarn } from "../logger.js";
import { StorageTransactionContentionError } from "../errors.js";
import type { TokenResult } from "../types.js";
import {
	findAccountIndexByIdentityKeys,
	toAccountIdentityKeys,
} from "./identity.js";
import {
	getStoragePath,
	withAccountStorageTransaction,
	withFlaggedAccountStorageTransaction,
	type AccountStorageV3,
	type FlaggedAccountStorageV1,
} from "../storage.js";
import { withRefreshLease } from "./transaction-lock.js";
import type { AccountMetadataV3 } from "./migrations.js";

export type PersistedRefreshIdentity = Pick<
	AccountMetadataV3,
	"organizationId" | "accountId" | "accountUserId" | "refreshToken"
>;

export type CoordinatedRefreshSuccess = Extract<TokenResult, { type: "success" }> & {
	readonly adopted: boolean;
	readonly rotatedAt?: number;
};

export type CoordinatedRefreshResult =
	| CoordinatedRefreshSuccess
	| Exclude<TokenResult, { type: "success" }>;

/**
 * How many times the durable commit is retried after the provider exchange has
 * already consumed the single-use refresh token. Losing the replacement at this
 * point would leave the account dead until the user logs in again, so the commit
 * is far more worth retrying than the acquisition was.
 */
const COMMIT_ATTEMPTS = 3;

function stableIdentityKeys(identity: PersistedRefreshIdentity): string[] {
	return toAccountIdentityKeys(identity).filter(
		(key) => !key.startsWith("refreshToken:"),
	);
}

function indexesMatchingKey(
	accounts: AccountMetadataV3[],
	key: string,
): number[] {
	return accounts.flatMap((account, index) =>
		toAccountIdentityKeys(account).includes(key) ? [index] : [],
	);
}

/**
 * Resolve the single stored record that a rotated refresh token must be written
 * to.
 *
 * Exact refresh-token matches are tried first: the caller is holding that token,
 * so a record carrying it is unambiguously the right target. Identity keys are
 * only a fallback for the case where the token has already rotated on disk, and
 * are only trusted when they resolve to exactly ONE record. A bare
 * `organizationId:` key routinely matches several records — a Business org with
 * two seats is stored as two accounts — and guessing there would exchange and
 * overwrite a different seat's credentials.
 */
function findRefreshTarget(
	accounts: AccountMetadataV3[],
	identity: PersistedRefreshIdentity,
): number {
	const keys = stableIdentityKeys(identity);

	// A seat key (`organizationId|accountId|accountUserId`) pins exactly one
	// member, so when the caller has one it is the ONLY key considered. Widening
	// to a workspace-level key here would resolve a *different* seat in the same
	// org, and a miss must stay a miss: the account really was removed.
	const seatKey = keys.find((key) => key.startsWith("seat:"));
	if (seatKey) {
		return findAccountIndexByIdentityKeys(accounts, [seatKey]);
	}

	for (const key of keys) {
		const matches = indexesMatchingKey(accounts, key);
		if (matches.length === 1) return matches[0] ?? -1;
		if (matches.length > 1) {
			// A bare `organizationId:` key matches every seat in a Business org, so
			// picking the first would exchange and overwrite another member's
			// credentials. The exact token the caller holds is the only safe
			// tiebreaker; without it, refuse rather than guess.
			const tokenMatch = matches.find(
				(index) => accounts[index]?.refreshToken === identity.refreshToken,
			);
			if (tokenMatch !== undefined) return tokenMatch;
			throw new Error(
				"Refresh identity is ambiguous after the persisted token rotated",
			);
		}
	}

	// No stable identity at all: the refresh token is the only handle available.
	const tokenMatches = accounts.flatMap((account, index) =>
		account.refreshToken === identity.refreshToken ? [index] : [],
	);
	if (tokenMatches.length > 0) return tokenMatches[0] ?? -1;

	throw new Error(
		"Refresh identity is ambiguous after the persisted token rotated",
	);
}

/**
 * A stored record can be adopted instead of exchanged when another process has
 * already rotated the token AND left a usable access token behind.
 */
function canAdopt(
	target: AccountMetadataV3,
	identity: PersistedRefreshIdentity,
): boolean {
	return (
		target.refreshToken !== identity.refreshToken &&
		Boolean(target.accessToken) &&
		target.expiresAt !== undefined &&
		target.expiresAt > Date.now()
	);
}

function adoptPersistedRotation(
	target: AccountMetadataV3,
): CoordinatedRefreshSuccess {
	if (!target.accessToken || target.expiresAt === undefined) {
		throw new Error("Persisted rotated credentials are incomplete");
	}
	return {
		type: "success",
		access: target.accessToken,
		refresh: target.refreshToken,
		expires: target.expiresAt,
		// Carried so consumers that read these off a refresh result behave the same
		// on the adopt path as on the exchange path: `index.ts` hydration derives
		// the account email from `idToken` and the stored scope from `scope`, and
		// `proactive-refresh.ts` rebuilds a TokenResult from all three.
		...(target.oauthScope ? { scope: target.oauthScope } : {}),
		multiAccount: true,
		adopted: true,
		rotatedAt: target.tokenRotatedAt,
	};
}

function nextRotationTimestamp(accounts: AccountMetadataV3[]): number {
	const latest = accounts.reduce(
		(maximum, account) => Math.max(maximum, account.tokenRotatedAt ?? 0),
		0,
	);
	return Math.max(Date.now(), latest + 1);
}

interface StorageShape {
	accounts: AccountMetadataV3[];
}

type TransactionRunner<T extends StorageShape> = <R>(
	handler: (current: T, persist: (storage: T) => Promise<void>) => Promise<R>,
) => Promise<R>;

/**
 * Apply a completed exchange to the freshly loaded storage.
 *
 * `persistAccessToken` is false for flagged storage: `normalizeFlaggedStorage`
 * intentionally keeps quarantined records credential-light, so writing a live
 * access token there would put it on disk only for it to be dropped on the next
 * read.
 */
function commitRotation(
	current: StorageShape,
	identity: PersistedRefreshIdentity,
	exchangedToken: string,
	refreshResult: Extract<TokenResult, { type: "success" }>,
	persistAccessToken: boolean,
): number | undefined {
	const index = findRefreshTarget(current.accounts, identity);
	const target = current.accounts[index];
	if (!target) {
		throw new Error("Account was removed before its token could refresh");
	}

	const rotated = refreshResult.refresh !== exchangedToken;
	const targetMemberId = identity.accountUserId?.trim() || target.accountUserId?.trim();
	const siblings = current.accounts.filter(
		(account) =>
			account.refreshToken === exchangedToken &&
			(!targetMemberId ||
				!account.accountUserId?.trim() ||
				account.accountUserId.trim() === targetMemberId),
	);
	const rotatedAt = rotated ? nextRotationTimestamp(current.accounts) : undefined;
	if (rotated) {
		for (const sibling of siblings) {
			// Siblings share the OAuth grant but can belong to distinct orgs, so they
			// get the rotated refresh token and an expired access token — never the
			// target's access token, which is scoped to the target's workspace. The
			// zeroed expiry forces each sibling to run its own exchange with the
			// now-current token when it is next selected.
			sibling.refreshToken = refreshResult.refresh;
			sibling.expiresAt = 0;
			sibling.tokenRotatedAt = rotatedAt;
		}
	}

	target.refreshToken = refreshResult.refresh;
	target.accountUserId =
		extractAccountUserId(refreshResult.access) ?? target.accountUserId;
	if (persistAccessToken) {
		target.accessToken = refreshResult.access;
		target.expiresAt = refreshResult.expires;
	} else {
		delete target.accessToken;
		delete target.expiresAt;
	}
	if (refreshResult.scope) {
		target.oauthScope = refreshResult.scope;
	}
	if (rotatedAt !== undefined) {
		target.tokenRotatedAt = rotatedAt;
	}
	return rotatedAt;
}

/**
 * Refresh a persisted credential without holding a storage lease across the
 * provider round trip.
 *
 * Phases:
 *  1. short storage transaction — adopt a rotation another process already
 *     committed, and otherwise read the current token;
 *  2. refresh lease — serializes the exchange itself across processes, because
 *     refresh tokens are single-use;
 *  3. short storage transaction — re-check (the winner of the lease may have
 *     just done the work), then exchange with no storage lease held, then
 *     commit in a final short transaction.
 *
 * Only phases 1 and 3 touch the storage lease, and each holds it for a local
 * read/write. Unrelated writers (`codex-note`, `codex-tag`, account toggles,
 * rotation stamps, TUI quota writes) therefore never queue behind a network
 * call.
 */
async function coordinateRefresh<T extends StorageShape>(
	identity: PersistedRefreshIdentity,
	runTransaction: TransactionRunner<T>,
	persistAccessToken: boolean,
): Promise<CoordinatedRefreshResult> {
	type Probe =
		| { kind: "adopt"; result: CoordinatedRefreshSuccess }
		| { kind: "exchange"; token: string };

	const probe = (): Promise<Probe> =>
		runTransaction<Probe>((current) => {
			const index = findRefreshTarget(current.accounts, identity);
			const target = current.accounts[index];
			if (!target) {
				throw new Error("Account was removed before its token could refresh");
			}
			if (canAdopt(target, identity)) {
				return Promise.resolve<Probe>({
					kind: "adopt",
					result: adoptPersistedRotation(target),
				});
			}
			return Promise.resolve<Probe>({
				kind: "exchange",
				token: target.refreshToken,
			});
		});

	return withRefreshLease(getStoragePath(), async () => {
		// Probed INSIDE the lease, not before it: whoever held the lease may have
		// just committed a rotation, and reading first would race with them. The
		// lease is a local file operation, so paying for it up front is cheaper
		// than an avoidable second exchange of a single-use token.
		const current = await probe();
		if (current.kind === "adopt") return current.result;

		const exchangedToken = current.token;
		const refreshResult = await queuedRefresh(exchangedToken);
		if (refreshResult.type !== "success") {
			return refreshResult;
		}

		// The provider has now invalidated `exchangedToken`, so losing the
		// replacement here would kill the account until the user logs in again.
		// Contention is the one failure worth retrying: a real I/O error (a full
		// disk, a read-only volume) will not resolve itself, and swallowing it
		// behind retries would just delay reporting it.
		let rotatedAt: number | undefined;
		for (let attempt = 1; ; attempt += 1) {
			try {
				rotatedAt = await runTransaction<number | undefined>(
					async (current, persist) => {
						const stamp = commitRotation(
							current,
							identity,
							exchangedToken,
							refreshResult,
							persistAccessToken,
						);
						await persist(current);
						return stamp;
					},
				);
				break;
			} catch (error) {
				const retryable =
					error instanceof StorageTransactionContentionError &&
					attempt < COMMIT_ATTEMPTS;
				if (!retryable) throw error;
				logWarn(
					`Retrying the commit of a rotated refresh token (attempt ${attempt}/${COMMIT_ATTEMPTS}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		return { ...refreshResult, adopted: false, rotatedAt };
	});
}

const runAccountTransaction: TransactionRunner<AccountStorageV3> = (handler) =>
	withAccountStorageTransaction(async (current, persist) => {
		if (!current) {
			throw new Error("Account storage is unavailable");
		}
		return handler(current, persist);
	});

const runFlaggedTransaction: TransactionRunner<FlaggedAccountStorageV1> = (handler) =>
	withFlaggedAccountStorageTransaction((current, persist) => handler(current, persist));

export async function coordinatePersistedRefresh(
	identity: PersistedRefreshIdentity,
): Promise<CoordinatedRefreshResult> {
	return coordinateRefresh(identity, runAccountTransaction, true);
}

export async function coordinateFlaggedPersistedRefresh(
	identity: PersistedRefreshIdentity,
): Promise<CoordinatedRefreshResult> {
	return coordinateRefresh(identity, runFlaggedTransaction, false);
}
