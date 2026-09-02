/**
 * `disposeShutdownHandler()` tears a manager's process-level side effects down.
 * A debounced save armed before that call is one of them: it fires up to 500ms
 * later and writes the manager's in-memory snapshot to the account file.
 *
 * That snapshot is authoritative for account *membership*. `saveToDisk` adopts
 * newer credentials and longer rate-limit blocks from disk, but never adopts
 * disk accounts the snapshot lacks, so a replaced manager firing late does not
 * merely lose a rotation stamp: it deletes every account its successor has that
 * the dead one did not.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";

/** Longer than the 500ms debounce, short enough to keep the suite fast. */
const PAST_DEBOUNCE_MS = 900;

const TEST_STORAGE_PATH = join(
	tmpdir(),
	`oc-codex-multi-auth-dispose-cancels-save-${process.pid}-${Date.now()}.json`,
);

const ON_DISK_ACCOUNTS = ["rt-user-1", "rt-user-2", "rt-user-3"] as const;

const managers: AccountManager[] = [];

function storageOf(refreshTokens: readonly string[]): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: refreshTokens.map((refreshToken, index) => ({
			refreshToken,
			addedAt: 1_700_000_000_000,
			lastUsed: 1_700_000_000_000 + index,
		})),
	};
}

/** A manager holding one account the on-disk store does not have. */
function managerWithForeignAccount(): AccountManager {
	const manager = new AccountManager(undefined, storageOf(["rt-from-a-dead-manager"]));
	managers.push(manager);
	return manager;
}

async function storedRefreshTokens(): Promise<string[]> {
	const raw = JSON.parse(
		await fs.readFile(TEST_STORAGE_PATH, "utf8"),
	) as AccountStorageV3;
	return raw.accounts.map((account) => account.refreshToken);
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
	// Redirect account storage before any manager exists, so no save in this
	// file can reach the developer's real account file.
	setStoragePathDirect(TEST_STORAGE_PATH);
	await fs.writeFile(TEST_STORAGE_PATH, JSON.stringify(storageOf(ON_DISK_ACCOUNTS)));
});

afterEach(async () => {
	// Dispose while the override is still active, so nothing can outlive it.
	for (const manager of managers.splice(0)) manager.disposeShutdownHandler();
	setStoragePathDirect(null);
	await fs.rm(TEST_STORAGE_PATH, { force: true });
});

describe("AccountManager.disposeShutdownHandler", () => {
	it("does not write the account file after the debounce window", async () => {
		// Given a store holding accounts this manager knows nothing about
		const manager = managerWithForeignAccount();

		// When a queued save is followed by disposal
		manager.saveToDiskDebounced();
		manager.disposeShutdownHandler();
		await sleep(PAST_DEBOUNCE_MS);

		// Then the store still holds exactly the accounts it started with
		await expect(storedRefreshTokens()).resolves.toEqual([...ON_DISK_ACCOUNTS]);
	});

	it("is the only thing preventing that write", async () => {
		// Given the same store and an identical queued save
		const manager = managerWithForeignAccount();

		// When the manager is left live instead of disposed
		manager.saveToDiskDebounced();
		await sleep(PAST_DEBOUNCE_MS);

		// Then the save lands and replaces the store's accounts, so the
		// assertion above is about disposal rather than about a save that never
		// had a chance to fire
		await expect(storedRefreshTokens()).resolves.toEqual(["rt-from-a-dead-manager"]);
	});
});
