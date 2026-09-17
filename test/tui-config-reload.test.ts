import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	homedir: () => home.path,
}));

type TuiModule = typeof import("../tui.js");
type PromptStatusOptions = ReturnType<TuiModule["readPromptStatusOptions"]>;

describe("TUI status configuration reload", () => {
	let configPath: string;
	let read: TuiModule["readPromptStatusOptions"];
	let same: TuiModule["samePromptStatusOptions"];

	const writeConfig = (config: unknown): void => {
		writeFileSync(configPath, JSON.stringify(config));
	};

	// Imported ONCE, which is also what the behaviour under test requires: a
	// reload that only works by re-importing the module proves nothing, since
	// the running TUI never re-imports. The config path is captured when
	// `lib/config.ts` is first evaluated, so the home directory is fixed before
	// that import and each test rewrites the same file underneath it.
	beforeAll(async () => {
		home.path = mkdtempSync(join(tmpdir(), "tui-config-reload-"));
		mkdirSync(join(home.path, ".opencode"));
		configPath = join(home.path, ".opencode", "openai-codex-auth-config.json");
		const tui: TuiModule = await import("../tui.js");
		read = tui.readPromptStatusOptions;
		same = tui.samePromptStatusOptions;
	});

	afterAll(() => {
		rmSync(home.path, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reports the shipped defaults when nothing is configured", () => {
		writeConfig({});
		expect(read()).toMatchObject({
			quotaDisplay: "free",
			quotaStatus: {
				mode: "active",
				accounts: true,
				multipliers: false,
				resetTimes: true,
				resetCredits: false,
				recovery: false,
			},
		});
	});

	it("picks up an edit to the file without reloading the module", () => {
		writeConfig({ quotaStatus: { mode: "active" } });
		expect(read().quotaStatus.mode).toBe("active");

		writeConfig({
			quotaDisplay: "used",
			quotaStatus: { mode: "overview", multipliers: true, recovery: true },
		});
		const after = read();
		expect(after.quotaStatus.mode).toBe("overview");
		expect(after.quotaStatus.multipliers).toBe(true);
		expect(after.quotaStatus.recovery).toBe(true);
		expect(after.quotaDisplay).toBe("used");
	});

	it("follows a switch back to the serving-account line", () => {
		writeConfig({ quotaStatus: { mode: "overview" } });
		expect(read().quotaStatus.mode).toBe("overview");

		writeConfig({ quotaStatus: { mode: "active" } });
		expect(read().quotaStatus.mode).toBe("active");
	});

	it("keeps the last usable reading when the file is mid-write", () => {
		writeConfig({ quotaStatus: { mode: "overview", recovery: true } });
		expect(read().quotaStatus.recovery).toBe(true);

		writeFileSync(configPath, '{"quotaStatus":{"mode":"over');
		const during = read();
		expect(during.quotaStatus.mode).toBe("overview");
		expect(during.quotaStatus.recovery).toBe(true);
	});

	it("lets the environment keep overriding the file on every read", () => {
		writeConfig({ quotaStatus: { mode: "overview" } });
		vi.stubEnv("CODEX_AUTH_QUOTA_STATUS", "active");
		expect(read().quotaStatus.mode).toBe("active");

		writeConfig({ quotaStatus: { mode: "overview", multipliers: true } });
		const after = read();
		expect(after.quotaStatus.mode).toBe("active");
		expect(after.quotaStatus.multipliers).toBe(true);
	});

	it("treats two readings of unchanged configuration as equal", () => {
		writeConfig({
			quotaDisplay: "used",
			quotaStatus: { mode: "overview", multipliers: true, recovery: true },
		});
		const first = read();
		const second = read();
		// Identity deliberately differs: every poll builds a fresh object, so
		// only a field-by-field comparison can stop a re-render every tick.
		expect(second).not.toBe(first);
		expect(same(first, second)).toBe(true);
	});

	it("notices a change in every field that shapes the line", () => {
		const base = {
			quotaDisplay: "free",
			maskEmail: false,
			maskEmailInQuotaDetails: false,
			quotaStatus: {
				mode: "active",
				accounts: true,
				multipliers: false,
				resetTimes: true,
				resetCredits: false,
				recovery: false,
			},
		} as const;
		writeConfig(base);
		const first = read();

		const changes: Array<Record<string, unknown>> = [
			{ ...base, quotaDisplay: "used" },
			{ ...base, maskEmail: true },
			{ ...base, maskEmailInQuotaDetails: true },
			{ ...base, quotaStatus: { ...base.quotaStatus, mode: "overview" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, accounts: false } },
			{ ...base, quotaStatus: { ...base.quotaStatus, multipliers: true } },
			{ ...base, quotaStatus: { ...base.quotaStatus, resetTimes: false } },
			{ ...base, quotaStatus: { ...base.quotaStatus, resetCredits: true } },
			{ ...base, quotaStatus: { ...base.quotaStatus, recovery: true } },
		];
		for (const change of changes) {
			writeConfig(change);
			expect(same(first, read())).toBe(false);
		}
	});
});
