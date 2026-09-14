import { describe, it, expect } from "vitest";
import {
	RetryBudgetTracker,
	resolveRetryBudgetLimits,
	type RetryBudgetLimits,
} from "../lib/request/retry-budget.js";

describe("retry-budget", () => {
	it("resolves profile defaults", () => {
		const conservative = resolveRetryBudgetLimits("conservative");
		const aggressive = resolveRetryBudgetLimits("aggressive");

		expect(conservative.rateLimitGlobal).toBe(1);
		expect(aggressive.rateLimitGlobal).toBeGreaterThan(conservative.rateLimitGlobal);
	});

	it("applies normalized overrides", () => {
		const limits = resolveRetryBudgetLimits("balanced", {
			network: 2.9,
			server: -1,
			emptyResponse: 0,
		});

		expect(limits.network).toBe(2);
		expect(limits.server).toBe(4);
		expect(limits.emptyResponse).toBe(0);
	});

	it("tracks usage and remaining budget", () => {
		const limits: RetryBudgetLimits = {
			authRefresh: 1,
			network: 1,
			server: 1,
			rateLimitShort: 1,
			rateLimitGlobal: 1,
			emptyResponse: 1,
		};
		const tracker = new RetryBudgetTracker(limits);

		expect(tracker.consume("network")).toBe(true);
		expect(tracker.consume("network")).toBe(false);
		expect(tracker.getRemaining("network")).toBe(0);
		expect(tracker.getUsage().network).toBe(1);
	});

	it("verifies budget consumption semantics across error stages", () => {
		const limits: RetryBudgetLimits = {
			authRefresh: 2,
			network: 2,
			server: 2,
			rateLimitShort: 2,
			rateLimitGlobal: 1,
			emptyResponse: 1,
		};
		const tracker = new RetryBudgetTracker(limits);

		// An initial long-delay rate limit rotates without consuming rateLimitGlobal
		expect(tracker.getUsage().rateLimitGlobal).toBe(0);
		expect(tracker.getRemaining("rateLimitGlobal")).toBe(1);

		// An invalidated 401 response triggers account rotation/cooldown without consuming authRefresh directly
		expect(tracker.getUsage().authRefresh).toBe(0);
		expect(tracker.getRemaining("authRefresh")).toBe(2);

		// Global all-accounts blocked wait consumes rateLimitGlobal
		expect(tracker.consume("rateLimitGlobal")).toBe(true);
		expect(tracker.getRemaining("rateLimitGlobal")).toBe(0);
		expect(tracker.consume("rateLimitGlobal")).toBe(false);

		// Token refresh attempts consume authRefresh
		expect(tracker.consume("authRefresh")).toBe(true);
		expect(tracker.getUsage().authRefresh).toBe(1);
	});

	it("clones constructor limits to avoid external mutation", () => {
		const limits: RetryBudgetLimits = {
			authRefresh: 1,
			network: 2,
			server: 3,
			rateLimitShort: 4,
			rateLimitGlobal: 5,
			emptyResponse: 6,
		};
		const tracker = new RetryBudgetTracker(limits);
		limits.network = 0;
		expect(tracker.getLimits().network).toBe(2);
	});
});
