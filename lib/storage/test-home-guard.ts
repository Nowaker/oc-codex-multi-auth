/**
 * The test-run write guard, shared by every storage writer.
 *
 * Extracted from `lib/storage/load-save.ts` so the credential-snapshot writer
 * can apply the same check. Importing it from `load-save.ts` directly would be
 * a cycle: `load-save.ts` is what triggers snapshots in the first place.
 */

import os from "node:os";
import { StorageError } from "./errors.js";
import { isWithinDirectory } from "./paths.js";

/**
 * Refuse to mutate account storage inside the developer's real home while the
 * test suite is running.
 *
 * `vitest.config.ts` redirects HOME to a sandbox before any module loads, but a
 * test that restores the captured real HOME, or a future regression in that
 * config, would otherwise write fixtures straight over live ChatGPT
 * credentials. `os.userInfo()` reads the passwd entry instead of `$HOME`, so it
 * still names the real home after the redirect and gives the check something
 * the sandbox cannot spoof. Inert outside vitest.
 */
export function assertTestRunNeverTouchesRealHome(path: string): void {
  if (!process.env.VITEST) return;

  let realHome: string;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    return;
  }
  if (!realHome || !isWithinDirectory(realHome, path)) return;

  throw new StorageError(
    `Refusing to write account storage inside the real home directory during a test run: ${path}`,
    "TEST_HOME_ESCAPE",
    path,
    "A test resolved account storage against the developer's real home. Point HOME at a temp directory for the whole vitest process (see vitest.config.ts) instead of overriding it per test.",
  );
}
