import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";

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
});
