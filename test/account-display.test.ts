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

	// A SYNTHETIC single-divergence shape - one distinguishing character, then
	// 38 identical ones - not what this backend issues; see the measured
	// profile below. No tail reaches a difference at the head, so a tail search
	// returns all 39 characters for every account. This is the case the single
	// anchored window exists for.
	it("stays short for ids that differ only at their first character", () => {
		const workspace = "05cd9f04-d56a-4256-9934-9cb827989a40";
		const ids = ["9", "X", "E", "W"].map((seat) => `${seat}__${workspace}`);

		expect(resolveSeatSuffixes(ids)).toEqual([
			"9__05c",
			"X__05c",
			"E__05c",
			"W__05c",
		]);
		expect(formatSeatSuffix(`9__${workspace}`, ids)).toBe("9__05c");
	});

	/**
	 * The profile measured structurally against a real nine-seat Business pool:
	 * 67 characters, five shared leading characters, no shared tail, and
	 * pairwise first divergences at three positions 26 apart. Reproduced rather
	 * than described, because the fixture it replaces encoded a description of
	 * that data that turned out to be wrong.
	 */
	const realPoolProfileIds = (): string[] => {
		const member = (head: string) => `${head}0123456789abcdefghijklmno`;
		const seat = (head: string, workspace: string) => `user_${member(head)}${workspace}`;
		const w1 = "05cd9f04-d56a-4256-9934-9cb827989a40";
		const w2 = "0ce0db3a-1111-2222-3333-444444ff8839";
		const w3 = "15aaaaaa-2222-3333-4444-555555aa1111";
		const w4 = "25bbbbbb-3333-4444-5555-666666bb2222";
		const w5 = "35cccccc-4444-5555-6666-777777cc3333";
		return [
			seat("A", w1),
			seat("B", w1),
			seat("C", w1),
			seat("D", w1),
			seat("E", w2),
			seat("A", w2),
			seat("B", w3),
			seat("F", w4),
			seat("C", w5),
		];
	};

	const firstDivergence = (left: string, right: string): number => {
		let index = 0;
		while (index < left.length && left[index] === right[index]) index += 1;
		return index;
	};

	it("carries the structure measured on the real pool, not a paraphrase of it", () => {
		const ids = realPoolProfileIds();
		const divergences = new Set<number>();
		for (let left = 0; left < ids.length; left += 1) {
			for (let right = left + 1; right < ids.length; right += 1) {
				divergences.add(firstDivergence(ids[left]!, ids[right]!));
			}
		}

		expect([...new Set(ids.map((id) => id.length))]).toEqual([67]);
		expect(new Set(ids).size).toBe(9);
		expect([...divergences].sort((left, right) => left - right)).toEqual([5, 31, 32]);
		// Neither of the first two strategies can separate these inside the cap,
		// which is what makes this shape worth a fixture at all.
		expect(new Set(ids.map((id) => id.slice(-32))).size).toBe(5);
		expect(new Set(ids.map((id) => id.slice(5, 5 + 12))).size).toBe(6);
	});

	// Distinct and bounded is the entire contract on this shape. Deliberately
	// not a specific string: which strategy reaches it is an implementation
	// detail, and pinning one is how the previous fixture came to assert a
	// rendering the real data never produced.
	it("renders the real-pool profile distinct and bounded", () => {
		const rendered = resolveSeatSuffixes(realPoolProfileIds()).filter(
			(seat): seat is string => seat !== undefined,
		);

		expect(rendered).toHaveLength(9);
		expect(new Set(rendered).size).toBe(9);
		for (const seat of rendered) {
			expect(seat.length, seat).toBeLessThanOrEqual(32);
		}
	});

	// Distinct and bounded is satisfied by a hash too, so on its own it leaves
	// the joined-excerpt strategy unpinned - delete that strategy and this
	// profile silently falls through to opaque output. This asserts the part
	// that is worth having: every piece of the rendered seat is lifted from the
	// id, so a human can find it there. Still no literal window.
	it("keeps the real-pool seat derived from the id rather than hashed", () => {
		const ids = realPoolProfileIds();
		const rendered = resolveSeatSuffixes(ids);

		ids.forEach((id, index) => {
			const seat = rendered[index];
			expect(seat, id).toBeDefined();
			for (const piece of String(seat).split("..")) {
				expect(piece.length, `"${piece}" of "${seat}"`).toBeGreaterThan(0);
				expect(id, `"${piece}" of "${seat}"`).toContain(piece);
			}
		});
	});

	// The hash is not a branch kept for tidiness. Divergences too many or too
	// far apart for joined excerpts to cover inside the cap land here, and what
	// it prints cannot be matched against the id by eye - which is why the
	// surfaces that print it have to say so.
	it("falls back to a bounded hash when the divergences are too scattered to excerpt", () => {
		const ids = [
			"A".repeat(60),
			...[0, 3, 6, 9, 12, 15, 18, 21].map(
				(at) => `${"A".repeat(at)}B${"A".repeat(59 - at)}`,
			),
		];

		const rendered = resolveSeatSuffixes(ids).filter(
			(seat): seat is string => seat !== undefined,
		);

		expect(new Set(rendered).size).toBe(ids.length);
		for (const seat of rendered) {
			expect(seat).toMatch(/^[0-9a-f]{8}$/);
		}
	});

	// A rendered seat sits in a table column, so its width may not be a
	// function of how long the member id happens to be. 32 is the contract:
	// the longest hash prefix the last-resort renderer can reach.
	it("bounds every rendering regardless of id length", () => {
		const workspace = "05cd9f04-d56a-4256-9934-9cb827989a40";
		const otherWorkspace = "0ce0db3a-1111-2222-3333-444444ff8839";
		const cases: string[][] = [
			["9", "X", "E", "W"].map((seat) => `${seat}__${workspace}`),
			[
				...["9", "X"].map((seat) => `${seat}__${workspace}`),
				...["Q", "R"].map((seat) => `${seat}__${otherWorkspace}`),
			],
			["member-000001", "other-000001"],
			["a".repeat(200), `b${"a".repeat(199)}`],
			// Long enough that returning any of them whole would breach the bound.
			[`${"A".repeat(50)}X`, `${"A".repeat(50)}Y`, `B${"A".repeat(50)}X`],
			realPoolProfileIds(),
			[
				"A".repeat(60),
				...[0, 3, 6, 9, 12, 15, 18, 21].map(
					(at) => `${"A".repeat(at)}B${"A".repeat(59 - at)}`,
				),
			],
		];

		for (const ids of cases) {
			const rendered = resolveSeatSuffixes(ids).filter(
				(seat): seat is string => seat !== undefined,
			);
			expect(new Set(rendered).size, `rendering ${ids.join(" / ")}`).toBe(
				new Set(ids).size,
			);
			for (const seat of rendered) {
				expect(seat.length, `"${seat}" from ${ids.join(" / ")}`).toBeLessThanOrEqual(32);
			}
		}
	});
});
