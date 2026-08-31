import { getQuotaNotifications, loadPluginConfig, type QuotaNotificationsConfig } from "./config.js";
import {
	deduplicateUsageAccountIndices,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatUsageReset,
	getUsageLeftPercent,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	type CodexUsageSummary,
} from "./codex-usage.js";
import { logDebug, logInfo, logWarn } from "./logger.js";
import {
	isDesktopNotificationSupported,
	sendDesktopNotification,
	type DesktopNotifier,
} from "./desktop-notifications.js";
import {
	getQuotaNotificationStatePath,
	updateQuotaNotificationState,
	type QuotaNotificationState,
	type QuotaWindowNotificationState,
} from "./quota-notification-state.js";
import { registerCleanup, unregisterCleanup } from "./shutdown.js";
import { loadAccounts, type AccountMetadataV3, type AccountStorageV3 } from "./storage.js";
import { getStoragePath } from "./storage/state.js";

const INITIAL_CHECK_DELAY_MS = 10_000;
const MAX_CONCURRENCY = 2;

export type QuotaWindowName = "fiveHour" | "weekly";

export interface AggregatedQuotaWindow {
	remainingPercent?: number;
	resetAtMs?: number;
}

export interface AggregatedQuotaUsage {
	fiveHour: AggregatedQuotaWindow;
	weekly: AggregatedQuotaWindow;
}

export interface QuotaThresholdCrossing {
	window: QuotaWindowName;
	threshold: number;
	remainingPercent: number;
	resetAtMs?: number;
}

export interface AccountQuotaSummary {
	usage: CodexUsageSummary;
}

export interface QuotaMonitor {
	start(): void;
	dispose(): void;
	runNow(): Promise<void>;
}

type MonitorDependencies = {
	loadConfig: () => QuotaNotificationsConfig;
	loadStorage: () => Promise<AccountStorageV3 | null>;
	fetchSummary: (
		storage: AccountStorageV3,
		account: AccountMetadataV3 | undefined,
		onCredentialsPersisted: () => void,
	) => Promise<AccountQuotaSummary | null>;
	notify: DesktopNotifier;
	notificationsSupported: () => boolean;
	/**
	 * Called once per check when refreshing an account rotated its single-use
	 * refresh token to disk. The host wires this to its account-manager cache
	 * invalidation; see {@link fetchUsageForAccount} for why it is mandatory.
	 */
	onCredentialsPersisted: () => void;
	now: () => number;
	initialDelayMs: number;
};

/**
 * Reduce one quota window across accounts to the single account that has the
 * most room left, reporting that account's own reset time.
 *
 * Two rules matter here:
 *
 *   - A window the plan has switched off is skipped via {@link hasUsageWindow}.
 *     Such a window still reports `used_percent: 0`, so counting it would score
 *     a disabled window as 100% remaining and mask every other account.
 *   - The percentage and the reset time are taken from the *same* account. A
 *     max-percent/min-reset pair describes a quota no account actually has.
 */
function aggregateWindow(
	summaries: readonly AccountQuotaSummary[],
	select: (summary: CodexUsageSummary) => CodexUsageSummary["primary"],
	now: number,
): AggregatedQuotaWindow {
	let best: { remainingPercent: number; resetAtMs?: number } | undefined;
	for (const accountSummary of summaries) {
		const window = select(accountSummary.usage);
		if (!hasUsageWindow(window)) continue;
		const remaining = getUsageLeftPercent(window.usedPercent);
		if (remaining === undefined) continue;
		const resetAtMs =
			typeof window.resetAtMs === "number" &&
			Number.isFinite(window.resetAtMs) &&
			window.resetAtMs > now
				? window.resetAtMs
				: undefined;
		if (best === undefined || remaining > best.remainingPercent) {
			best = { remainingPercent: remaining, resetAtMs };
			continue;
		}
		// Tie on headroom: prefer the account that recovers first, and prefer a
		// known reset over an unknown one.
		if (
			remaining === best.remainingPercent &&
			resetAtMs !== undefined &&
			(best.resetAtMs === undefined || resetAtMs < best.resetAtMs)
		) {
			best = { remainingPercent: remaining, resetAtMs };
		}
	}
	return best ? { remainingPercent: best.remainingPercent, resetAtMs: best.resetAtMs } : {};
}

