import { describe, expect, it } from "vitest";
import { formatQuotaOverviewCandidates, formatQuotaOverviewText, type QuotaOverviewOptions } from "../lib/quota-overview.js";
import { resolveQuotaRecoveryEvents } from "../lib/quota-recovery.js";
import { formatQuotaOverviewStatusLines } from "../lib/tui-status.js";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const day = 24 * hour;
const options = {
	mode: "used", layout: "total", names: "number", order: "number",
	multipliers: false, allotment: false, resetTimes: "never",
	resetCredits: false, recovery: "all", now,
} satisfies QuotaOverviewOptions;
const accounts = [{ index: 1, windows: [24, 31, 55, 57, 63, 69, 75, 94].map((leftPercent, index) => ({
	leftPercent,
	resetAtMs: now + (index < 3 ? 5 * day + index * hour : 6 * day + (index - 3) * hour),
})) }];

describe("displayed recovery buckets", () => {
	it("sums distinct timestamps sharing a displayed day without merging adjacent days", () => {
		// Given / When
		const candidates = formatQuotaOverviewCandidates(accounts, options);
		// Then
		expect(candidates).toEqual([
			"76% +33% in 5d, +43% in 6d",
			"76% +33% 5d, +43% 6d",
			"76% +33% 5d",
			"76%",
		]);
	});

	it("retains exact-time marginal simulation underneath display grouping", () => {
		// Given / When
		const events = resolveQuotaRecoveryEvents(accounts, now);
		// Then
		expect(events.map((event) => event.deltaPercent)).toEqual([7, 24, 2, 6, 6, 6, 19, 6]);
		expect(new Set(events.map((event) => event.atMs)).size).toBe(8);
	});

	it("truncates only after summing the complete displayed bucket", () => {
		// Given / When
		const lines = formatQuotaOverviewStatusLines({ accounts, options, availableChars: 12, maxRows: 1 });
		// Then
		expect(lines).toEqual(["76% +33% 5d"]);
	});

	it("sums weighted marginal gains rather than unweighted account percentages", () => {
		// Given
		const weighted = [
			{ index: 1, planType: "pro", windows: [
				{ leftPercent: 0, resetAtMs: now + 5 * day },
				{ leftPercent: 50, resetAtMs: now + 5 * day + hour },
			] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: now + 6 * day }] },
		];
		// When
		const text = formatQuotaOverviewText(weighted, options);
		// Then
		expect(text).toBe("100% +95% in 5d, +5% in 6d");
	});

	it("groups floored hours without mixing different hours or unit labels", () => {
		// Given
		const hourly = [{ index: 1, windows: [
			{ leftPercent: 0, resetAtMs: now + hour + 5 * 60_000 },
			{ leftPercent: 20, resetAtMs: now + hour + 40 * 60_000 },
			{ leftPercent: 40, resetAtMs: now + 2 * hour + 60_000 },
			{ leftPercent: 60, resetAtMs: now + day },
		] }];
		// When
		const text = formatQuotaOverviewText(hourly, options);
		// Then
		expect(text).toBe("100% +40% in 1h, +20% in 2h, +40% in 1d");
	});
});
