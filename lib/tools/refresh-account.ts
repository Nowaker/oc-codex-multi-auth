/**
 * Shared token refresh persistence for the account-management tools.
 *
 * OpenAI refresh tokens are single-use and rotate on exchange. Production
 * refreshes flow through `coordinatePersistedRefresh()`, which owns the
 * authoritative reload, exchange, and durable commit under one lease.
 */

import { extractAccountUserId } from "../auth/token-utils.js";
import {
	withAccountStorageTransaction,
	type AccountMetadataV3,
} from "../storage.js";
import {
	findAccountIndexByIdentityKeys,
	toAccountIdentityKeys,
} from "../storage/identity.js";
import type { TokenResult } from "../types.js";
import { coordinatePersistedRefresh } from "../storage/coordinated-refresh.js";

export interface RefreshAccountIdentity {
	organizationId?: string;
	accountId?: string;
	accountUserId?: string;
	refreshToken: string;
}

export interface RefreshAccountInput {
	index: number;
	identity: RefreshAccountIdentity;
	enabled?: boolean;
}

export interface PersistedRefreshResult {
	index: number;
	identity: RefreshAccountIdentity;
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
	rotatedAt?: number;
	persisted: boolean;
	persistError?: string;
}

export type AccountRefreshOutcome =
	| { status: "skipped"; index: number; identity: RefreshAccountIdentity }
	| { status: "failed"; index: number; identity: RefreshAccountIdentity; error: string }
	| { status: "refreshed"; index: number; result: PersistedRefreshResult };

export function findAccountIndexByIdentity(
	accounts: RefreshAccountIdentity[],
	identity: RefreshAccountIdentity,
): number {
	return findAccountIndexByIdentityKeys(accounts, toAccountIdentityKeys(identity));
}

/**
 * Persists one successful refresh in a short storage transaction. The account
 * is re-located from a freshly re-read snapshot, and sibling accounts that
 * share the consumed single-use refresh token are rotated atomically with it.
 */
export async function persistRefreshResult(
	index: number,
	identity: RefreshAccountIdentity,
	refreshResult: Extract<TokenResult, { type: "success" }>,
): Promise<PersistedRefreshResult> {
	const rotated = refreshResult.refresh !== identity.refreshToken;
	const rotatedAt = rotated ? Date.now() : undefined;

	try {
		return await withAccountStorageTransaction(async (current, persist) => {
			if (!current) {
				throw new Error("Account storage is unavailable");
			}
			const idx = findAccountIndexByIdentity(current.accounts, identity);
			if (idx < 0) {
				throw new Error("Account was removed while its token was refreshing");
			}
			const target = current.accounts[idx];
			if (!target) {
				throw new Error("Account was removed while its token was refreshing");
			}
			if (target.refreshToken === identity.refreshToken) {
				if (rotated) {
					// A login can produce sibling org/workspace records sharing one
					// single-use refresh token. Mirror the account-state propagation used
					// by request-time refresh: update those records with the new token and
					// expire their workspace-specific access tokens so they refresh cleanly.
					// Do this before assigning the target, since siblings are matched by
					// the consumed token and the target starts with that token too.
					for (const sibling of current.accounts) {
						if (sibling === target) continue;
						if (sibling.refreshToken !== identity.refreshToken) continue;
						sibling.refreshToken = refreshResult.refresh;
						sibling.expiresAt = 0;
						if (rotatedAt !== undefined) {
							sibling.tokenRotatedAt = rotatedAt;
						}
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
			} else if (target.refreshToken === refreshResult.refresh) {
				// A sibling account in this process just persisted the same rotation
				// and propagated the new token to this workspace record. Apply only
				// this workspace's freshly returned access token; do not overwrite
				// non-credential state in the fresh snapshot.
				target.accessToken = refreshResult.access;
				target.accountUserId =
					extractAccountUserId(refreshResult.access) ?? target.accountUserId;
				target.expiresAt = refreshResult.expires;
			} else {
				// The refresh was keyed off `identity.refreshToken` (the consumed,
				// pre-rotation value). If storage carries neither that token nor the
				// exact rotation returned by this refresh, another process rotated
				// this credential while this network-bound refresh was in flight. We
				// cannot know which resulting chain is live, so fail this
				// verification rather than clobber whatever the other process wrote.
				throw new Error(
					"Refresh token changed concurrently while verification was in progress",
				);
			}

			await persist(current);
			return {
				index,
				identity,
				refreshToken: refreshResult.refresh,
				accessToken: refreshResult.access,
				expiresAt: refreshResult.expires,
				rotatedAt,
				persisted: true,
			};
		});
	} catch (error) {
		return {
			index,
			identity,
			refreshToken: refreshResult.refresh,
			accessToken: refreshResult.access,
			expiresAt: refreshResult.expires,
			rotatedAt,
			persisted: false,
			persistError: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Refreshes one account and persists the rotated credential before reporting
 * success. Disabled standalone accounts are skipped: refreshing them is wrong
 * (they may intentionally retain a dead duplicate credential), while disabled
 * siblings sharing an enabled account's consumed token are still updated by
 * `persistRefreshResult()` so the shared credential remains consistent.
 */
export async function refreshAndPersistAccount(
	account: RefreshAccountInput,
): Promise<AccountRefreshOutcome> {
	const { index, identity } = account;
	if (account.enabled === false) {
		return { status: "skipped", index, identity };
	}

	let refreshResult: Awaited<ReturnType<typeof coordinatePersistedRefresh>>;
	try {
		refreshResult = await coordinatePersistedRefresh(identity);
	} catch (error) {
		return {
			status: "failed",
			index,
			identity,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	if (refreshResult.type !== "success") {
		return {
			status: "failed",
			index,
			identity,
			error:
				refreshResult.message ?? refreshResult.reason ?? "token refresh failed",
		};
	}

	return {
		status: "refreshed",
		index,
		result: {
			index,
			identity,
			refreshToken: refreshResult.refresh,
			accessToken: refreshResult.access,
			expiresAt: refreshResult.expires,
			rotatedAt: refreshResult.rotatedAt,
			persisted: true,
		},
	};
}

export function buildRefreshInputs(
	accounts: AccountMetadataV3[],
): RefreshAccountInput[] {
	return accounts.map((account, index) => ({
		index,
		enabled: account.enabled,
		identity: {
			organizationId: account.organizationId,
			accountId: account.accountId,
			accountUserId:
				account.accountUserId?.trim() || extractAccountUserId(account.accessToken),
			refreshToken: account.refreshToken,
		},
	}));
}
