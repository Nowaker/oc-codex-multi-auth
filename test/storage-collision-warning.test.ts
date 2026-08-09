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

		expect(warnMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		await loadAccounts();

		expect(warnMock).toHaveBeenCalledTimes(2);
	});
});
