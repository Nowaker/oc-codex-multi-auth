import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Event } from "@opencode-ai/sdk/v2";
import type { JSX } from "@opentui/solid";

import {
	getCodexTuiMaskEmail,
	getCodexTuiMaskEmailInQuotaDetails,
	getQuotaDisplay,
	getQuotaStatus,
	loadPluginConfig,
	type QuotaStatusConfig,
	type QuotaStatusMode,
} from "./lib/config.js";
import type { QuotaDisplayMode } from "./lib/quota-display.js";
import type {
	QuotaOverviewAccount,
	QuotaOverviewOptions,
} from "./lib/quota-overview.js";
import {
	fetchTuiQuotaOverview,
	mergeOverviewWithLatestAccount,
	toQuotaOverviewAccounts,
} from "./lib/tui-quota-overview.js";
import {
	createUsageAccountFingerprint,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatUsageWindowLabel,
	getUsageLeftPercent,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	resolveCodexUsageActiveAccount,
} from "./lib/codex-usage.js";
import {
	formatPromptStatusText,
	formatQuotaDetailsText,
	formatQuotaOverviewStatusText,
	resolveQuotaOverviewTone,
	resolveQuotaPromptTone,
	type CompactQuotaLimit,
	type CompactQuotaStatus,
	type QuotaPromptTone,
} from "./lib/tui-status.js";
import {
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	getTuiQuotaOverviewCachePath,
	isFreshTuiQuotaSnapshot,
	isTuiQuotaSnapshot,
	readTuiQuotaSnapshot,
	writeTuiQuotaSnapshot,
	type TuiQuotaSnapshot,
} from "./lib/tui-quota-cache.js";
import { loadAccounts } from "./lib/storage.js";

const CACHE_KEY = "oc-codex-multi-auth:tui-status:v2";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_REFRESH_DEBOUNCE_MS = 750;
const ACCOUNT_POLL_INTERVAL_MS = 1_000;
// The status line is the one surface that reads this configuration once and
// then renders it for the rest of the session, so it is the only one where an
// edit would otherwise need a restart to be seen. `loadPluginConfig` already
// re-reads the file on every call and only skips re-parsing when the bytes are
// unchanged, so polling it costs one read of a file measured in hundreds of
// bytes.
const CONFIG_POLL_INTERVAL_MS = 2_000;

type StoredQuotaStatus = TuiQuotaSnapshot;

type SolidRuntime = Pick<
	typeof import("@opentui/solid"),
	"createElement" | "spread"
> &
	Pick<typeof import("solid-js"), "createSignal" | "onCleanup">;

let inFlightRefresh: Promise<CompactQuotaStatus> | undefined;

type QuotaOverviewState =
	| { type: "loading" }
	| { type: "unavailable" }
	| { type: "ready"; accounts: readonly QuotaOverviewAccount[]; stale: boolean };

let inFlightOverview: Promise<QuotaOverviewState> | undefined;

async function refreshQuotaOverviewInner(
	api: TuiPluginApi,
): Promise<QuotaOverviewState> {
	try {
		const now = Date.now();
		const snapshot = await fetchTuiQuotaOverview({
			cachePath: getTuiQuotaOverviewCachePath(api.state.path.state),
			now,
		});
		if (!snapshot || snapshot.accounts.length === 0) {
			return { type: "unavailable" };
		}
		const merged = mergeOverviewWithLatestAccount(
			snapshot,
			await readSharedQuotaStatus(api),
		);
		return {
			type: "ready",
			accounts: toQuotaOverviewAccounts(merged),
			// Judged on the poll, not on the merged account: one account read a
			// moment ago does not make a five-minute-old reading of the other six
			// current.
			stale: !isFreshTuiQuotaSnapshot(merged, now),
		};
	} catch {
		return { type: "unavailable" };
	}
}

/**
 * Coalesce concurrent refreshes.
 *
 * Every session event that can move a quota schedules one of these, and
 * without this guard a burst of tool completions would start several passes
 * over the whole pool at once. The pass itself is already cheap while the
 * cache is fresh - it reads one file - so the events can stay wired to it.
 */
