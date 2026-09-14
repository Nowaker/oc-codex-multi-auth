import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverWarmedAccount } from "../lib/accounts/warm-recovery.js";
import { loadAccounts, saveAccounts, setStoragePathDirect, type AccountMetadataV3 } from "../lib/storage.js";

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
		primary_window: { used_percent: used, limit_window_seconds: 604800 },
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
