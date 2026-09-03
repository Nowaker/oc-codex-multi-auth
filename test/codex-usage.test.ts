import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	deduplicateUsageAccountIndices,
	fetchCodexUsage,
	formatUsageLimitSummary,
	formatUsageReset,
	getUsageQuotaExhaustedResetAtMs,
	getUsageLeftPercent,
	hasUsageWindow,
	parseCodexUsagePayload,
	persistUsageQuotaExhaustion,
	resolveCodexUsageActiveAccount,
	type UsagePayload,
} from "../lib/codex-usage.js";
import { loadAccounts, saveAccounts, type AccountStorageV3 } from "../lib/storage.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { setStoragePathDirect } from "../lib/storage/state.js";

describe("codex usage helpers", () => {
	it("formats same-day reset times on a locale-independent 24-hour clock", () => {
		// Pinned well clear of midnight: a real clock would cross into the next
		// day inside the 60s offset and take the "on <date>" branch instead.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
		const formatTime = vi
			.spyOn(Date.prototype, "toLocaleTimeString")
			.mockReturnValue("22:30");

		try {
			expect(formatUsageReset(Date.now() + 60_000)).toBe("22:30");
			expect(formatTime).toHaveBeenCalledWith(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
		} finally {
			formatTime.mockRestore();
			vi.useRealTimers();
		}
	});

	it("reads a non-object usage document as an empty one instead of throwing", () => {
		// `fetchCodexUsage` casts `response.json()` straight to UsagePayload, so a
		// 200 whose body is `null` reaches the parser as null.
		for (const payload of [null, undefined, "ok", 5, true] as unknown[]) {
			const usage = parseCodexUsagePayload(payload as UsagePayload);
			expect(usage.limits, `payload=${String(payload)}`).toEqual([]);
			expect(usage.primary, `payload=${String(payload)}`).toEqual({});
			expect(usage.secondary, `payload=${String(payload)}`).toEqual({});
			expect(usage.planType, `payload=${String(payload)}`).toBeNull();
			expect(usage.credits, `payload=${String(payload)}`).toBeNull();
			expect(usage.additionalLimits, `payload=${String(payload)}`).toEqual([]);
			expect(formatUsageLimitSummary(usage.primary)).toBe("unavailable");
		}
	});

	it("parses usage payloads using remaining-percent semantics", () => {
		const payload: UsagePayload = {
			plan_type: "team",
			rate_limit: {
				primary_window: {
					used_percent: 13,
					limit_window_seconds: 18000,
				},
				secondary_window: {
					used_percent: 36,
					limit_window_seconds: 604800,
				},
			},
			code_review_rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 604800,
				},
			},
			additional_rate_limits: [
				{
					limit_name: "batch_jobs",
					rate_limit: {
						primary_window: {
							used_percent: 25,
							limit_window_seconds: 3600,
						},
					},
				},
			],
			credits: { unlimited: true },
		};

		const usage = parseCodexUsagePayload(payload);

		expect(usage.planType).toBe("team");
		expect(usage.credits).toBe("unlimited");
		expect(usage.limits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "5h limit",
					leftPercent: 87,
					summary: "87% left",
				}),
				expect.objectContaining({
					name: "Weekly limit",
					leftPercent: 64,
					summary: "64% left",
				}),
				expect.objectContaining({
					name: "Code review",
					leftPercent: 100,
				}),
				expect.objectContaining({
					name: "Batch Jobs",
					leftPercent: 75,
				}),
			]),
		);
	});

	it("finds the latest valid reset for an exhausted ordinary usage window", () => {
		const now = Date.now();
		expect(
			getUsageQuotaExhaustedResetAtMs(
				[
					{ usedPercent: 100, windowMinutes: 300, resetAtMs: now + 60_000 },
					{ usedPercent: 100, windowMinutes: 10080, resetAtMs: now + 86_400_000 },
				],
				now,
			),
		).toBe(now + 86_400_000);
		expect(
			getUsageQuotaExhaustedResetAtMs(
				[{ usedPercent: 100, windowMinutes: 0, resetAtMs: now + 60_000 }],
				now,
			),
		).toBeUndefined();
	});

	it("persists a quota block for every model family without shortening a longer block", async () => {
		const directory = await mkdtemp(join(tmpdir(), "usage-quota-persist-"));
		try {
			setStoragePathDirect(join(directory, "accounts.json"));
			const account = {
				refreshToken: "refresh-1",
				accountId: "account-1",
				addedAt: 0,
				lastUsed: 0,
			};
			await saveAccounts({ version: 3, accounts: [account], activeIndex: 0 });
			const resetAtMs = Date.now() + 86_400_000;

			expect(await persistUsageQuotaExhaustion(account, resetAtMs)).toBe(true);
			expect(await persistUsageQuotaExhaustion(account, resetAtMs - 60_000)).toBe(false);

			const persisted = await loadAccounts();
			expect(persisted?.accounts[0]?.rateLimitResetTimes).toEqual(
				expect.objectContaining(
					Object.fromEntries(MODEL_FAMILIES.map((family) => [family, resetAtMs])),
				),
			);
		} finally {
			setStoragePathDirect(null);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("clamps remaining percent and preserves active codex account selection", () => {
		expect(getUsageLeftPercent(-10)).toBe(100);
		expect(getUsageLeftPercent(110)).toBe(0);
		expect(getUsageLeftPercent(12.4)).toBe(88);

		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 2 },
			accounts: [
				{ refreshToken: "r1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-2", addedAt: 0, lastUsed: 0 },
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([1, 2]);
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 2,
			account: { accountId: "acc-2" },
		});
	});

	it("keeps same-token workspace entries distinct, skips disabled, and prefers the freshest duplicate", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", accountId: "acc-2", organizationId: "org-2", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-3", enabled: false, addedAt: 0, lastUsed: 50 },
				{ refreshToken: "r3", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
			],
		};

		// org-1 (key W) appears at index 0 and again at index 3 (re-added with a
		// fresh token r3); org-2 (key X) at index 1; index 2 disabled. Display
		// order follows first appearance (W then X), but W resolves to its
		// freshest occurrence (index 3, token r3), not the stale index 0.
		expect(deduplicateUsageAccountIndices(storage)).toEqual([3, 1]);
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 0,
			account: { accountId: "acc-1" },
		});
	});

	it("keeps Business members with the same workspace id as separate quota pools", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "owner-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-business",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "invited-refresh",
					accountId: "business-account",
					accountUserId: "member-invited",
					organizationId: "org-business",
					addedAt: 0,
					lastUsed: 0,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("keeps separate rows for one member across distinct workspaces", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "shared-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-two",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("collapses duplicate rows for the same Business member credential", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "other-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([1]);
	});

	it("keeps separate rows for distinct members of one Business workspace", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "owner-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "invitee-refresh",
					accountId: "business-account",
					accountUserId: "member-invitee",
					organizationId: "org-one",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("deduplicates workspace identities without delimiter collisions", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "r1", accountId: "acc:1", organizationId: "org", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc", organizationId: "1:org", addedAt: 0, lastUsed: 0 },
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("handles sparse/undefined account slots without throwing", () => {
		const storage = {
			version: 3,
			activeIndex: 5,
			accounts: [
				undefined,
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 10 },
			],
		} as unknown as AccountStorageV3;

		expect(() => resolveCodexUsageActiveAccount(storage)).not.toThrow();
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-1" },
		});
	});

	it("returns null when every account slot is empty or disabled", () => {
		const storage = {
			version: 3,
			activeIndex: 0,
			accounts: [
				undefined,
				{ refreshToken: "r2", accountId: "acc-2", enabled: false, addedAt: 0, lastUsed: 0 },
			],
		} as unknown as AccountStorageV3;

		expect(resolveCodexUsageActiveAccount(storage)).toBeNull();
	});

	it("keeps the active account when its lastUsed is missing", () => {
		const storage = {
			version: 3,
			activeIndex: 1,
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-2", organizationId: "org-2", addedAt: 0 },
			],
		} as unknown as AccountStorageV3;

		// The active account (index 1) has no lastUsed. It must not lose the
		// marker to index 0's lastUsed:0 via a 0 > -1 comparison.
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-2" },
		});
	});

	it("drops accounts that have no workspace identity and no refresh token", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
			],
		};

		// The identity-less entry (index 0) yields no dedupe key and is excluded.
		expect(deduplicateUsageAccountIndices(storage)).toEqual([1]);
	});

	it("uses the most recently persisted request account for usage display", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", addedAt: 0, lastUsed: 10 },
				{ refreshToken: "r2", accountId: "acc-2", addedAt: 0, lastUsed: 20 },
			],
		};

		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-2" },
		});
	});
});

