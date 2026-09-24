import { describe, expect, it } from "vitest";
import {
	formatQuotaOverviewCandidates,
	formatQuotaOverviewText,
	formatQuotaResetsCandidates,
	type QuotaOverviewAccount,
	type QuotaOverviewOptions,
} from "../lib/quota-overview.js";
import { resolveQuotaRecoveryEvents } from "../lib/quota-recovery.js";
import { formatQuotaResetsStatusLines } from "../lib/tui-status.js";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const options = {
	mode: "used", layout: "total", names: "number", order: "number",
	multipliers: false, allotment: false, resetTimes: "never",
	resetCredits: false, recovery: "all", now,
} satisfies QuotaOverviewOptions;

describe("capacity recovery forecast", () => {
	it("preserves legacy silence when the earliest reset remains blocked", () => {
		const accounts = [{ index: 1, windows: [
			{ leftPercent: 0, resetAtMs: now + hour },
			{ leftPercent: 0, resetAtMs: now + 3 * hour },
		] }];
		expect(formatQuotaOverviewText(accounts, { ...options, recovery: true })).toBe("100%");
		expect(formatQuotaOverviewText(accounts, options)).toBe("100% +100% in 3h");
	});

	it("recovers only to the next governing limit before that window also resets", () => {
		// Given
		const accounts = [{ index: 1, windows: [
			{ leftPercent: 20, resetAtMs: now + hour },
			{ leftPercent: 50, resetAtMs: now + 3 * hour },
		] }];
		// When
		const events = resolveQuotaRecoveryEvents(accounts, now);
		// Then
		expect(events).toEqual([
			{ deltaPercent: 30, atMs: now + hour },
			{ deltaPercent: 50, atMs: now + 3 * hour },
		]);
	});

	it("does not exceed used capacity when many individually rounded gains accumulate", () => {
		// Given
		const accounts = Array.from({ length: 37 }, (_, index) => ({ index,
			windows: [{ leftPercent: 63, resetAtMs: now + (index + 1) * hour }],
		}));
		// When
		const events = resolveQuotaRecoveryEvents(accounts, now);
		// Then
		expect(events.reduce((sum, event) => sum + event.deltaPercent, 0)).toBe(37);
	});

	it("returns incremental weighted capacity after earlier blocking windows reset", () => {
		// Given: the first reset is blocked; a 20x seat then recovers twice.
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "pro", windows: [
				{ leftPercent: 0, resetAtMs: now + hour },
				{ leftPercent: 0, resetAtMs: now + 3 * hour },
			] },
			{ index: 2, planType: "plus", windows: [
				{ leftPercent: 0, resetAtMs: now + 2 * hour },
			] },
		];
		// When
		const text = formatQuotaOverviewText(accounts, options);
		// Then: 5 + 95 = 100 points, not cumulative 5 + 100.
		expect(text).toBe("100% +5% in 2h, +95% in 3h");
	});

	it("batches simultaneous resets and never refills invalid or past events", () => {
		// Given
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, windows: [{ leftPercent: 50, resetAtMs: now + hour }] },
			{ index: 2, windows: [{ leftPercent: 50, resetAtMs: now + hour }] },
			{ index: 3, windows: [{ leftPercent: 0, resetAtMs: now - hour }] },
			{ index: 4, windows: [{ leftPercent: 0, resetAtMs: NaN }] },
			{ index: 5, windows: [{ resetAtMs: now + hour }] },
		];
		// When
		const text = formatQuotaOverviewText(accounts, options);
		// Then
		expect(text).toBe("75% +25% in 1h");
	});

	it("keeps only chronological prefixes on narrow total-only candidates", () => {
		// Given
		const accounts = [1, 2, 3].map((index) => ({ index,
			windows: [{ leftPercent: 0, resetAtMs: now + index * hour }],
		}));
		// When
		const candidates = formatQuotaOverviewCandidates(accounts, options);
		// Then
		expect(candidates).toEqual([
			"100% +33% in 1h, +34% in 2h, +33% in 3h",
			"100% +33% 1h, +34% 2h, +33% 3h",
			"100% +33% 1h, +34% 2h",
			"100% +33% 1h",
			"100%",
		]);
	});

	it("retains recovery beside other overview layouts", () => {
		// Given
		const accounts = [{ index: 1, windows: [{ leftPercent: 75, resetAtMs: now + hour }] }];
		// When
		const text = formatQuotaOverviewText(accounts, { ...options, layout: "count" });
		// Then
		expect(text).toBe("25%: 1 account, +25% in 1h");
	});

	it("renders no invented forecast when all quotas are unreadable", () => {
		// Given
		const accounts = [{ index: 1, windows: [{ resetAtMs: now + hour }] }];
		// When
		const candidates = formatQuotaOverviewCandidates(accounts, options);
		// Then
		expect(candidates).toEqual([]);
	});
});

