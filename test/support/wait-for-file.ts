import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Wait until `filePath` exists.
 *
 * This polls on purpose. The previous implementation checked for the file and
 * then started iterating an `fsPromises.watch()` async generator, but that
 * generator is lazy: nothing is observed until the first iteration, so a file
 * created between the existence check and the loop produced no event and the
 * wait never woke. Measured on Node 20: the multiprocess refresh handshake lost
 * that race in 6 of 10 runs, and in 3 of 3 with a 200ms sleep inserted into the
 * window. Polling removes the ordering assumption entirely, and the handshake
 * files it waits on appear in milliseconds.
 *
 * @param filePath - File whose creation ends the wait
 * @param timeoutMs - How long to wait before failing
 * @param intervalMs - Delay between existence checks
 */
export async function waitForFile(
	filePath: string,
	timeoutMs = 15_000,
	intervalMs = 20,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await access(filePath);
			return;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		// Report the file we gave up on. A bare test timeout says only that the
		// test was slow, not which side of the handshake never arrived.
		if (Date.now() >= deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${filePath}`);
		}
		await delay(intervalMs);
	}
}
