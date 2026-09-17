import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getQuotaStatus } from "../lib/config.js";
import { PluginConfigSchema } from "../lib/schemas.js";
import {
	computeWeightedLeftPercent,
	formatCompactDuration,
	formatQuotaOverviewCandidates,
	formatQuotaOverviewText,
	resolveGoverningWindow,
	resolveQuotaOverviewRecovery,
	resolveQuotaOverviewTonePercent,
	type QuotaOverviewAccount,
	type QuotaOverviewOptions,
} from "../lib/quota-overview.js";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const allOff: Omit<QuotaOverviewOptions, "mode"> = {
	accounts: false,
	multipliers: false,
	resetTimes: false,
	resetCredits: false,
	recovery: false,
	now: NOW,
};

function options(overrides: Partial<QuotaOverviewOptions> = {}): QuotaOverviewOptions {
	return { mode: "free", ...allOff, ...overrides };
}

/** The pool from the issue: a 5x seat, a spent 20x seat, and a 1x seat. */
const pool: QuotaOverviewAccount[] = [
	{
		index: 1,
		planType: "self_serve_business_prolite",
		windows: [{ leftPercent: 87, resetAtMs: NOW + 2 * DAY }],
	},
	{
		index: 2,
		planType: "pro",
		resetCredits: 1,
		windows: [
			{ leftPercent: 100, resetAtMs: NOW + 4 * HOUR },
			{ leftPercent: 0, resetAtMs: NOW + 3 * DAY },
		],
	},
	{
		index: 3,
		planType: "plus",
		windows: [{ leftPercent: 88, resetAtMs: NOW + 5 * DAY }],
	},
];

describe("formatCompactDuration", () => {
	it("floors to the largest unit that fits", () => {
		expect(formatCompactDuration(3 * DAY)).toBe("3d");
		expect(formatCompactDuration(2 * DAY + 20 * HOUR)).toBe("2d");
		expect(formatCompactDuration(5 * HOUR)).toBe("5h");
		expect(formatCompactDuration(90 * 60 * 1000)).toBe("1h");
		expect(formatCompactDuration(15 * 60 * 1000)).toBe("15m");
	});

	it("never counts a future reset as zero away", () => {
		expect(formatCompactDuration(1)).toBe("1m");
	});

	it("drops a reset already in the past", () => {
		expect(formatCompactDuration(0)).toBeUndefined();
		expect(formatCompactDuration(-DAY)).toBeUndefined();
		expect(formatCompactDuration(Number.NaN)).toBeUndefined();
	});
});

describe("resolveGoverningWindow", () => {
	it("picks the window with the least headroom", () => {
		expect(resolveGoverningWindow(pool[1]!)?.leftPercent).toBe(0);
	});

	it("breaks a tie on the window that blocks for longer", () => {
		const account: QuotaOverviewAccount = {
			index: 1,
			windows: [
				{ leftPercent: 0, resetAtMs: NOW + 4 * HOUR },
				{ leftPercent: 0, resetAtMs: NOW + 3 * DAY },
			],
		};
		expect(resolveGoverningWindow(account)?.resetAtMs).toBe(NOW + 3 * DAY);
	});

	it("ignores windows with no readable percentage", () => {
		const account: QuotaOverviewAccount = {
			index: 1,
			windows: [{ resetAtMs: NOW + HOUR }, { leftPercent: 40 }],
		};
		expect(resolveGoverningWindow(account)?.leftPercent).toBe(40);
	});

	it("returns nothing when no window is readable", () => {
		expect(resolveGoverningWindow({ index: 1, windows: [] })).toBeUndefined();
	});
});

describe("computeWeightedLeftPercent", () => {
	it("weighs each account by its plan allotment", () => {
		// (5*87 + 20*0 + 1*88) / 26 = 20.1
		expect(computeWeightedLeftPercent(pool)).toBe(20);
	});

	it("differs from the unweighted mean, which is the point", () => {
		const unweighted = Math.round((87 + 0 + 88) / 3);
		expect(unweighted).toBe(58);
		expect(computeWeightedLeftPercent(pool)).not.toBe(unweighted);
	});

	it("weighs a plan that states no ratio as one baseline seat", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "enterprise", windows: [{ leftPercent: 50 }] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 100 }] },
		];
		expect(computeWeightedLeftPercent(accounts)).toBe(75);
	});

	it("leaves an unreadable account out rather than counting it as full", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 40 }] },
			{ index: 2, planType: "plus", windows: [] },
		];
		expect(computeWeightedLeftPercent(accounts)).toBe(40);
	});

	it("reports nothing when the whole pool is unreadable", () => {
		expect(computeWeightedLeftPercent([{ index: 1, windows: [] }])).toBeUndefined();
	});
});

