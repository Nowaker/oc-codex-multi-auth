import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acquireOrDetectLockMock, warnMock } = vi.hoisted(() => ({
	acquireOrDetectLockMock: vi.fn(),
	warnMock: vi.fn(),
}));

vi.mock("../lib/logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/logger.js")>();
	return {
		...actual,
		createLogger: () => ({
			debug: vi.fn(),
			info: vi.fn(),
			warn: warnMock,
			error: vi.fn(),
			time: vi.fn(),
			timeEnd: vi.fn(),
		}),
	};
});
vi.mock("../lib/storage/worktree-lock.js", () => ({
	acquireOrDetectLock: acquireOrDetectLockMock,
}));

import {
	__resetCollisionWarningThrottleForTests,
	loadAccounts,
} from "../lib/storage/load-save.js";
import { setStoragePathDirect } from "../lib/storage/state.js";

const COLLISION_MESSAGE = "Multi-worktree collision detected on account storage";

/**
 * loadAccounts() warns from several unrelated sites (schema validation, global
 * fallback load failures). Counting every warn would fail this suite the moment
 * any of them fires, so only the collision warning is counted.
 */
function collisionWarnCount(): number {
	return warnMock.mock.calls.filter((call) => call[0] === COLLISION_MESSAGE)
		.length;
}

describe("account storage collision warning throttle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		warnMock.mockReset();
		acquireOrDetectLockMock.mockReset();
		acquireOrDetectLockMock.mockResolvedValue({
			acquired: false,
			foreign: {
				pid: 1234,
				hostname: "other-host",
				cwd: "/tmp/other-worktree",
				startedAt: new Date(0).toISOString(),
				lastActive: new Date(0).toISOString(),
			},
		});
		setStoragePathDirect("/tmp/oc-codex-collision-warning/accounts.json");
		__resetCollisionWarningThrottleForTests();
	});

	afterEach(() => {
		setStoragePathDirect(null);
		vi.useRealTimers();
	});

	it("warns once per throttle window", async () => {
		await loadAccounts();
		await loadAccounts();

		expect(collisionWarnCount()).toBe(1);

		vi.advanceTimersByTime(60_000);
		await loadAccounts();

		expect(collisionWarnCount()).toBe(2);
	});

	it("warns separately for distinct storage paths", async () => {
		await loadAccounts();
		setStoragePathDirect(
			"/tmp/oc-codex-collision-warning-other/accounts.json",
		);

		await loadAccounts();

		expect(collisionWarnCount()).toBe(2);
	});

	it("keeps throttling when the foreign holder restarts", async () => {
		// The throttle used to key on the foreign pid and startedAt, so a peer
		// that restarted - or a series of short-lived sessions - produced a fresh
		// identity on every probe and defeated the throttle entirely.
		await loadAccounts();
		for (const [pid, startedAt] of [
			[4321, 1],
			[5678, 2],
			[9012, 3],
		] as const) {
			acquireOrDetectLockMock.mockResolvedValue({
				acquired: false,
				foreign: {
					pid,
					hostname: "other-host",
					cwd: "/tmp/other-worktree",
					startedAt: new Date(startedAt).toISOString(),
					lastActive: new Date(startedAt).toISOString(),
				},
			});
			await loadAccounts();
		}

		expect(collisionWarnCount()).toBe(1);
	});

	it("does not record a warning the logger failed to emit", async () => {
		// shouldWarnForCollision used to record the warn before the caller emitted
		// it, so a throwing logger silently suppressed the next 60s of collisions.
		warnMock.mockImplementationOnce(() => {
			throw new Error("transport down");
		});

		await loadAccounts();
		await loadAccounts();

		expect(collisionWarnCount()).toBe(2);
	});

	it("bounds remembered collision identities", async () => {
		// Identities are (storage path, host) pairs, so distinct paths are what
		// fills the map - a single peer cycling pids no longer can.
		const pathFor = (index: number) =>
			`/tmp/oc-codex-collision-warning-${index}/accounts.json`;
		for (let index = 1; index <= 129; index += 1) {
			setStoragePathDirect(pathFor(index));
			await loadAccounts();
		}

		// The first identity has been evicted, so it warns again.
		setStoragePathDirect(pathFor(1));
		await loadAccounts();

		expect(collisionWarnCount()).toBe(130);
	});
});
