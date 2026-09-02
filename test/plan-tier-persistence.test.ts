/**
 * The stored plan tier and the stored account label are both written at login
 * and read back on surfaces the user sees. This covers the three places where
 * either one silently disappeared or went stale.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import { persistAccountPool, type TokenSuccessWithAccount } from "../lib/auth/login-runner.js";
import { JWT_CLAIM_PATH } from "../lib/constants.js";
import { loadAccounts, setStoragePathDirect } from "../lib/storage.js";
import { loadFlaggedAccounts, saveFlaggedAccounts } from "../lib/storage/flagged.js";

function makeToken(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function accessTokenFor(options: { accountId: string; planType?: string; email?: string }): string {
	return makeToken({
		[JWT_CLAIM_PATH]: {
			chatgpt_account_id: options.accountId,
			...(options.planType ? { chatgpt_plan_type: options.planType } : {}),
			...(options.email ? { email: options.email } : {}),
		},
	});
}

function loginResult(options: {
	accountId: string;
	refresh: string;
	planType?: string;
	email?: string;
}): TokenSuccessWithAccount {
	return {
		type: "success",
		access: accessTokenFor(options),
		refresh: options.refresh,
		expires: Date.now() + 60_000,
		accountIdOverride: options.accountId,
		accountIdSource: "token",
	};
}

let testDir: string;

beforeEach(async () => {
	testDir = join(
		tmpdir(),
		`plan-tier-persistence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(testDir, { recursive: true });
	setStoragePathDirect(join(testDir, "oc-codex-multi-auth-accounts.json"));
});

afterEach(async () => {
	setStoragePathDirect(null);
	await fs.rm(testDir, { recursive: true, force: true });
});

describe("plan tier persistence", () => {
	it("survives a round trip through the flagged-account store", async () => {
		// The flagged normalizer rebuilds records field by field, so a field it
		// does not name is dropped on the way through quarantine.
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{
					refreshToken: "rt-quarantined",
					accountId: "05cd9f04-d56a-4256-9934-9cb827989a40",
					planType: "self_serve_business_prolite",
					email: "seat@example.com",
					addedAt: 1_700_000_000_000,
					lastUsed: 1_700_000_000_000,
					flaggedAt: 1_700_000_000_000,
				},
			],
		});

		const restored = await loadFlaggedAccounts();
		expect(restored.accounts[0]?.planType).toBe("self_serve_business_prolite");
	});

	it("follows the access token across a refresh instead of pinning the login value", () => {
		const manager = new AccountManager(undefined, {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "rt-1",
					accountId: "acct-1",
					planType: "plus",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		// The live record, not a snapshot copy: updateFromAuth mutates in place.
		const account = manager.getCurrentOrNextForFamilyHybrid("codex", "gpt-5.1");
		expect(account).not.toBeNull();

		// A Plus -> Pro upgrade arrives on the next refreshed access token. The
		// live x-codex-plan-type header already reported the new tier, so a
		// login-only read would leave codex-list contradicting it.
		manager.updateFromAuth(account!, {
			type: "oauth",
			refresh: "rt-2",
			access: accessTokenFor({ accountId: "acct-1", planType: "pro" }),
			expires: Date.now() + 60_000,
		});
		expect(manager.getAccountsSnapshot()[0]?.planType).toBe("pro");

		// A token with no claim leaves the known tier alone rather than erasing it.
		manager.updateFromAuth(account!, {
			type: "oauth",
			refresh: "rt-3",
			access: accessTokenFor({ accountId: "acct-1" }),
			expires: Date.now() + 60_000,
		});
		expect(manager.getAccountsSnapshot()[0]?.planType).toBe("pro");
	});
});

describe("account label on re-login", () => {
	const account = {
		accountId: "2aae3eeb-f7fd-4b2d-96c1-413d33c487c4",
		refresh: "rt-shared",
		email: "user@example.com",
	};

	it("clears a stale label that named an API organization", async () => {
		await persistAccountPool([loginResult(account)], true);
		const seeded = await loadAccounts();
		expect(seeded?.accounts).toHaveLength(1);

		// Simulate a pool written by an older version, whose label named an
		// API-platform organization rather than the ChatGPT subscription.
		seeded!.accounts[0]!.accountLabel = "DreamHost API (role:owner) [id:c487c4]";
		const { saveAccounts } = await import("../lib/storage.js");
		await saveAccounts(seeded!);

		await persistAccountPool([loginResult(account)], false);
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.accountLabel).toBeUndefined();
		// The identity is still there, in the fields every surface renders from.
		expect(stored?.accounts[0]?.accountId).toBe(account.accountId);
	});

	it("keeps a label the user chose", async () => {
		await persistAccountPool([loginResult(account)], true);
		const seeded = await loadAccounts();
		seeded!.accounts[0]!.accountLabel = "My work account";
		const { saveAccounts } = await import("../lib/storage.js");
		await saveAccounts(seeded!);

		await persistAccountPool([loginResult(account)], false);
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.accountLabel).toBe("My work account");
	});
});
