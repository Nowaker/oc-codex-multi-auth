import { describe, it, expect } from "vitest";
import { homedir, userInfo } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { LOG_DIR } from "../lib/logger.js";
import { ACCOUNTS_FILE_NAME } from "../lib/constants.js";
import { saveAccounts } from "../lib/storage/load-save.js";
import { getConfigDir } from "../lib/storage/paths.js";
import {
	getStoragePath,
	setStoragePath,
	setStoragePathDirect,
} from "../lib/storage/state.js";

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