function refreshQuotaOverview(api: TuiPluginApi): Promise<QuotaOverviewState> {
	if (inFlightOverview) return inFlightOverview;
	inFlightOverview = refreshQuotaOverviewInner(api).finally(() => {
		inFlightOverview = undefined;
	});
	return inFlightOverview;
}

function isStoredQuotaStatus(value: unknown): value is StoredQuotaStatus {
	return isTuiQuotaSnapshot(value);
}

function readStoredQuotaStatus(
	api: TuiPluginApi,
	fingerprint: string,
): StoredQuotaStatus | undefined {
	if (!api.kv.ready) return undefined;
	try {
		const cached = api.kv.get<unknown>(CACHE_KEY);
		return isStoredQuotaStatus(cached) && cached.fingerprint === fingerprint
			? cached
			: undefined;
	} catch {
		return undefined;
	}
}

function writeStoredQuotaStatus(
	api: TuiPluginApi,
	status: StoredQuotaStatus,
): void {
	if (!api.kv.ready) return;
	try {
		api.kv.set(CACHE_KEY, status);
	} catch {
		// The prompt status is best-effort; cache write failures should not
		// affect the OpenCode TUI.
	}
}

function toCompactQuotaStatus(
	stored: StoredQuotaStatus,
	stale: boolean,
): CompactQuotaStatus {
	return {
		type: "ready",
		limits: stored.limits,
		stale,
		source: stored.source,
		fetchedAt: stored.fetchedAt,
		fingerprint: stored.fingerprint,
		accountIndex: stored.accountIndex,
		accountCount: stored.accountCount,
		accountEmail: stored.accountEmail,
		accountLabel: stored.accountLabel,
		planType: stored.planType,
		activeLimit: stored.activeLimit,
	};
}

function getQuotaSnapshotRevision(snapshot: {
	source?: string;
	fetchedAt?: number;
}): string | undefined {
	if (
		!snapshot.source ||
		typeof snapshot.fetchedAt !== "number" ||
		!Number.isFinite(snapshot.fetchedAt)
	) {
		return undefined;
	}
	return `${snapshot.source}:${snapshot.fetchedAt}`;
}

function toCompactQuotaLimit(
	window: { usedPercent?: number; windowMinutes?: number; resetAtMs?: number },
): CompactQuotaLimit | undefined {
	if (!hasUsageWindow(window)) return undefined;
	return {
		label: formatUsageWindowLabel(window.windowMinutes),
		leftPercent: getUsageLeftPercent(window.usedPercent) ?? null,
		usedPercent: window.usedPercent,
		windowMinutes: window.windowMinutes,
		resetAtMs: window.resetAtMs,
	};
}

function formatTuiAccountLabel(
	account: { email?: string; accountId?: string; organizationId?: string },
	index: number,
): string {
	return (
		account.email?.trim() ||
		account.accountId?.trim() ||
		account.organizationId?.trim() ||
		`Account ${index + 1}`
	);
}

function getSharedQuotaCachePath(api: TuiPluginApi): string {
	return getTuiQuotaCachePath(api.state.path.state);
}

async function readSharedQuotaStatus(
	api: TuiPluginApi,
	fingerprint?: string,
): Promise<StoredQuotaStatus | undefined> {
	const cachePath = getSharedQuotaCachePath(api);
	const snapshot = await readTuiQuotaSnapshot(cachePath);
	if (snapshot && (fingerprint === undefined || snapshot.fingerprint === fingerprint)) return snapshot;
	const fallbackSnapshot = await readTuiQuotaSnapshot();
	return fallbackSnapshot && (fingerprint === undefined || fallbackSnapshot.fingerprint === fingerprint)
		? fallbackSnapshot
		: undefined;
}

async function writeSharedQuotaStatus(
	api: TuiPluginApi,
	status: StoredQuotaStatus,
): Promise<void> {
	try {
		await writeTuiQuotaSnapshot(status, getSharedQuotaCachePath(api));
	} catch {
		// The prompt status is best-effort; shared cache write failures should
		// not affect the OpenCode TUI.
	}
}

