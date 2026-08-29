import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodexUsagePayload, type CodexUsageSummary } from "../lib/codex-usage.js";
import {
	aggregateQuotaUsage,
	createQuotaMonitor,
	formatQuotaNotification,
	selectPreferredQuotaWindow,
	transitionQuotaState,
	type AccountQuotaSummary,
} from "../lib/quota-notifications.js";
import { setStoragePathDirect } from "../lib/storage/state.js";

function usage(options: {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	fiveHourReset?: number;
	weeklyReset?: number;
}): CodexUsageSummary {
	return parseCodexUsagePayload({
		rate_limit: {
			primary_window: {
				used_percent: options.fiveHourUsed,
				limit_window_seconds: 18_000,
				reset_at: options.fiveHourReset,
			},
			secondary_window: {
				used_percent: options.weeklyUsed,
				limit_window_seconds: 604_800,
				reset_at: options.weeklyReset,
			},
		},
	});
}

function accountUsage(email: string, options: Parameters<typeof usage>[0]): AccountQuotaSummary {
	return { email, usage: usage(options) };
}

describe("quota notification aggregation", () => {
	it("uses the best remaining quotas and earliest future resets", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage("fi***@example.com", {
					fiveHourUsed: 80,
					weeklyUsed: 30,
					fiveHourReset: 2_000,
					weeklyReset: 3_000,
				}),
				accountUsage("se***@example.com", {
					fiveHourUsed: 40,
					weeklyUsed: 90,
					fiveHourReset: 1_500,
					weeklyReset: 2_500,
				}),
			],
			1_000_000,
		);
		expect(result).toEqual({
			fiveHour: {
				remainingPercent: 60,
				resetAtMs: 1_500_000,
				bestAccountEmail: "se***@example.com",
				resetAccountEmail: "se***@example.com",
			},
			weekly: {
				remainingPercent: 70,
				resetAtMs: 2_500_000,
				bestAccountEmail: "fi***@example.com",
				resetAccountEmail: "se***@example.com",
			},
		});
	});

	it("ignores expired reset timestamps", () => {
		const result = aggregateQuotaUsage(
			[accountUsage("ac***@example.com", {
				fiveHourUsed: 50,
				weeklyUsed: 50,
				fiveHourReset: 500,
				weeklyReset: 2_000,
			})],
			1_000_000,
		);
		expect(result.fiveHour.resetAtMs).toBeUndefined();
		expect(result.weekly.resetAtMs).toBe(2_000_000);
	});
});

describe("quota notification content", () => {
	it("shows a compact 5-hour summary and weekly best", () => {
		const aggregate = {
			fiveHour: {
				remainingPercent: 8,
				resetAtMs: Date.now() + 60_000,
				bestAccountEmail: "fi***@example.com",
				resetAccountEmail: "re***@example.com",
			},
			weekly: {
				remainingPercent: 72,
				resetAtMs: Date.now() + 120_000,
				bestAccountEmail: "be***@example.com",
				resetAccountEmail: "we***@example.com",
			},
		};
		expect(selectPreferredQuotaWindow(aggregate)?.name).toBe("fiveHour");
		const lines = formatQuotaNotification(aggregate).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^5h: 8% \| resets .+$/);
		expect(lines[1]).toMatch(/^Weekly: 72% \| resets .+$/);
	});

	it("handles a missing quota window", () => {
		expect(formatQuotaNotification({
			fiveHour: {},
			weekly: { remainingPercent: 20, bestAccountEmail: "we***@example.com" },
		})).toBe("5h: unavailable\nWeekly: 20% | resets unavailable");
	});
});

