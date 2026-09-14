import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
	...await original<typeof import("node:os")>(),
	homedir: () => home.path,
}));
vi.mock("../lib/logger.js", () => ({ logWarn: vi.fn() }));

describe("config hot reload", () => {
	let configPath: string;
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		home.path = mkdtempSync(join(tmpdir(), "config-hot-reload-"));
		mkdirSync(join(home.path, ".opencode"));
		configPath = join(home.path, ".opencode", "openai-codex-auth-config.json");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home.path, { recursive: true, force: true });
	});

	it("reuses the parsed object when the file stat is unchanged", async () => {
		writeFileSync(configPath, '{"retryAllAccountsRateLimited":true}');
		const { loadPluginConfig } = await import("../lib/config.js");
		const first = loadPluginConfig();
		expect(loadPluginConfig()).toBe(first);
	});

	it("reloads changed values when size changes with the same mtime", async () => {
		writeFileSync(configPath, '{"retryAllAccountsRateLimited":true}');
		utimesSync(configPath, 100, 100);
		const { loadPluginConfig } = await import("../lib/config.js");
		const first = loadPluginConfig();
		writeFileSync(configPath, '{"retryAllAccountsRateLimited":false}');
		utimesSync(configPath, 100, 100);
		const second = loadPluginConfig();
		expect(second).not.toBe(first);
		expect(second.retryAllAccountsRateLimited).toBe(false);
	});

	it("reloads when mtime changes with the same size", async () => {
		writeFileSync(configPath, '{"retryAllAccountsMaxRetries":1}');
		const { loadPluginConfig } = await import("../lib/config.js");
		loadPluginConfig();
		const previous = statSync(configPath);
		writeFileSync(configPath, '{"retryAllAccountsMaxRetries":2}');
		utimesSync(configPath, previous.atime, new Date(previous.mtimeMs + 1000));
		expect(loadPluginConfig().retryAllAccountsMaxRetries).toBe(2);
	});

	it("uses defaults on deletion and notices recreation", async () => {
		const { loadPluginConfig } = await import("../lib/config.js");
		const defaults = loadPluginConfig();
		expect(loadPluginConfig()).toBe(defaults);
		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		expect(loadPluginConfig().rotationStrategy).toBe("sticky");
		unlinkSync(configPath);
		expect(loadPluginConfig()).toBe(defaults);
		writeFileSync(configPath, '{"rotationStrategy":"round-robin"}');
		expect(loadPluginConfig().rotationStrategy).toBe("round-robin");
	});

	it("warns only once per parse and keeps env getters live", async () => {
		writeFileSync(configPath, '{"fallbackOnUnsupportedCodexModel":true}');
		const { loadPluginConfig, getCodexTuiMaskEmail } = await import("../lib/config.js");
		const { logWarn } = await import("../lib/logger.js");
		const first = loadPluginConfig();
		loadPluginConfig();
		expect(logWarn).toHaveBeenCalledTimes(1);
		vi.stubEnv("CODEX_TUI_MASK_EMAIL", "1");
		expect(getCodexTuiMaskEmail(first)).toBe(true);
		vi.stubEnv("CODEX_TUI_MASK_EMAIL", "0");
		expect(getCodexTuiMaskEmail(first)).toBe(false);
	});
});
