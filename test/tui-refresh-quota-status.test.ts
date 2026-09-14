import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createUsageAccountFingerprint, ensureCodexUsageAccessToken, fetchCodexUsage, resolveCodexUsageActiveAccount } from "../lib/codex-usage.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
}));

vi.mock("../lib/codex-usage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/codex-usage.js")>();
	return {
		...actual,
		ensureCodexUsageAccessToken: vi.fn(() => {
			throw new Error("live usage fetch should not happen when a fresh shared snapshot exists");
		}),
		fetchCodexUsage: vi.fn(() => {
			throw new Error("live usage fetch should not happen when a fresh shared snapshot exists");
		}),
	};
});

import { loadAccounts } from "../lib/storage.js";
import {
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	writeTuiQuotaSnapshot,
	type TuiQuotaSnapshot,
} from "../lib/tui-quota-cache.js";
import { refreshQuotaStatusInner } from "../tui.js";

const storage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "active@example.com",
			accountId: "account-active",
			refreshToken: "refresh-active",
			addedAt: 1,
			lastUsed: 10,
		},
		{
			email: "serving@example.com",
			accountId: "account-serving",
			refreshToken: "refresh-serving",
			addedAt: 2,
			lastUsed: 2,
		},
		{
			email: "serving@example.com",
			accountId: "account-serving",
			refreshToken: "refresh-serving",
			addedAt: 3,
			lastUsed: 3,
		},
	],
};

function createFakeApi(stateDir: string) {
	const kvStore = new Map<string, unknown>();
	return {
		kv: {
			ready: true,
			get: <T>(key: string) => kvStore.get(key) as T,
			set: (key: string, value: unknown) => {
				kvStore.set(key, value);
			},
		},
		state: {
			path: {
				state: stateDir,
			},
		},
	} as unknown as TuiPluginApi;
}

describe("refreshQuotaStatusInner", () => {
	let stateDir: string;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
		stateDir = await mkdtemp(join(tmpdir(), "oc-codex-tui-quota-"));
		vi.stubEnv("OPENCODE_STATE_DIR", stateDir);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("shows the account that actually served the last request, not the stored active account", async () => {
		const api = createFakeApi(stateDir);
		const cachePath = getTuiQuotaCachePath(stateDir);

		const servingSnapshot: TuiQuotaSnapshot = createTuiQuotaSnapshot({
			fingerprint: createUsageAccountFingerprint(storage.accounts[1]!),
			source: "headers",
			accountIndex: 2,
			accountCount: 3,
			accountEmail: "serving@example.com",
			accountLabel: "serving@example.com",
			limits: [
				{ label: "5h", leftPercent: 90, usedPercent: 10, windowMinutes: 300 },
			],
			fetchedAt: Date.now(),
		});
		await writeTuiQuotaSnapshot(servingSnapshot, cachePath);

		const result = await refreshQuotaStatusInner(api);

		expect(result.type).toBe("ready");
		if (result.type !== "ready") throw new Error("expected ready status");
		expect(result.fingerprint).toBe(createUsageAccountFingerprint(storage.accounts[1]!));
		expect(result.accountIndex).toBe(2);
		expect(result.accountEmail).toBe("serving@example.com");
		expect(result.stale).toBe(false);
		expect(resolveCodexUsageActiveAccount(storage)?.index).toBe(0);
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
		expect(fetchCodexUsage).not.toHaveBeenCalled();
	});

	it("does not display a stale snapshot for a different account as the active account's numbers", async () => {
		const api = createFakeApi(stateDir);
		const cachePath = getTuiQuotaCachePath(stateDir);

		const staleOtherAccountSnapshot: TuiQuotaSnapshot = createTuiQuotaSnapshot({
			fingerprint: "fingerprint-stale-other-account",
			source: "headers",
			accountIndex: 3,
			accountCount: 3,
			accountEmail: "serving@example.com",
			accountLabel: "serving@example.com",
			limits: [
				{ label: "5h", leftPercent: 90, usedPercent: 10, windowMinutes: 300 },
			],
			fetchedAt: Date.now() - 60 * 60 * 1000,
		});
		await writeTuiQuotaSnapshot(staleOtherAccountSnapshot, cachePath);

		const result = await refreshQuotaStatusInner(api);

		expect(result.type).toBe("unavailable");
	});
	it("ignores a fresh snapshot from an account outside the current pool", async () => {
		await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({
			fingerprint: "another-project", source: "headers", accountIndex: 1,
			accountCount: 1, accountEmail: "other@example.com", fetchedAt: Date.now(),
			limits: [{ label: "5h", leftPercent: 80, usedPercent: 20, windowMinutes: 300 }],
		}), getTuiQuotaCachePath(stateDir));
		expect((await refreshQuotaStatusInner(createFakeApi(stateDir))).type).toBe("unavailable");
	});
});
