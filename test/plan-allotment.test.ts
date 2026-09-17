import { describe, expect, it } from "vitest";

import {
	DEFAULT_PLAN_WEIGHT,
	describePlanAllotment,
	formatPlanMultiplier,
	getPlanWeight,
	normalizePlanSlug,
} from "../lib/plan-allotment.js";

describe("normalizePlanSlug", () => {
	it("collapses the spellings the same tier arrives under", () => {
		expect(normalizePlanSlug("team")).toBe("team");
		expect(normalizePlanSlug("chatgptteamplan")).toBe("team");
		expect(normalizePlanSlug("ChatGPT_Team_Plan")).toBe("team");
		expect(normalizePlanSlug("self_serve_business_prolite")).toBe(
			"self serve business prolite",
		);
	});

	it("treats blank and non-string input as absent", () => {
		expect(normalizePlanSlug("")).toBeUndefined();
		expect(normalizePlanSlug("   ")).toBeUndefined();
		expect(normalizePlanSlug(null)).toBeUndefined();
		expect(normalizePlanSlug(undefined)).toBeUndefined();
	});
});

describe("describePlanAllotment", () => {
	it("places the plans this pool actually holds", () => {
		expect(describePlanAllotment("pro")).toEqual({
			weight: 20,
			multiplier: "20x",
			monthlyUsd: 200,
		});
		expect(describePlanAllotment("self_serve_business_prolite")).toEqual({
			weight: 5,
			multiplier: "5x",
			monthlyUsd: 125,
		});
		expect(describePlanAllotment("team")).toEqual({
			weight: 1,
			multiplier: "1x",
			monthlyUsd: 25,
		});
		expect(describePlanAllotment("plus")).toEqual({
			weight: 1,
			multiplier: "1x",
			monthlyUsd: 20,
		});
	});

	it("keeps the $100 Pro apart from the $200 one", () => {
		expect(describePlanAllotment("pro 5x").multiplier).toBe("5x");
		expect(describePlanAllotment("pro_legacy").multiplier).toBe("5x");
		expect(describePlanAllotment("pro 20x").multiplier).toBe("20x");
	});

	it("reads the premium Business seat as a seat, not as personal Pro Lite", () => {
		// Both normalize to text containing `prolite`; only the one naming a
		// business workspace is the $125 seat.
		expect(describePlanAllotment("self_serve_business_prolite").monthlyUsd).toBe(125);
		expect(describePlanAllotment("prolite").monthlyUsd).toBe(100);
	});

	it("states no ratio for a bare business workspace", () => {
		expect(describePlanAllotment("business")).toEqual({});
	});

	it("separates Business Standard from Business Premium", () => {
		expect(describePlanAllotment("business_standard")).toEqual({
			weight: 1,
			multiplier: "1x",
			monthlyUsd: 25,
		});
	});

	it("states no ratio for plans that carry no Codex allotment", () => {
		expect(describePlanAllotment("free")).toEqual({});
		expect(describePlanAllotment("go")).toEqual({});
		expect(describePlanAllotment("enterprise")).toEqual({});
		expect(describePlanAllotment("something-new")).toEqual({});
		expect(describePlanAllotment(null)).toEqual({});
	});
});

describe("getPlanWeight", () => {
	it("falls back to the baseline seat rather than removing the account", () => {
		expect(getPlanWeight("enterprise")).toBe(DEFAULT_PLAN_WEIGHT);
		expect(getPlanWeight(undefined)).toBe(DEFAULT_PLAN_WEIGHT);
		expect(getPlanWeight("pro")).toBe(20);
	});
});

describe("formatPlanMultiplier", () => {
	it("renders the badge only for a plan that states a ratio", () => {
		expect(formatPlanMultiplier("pro")).toBe("20x");
		expect(formatPlanMultiplier("self_serve_business_prolite")).toBe("5x");
		expect(formatPlanMultiplier("enterprise")).toBeUndefined();
	});
});
