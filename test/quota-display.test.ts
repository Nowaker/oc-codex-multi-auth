import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getQuotaDisplay } from "../lib/config.js";
import {
	formatUsageLimitSummary,
	parseCodexUsagePayload,
	type UsagePayload,
} from "../lib/codex-usage.js";
import {
	formatNamedQuotaPercent,
	formatQuotaPercent,
	toQuotaDisplayPercent,
} from "../lib/quota-display.js";
import { formatQuotaNotification } from "../lib/quota-notifications.js";
import { PluginConfigSchema } from "../lib/schemas.js";
import {
	formatPromptStatusText,
	formatQuotaDetailsText,
	resolveQuotaPromptTone,
	type CompactQuotaStatus,
} from "../lib/tui-status.js";

const ENV_KEY = "CODEX_AUTH_QUOTA_DISPLAY";
const FIVE_HOUR_SECONDS = 300 * 60;
const WEEKLY_SECONDS = 10080 * 60;

function readyQuota(
	limits: CompactQuotaStatus extends { limits: infer L } ? L : never,
): CompactQuotaStatus {
	return { type: "ready", limits, stale: false };
}

function usagePayload(
	primaryUsedPercent: number | undefined,
	secondaryUsedPercent: number | undefined,
): UsagePayload {
	return {
		rate_limit: {
			primary_window: {
				used_percent: primaryUsedPercent,
				limit_window_seconds: FIVE_HOUR_SECONDS,
			},
			secondary_window: {
				used_percent: secondaryUsedPercent,
				limit_window_seconds: WEEKLY_SECONDS,
			},
		},
	};
}

describe("quota display percentages", () => {
	it("inverts the percentage only in used mode", () => {
		expect(toQuotaDisplayPercent(88, "free")).toBe(88);
		expect(toQuotaDisplayPercent(88, "used")).toBe(12);
		expect(formatQuotaPercent(88, "free")).toBe("88%");
		expect(formatQuotaPercent(88, "used")).toBe("12%");
		expect(formatNamedQuotaPercent(88, "free")).toBe("88% left");
		expect(formatNamedQuotaPercent(88, "used")).toBe("12% used");
	});

	it("renders an untouched window as fully free and zero used", () => {
		expect(formatQuotaPercent(100, "free")).toBe("100%");
		expect(formatQuotaPercent(100, "used")).toBe("0%");
		expect(formatNamedQuotaPercent(100, "free")).toBe("100% left");
		expect(formatNamedQuotaPercent(100, "used")).toBe("0% used");
	});

	it("renders a spent window as zero free and fully used", () => {
		expect(formatQuotaPercent(0, "free")).toBe("0%");
		expect(formatQuotaPercent(0, "used")).toBe("100%");
		expect(formatNamedQuotaPercent(0, "free")).toBe("0% left");
		expect(formatNamedQuotaPercent(0, "used")).toBe("100% used");
	});

	it("keeps both readings of one window adding up to 100", () => {
		for (const leftPercent of [0, 1, 12, 33, 50, 87, 99, 100]) {
			expect(
				toQuotaDisplayPercent(leftPercent, "free") +
					toQuotaDisplayPercent(leftPercent, "used"),
			).toBe(100);
		}
	});
});

describe("quotaDisplay setting", () => {
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		if (previous === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = previous;
	});

	it("defaults to free, matching how Codex reports a quota", () => {
		expect(getQuotaDisplay({})).toBe("free");
	});

	it("honours the configured mode", () => {
		expect(getQuotaDisplay({ quotaDisplay: "used" })).toBe("used");
		expect(getQuotaDisplay({ quotaDisplay: "free" })).toBe("free");
	});

	it("lets the environment override the configured mode in both directions", () => {
		process.env[ENV_KEY] = "used";
		expect(getQuotaDisplay({ quotaDisplay: "free" })).toBe("used");
		process.env[ENV_KEY] = "free";
		expect(getQuotaDisplay({ quotaDisplay: "used" })).toBe("free");
	});

	it("falls back to the configured mode when the environment value is unknown", () => {
		process.env[ENV_KEY] = "percent";
		expect(getQuotaDisplay({ quotaDisplay: "used" })).toBe("used");
	});

	it("accepts only the two modes in the plugin config schema", () => {
		expect(PluginConfigSchema.safeParse({ quotaDisplay: "free" }).success).toBe(
			true,
		);
		expect(PluginConfigSchema.safeParse({ quotaDisplay: "used" }).success).toBe(
			true,
		);
		expect(
			PluginConfigSchema.safeParse({ quotaDisplay: "remaining" }).success,
		).toBe(false);
	});
});