describe("resolveQuotaOverviewRecovery", () => {
	it("ignores a refill that leaves the account's governing window spent", () => {
		// Account 2's 5h window is already full, so the earliest reset that
		// changes anything is its weekly one three days out.
		const recovery = resolveQuotaOverviewRecovery(pool, NOW);
		expect(recovery?.atMs).toBe(NOW + 2 * DAY);
	});

	it("measures how far the pool total moves", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: NOW + DAY }] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 50 }] },
		];
		// 25% now, 75% once account 1 refills.
		expect(resolveQuotaOverviewRecovery(accounts, NOW)).toEqual({
			deltaPercent: 50,
			atMs: NOW + DAY,
		});
	});

	it("reports nothing when no window has a future reset", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: NOW - DAY }] },
		];
		expect(resolveQuotaOverviewRecovery(accounts, NOW)).toBeUndefined();
	});

	it("reports nothing when every account is already full", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 100, resetAtMs: NOW + DAY }] },
		];
		expect(resolveQuotaOverviewRecovery(accounts, NOW)).toBeUndefined();
	});
});

describe("formatQuotaOverviewText", () => {
	it("renders the fullest form as headroom left", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({
					accounts: true,
					multipliers: true,
					resetTimes: true,
					resetCredits: true,
				}),
			),
		).toBe("20%: #1 5x 87%, #2 20x 0% 3d 1r, #3 1x 88%");
	});

	it("inverts every percentage under `used`", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({
					mode: "used",
					accounts: true,
					multipliers: true,
					resetTimes: true,
					resetCredits: true,
				}),
			),
		).toBe("80%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%");
	});

	it("drops the badges without dropping the accounts", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ mode: "used", accounts: true, resetTimes: true }),
			),
		).toBe("80%: #1 13%, #2 100% 3d, #3 12%");
	});

	it("keeps reset counts with the badges switched off", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({
					mode: "used",
					accounts: true,
					resetTimes: true,
					resetCredits: true,
				}),
			),
		).toBe("80%: #1 13%, #2 100% 3d 1r, #3 12%");
	});

	it("collapses to a count when the breakdown is switched off", () => {
		expect(formatQuotaOverviewText(pool, options({ mode: "used" }))).toBe(
			"80%: 3 accounts",
		);
	});

	it("adds the recovery clause with the sign the reading moves in", () => {
		// Account 1 refills first, from 87% to full: a 5x seat moving 13 points
		// lifts a pool weighted 5:20:1 by three.
		expect(
			formatQuotaOverviewText(pool, options({ recovery: true })),
		).toBe("20%: 3 accounts, +3% in 2d");
		expect(
			formatQuotaOverviewText(pool, options({ mode: "used", recovery: true })),
		).toBe("80%: 3 accounts, -3% in 2d");
	});

	it("prints a reset only for an account near exhaustion", () => {
		const line = formatQuotaOverviewText(
			pool,
			options({ accounts: true, resetTimes: true }),
		);
		expect(line).toBe("20%: #1 87%, #2 0% 3d, #3 88%");
	});

	it("omits a zero reset-credit count", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", resetCredits: 0, windows: [{ leftPercent: 40 }] },
		];
		expect(
			formatQuotaOverviewText(accounts, options({ accounts: true, resetCredits: true })),
		).toBe("40%: #1 40%");
	});

	it("says `1 account` rather than `1 accounts`", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 40 }] },
		];
		expect(formatQuotaOverviewText(accounts, options())).toBe("40%: 1 account");
	});

	it("renders nothing when the pool cannot be read", () => {
		expect(formatQuotaOverviewText([], options({ accounts: true }))).toBe("");
	});
});

