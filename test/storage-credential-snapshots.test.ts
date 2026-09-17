import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import {
	_resetBackendForTests,
	_setBackendForTests,
	type KeychainBackend,
} from "../lib/storage/keychain.js";
import { TEST_HOME_ESCAPE_CODE } from "../lib/storage/test-home-guard.js";
import {
	clearAccounts,
	saveAccounts,
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";
import {
	CREDENTIAL_SNAPSHOT_PREFIX,
	isCredentialSnapshotFileName,
	isSignificantStorageChange,
	pruneCredentialSnapshots,
} from "../lib/storage/credential-snapshots.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";

type StoredAccount = AccountStorageV3["accounts"][number];

let testDir: string;
let storagePath: string;
let backupsDir: string;

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
	return {
		accountId: "acct-1",
		email: "one@example.com",
		refreshToken: "rt-1",
		accessToken: "at-1",
		expiresAt: 1_900_000_000_000,
		addedAt: 1_000,
		lastUsed: 2_000,
		...overrides,
	};
}

function makeStorage(): AccountStorageV3 {
	return {
		version: 3,
		accounts: [
			makeAccount(),
			makeAccount({
				accountId: "acct-2",
				email: "two@example.com",
				refreshToken: "rt-2",
				accessToken: "at-2",
			}),
		],
		activeIndex: 0,
	};
}

function withAccount(
	storage: AccountStorageV3,
	index: number,
	mutate: (account: StoredAccount) => StoredAccount,
): AccountStorageV3 {
	return {
		...storage,
		accounts: storage.accounts.map((account, i) => (i === index ? mutate({ ...account }) : account)),
	};
}

async function listSnapshotNames(): Promise<string[]> {
	try {
		return (await fs.readdir(backupsDir)).filter(isCredentialSnapshotFileName).sort();
	} catch {
		return [];
	}
}

async function readSnapshotContents(): Promise<string[]> {
	const names = await listSnapshotNames();
	return Promise.all(names.map((name) => fs.readFile(join(backupsDir, name), "utf-8")));
}

async function readLiveStore(): Promise<AccountStorageV3> {
	return JSON.parse(await fs.readFile(storagePath, "utf-8")) as AccountStorageV3;
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	testDir = await mkdtemp(join(tmpdir(), "oc-codex-credential-snapshots-"));
	storagePath = join(testDir, "oc-codex-multi-auth-accounts.json");
	backupsDir = join(testDir, "backups");
	setStoragePathDirect(storagePath);
});

afterEach(async () => {
	setStoragePathDirect(null);
	vi.unstubAllEnvs();
	await fs.rm(testDir, { recursive: true, force: true });
});

