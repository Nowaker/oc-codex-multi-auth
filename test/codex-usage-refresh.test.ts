import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";

let transactionStorage: AccountStorageV3 | null = null;
let persistedStorage: AccountStorageV3 | null = null;

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		withAccountStorageTransaction: vi.fn(
			async (
				handler: (
					current: AccountStorageV3 | null,
					persist: (storage: AccountStorageV3) => Promise<void>,
				) => Promise<unknown>,
			) =>
				handler(transactionStorage, async (storage) => {
					persistedStorage = structuredClone(storage);
				}),
		),
	};
});

import { ensureCodexUsageAccessToken } from "../lib/codex-usage.js";
import { queuedRefresh } from "../lib/refresh-queue.js";

const accessTokenFor = (memberId: string): string => {
	const payload = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: "business-account",
			chatgpt_account_user_id: memberId,
		},
	};
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
};

const storedMember = (memberId: string, refreshToken: string) => ({
	accountId: "business-account",
	accountUserId: memberId,
	organizationId: "org-business",
	refreshToken,
	accessToken: accessTokenFor(memberId),
	expiresAt: 0,
	addedAt: 1,
	lastUsed: 1,
});

describe("Codex usage refresh persistence for Business members", () => {
	beforeEach(() => {
		transactionStorage = null;
		persistedStorage = null;
		vi.mocked(queuedRefresh).mockReset();
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success",
			access: accessTokenFor("member-owner"),
			refresh: "owner-refresh-new",
			expires: Date.now() + 60_000,
		});
	});

	it("refreshes only the matching member from the authoritative current token", async () => {
		const staleOwner = storedMember("member-owner", "owner-refresh-stale");
		transactionStorage = {
			version: 3,
			activeIndex: 0,
			accounts: [
				storedMember("member-owner", "owner-refresh-current"),
				storedMember("member-invited", "invited-refresh-current"),
			],
		};

		const result = await ensureCodexUsageAccessToken({
			storage: { version: 3, activeIndex: 0, accounts: [staleOwner] },
			account: staleOwner,
		});

		expect(result.persisted).toBe(true);
		expect(result.accessToken).toBe(accessTokenFor("member-owner"));
		expect(persistedStorage?.accounts[0]?.refreshToken).toBe("owner-refresh-new");
		expect(persistedStorage?.accounts[1]?.refreshToken).toBe("invited-refresh-current");
		expect(queuedRefresh).toHaveBeenCalledWith("owner-refresh-current");
	});

	it("does not rotate another member that shares the consumed legacy token", async () => {
		const staleOwner = storedMember("member-owner", "shared-refresh");
		transactionStorage = {
			version: 3,
			activeIndex: 0,
			accounts: [
				storedMember("member-owner", "shared-refresh"),
				storedMember("member-invited", "shared-refresh"),
			],
		};

		const result = await ensureCodexUsageAccessToken({
			storage: { version: 3, activeIndex: 0, accounts: [staleOwner] },
			account: staleOwner,
		});

		expect(result.persisted).toBe(true);
		expect(persistedStorage?.accounts[0]?.refreshToken).toBe("owner-refresh-new");
		expect(persistedStorage?.accounts[1]?.refreshToken).toBe("shared-refresh");
	});

	it("does not overwrite a different member when the intended member is absent", async () => {
		const staleOwner = storedMember("member-owner", "owner-refresh-stale");
		transactionStorage = {
			version: 3,
			activeIndex: 0,
			accounts: [storedMember("member-invited", "invited-refresh-current")],
		};

		const result = ensureCodexUsageAccessToken({
			storage: { version: 3, activeIndex: 0, accounts: [staleOwner] },
			account: staleOwner,
		});

		await expect(result).rejects.toThrow(/removed/i);
		expect(persistedStorage).toBeNull();
		expect(transactionStorage.accounts[0]?.refreshToken).toBe("invited-refresh-current");
	});
});
