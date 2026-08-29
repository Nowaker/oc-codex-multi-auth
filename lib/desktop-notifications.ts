import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { logDebug, logWarn } from "./logger.js";

const DELIVERY_TIMEOUT_MS = 10_000;
const OPENCODE_BUNDLE_ID = "ai.opencode.desktop";
const QUOTA_NOTIFICATION_GROUP = "oc-codex-multi-auth-quota";
const TERMINAL_NOTIFIER_PATHS = [
	"/opt/homebrew/bin/terminal-notifier",
	"/usr/local/bin/terminal-notifier",
] as const;
const MACOS_NOTIFICATION_SCRIPT = `
function run(argv) {
	const app = Application.currentApplication();
	app.includeStandardAdditions = true;
	app.displayNotification(argv[1], { withTitle: argv[0] });
}
`.trim();

type NotificationCallback = (error: Error | null) => void;
type ExecuteFile = (
	file: string,
	args: string[],
	options: { timeout: number; windowsHide: boolean },
	callback: NotificationCallback,
) => unknown;

type ExecutionResult = { success: true } | { success: false; error: unknown };

export type DesktopNotifier = (title: string, message: string) => Promise<boolean>;

const executeFile: ExecuteFile = (file, args, options, callback) => {
	return execFile(file, args, options, (error) => callback(error));
};

function getErrorCode(error: unknown): string {
	if (typeof error !== "object" || error === null) return "unknown";
	const code = (error as Record<string, unknown>).code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "unknown";
}

export function resolveTerminalNotifierPath(
	pathValue = process.env.PATH,
	pathExists: (path: string) => boolean = existsSync,
): string | undefined {
	const candidates = [
		...TERMINAL_NOTIFIER_PATHS,
		...(pathValue?.split(delimiter).filter(Boolean).map((directory) => join(directory, "terminal-notifier")) ?? []),
	];
	return Array.from(new Set(candidates)).find(pathExists);
}

function executeNotification(
	run: ExecuteFile,
	file: string,
	args: string[],
): Promise<ExecutionResult> {
	return new Promise((resolve) => {
		try {
			run(file, args, { timeout: DELIVERY_TIMEOUT_MS, windowsHide: true }, (error) => {
				if (error) {
					resolve({ success: false, error });
					return;
				}
				resolve({ success: true });
			});
		} catch (error) {
			resolve({ success: false, error });
		}
	});
}

export function isDesktopNotificationSupported(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "darwin";
}

export function createDesktopNotifier(options?: {
	platform?: NodeJS.Platform;
	executeFile?: ExecuteFile;
	terminalNotifierPath?: string | null;
}): DesktopNotifier {
	const platform = options?.platform ?? process.platform;
	const run = options?.executeFile ?? executeFile;
	const terminalNotifierPath = options?.terminalNotifierPath === undefined
		? resolveTerminalNotifierPath()
		: options.terminalNotifierPath ?? undefined;
	let warningLogged = false;

	const warnOnce = (message: string): void => {
		if (warningLogged) return;
		warningLogged = true;
		logWarn(message);
	};

	return async (title, message) => {
		if (!isDesktopNotificationSupported(platform)) {
			warnOnce("Desktop quota notifications are supported only on macOS.");
			return false;
		}

		if (terminalNotifierPath) {
			const branded = await executeNotification(run, terminalNotifierPath, [
				"-title", title,
				"-message", message,
				"-sender", OPENCODE_BUNDLE_ID,
				"-activate", OPENCODE_BUNDLE_ID,
				"-group", QUOTA_NOTIFICATION_GROUP,
			]);
			if (branded.success) return true;
			logDebug(
				`OpenCode-branded quota notification failed with code ${getErrorCode(branded.error)}; falling back to osascript`,
			);
		}

		const fallback = await executeNotification(
			run,
			"/usr/bin/osascript",
			["-l", "JavaScript", "-e", MACOS_NOTIFICATION_SCRIPT, title, message],
		);
		if (fallback.success) return true;
		logDebug(`Desktop quota notification failed with code ${getErrorCode(fallback.error)}`);
		warnOnce("Desktop quota notification delivery failed on macOS.");
		return false;
	};
}

export const sendDesktopNotification = createDesktopNotifier();
