import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
	ConfigLockContentionError,
	updateModelAccountPool,
} from "../lib/config.js";

describe("model account pool config lock contention", () => {
	const configPath = join(
		testHome,
		".opencode",
		"openai-codex-auth-config.json",
	);

	beforeEach(async () => {
		lockMock.mockReset();
		await fs.rm(testHome, { recursive: true, force: true });
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
			path: `${testHome}/.opencode/openai-codex-auth-config.json`,
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

	it("preserves malformed lock acquisition rejections", async () => {
		lockMock.mockRejectedValue(null);

		await expect(
			updateModelAccountPool("model", "set", ["one"]),
		).rejects.toBe(null);
	});
});