export async function resolveQuotaPollFingerprint(
	api: TuiPluginApi,
): Promise<string | undefined> {
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) return undefined;
	const shared = await readSharedQuotaStatus(api);
	if (
		shared?.source === "headers" &&
		isFreshTuiQuotaSnapshot(shared) &&
		storage.accounts.some(
			(account) => createUsageAccountFingerprint(account) === shared.fingerprint,
		)
	) {
		return shared.fingerprint;
	}
	const selection = resolveCodexUsageActiveAccount(storage);
	return selection
		? createUsageAccountFingerprint(selection.account)
		: undefined;
}

export async function refreshQuotaStatusInner(
	api: TuiPluginApi,
): Promise<CompactQuotaStatus> {
	try {
		const storage = await loadAccounts();
		if (!storage || storage.accounts.length === 0) {
			return { type: "missing" };
		}

		const latestShared = await readSharedQuotaStatus(api);
		const now = Date.now();
		// A shared snapshot only proves freshness while requests flow: the
		// request path pushes it per response, but during an idle gap nothing
		// rewrites it and the quota windows it describes may have reset
		// server-side. Trust it as current within one refresh interval;
		// otherwise fall through to a live /wham/usage read and keep the
		// snapshot only as a stale fallback.
		if (latestShared?.source === "headers" && isFreshTuiQuotaSnapshot(latestShared, now) &&
			storage.accounts.some((account) => createUsageAccountFingerprint(account) === latestShared.fingerprint)) {
			writeStoredQuotaStatus(api, latestShared);
			return toCompactQuotaStatus(latestShared, false);
		}
		const selection = resolveCodexUsageActiveAccount(storage);
		if (!selection) return { type: "missing" };
		const fingerprint = createUsageAccountFingerprint(selection.account);
		const shared = await readSharedQuotaStatus(api, fingerprint);
		const stored = readStoredQuotaStatus(api, fingerprint);
		const cached =
			shared && (!stored || shared.fetchedAt >= stored.fetchedAt)
				? shared
				: stored;

		try {
			const credentials = await ensureCodexUsageAccessToken({
				storage,
				account: selection.account,
			});
			const accountId = resolveCodexUsageAccountId({
				account: selection.account,
				accessToken: credentials.accessToken,
			});
			if (!accountId) throw new Error("Missing account id");

			const payload = await fetchCodexUsage({
				accountId,
				accessToken: credentials.accessToken,
				organizationId: selection.account.organizationId,
			});
			const usage = parseCodexUsagePayload(payload);
			const limits = [
				toCompactQuotaLimit(usage.primary),
				toCompactQuotaLimit(usage.secondary),
			].filter((limit): limit is CompactQuotaLimit => Boolean(limit));
			const stored = createTuiQuotaSnapshot({
				fingerprint,
				source: "usage",
				accountIndex: selection.index + 1,
				accountCount: storage.accounts.length,
				accountEmail: selection.account.email?.trim() || undefined,
				accountLabel: formatTuiAccountLabel(
					selection.account,
					selection.index,
				),
				planType: usage.planType ?? undefined,
				limits,
				fetchedAt: now,
			});
			writeStoredQuotaStatus(api, stored);
			await writeSharedQuotaStatus(api, stored);
			return toCompactQuotaStatus(stored, false);
		} catch {
			return cached ? toCompactQuotaStatus(cached, true) : { type: "unavailable" };
		}
	} catch {
		return { type: "unavailable" };
	}
}

function refreshQuotaStatus(api: TuiPluginApi): Promise<CompactQuotaStatus> {
	if (inFlightRefresh) return inFlightRefresh;
	inFlightRefresh = refreshQuotaStatusInner(api).finally(() => {
		inFlightRefresh = undefined;
	});
	return inFlightRefresh;
}

export function shouldRefreshQuotaForEvent(event: Event): boolean {
	switch (event.type) {
		case "message.updated":
			return (
				event.properties.info.role === "assistant" &&
				typeof event.properties.info.time.completed === "number"
			);
		case "message.part.updated": {
			const { part } = event.properties;
			if (part.type === "step-finish") return true;
			if (part.type !== "tool") return false;
			return (
				part.state.status === "completed" || part.state.status === "error"
			);
		}
		case "session.idle":
		case "session.error":
			return true;
		case "session.status":
			return event.properties.status.type === "idle";
		default:
			return false;
	}
}