export function aggregateQuotaUsage(
	summaries: readonly AccountQuotaSummary[],
	now = Date.now(),
): AggregatedQuotaUsage {
	return {
		fiveHour: aggregateWindow(summaries, (summary) => summary.primary, now),
		weekly: aggregateWindow(summaries, (summary) => summary.secondary, now),
	};
}

/**
 * Decide whether this observation crosses a threshold downward.
 *
 * A threshold fires when the window is at or below it *and* the previous
 * observation was strictly above it, which is the "rises above it after a
 * reset" contract in `docs/configuration.md`. The most severe matching
 * threshold wins, and the selection does not assume `thresholds` is sorted.
 */
export function transitionQuotaWindow(
	previous: QuotaWindowNotificationState,
	current: AggregatedQuotaWindow,
	thresholds: readonly number[],
): { state: QuotaWindowNotificationState; threshold?: number } {
	const remaining = current.remainingPercent;
	if (remaining === undefined) return { state: previous };

	const matching = thresholds.filter(
		(threshold) =>
			remaining <= threshold &&
			(previous.lastPercent === undefined || previous.lastPercent > threshold),
	);
	return {
		state: { lastPercent: remaining },
		threshold: matching.length > 0 ? Math.min(...matching) : undefined,
	};
}

export function transitionQuotaState(
	previous: QuotaNotificationState | undefined,
	usage: AggregatedQuotaUsage,
	thresholds: readonly number[],
	now = Date.now(),
): { state: QuotaNotificationState; crossings: QuotaThresholdCrossing[] } {
	const baseline = previous ?? { fiveHour: {}, weekly: {}, updatedAt: now };
	const fiveHour = transitionQuotaWindow(baseline.fiveHour, usage.fiveHour, thresholds);
	const weekly = transitionQuotaWindow(baseline.weekly, usage.weekly, thresholds);
	const crossings: QuotaThresholdCrossing[] = [];
	if (fiveHour.threshold !== undefined && usage.fiveHour.remainingPercent !== undefined) {
		crossings.push({
			window: "fiveHour",
			threshold: fiveHour.threshold,
			remainingPercent: usage.fiveHour.remainingPercent,
			resetAtMs: usage.fiveHour.resetAtMs,
		});
	}
	if (weekly.threshold !== undefined && usage.weekly.remainingPercent !== undefined) {
		crossings.push({
			window: "weekly",
			threshold: weekly.threshold,
			remainingPercent: usage.weekly.remainingPercent,
			resetAtMs: usage.weekly.resetAtMs,
		});
	}
	return {
		state: {
			fiveHour: fiveHour.state,
			weekly: weekly.state,
			lastDeliveredAt: baseline.lastDeliveredAt,
			updatedAt: now,
		},
		crossings,
	};
}

export function formatQuotaNotification(usage: AggregatedQuotaUsage): string {
	const fiveHourLine = usage.fiveHour.remainingPercent !== undefined
		? `5h: ${usage.fiveHour.remainingPercent}% | resets ${formatUsageReset(usage.fiveHour.resetAtMs) ?? "unavailable"}`
		: "5h: unavailable";
	const weeklyLine = usage.weekly.remainingPercent !== undefined
		? `Weekly: ${usage.weekly.remainingPercent}% | resets ${formatUsageReset(usage.weekly.resetAtMs) ?? "unavailable"}`
		: "Weekly: unavailable";
	return `${fiveHourLine}\n${weeklyLine}`;
}

interface DeliveryClaim {
	delivering: boolean;
	state: QuotaNotificationState;
	baseline: QuotaNotificationState | undefined;
	crossings: QuotaThresholdCrossing[];
	previousLastDeliveredAt: number;
}

