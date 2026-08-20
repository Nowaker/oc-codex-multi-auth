import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

import { queuedRefresh } from "../lib/refresh-queue.js";
import {
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	withAccountStorageTransaction,
} from "../lib/storage.js";
import { refreshAndPersistAccount } from "../lib/tools/refresh-account.js";

const identity = {
	organizationId: "organization-1",
	accountId: "workspace-1",
	accountUserId: "member-1",
	refreshToken: "refresh-0",
} as const;

describe("persisted refresh coordination", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-refresh-coordination-"));
		setStoragePathDirect(join(directory, "accounts.json"));
		vi.mocked(queuedRefresh).mockReset().mockRejectedValue(
			new Error("Unexpected OAuth exchange"),
		);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await rm(directory, { recursive: true, force: true });
	});

	async function seedAccount(overrides: Readonly<Record<string, unknown>> = {}): Promise<void> {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					...identity,
					accessToken: "access-0",
					expiresAt: 0,
					addedAt: 1,
					lastUsed: 1,
					...overrides,
				},
			],
		});
	}

	it("adopts a rotation already committed for the same stable workspace identity", async () => {
		// given
		await seedAccount({
			refreshToken: "refresh-1",
			accessToken: "access-1",
			expiresAt: 2_000_000_000_000,
			tokenRotatedAt: 10,
		});

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then
		expect(outcome).toMatchObject({
			status: "refreshed",
			result: {
				refreshToken: "refresh-1",
				accessToken: "access-1",
				rotatedAt: 10,
			},
		});
		expect(queuedRefresh).not.toHaveBeenCalled();
	});

	it("fails closed when only a consumed token could match multiple rotated accounts", async () => {
		// given
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-1a",
					accessToken: "access-1a",
					expiresAt: 2_000_000_000_000,
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "refresh-1b",
					accessToken: "access-1b",
					expiresAt: 2_000_000_000_000,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		// when
		const outcome = await refreshAndPersistAccount({
			index: 0,
			identity: { refreshToken: "refresh-0" },
		});

		// then
		expect(outcome).toMatchObject({
			status: "failed",
			error: expect.stringMatching(/ambiguous/i),
		});
		expect(queuedRefresh).not.toHaveBeenCalled();
	});

	it("advances tokenRotatedAt monotonically when the wall clock is behind", async () => {
		// given
		const futureRotation = Date.now() + 60_000;
		await seedAccount({ tokenRotatedAt: futureRotation });
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});

		// when
		await refreshAndPersistAccount({ index: 0, identity });

		// then
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.tokenRotatedAt).toBeGreaterThan(futureRotation);
	});

	it("preserves a metadata mutation committed before the rotated token", async () => {
		// given
		await seedAccount();
		let finishRefresh: ((value: {
			type: "success";
			access: string;
			refresh: string;
			expires: number;
		}) => void) | undefined;
		let notifyRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			notifyRefreshStarted = resolve;
		});
		vi.mocked(queuedRefresh).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRefresh = resolve;
					notifyRefreshStarted?.();
				}),
		);
		const refresh = refreshAndPersistAccount({ index: 0, identity });
		await refreshStarted;
		const metadataMutation = withAccountStorageTransaction(async (current, persist) => {
			if (!current?.accounts[0]) throw new Error("Expected account fixture");
			current.accounts[0].accountLabel = "metadata-update";
			await persist(current);
		});

		// when
		if (!finishRefresh) throw new Error("Expected refresh to start");
		finishRefresh({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});
		await Promise.all([refresh, metadataMutation]);

		// then
		const stored = await loadAccounts();
		expect(stored?.accounts[0]).toMatchObject({
			accountLabel: "metadata-update",
			refreshToken: "refresh-1",
		});
	});

	it("refuses to spend the token when the refresh lease was compromised", async () => {
		// given a lease that is reclaimed by another process before the exchange
		await seedAccount();
		const { withRefreshLease } = await import("../lib/storage/transaction-lock.js");
		const { StorageTransactionContentionError } = await import("../lib/errors.js");
		const realLease = vi.mocked(withRefreshLease).getMockImplementation?.();
		const leaseSpy = vi
			.spyOn(await import("../lib/storage/transaction-lock.js"), "withRefreshLease")
			.mockImplementation(async (storagePath, operation) =>
				operation({
					assertValid() {
						throw new StorageTransactionContentionError(storagePath);
					},
				}),
			);

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then the single-use token is never exchanged
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(outcome.status).toBe("failed");
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-0");

		leaseSpy.mockRestore();
		if (realLease) vi.mocked(withRefreshLease).mockImplementation(realLease);
	});

	it("does not hold the storage lease across the provider exchange", async () => {
		// given a provider exchange that outlasts the lease acquisition budget
		await seedAccount();
		let finishRefresh: ((value: {
			type: "success";
			access: string;
			refresh: string;
			expires: number;
		}) => void) | undefined;
		let notifyRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			notifyRefreshStarted = resolve;
		});
		vi.mocked(queuedRefresh).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRefresh = resolve;
					notifyRefreshStarted?.();
				}),
		);
		const refresh = refreshAndPersistAccount({ index: 0, identity });
		await refreshStarted;

		// when an unrelated storage write runs while the exchange is still open
		const noteCommitted = await Promise.race([
			withAccountStorageTransaction(async (current, persist) => {
				if (!current?.accounts[0]) throw new Error("Expected account fixture");
				current.accounts[0].accountNote = "written-mid-exchange";
				await persist(current);
				return true;
			}),
			// If the exchange still held the lease, acquisition would burn its whole
			// retry budget and then throw, so a bounded timer is enough to prove the
			// write is not queued behind the network call.
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
		]);

		// then it completes without waiting for the exchange to finish
		expect(noteCommitted).toBe(true);

		if (!finishRefresh) throw new Error("Expected refresh to start");
		finishRefresh({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});
		await refresh;

		// and the rotated credential still commits on top of it
		const stored = await loadAccounts();
		expect(stored?.accounts[0]).toMatchObject({
			accountNote: "written-mid-exchange",
			refreshToken: "refresh-1",
		});
	}, 20_000);
});
