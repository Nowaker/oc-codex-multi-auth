/**
 * Clipboard delivery for the authorization URL.
 *
 * Every login method that hands a URL to a human has the same last mile: the
 * URL has to reach a browser. Two independent transports are attempted, and
 * they are complementary rather than redundant:
 *
 * - The HOST clipboard (`pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip`) puts the
 *   URL on the clipboard of the machine this process runs on. That is the right
 *   target for a local login and the wrong one for an SSH session, where the
 *   browser lives on the operator's laptop.
 * - OSC 52 writes the URL to the CONTROLLING TERMINAL, which forwards it to the
 *   clipboard of whichever machine the terminal emulator runs on. That is the
 *   remote case: over SSH the sequence travels back down the same connection
 *   the operator is typing into, so the URL lands where the browser actually
 *   is. It is fire-and-forget by design - the terminal sends no reply - so a
 *   successful write means "the sequence was emitted", never "the clipboard was
 *   updated". Terminals that do not implement OSC 52 silently drop it.
 *
 * Neither transport is load-bearing. A login is still completable by reading
 * the URL off the screen, so every failure here is reported in one line and
 * never raised: a missing `xclip` must not be what stops someone signing in.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Which clipboard the URL reached. */
export type ClipboardScope = "host" | "terminal";

export interface ClipboardCopyResult {
	/** True when at least one transport accepted the text. */
	copied: boolean;
	/** Transports that succeeded, in attempt order. */
	scopes: ClipboardScope[];
	/**
	 * One line for the user. Never contains the copied text, so it is safe to
	 * append to instructions or log verbatim.
	 */
	message: string;
}

interface ClipboardCommand {
	command: string;
	args: string[];
}

/**
 * OSC 52 payloads are capped by the terminal, and an over-long one is not
 * rejected cleanly - it is truncated into a corrupt clipboard entry or printed
 * as literal garbage. xterm's default budget is just under 75 KB, so stop well
 * before any terminal starts improvising. An authorization URL is ~400 bytes;
 * this only ever guards against a caller passing something unexpected.
 */
const MAX_OSC52_PAYLOAD_BYTES = 32_768;

/** Host clipboard writers race a hung selection owner, not a slow copy. */
const CLIPBOARD_COMMAND_TIMEOUT_MS = 2_000;

/**
 * Host clipboard writers for the current platform, in preference order.
 *
 * On Linux the display server decides the winner: `wl-copy` cannot reach an X11
 * selection and `xclip`/`xsel` cannot reach a Wayland one. Both orderings are
 * self-correcting because a tool that cannot connect exits non-zero and the
 * next candidate runs - `WAYLAND_DISPLAY` only decides which one pays that cost
 * first.
 */
export function getClipboardCommands(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
	if (platform === "darwin") {
		return [{ command: "pbcopy", args: [] }];
	}
	if (platform === "win32") {
		return [{ command: "clip", args: [] }];
	}

	const wayland: ClipboardCommand = { command: "wl-copy", args: [] };
	const x11: ClipboardCommand[] = [
		{ command: "xclip", args: ["-selection", "clipboard"] },
		{ command: "xsel", args: ["--clipboard", "--input"] },
	];
	return env.WAYLAND_DISPLAY ? [wayland, ...x11] : [...x11, wayland];
}

/**
 * Writes `text` to the host clipboard through the first writer that accepts it.
 *
 * stdout and stderr are discarded rather than inherited because `xclip` and
 * `wl-copy` fork a background process to own the selection for as long as it
 * lives. An inherited pipe would stay open in that child and `spawnSync` would
 * block on EOF until the user next copied something else.
 */
function copyToHostClipboard(
	text: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): { copied: boolean; attempted: string[] } {
	const commands = getClipboardCommands(platform, env);
	const attempted: string[] = [];

	for (const { command, args } of commands) {
		attempted.push(command);
		try {
			const result = spawnSync(command, args, {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
				timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
				shell: false,
			});
			// `error` covers both a writer that is not installed (ENOENT) and one
			// that hung past the timeout; `status` covers one that ran and refused,
			// which is what an X11-only `wl-copy` does.
			if (!result.error && result.status === 0) {
				return { copied: true, attempted };
			}
		} catch {
			// spawnSync itself refused - treat exactly like a failed writer
		}
	}

	return { copied: false, attempted };
}

