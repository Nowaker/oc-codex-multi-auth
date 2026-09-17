import {
	formatSeatSuffix,
	maskEmailForDisplay,
	resolveDisplayEmail,
	resolveSeatSuffixes,
} from "../lib/account-display.js";

describe("account-display", () => {
	describe("maskEmailForDisplay", () => {
		it("preserves the domain and first two local characters", () => {
			expect(maskEmailForDisplay("user@example.com")).toBe("us***@example.com");
		});

		it("keeps a single-character local part", () => {
			expect(maskEmailForDisplay("a@example.org")).toBe("a***@example.org");
		});

		it("preserves multi-part domains", () => {
			expect(maskEmailForDisplay("user@mail.company.co.uk")).toBe(
				"us***@mail.company.co.uk",
			);
		});

		it("falls back to a fully masked token for non-emails", () => {
			expect(maskEmailForDisplay("not-an-email")).toBe("*****");
		});

		it("returns undefined for empty or whitespace input", () => {
			expect(maskEmailForDisplay(undefined)).toBeUndefined();
			expect(maskEmailForDisplay("")).toBeUndefined();
			expect(maskEmailForDisplay("   ")).toBeUndefined();
		});

		it("trims surrounding whitespace before masking", () => {
			expect(maskEmailForDisplay("  user@example.com  ")).toBe(
				"us***@example.com",
			);
		});
	});

	describe("resolveDisplayEmail", () => {
		it("returns the raw email when masking is disabled", () => {
			expect(resolveDisplayEmail("user@example.com", false)).toBe(
				"user@example.com",
			);
		});

		it("returns a masked email when masking is enabled", () => {
			expect(resolveDisplayEmail("user@example.com", true)).toBe(
				"us***@example.com",
			);
		});

		it("returns undefined when there is no email", () => {
			expect(resolveDisplayEmail(undefined, true)).toBeUndefined();
			expect(resolveDisplayEmail("", false)).toBeUndefined();
		});
	});
});

describe("email masking edge cases", () => {
	it("handles empty, whitespace, no-@, and leading-@ inputs", () => {
		expect(maskEmailForDisplay(undefined)).toBeUndefined();
		expect(maskEmailForDisplay("")).toBeUndefined();
		expect(maskEmailForDisplay("   ")).toBeUndefined();
		expect(maskEmailForDisplay("not-an-email")).toBe("*****");
		expect(maskEmailForDisplay("@example.com")).toBe("*****");
		expect(maskEmailForDisplay("a@example.org")).toBe("a***@example.org");
	});

	it("never emits a lone surrogate for unicode local parts", () => {
		for (const email of [
			"üser@example.com",
			"münchen@example.de",
			"a😀@example.com",
			"😀@example.com",
			"👋🏽hi@example.com",
		]) {
			const masked = maskEmailForDisplay(email)!;
			expect(masked, `masking ${email}`).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
			expect(masked, `masking ${email}`).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		}
	});
});

describe("seat suffix", () => {
	it("uses six characters when nothing else needs telling apart", () => {
		expect(formatSeatSuffix("user_aaaaaa111111")).toBe("111111");
		expect(formatSeatSuffix("abc")).toBe("abc");
		expect(formatSeatSuffix(undefined)).toBeUndefined();
		expect(formatSeatSuffix("   ")).toBeUndefined();
	});

	// Six characters is a tail, not an identity. These two member ids are
	// different seats - different quota, different weekly reset - that happen
	// to end the same way, so a fixed six-character suffix renders both as
	// `000001` and reports two accounts as one.
	it("grows past six characters when distinct ids share a six-character tail", () => {
		const ids = ["member-000001", "other-000001"];

		expect(resolveSeatSuffixes(ids)).toEqual(["ber-000001", "her-000001"]);
		expect(formatSeatSuffix("member-000001", ids)).toBe("ber-000001");
		expect(formatSeatSuffix("other-000001", ids)).toBe("her-000001");
	});

	it("never renders two distinct member ids the same way", () => {
		const cases: string[][] = [
			["member-000001", "other-000001"],
			["aaaaaa", "bbbbbb"],
			["prefix-a-xxxxxx", "prefix-b-xxxxxx", "prefix-c-xxxxxx"],
			["short", "a-very-long-member-identifier-short"],
			["x".repeat(40), `y${"x".repeat(39)}`],
		];

		for (const ids of cases) {
			const rendered = resolveSeatSuffixes(ids).filter(
				(seat): seat is string => seat !== undefined,
			);
			expect(new Set(rendered).size, `rendering ${ids.join(" / ")}`).toBe(
				new Set(ids).size,
			);
		}
	});

	it("holds the position of entries that have no member id", () => {
		expect(resolveSeatSuffixes(["member-000001", undefined, "other-000001"])).toEqual([
			"ber-000001",
			undefined,
			"her-000001",
		]);
	});

	// Repeats of one id are one seat listed twice, not a collision to resolve,
	// so they must not push every row into a longer rendering.
	it("keeps six characters when the only repeats are the same id", () => {
		expect(resolveSeatSuffixes(["user_aaaaaa111111", "user_aaaaaa111111"])).toEqual([
			"111111",
			"111111",
		]);
	});

	// A caller passing the OTHER accounts rather than all of them still gets a
	// suffix that separates this id from them.
	it("counts the rendered id itself even when the peer list omits it", () => {
		expect(formatSeatSuffix("member-000001", ["other-000001"])).toBe("ber-000001");
	});
});
