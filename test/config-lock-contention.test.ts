import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

const { lockMock } = vi.hoisted(() => ({ lockMock: vi.fn() }));
const testHome = vi.hoisted(
	() => `/tmp/oc-codex-config-lock-contention-${process.pid}`,
);

vi.mock("proper-lockfile", () => ({ lock: lockMock }));
vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => testHome };
});

import {
	__resetLockContentionStateForTests,
	updateModelAccountPool,
} from "../lib/config.js";
import {
	CodexError,
	ConfigError,
	ConfigLockContentionError,
} from "../lib/errors.js";

describe("model account pool config lock contention", () => {
	const configPath = join(
		testHome,
		".opencode",
		"openai-codex-auth-config.json",
	);

	const realPlatform = process.platform;

	/**
	 * The Windows branch of the contention classifier has to be exercised from
	 * Linux CI too, so the platform is stubbed rather than the test skipped.
	 */
	function stubPlatform(platform: NodeJS.Platform): void {
		Object.defineProperty(process, "platform", {
			value: platform,
			configurable: true,
		});
	}

	beforeEach(async () => {
		lockMock.mockReset();
		__resetLockContentionStateForTests();
		await fs.rm(testHome, { recursive: true, force: true });
	});

	afterEach(() => {
		stubPlatform(realPlatform);
	});

	afterAll(async () => {
		await fs.rm(testHome, { recursive: true, force: true });
	});

	it("classifies only exhausted proper-lockfile acquisition", async () => {
		const cause = Object.assign(new Error("already held"), { code: "ELOCKED" });
		lockMock.mockRejectedValue(cause);

		const pending = updateModelAccountPool("model", "set", ["one"]);

		await expect(pending).rejects.toMatchObject({
			name: "ConfigLockContentionError",
			code: "CODEX_CONFIG_LOCK_CONTENTION",
			path: configPath,
			cause,
		});
		await expect(pending).rejects.toBeInstanceOf(ConfigLockContentionError);
	});

	it("preserves non-contention lock acquisition failures", async () => {
		const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
		lockMock.mockRejectedValue(cause);

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toBe(cause);
	});

	it("revalidates a non-dry no-op after acquiring the lock", async () => {
		await fs.mkdir(dirname(configPath), { recursive: true });
		await fs.writeFile(
			configPath,
			JSON.stringify({ modelAccountPools: { model: ["one"] } }),
			"utf8",
		);
		lockMock.mockImplementationOnce(async () => {
			await fs.writeFile(
				configPath,
				JSON.stringify({ modelAccountPools: { model: [] } }),
				"utf8",
			);
			return async () => {};
		});

		const result = await updateModelAccountPool("model", "set", ["one"]);
		const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
			modelAccountPools: Record<string, string[]>;
		};

		expect(lockMock).toHaveBeenCalledTimes(1);
		expect(result.changed).toBe(true);
		expect(result.previousAccountIds).toEqual([]);
		expect(persisted.modelAccountPools.model).toEqual(["one"]);
	});

	it("keeps a successful mutation when releasing the lock fails", async () => {
		// proper-lockfile rejects release() with ERELEASED when the lock was
		// compromised mid-mutation, and removeLock propagates any non-ENOENT
		// rmdir error. Before the fix that rejection escaped from the finally
		// block and replaced the return value, so a change that had already
		// reached disk was reported as a fatal lock error.
		const releaseError = Object.assign(new Error("lock is already released"), {
			code: "ERELEASED",
		});
		lockMock.mockResolvedValueOnce(async () => {
			throw releaseError;
		});

		const result = await updateModelAccountPool("model", "set", ["one"]);
		const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
			modelAccountPools: Record<string, string[]>;
		};

		expect(result.changed).toBe(true);
		expect(persisted.modelAccountPools.model).toEqual(["one"]);
	});

	it("installs an onCompromised handler that cannot kill the process", async () => {
		// The proper-lockfile default rethrows from inside an fs callback, and
		// nothing in this process installs an uncaughtException handler.
		lockMock.mockResolvedValueOnce(async () => {});

		await updateModelAccountPool("model", "set", ["one"]);

		const options = lockMock.mock.calls[0]?.[1] as {
			onCompromised?: (error: Error) => void;
		};
		expect(typeof options?.onCompromised).toBe("function");
		expect(() =>
			options.onCompromised?.(
				Object.assign(new Error("lock compromised"), {
					code: "ECOMPROMISED",
				}),
			),
		).not.toThrow();
	});

	it("classifies Windows lock-directory failures as contention", async () => {
		// On win32 a lock directory held open by another process (or by an
		// antivirus scanner or the indexer) surfaces as EPERM/EBUSY, never
		// EEXIST, so operation.mainError() is not ELOCKED and the degrade path
		// used to be skipped entirely.
		stubPlatform("win32");
		const cause = Object.assign(new Error("operation not permitted"), {
			code: "EPERM",
		});
		lockMock.mockRejectedValue(cause);

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toBeInstanceOf(ConfigLockContentionError);
	});

	it("keeps EPERM fatal off Windows", async () => {
		stubPlatform("linux");
		const cause = Object.assign(new Error("operation not permitted"), {
			code: "EPERM",
		});
		lockMock.mockRejectedValue(cause);

		await expect(updateModelAccountPool("model", "set", ["one"])).rejects.toBe(
			cause,
		);
	});

	it("previews without acquiring the configuration lock", async () => {
		// The one behaviour this branch actually changes for non-error callers:
		// a dry run no longer contends for the config lock at all.
		const result = await updateModelAccountPool("model", "set", ["one"], {
			dryRun: true,
		});

		expect(lockMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({ dryRun: true, changed: true });
	});

	// ---------- finding 5: N contended callers must not cost N budgets ----------
	it("drops to a probe budget once contention is established", async () => {
		const cause = Object.assign(new Error("already held"), { code: "ELOCKED" });
		lockMock.mockRejectedValue(cause);

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toBeInstanceOf(ConfigLockContentionError);
		await expect(
			updateModelAccountPool("model", "set", ["two"]),
		).rejects.toBeInstanceOf(ConfigLockContentionError);

		const first = lockMock.mock.calls[0]?.[1] as { retries: { retries: number } };
		const second = lockMock.mock.calls[1]?.[1] as { retries: { retries: number } };

		expect(first.retries.retries).toBe(20);
		// Every mutation is serialized behind the in-process queue, so without
		// this the second caller would wait out another full budget against a
		// holder the first caller already proved is external.
		expect(second.retries.retries).toBeLessThan(first.retries.retries);
	});

	it("restores the full retry budget after a successful acquisition", async () => {
		const cause = Object.assign(new Error("already held"), { code: "ELOCKED" });
		lockMock.mockRejectedValueOnce(cause);
		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toBeInstanceOf(ConfigLockContentionError);

		lockMock.mockResolvedValueOnce(async () => {});
		await updateModelAccountPool("model", "set", ["two"]);

		lockMock.mockRejectedValueOnce(cause);
		await expect(
			updateModelAccountPool("model", "set", ["three"]),
		).rejects.toBeInstanceOf(ConfigLockContentionError);

		const third = lockMock.mock.calls[2]?.[1] as { retries: { retries: number } };
		expect(third.retries.retries).toBe(20);
	});

	// ---------- finding 11: transient, not "your configuration is wrong" ----------
	it("is a transient error rather than a configuration error", () => {
		const error = new ConfigLockContentionError("/tmp/config.json");

		expect(error).toBeInstanceOf(CodexError);
		expect(error.retryable).toBe(true);
		// ConfigError means the user must go fix something; a handler catching it
		// to stop retrying would give exactly the wrong advice here.
		expect(error).not.toBeInstanceOf(ConfigError);
	});

	it("preserves malformed lock acquisition rejections", async () => {
		lockMock.mockRejectedValue(null);

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toBe(null);
	});
});