describe("credential snapshots: significance", () => {
	it("writes no snapshot on the first save because there is no previous state", async () => {
		await saveAccounts(makeStorage());

		expect(await listSnapshotNames()).toEqual([]);
		expect(await exists(backupsDir)).toBe(false);
	});

	const ignoredChanges: Array<[string, (storage: AccountStorageV3) => AccountStorageV3]> = [
		[
			"lastUsed",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, lastUsed: a.lastUsed + 90_000 })),
		],
		[
			"lastSwitchReason",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, lastSwitchReason: "rotation" })),
		],
		[
			"rateLimitResetTimes",
			(storage) =>
				withAccount(storage, 0, (a) => ({
					...a,
					rateLimitResetTimes: { [MODEL_FAMILIES[0]]: Date.now() + 60_000 },
				})),
		],
		[
			"coolingDownUntil and cooldownReason",
			(storage) =>
				withAccount(storage, 0, (a) => ({
					...a,
					coolingDownUntil: Date.now() + 60_000,
					cooldownReason: "network-error",
				})),
		],
		[
			"quota exhaustion stamps",
			(storage) =>
				withAccount(storage, 0, (a) => ({
					...a,
					quotaExhaustedUntil: Date.now() + 60_000,
					quotaExhaustedStampAt: Date.now(),
				})),
		],
		["activeIndex", (storage) => ({ ...storage, activeIndex: 1 })],
		[
			"activeIndexByFamily",
			(storage) => ({ ...storage, activeIndexByFamily: { [MODEL_FAMILIES[0]]: 1 } }),
		],
	];

	it.each(ignoredChanges)("takes no snapshot for a %s-only change", async (_label, mutate) => {
		const base = makeStorage();
		await saveAccounts(base);

		await saveAccounts(mutate(base));

		expect(await listSnapshotNames()).toEqual([]);
	});

	const significantChanges: Array<[string, (storage: AccountStorageV3) => AccountStorageV3]> = [
		[
			"account added",
			(storage) => ({
				...storage,
				accounts: [
					...storage.accounts,
					makeAccount({ accountId: "acct-3", email: "three@example.com", refreshToken: "rt-3" }),
				],
			}),
		],
		["account removed", (storage) => ({ ...storage, accounts: storage.accounts.slice(0, 1) })],
		[
			"refresh token rotated",
			(storage) =>
				withAccount(storage, 0, (a) => ({
					...a,
					refreshToken: "rt-rotated",
					accessToken: "at-rotated",
					expiresAt: (a.expiresAt ?? 0) + 3_600_000,
					tokenRotatedAt: 1_800_000_000_000,
				})),
		],
		[
			"access token replaced",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, accessToken: "at-fresh" })),
		],
		[
			"expiry moved",
			(storage) =>
				withAccount(storage, 0, (a) => ({ ...a, expiresAt: (a.expiresAt ?? 0) + 600_000 })),
		],
		["label set", (storage) => withAccount(storage, 0, (a) => ({ ...a, accountLabel: "Work" }))],
		["tags set", (storage) => withAccount(storage, 0, (a) => ({ ...a, accountTags: ["work"] }))],
		["note set", (storage) => withAccount(storage, 0, (a) => ({ ...a, accountNote: "primary" }))],
		["disabled", (storage) => withAccount(storage, 0, (a) => ({ ...a, enabled: false }))],
		[
			"email changed",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, email: "renamed@example.com" })),
		],
		[
			"accountUserId set",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, accountUserId: "member-9" })),
		],
		[
			"accountIdSource changed",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, accountIdSource: "manual" })),
		],
		["plan type changed", (storage) => withAccount(storage, 0, (a) => ({ ...a, planType: "pro" }))],
		[
			"oauth scope changed",
			(storage) => withAccount(storage, 0, (a) => ({ ...a, oauthScope: "openid profile" })),
		],
	];

	it.each(significantChanges)("snapshots a %s", async (_label, mutate) => {
		const base = makeStorage();
		await saveAccounts(base);
		const before = await fs.readFile(storagePath, "utf-8");

		await saveAccounts(mutate(base));

		expect(await readSnapshotContents()).toEqual([before]);
	});

	it("preserves the previous document rather than the incoming one", async () => {
		const base = makeStorage();
		await saveAccounts(base);

		await saveAccounts(
			withAccount(base, 0, (a) => ({ ...a, refreshToken: "rt-clobbered-by-a-bad-write" })),
		);

		const [snapshot] = await readSnapshotContents();
		const snapshotDoc = JSON.parse(snapshot) as AccountStorageV3;
		expect(snapshotDoc.accounts[0].refreshToken).toBe("rt-1");
		expect((await readLiveStore()).accounts[0].refreshToken).toBe("rt-clobbered-by-a-bad-write");
	});

	it("snapshots a store that no longer parses", async () => {
		await fs.writeFile(storagePath, "{ this is not json", "utf-8");

		await saveAccounts(makeStorage());

		expect(await readSnapshotContents()).toEqual(["{ this is not json"]);
	});

	it("treats a storage schema version change as significant", () => {
		const previous = JSON.stringify({
			version: 1,
			accounts: [{ refreshToken: "rt-1", addedAt: 1, lastUsed: 2 }],
			activeIndex: 0,
		});

		expect(
			isSignificantStorageChange(previous, {
				version: 3,
				accounts: [{ refreshToken: "rt-1", addedAt: 1, lastUsed: 2 }],
				activeIndex: 0,
			}),
		).toBe(true);
	});

	it("ignores key order and undefined-valued keys in the incoming document", () => {
		const previous = JSON.stringify({
			version: 3,
			activeIndex: 0,
			accounts: [{ addedAt: 1, lastUsed: 2, refreshToken: "rt-1" }],
		});

		expect(
			isSignificantStorageChange(previous, {
				version: 3,
				accounts: [{ refreshToken: "rt-1", addedAt: 1, lastUsed: 2, email: undefined }],
				activeIndex: 0,
			}),
		).toBe(false);
	});
});

describe("credential snapshots: clearAccounts", () => {
	it("snapshots the store before deleting it", async () => {
		await saveAccounts(makeStorage());
		const before = await fs.readFile(storagePath, "utf-8");

		await clearAccounts();

		expect(await exists(storagePath)).toBe(false);
		expect(await readSnapshotContents()).toEqual([before]);
	});

	it("writes nothing when there is no store to delete", async () => {
		await clearAccounts();

		expect(await listSnapshotNames()).toEqual([]);
	});
});

