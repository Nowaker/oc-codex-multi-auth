import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-run throwaway home. The suite writes real account storage, so without
 * this a `npm test` resolves `~/.opencode/oc-codex-multi-auth-accounts.json`
 * against the developer's actual home and overwrites live ChatGPT credentials
 * with fixtures.
 *
 * This must be `test.env`, not a `setupFiles` entry: vitest applies `test.env`
 * before the worker imports any test module, and `lib/config.ts`,
 * `lib/accounts/recovery.ts` and `lib/logger.ts` capture `homedir()` at module
 * scope, so anything later than import time is too late for them.
 */
const inheritedHome = process.env.OC_CODEX_TEST_HOME;
const isolatedHome =
  inheritedHome ?? mkdtempSync(join(tmpdir(), 'oc-codex-multi-auth-test-home-'));
process.env.OC_CODEX_TEST_HOME = isolatedHome;
// Only a home this config minted may be removed once the run ends. One handed
// in through the environment belongs to whoever set it.
if (!inheritedHome) process.env.OC_CODEX_TEST_HOME_OWNED = '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      OC_CODEX_TEST_HOME: isolatedHome,
    },
    // Four suites import the real `index.ts`, and the first one scheduled pays
    // the transform of a 4900-line entry plus its dependency graph: measured at
    // 3.2s-6.7s on an idle machine, against a 5s default. Whichever suite loses
    // that race times out under full-suite CPU contention, which is flakiness in
    // the harness rather than in any assertion (a warm re-import costs ~400ms).
    testTimeout: 15_000,
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      '.opencode/**',
      'dist/**',
      'tmp/**',
      '**/node_modules/**',
      '**/.opencode/**',
      '**/dist/**',
      '**/tmp/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'test/'],
      thresholds: {
        // Global coverage floor.
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
        // Per-file coverage floor for the production source tree. Set below the
        // global average so legitimate low-coverage utility files do not block
        // work, while still catching regressions where a single file drops
        // sharply. Track increases in
        // https://github.com/ndycode/oc-codex-multi-auth/issues/149.
        'lib/**/*.ts': {
          statements: 70,
          branches: 70,
          functions: 70,
          lines: 70,
        },
        'index.ts': {
          statements: 69,
          branches: 50,
          functions: 70,
          lines: 70,
        },
      },
    },
  },
});