describe("formatQuotaOverviewCandidates", () => {
	it("degrades detail before it degrades the pool total", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({
				accounts: true,
				multipliers: true,
				resetTimes: true,
				resetCredits: true,
				recovery: true,
			}),
		);
		expect(candidates[0]).toContain("5x");
		expect(candidates[0]).toContain(" in ");
		expect(candidates.at(-1)).toBe("20%");
		for (const candidate of candidates) expect(candidate.startsWith("20%")).toBe(true);
		expect(new Set(candidates).size).toBe(candidates.length);
		const firstWithoutBreakdown = candidates.findIndex((candidate) =>
			candidate.includes("accounts"),
		);
		const lastWithBreakdown = candidates.findLastIndex((candidate) =>
			candidate.includes("#1"),
		);
		expect(lastWithBreakdown).toBeLessThan(firstWithoutBreakdown);
	});

	it("never reintroduces a switch that is off", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({ accounts: true, resetTimes: true }),
		);
		for (const candidate of candidates) {
			expect(candidate).not.toContain("5x");
			expect(candidate).not.toContain("1r");
			expect(candidate).not.toContain(" in ");
		}
	});
});

describe("resolveQuotaOverviewTonePercent", () => {
	it("reports the healthiest account, not the worst", () => {
		expect(resolveQuotaOverviewTonePercent(pool)).toBe(88);
	});

	it("reports nothing for an unreadable pool", () => {
		expect(resolveQuotaOverviewTonePercent([])).toBeUndefined();
	});
});

describe("getQuotaStatus", () => {
	const envKeys = [
		"CODEX_AUTH_QUOTA_STATUS",
		"CODEX_AUTH_QUOTA_STATUS_ACCOUNTS",
		"CODEX_AUTH_QUOTA_STATUS_MULTIPLIERS",
		"CODEX_AUTH_QUOTA_STATUS_RESET_TIMES",
		"CODEX_AUTH_QUOTA_STATUS_RESET_CREDITS",
		"CODEX_AUTH_QUOTA_STATUS_RECOVERY",
	] as const;
	let previous: Record<string, string | undefined> = {};

	beforeEach(() => {
		previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		for (const key of envKeys) delete process.env[key];
	});

	afterEach(() => {
		for (const key of envKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("leaves every existing install on the account it is serving from", () => {
		expect(getQuotaStatus({}).mode).toBe("active");
	});

	it("shows each account with its reset once the pool view is on", () => {
		expect(getQuotaStatus({ quotaStatus: { mode: "overview" } })).toEqual({
			mode: "overview",
			accounts: true,
			multipliers: false,
			resetTimes: true,
			resetCredits: false,
			recovery: false,
		});
	});

	it("honours every switch independently", () => {
		expect(
			getQuotaStatus({
				quotaStatus: {
					mode: "overview",
					accounts: true,
					multipliers: false,
					resetTimes: false,
					resetCredits: true,
					recovery: true,
				},
			}),
		).toEqual({
			mode: "overview",
			accounts: true,
			multipliers: false,
			resetTimes: false,
			resetCredits: true,
			recovery: true,
		});
	});

	it("lets the environment override the configured switches", () => {
		process.env.CODEX_AUTH_QUOTA_STATUS = "overview";
		process.env.CODEX_AUTH_QUOTA_STATUS_MULTIPLIERS = "1";
		process.env.CODEX_AUTH_QUOTA_STATUS_ACCOUNTS = "0";
		const resolved = getQuotaStatus({ quotaStatus: { mode: "active", multipliers: false } });
		expect(resolved.mode).toBe("overview");
		expect(resolved.multipliers).toBe(true);
		expect(resolved.accounts).toBe(false);
	});

	it("switches off for any boolean env value that is not the literal 1", () => {
		// Plugin-wide contract: a set variable always overrides the config, and
		// only "1" enables. `true` is therefore off, not ignored.
		process.env.CODEX_AUTH_QUOTA_STATUS_MULTIPLIERS = "true";
		expect(getQuotaStatus({ quotaStatus: { multipliers: true } }).multipliers).toBe(
			false,
		);
		process.env.CODEX_AUTH_QUOTA_STATUS_MULTIPLIERS = "1";
		expect(getQuotaStatus({ quotaStatus: { multipliers: false } }).multipliers).toBe(
			true,
		);
	});

	it("falls back to the configured mode when the environment value is unknown", () => {
		process.env.CODEX_AUTH_QUOTA_STATUS = "summary";
		expect(getQuotaStatus({ quotaStatus: { mode: "overview" } }).mode).toBe(
			"overview",
		);
	});

	it("accepts only the two modes in the plugin config schema", () => {
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { mode: "overview" } }).success,
		).toBe(true);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { mode: "active" } }).success,
		).toBe(true);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { mode: "aggregate" } }).success,
		).toBe(false);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { multipliers: "yes" } }).success,
		).toBe(false);
	});
});
