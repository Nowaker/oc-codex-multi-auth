import { getQuotaNotifications, loadPluginConfig, type QuotaNotificationsConfig } from "./config.js";
import {
	deduplicateUsageAccountIndices,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatUsageReset,
	getUsageLeftPercent,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	type CodexUsageSummary,
} from "./codex-usage.js";
import { maskEmailForDisplay } from "./account-display.js";
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
import { loadAccounts, type AccountMetadataV3, type AccountStorageV3 } from "./storage.js";
import { getStoragePath } from "./storage/state.js";

const INITIAL_CHECK_DELAY_MS = 10_000;
const MAX_CONCURRENCY = 2;

export type QuotaWindowName = "fiveHour" | "weekly";

export interface AggregatedQuotaWindow {
	remainingPercent?: number;
	resetAtMs?: number;
	bestAccountEmail?: string;
	resetAccountEmail?: string;
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
	bestAccountEmail?: string;
	resetAccountEmail?: string;
}

export interface AccountQuotaSummary {
	usage: CodexUsageSummary;
	email?: string;
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
		maskAccountEmails: boolean,
	) => Promise<AccountQuotaSummary | null>;
	notify: DesktopNotifier;
	notificationsSupported: () => boolean;
	now: () => number;
	initialDelayMs: number;
};

