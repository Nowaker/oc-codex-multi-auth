/**
 * Codex credits as a last-resort reserve (`creditsReserve`).
 *
 * Once a Plus/Pro account's plan windows are spent, the Codex backend keeps
 * serving it by drawing on the account's purchased credits; the client sends
 * no opt-in (codex-rs has none) and the backend decides. Measured 2026-09-30:
 * a Pro account at 100% of its weekly window with a credit balance answered
 * `/wham/usage` with `rate_limit.allowed: true` and served 200.
 *
 * The plugin's `quotaExhaustedUntil` block exists to protect those credits,
 * so with the reserve on it still decides the ORDER: an account with plan
 * quota always serves first, and an account held back by nothing but its
 * spent subscription window is offered only when every account in the pool
 * has spent its window too. One that is only throttled or cooling down is
 * waited for, never paid around. Whether that account actually has credits
 * is the backend's answer; a refusal is remembered here, in memory, until the
 * window it names resets, so an account without credits costs one refused
 * request per process. An account with automatic credit top-up can be
 * charged by that request, which is why the reserve is off by default.
 */
import type { AccountSelectionExplainability } from "./state.js";

type ExplainedAccount = Pick<AccountSelectionExplainability, "index" | "eligible" | "reasons">;

/**
 * Whether an account can still serve on its plan quota at some point without
 * spending credits. Only a spent subscription window (`quota-exhausted`) says
 * it cannot; a throttle, a token bucket, or a network cooldown only delays it,
 * so credits wait for it. A disabled account and one whose login failed serve
 * nothing at all, so they hold no plan quota the reserve could wait for.
 */
function hasPlanQuota(entry: ExplainedAccount): boolean {
	if (entry.eligible) return true;
	return !entry.reasons.some(
		(reason) => reason === "quota-exhausted" || reason === "disabled" || reason === "cooldown:auth-failure",
	);
}

/**
 * The account to serve on credits, or undefined while any account in the pool
 * still has plan quota - including one already tried this request, and one
 * merely throttled or cooling down - or when none is blocked by its spent
 * subscription window alone.
 */
export function pickCreditsReserveIndex(
	explainability: readonly ExplainedAccount[],
	options: {
		attempted: ReadonlySet<number>;
		inPool: (index: number) => boolean;
		refused: (index: number) => boolean;
	},
): number | undefined {
	const pool = explainability.filter((entry) => options.inPool(entry.index));
	if (pool.some(hasPlanQuota)) return undefined;
	return pool.find(
		(entry) =>
			!options.attempted.has(entry.index) &&
			entry.reasons.length === 1 &&
			entry.reasons[0] === "quota-exhausted" &&
			!options.refused(entry.index),
	)?.index;
}

/** Accounts whose credits turn the backend refused, per quota key, until the stated reset. */
export class CreditsRefusals {
	private readonly until = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	mark(accountKey: string, quotaKey: string, until: number): void {
		this.until.set(`${accountKey}\u0000${quotaKey}`, until);
	}

	isRefused(accountKey: string, quotaKey: string): boolean {
		const key = `${accountKey}\u0000${quotaKey}`;
		const until = this.until.get(key);
		if (until === undefined) return false;
		if (until <= this.now()) {
			this.until.delete(key);
			return false;
		}
		return true;
	}
}