describe("usage limit summaries follow the display mode", () => {
	it("names which percentage it is reporting", () => {
		const window = { usedPercent: 12, windowMinutes: 300 };
		expect(formatUsageLimitSummary(window, "free")).toBe("88% left");
		expect(formatUsageLimitSummary(window, "used")).toBe("12% used");
	});

	it("defaults to free when no mode is supplied", () => {
		expect(formatUsageLimitSummary({ usedPercent: 12 })).toBe("88% left");
	});

	it("reports an untouched and a spent window at both boundaries", () => {
		expect(formatUsageLimitSummary({ usedPercent: 0 }, "free")).toBe("100% left");
		expect(formatUsageLimitSummary({ usedPercent: 0 }, "used")).toBe("0% used");
		expect(formatUsageLimitSummary({ usedPercent: 100 }, "free")).toBe("0% left");
		expect(formatUsageLimitSummary({ usedPercent: 100 }, "used")).toBe(
			"100% used",
		);
	});

	it("reports an unreadable percentage as unavailable in either mode", () => {
		expect(formatUsageLimitSummary({ windowMinutes: 300 }, "free")).toBe(
			"unavailable",
		);
		expect(formatUsageLimitSummary({ windowMinutes: 300 }, "used")).toBe(
			"unavailable",
		);
	});

	it("words every rendered limit in the parsed payload", () => {
		const free = parseCodexUsagePayload(usagePayload(12, 0), "free");
		const used = parseCodexUsagePayload(usagePayload(12, 0), "used");
		expect(free.limits.map((limit) => limit.summary)).toEqual([
			"88% left",
			"100% left",
		]);
		expect(used.limits.map((limit) => limit.summary)).toEqual([
			"12% used",
			"0% used",
		]);
	});

	it("leaves the machine-readable percentages identical in both modes", () => {
		const free = parseCodexUsagePayload(usagePayload(12, 100), "free");
		const used = parseCodexUsagePayload(usagePayload(12, 100), "used");
		const numbers = (summary: typeof free) =>
			summary.limits.map((limit) => ({
				name: limit.name,
				usedPercent: limit.usedPercent,
				leftPercent: limit.leftPercent,
				windowMinutes: limit.windowMinutes,
			}));
		expect(numbers(used)).toEqual(numbers(free));
		expect(numbers(free)).toEqual([
			{
				name: "5h limit",
				usedPercent: 12,
				leftPercent: 88,
				windowMinutes: 300,
			},
			{
				name: "Weekly limit",
				usedPercent: 100,
				leftPercent: 0,
				windowMinutes: 10080,
			},
		]);
	});
});