describe("credential snapshots: retention", () => {
	async function seedForeignBackups(): Promise<string[]> {
		await fs.mkdir(backupsDir, { recursive: true });
		const foreignFiles = [
			join(backupsDir, "codex-pre-import-backup-20250101-000000000-aaaaaa.json"),
			join(backupsDir, "codex-backup-20250101-000000000-bbbbbb.json"),
			join(backupsDir, "oc-codex-multi-auth-accounts.json.migrated-to-keychain.2025-01-01T00-00-00-000Z"),
		];
		for (const file of foreignFiles) {
			await fs.writeFile(file, "foreign", "utf-8");
		}
		const foreignDir = join(backupsDir, "pre-global-migration-20250101-000000000");
		await fs.mkdir(foreignDir, { recursive: true });
		return [...foreignFiles, foreignDir];
	}

	it("keeps only the configured number of snapshots across repeated saves", async () => {
		vi.stubEnv("CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT", "3");
		const foreign = await seedForeignBackups();

		const base = makeStorage();
		await saveAccounts(base);
		for (let generation = 1; generation <= 5; generation += 1) {
			await saveAccounts(
				withAccount(base, 0, (a) => ({ ...a, accountLabel: `generation-${generation}` })),
			);
		}

		expect(await listSnapshotNames()).toHaveLength(3);
		for (const path of foreign) {
			expect(await exists(path), `${path} must survive pruning`).toBe(true);
		}
	});

	it("deletes the oldest snapshots and never a foreign file", async () => {
		const foreign = await seedForeignBackups();
		const snapshots = ["oldest", "older", "old", "newer", "newest"];
		for (const [index, marker] of snapshots.entries()) {
			const path = join(
				backupsDir,
				`${CREDENTIAL_SNAPSHOT_PREFIX}-2025010${index + 1}-000000000-abcdef.json`,
			);
			await fs.writeFile(path, marker, "utf-8");
			const stamp = new Date(1_700_000_000_000 + index * 60_000);
			await fs.utimes(path, stamp, stamp);
		}

		await pruneCredentialSnapshots(backupsDir, 2);

		expect((await readSnapshotContents()).sort()).toEqual(["newer", "newest"].sort());
		for (const path of foreign) {
			expect(await exists(path), `${path} must survive pruning`).toBe(true);
		}
	});

	it("keeps every snapshot when the max count is zero", async () => {
		await fs.mkdir(backupsDir, { recursive: true });
		for (let index = 0; index < 4; index += 1) {
			await fs.writeFile(
				join(backupsDir, `${CREDENTIAL_SNAPSHOT_PREFIX}-2025010${index + 1}-000000000-abcdef.json`),
				`snapshot-${index}`,
				"utf-8",
			);
		}

		await pruneCredentialSnapshots(backupsDir, 0);

		expect(await listSnapshotNames()).toHaveLength(4);
	});

	it("recognizes only its own filenames", () => {
		expect(isCredentialSnapshotFileName(`${CREDENTIAL_SNAPSHOT_PREFIX}-20250101-000000000-ab.json`))
			.toBe(true);
		expect(isCredentialSnapshotFileName("codex-pre-import-backup-20250101-000000000-ab.json"))
			.toBe(false);
		expect(isCredentialSnapshotFileName("codex-backup-20250101-000000000-ab.json")).toBe(false);
		expect(isCredentialSnapshotFileName(`${CREDENTIAL_SNAPSHOT_PREFIX}.json`)).toBe(false);
	});
});

