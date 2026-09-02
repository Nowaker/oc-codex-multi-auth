/**
 * Cross-worker mutex for the fixed OAuth callback port.
 *
 * Vitest runs test files in parallel workers, and more than one suite binds
 * port 1455 for real. The port cannot be parameterized away: `REDIRECT_URI` is
 * registered with the authorization server, so a suite that exercises the real
 * listener has to take the real port. Two such suites overlapping means one of
 * them sees `ready: false` and fails an assertion that only broke because a
 * sibling file happened to be scheduled alongside it.
 *
 * The lock is a directory, not `proper-lockfile`: `mkdir` is atomic on both
 * Windows and POSIX and carries no per-process bookkeeping, so it behaves the
 * same whether Vitest gives each file its own process or its own thread.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_DIR = join(tmpdir(), "oc-codex-multi-auth-oauth-port-1455.lock");

/** Long enough for the slowest port suite, short enough to self-heal. */
const STALE_MS = 60_000;
const ACQUIRE_TIMEOUT_MS = 60_000;
const POLL_MS = 25;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

async function lockAgeMs(): Promise<number | null> {
	try {
		const stats = await fs.stat(LOCK_DIR);
		return Date.now() - stats.mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Waits for exclusive use of port 1455 and returns the release function. Call
 * it from `beforeAll` and release in `afterAll`; the release is idempotent.
 */
export async function acquireOAuthPortLock(): Promise<() => Promise<void>> {
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	for (;;) {
		try {
			await fs.mkdir(LOCK_DIR);
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await fs.rm(LOCK_DIR, { recursive: true, force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A run that crashed mid-suite leaves the directory behind; reclaim
			// it rather than hanging every later run until someone deletes it.
			const age = await lockAgeMs();
			if (age !== null && age > STALE_MS) {
				await fs.rm(LOCK_DIR, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`Timed out waiting for the port-1455 test lock at ${LOCK_DIR}`,
				);
			}
			await sleep(POLL_MS);
		}
	}
}
