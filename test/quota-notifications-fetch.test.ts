import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";

const ensureCodexUsageAccessToken = vi.fn();
const fetchCodexUsage = vi.fn();

// Only the two network/credential seams are stubbed. Everything else in
// `codex-usage.js` stays real so this exercises the default `fetchSummary`
// wiring rather than a reimplementation of it.
vi.mock("../lib/codex-usage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/codex-usage.js")>();
	return {
		...actual,
		ensureCodexUsageAccessToken: (...args: unknown[]) =>
			ensureCodexUsageAccessToken(...args) as unknown,
		fetchCodexUsage: (...args: unknown[]) => fetchCodexUsage(...args) as unknown,
	};
});

const { createQuotaMonitor } = await import("../lib/quota-notifications.js");
const { setStoragePathDirect } = await import("../lib/storage/state.js");

const storage: AccountStorageV3 = {
	version: 3,
	accounts: [{ refreshToken: "refresh-1", accountId: "account-1", addedAt: 0, lastUsed: 0 }],
	activeIndex: 0,
};

function monitorWith(overrides: Record<string, unknown> = {}) {
	return createQuotaMonitor({
		loadConfig: () => ({
			enabled: true,
			intervalMs: 1_000,
			notifyEveryCheck: true,
			thresholds: [25, 10, 0],
		}),
		loadStorage: async () => storage,
		notificationsSupported: () => true,
		...overrides,
	});
}

describe("default quota fetch path", () => {
	const directories: string[] = [];

	beforeEach(async () => {
		vi.clearAllMocks();
		const directory = await mkdtemp(join(tmpdir(), "quota-fetch-"));
		directories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("invalidates the account cache as soon as a refresh persists, before the usage call", async () => {
		const order: string[] = [];
		ensureCodexUsageAccessToken.mockImplementation(() => {
			order.push("refresh");
			return { accessToken: "access-1", refreshed: true, persisted: true };
		});
		fetchCodexUsage.mockImplementation(() => {
			order.push("usage");
			return {
				rate_limit: {
					primary_window: { used_percent: 50, limit_window_seconds: 18_000 },
					secondary_window: { used_percent: 50, limit_window_seconds: 604_800 },
				},
			};
		});
		const onCredentialsPersisted = vi.fn(() => order.push("invalidate"));

		await monitorWith({ onCredentialsPersisted, notify: vi.fn().mockResolvedValue(true) }).runNow();

		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
		expect(order).toEqual(["refresh", "invalidate", "usage"]);
	});

	it("still invalidates the cache when the usage call fails after a rotation", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: true,
			persisted: true,
		});
		fetchCodexUsage.mockRejectedValue(new Error("429 from the usage endpoint"));
		const onCredentialsPersisted = vi.fn();
		const notify = vi.fn().mockResolvedValue(true);

		await monitorWith({ onCredentialsPersisted, notify }).runNow();

		// The rotation is durable on disk, so the stale cached AccountManager
		// must be dropped even though this account produced no usage.
		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not invalidate the cache when the token was still valid", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: false,
			persisted: false,
		});
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				primary_window: { used_percent: 90, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
			},
		});
		const onCredentialsPersisted = vi.fn();
		const notify = vi.fn().mockResolvedValue(true);

		await monitorWith({ onCredentialsPersisted, notify }).runNow();

		expect(onCredentialsPersisted).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Codex quota status",
			"5h: 10% | resets unavailable\nWeekly: 90% | resets unavailable",
		);
	});

	it("skips an account whose access token carries no resolvable account id", async () => {
		const anonymous: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "refresh-2", addedAt: 0, lastUsed: 0 }],
			activeIndex: 0,
		};
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "not-a-jwt",
			refreshed: false,
			persisted: false,
		});
		const notify = vi.fn().mockResolvedValue(true);

		await monitorWith({ loadStorage: async () => anonymous, notify }).runNow();

		expect(fetchCodexUsage).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("swallows a refresh failure for one account without aborting the check", async () => {
		const twoAccounts: AccountStorageV3 = {
			version: 3,
			accounts: [
				{ refreshToken: "refresh-a", accountId: "account-a", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "refresh-b", accountId: "account-b", addedAt: 0, lastUsed: 0 },
			],
			activeIndex: 0,
		};
		ensureCodexUsageAccessToken.mockImplementation((params: { account: { accountId?: string } }) => {
			if (params.account.accountId === "account-a") {
				throw new Error("Cannot refresh: account has no refresh token");
			}
			return { accessToken: "access-b", refreshed: false, persisted: false };
		});
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
			},
		});
		const notify = vi.fn().mockResolvedValue(true);

		await monitorWith({ loadStorage: async () => twoAccounts, notify }).runNow();

		expect(fetchCodexUsage).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			"Codex quota status",
			"5h: 80% | resets unavailable\nWeekly: 80% | resets unavailable",
		);
	});
});
