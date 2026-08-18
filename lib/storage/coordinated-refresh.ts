import { extractAccountUserId } from "../auth/token-utils.js";
import { queuedRefresh } from "../refresh-queue.js";
import type { TokenResult } from "../types.js";
import {
	findAccountIndexByIdentityKeys,
	toAccountIdentityKeys,
} from "./identity.js";
import {
	withAccountStorageTransaction,
	withFlaggedAccountStorageTransaction,
} from "../storage.js";
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

function stableIdentityKeys(identity: PersistedRefreshIdentity): string[] {
	const keys = toAccountIdentityKeys(identity).filter(
		(key) => !key.startsWith("refreshToken:"),
	);
	const seatKey = keys.find((key) => key.startsWith("seat:"));
	return seatKey ? [seatKey] : keys;
}

function findRefreshTarget(
	accounts: AccountMetadataV3[],
	identity: PersistedRefreshIdentity,
): number {
	const stableKeys = stableIdentityKeys(identity);
	if (stableKeys.length > 0) {
		return findAccountIndexByIdentityKeys(accounts, stableKeys);
	}

	const matchingTokenIndexes = accounts.flatMap((account, index) =>
		account.refreshToken === identity.refreshToken ? [index] : [],
	);
	if (matchingTokenIndexes.length > 0) {
		return matchingTokenIndexes[0] ?? -1;
	}
	throw new Error(
		"Refresh identity is ambiguous after the persisted token rotated",
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

async function refreshCurrentStorage<T extends { accounts: AccountMetadataV3[] }>(
	identity: PersistedRefreshIdentity,
	current: T,
	persist: (storage: T) => Promise<void>,
): Promise<CoordinatedRefreshResult> {
	const index = findRefreshTarget(current.accounts, identity);
	const target = current.accounts[index];
	if (!target) {
		throw new Error("Account was removed before its token could refresh");
	}
	let currentRefreshToken = identity.refreshToken;
	if (
		target.refreshToken !== identity.refreshToken &&
		target.accessToken &&
		target.expiresAt !== undefined &&
		target.expiresAt > Date.now()
	) {
		return adoptPersistedRotation(target);
	}
	currentRefreshToken = target.refreshToken;

	const refreshResult = await queuedRefresh(currentRefreshToken);
	if (refreshResult.type !== "success") {
		return refreshResult;
	}

	const rotated = refreshResult.refresh !== currentRefreshToken;
	const targetMemberId = identity.accountUserId?.trim() || target.accountUserId?.trim();
	const siblings = current.accounts.filter(
		(account) =>
			account.refreshToken === currentRefreshToken &&
			(!targetMemberId ||
				!account.accountUserId?.trim() ||
				account.accountUserId.trim() === targetMemberId),
	);
	const rotatedAt = rotated ? nextRotationTimestamp(siblings) : undefined;
	if (rotated) {
		for (const sibling of siblings) {
			sibling.refreshToken = refreshResult.refresh;
			sibling.expiresAt = 0;
			sibling.tokenRotatedAt = rotatedAt;
		}
	}

	target.refreshToken = refreshResult.refresh;
	target.accountUserId =
		extractAccountUserId(refreshResult.access) ?? target.accountUserId;
	target.accessToken = refreshResult.access;
	target.expiresAt = refreshResult.expires;
	if (rotatedAt !== undefined) {
		target.tokenRotatedAt = rotatedAt;
	}
	await persist(current);

	return {
		...refreshResult,
		adopted: false,
		rotatedAt,
	};
}

export async function coordinatePersistedRefresh(
	identity: PersistedRefreshIdentity,
): Promise<CoordinatedRefreshResult> {
	return withAccountStorageTransaction(async (current, persist) => {
		if (!current) {
			throw new Error("Account storage is unavailable");
		}
		return refreshCurrentStorage(identity, current, persist);
	});
}

export async function coordinateFlaggedPersistedRefresh(
	identity: PersistedRefreshIdentity,
): Promise<CoordinatedRefreshResult> {
	return withFlaggedAccountStorageTransaction(async (current, persist) => {
		return refreshCurrentStorage(identity, current, persist);
	});
}
