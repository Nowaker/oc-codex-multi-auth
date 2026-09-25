import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodexUsagePayload } from "../lib/codex-usage.js";
import { formatQuotaResetsCandidates } from "../lib/quota-overview.js";
import { isTuiQuotaOverviewSnapshot, readTuiQuotaOverviewSnapshot, writeTuiQuotaOverviewSnapshot, type TuiQuotaOverviewSnapshot } from "../lib/tui-quota-cache.js";
import { toOverviewAccount, toQuotaOverviewAccounts } from "../lib/tui-quota-overview.js";

describe("reset applicability cache", () => {
	it.each([
		{ usedPercent: 79.8, eligible: false },
		{ usedPercent: 80, eligible: true },
	])("uses unrounded adapter usage at the threshold: $usedPercent", ({ usedPercent, eligible }) => {
		const accounts = [100, usedPercent].map((used, index) => toOverviewAccount({
			fingerprint: `fixture-${index}`, index: index + 1,
			usage: parseCodexUsagePayload({
				plan_type: "plus",
				rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } },
				rate_limit_reset_credits: { available_count: 1, applicable_available_count: index === 0 ? 1 : 0 },
			}),
		}));
		const snapshot = { version: 1 as const, fetchedAt: 1000, accounts } satisfies TuiQuotaOverviewSnapshot;
		const candidates = formatQuotaResetsCandidates(toQuotaOverviewAccounts(snapshot), { minUsedPercent: 90 });
		expect(candidates.length > 0).toBe(eligible);
	});

	it.each([null, 0, 1])("preserves applicability %s across real cache serialization", async (applicable) => {
		// Given
		const dir = await mkdtemp(join(tmpdir(), "quota-applicability-"));
		const path = join(dir, "overview.json");
		const account = toOverviewAccount({ fingerprint: "fixture", index: 1,
			usage: parseCodexUsagePayload({
				rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
				rate_limit_reset_credits: { available_count: 2,
					applicable_available_count: applicable === null ? -1 : applicable },
			}),
		});
		try {
			// When
			await writeTuiQuotaOverviewSnapshot({ version: 1, fetchedAt: 1000, accounts: [account] }, path);
			const cached = await readTuiQuotaOverviewSnapshot(path);
			// Then
			expect(cached?.accounts[0]?.resetCreditsApplicable).toBe(applicable);
			if (!cached) throw new Error("fixture cache missing");
			const candidates = formatQuotaResetsCandidates(toQuotaOverviewAccounts(cached), {});
			expect(candidates.length > 0).toBe(applicable === 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("treats a pool whose displayed headroom is 0% as spent at the default threshold", () => {
		const account = toOverviewAccount({ fingerprint: "fixture", index: 1,
			usage: parseCodexUsagePayload({
				plan_type: "plus",
				rate_limit: { primary_window: { used_percent: 99.6, limit_window_seconds: 18000 } },
				rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
			}),
		});
		const snapshot = { version: 1 as const, fetchedAt: 1000, accounts: [account] } satisfies TuiQuotaOverviewSnapshot;
		expect(formatQuotaResetsCandidates(toQuotaOverviewAccounts(snapshot), {}).length).toBeGreaterThan(0);
	});

	it.each([-1, 0.5, "1", Infinity])("rejects invalid cached applicability %s", (applicable) => {
		// Given
		const snapshot = { version: 1, fetchedAt: 1000, accounts: [{ fingerprint: "fixture",
			index: 1, limits: [], resetCredits: 2, resetCreditsApplicable: applicable }] };
		// When / Then
		expect(isTuiQuotaOverviewSnapshot(snapshot)).toBe(false);
	});
});
