import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	getTuiQuotaOverviewCachePath,
	isTuiQuotaOverviewSnapshot,
	readTuiQuotaOverviewSnapshot,
	sanitizeTuiQuotaOverviewSnapshot,
	writeTuiQuotaOverviewSnapshot,
	TUI_QUOTA_CACHE_VERSION,
	TUI_QUOTA_OVERVIEW_CACHE_FILE,
	type TuiQuotaOverviewSnapshot,
	type TuiQuotaSnapshot,
} from "../lib/tui-quota-cache.js";
import {
	fetchTuiQuotaOverview,
	mergeOverviewWithLatestAccount,
	toOverviewAccount,
	toQuotaOverviewAccounts,
} from "../lib/tui-quota-overview.js";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

function snapshot(
	overrides: Partial<TuiQuotaOverviewSnapshot> = {},
): TuiQuotaOverviewSnapshot {
	return {
		version: TUI_QUOTA_CACHE_VERSION,
		fetchedAt: NOW,
		accounts: [
			{
				fingerprint: "aaaa",
				index: 1,
				planType: "pro",
				resetCredits: 1,
				limits: [
					{ label: "weekly", leftPercent: 0, usedPercent: 100, windowMinutes: 10080, resetAtMs: NOW + 86_400_000 },
				],
			},
			{
				fingerprint: "bbbb",
				index: 2,
				planType: "team",
				limits: [{ label: "5h", leftPercent: 60, usedPercent: 40, windowMinutes: 300 }],
			},
		],
		...overrides,
	};
}

describe("getTuiQuotaOverviewCachePath", () => {
	it("sits beside the single-account cache in the same state dir", () => {
		expect(getTuiQuotaOverviewCachePath("/state")).toBe(
			join("/state", TUI_QUOTA_OVERVIEW_CACHE_FILE),
		);
	});
});

describe("isTuiQuotaOverviewSnapshot", () => {
	it("accepts a snapshot this build wrote", () => {
		expect(isTuiQuotaOverviewSnapshot(snapshot())).toBe(true);
	});

	it("rejects a document from another version or shape", () => {
		expect(isTuiQuotaOverviewSnapshot(snapshot({ version: 2 as never }))).toBe(false);
		expect(isTuiQuotaOverviewSnapshot({ ...snapshot(), accounts: "no" })).toBe(false);
		expect(isTuiQuotaOverviewSnapshot(null)).toBe(false);
		expect(isTuiQuotaOverviewSnapshot(undefined)).toBe(false);
	});

	it("rejects an account with no fingerprint to attribute it to", () => {
		const invalid = snapshot();
		invalid.accounts[0]!.fingerprint = "  ";
		expect(isTuiQuotaOverviewSnapshot(invalid)).toBe(false);
	});
});

describe("sanitizeTuiQuotaOverviewSnapshot", () => {
	it("drops a window the plan has switched off", () => {
		const withDisabled = snapshot();
		withDisabled.accounts[1]!.limits.push({
			label: "quota",
			leftPercent: 100,
			usedPercent: 0,
			windowMinutes: 0,
		});
		expect(
			sanitizeTuiQuotaOverviewSnapshot(withDisabled).accounts[1]!.limits,
		).toHaveLength(1);
	});
});

describe("overview cache round trip", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "oc-overview-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads back what it wrote", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeTuiQuotaOverviewSnapshot(snapshot(), path);
		expect(await readTuiQuotaOverviewSnapshot(path)).toEqual(snapshot());
	});

	it("treats a missing or corrupt cache as absent rather than throwing", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		expect(await readTuiQuotaOverviewSnapshot(path)).toBeUndefined();
		await writeFile(path, "{ not json");
		expect(await readTuiQuotaOverviewSnapshot(path)).toBeUndefined();
	});

	it("serves a fresh cache without touching storage or the network", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeTuiQuotaOverviewSnapshot(snapshot(), path);
		const result = await fetchTuiQuotaOverview({
			cachePath: path,
			now: NOW + 1000,
			loadStorage: async () => {
				throw new Error("storage must not be read while the cache is fresh");
			},
		});
		expect(result?.accounts).toHaveLength(2);
	});

	it("keeps the last known pool when every account fails to report", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeTuiQuotaOverviewSnapshot(snapshot(), path);
		const stale = await fetchTuiQuotaOverview({
			cachePath: path,
			// Well past the freshness window, so the cache cannot short-circuit.
			now: NOW + 60 * 60 * 1000,
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "r", enabled: true }],
				activeIndex: 0,
			}) as never,
		});
		expect(stale?.fetchedAt).toBe(NOW);
	});

	it("reports nothing when there are no accounts at all", async () => {
		expect(
			await fetchTuiQuotaOverview({
				cachePath: join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE),
				now: NOW,
				loadStorage: async () => null,
			}),
		).toBeUndefined();
	});
});