/**
 * Wraps an OSC 52 sequence for the multiplexer it has to travel through.
 *
 * tmux does not forward unrecognized sequences; it needs its DCS passthrough,
 * inside which every ESC of the payload must be doubled or tmux ends the
 * passthrough on the payload's own ESC. Requires `allow-passthrough on` in tmux
 * 3.3+, which cannot be detected from here - an unconfigured tmux drops the
 * sequence, which is the same silent no-op as a terminal without OSC 52.
 */
function wrapForMultiplexer(sequence: string, env: NodeJS.ProcessEnv): string {
	if (!env.TMUX) return sequence;
	return `\u001BPtmux;${sequence.replace(/\u001B/g, "\u001B\u001B")}\u001B\\`;
}

/**
 * Emits the sequence on the controlling terminal.
 *
 * `/dev/tty` is tried first and stderr only as a fallback: the plugin's streams
 * may be piped into OpenCode rather than attached to the terminal, and a
 * sequence written into a pipe reaches a log file instead of a clipboard.
 * Opening the controlling terminal directly sidesteps that entirely.
 */
function writeToTerminal(sequence: string, platform: NodeJS.Platform): boolean {
	if (platform !== "win32") {
		let fd: number | undefined;
		try {
			fd = fs.openSync("/dev/tty", "w");
			fs.writeSync(fd, sequence);
			return true;
		} catch {
			// no controlling terminal: a service unit, a detached process
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch {
					// a descriptor that will not close must not fail the copy
				}
			}
		}
	}

	try {
		if (process.stderr?.isTTY) {
			process.stderr.write(sequence);
			return true;
		}
	} catch {
		// a stream that refuses the write is just another unavailable transport
	}
	return false;
}

/**
 * Sends `text` to the terminal's clipboard via OSC 52. Returns whether the
 * sequence was emitted, which is as much as this protocol can ever report.
 */
function copyViaTerminal(
	text: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): boolean {
	// TERM=dumb promises no escape-sequence handling at all, so the sequence
	// would be printed as literal text across the user's screen.
	if (!env.TERM || env.TERM === "dumb") return false;

	const payload = Buffer.from(text, "utf8").toString("base64");
	if (payload.length > MAX_OSC52_PAYLOAD_BYTES) return false;

	return writeToTerminal(
		wrapForMultiplexer(`\u001B]52;c;${payload}\u0007`, env),
		platform,
	);
}

function describeOutcome(
	scopes: ClipboardScope[],
	attempted: string[],
	env: NodeJS.ProcessEnv,
): string {
	const host = scopes.includes("host");
	const terminal = scopes.includes("terminal");
	const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);

	if (host && terminal) {
		return "URL copied to the clipboard on this host and sent to your terminal's clipboard.";
	}
	if (terminal) {
		return "URL sent to your terminal's clipboard.";
	}
	if (host) {
		return remote
			? "URL copied to the clipboard on this host (remote session, so it may not be the machine your browser is on)."
			: "URL copied to the clipboard.";
	}

	const writers = attempted.length > 0 ? attempted.join(", ") : "none";
	return `Could not copy the URL to any clipboard (no ${writers} available, and the terminal did not accept a clipboard write).`;
}

/**
 * Copies `text` to every clipboard transport that will take it.
 *
 * Both transports are attempted independently, because succeeding on one says
 * nothing about the other: a local desktop session usually gets the host
 * clipboard and no OSC 52, and an SSH session with no X display usually gets
 * the reverse. Never throws and never reports a partial success as a failure.
 *
 * Set `CODEX_AUTH_CLIPBOARD=0` to opt out entirely - for anyone who would
 * rather keep their clipboard, or whose terminal renders OSC 52 as garbage.
 */
export function copyTextToClipboard(
	text: string,
	options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
): ClipboardCopyResult {
	const platform = options?.platform ?? process.platform;
	const env = options?.env ?? process.env;

	if (env.CODEX_AUTH_CLIPBOARD === "0") {
		return { copied: false, scopes: [], message: "" };
	}
	if (!text) {
		return { copied: false, scopes: [], message: "" };
	}

	const scopes: ClipboardScope[] = [];
	let attempted: string[] = [];

	try {
		const host = copyToHostClipboard(text, platform, env);
		attempted = host.attempted;
		if (host.copied) scopes.push("host");
	} catch {
		// a broken host transport must not skip the terminal transport
	}

	try {
		if (copyViaTerminal(text, platform, env)) scopes.push("terminal");
	} catch {
		// see above: the whole helper is best-effort
	}

	return {
		copied: scopes.length > 0,
		scopes,
		message: describeOutcome(scopes, attempted, env),
	};
}
