import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LOG_DIR } from "../lib/logger.js";
import { ACCOUNTS_FILE_NAME } from "../lib/constants.js";
import { saveAccounts } from "../lib/storage/load-save.js";
import { getConfigDir } from "../lib/storage/paths.js";
import {
	getStoragePath,
	setStoragePath,
	setStoragePathDirect,
} from "../lib/storage/state.js";
import { MINTED_HOME_PREFIX, teardown } from "./global-setup.js";

function realUserHome(): string {
	return userInfo().homedir;
}

function isUnder(baseDir: string, targetPath: string): boolean {
	const rel = relative(resolve(baseDir), resolve(targetPath));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("test home isolation", () => {
	it("redirects homedir() away from the real user home", () => {
		expect(process.env.OC_CODEX_TEST_HOME).toBeTruthy();
		expect(homedir()).toBe(process.env.OC_CODEX_TEST_HOME);
		expect(isUnder(realUserHome(), homedir())).toBe(false);
	});

	it("keeps every resolved account storage path out of the real user home", () => {
		const real = realUserHome();

		setStoragePath(null);
		expect(isUnder(real, getStoragePath())).toBe(false);

		setStoragePath(process.cwd());
		expect(isUnder(real, getStoragePath())).toBe(false);

		setStoragePath(null);
		expect(isUnder(real, getConfigDir())).toBe(false);
	});

	// LOG_DIR is captured at module scope from homedir(), so it only lands in
	// the sandbox if the override beat the import. That is the property a
	// setupFiles entry cannot provide and this whole mechanism exists for.
	it("beats module-scope homedir() capture", () => {
		expect(isUnder(realUserHome(), LOG_DIR)).toBe(false);
		expect(isUnder(process.env.OC_CODEX_TEST_HOME as string, LOG_DIR)).toBe(true);
	});

	it("refuses to write account storage that escapes into the real home", async () => {
		const escaped = resolve(realUserHome(), ".opencode", ACCOUNTS_FILE_NAME);
		setStoragePathDirect(escaped);
		try {
			await expect(
				saveAccounts({ version: 3, accounts: [], activeIndex: 0 }),
			).rejects.toMatchObject({ code: "TEST_HOME_ESCAPE" });
		} finally {
			setStoragePathDirect(null);
		}
	});
});

describe("test home teardown", () => {
	// Every case drives `teardown` against a directory this test made, never
	// against the live run's own home, so a broken gate can only destroy scratch.
	const runTeardown = async (
		home: string | undefined,
		owned: boolean,
	): Promise<void> => {
		const previousHome = process.env.OC_CODEX_TEST_HOME;
		const previousOwned = process.env.OC_CODEX_TEST_HOME_OWNED;
		if (home === undefined) delete process.env.OC_CODEX_TEST_HOME;
		else process.env.OC_CODEX_TEST_HOME = home;
		if (owned) process.env.OC_CODEX_TEST_HOME_OWNED = "1";
		else delete process.env.OC_CODEX_TEST_HOME_OWNED;
		try {
			await teardown();
		} finally {
			if (previousHome === undefined) delete process.env.OC_CODEX_TEST_HOME;
			else process.env.OC_CODEX_TEST_HOME = previousHome;
			if (previousOwned === undefined) delete process.env.OC_CODEX_TEST_HOME_OWNED;
			else process.env.OC_CODEX_TEST_HOME_OWNED = previousOwned;
		}
	};

	const mintedLookalike = (): string =>
		mkdtempSync(join(tmpdir(), MINTED_HOME_PREFIX));

	// `vitest.config.ts` spells the prefix as a literal and this module exports
	// it as a constant. Were the two to drift apart, teardown would simply stop
	// matching the home the config minted and the leak would return silently.
	it("agrees with the prefix the config actually minted", () => {
		if (process.env.OC_CODEX_TEST_HOME_OWNED !== "1") return;
		const home = process.env.OC_CODEX_TEST_HOME as string;
		expect(resolve(home).startsWith(resolve(tmpdir(), MINTED_HOME_PREFIX))).toBe(true);
	});

	it("removes a home it minted itself", async () => {
		const home = mintedLookalike();
		expect(existsSync(home)).toBe(true);
		await runTeardown(home, true);
		expect(existsSync(home)).toBe(false);
	});

	// Identical path shape to the case above, so the ownership flag is the only
	// thing left deciding it. A home handed in through the environment belongs
	// to whoever set it.
	it("keeps an inherited home that looks exactly like a minted one", async () => {
		const home = mintedLookalike();
		try {
			await runTeardown(home, false);
			expect(existsSync(home)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("keeps a path outside the temp directory", async () => {
		const scratchRoot = join(process.cwd(), "tmp");
		mkdirSync(scratchRoot, { recursive: true });
		const outside = mkdtempSync(join(scratchRoot, MINTED_HOME_PREFIX));
		try {
			await runTeardown(outside, true);
			expect(existsSync(outside)).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps a temp path that does not carry the minted prefix", async () => {
		const foreign = mkdtempSync(join(tmpdir(), "oc-codex-unrelated-"));
		try {
			await runTeardown(foreign, true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			rmSync(foreign, { recursive: true, force: true });
		}
	});

	// An interrupted run can leave the env half-set or the directory already
	// gone. Neither may throw, or the failure outlives the run it came from.
	it("tolerates a missing home and an already-removed one", async () => {
		await expect(runTeardown(undefined, true)).resolves.toBeUndefined();

		const home = mintedLookalike();
		await runTeardown(home, true);
		expect(existsSync(home)).toBe(false);
		await expect(runTeardown(home, true)).resolves.toBeUndefined();
	});
});
