import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

vi.mock('node:child_process', () => ({
	spawnSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
	default: {
		openSync: vi.fn(),
		writeSync: vi.fn(),
		closeSync: vi.fn(),
	},
}));

import { copyTextToClipboard, getClipboardCommands } from '../lib/auth/clipboard.js';

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedOpenSync = vi.mocked(fs.openSync);
const mockedWriteSync = vi.mocked(fs.writeSync);
const mockedCloseSync = vi.mocked(fs.closeSync);

const ESC = '\u001B';
const BEL = '\u0007';
const URL = 'https://auth.openai.com/oauth/authorize?state=abc&code_challenge=xyz';
const URL_B64 = Buffer.from(URL, 'utf8').toString('base64');

const spawnOk = () => ({ status: 0, error: undefined }) as unknown as ReturnType<typeof spawnSync>;
const spawnMissing = () =>
	({ status: null, error: new Error('ENOENT') }) as unknown as ReturnType<typeof spawnSync>;
const spawnRefused = () => ({ status: 1, error: undefined }) as unknown as ReturnType<typeof spawnSync>;

/** No host writer and no terminal: the baseline for isolating one transport. */
const noTransports = { TERM: 'dumb' } as NodeJS.ProcessEnv;

describe('Clipboard Module', () => {
	const originalIsTTY = process.stderr.isTTY;

	const setStderrTTY = (value: boolean | undefined) => {
		Object.defineProperty(process.stderr, 'isTTY', {
			value,
			configurable: true,
			writable: true,
		});
	};

	beforeEach(() => {
		// reset, not clear: a test that makes writeSync throw would otherwise
		// leave that implementation in place for every test after it
		vi.resetAllMocks();
		mockedSpawnSync.mockReturnValue(spawnMissing());
		mockedOpenSync.mockImplementation(() => {
			throw new Error('ENXIO');
		});
		setStderrTTY(false);
	});

	afterEach(() => {
		setStderrTTY(originalIsTTY);
	});

	describe('getClipboardCommands', () => {
		it('uses pbcopy on macOS', () => {
			expect(getClipboardCommands('darwin', {})).toEqual([{ command: 'pbcopy', args: [] }]);
		});

		it('uses clip on Windows', () => {
			expect(getClipboardCommands('win32', {})).toEqual([{ command: 'clip', args: [] }]);
		});

		it('prefers wl-copy when a Wayland display is present', () => {
			const commands = getClipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' });
			expect(commands.map((entry) => entry.command)).toEqual(['wl-copy', 'xclip', 'xsel']);
		});

		it('prefers the X11 writers when no Wayland display is present', () => {
			const commands = getClipboardCommands('linux', {});
			expect(commands.map((entry) => entry.command)).toEqual(['xclip', 'xsel', 'wl-copy']);
		});

		it('treats an unknown platform as Linux', () => {
			const commands = getClipboardCommands('freebsd', {});
			expect(commands.map((entry) => entry.command)).toEqual(['xclip', 'xsel', 'wl-copy']);
		});

		it('selects the clipboard selection explicitly for xclip and xsel', () => {
			const commands = getClipboardCommands('linux', {});
			expect(commands[0]).toEqual({ command: 'xclip', args: ['-selection', 'clipboard'] });
			expect(commands[1]).toEqual({ command: 'xsel', args: ['--clipboard', '--input'] });
		});
	});

	describe('host clipboard', () => {
		it('pipes the text to the writer without a shell', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			const result = copyTextToClipboard(URL, { platform: 'darwin', env: noTransports });

			expect(mockedSpawnSync).toHaveBeenCalledWith(
				'pbcopy',
				[],
				expect.objectContaining({ input: URL, shell: false }),
			);
			expect(result.scopes).toEqual(['host']);
			expect(result.copied).toBe(true);
		});

		it('discards writer output so a forked selection owner cannot block the copy', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			copyTextToClipboard(URL, { platform: 'darwin', env: noTransports });

			expect(mockedSpawnSync).toHaveBeenCalledWith(
				'pbcopy',
				[],
				expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] }),
			);
		});

		it('bounds the writer with a timeout', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			copyTextToClipboard(URL, { platform: 'darwin', env: noTransports });

			const options = mockedSpawnSync.mock.calls[0][2] as { timeout: number };
			expect(options.timeout).toBeGreaterThan(0);
		});

		it('falls through to the next writer when one is not installed', () => {
			mockedSpawnSync.mockImplementationOnce(spawnMissing).mockImplementationOnce(spawnOk);

			const result = copyTextToClipboard(URL, { platform: 'linux', env: noTransports });

			expect(mockedSpawnSync.mock.calls.map((call) => call[0])).toEqual(['xclip', 'xsel']);
			expect(result.scopes).toEqual(['host']);
		});

		it('falls through when a writer runs but refuses, as wl-copy does under X11', () => {
			mockedSpawnSync
				.mockImplementationOnce(spawnRefused)
				.mockImplementationOnce(spawnRefused)
				.mockImplementationOnce(spawnOk);

			const result = copyTextToClipboard(URL, { platform: 'linux', env: noTransports });

			expect(mockedSpawnSync.mock.calls.map((call) => call[0])).toEqual([
				'xclip',
				'xsel',
				'wl-copy',
			]);
			expect(result.copied).toBe(true);
		});

		it('stops at the first writer that accepts the text', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			copyTextToClipboard(URL, { platform: 'linux', env: noTransports });

			expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
		});

		it('names the writers it looked for when none are available', () => {
			const result = copyTextToClipboard(URL, { platform: 'linux', env: noTransports });

			expect(result.copied).toBe(false);
			expect(result.message).toContain('xclip');
			expect(result.message).toContain('xsel');
			expect(result.message).toContain('wl-copy');
		});

		it('does not throw when spawnSync itself throws', () => {
			mockedSpawnSync.mockImplementation(() => {
				throw new Error('spawn exploded');
			});

			const result = copyTextToClipboard(URL, { platform: 'linux', env: noTransports });

			expect(result.copied).toBe(false);
		});
	});

	describe('terminal clipboard (OSC 52)', () => {
		it('writes a base64 OSC 52 payload to the controlling terminal', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			const result = copyTextToClipboard(URL, {
				platform: 'linux',
				env: { TERM: 'xterm-256color' },
			});

			expect(mockedOpenSync).toHaveBeenCalledWith('/dev/tty', 'w');
			expect(mockedWriteSync).toHaveBeenCalledWith(7, `${ESC}]52;c;${URL_B64}${BEL}`);
			expect(result.scopes).toEqual(['terminal']);
		});

		it('closes the terminal descriptor after writing', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'xterm' } });

			expect(mockedCloseSync).toHaveBeenCalledWith(7);
		});

		it('closes the descriptor even when the write fails', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);
			mockedWriteSync.mockImplementation(() => {
				throw new Error('EIO');
			});

			const result = copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'xterm' } });

			expect(mockedCloseSync).toHaveBeenCalledWith(7);
			expect(result.scopes).not.toContain('terminal');
		});

		it('wraps the sequence for tmux and doubles the payload escapes', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			copyTextToClipboard(URL, {
				platform: 'linux',
				env: { TERM: 'screen-256color', TMUX: '/tmp/tmux-1000/default,123,0' },
			});

			expect(mockedWriteSync).toHaveBeenCalledWith(
				7,
				`${ESC}Ptmux;${ESC}${ESC}]52;c;${URL_B64}${BEL}${ESC}\\`,
			);
		});

		it('falls back to stderr when there is no controlling terminal', () => {
			setStderrTTY(true);
			const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

			const result = copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'xterm' } });

			expect(write).toHaveBeenCalledWith(`${ESC}]52;c;${URL_B64}${BEL}`);
			expect(result.scopes).toEqual(['terminal']);
			write.mockRestore();
		});

		it('does not write to a stderr that is not a terminal', () => {
			setStderrTTY(false);
			const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

			const result = copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'xterm' } });

			expect(write).not.toHaveBeenCalled();
			expect(result.scopes).toEqual([]);
			write.mockRestore();
		});

		it('never opens /dev/tty on Windows', () => {
			setStderrTTY(true);
			const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

			copyTextToClipboard(URL, { platform: 'win32', env: { TERM: 'xterm' } });

			expect(mockedOpenSync).not.toHaveBeenCalled();
			expect(write).toHaveBeenCalled();
			write.mockRestore();
		});

		it('skips a terminal that promises no escape handling', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'dumb' } });

			expect(mockedWriteSync).not.toHaveBeenCalled();
		});

		it('skips when TERM is unset', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			copyTextToClipboard(URL, { platform: 'linux', env: {} });

			expect(mockedWriteSync).not.toHaveBeenCalled();
		});

		it('skips a payload larger than terminals reliably accept', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			const result = copyTextToClipboard('x'.repeat(40_000), {
				platform: 'linux',
				env: { TERM: 'xterm' },
			});

			expect(mockedWriteSync).not.toHaveBeenCalled();
			expect(result.copied).toBe(false);
		});
	});

	describe('outcome reporting', () => {
		it('reports both transports when both succeed', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			const result = copyTextToClipboard(URL, {
				platform: 'linux',
				env: { TERM: 'xterm' },
			});

			expect(result.scopes).toEqual(['host', 'terminal']);
			expect(result.message).toContain('this host');
			expect(result.message).toContain("terminal's clipboard");
		});

		it('reports a plain local copy without qualification', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			const result = copyTextToClipboard(URL, { platform: 'darwin', env: noTransports });

			expect(result.message).toBe('URL copied to the clipboard.');
		});

		it('warns that a host-only copy may be the wrong machine over SSH', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			const result = copyTextToClipboard(URL, {
				platform: 'linux',
				env: { TERM: 'dumb', SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22' },
			});

			expect(result.scopes).toEqual(['host']);
			expect(result.message).toContain('remote session');
		});

		it('reports a terminal-only copy as reaching the terminal', () => {
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			const result = copyTextToClipboard(URL, {
				platform: 'linux',
				env: { TERM: 'xterm' },
			});

			expect(result.scopes).toEqual(['terminal']);
			expect(result.message).toBe("URL sent to your terminal's clipboard.");
		});

		it('never puts the copied text in the message', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			const result = copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'xterm' } });

			expect(result.message).not.toContain(URL);
		});
	});

	describe('opting out', () => {
		it('attempts nothing when CODEX_AUTH_CLIPBOARD is 0', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());
			mockedOpenSync.mockReturnValue(7 as unknown as number);

			const result = copyTextToClipboard(URL, {
				platform: 'linux',
				env: { TERM: 'xterm', CODEX_AUTH_CLIPBOARD: '0' },
			});

			expect(mockedSpawnSync).not.toHaveBeenCalled();
			expect(mockedWriteSync).not.toHaveBeenCalled();
			expect(result).toEqual({ copied: false, scopes: [], message: '' });
		});

		it('stays enabled for any other value', () => {
			mockedSpawnSync.mockReturnValue(spawnOk());

			const result = copyTextToClipboard(URL, {
				platform: 'darwin',
				env: { TERM: 'dumb', CODEX_AUTH_CLIPBOARD: '1' },
			});

			expect(result.copied).toBe(true);
		});

		it('attempts nothing for empty text', () => {
			const result = copyTextToClipboard('', { platform: 'linux', env: { TERM: 'xterm' } });

			expect(mockedSpawnSync).not.toHaveBeenCalled();
			expect(result).toEqual({ copied: false, scopes: [], message: '' });
		});
	});

	it('still tries the terminal when the host transport throws', () => {
		mockedSpawnSync.mockImplementation(() => {
			throw new Error('spawn exploded');
		});
		mockedOpenSync.mockReturnValue(7 as unknown as number);

		const result = copyTextToClipboard(URL, { platform: 'linux', env: { TERM: 'xterm' } });

		expect(result.scopes).toEqual(['terminal']);
	});
});
