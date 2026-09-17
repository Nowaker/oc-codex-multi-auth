/**
 * One constant line describing the whole account pool.
 *
 * The prompt status line names whichever account served the most recent
 * request, so on a pool of several accounts it changes identity as rotation
 * moves - and a reader who wants to know where the pool stands has to watch it
 * long enough to see every account go past. This module renders the pool
 * instead: every account at once, in a fixed order, so the line only changes
 * when the underlying quota does.
 *
 * ```text
 * 24%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%
 * ```
 *
 * The leading figure is the pool total, and it is a WEIGHTED mean rather than
 * a plain one. A Pro seat spent to 50% has given up twenty times the capacity
 * a Business Standard seat does at 50%, so averaging the percentages
 * unweighted describes a pool nobody has; `lib/plan-allotment.ts` supplies the
 * per-plan ratio the mean is taken over.
 *
 * Percentages follow `quotaDisplay` like every other surface, so the same pool
 * reads `24%` as headroom or `76%` as consumption. Only the wording changes:
 * every decision here - which window governs an account, which account is
 * closest to recovering, whether a reset time is worth the characters - stays
 * keyed on the percentage remaining.
 */

import {
	formatPlanMultiplier,
	getPlanWeight,
} from "./plan-allotment.js";
import {
	formatQuotaPercent,
	toQuotaDisplayPercent,
	type QuotaDisplayMode,
} from "./quota-display.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Only an account at or below this headroom gets its reset time printed.
 *
 * Every account has a reset, and printing all of them triples the length of
 * the line to say "this account you are not waiting on recovers at some point
 * too". The threshold matches the one the single-account status line already
 * uses to decide the same question, so an account near exhaustion reads the
 * same way in either mode.
 */
export const OVERVIEW_RESET_LEFT_PERCENT = 25;

/** Smallest pool-total movement worth spending characters on. */
const MIN_RECOVERY_DELTA_PERCENT = 1;

export type QuotaOverviewWindow = {
	/** Percentage of this window still free, 0-100. */
	leftPercent?: number;
	resetAtMs?: number;
};

export type QuotaOverviewAccount = {
	/** 1-based position, as `codex-list` and `codex-switch` number accounts. */
	index: number;
	/** `plan_type` as reported by `/wham/usage`, used for the weighting only. */
	planType?: string;
	windows: readonly QuotaOverviewWindow[];
	/** Banked rate-limit resets redeemable now, rendered as `1r`. */
	resetCredits?: number;
};

export type QuotaOverviewOptions = {
	mode: QuotaDisplayMode;
	/** Per-account breakdown, versus a bare `3 accounts`. */
	accounts: boolean;
	/** `5x` / `20x` allotment badges beside each account. */
	multipliers: boolean;
	/** `3d` beside an account close to exhaustion. */
	resetTimes: boolean;
	/** `1r` for redeemable banked resets. */
	resetCredits: boolean;
	/** `+12% in 3d`: how far the pool total moves at the next reset. */
	recovery: boolean;
	now?: number;
};

export type QuotaOverviewRecovery = {
	/**
	 * Pool-total movement at {@link atMs}, in percentage points, always
	 * positive - it is capacity returning. The rendered sign follows the
	 * display mode, since the number a reader is watching moves up under
	 * `free` and down under `used`.
	 */
	deltaPercent: number;
	atMs: number;
};

