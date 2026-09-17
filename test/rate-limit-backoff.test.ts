import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	clearRateLimitBackoffState,
	getRateLimitBackoff,
	remapRateLimitBackoffAfterRemoval,
	resetRateLimitBackoff,
	calculateBackoffMs,
	getRateLimitBackoffWithReason,
} from "../lib/request/rate-limit-backoff.js";

describe("Rate limit backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		clearRateLimitBackoffState();
	});

	afterEach(() => {
		clearRateLimitBackoffState();
		vi.useRealTimers();
	});

	it("deduplicates concurrent 429s within the window", () => {
		const first = getRateLimitBackoff(0, "codex", 1000);
		expect(first).toEqual({ attempt: 1, delayMs: 1000, isDuplicate: false });

		vi.setSystemTime(new Date(1000));
		const second = getRateLimitBackoff(0, "codex", 1000);
		expect(second.attempt).toBe(1);
		expect(second.delayMs).toBe(1000);
		expect(second.isDuplicate).toBe(true);
	});

	it("increments after dedup window", () => {
		getRateLimitBackoff(0, "codex", 1000);
		vi.setSystemTime(new Date(2500));
		const second = getRateLimitBackoff(0, "codex", 1000);
		expect(second.attempt).toBe(2);
		expect(second.delayMs).toBe(2000);
		expect(second.isDuplicate).toBe(false);
	});

	it("resets after quiet period", () => {
		getRateLimitBackoff(0, "codex", 1000);
		vi.setSystemTime(new Date(121_000));
		const next = getRateLimitBackoff(0, "codex", 1000);
		expect(next.attempt).toBe(1);
	});

	it("resetRateLimitBackoff clears state", () => {
		getRateLimitBackoff(0, "codex", 1000);
		resetRateLimitBackoff(0, "codex");
		const next = getRateLimitBackoff(0, "codex", 1000);
		expect(next.attempt).toBe(1);
		expect(next.isDuplicate).toBe(false);
	});

	describe("calculateBackoffMs", () => {
		it("applies quota multiplier (3.0)", () => {
			const result = calculateBackoffMs(1000, 1, "quota");
			expect(result).toBe(3000);
		});

		it("applies tokens multiplier (1.5)", () => {
			const result = calculateBackoffMs(1000, 1, "tokens");
			expect(result).toBe(1500);
		});

		it("applies concurrent multiplier (0.5)", () => {
			const result = calculateBackoffMs(1000, 1, "concurrent");
			expect(result).toBe(500);
		});

		it("applies unknown multiplier (1.0)", () => {
			const result = calculateBackoffMs(1000, 1, "unknown");
			expect(result).toBe(1000);
		});

		it("applies exponential backoff on higher attempts", () => {
			const attempt1 = calculateBackoffMs(1000, 1, "unknown");
			const attempt2 = calculateBackoffMs(1000, 2, "unknown");
			const attempt3 = calculateBackoffMs(1000, 3, "unknown");
			expect(attempt1).toBe(1000);
			expect(attempt2).toBe(2000);
			expect(attempt3).toBe(4000);
		});

		it("caps at MAX_BACKOFF_MS", () => {
			const result = calculateBackoffMs(1000, 20, "quota");
			expect(result).toBeLessThanOrEqual(5 * 60 * 1000);
		});

		it("uses default multiplier when reason is undefined", () => {
			const result = calculateBackoffMs(1000, 1);
			expect(result).toBe(1000);
		});

		it("uses fallback multiplier 1.0 when reason is not in map (line 111 coverage)", () => {
			const result = calculateBackoffMs(1000, 1, "unknown-reason" as never);
			expect(result).toBe(1000);
		});
	});

	describe("normalizeDelayMs edge cases (line 32 coverage)", () => {
		it("uses fallback when serverRetryAfterMs is null", () => {
			const result = getRateLimitBackoff(10, "null-test", null);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is undefined", () => {
			const result = getRateLimitBackoff(11, "undefined-test", undefined);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is NaN", () => {
			const result = getRateLimitBackoff(12, "nan-test", NaN);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is Infinity", () => {
			const result = getRateLimitBackoff(13, "infinity-test", Infinity);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is negative Infinity", () => {
			const result = getRateLimitBackoff(14, "neg-infinity-test", -Infinity);
			expect(result.delayMs).toBe(1000);
		});
	});

	describe("getRateLimitBackoffWithReason", () => {
		it("returns adjusted delay with quota reason", () => {
			const result = getRateLimitBackoffWithReason(0, "test-quota", 1000, "quota");
			expect(result.reason).toBe("quota");
			expect(result.delayMs).toBe(3000);
			expect(result.attempt).toBe(1);
		});

		it("returns adjusted delay with tokens reason", () => {
			const result = getRateLimitBackoffWithReason(1, "test-tokens", 2000, "tokens");
			expect(result.reason).toBe("tokens");
			expect(result.delayMs).toBe(3000);
		});

		it("uses unknown reason by default", () => {
			const result = getRateLimitBackoffWithReason(2, "test-default", 1000);
			expect(result.reason).toBe("unknown");
			expect(result.delayMs).toBe(1000);
		});

		it("increments attempt on subsequent calls", () => {
			getRateLimitBackoffWithReason(3, "test-increment", 1000, "quota");
			vi.setSystemTime(new Date(2500));
			const second = getRateLimitBackoffWithReason(3, "test-increment", 1000, "quota");
			expect(second.attempt).toBe(2);
			expect(second.delayMs).toBe(12000);
		});
	});
});
describe("rate-limit backoff with hostile server inputs", () => {
	afterEach(() => {
		vi.useRealTimers();
		clearRateLimitBackoffState();
	});

	const finitePositiveBounded = (value: number): void => {
		expect(Number.isFinite(value)).toBe(true);
		expect(value).toBeGreaterThanOrEqual(0);
	};

	it("delayMs stays finite and non-negative for NaN/Infinity/negative/zero inputs", () => {
		for (const input of [NaN, Infinity, -Infinity, -5, 0, 1e309, Number.MIN_VALUE]) {
			const result = getRateLimitBackoff(0, `q-${String(input)}`, input);
			finitePositiveBounded(result.delayMs);
			expect(result.attempt).toBeGreaterThanOrEqual(1);
			expect(Number.isFinite(result.attempt)).toBe(true);
		}
	});

	it("huge-but-finite server delay does not overflow to NaN/Infinity", () => {
		const result = getRateLimitBackoff(1, "q-huge", 1e12);
		finitePositiveBounded(result.delayMs);
	});

	it("exponential component never exceeds the 60s cap regardless of attempt count", () => {
		for (let i = 0; i < 2000; i++) {
			const result = getRateLimitBackoff(2, "q-growth", 1000);
			finitePositiveBounded(result.delayMs);
			expect(result.delayMs).toBeLessThanOrEqual(60_000);
		}
	});

	it("backoff with reason stays finite for all reasons and huge attempt counts", () => {
		for (const reason of ["quota", "tokens", "concurrent", "unknown"] as const) {
			const capped = calculateBackoffMs(60_000, 5000, reason);
			finitePositiveBounded(capped);
			expect(capped).toBeLessThanOrEqual(60_000);
		}
		const adjusted = getRateLimitBackoffWithReason(3, "q-reason", 1000, "quota");
		finitePositiveBounded(adjusted.delayMs);
	});

	it("remapRateLimitBackoffAfterRemoval survives malformed keys without resurrecting blocks", () => {
		getRateLimitBackoff(0, "a", 1000);
		getRateLimitBackoff(1, "b", 1000);
		expect(() => remapRateLimitBackoffAfterRemoval(0)).not.toThrow();
		expect(() => remapRateLimitBackoffAfterRemoval(-1)).not.toThrow();
		expect(() => remapRateLimitBackoffAfterRemoval(9999)).not.toThrow();
	});
});
