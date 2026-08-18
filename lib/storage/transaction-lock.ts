import { lock } from "proper-lockfile";

import { StorageTransactionContentionError } from "../errors.js";
import { logWarn } from "../logger.js";
import { isWindowsLockError } from "./atomic-write.js";
import { withStorageLock } from "./state.js";

const TRANSACTION_LOCK_STALE_MS = 10_000;
const TRANSACTION_LOCK_UPDATE_MS = 2_000;
const TRANSACTION_LOCK_RETRIES = {
	retries: 5,
	factor: 1.5,
	minTimeout: 40,
	maxTimeout: 250,
	randomize: true,
} as const;

interface StorageTransactionLease {
	assertValid(): void;
}

export interface StorageTransactionOptions<Current, Persisted extends Current, Result> {
	readonly storagePath: string;
	readonly load: () => Promise<Current>;
	readonly persist: (storage: Persisted) => Promise<void>;
	readonly handler: (
		current: Current,
		persist: (storage: Persisted) => Promise<void>,
	) => Promise<Result>;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function isContentionError(error: unknown): boolean {
	if (hasErrorCode(error, "ELOCKED")) return true;
	return process.platform === "win32" && isWindowsLockError(error);
}

async function releaseQuietly(
	release: () => Promise<void>,
	lockPath: string,
): Promise<void> {
	try {
		await release();
	} catch (error) {
		logWarn(
			`Failed to release account storage transaction lease at ${lockPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export function getStorageTransactionLockPath(storagePath: string): string {
	return `${storagePath}.transaction.lock`;
}

async function withStorageTransactionLease<T>(
	storagePath: string,
	operation: (lease: StorageTransactionLease) => Promise<T>,
): Promise<T> {
	const lockPath = getStorageTransactionLockPath(storagePath);
	let compromised: Error | undefined;
	let release: () => Promise<void>;
	try {
		release = await lock(storagePath, {
			realpath: false,
			lockfilePath: lockPath,
			stale: TRANSACTION_LOCK_STALE_MS,
			update: TRANSACTION_LOCK_UPDATE_MS,
			retries: TRANSACTION_LOCK_RETRIES,
			onCompromised: (error: Error) => {
				compromised = error;
				logWarn(
					`Account storage transaction lease at ${lockPath} was compromised: ${error.message}`,
				);
			},
		});
	} catch (error) {
		if (isContentionError(error)) {
			throw new StorageTransactionContentionError(storagePath, error);
		}
		throw error;
	}

	try {
		return await operation({
			assertValid() {
				if (compromised) {
					throw new StorageTransactionContentionError(storagePath, compromised);
				}
			},
		});
	} finally {
		await releaseQuietly(release, lockPath);
	}
}

export function withStorageTransaction<Current, Persisted extends Current, Result>(
	options: StorageTransactionOptions<Current, Persisted, Result>,
): Promise<Result> {
	return withStorageLock(() =>
		withStorageTransactionLease(options.storagePath, async (lease) => {
			const current = await options.load();
			return options.handler(current, async (storage) => {
				lease.assertValid();
				await options.persist(storage);
			});
		}),
	);
}
