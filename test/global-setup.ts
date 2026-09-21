import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const MINTED_HOME_PREFIX = "oc-codex-multi-auth-test-home-";

/**
 * Remove the throwaway home `vitest.config.ts` minted for this run.
 *
 * Every run otherwise leaves one behind, and on a tmpfs `/tmp` they accumulate
 * until a run dies of ENOSPC.
 *
 * Three conditions gate the delete, because this is an unattended `rm -rf`:
 * the config must have minted the directory itself rather than been handed one
 * through `OC_CODEX_TEST_HOME`, the resolved path must still sit directly under
 * `tmpdir()`, and it must carry the prefix `mkdtempSync` was given. A path that
 * fails any of them is left alone rather than guessed at.
 */
export async function teardown(): Promise<void> {
	if (process.env.OC_CODEX_TEST_HOME_OWNED !== "1") return;

	const home = process.env.OC_CODEX_TEST_HOME;
	if (!home) return;

	const resolved = resolve(home);
	const expectedPrefix = resolve(tmpdir(), MINTED_HOME_PREFIX);
	if (resolved === expectedPrefix || !resolved.startsWith(expectedPrefix)) return;

	await rm(resolved, { recursive: true, force: true });
}