describe("disabled usage windows (issue #194)", () => {
	it("drops a window the server reports with a zero-second length", () => {
		const payload: UsagePayload = {
			plan_type: "team",
			rate_limit: {
				primary_window: {
					used_percent: 23,
					limit_window_seconds: 10080 * 60,
				},
				secondary_window: {
					used_percent: 0,
					limit_window_seconds: 0,
					reset_after_seconds: 0,
				},
			},
		};

		const usage = parseCodexUsagePayload(payload);

		// A zero-length window is switched off, not a one-minute window.
		expect(usage.secondary.windowMinutes).toBe(0);
		expect(hasUsageWindow(usage.secondary)).toBe(false);
		expect(usage.limits).toHaveLength(1);
		expect(usage.limits[0]).toMatchObject({
			name: "Weekly limit",
			leftPercent: 77,
		});
	});

	it("keeps a window whose length the server omits", () => {
		const usage = parseCodexUsagePayload({
			rate_limit: { primary_window: { used_percent: 10 } },
		});

		expect(hasUsageWindow(usage.primary)).toBe(true);
		expect(usage.limits[0]).toMatchObject({ name: "quota limit", leftPercent: 90 });
	});
});

describe("Codex usage endpoint", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches free-plan quotas without selecting a model", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ plan_type: "free", rate_limit: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchCodexUsage({
			accountId: "account-free",
			accessToken: "access-free",
			organizationId: undefined,
			timeoutMs: 1_000,
		})).resolves.toMatchObject({ plan_type: "free" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/wham/usage");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
	});

	it("normalizes usage endpoint workspace and token failures", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { code: "deactivated_workspace" } }), {
					status: 402,
				}),
			)
			.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		const request = {
			accountId: "account-1",
			accessToken: "access-1",
			organizationId: undefined,
			timeoutMs: 1_000,
			normalizeAccountErrors: true,
		};
		await expect(fetchCodexUsage(request)).rejects.toThrow("deactivated_workspace");
		await expect(fetchCodexUsage(request)).rejects.toThrow("authentication token has been invalidated");
	});
});
