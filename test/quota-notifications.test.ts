import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodexUsagePayload, type CodexUsageSummary } from "../lib/codex-usage.js";
import {
	aggregateQuotaUsage,
	createQuotaMonitor,
	formatQuotaNotification,
	transitionQuotaState,
	type AccountQuotaSummary,
} from "../lib/quota-notifications.js";
import {
	getQuotaNotificationStatePath,
	readQuotaNotificationState,
	updateQuotaNotificationState,
} from "../lib/quota-notification-state.js";
import { getCleanupCount } from "../lib/shutdown.js";
import { setStoragePathDirect } from "../lib/storage/state.js";

function usage(options: {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	fiveHourReset?: number;
	weeklyReset?: number;
	fiveHourWindowSeconds?: number;
	weeklyWindowSeconds?: number;
}): CodexUsageSummary {
	return parseCodexUsagePayload({
		rate_limit: {
			primary_window: {
				used_percent: options.fiveHourUsed,
				limit_window_seconds: options.fiveHourWindowSeconds ?? 18_000,
				reset_at: options.fiveHourReset,
			},
			secondary_window: {
				used_percent: options.weeklyUsed,
				limit_window_seconds: options.weeklyWindowSeconds ?? 604_800,
				reset_at: options.weeklyReset,
			},
		},
	});
}

function accountUsage(options: Parameters<typeof usage>[0]): AccountQuotaSummary {
	return { usage: usage(options) };
}

