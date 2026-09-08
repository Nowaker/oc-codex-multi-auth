import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	formatPromptStatusText,
	formatQuotaDetailsText,
	resolvePromptReasoningVariant,
	resolveQuotaPromptTone,
	type CompactQuotaStatus,
	type PromptStatusConfig,
	type PromptStatusMessage,
} from "../lib/tui-status.js";

const sep = ` ${String.fromCharCode(183)} `;
const quota: CompactQuotaStatus = {
	type: "ready",
	limits: [
		{ label: "5h", leftPercent: 88 },
		{ label: "7d", leftPercent: 83 },
	],
	stale: false,
};

describe("TUI prompt status helpers", () => {

	it("formats prompt status text from supplied quota labels", () => {
		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota,
				width: 120,
			}),
		).toBe(`5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota,
				width: 80,
			}),
		).toBe(`5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota,
				width: 50,
			}),
		).toBe("5h 88%");
	});

	it("falls back to non-sensitive status when quota is unavailable", () => {
		expect(
			formatPromptStatusText({
				variant: "high",
				quota: { type: "unavailable" },
				width: 120,
			}),
		).toBe("limits ?");
		expect(
			formatPromptStatusText({
				quota: { type: "missing" },
				width: 120,
			}),
		).toBe("no auth");
		expect(
			formatPromptStatusText({
				quota: { type: "loading" },
				width: 120,
			}),
		).toBe("");
	});

	it("adds account hint only when multiple accounts are configured", () => {
		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 120,
			}),
		).toBe(`[user2@example.com]${sep}5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
				},
				width: 120,
			}),
		).toBe(`A2${sep}5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 1,
					accountCount: 1,
				},
				width: 120,
			}),
		).toBe(`5h 88%${sep}7d 83%`);
	});

	it("masks account email in prompt status when requested", () => {
		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 120,
				maskEmail: true,
			}),
		).toBe(`[us***@example.com]${sep}5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountLabel: "Account 2 (user2@example.com)",
				},
				width: 120,
				maskEmail: true,
			}),
		).toBe(`[us***@example.com]${sep}5h 88%${sep}7d 83%`);
	});

	it("preserves account email in prompt status when masking is disabled", () => {
		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 120,
				maskEmail: false,
			}),
		).toBe(`[user2@example.com]${sep}5h 88%${sep}7d 83%`);
	});

	it("prefers quota over variant when status space is tight", () => {
		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 50,
			}),
		).toBe("5h 88%");
	});

	it("resolves prompt tone from quota thresholds", () => {
		expect(resolveQuotaPromptTone(quota)).toBe("normal");
		expect(
			resolveQuotaPromptTone({
				...quota,
				limits: [{ label: "5h", leftPercent: 20 }],
			}),
		).toBe("warning");
		expect(
			resolveQuotaPromptTone({
				...quota,
				limits: [{ label: "5h", leftPercent: 8 }],
			}),
		).toBe("danger");
		expect(resolveQuotaPromptTone({ ...quota, stale: true })).toBe("stale");
	});

	it("adds reset time to compact status only when quota is low", () => {
		// Pinned to midday. On the real clock a reset one minute out lands on
		// tomorrow whenever the suite runs in the last minute before local
		// midnight, and the day-context formatter then renders "Sat 00:00",
		// which the leading digits below reject.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 5, 12, 0));
		try {
			const resetStatus = formatPromptStatusText({
				quota: {
					...quota,
					limits: [
						{ label: "5h", leftPercent: 8, resetAtMs: Date.now() + 60_000 },
						{ label: "7d", leftPercent: 83 },
					],
				},
				width: 120,
			});

			expect(resetStatus).toMatch(/5h 8% resets \d{2}:\d{2}/);
			expect(resetStatus).toContain("7d 83%");
			expect(
				formatPromptStatusText({
					quota,
					width: 120,
				}),
			).not.toContain("resets");
		} finally {
			vi.useRealTimers();
		}
	});

	it("formats quota details for the command dialog", () => {
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
				accountLabel: "Account 2 (neil@example.com)",
				source: "headers",
				fetchedAt: 1_000,
				planType: "plus",
				activeLimit: 40,
			},
			31_000,
		);

		expect(details).toContain("Account: [neil@example.com] (Account 2");
		expect(details).toContain("5h: 88% left");
		// Named the same way the stored plan is, so one seat does not read
		// "Plus" in codex-list and "plus" here.
		expect(details).toContain("Plan: Plus");
		expect(details).toContain("Active limit: 40");
		expect(details).toContain("Source: response headers");
		expect(details).toContain("Updated: just now");
	});

	it("partial mask keeps accounts distinguishable in prompt status", () => {
		const one = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "javi.ortiz.1982@gmail.com",
			},
			width: 120,
			maskEmail: true,
		});
		const two = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(one).toContain("[ja***@gmail.com]");
		expect(two).toContain("[ne***@example.com]");
		expect(one).not.toContain("javi.ortiz.1982@gmail.com");
	});

	it("falls back to a flat mask for account values without an email pattern", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "user-without-at-sign",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[*****]");
		expect(out).not.toContain("user-without-at-sign");
	});

	it("falls back to the flat mask rather than dropping the account", () => {
		// The partial hint is twelve characters longer than the flat one, and
		// the ladder drops the account hint when a rung does not fit. Without
		// the flat form as a second try at the same rung, turning masking on
		// removes the account from a 78-column line entirely - identifying the
		// account less rather than more, which is the opposite of the point.
		// The domain is long enough that the partial hint overruns the
		// 78-column budget by a clear margin and fits the 120-column one with
		// room to spare, so the two assertions do not sit on a boundary that a
		// change to the budget table could tip.
		const masked = {
			...quota,
			accountIndex: 2,
			accountCount: 3,
			accountEmail: "someone@eng.university.edu",
		};

		expect(
			formatPromptStatusText({ quota: masked, width: 78, maskEmail: true }),
		).toBe(`[*****]${sep}5h 88%${sep}7d 83%`);
		expect(
			formatPromptStatusText({ quota: masked, width: 120, maskEmail: true }),
		).toBe(`[so***@eng.university.edu]${sep}5h 88%${sep}7d 83%`);
	});

	it("reduces a multi-address account value to one masked address", () => {
		// The hint is an identity for one account, so it takes the address and
		// discards the rest rather than masking in place. Substituting in
		// place is what would keep the second address, or a real name, beside
		// the mask.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "alice@example.com;bob@corp.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[al***@example.com]");
		expect(out).not.toContain("alice@example.com");
		expect(out).not.toContain("bob@corp.com");
	});

	it("keeps no identifying text around the address it masks", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "Neil Smith neil@example.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[ne***@example.com]");
		expect(out).not.toContain("Neil Smith");
	});

	it("flattens an account value whose separator is not an address boundary", () => {
		// `/` is not a separator the token scan splits on, so both addresses
		// land in one match. A partial mask keeps everything after the first
		// `@`, which here is the whole of the second address.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "alice@example.com/bob@corp.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[*****]");
		expect(out).not.toContain("bob");
		expect(out).not.toContain("corp.com");
	});

	it("flattens an account value that has an @ but is not an address", () => {
		// `maskEmailForDisplay` keeps everything from the first `@` onward,
		// which for free text is the free text.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "Team @ Acme Corp",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[*****]");
		expect(out).not.toContain("Acme");
	});

	it("masks every address in a label, whatever punctuation joins them", () => {
		// The details dialog keeps the label's structure, so masking there is
		// in place. Each token carrying an `@` is masked on its own, and a
		// token carrying two is flattened rather than half-masked.
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "alice@example.com",
				accountLabel: "Shared: alice@example.com;bob@corp.com and carol@x.io/dave@y.io",
				source: "headers",
				fetchedAt: 1_000,
			},
			31_000,
			{ maskEmail: true },
		);

		expect(details).toContain("al***@example.com;bo***@corp.com");
		expect(details).toContain("*****");
		expect(details).not.toContain("bob@corp.com");
		expect(details).not.toContain("carol");
		expect(details).not.toContain("dave");
		expect(details).not.toContain("y.io");
	});

	it("masks emails embedded in free-text account labels", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountLabel: "Account 2 (user2@example.com)",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[us***@example.com]");
		expect(out).not.toContain("user2@example.com");
	});

	it("masks account email in quota details when requested", () => {
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
				accountLabel: "Account 2 (neil@example.com)",
				source: "usage",
				fetchedAt: 1_000,
			},
			31_000,
			{ maskEmail: true },
		);

		expect(details).toContain("Account: [ne***@example.com] (Account 2 (ne***@example.com))");
		expect(details).not.toContain("neil@example.com");
		expect(details).toContain("5h: 88% left");
	});

	it("preserves account email in quota details when masking is disabled", () => {
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
				accountLabel: "Account 2 (neil@example.com)",
				source: "usage",
				fetchedAt: 1_000,
			},
			31_000,
			{ maskEmail: false },
		);

		expect(details).toContain("Account: [neil@example.com] (Account 2 (neil@example.com))");
	});

	it("resolves the selected variant from session messages before config defaults", () => {
		const messages: PromptStatusMessage[] = [
			{
				role: "assistant",
				modelID: "gpt-5.5-high",
				variant: "high",
			},
			{
				role: "user",
				userModel: {
					modelID: "gpt-5.5",
					variant: "xhigh",
				},
			},
		];
		const config: PromptStatusConfig = {
			model: "openai/gpt-5.5-medium",
		};

		expect(resolvePromptReasoningVariant({ messages, config })).toBe("xhigh");
	});

	it("resolves legacy suffixes and provider reasoning options from config", () => {
		expect(
			resolvePromptReasoningVariant({
				config: {
					model: "openai/gpt-5.5-fast-medium",
				},
			}),
		).toBe("medium");

		expect(
			resolvePromptReasoningVariant({
				config: {
					model: "openai/gpt-5.5",
					provider: {
						openai: {
							options: {
								reasoningEffort: "high",
							},
						},
					},
				},
			}),
		).toBe("high");
	});

	it("prefers the selected agent reasoning effort over provider defaults", () => {
		const config: PromptStatusConfig = {
			model: "openai/gpt-5.5",
			default_agent: "Sisyphus - Ultraworker",
			agent: {
				"Sisyphus - Ultraworker": {
					model: "openai/gpt-5.5",
					reasoningEffort: "xhigh",
				},
			},
			provider: {
				openai: {
					options: {
						reasoningEffort: "medium",
					},
				},
			},
		};

		expect(resolvePromptReasoningVariant({ config })).toBe("xhigh");
	});
});

describe("formatResetTime day context", () => {
	// Fake timers freeze both Date.now() and new Date() so the formatter's
	// "now" and the fixed reset timestamps land on deterministic dates.
	const now = new Date(2026, 8, 5, 12, 0); // 2026-09-05T12:00 local
	// Expected labels are derived from the runtime's own Intl formatting so
	// the assertions hold under any default locale.
	const weekdayLabel = new Date(2026, 8, 8, 2, 25).toLocaleDateString(
		undefined,
		{ weekday: "short" },
	);
	const dateLabel = new Date(2026, 8, 15, 2, 25).toLocaleDateString(undefined, {
		month: "short",
		day: "2-digit",
	});
	const timeLabel = (h: number, m: number) =>
		new Date(2026, 8, 5, h, m)
			.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			})
			.replace(/^24/, "00");

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps an unknown width inside the narrowest terminal it stands in for", () => {
		// The renderer reports no width during an early render or from a
		// detached renderer, and this branch also covers a 40-column
		// terminal. A budget wider than that wraps the line and pushes the
		// prompt, with nothing here able to detect it happened.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "someone@student.university.edu",
				limits: [
					{ label: "5h", leftPercent: 8, resetAtMs: new Date(2026, 8, 15, 2, 25).getTime() },
					{ label: "7d", leftPercent: 83 },
				],
			},
		});

		expect(out.length).toBeLessThanOrEqual(32);
		expect(out).not.toBe("");
	});

	it("keeps time-only format for same-day resets", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [
					{ label: "5h", leftPercent: 8, resetAtMs: new Date(2026, 8, 5, 18, 30).getTime() },
				],
			},
			width: 120,
		});
		expect(out).toBe(`5h 8% resets ${timeLabel(18, 30)}`);
	});

	it("adds weekday for resets within the coming week", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [
					{ label: "7d", leftPercent: 0, resetAtMs: new Date(2026, 8, 8, 2, 25).getTime() },
				],
			},
			width: 120,
		});
		expect(out).toBe(`7d 0% resets ${weekdayLabel} ${timeLabel(2, 25)}`);
	});

	it("uses absolute date beyond a week", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [
					{ label: "7d", leftPercent: 0, resetAtMs: new Date(2026, 8, 15, 2, 25).getTime() },
				],
			},
			width: 120,
		});
		expect(out).toBe(`7d 0% resets ${dateLabel} ${timeLabel(2, 25)}`);
	});

	it("uses absolute date at exactly seven calendar days over a DST weekend", () => {
		// 2026-03-02 -> 2026-03-09 is seven calendar days. In a zone that
		// springs forward that weekend (America/New_York among them) the same
		// gap is 167 hours, and a millisecond division reads it as six days
		// and renders "Mon", repeating today's weekday. The assertion holds in
		// any zone; it only exercises the DST path when the runner is in one.
		vi.setSystemTime(new Date(2026, 2, 2, 12, 0));
		const reset = new Date(2026, 2, 9, 2, 25);
		const expected = `${reset.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${reset.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [{ label: "7d", leftPercent: 0, resetAtMs: reset.getTime() }],
			},
			width: 120,
		});
		expect(out).toBe(`7d 0% resets ${expected}`);
	});
});