describe("weighted reset threshold", () => {
	const accounts: QuotaOverviewAccount[] = [
		{ index: 1, planType: "pro", resetCredits: 1,
			windows: [{ leftPercent: 0, resetAtMs: now + 3 * hour }] },
		{ index: 2, planType: "plus", resetCredits: 2,
			windows: [{ leftPercent: 100, resetAtMs: now + 5 * hour }] },
	];

	it("shows applicable credits at the weighted threshold without requiring every seat spent", () => {
		// Given / When
		const candidates = formatQuotaResetsCandidates(accounts, { minUsedPercent: 90, names: "number", now });
		// Then: the healthy banked-credit account is not actionable.
		expect(candidates[0]).toBe("Free resets: 3h 1r #1");
	});

	it("preserves the default full exhaustion gate", () => {
		// Given / When
		const candidates = formatQuotaResetsCandidates(accounts, { now });
		// Then
		expect(candidates).toEqual([]);
	});

	it("forwards the threshold through the actual status-line wrapper", () => {
		// Given / When
		const lines = formatQuotaResetsStatusLines({ accounts, options, resetsMinUsedPercent: 90, availableChars: 100 });
		// Then
		expect(lines).toEqual(["Free resets: 3h 1r #1"]);
	});

	it("compares exact weighted usage rather than its rounded display", () => {
		// Given
		const near = [{ index: 1, resetCredits: 1, resetCreditsApplicable: 1,
			windows: [{ leftPercent: 10.1, resetAtMs: now + hour }] }];
		// When
		const candidates = formatQuotaResetsCandidates(near, { minUsedPercent: 90, now });
		// Then
		expect(candidates).toEqual([]);
	});

	it("orders applicable seats by latest natural recovery first", () => {
		// Given
		const eligible = [1, 4, 2].map((index) => ({ index, resetCredits: 1, resetCreditsApplicable: 1,
			windows: [{ leftPercent: 10, resetAtMs: now + index * hour }] }));
		// When
		const candidates = formatQuotaResetsCandidates(eligible, { minUsedPercent: 90, names: "number", now });
		// Then
		expect(candidates[0]).toBe("Free resets: 4h 1r #4, 2h 1r #2, 1h 1r #1");
	});

	it("does not promote unknown applicability into actionable credits", () => {
		// Given
		const unknown: QuotaOverviewAccount[] = [{ ...accounts[0], index: 1,
			windows: [{ leftPercent: 0 }], resetCredits: 4, resetCreditsApplicable: null }];
		// When
		const candidates = formatQuotaResetsCandidates(unknown, { minUsedPercent: 90, now });
		// Then
		expect(candidates).toEqual([]);
	});

	it("skips the page below the configured usage threshold", () => {
		// Given / When
		const candidates = formatQuotaResetsCandidates(accounts, { minUsedPercent: 96, now });
		// Then
		expect(candidates).toEqual([]);
	});
});