export function createQuotaMonitor(overrides: Partial<MonitorDependencies> = {}): QuotaMonitor {
	const dependencies: MonitorDependencies = {
		loadConfig: () => getQuotaNotifications(loadPluginConfig()),
		loadStorage: loadAccounts,
		fetchSummary: fetchUsageForAccount,
		notify: sendDesktopNotification,
		notificationsSupported: isDesktopNotificationSupported,
		onCredentialsPersisted: () => undefined,
		now: Date.now,
		initialDelayMs: INITIAL_CHECK_DELAY_MS,
		...overrides,
	};
	let timer: NodeJS.Timeout | undefined;
	let started = false;
	let disposed = false;
	let running = false;
	let generation = 0;
	// Keyed by state path: the host flips `setStoragePath` at runtime, so one
	// project's threshold state must never be carried into another's file.
	const memoryStateByPath = new Map<string, QuotaNotificationState>();

	const schedule = (delayMs: number, expectedGeneration: number): void => {
		if (!started || disposed || expectedGeneration !== generation) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void tick(expectedGeneration, true);
		}, delayMs);
		timer.unref();
	};

	const releaseUndeliveredClaim = async (
		statePath: string,
		claim: DeliveryClaim,
		claimedAt: number,
	): Promise<void> => {
		const reverted: QuotaNotificationState = {
			fiveHour: claim.state.fiveHour,
			weekly: claim.state.weekly,
			lastDeliveredAt: claim.previousLastDeliveredAt > 0 ? claim.previousLastDeliveredAt : undefined,
			updatedAt: dependencies.now(),
		};
		for (const crossing of claim.crossings) {
			reverted[crossing.window] = claim.baseline?.[crossing.window] ?? {};
		}
		try {
			const applied = await updateQuotaNotificationState<boolean>(statePath, (persisted) => {
				if (persisted?.updatedAt !== claimedAt) {
					// Someone else wrote after our claim; leave their state alone.
					return { state: persisted ?? claim.state, result: false };
				}
				return { state: reverted, result: true };
			});
			if (applied) memoryStateByPath.set(statePath, reverted);
		} catch (error) {
			logWarn(`Failed to release an undelivered quota notification claim: ${(error as Error).message}`);
		}
	};

	const check = async (config: QuotaNotificationsConfig, expectedGeneration: number): Promise<void> => {
		const storage = await dependencies.loadStorage();
		if (!storage || storage.accounts.length === 0 || disposed || expectedGeneration !== generation) return;

		const indices = deduplicateUsageAccountIndices(storage);
		const summaries: AccountQuotaSummary[] = [];
		let credentialsPersisted = false;
		const markCredentialsPersisted = (): void => {
			credentialsPersisted = true;
		};
		for (let offset = 0; offset < indices.length; offset += MAX_CONCURRENCY) {
			if (disposed || expectedGeneration !== generation) break;
			const chunk = indices.slice(offset, offset + MAX_CONCURRENCY);
			const results = await Promise.all(
				chunk.map((index) => dependencies.fetchSummary(
					storage,
					storage.accounts[index],
					markCredentialsPersisted,
				)),
			);
			for (const summary of results) {
				if (summary) summaries.push(summary);
			}
		}
		// Must run even when the tick is aborting: a rotated refresh token is
		// already durable on disk, and leaving the host's cached AccountManager
		// holding the old one lets its debounced save clobber the rotation.
		if (credentialsPersisted) {
			try {
				dependencies.onCredentialsPersisted();
			} catch (error) {
				logWarn(`Failed to invalidate account cache after a quota refresh: ${(error as Error).message}`);
			}
		}
		if (summaries.length === 0 || disposed || expectedGeneration !== generation) return;

		const now = dependencies.now();
		const usage = aggregateQuotaUsage(summaries, now);
		const statePath = getQuotaNotificationStatePath(getStoragePath());
		const memoryState = memoryStateByPath.get(statePath);

		let claim: DeliveryClaim;
		try {
			// Phase 1: claim the delivery slot under the cross-process lease. The
			// notifier is NOT called here — its 10s timeout is an order of
			// magnitude longer than the lease's ~660ms retry budget, so holding
			// the lease across delivery makes concurrent processes drop whole
			// checks with ELOCKED.
			claim = await updateQuotaNotificationState<DeliveryClaim>(statePath, (persisted) => {
				const baseline =
					memoryState && (!persisted || memoryState.updatedAt > persisted.updatedAt)
						? memoryState
						: persisted;
				const transition = transitionQuotaState(baseline, usage, config.thresholds, now);
				const previousLastDeliveredAt = Math.max(
					persisted?.lastDeliveredAt ?? 0,
					memoryState?.lastDeliveredAt ?? 0,
				);
				if (previousLastDeliveredAt > 0) {
					transition.state.lastDeliveredAt = previousLastDeliveredAt;
				}
				const everyCheckDue =
					config.notifyEveryCheck &&
					(previousLastDeliveredAt === 0 || now - previousLastDeliveredAt >= config.intervalMs);
				const delivering = transition.crossings.length > 0 || everyCheckDue;
				if (delivering) transition.state.lastDeliveredAt = now;
				return {
					state: transition.state,
					result: {
						delivering,
						state: transition.state,
						baseline,
						crossings: transition.crossings,
						previousLastDeliveredAt,
					},
				};
			});
		} catch (error) {
			logWarn(`Failed to update quota notification state: ${(error as Error).message}`);
			return;
		}
		memoryStateByPath.set(statePath, claim.state);
		if (!claim.delivering) return;

		// Phase 2: deliver outside the lease.
		const delivered =
			disposed || expectedGeneration !== generation
				? false
				: await dependencies
					.notify("Codex quota status", formatQuotaNotification(usage))
					.catch((error: unknown) => {
						logDebug(`Failed to deliver quota notification: ${(error as Error).message}`);
						return false;
					});
		if (delivered) {
			logInfo("Quota notification delivered");
			return;
		}

		// Phase 3: delivery failed, so release the claim and re-arm the crossed
		// windows. Another process that claimed in the meantime keeps its claim.
		await releaseUndeliveredClaim(statePath, claim, now);
	};

	const scheduleNext = (expectedGeneration: number): void => {
		let intervalMs: number;
		try {
			intervalMs = dependencies.loadConfig().intervalMs;
		} catch (error) {
			// Reading the config is the only thing that can throw out here, and
			// `tick`'s catch cannot cover its own `finally`.
			logDebug(`Quota monitor could not schedule the next check: ${(error as Error).message}`);
			return;
		}
		schedule(intervalMs, expectedGeneration);
	};

	const tick = async (expectedGeneration: number, reschedule: boolean): Promise<void> => {
		if (disposed || expectedGeneration !== generation) return;
		if (running) {
			if (reschedule) scheduleNext(expectedGeneration);
			return;
		}
		running = true;
		// Stays true when the config read throws, so a transient failure retries
		// on the next interval instead of killing the monitor for the session.
		let keepPolling = true;
		try {
			const config = dependencies.loadConfig();
			keepPolling = config.enabled && dependencies.notificationsSupported();
			if (keepPolling) await check(config, expectedGeneration);
		} catch (error) {
			logDebug(`Quota monitor tick failed: ${(error as Error).message}`);
		} finally {
			running = false;
			// A feature that is switched off, or a platform without Notification
			// Center, stops polling rather than waking every interval forever.
			// Turning it on is a restart, which `docs/configuration.md` requires.
			if (reschedule && keepPolling) scheduleNext(expectedGeneration);
		}
	};

	const disposeMonitor = (): void => {
		if (disposed) return;
		disposed = true;
		started = false;
		generation += 1;
		if (timer) clearTimeout(timer);
		timer = undefined;
		unregisterCleanup(disposeMonitor);
	};

	return {
		start() {
			if (started && !disposed) return;
			started = true;
			disposed = false;
			generation += 1;
			// `server.instance.disposed` is not emitted on SIGINT/SIGTERM, nor by
			// every host, so the timer is also torn down by the shared drain.
			registerCleanup(disposeMonitor);
			schedule(dependencies.initialDelayMs, generation);
		},
		dispose: disposeMonitor,
		async runNow() {
			await tick(generation, false);
		},
	};
}

async function fetchUsageForAccount(
	storage: AccountStorageV3,
	account: AccountMetadataV3 | undefined,
	onCredentialsPersisted: () => void = () => undefined,
): Promise<AccountQuotaSummary | null> {
	if (!account) return null;
	try {
		const credentials = await ensureCodexUsageAccessToken({ storage, account });
		// Signal BEFORE the usage fetch: the rotation is already durable, so a
		// later throw must not swallow the cache invalidation.
		if (credentials.persisted) onCredentialsPersisted();
		const accountId = resolveCodexUsageAccountId({ account, accessToken: credentials.accessToken });
		if (!accountId) return null;
		return {
			usage: parseCodexUsagePayload(await fetchCodexUsage({
				accountId,
				accessToken: credentials.accessToken,
				organizationId: account.organizationId,
				normalizeAccountErrors: true,
			})),
		};
	} catch (error) {
		logDebug(`Failed to fetch quota for one account: ${(error as Error).message}`);
		return null;
	}
}