function isPercent(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Render a duration the way a countdown reads: the largest unit that fits,
 * floored, so `2d` never claims more time remains than actually does. A gap
 * under a minute still reads `1m` rather than `0m`, because a reset that has
 * not happened yet is not zero away.
 */
export function formatCompactDuration(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	if (ms >= MS_PER_DAY) return `${Math.floor(ms / MS_PER_DAY)}d`;
	if (ms >= MS_PER_HOUR) return `${Math.floor(ms / MS_PER_HOUR)}h`;
	return `${Math.max(1, Math.floor(ms / MS_PER_MINUTE))}m`;
}

/**
 * The window that decides what an account can still do.
 *
 * An account reports several windows at once - typically a 5-hour and a weekly
 * one - and the one with the least headroom is the one that stops a request,
 * so it is the one the account is described by. On a tie the window that
 * blocks for longer governs: two windows both fully spent are not equally
 * costly when one returns in four hours and the other in three days.
 */
export function resolveGoverningWindow(
	account: QuotaOverviewAccount,
): QuotaOverviewWindow | undefined {
	let governing: QuotaOverviewWindow | undefined;
	for (const window of account.windows) {
		if (!isPercent(window.leftPercent)) continue;
		if (!governing) {
			governing = window;
			continue;
		}
		const governingLeft = governing.leftPercent ?? 100;
		if (window.leftPercent < governingLeft) {
			governing = window;
			continue;
		}
		if (
			window.leftPercent === governingLeft &&
			isPercent(window.resetAtMs) &&
			(!isPercent(governing.resetAtMs) || window.resetAtMs > governing.resetAtMs)
		) {
			governing = window;
		}
	}
	return governing;
}

/**
 * Weighted mean headroom across the pool, or `undefined` when no account
 * reported a readable window.
 *
 * Accounts with no readable window are left out rather than counted as full:
 * a quota we could not read is not capacity we know we have.
 */
export function computeWeightedLeftPercent(
	accounts: readonly QuotaOverviewAccount[],
): number | undefined {
	let weighted = 0;
	let totalWeight = 0;
	for (const account of accounts) {
		const governing = resolveGoverningWindow(account);
		if (!governing || !isPercent(governing.leftPercent)) continue;
		const weight = getPlanWeight(account.planType);
		if (!Number.isFinite(weight) || weight <= 0) continue;
		weighted += weight * governing.leftPercent;
		totalWeight += weight;
	}
	return totalWeight > 0 ? Math.round(weighted / totalWeight) : undefined;
}

/**
 * The next moment the pool gets capacity back, and how much.
 *
 * Only the window that actually resets is refilled, and the account's
 * governing window is then resolved again: an account whose 5-hour window
 * resets while its weekly window is still spent gains nothing, and reporting
 * the 5-hour refill as pool recovery would promise headroom that does not
 * arrive. Movement below one point is dropped rather than rendered as `+0%`.
 */
export function resolveQuotaOverviewRecovery(
	accounts: readonly QuotaOverviewAccount[],
	now: number = Date.now(),
): QuotaOverviewRecovery | undefined {
	const current = computeWeightedLeftPercent(accounts);
	if (current === undefined) return undefined;

	let earliest: number | undefined;
	for (const account of accounts) {
		for (const window of account.windows) {
			if (!isPercent(window.leftPercent) || window.leftPercent >= 100) continue;
			const resetAtMs = window.resetAtMs;
			if (!isPercent(resetAtMs) || resetAtMs <= now) continue;
			if (earliest === undefined || resetAtMs < earliest) earliest = resetAtMs;
		}
	}
	if (earliest === undefined) return undefined;

	const refilled = accounts.map((account) => ({
		...account,
		windows: account.windows.map((window) =>
			isPercent(window.resetAtMs) && window.resetAtMs <= earliest
				? { ...window, leftPercent: 100 }
				: window,
		),
	}));
	const recovered = computeWeightedLeftPercent(refilled);
	if (recovered === undefined) return undefined;
	const deltaPercent = recovered - current;
	if (deltaPercent < MIN_RECOVERY_DELTA_PERCENT) return undefined;
	return { deltaPercent, atMs: earliest };
}

type AccountSegmentOptions = Pick<
	QuotaOverviewOptions,
	"mode" | "multipliers" | "resetTimes" | "resetCredits"
> & { now: number };

function formatAccountSegment(
	account: QuotaOverviewAccount,
	options: AccountSegmentOptions,
): string | undefined {
	const governing = resolveGoverningWindow(account);
	if (!governing || !isPercent(governing.leftPercent)) return undefined;
	const parts = [`#${account.index}`];
	if (options.multipliers) {
		const multiplier = formatPlanMultiplier(account.planType);
		if (multiplier) parts.push(multiplier);
	}
	parts.push(formatQuotaPercent(governing.leftPercent, options.mode));
	if (
		options.resetTimes &&
		governing.leftPercent <= OVERVIEW_RESET_LEFT_PERCENT &&
		isPercent(governing.resetAtMs)
	) {
		const reset = formatCompactDuration(governing.resetAtMs - options.now);
		if (reset) parts.push(reset);
	}
	if (
		options.resetCredits &&
		typeof account.resetCredits === "number" &&
		Number.isFinite(account.resetCredits) &&
		account.resetCredits > 0
	) {
		parts.push(`${Math.trunc(account.resetCredits)}r`);
	}
	return parts.join(" ");
}

/**
 * `+12% in 3d` / `-12% in 3d`.
 *
 * The sign describes the direction the number beside it moves, not the
 * direction of the user's fortunes: under `used` the pool total falls as
 * capacity returns, and a `+` there would contradict the figure it annotates.
 */
function formatRecovery(
	recovery: QuotaOverviewRecovery,
	options: { mode: QuotaDisplayMode; now: number },
): string | undefined {
	const at = formatCompactDuration(recovery.atMs - options.now);
	if (!at) return undefined;
	const sign = options.mode === "used" ? "-" : "+";
	return `${sign}${recovery.deltaPercent}% in ${at}`;
}

function formatAccountCount(count: number): string {
	return `${count} account${count === 1 ? "" : "s"}`;
}

/**
 * Every rendering of this pool, longest first.
 *
 * The caller takes the first that fits its width. Detail is dropped in the
 * order that costs a reader the least: the recovery clause and then the
 * annotations (badges, banked resets) that sit beside a figure which stays
 * either way, then the per-account breakdown, leaving the pool total - the one
 * thing the line exists to say - as the last to go.
 *
 * Order is preference, NOT length: a stripped-down rung is occasionally a
 * character or two longer than the rung above it. Sorting by length instead
 * would let a form win or lose by two characters as a percentage crosses from
 * `9%` to `10%`, and the line would change shape while the reader watches -
 * the flicker this whole mode exists to remove.
 *
 * Candidates never exceed what {@link QuotaOverviewOptions} asked for, so a
 * switch left off cannot reappear because the terminal happened to be wide.
 */
export function formatQuotaOverviewCandidates(
	accounts: readonly QuotaOverviewAccount[],
	options: QuotaOverviewOptions,
): string[] {
	const now = options.now ?? Date.now();
	const total = computeWeightedLeftPercent(accounts);
	if (total === undefined) return [];
	const totalText = formatQuotaPercent(total, options.mode);

	const usable = accounts.filter((account) => resolveGoverningWindow(account));
	const recovery = options.recovery
		? resolveQuotaOverviewRecovery(accounts, now)
		: undefined;
	const recoveryText = recovery
		? formatRecovery(recovery, { mode: options.mode, now })
		: undefined;

	const breakdowns: string[] = [];
	if (options.accounts) {
		// Each rung drops one annotation, so a narrow terminal loses the badge
		// rather than the account it was attached to.
		const rungs: Array<Pick<QuotaOverviewOptions, "multipliers" | "resetTimes" | "resetCredits">> = [
			{
				multipliers: options.multipliers,
				resetTimes: options.resetTimes,
				resetCredits: options.resetCredits,
			},
			{
				multipliers: false,
				resetTimes: options.resetTimes,
				resetCredits: options.resetCredits,
			},
			{ multipliers: false, resetTimes: options.resetTimes, resetCredits: false },
			{ multipliers: false, resetTimes: false, resetCredits: false },
		];
		for (const rung of rungs) {
			const segments = usable
				.map((account) =>
					formatAccountSegment(account, { ...rung, mode: options.mode, now }),
				)
				.filter((segment): segment is string => Boolean(segment));
			if (segments.length === 0) continue;
			const text = segments.join(", ");
			if (!breakdowns.includes(text)) breakdowns.push(text);
		}
	}

	const countText = formatAccountCount(usable.length);
	const candidates: string[] = [];
	const push = (...tail: Array<string | undefined>): void => {
		const body = tail.filter((part): part is string => Boolean(part));
		const text = body.length > 0 ? `${totalText}: ${body.join(", ")}` : totalText;
		if (!candidates.includes(text)) candidates.push(text);
	};

	for (const breakdown of breakdowns) {
		push(breakdown, recoveryText);
		push(breakdown);
	}
	push(countText, recoveryText);
	push(countText);
	push();
	return candidates;
}

/** The fullest rendering, for surfaces with a line to themselves. */
export function formatQuotaOverviewText(
	accounts: readonly QuotaOverviewAccount[],
	options: QuotaOverviewOptions,
): string {
	return formatQuotaOverviewCandidates(accounts, options)[0] ?? "";
}

/**
 * Headroom of the account with the most room left, for the caller that
 * colours the line.
 *
 * Deliberately the best account rather than the worst: a pool is only in
 * trouble when nothing in it has room left, and keying on the worst account
 * would paint the line red for one spent seat that rotation has already
 * stopped selecting while every other account serves requests normally.
 */
export function resolveQuotaOverviewTonePercent(
	accounts: readonly QuotaOverviewAccount[],
): number | undefined {
	let best: number | undefined;
	for (const account of accounts) {
		const governing = resolveGoverningWindow(account);
		if (!governing || !isPercent(governing.leftPercent)) continue;
		if (best === undefined || governing.leftPercent > best) {
			best = governing.leftPercent;
		}
	}
	return best;
}

/** Re-exported so callers rendering a bare total need only this module. */
export { toQuotaDisplayPercent };