type PromptStatusOptions = {
	maskEmail: boolean;
	maskEmailInQuotaDetails: boolean;
	quotaDisplay: QuotaDisplayMode;
	quotaStatus: QuotaStatusConfig;
};

export function readPromptStatusOptions(): PromptStatusOptions {
	const pluginConfig = loadPluginConfig();
	return {
		maskEmail: getCodexTuiMaskEmail(pluginConfig),
		maskEmailInQuotaDetails: getCodexTuiMaskEmailInQuotaDetails(pluginConfig),
		quotaDisplay: getQuotaDisplay(pluginConfig),
		quotaStatus: getQuotaStatus(pluginConfig),
	};
}

/**
 * Whether two readings of the configuration would render the same line.
 *
 * Compared field by field rather than by identity: every poll builds a fresh
 * object, so identity always differs and pushing it into a signal would
 * re-render the status line every two seconds forever.
 */
export function samePromptStatusOptions(
	left: PromptStatusOptions,
	right: PromptStatusOptions,
): boolean {
	return (
		left.maskEmail === right.maskEmail &&
		left.maskEmailInQuotaDetails === right.maskEmailInQuotaDetails &&
		left.quotaDisplay === right.quotaDisplay &&
		left.quotaStatus.mode === right.quotaStatus.mode &&
		left.quotaStatus.accounts === right.quotaStatus.accounts &&
		left.quotaStatus.multipliers === right.quotaStatus.multipliers &&
		left.quotaStatus.resetTimes === right.quotaStatus.resetTimes &&
		left.quotaStatus.resetCredits === right.quotaStatus.resetCredits &&
		left.quotaStatus.recovery === right.quotaStatus.recovery
	);
}

/**
 * One status line's data pipeline, separated from the node that shows it.
 *
 * `mode` chooses between two pipelines that poll different things, and it can
 * change while a session is open. Keeping the data behind this interface lets
 * the node stay put and simply read from whichever pipeline is current, rather
 * than the slot having to replace a node the renderer already mounted.
 */
type QuotaStatusController = {
	content(options: PromptStatusOptions): string;
	tone(): QuotaPromptTone;
	dispose(): void;
};

function toQuotaOverviewOptions(
	options: PromptStatusOptions,
	now: number,
): QuotaOverviewOptions {
	// Spelled out rather than spread: `QuotaStatusConfig.mode` selects the
	// status line's shape while `QuotaOverviewOptions.mode` is the free/used
	// wording, and spreading one over the other silently renders every
	// percentage as headroom.
	return {
		mode: options.quotaDisplay,
		accounts: options.quotaStatus.accounts,
		multipliers: options.quotaStatus.multipliers,
		resetTimes: options.quotaStatus.resetTimes,
		resetCredits: options.quotaStatus.resetCredits,
		recovery: options.quotaStatus.recovery,
		now,
	};
}

/**
 * The pool-wide status line's data pipeline.
 *
 * Kept apart from the active-account one rather than branching inside it:
 * that one maintains a serving-account fingerprint, a snapshot revision and a
 * one-second identity poll, all of which exist to answer "which account is
 * this" - the question this mode is built to stop asking.
 */