describe("toOverviewAccount", () => {
	it("keeps only the windows that govern ordinary model requests", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 3,
			usage: {
				planType: "pro",
				credits: null,
				resetCredits: { available: 2, applicableNow: 1 },
				primary: { usedPercent: 40, windowMinutes: 300 },
				secondary: { usedPercent: 10, windowMinutes: 10080 },
				codeReview: { usedPercent: 100, windowMinutes: 300 },
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.limits.map((limit) => limit.label)).toEqual(["5h", "weekly"]);
		expect(account.limits[0]!.leftPercent).toBe(60);
		expect(account.index).toBe(3);
		expect(account.resetCredits).toBe(1);
	});

	it("falls back to the banked count when the applicable count is unreadable", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 1,
			usage: {
				planType: null,
				credits: null,
				resetCredits: { available: 3, applicableNow: null },
				primary: { usedPercent: 0, windowMinutes: 300 },
				secondary: {},
				codeReview: {},
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.resetCredits).toBe(3);
	});

	it("carries the names the status line can call an account by", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 1,
			email: " damian@nowaker.net ",
			label: " work ",
			usage: {
				planType: null,
				credits: null,
				resetCredits: null,
				primary: { usedPercent: 0, windowMinutes: 300 },
				secondary: {},
				codeReview: {},
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.email).toBe("damian@nowaker.net");
		expect(account.label).toBe("work");
	});

	it("leaves a nameless account nameless rather than inventing one", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 1,
			label: "   ",
			usage: {
				planType: null,
				credits: null,
				resetCredits: null,
				primary: { usedPercent: 0, windowMinutes: 300 },
				secondary: {},
				codeReview: {},
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.email).toBeUndefined();
		expect(account.label).toBeUndefined();
	});
});

describe("mergeOverviewWithLatestAccount", () => {
	const latest: TuiQuotaSnapshot = {
		version: TUI_QUOTA_CACHE_VERSION,
		fingerprint: "bbbb",
		fetchedAt: NOW + 60_000,
		source: "headers",
		limits: [{ label: "5h", leftPercent: 12, usedPercent: 88, windowMinutes: 300 }],
	};

	it("takes the request path's newer reading of the serving account", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), latest);
		expect(merged.accounts[1]!.limits[0]!.leftPercent).toBe(12);
		expect(merged.accounts[0]!.limits[0]!.leftPercent).toBe(0);
	});

	it("ignores a reading older than the poll", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			fetchedAt: NOW - 60_000,
		});
		expect(merged.accounts[1]!.limits[0]!.leftPercent).toBe(60);
	});

	it("ignores an account the pool does not contain", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			fingerprint: "zzzz",
		});
		expect(merged).toEqual(snapshot());
	});

	it("ignores an empty reading rather than blanking the account", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			limits: [],
		});
		expect(merged.accounts[1]!.limits).toHaveLength(1);
	});

	it("is a no-op with nothing to merge", () => {
		expect(mergeOverviewWithLatestAccount(snapshot(), undefined)).toEqual(snapshot());
	});

	it("learns an email the pool poll did not have", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			accountEmail: "damian@nowaker.net",
		});
		expect(merged.accounts[1]!.email).toBe("damian@nowaker.net");
	});
});

describe("toQuotaOverviewAccounts", () => {
	it("hands the formatter percentages and resets, not labels", () => {
		expect(toQuotaOverviewAccounts(snapshot())).toEqual([
			{
				index: 1,
				planType: "pro",
				resetCredits: 1,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 86_400_000 }],
			},
			{
				index: 2,
				planType: "team",
				resetCredits: undefined,
				windows: [{ leftPercent: 60, resetAtMs: undefined }],
			},
		]);
	});

	it("passes an unreadable percentage through as absent", () => {
		const unreadable = snapshot();
		unreadable.accounts[0]!.limits[0]!.leftPercent = null;
		expect(toQuotaOverviewAccounts(unreadable)[0]!.windows[0]!.leftPercent).toBeUndefined();
	});
});