describe("TUI quota surfaces follow the display mode", () => {
	const sep = ` ${String.fromCharCode(183)} `;
	const quota = readyQuota([
		{ label: "5h", leftPercent: 88 },
		{ label: "7d", leftPercent: 83 },
	]);

	it("prints the bare percentage the configured mode asks for", () => {
		expect(formatPromptStatusText({ quota, width: 120 })).toBe(
			`5h 88%${sep}7d 83%`,
		);
		expect(
			formatPromptStatusText({ quota, width: 120, quotaDisplay: "free" }),
		).toBe(`5h 88%${sep}7d 83%`);
		expect(
			formatPromptStatusText({ quota, width: 120, quotaDisplay: "used" }),
		).toBe(`5h 12%${sep}7d 17%`);
	});

	it("prints both status-line boundaries", () => {
		const boundary = readyQuota([
			{ label: "5h", leftPercent: 100 },
			{ label: "7d", leftPercent: 0 },
		]);
		expect(
			formatPromptStatusText({ quota: boundary, width: 120, quotaDisplay: "free" }),
		).toBe(`5h 100%${sep}7d 0%`);
		expect(
			formatPromptStatusText({ quota: boundary, width: 120, quotaDisplay: "used" }),
		).toBe(`5h 0%${sep}7d 100%`);
	});

	it("omits a window with no readable percentage in either mode", () => {
		const unknown = readyQuota([{ label: "5h", leftPercent: null }]);
		expect(
			formatPromptStatusText({ quota: unknown, width: 120, quotaDisplay: "free" }),
		).toBe("");
		expect(
			formatPromptStatusText({ quota: unknown, width: 120, quotaDisplay: "used" }),
		).toBe("");
	});

	it("names the percentage in the details dialog", () => {
		expect(
			formatQuotaDetailsText(quota, Date.now(), { quotaDisplay: "free" }),
		).toContain("5h: 88% left");
		expect(
			formatQuotaDetailsText(quota, Date.now(), { quotaDisplay: "used" }),
		).toContain("5h: 12% used");
	});

	it("names both details boundaries and an unreadable window", () => {
		const edges = readyQuota([
			{ label: "5h", leftPercent: 100 },
			{ label: "7d", leftPercent: 0 },
			{ label: "code review", leftPercent: null },
		]);
		const free = formatQuotaDetailsText(edges, Date.now(), {
			quotaDisplay: "free",
		});
		const used = formatQuotaDetailsText(edges, Date.now(), {
			quotaDisplay: "used",
		});
		expect(free).toContain("5h: 100% left");
		expect(free).toContain("7d: 0% left");
		expect(used).toContain("5h: 0% used");
		expect(used).toContain("7d: 100% used");
		for (const text of [free, used]) {
			expect(text).toContain("code review: unavailable");
		}
	});

	it("keeps the exhaustion tone keyed on headroom, not on the printed number", () => {
		const nearlySpent = readyQuota([{ label: "5h", leftPercent: 5 }]);
		const nearlyFull = readyQuota([{ label: "5h", leftPercent: 95 }]);
		expect(
			formatPromptStatusText({
				quota: nearlySpent,
				width: 120,
				quotaDisplay: "used",
			}),
		).toBe("5h 95%");
		expect(resolveQuotaPromptTone(nearlySpent)).toBe("danger");
		expect(
			formatPromptStatusText({
				quota: nearlyFull,
				width: 120,
				quotaDisplay: "used",
			}),
		).toBe("5h 5%");
		expect(resolveQuotaPromptTone(nearlyFull)).toBe("normal");
	});
});

describe("quota notifications follow the display mode", () => {
	it("reports the configured percentage for each window", () => {
		const usage = {
			fiveHour: { remainingPercent: 10 },
			weekly: { remainingPercent: 72 },
		};
		expect(formatQuotaNotification(usage, "free").split("\n")).toEqual([
			"5h: 10% | resets unavailable",
			"Weekly: 72% | resets unavailable",
		]);
		expect(formatQuotaNotification(usage, "used").split("\n")).toEqual([
			"5h: 90% | resets unavailable",
			"Weekly: 28% | resets unavailable",
		]);
	});

	it("leaves a window with no readable percentage unavailable in either mode", () => {
		const usage = { fiveHour: {}, weekly: { remainingPercent: 0 } };
		expect(formatQuotaNotification(usage, "free").split("\n")).toEqual([
			"5h: unavailable",
			"Weekly: 0% | resets unavailable",
		]);
		expect(formatQuotaNotification(usage, "used").split("\n")).toEqual([
			"5h: unavailable",
			"Weekly: 100% | resets unavailable",
		]);
	});
});