function createOverviewQuotaController(
	api: TuiPluginApi,
	solid: SolidRuntime,
): QuotaStatusController {
	const [state, setState] = solid.createSignal<QuotaOverviewState>({
		type: "loading",
	});
	const refresh = (): void => {
		void refreshQuotaOverview(api).then(setState, () => {
			setState({ type: "unavailable" });
		});
	};
	let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	const scheduleRefresh = (): void => {
		if (refreshTimeout) clearTimeout(refreshTimeout);
		refreshTimeout = setTimeout(() => {
			refreshTimeout = undefined;
			refresh();
		}, EVENT_REFRESH_DEBOUNCE_MS);
	};

	refresh();
	const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
	const disposers = [
		api.event.on("message.updated", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("message.part.updated", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("session.idle", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("session.status", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("session.error", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
	];
	return {
		content(options) {
			const current = state();
			if (current.type !== "ready") {
				// Blank while the first pass runs; a placeholder swapped out a
				// moment later is exactly the flicker this mode removes.
				return current.type === "loading" ? "" : "limits ?";
			}
			return formatQuotaOverviewStatusText({
				accounts: current.accounts,
				options: toQuotaOverviewOptions(options, Date.now()),
				width: api.renderer.width,
			});
		},
		tone() {
			const current = state();
			if (current.type === "ready") {
				return resolveQuotaOverviewTone(current.accounts, current.stale);
			}
			return current.type === "loading" ? "unknown" : "warning";
		},
		dispose() {
			clearInterval(interval);
			if (refreshTimeout) clearTimeout(refreshTimeout);
			for (const dispose of disposers) dispose();
		},
	};
}

/** The serving-account pipeline: the status line's original behaviour. */
function createActiveQuotaController(
	api: TuiPluginApi,
	solid: SolidRuntime,
): QuotaStatusController {
	const [quota, setQuota] = solid.createSignal<CompactQuotaStatus>({
		type: "loading",
	});
	let currentFingerprint: string | undefined;
	let currentSnapshotRevision: string | undefined;
	const applyQuota = (next: CompactQuotaStatus): void => {
		if (next.type === "ready") {
			currentFingerprint = next.fingerprint;
			currentSnapshotRevision = getQuotaSnapshotRevision(next);
		}
		if (next.type === "missing") {
			currentFingerprint = undefined;
			currentSnapshotRevision = undefined;
		}
		setQuota(next);
	};
	const refresh = (): void => {
		void refreshQuotaStatus(api).then(applyQuota, () => {
			applyQuota({ type: "unavailable" });
		});
	};
	let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	const scheduleRefresh = (): void => {
		if (refreshTimeout) clearTimeout(refreshTimeout);
		refreshTimeout = setTimeout(() => {
			refreshTimeout = undefined;
			refresh();
		}, EVENT_REFRESH_DEBOUNCE_MS);
	};

	refresh();
	const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
	let cachePollInFlight = false;
	const pollSharedQuotaCache = (): void => {
		if (cachePollInFlight) return;
		cachePollInFlight = true;
		void (async () => {
			const fingerprint = await resolveQuotaPollFingerprint(api);
			if (!fingerprint) {
				if (currentFingerprint) applyQuota({ type: "missing" });
				return;
			}
			if (fingerprint !== currentFingerprint) {
				currentFingerprint = fingerprint;
				currentSnapshotRevision = undefined;
				setQuota({ type: "loading" });
				refresh();
				return;
			}
			const shared = await readSharedQuotaStatus(api, fingerprint);
			if (!shared) return;
			const revision = getQuotaSnapshotRevision(shared);
			if (!revision || revision === currentSnapshotRevision) return;
			writeStoredQuotaStatus(api, shared);
			// A changed revision is usually a fresh push from the request path,
			// but on TUI startup this poll can see an old snapshot before the
			// initial live fetch lands — render that honestly as stale.
			applyQuota(toCompactQuotaStatus(shared, !isFreshTuiQuotaSnapshot(shared)));
		})().finally(() => {
			cachePollInFlight = false;
		});
	};
	const accountInterval = setInterval(
		pollSharedQuotaCache,
		ACCOUNT_POLL_INTERVAL_MS,
	);
	const disposeMessageUpdated = api.event.on("message.updated", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	const disposeMessagePartUpdated = api.event.on(
		"message.part.updated",
		(event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		},
	);
	const disposeSessionIdle = api.event.on("session.idle", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	const disposeSessionStatus = api.event.on("session.status", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	const disposeSessionError = api.event.on("session.error", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	return {
		content(options) {
			return formatPromptStatusText({
				quota: quota(),
				width: api.renderer.width,
				maskEmail: options.maskEmail,
				quotaDisplay: options.quotaDisplay,
			});
		},
		tone() {
			return resolveQuotaPromptTone(quota());
		},
		dispose() {
			clearInterval(interval);
			clearInterval(accountInterval);
			if (refreshTimeout) clearTimeout(refreshTimeout);
			disposeMessageUpdated();
			disposeMessagePartUpdated();
			disposeSessionIdle();
			disposeSessionStatus();
			disposeSessionError();
		},
	};
}

/**
 * The status-line node, which outlives any change to how it is configured.
 *
 * Both the shape of the line and the pipeline behind it come from a file the
 * user edits while sessions are open, so this polls that file and swaps the
 * pipeline underneath a node the renderer keeps mounted. The alternative -
 * re-registering the slot - would ask the renderer to replace a live node, and
 * a mode change is exactly when it must not blink.
 */
function createPromptStatus(
	api: TuiPluginApi,
	solid: SolidRuntime,
	initialOptions: PromptStatusOptions,
): JSX.Element {
	const [options, setOptions] = solid.createSignal(initialOptions);
	const create = (mode: QuotaStatusMode): QuotaStatusController =>
		mode === "overview"
			? createOverviewQuotaController(api, solid)
			: createActiveQuotaController(api, solid);
	let controller = create(initialOptions.quotaStatus.mode);
	let controllerMode = initialOptions.quotaStatus.mode;

	const configInterval = setInterval(() => {
		const next = readPromptStatusOptions();
		if (samePromptStatusOptions(options(), next)) return;
		if (next.quotaStatus.mode !== controllerMode) {
			controller.dispose();
			controller = create(next.quotaStatus.mode);
			controllerMode = next.quotaStatus.mode;
		}
		setOptions(next);
	}, CONFIG_POLL_INTERVAL_MS);
	solid.onCleanup(() => {
		clearInterval(configInterval);
		controller.dispose();
	});

	const node = solid.createElement("text");
	solid.spread(
		node,
		{
			get content() {
				// Read through the signal first: a pipeline swap always comes with
				// an options change, and that is what re-subscribes this to the
				// new pipeline's state.
				return controller.content(options());
			},
			get fg() {
				options();
				const tone = controller.tone();
				if (tone === "danger") return api.theme.current.error;
				if (tone === "warning" || tone === "stale") {
					return api.theme.current.warning;
				}
				if (tone === "normal") return api.theme.current.success;
				return api.theme.current.textMuted;
			},
			selectable: false,
			truncate: true,
			wrapMode: "none",
		},
		false,
	);
	return node;
}

function showQuotaDetails(api: TuiPluginApi): void {
	// Read at open time, not at startup: the dialog is one keystroke away from
	// the line it explains, and the two disagreeing about `used` vs `free`
	// after an edit would be worse than either being stale alone.
	const options = readPromptStatusOptions();
	void refreshQuotaStatus(api).then(
		(status) => {
			api.ui.dialog.replace(() =>
				api.ui.DialogAlert({
					title: "Codex quota",
					message: formatQuotaDetailsText(status, Date.now(), {
						maskEmail: options.maskEmail && options.maskEmailInQuotaDetails,
						quotaDisplay: options.quotaDisplay,
					}),
					onConfirm: () => api.ui.dialog.clear(),
				}),
			);
		},
		() => {
			api.ui.dialog.replace(() =>
				api.ui.DialogAlert({
					title: "Codex quota",
					message: formatQuotaDetailsText({ type: "unavailable" }),
					onConfirm: () => api.ui.dialog.clear(),
				}),
			);
		},
	);
}

const module: TuiPluginModule = {
	id: "oc-codex-multi-auth.status",
	async tui(api) {
		const promptOptions = readPromptStatusOptions();
		const [{ createElement, spread }, { createSignal, onCleanup }] =
			await Promise.all([import("@opentui/solid"), import("solid-js")]);
		const solid: SolidRuntime = {
			createElement,
			spread,
			createSignal,
			onCleanup,
		};

		api.slots.register({
			slots: {
				session_prompt_right: () =>
					createPromptStatus(api, solid, promptOptions),
			},
		});
		const disposeCommand = api.command.register(() => [
			{
				title: "Codex quota details",
				value: "codex.quota.details",
				description:
					"Show active account usage, reset times, source, and last refresh.",
				category: "Codex",
				onSelect: () => showQuotaDetails(api),
			},
		]);
		api.lifecycle.onDispose(disposeCommand);
	},
};

export default module;
