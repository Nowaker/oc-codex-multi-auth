import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverWarmedAccount } from "../lib/accounts/warm-recovery.js";
import { AccountManager } from "../lib/accounts.js";
import { loadAccounts, saveAccounts, setStoragePathDirect, withAccountStorageTransaction, type AccountMetadataV3 } from "../lib/storage.js";

describe("warm recovery evidence", () => {
	let directory: string;
	let account: AccountMetadataV3;
	beforeEach(async () => {
		vi.stubEnv("CODEX_KEYCHAIN", "0");
		directory = await mkdtemp(join(tmpdir(), "warm-recovery-"));
		setStoragePathDirect(join(directory, "accounts.json"));
		account = {
			accountId: "recovery-account", refreshToken: "fake-refresh", addedAt: 1, lastUsed: 1,
			quotaExhaustedUntil: Date.now() + 86400000, quotaExhaustedStampAt: 100,
			rateLimitResetTimes: { "gpt-5.1:gpt-5.1": 5000, "codex:gpt-5-codex": 9000 },
		};
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
	});
	afterEach(async () => {
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});
	const usage = (used: number) => new Response(JSON.stringify({ rate_limit: {
		primary_window: { used_percent: used, limit_window_seconds: 604800 }, secondary_window: null,
	} }));
	it("keeps exhausted subscription quota and other model blocks after a successful fallback warm", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(usage(100));
		await recoverWarmedAccount({ account, model: "gpt-5.1", accessToken: "fake-access" });
		const stored = (await loadAccounts())?.accounts[0];
		expect(stored?.quotaExhaustedUntil).toBe(account.quotaExhaustedUntil);
		expect(stored?.rateLimitResetTimes).toEqual({ "codex:gpt-5-codex": 9000 });
	});
	it("clears subscription quota only after usage confirms recovery", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(usage(1));
		await recoverWarmedAccount({ account, model: "gpt-5.1", accessToken: "fake-access" });
		const stored = (await loadAccounts())?.accounts[0];
		expect(stored?.quotaExhaustedUntil).toBeUndefined();
		expect(stored?.quotaExhaustedClearedAt).toBeGreaterThan(0);
		expect(stored?.rateLimitResetTimes?.["codex:gpt-5-codex"]).toBe(9000);
	});
	it("retains newer quota and model limits recorded while the warm recovery check runs", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ ...account,
				quotaExhaustedStampAt: 200,
				rateLimitResetTimes: { ...account.rateLimitResetTimes, "gpt-5.1:gpt-5.1": 7000 },
			}] });
			return usage(0);
		});
		await recoverWarmedAccount({ account, model: "gpt-5.1", accessToken: "fake-access" });
		const stored = (await loadAccounts())?.accounts[0];
		expect(stored?.quotaExhaustedStampAt).toBe(200);
		expect(stored?.quotaExhaustedUntil).toBe(account.quotaExhaustedUntil);
		expect(stored?.rateLimitResetTimes?.["gpt-5.1:gpt-5.1"]).toBe(7000);
	});
});
describe("warm recovery scoped block cleanup", () => {
	let directory: string;
	let account: AccountMetadataV3;
	beforeEach(async () => {
		vi.stubEnv("CODEX_KEYCHAIN", "0");
		directory = await mkdtemp(join(tmpdir(), "warm-recovery-scoped-"));
		setStoragePathDirect(join(directory, "accounts.json"));
	});
	afterEach(async () => {
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});
	const usage = (used: number) => new Response(JSON.stringify({ rate_limit: {
		primary_window: { used_percent: used, limit_window_seconds: 604800 }, secondary_window: null,
	} }));

	it("a 429-shaped block (family-wide key plus model key) survives warm recovery and keeps the account ineligible", async () => {
		const modelKey = "gpt-5-codex:gpt-5-codex";
		const familyKey = "gpt-5-codex";
		account = {
			accountId: "warm-blocked", refreshToken: "fake-refresh", addedAt: 1, lastUsed: 1,
			quotaExhaustedUntil: Date.now() + 86_400_000, quotaExhaustedStampAt: 100,
			rateLimitResetTimes: { [familyKey]: 5000, [modelKey]: 5000 },
		};
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(usage(1));

		await recoverWarmedAccount({ account, model: "gpt-5-codex", accessToken: "fake-access" });

		const stored = (await loadAccounts())?.accounts[0];
		expect(stored?.rateLimitResetTimes?.[modelKey]).toBeUndefined();
		expect(stored?.rateLimitResetTimes?.[familyKey]).toBeUndefined();
		const manager = await AccountManager.loadFromDisk();
		const explainability = manager.getSelectionExplainability("gpt-5-codex", "gpt-5-codex")[0];
		expect(explainability?.eligible).toBe(true);
	});

	it("a failed usage verification does not cancel the model-marker cleanup", async () => {
		const modelKey = "gpt-5-codex:gpt-5-codex";
		account = {
			accountId: "warm-usage-fail", refreshToken: "fake-refresh", addedAt: 1, lastUsed: 1,
			quotaExhaustedUntil: Date.now() + 86_400_000, quotaExhaustedStampAt: 100,
			rateLimitResetTimes: { [modelKey]: 5000 },
		};
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("usage endpoint unreachable"));

		await expect(recoverWarmedAccount({ account, model: "gpt-5-codex", accessToken: "fake-access" }))
			.rejects.toThrow("usage endpoint unreachable");

		const stored = (await loadAccounts())?.accounts[0];
		expect(stored?.rateLimitResetTimes?.[modelKey]).toBeUndefined();
	});

	it("a concurrently cleared rate-limit key resurrects through the disposed manager's volatile merge after a warm quota-only clear", async () => {
		const staleKey = "codex";
		account = {
			accountId: "warm-race", refreshToken: "fake-refresh", addedAt: 1, lastUsed: 1,
			quotaExhaustedUntil: Date.now() + 86_400_000, quotaExhaustedStampAt: 100,
			rateLimitResetTimes: { [staleKey]: Date.now() + 3_600_000 },
		};
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
		const manager = await AccountManager.loadFromDisk();
		const snapshot = structuredClone(account);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(usage(1));

		await withAccountStorageTransaction(async (current, persist) => {
			if (!current) return;
			delete current.accounts[0]?.rateLimitResetTimes?.[staleKey];
			await persist(current);
		});

		const cleared: AccountMetadataV3[] = [];
		await recoverWarmedAccount({ account: snapshot, model: "gpt-5.5", accessToken: "fake-access" },
			(clearedSnapshot) => { cleared.push(clearedSnapshot); });

		manager.disposeShutdownHandler(false, cleared);
		await manager.saveToDisk();

		const stored = (await loadAccounts())?.accounts[0];
		expect(stored?.rateLimitResetTimes?.[staleKey]).toBeUndefined();
		expect(stored?.quotaExhaustedUntil).toBeUndefined();
	});
});