describe("credential snapshots: safety", () => {
	it.skipIf(process.platform === "win32")(
		"writes snapshots as 0600 inside a 0700 directory",
		async () => {
			const base = makeStorage();
			await saveAccounts(base);
			await saveAccounts(withAccount(base, 0, (a) => ({ ...a, refreshToken: "rt-rotated" })));

			const [name] = await listSnapshotNames();
			const fileStats = await fs.stat(join(backupsDir, name));
			const dirStats = await fs.stat(backupsDir);
			expect(fileStats.mode & 0o777).toBe(0o600);
			expect(dirStats.mode & 0o777).toBe(0o700);
		},
	);

	it("does not fail the save when the snapshot cannot be written", async () => {
		const base = makeStorage();
		await saveAccounts(base);
		await fs.writeFile(backupsDir, "not a directory", "utf-8");

		await expect(
			saveAccounts(withAccount(base, 0, (a) => ({ ...a, refreshToken: "rt-rotated" }))),
		).resolves.toBeUndefined();

		expect((await readLiveStore()).accounts[0].refreshToken).toBe("rt-rotated");
		expect(await fs.readFile(backupsDir, "utf-8")).toBe("not a directory");
	});

	it("writes nothing at all when the feature is disabled", async () => {
		vi.stubEnv("CODEX_AUTH_CREDENTIAL_SNAPSHOTS", "0");

		const base = makeStorage();
		await saveAccounts(base);
		await saveAccounts(withAccount(base, 0, (a) => ({ ...a, refreshToken: "rt-rotated" })));
		await clearAccounts();

		expect(await exists(backupsDir)).toBe(false);
	});

	it("propagates a clear refused by the test-home guard instead of reporting success", async () => {
		// A path under the real home that does not exist and is not a storage
		// location, so a regression in the guard still cannot unlink a real
		// account store. The guard runs before any filesystem call, so nothing
		// here is created either.
		const escaped = resolve(
			userInfo().homedir,
			".oc-codex-credential-snapshot-guard-probe",
			"oc-codex-multi-auth-accounts.json",
		);
		setStoragePathDirect(escaped);

		await expect(clearAccounts()).rejects.toMatchObject({
			code: TEST_HOME_ESCAPE_CODE,
		});
		expect(await exists(escaped)).toBe(false);
	});
});

describe("credential snapshots: keychain opt-in", () => {
	function createMockKeychain(): KeychainBackend & { failWrites: boolean } {
		const store = new Map<string, string>();
		const backend = {
			failWrites: false,
			async get(service: string, account: string) {
				return store.get(`${service}::${account}`) ?? null;
			},
			async set(service: string, account: string, secret: string) {
				if (backend.failWrites) throw new Error("simulated keychain failure");
				store.set(`${service}::${account}`, secret);
			},
			async delete(service: string, account: string) {
				return store.delete(`${service}::${account}`);
			},
			async isAvailable() {
				return true;
			},
		};
		return backend;
	}

	afterEach(() => {
		_resetBackendForTests();
	});

	it("writes no snapshot when clearing a keychain-backed store", async () => {
		await saveAccounts(makeStorage());
		const before = await fs.readFile(storagePath, "utf-8");
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		_setBackendForTests(createMockKeychain());

		await clearAccounts();

		expect(await listSnapshotNames()).toEqual([]);
		expect(await exists(storagePath)).toBe(false);
		// The store really did hold a plaintext pool, so a snapshot here would
		// have copied live tokens into backups/ rather than been a no-op.
		expect(before).toContain("rt-1");
	});

	it("writes no snapshot when a failed keychain write falls back to JSON", async () => {
		const base = makeStorage();
		await saveAccounts(base);
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		const backend = createMockKeychain();
		backend.failWrites = true;
		_setBackendForTests(backend);

		await saveAccounts(withAccount(base, 0, (a) => ({ ...a, refreshToken: "rt-rotated" })));

		// The fallback wrote the pool to JSON, which is the path that snapshots.
		expect((await readLiveStore()).accounts[0].refreshToken).toBe("rt-rotated");
		expect(await listSnapshotNames()).toEqual([]);
	});
});

describe("credential snapshots: token rotation semantics", () => {
	it("keeps the superseded token for the refreshed account and live tokens for the rest", async () => {
		const base = makeStorage();
		await saveAccounts(base);

		await saveAccounts(
			withAccount(base, 0, (a) => ({
				...a,
				refreshToken: "rt-1-rotated",
				accessToken: "at-1-rotated",
				tokenRotatedAt: 1_800_000_000_000,
			})),
		);

		const [snapshot] = await readSnapshotContents();
		const snapshotDoc = JSON.parse(snapshot) as AccountStorageV3;
		// A refresh consumes one account's token, so that one account's
		// snapshotted token is the superseded one...
		expect(snapshotDoc.accounts[0].refreshToken).toBe("rt-1");
		// ...while every other account in the pool is snapshotted with the
		// token that is still live on disk. That bounds the staleness of a
		// snapshot to the accounts a single write actually rotated.
		expect(snapshotDoc.accounts[1].refreshToken).toBe("rt-2");
		expect((await readLiveStore()).accounts[1].refreshToken).toBe("rt-2");
	});
});
