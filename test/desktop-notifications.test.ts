import { describe, expect, it, vi } from "vitest";

import {
	createDesktopNotifier,
	isDesktopNotificationSupported,
	resolveTerminalNotifierPath,
} from "../lib/desktop-notifications.js";

type ExecuteCallback = (error: Error | null) => void;

describe("desktop notifications", () => {
	it("uses terminal-notifier with OpenCode branding and grouped safe arguments", async () => {
		const executeFile = vi.fn(
			(_file: string, _args: string[], _options: unknown, callback: ExecuteCallback) => {
				callback(null);
			},
		);
		const notify = createDesktopNotifier({
			platform: "darwin",
			executeFile,
			terminalNotifierPath: "/opt/homebrew/bin/terminal-notifier",
		});
		const title = 'Quota "$(unsafe)"';
		const message = "10% left\n`unsafe`";

		await expect(notify(title, message)).resolves.toBe(true);
		expect(executeFile).toHaveBeenCalledWith(
			"/opt/homebrew/bin/terminal-notifier",
			[
				"-title", title,
				"-message", message,
				"-sender", "ai.opencode.desktop",
				"-activate", "ai.opencode.desktop",
				"-group", "oc-codex-multi-auth-quota",
			],
			{ timeout: 10_000, windowsHide: true },
			expect.any(Function),
		);
	});

	it("uses macOS osascript without interpolating notification content", async () => {
		const executeFile = vi.fn(
			(_file: string, _args: string[], _options: unknown, callback: ExecuteCallback) => {
				callback(null);
			},
		);
		const notify = createDesktopNotifier({
			platform: "darwin",
			executeFile,
			terminalNotifierPath: null,
		});
		const title = 'Quota "$(unsafe)"';
		const message = "10% left\n`unsafe`";

		await expect(notify(title, message)).resolves.toBe(true);
		expect(executeFile).toHaveBeenCalledOnce();
		const [file, args, options] = executeFile.mock.calls[0] ?? [];
		expect(file).toBe("/usr/bin/osascript");
		expect(args?.slice(0, 4)).toEqual(["-l", "JavaScript", "-e", expect.any(String)]);
		expect(args?.slice(4)).toEqual([title, message]);
		expect(args?.[3]).not.toContain(title);
		expect(args?.[3]).not.toContain(message);
		expect(options).toEqual({ timeout: 10_000, windowsHide: true });
	});

	it("falls back to osascript when branded delivery fails", async () => {
		const executeFile = vi.fn(
			(file: string, _args: string[], _options: unknown, callback: ExecuteCallback) => {
				callback(file.includes("terminal-notifier") ? new Error("failed") : null);
			},
		);
		const notify = createDesktopNotifier({
			platform: "darwin",
			executeFile,
			terminalNotifierPath: "/opt/homebrew/bin/terminal-notifier",
		});

		await expect(notify("Quota", "Body")).resolves.toBe(true);
		expect(executeFile).toHaveBeenCalledTimes(2);
		expect(executeFile.mock.calls[1]?.[0]).toBe("/usr/bin/osascript");
	});

	it("returns false when branded and fallback delivery both fail", async () => {
		const executeFile = vi.fn(
			(_file: string, _args: string[], _options: unknown, callback: ExecuteCallback) => {
				callback(Object.assign(new Error("failed"), { code: "EACCES" }));
			},
		);
		const notify = createDesktopNotifier({
			platform: "darwin",
			executeFile,
			terminalNotifierPath: "/opt/homebrew/bin/terminal-notifier",
		});

		await expect(notify("Quota", "Body")).resolves.toBe(false);
		expect(executeFile).toHaveBeenCalledTimes(2);
	});

	it("handles synchronous process errors", async () => {
		const executeFile = vi.fn(() => {
			throw Object.assign(new Error("failed"), { code: "ENOENT" });
		});
		const notify = createDesktopNotifier({
			platform: "darwin",
			executeFile,
			terminalNotifierPath: null,
		});

		await expect(notify("Quota", "Body")).resolves.toBe(false);
	});

	it("skips unsupported platforms without launching a process", async () => {
		const executeFile = vi.fn();
		const notify = createDesktopNotifier({ platform: "linux", executeFile });

		await expect(notify("Quota", "Body")).resolves.toBe(false);
		expect(executeFile).not.toHaveBeenCalled();
	});
});

describe("desktop notification support", () => {
	it("supports only macOS", () => {
		expect(isDesktopNotificationSupported("darwin")).toBe(true);
		expect(isDesktopNotificationSupported("win32")).toBe(false);
		expect(isDesktopNotificationSupported("linux")).toBe(false);
	});

	it("resolves fixed Homebrew paths before inherited PATH entries", () => {
		const existing = new Set([
			"/opt/homebrew/bin/terminal-notifier",
			"/custom/bin/terminal-notifier",
		]);
		expect(resolveTerminalNotifierPath("/custom/bin", (path) => existing.has(path))).toBe(
			"/opt/homebrew/bin/terminal-notifier",
		);
	});
});
