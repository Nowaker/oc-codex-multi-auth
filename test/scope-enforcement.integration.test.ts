/**
 * End-to-end coverage for issue #213, exercised against REAL storage rather
 * than the module mocks used in `test/accounts.test.ts`.
 *
 * The reported symptom was a fresh `opencode auth login` landing an account in
 * the pool already disabled with
 * "Re-auth required for missing OAuth scope(s): openid, profile, email,
 * offline_access." — all four required scopes at once, which is what an absent
 * scope looks like rather than a denied one. These tests drive the real
 * login-persist -> load path and assert on what actually reaches disk.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { persistAccountPool } from "../lib/auth/login-runner.js";
import { SCOPE } from "../lib/auth/auth.js";
import { loadAccounts, saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import type { OAuthAuthDetails } from "../lib/types.js";

const REAUTH_NOTE =
	"Re-auth required for missing OAuth scope(s): openid, profile, email, offline_access.";

describe("OAuth scope enforcement (issue #213, real storage)", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`scope-enforcement-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
		setStoragePathDirect(join(testDir, "accounts.json"));
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await fs.rm(testDir, { recursive: true, force: true });
	});

	// The exact reported flow: log in, then have the plugin load with a host
	// credential that carries no scope (which is what `refreshAccessToken` and
	// the host backfill both produce).
	it("leaves a freshly logged-in account enabled when the host credential has no scope", async () => {
		await persistAccountPool(
			[
				{
					type: "success",
					access: "access-token",
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
					scope: SCOPE,
				},
			],
			false,
		);

		const hostCredential: OAuthAuthDetails = {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			// No `scope` — exactly what the host auth.json holds after a refresh.
		};

		const manager = await AccountManager.loadFromDisk(hostCredential);
		const account = manager.getCurrentAccount();

		expect(manager.getAccountCount()).toBe(1);
		expect(account?.enabled).toBe(true);
		expect(account?.accountNote).toBeUndefined();
	});

	it("leaves the account enabled when neither the pool nor the host records a scope", async () => {
		await persistAccountPool(
			[
				{
					type: "success",
					access: "access-token",
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
				},
			],
			false,
		);

		const manager = await AccountManager.loadFromDisk({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		expect(manager.getCurrentAccount()?.enabled).toBe(true);
		expect(manager.getCurrentAccount()?.accountNote).toBeUndefined();
	});

	// Recovery for anyone already stranded by 6.11.2: the repair must reach the
	// file, not just the in-memory registry.
	it("repairs a 6.11.2-disabled account and writes the repair to disk", async () => {
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-token",
					oauthScope: SCOPE,
					enabled: false,
					accountNote: REAUTH_NOTE,
					addedAt: now,
					lastUsed: now,
				},
			],
			activeIndexByFamily: {},
		});

		const manager = await AccountManager.loadFromDisk();
		expect(manager.getCurrentAccount()?.enabled).toBe(true);

		// The point of the flush: a separate reader must see the repair too.
		const onDisk = await loadAccounts();
		expect(onDisk?.accounts[0]?.enabled).not.toBe(false);
		expect(onDisk?.accounts[0]?.accountNote).toBeUndefined();
	});

	it("repairs a 6.11.2-disabled account whose scope was never recorded", async () => {
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-token",
					enabled: false,
					accountNote: REAUTH_NOTE,
					addedAt: now,
					lastUsed: now,
				},
			],
			activeIndexByFamily: {},
		});

		const manager = await AccountManager.loadFromDisk();
		expect(manager.getCurrentAccount()?.enabled).toBe(true);

		const onDisk = await loadAccounts();
		expect(onDisk?.accounts[0]?.enabled).not.toBe(false);
		expect(onDisk?.accounts[0]?.accountNote).toBeUndefined();
	});

	// The enforcement that must survive all of the above.
	it("still disables an account whose recorded scope is genuinely incomplete", async () => {
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-token",
					oauthScope: "openid profile",
					addedAt: now,
					lastUsed: now,
				},
			],
			activeIndexByFamily: {},
		});

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0];

		expect(account?.enabled).toBe(false);
		expect(account?.accountNote).toBe(
			"Re-auth required for missing OAuth scope(s): email, offline_access.",
		);
	});

	it("does not resurrect an account the operator disabled by hand", async () => {
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-token",
					oauthScope: SCOPE,
					enabled: false,
					addedAt: now,
					lastUsed: now,
				},
			],
			activeIndexByFamily: {},
		});

		const manager = await AccountManager.loadFromDisk();
		expect(manager.getAccountsSnapshot()[0]?.enabled).toBe(false);
	});

	// A blank scope on disk is legacy junk, not an explicit empty grant.
	it("treats a blank stored scope as absent rather than as a failed grant", async () => {
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-token",
					oauthScope: "   ",
					addedAt: now,
					lastUsed: now,
				},
			],
			activeIndexByFamily: {},
		});

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getCurrentAccount();

		expect(account?.enabled).toBe(true);
		expect(account?.accountNote).toBeUndefined();
		expect(account?.oauthScope).toBeUndefined();
	});
});
