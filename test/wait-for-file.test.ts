import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { waitForFile } from "./support/wait-for-file.js";

describe("waitForFile", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-wait-for-file-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("resolves immediately when the file already exists", async () => {
		// given
		const target = join(directory, "present");
		await writeFile(target, "", "utf8");

		// when + then
		await expect(waitForFile(target, 1_000)).resolves.toBeUndefined();
	});

	it("resolves when the file appears after the wait has started", async () => {
		// given
		const target = join(directory, "late");
		const waiting = waitForFile(target, 5_000);

		// when
		await delay(150);
		await writeFile(target, "", "utf8");

		// then
		await expect(waiting).resolves.toBeUndefined();
	});

	it("names the file it gave up on when the deadline passes", async () => {
		// given
		const target = join(directory, "never");

		// when + then: a bare test timeout would say only that the test was slow,
		// not which side of a handshake failed to arrive.
		await expect(waitForFile(target, 120, 20)).rejects.toThrow(
			`Timed out after 120ms waiting for ${target}`,
		);
	});

	it("propagates errors that are not a missing file instead of polling them away", async () => {
		// given a path the argument validator rejects on every platform. A path
		// under a regular file is not usable here: it reports ENOTDIR on Linux but
		// ENOENT on Windows, so it would be polled until the deadline and the
		// assertion would pass for the wrong reason.
		const target = `${join(directory, "embedded")}${String.fromCharCode(0)}nul`;

		// when
		const started = Date.now();
		const failure = await waitForFile(target, 10_000).catch((error: unknown) => error);

		// then the real error surfaces immediately, rather than being retried
		// until the deadline and reported as a timeout.
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain("Timed out");
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
