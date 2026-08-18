/**
 * Persistence surface for {@link AccountManager}: debounced disk saves,
 * pending-save coalescing, and shutdown-flush registration.
 *
 * All on-disk format concerns live in `lib/storage.ts`. This module owns the
 * *lifecycle* (when to save, how to flush before exit, how to dispose the
 * shutdown hook) rather than the serialization shape itself.
 */

import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { registerCleanup, unregisterCleanup } from "../shutdown.js";
import {
	withAccountStorageTransaction,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../storage.js";
import { getWorkspaceIdentityKey } from "../storage/identity.js";
import { nowMs } from "../utils.js";
import { clampNonNegativeInt } from "./rate-limits.js";
import type { AccountState } from "./state.js";

const log = createLogger("accounts");

/**
 * Upper bound the shutdown handler will wait for `flushPendingSave` so that a
 * jammed save cannot stall SIGINT/SIGTERM indefinitely.
 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

export class AccountPersistence {
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingSave: Promise<void> | null = null;
	private shutdownHandler: (() => Promise<void>) | null = null;

	constructor(private readonly state: AccountState) {}

	async saveToDisk(): Promise<void> {
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			const raw = this.state.currentAccountIndexByFamily[family];
			activeIndexByFamily[family] = clampNonNegativeInt(raw, 0);
		}

		const activeIndex = clampNonNegativeInt(activeIndexByFamily.codex, 0);

		const storage: AccountStorageV3 = {
			version: 3,
			accounts: this.state.accounts.map((account) => ({
				accountId: account.accountId,
				accountUserId: account.accountUserId,
				organizationId: account.organizationId,
				accountIdSource: account.accountIdSource,
				accountLabel: account.accountLabel,
				accountTags: account.accountTags,
				accountNote: account.accountNote,
				email: account.email,
				refreshToken: account.refreshToken,
				accessToken: account.access,
				expiresAt: account.expires,
				oauthScope: account.oauthScope,
				tokenRotatedAt: account.tokenRotatedAt,
				enabled: account.enabled === false ? false : undefined,
				addedAt: account.addedAt,
				lastUsed: account.lastUsed,
				lastSwitchReason: account.lastSwitchReason,
				// Copied, not referenced: adoptLongerDiskRateLimits merges the
				// on-disk blocks into this payload, and it must not reach back
				// through a shared reference into live rotation state.
				rateLimitResetTimes:
					Object.keys(account.rateLimitResetTimes).length > 0
						? { ...account.rateLimitResetTimes }
						: undefined,
				coolingDownUntil: account.coolingDownUntil,
				cooldownReason: account.cooldownReason,
			})),
			activeIndex,
			activeIndexByFamily,
		};

		// Read-modify-write under the storage lock. A plain saveAccounts()
		// would blind-overwrite the file from this process's snapshot: fine
		// for the documented lost-write set (rotation/health/rate-limit
		// state), fatal for credentials — refresh tokens are single-use, so
		// clobbering another process's freshly-rotated token kills the
		// account permanently. Adopt any newer on-disk credentials before
		// persisting.
		await withAccountStorageTransaction(async (current, persist) => {
			if (current) {
				// Before adoptNewerDiskCredentials: for records without workspace
				// ids the refresh token participates in the identity key, and
				// adopting a rotated token would change which disk record this
				// account matches.
				this.adoptLongerDiskRateLimits(storage, current);
				this.adoptNewerDiskCredentials(storage, current);
			}
			await persist(storage);
		});
	}

	/**
	 * Merges still-active rate-limit blocks from `disk` into `outgoing`, keeping
	 * whichever block runs longer per quota key.
	 *
	 * Rate-limit state is otherwise last-writer-wins, which is fine for a 5h
	 * window that both processes rediscover within minutes. It is not fine for a
	 * quota block: a second opencode process holding a stale snapshot would save
	 * over the weekly block another process had just recorded, and the exhausted
	 * account would be back in rotation after the next reload (issue #218).
	 *
	 * Only blocks still in the future are adopted, so an expired entry another
	 * process has not pruned yet cannot be resurrected, and a block this process
	 * deliberately cleared stays cleared once it has elapsed. `codex-doctor --fix`
	 * is unaffected: it persists through its own storage transaction rather than
	 * this method.
	 *
	 * Live in-memory state is intentionally left alone — unlike a consumed
	 * refresh token, a missing block is self-correcting, since the very next
	 * response re-applies it from the quota headers.
	 */
	private adoptLongerDiskRateLimits(
		outgoing: AccountStorageV3,
		disk: AccountStorageV3,
	): void {
		const now = nowMs();
		const diskByIdentity = new Map<string, AccountMetadataV3>();
		for (const record of disk.accounts) {
			diskByIdentity.set(getWorkspaceIdentityKey(record), record);
		}

		for (const mine of outgoing.accounts) {
			if (!mine) continue;
			const theirs = diskByIdentity.get(getWorkspaceIdentityKey(mine));
			const theirResets = theirs?.rateLimitResetTimes;
			if (!theirResets) continue;

			for (const [key, theirReset] of Object.entries(theirResets)) {
				if (
					typeof theirReset !== "number" ||
					!Number.isFinite(theirReset) ||
					theirReset <= now
				) {
					continue;
				}
				const myReset = mine.rateLimitResetTimes?.[key];
				if (typeof myReset === "number" && myReset >= theirReset) continue;
				mine.rateLimitResetTimes = {
					...(mine.rateLimitResetTimes ?? {}),
					[key]: theirReset,
				};
			}
		}
	}

	/**
	 * Merges credentials from `disk` into `outgoing` (and the live in-memory
	 * accounts) for every account whose on-disk refresh token differs and
	 * carries a NEWER `tokenRotatedAt` stamp — i.e. another process rotated
	 * the token after this process loaded its snapshot. Records without a
	 * stamp (pre-upgrade files) keep this process's value, matching the old
	 * behavior. Only credential fields are merged; rotation/health/rate-limit
	 * state intentionally stays last-writer-wins.
	 */
	private adoptNewerDiskCredentials(
		outgoing: AccountStorageV3,
		disk: AccountStorageV3,
	): void {
		const diskByIdentity = new Map<string, AccountMetadataV3>();
		for (const record of disk.accounts) {
			diskByIdentity.set(getWorkspaceIdentityKey(record), record);
		}

		for (let i = 0; i < outgoing.accounts.length; i++) {
			const mine = outgoing.accounts[i];
			if (!mine) continue;
			const theirs = diskByIdentity.get(getWorkspaceIdentityKey(mine));
			if (!theirs?.refreshToken || theirs.refreshToken === mine.refreshToken) {
				continue;
			}
			if ((theirs.tokenRotatedAt ?? 0) <= (mine.tokenRotatedAt ?? 0)) {
				continue;
			}

			const mineIdentity = getWorkspaceIdentityKey(mine);
			mine.refreshToken = theirs.refreshToken;
			mine.accessToken = theirs.accessToken;
			mine.expiresAt = theirs.expiresAt;
			// Truthy, not `??`: a legacy record can hold an empty-string scope, and
			// `??` would let it overwrite a good in-memory value. Matches the live
			// mirror below (issue #213).
			mine.oauthScope = theirs.oauthScope || mine.oauthScope;
			mine.tokenRotatedAt = theirs.tokenRotatedAt;

			// Mirror into live state so this process stops refreshing with the
			// consumed token. Matched by identity key rather than array index:
			// outgoing is currently built from state.accounts in order, but the
			// mirror must not silently target the wrong account if that ever
			// changes. The identity key is computed from `mine` BEFORE the
			// credential adoption above, since the token participates in the
			// key for records without workspace ids.
			const live = this.state.accounts.find(
				(candidate) => getWorkspaceIdentityKey(candidate) === mineIdentity,
			);
			if (live) {
				live.refreshToken = theirs.refreshToken;
				live.access = theirs.accessToken;
				live.expires = theirs.expiresAt;
				if (theirs.oauthScope) live.oauthScope = theirs.oauthScope;
				live.tokenRotatedAt = theirs.tokenRotatedAt;
			}

			log.info("Adopted newer on-disk credentials during save", {
				accountIndex: i,
				rotatedAt: theirs.tokenRotatedAt,
			});
		}
	}

	saveToDiskDebounced(delayMs = 500): void {
		this.ensureShutdownFlushRegistered();
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
		}
		this.saveDebounceTimer = setTimeout(() => {
			this.saveDebounceTimer = null;
			const doSave = async () => {
				try {
					if (this.pendingSave) {
						await this.pendingSave;
					}
					this.pendingSave = this.saveToDisk().finally(() => {
						this.pendingSave = null;
					});
					await this.pendingSave;
				} catch (error) {
					log.warn("Debounced save failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			void doSave();
		}, delayMs);
	}

	async flushPendingSave(): Promise<void> {
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
			this.saveDebounceTimer = null;
			await this.saveToDisk();
		}
		if (this.pendingSave) {
			await this.pendingSave;
		}
	}

	/**
	 * Registers a process-shutdown cleanup that awaits any pending debounced
	 * save. Without this, a rotation queued inside the 500ms debounce window
	 * would be lost when SIGINT/SIGTERM fires before the timer resolves.
	 * Registration is lazy (only when `saveToDiskDebounced` is first invoked)
	 * so idle managers do not leak handlers into the shutdown queue.
	 */
	private ensureShutdownFlushRegistered(): void {
		if (this.shutdownHandler) return;
		const handler = async (): Promise<void> => {
			// One-shot: clear the slot first so that if `runCleanup()` fires
			// externally (e.g. tests reusing a manager across cycles, or any
			// other caller that drains the global cleanup queue), a subsequent
			// `saveToDiskDebounced()` can re-register a fresh handler. Without
			// this the guard above returns early and the next pending save
			// goes unprotected on shutdown.
			this.shutdownHandler = null;
			let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
			try {
				await Promise.race([
					this.flushPendingSave(),
					new Promise<void>((_resolve, reject) => {
						timeoutTimer = setTimeout(() => {
							reject(
								new Error(
									`flushPendingSave timed out after ${SHUTDOWN_FLUSH_TIMEOUT_MS}ms`,
								),
							);
						}, SHUTDOWN_FLUSH_TIMEOUT_MS);
					}),
				]);
			} catch (error) {
				log.warn("Shutdown flush failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				if (timeoutTimer) clearTimeout(timeoutTimer);
			}
		};
		this.shutdownHandler = handler;
		registerCleanup(handler);
	}

	/**
	 * Removes this manager's shutdown cleanup registration. Call this when
	 * replacing an `AccountManager` instance (e.g., on cache invalidation)
	 * to avoid unbounded growth of the global cleanup queue.
	 */
	disposeShutdownHandler(): void {
		if (!this.shutdownHandler) return;
		unregisterCleanup(this.shutdownHandler);
		this.shutdownHandler = null;
	}
}
