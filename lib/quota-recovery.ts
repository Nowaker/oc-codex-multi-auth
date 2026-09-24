import { computeWeightedLeftPercent } from "./quota-capacity.js";
import type { QuotaOverviewAccount, QuotaOverviewRecovery, QuotaOverviewWindow } from "./quota-overview.js";

function isFutureReset(window: QuotaOverviewWindow, now: number): boolean {
	return typeof window.leftPercent === "number" &&
		Number.isFinite(window.leftPercent) && window.leftPercent >= 0 && window.leftPercent < 100 &&
		typeof window.resetAtMs === "number" && Number.isFinite(window.resetAtMs) && window.resetAtMs > now;
}

/** Simulate known ordinary windows once; deltas telescope rather than repeating cumulative gains. */
export function resolveQuotaRecoveryEvents(
	accounts: readonly QuotaOverviewAccount[],
	now: number = Date.now(),
): QuotaOverviewRecovery[] {
	let previous = computeWeightedLeftPercent(accounts);
	if (previous === undefined) return [];
	const timestamps = new Set<number>();
	for (const account of accounts) {
		for (const window of account.windows) {
			if (isFutureReset(window, now) && window.resetAtMs !== undefined) timestamps.add(window.resetAtMs);
		}
	}
	let simulated = accounts;
	const events: QuotaOverviewRecovery[] = [];
	for (const atMs of [...timestamps].sort((left, right) => left - right)) {
		simulated = simulated.map((account) => ({
			...account,
			windows: account.windows.map((window) =>
				window.resetAtMs === atMs && isFutureReset(window, now)
					? { ...window, leftPercent: 100 }
					: window),
		}));
		const recovered = computeWeightedLeftPercent(simulated);
		if (recovered === undefined) continue;
		const deltaPercent = recovered - previous;
		previous = recovered;
		if (deltaPercent > 0) events.push({ atMs, deltaPercent });
	}
	return events;
}