describe("quota threshold transitions", () => {
	const thresholds = [25, 10, 0];

	it("triggers 25%, 10%, and 0% as separate downward crossings", () => {
		const first = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 100 } },
			thresholds,
		);
		expect(first.crossings.map((crossing) => crossing.threshold)).toEqual([25]);

		const second = transitionQuotaState(
			first.state,
			{ fiveHour: { remainingPercent: 9 }, weekly: { remainingPercent: 100 } },
			thresholds,
		);
		expect(second.crossings.map((crossing) => crossing.threshold)).toEqual([10]);

		const third = transitionQuotaState(
			second.state,
			{ fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 100 } },
			thresholds,
		);
		expect(third.crossings.map((crossing) => crossing.threshold)).toEqual([0]);
	});

	it("selects the most severe threshold when usage jumps across bands", () => {
		const baseline = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 50 }, weekly: {} },
			thresholds,
		).state;
		const result = transitionQuotaState(
			baseline,
			{ fiveHour: { remainingPercent: 5 }, weekly: {} },
			thresholds,
		);
		expect(result.crossings[0]?.threshold).toBe(10);
	});

	it("tracks 5-hour and weekly windows independently", () => {
		const first = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 50 } },
			thresholds,
		);
		const second = transitionQuotaState(
			first.state,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 20 } },
			thresholds,
		);
		expect(second.crossings).toMatchObject([
			{ window: "weekly", threshold: 25, remainingPercent: 20 },
		]);
	});

	it("preserves valid observations when a window is missing", () => {
		const first = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 40 } },
			thresholds,
		);
		const second = transitionQuotaState(first.state, { fiveHour: {}, weekly: {} }, thresholds);
		expect(second.state.fiveHour).toEqual(first.state.fiveHour);
		expect(second.state.weekly).toEqual(first.state.weekly);
		expect(second.crossings).toEqual([]);
	});

	it("suppresses duplicates and re-arms after a reset", () => {
		const low = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		const duplicate = transitionQuotaState(
			low.state,
			{ fiveHour: { remainingPercent: 15 }, weekly: {} },
			thresholds,
		);
		expect(duplicate.crossings).toEqual([]);

		const reset = transitionQuotaState(
			duplicate.state,
			{ fiveHour: { remainingPercent: 100 }, weekly: {} },
			thresholds,
		);
		const lowAgain = transitionQuotaState(
			reset.state,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		expect(lowAgain.crossings[0]?.threshold).toBe(25);
	});
});

describe("quota monitor lifecycle", () => {
	const tempDirectories: string[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		setStoragePathDirect(null);
		await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("does not poll accounts while disabled and starts only one timer", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: false, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			initialDelayMs: 10,
		});
		monitor.start();
		monitor.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(loadStorage).not.toHaveBeenCalled();
		monitor.dispose();
	});

	it("cancels a scheduled check on disposal", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			initialDelayMs: 10,
		});
		monitor.start();
		monitor.dispose();
		await vi.advanceTimersByTimeAsync(20);
		expect(loadStorage).not.toHaveBeenCalled();
	});

	it("does not poll accounts when desktop notifications are unsupported", async () => {
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			notificationsSupported: () => false,
		});

		await monitor.runNow();
		expect(loadStorage).not.toHaveBeenCalled();
	});

	it("notifies when only the weekly window crosses a threshold", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		let weeklyUsed = 50;
		const notify = vi.fn().mockResolvedValue(true);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage("ac***@example.com", {
				fiveHourUsed: 50,
				weeklyUsed,
			}),
			notify,
			notificationsSupported: () => true,
		});

		await monitor.runNow();
		weeklyUsed = 80;
		await monitor.runNow();

		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[1]).toBe("5h: 50% | resets unavailable\nWeekly: 20% | resets unavailable");
	});

	it("notifies after every successful check when configured", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(true);
		let now = 1_000;
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage("ac***@example.com", {
				fiveHourUsed: 50,
				weeklyUsed: 50,
			}),
			notify,
			notificationsSupported: () => true,
			now: () => now,
		});

		await monitor.runNow();
		now += 1_000;
		await monitor.runNow();

		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("delivers only once per interval across monitor instances", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(true);
		const dependencies = {
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3 as const,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage("ac***@example.com", {
				fiveHourUsed: 50,
				weeklyUsed: 50,
			}),
			notify,
			notificationsSupported: () => true,
			now: () => 1_000,
		};

		await Promise.all([
			createQuotaMonitor(dependencies).runNow(),
			createQuotaMonitor(dependencies).runNow(),
		]);

		expect(notify).toHaveBeenCalledOnce();
	});

	it("does not notify every check when no quota fetch succeeds", async () => {
		const notify = vi.fn().mockResolvedValue(true);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: true, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => null,
			notify,
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(notify).not.toHaveBeenCalled();
	});

	it("omits account identities even when masking is disabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(true);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, maskAccountEmails: false, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async (_storage, _account, maskAccountEmails) => accountUsage(
				maskAccountEmails ? "ac***@example.com" : "account@example.com",
				{ fiveHourUsed: 50, weeklyUsed: 50 },
			),
			notify,
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(notify.mock.calls[0]?.[1]).toBe("5h: 50% | resets unavailable\nWeekly: 50% | resets unavailable");
	});
});