function aggregateWindow(
	summaries: readonly AccountQuotaSummary[],
	select: (summary: CodexUsageSummary) => CodexUsageSummary["primary"],
	now: number,
): AggregatedQuotaWindow {
	let remainingPercent: number | undefined;
	let resetAtMs: number | undefined;
	let bestAccountEmail: string | undefined;
	let resetAccountEmail: string | undefined;
	for (const accountSummary of summaries) {
		const window = select(accountSummary.usage);
		const remaining = getUsageLeftPercent(window.usedPercent);
		if (remaining !== undefined && (remainingPercent === undefined || remaining > remainingPercent)) {
			remainingPercent = remaining;
			bestAccountEmail = accountSummary.email;
		}
		if (
			typeof window.resetAtMs === "number" &&
			Number.isFinite(window.resetAtMs) &&
			window.resetAtMs > now &&
			(resetAtMs === undefined || window.resetAtMs < resetAtMs)
		) {
			resetAtMs = window.resetAtMs;
			resetAccountEmail = accountSummary.email;
		}
	}
	return { remainingPercent, resetAtMs, bestAccountEmail, resetAccountEmail };
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

function activeThresholdFor(percent: number, thresholds: readonly number[]): number | undefined {
	return thresholds.filter((threshold) => percent <= threshold).at(-1);
}

export function transitionQuotaWindow(
	previous: QuotaWindowNotificationState,
	current: AggregatedQuotaWindow,
	thresholds: readonly number[],
): { state: QuotaWindowNotificationState; threshold?: number } {
	if (current.remainingPercent === undefined) return { state: previous };

	const matching = thresholds.filter((threshold) => {
		if (current.remainingPercent === undefined || current.remainingPercent > threshold) return false;
		return previous.lastPercent === undefined || previous.lastPercent > threshold;
	});
	return {
		state: {
			lastPercent: current.remainingPercent,
			activeThreshold: activeThresholdFor(current.remainingPercent, thresholds),
		},
		threshold: matching.at(-1),
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
			bestAccountEmail: usage.fiveHour.bestAccountEmail,
			resetAccountEmail: usage.fiveHour.resetAccountEmail,
		});
	}
	if (weekly.threshold !== undefined && usage.weekly.remainingPercent !== undefined) {
		crossings.push({
			window: "weekly",
			threshold: weekly.threshold,
			remainingPercent: usage.weekly.remainingPercent,
			resetAtMs: usage.weekly.resetAtMs,
			bestAccountEmail: usage.weekly.bestAccountEmail,
			resetAccountEmail: usage.weekly.resetAccountEmail,
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

export function selectPreferredQuotaWindow(usage: AggregatedQuotaUsage): {
	name: QuotaWindowName;
	label: string;
	usage: AggregatedQuotaWindow;
} | undefined {
	if (usage.fiveHour.remainingPercent !== undefined) {
		return { name: "fiveHour", label: "5-hour", usage: usage.fiveHour };
	}
	if (usage.weekly.remainingPercent !== undefined) {
		return { name: "weekly", label: "weekly", usage: usage.weekly };
	}
	return undefined;
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

export function createQuotaMonitor(overrides: Partial<MonitorDependencies> = {}): QuotaMonitor {
	const dependencies: MonitorDependencies = {
		loadConfig: () => getQuotaNotifications(loadPluginConfig()),
		loadStorage: loadAccounts,
		fetchSummary: fetchUsageForAccount,
		notify: sendDesktopNotification,
		notificationsSupported: isDesktopNotificationSupported,
		now: Date.now,
		initialDelayMs: INITIAL_CHECK_DELAY_MS,
		...overrides,
	};
	let timer: NodeJS.Timeout | undefined;
	let started = false;
	let disposed = false;
	let running = false;
	let generation = 0;
	let memoryState: QuotaNotificationState | undefined;

	const schedule = (delayMs: number, expectedGeneration: number): void => {
		if (!started || disposed || expectedGeneration !== generation) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void tick(expectedGeneration, true);
		}, delayMs);
		timer.unref();
	};

	const check = async (config: QuotaNotificationsConfig, expectedGeneration: number): Promise<void> => {
		const storage = await dependencies.loadStorage();
		if (!storage || storage.accounts.length === 0 || disposed || expectedGeneration !== generation) return;

		const indices = deduplicateUsageAccountIndices(storage);
		const summaries: AccountQuotaSummary[] = [];
		for (let offset = 0; offset < indices.length; offset += MAX_CONCURRENCY) {
			if (disposed || expectedGeneration !== generation) return;
			const chunk = indices.slice(offset, offset + MAX_CONCURRENCY);
			const results = await Promise.all(
				chunk.map((index) => dependencies.fetchSummary(
					storage,
					storage.accounts[index],
					config.maskAccountEmails,
				)),
			);
			for (const summary of results) {
				if (summary) summaries.push(summary);
			}
		}
		if (summaries.length === 0 || disposed || expectedGeneration !== generation) return;

		const now = dependencies.now();
		const usage = aggregateQuotaUsage(summaries, now);
		const statePath = getQuotaNotificationStatePath(getStoragePath());
		let transition: ReturnType<typeof transitionQuotaState> | undefined;
		try {
			const deliveredCount = await updateQuotaNotificationState(statePath, async (persisted) => {
				const baseline =
					memoryState && (!persisted || memoryState.updatedAt > persisted.updatedAt)
						? memoryState
						: persisted;
				transition = transitionQuotaState(baseline, usage, config.thresholds, now);
				const lastDeliveredAt = Math.max(
					persisted?.lastDeliveredAt ?? 0,
					memoryState?.lastDeliveredAt ?? 0,
				);
				if (lastDeliveredAt > 0) transition.state.lastDeliveredAt = lastDeliveredAt;
				let delivered = false;
				const everyCheckDue =
					config.notifyEveryCheck &&
					(lastDeliveredAt === 0 || now - lastDeliveredAt >= config.intervalMs);
				const shouldNotify = transition.crossings.length > 0 || everyCheckDue;
				if (!disposed && expectedGeneration === generation && shouldNotify) {
					delivered = await dependencies
						.notify("Codex quota low", formatQuotaNotification(usage))
						.catch((error: unknown) => {
							logDebug(`Failed to deliver quota notification: ${(error as Error).message}`);
							return false;
						});
				}
				if (delivered) transition.state.lastDeliveredAt = now;
				if (!delivered) {
					for (const crossing of transition.crossings) {
						transition.state[crossing.window] = baseline?.[crossing.window] ?? {};
					}
				}
				return {
					state: transition.state,
					result: delivered ? 1 : 0,
				};
			});
			if (transition) memoryState = transition.state;
			if (deliveredCount > 0) {
				logInfo("Quota notification delivered");
			}
		} catch (error) {
			if (transition) memoryState = transition.state;
			logWarn(`Failed to update quota notification state: ${(error as Error).message}`);
		}
	};

	const tick = async (expectedGeneration: number, reschedule: boolean): Promise<void> => {
		if (disposed || expectedGeneration !== generation) return;
		if (running) {
			if (reschedule) schedule(dependencies.loadConfig().intervalMs, expectedGeneration);
			return;
		}
		running = true;
		try {
			const config = dependencies.loadConfig();
			if (config.enabled && dependencies.notificationsSupported()) {
				await check(config, expectedGeneration);
			}
		} catch (error) {
			logDebug(`Quota monitor tick failed: ${(error as Error).message}`);
		} finally {
			running = false;
			if (reschedule) schedule(dependencies.loadConfig().intervalMs, expectedGeneration);
		}
	};

	return {
		start() {
			if (started && !disposed) return;
			started = true;
			disposed = false;
			generation += 1;
			schedule(dependencies.initialDelayMs, generation);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			started = false;
			generation += 1;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
		async runNow() {
			await tick(generation, false);
		},
	};
}

async function fetchUsageForAccount(
	storage: AccountStorageV3,
	account: AccountMetadataV3 | undefined,
	maskAccountEmails: boolean,
): Promise<AccountQuotaSummary | null> {
	if (!account) return null;
	try {
		const credentials = await ensureCodexUsageAccessToken({ storage, account });
		const accountId = resolveCodexUsageAccountId({ account, accessToken: credentials.accessToken });
		if (!accountId) return null;
		return {
			usage: parseCodexUsagePayload(await fetchCodexUsage({
				accountId,
				accessToken: credentials.accessToken,
				organizationId: account.organizationId,
				normalizeAccountErrors: true,
			})),
			email: maskAccountEmails ? maskEmailForDisplay(account.email) : account.email,
		};
	} catch (error) {
		logDebug(`Failed to fetch quota for one account: ${(error as Error).message}`);
		return null;
	}
}