describe("quota notification aggregation", () => {
	it("reports the account with the most headroom and that same account's reset", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage({
					fiveHourUsed: 80,
					weeklyUsed: 30,
					fiveHourReset: 2_000,
					weeklyReset: 3_000,
				}),
				accountUsage({
					fiveHourUsed: 40,
					weeklyUsed: 90,
					fiveHourReset: 1_500,
					weeklyReset: 2_500,
				}),
			],
			1_000_000,
		);
		expect(result).toEqual({
			// Second account: 60% left, resetting at its own 1_500_000.
			fiveHour: {
				remainingPercent: 60,
				resetAtMs: 1_500_000,
			},
			// First account: 70% left, resetting at its own 3_000_000. Taking the
			// other account's earlier 2_500_000 here would describe a 70% quota
			// that recovers at a time no account recovers at.
			weekly: {
				remainingPercent: 70,
				resetAtMs: 3_000_000,
			},
		});
	});

	it("skips windows the plan has switched off instead of scoring them as full", () => {
		const result = aggregateQuotaUsage(
			[
				// Disabled 5-hour window: reports used_percent 0 with a zero-length
				// window, which would otherwise read as 100% remaining.
				accountUsage({
					fiveHourUsed: 0,
					fiveHourWindowSeconds: 0,
					weeklyUsed: 10,
				}),
				accountUsage({ fiveHourUsed: 98, weeklyUsed: 20 }),
			],
			1_000_000,
		);
		expect(result.fiveHour.remainingPercent).toBe(2);
		expect(result.weekly.remainingPercent).toBe(90);
	});

	it("reports nothing for a window that is disabled on every account", () => {
		const result = aggregateQuotaUsage(
			[accountUsage({ fiveHourUsed: 0, fiveHourWindowSeconds: 0, weeklyUsed: 40 })],
			1_000_000,
		);
		expect(result.fiveHour).toEqual({});
		expect(result.weekly.remainingPercent).toBe(60);
	});

	it("prefers the earliest reset when two accounts tie on headroom", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage({ fiveHourUsed: 50, fiveHourReset: 3_000 }),
				accountUsage({ fiveHourUsed: 50, fiveHourReset: 1_500 }),
			],
			1_000_000,
		);
		expect(result.fiveHour).toEqual({ remainingPercent: 50, resetAtMs: 1_500_000 });
	});

	it("ignores expired reset timestamps", () => {
		const result = aggregateQuotaUsage(
			[accountUsage({
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
			},
			weekly: {
				remainingPercent: 72,
				resetAtMs: Date.now() + 120_000,
			},
		};
		const lines = formatQuotaNotification(aggregate).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^5h: 8% \| resets .+$/);
		expect(lines[1]).toMatch(/^Weekly: 72% \| resets .+$/);
	});

	it("handles a missing quota window", () => {
		expect(formatQuotaNotification({
			fiveHour: {},
			weekly: { remainingPercent: 20 },
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

	it("re-arms only when the window rises strictly above the threshold", () => {
		// A partial recovery to exactly 25 does not re-arm the 25% alert, which
		// is the documented contract: the window must rise *above* it. The user
		// was already told about 25 on the way down, and the more severe
		// thresholds below it still fire normally.
		const low = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		expect(low.crossings[0]?.threshold).toBe(25);

		const partialRecovery = transitionQuotaState(
			low.state,
			{ fiveHour: { remainingPercent: 25 }, weekly: {} },
			thresholds,
		);
		expect(partialRecovery.crossings).toEqual([]);

		const dropAgain = transitionQuotaState(
			partialRecovery.state,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		expect(dropAgain.crossings).toEqual([]);

		const deeper = transitionQuotaState(
			dropAgain.state,
			{ fiveHour: { remainingPercent: 9 }, weekly: {} },
			thresholds,
		);
		expect(deeper.crossings[0]?.threshold).toBe(10);
	});

	it("picks the most severe crossing without assuming the thresholds are sorted", () => {
		const result = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 5 }, weekly: {} },
			[0, 25, 10],
		);
		expect(result.crossings[0]?.threshold).toBe(10);
	});

	it("never alerts when thresholds are explicitly empty", () => {
		const result = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 0 } },
			[],
		);
		expect(result.crossings).toEqual([]);
		expect(result.state.fiveHour).toEqual({ lastPercent: 0 });
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
			loadConfig: () => ({ enabled: false, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			initialDelayMs: 10,
		});
		monitor.start();
		monitor.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(loadStorage).not.toHaveBeenCalled();
		monitor.dispose();
	});

	it("stops rescheduling once it sees the feature switched off", async () => {
		vi.useFakeTimers();
		const loadConfig = vi.fn(() => ({
			enabled: false,
			intervalMs: 1_000,
			notifyEveryCheck: false,
			thresholds: [25, 10, 0],
		}));
		const monitor = createQuotaMonitor({ loadConfig, initialDelayMs: 10 });

		monitor.start();
		await vi.advanceTimersByTimeAsync(10_000);

		// One tick, then no standing timer: a disabled feature must not wake the
		// host every interval for the life of the process.
		expect(vi.getTimerCount()).toBe(0);
		monitor.dispose();
	});

	it("does not poll a configuration that can never deliver", async () => {
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			// Enabled, but with no thresholds and no every-check alert there is
			// nothing any check could produce.
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [] }),
			loadStorage,
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(loadStorage).not.toHaveBeenCalled();
	});

	it("keeps polling on the configured interval while enabled", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			notificationsSupported: () => true,
			initialDelayMs: 10,
		});

		monitor.start();
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(loadStorage).toHaveBeenCalledTimes(3);
		monitor.dispose();
	});

	it("cancels a scheduled check on disposal", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
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
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
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
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({
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
		expect(notify).toHaveBeenCalledWith(
			"Codex quota status",
			"5h: 50% | resets unavailable\nWeekly: 20% | resets unavailable",
		);
	});

	it("notifies after every successful check when configured", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(true);
		let now = 1_000;
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({
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
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3 as const,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({
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
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
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

	it("invalidates the account cache when a refresh rotated a credential", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const onCredentialsPersisted = vi.fn();
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			// A rotation that is durable on disk even though the usage fetch then
			// fails: the stale cached AccountManager still has to be dropped.
			fetchSummary: async (_storage, _account, credentialsPersisted) => {
				credentialsPersisted();
				return null;
			},
			notify: vi.fn().mockResolvedValue(true),
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(onCredentialsPersisted).not.toHaveBeenCalled();

		const withCallback = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async (_storage, _account, credentialsPersisted) => {
				credentialsPersisted();
				return null;
			},
			onCredentialsPersisted,
			notify: vi.fn().mockResolvedValue(true),
			notificationsSupported: () => true,
		});

		await withCallback.runNow();

		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
	});

	it("delivers the notification outside the cross-process state lease", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const statePath = getQuotaNotificationStatePath(storagePath);
		let leaseWasFree: boolean | undefined;

		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({ fiveHourUsed: 50, weeklyUsed: 50 }),
			// Stands in for the ~10s osascript call. Another process must be able
			// to take the lease while this runs.
			notify: async () => {
				leaseWasFree = await updateQuotaNotificationState(statePath, (persisted) => ({
					state: persisted ?? { fiveHour: {}, weekly: {}, updatedAt: 1 },
					result: true,
				})).catch(() => false);
				return true;
			},
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(leaseWasFree).toBe(true);
	});

	it("re-arms a crossed threshold when delivery fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(false);
		const dependencies = {
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3 as const,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({ fiveHourUsed: 50, weeklyUsed: 80 }),
			notify,
			notificationsSupported: () => true,
			now: () => 1_000,
		};
		const monitor = createQuotaMonitor(dependencies);

		await monitor.runNow();
		await monitor.runNow();

		// Both checks saw weekly at 20%: the first crossing was never delivered,
		// so the second must try again rather than treat it as already alerted.
		expect(notify).toHaveBeenCalledTimes(2);
		expect(await readQuotaNotificationState(getQuotaNotificationStatePath(join(directory, "accounts.json"))))
			.toMatchObject({ weekly: {}, lastDeliveredAt: undefined });
	});

	it("writes state beside the accounts file the check actually read", async () => {
		const projectA = await mkdtemp(join(tmpdir(), "quota-monitor-a-"));
		const projectB = await mkdtemp(join(tmpdir(), "quota-monitor-b-"));
		tempDirectories.push(projectA, projectB);
		const accountsA = join(projectA, "accounts.json");
		const accountsB = join(projectB, "accounts.json");
		setStoragePathDirect(accountsA);

		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => {
				// The host switched projects while the fetches were in flight.
				setStoragePathDirect(accountsB);
				return accountUsage({ fiveHourUsed: 50, weeklyUsed: 50 });
			},
			notify: vi.fn().mockResolvedValue(true),
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(await readQuotaNotificationState(getQuotaNotificationStatePath(accountsA))).toBeTruthy();
		expect(await readQuotaNotificationState(getQuotaNotificationStatePath(accountsB))).toBeUndefined();
	});

	it("tears the timer down through the shared shutdown drain", () => {
		vi.useFakeTimers();
		const before = getCleanupCount();
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: false, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			initialDelayMs: 10,
		});

		monitor.start();
		expect(getCleanupCount()).toBe(before + 1);

		monitor.dispose();
		expect(getCleanupCount()).toBe(before);
	});
});
