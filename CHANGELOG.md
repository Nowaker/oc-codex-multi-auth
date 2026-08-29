# Changelog

All notable changes to this project will be documented in this file. Dates are ISO format (YYYY-MM-DD).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Quota Notifications**: Added optional macOS Notification Center monitoring for 5-hour and weekly quotas across all enabled accounts. When enabled via `quotaNotifications.enabled: true` or `CODEX_AUTH_QUOTA_NOTIFICATIONS=1`, it independently tracks the best remaining limit for each pool-wide window and alerts at 25%, 10%, or 0%. Set `quotaNotifications.notifyEveryCheck: true` to receive the same aggregate alert after every successful poll instead. Alerts use the 5-hour window when available and weekly otherwise, showing its highest remaining percentage on the first line, shortest reset on the second, and highest weekly percentage on the third. Account emails are masked by default and can be shown in full with `quotaNotifications.maskAccountEmails: false`. Shared delivery timestamps suppress duplicate every-check alerts from concurrent plugin instances, while threshold crossings remain immediate. When Homebrew `terminal-notifier` is available, notifications use OpenCode's name, icon, bundle identity, and a stable replacement group; delivery falls back to `osascript` otherwise. Threshold state is persisted without account identities so alerts do not repeat until the relevant window resets.

## [6.14.3] - 2026-08-27

### Fixed
- **An implausible quota-reset header took an account out of rotation permanently.** The `x-codex-*` reset headers were parsed with no upper bound: `-reset-after-seconds` was multiplied out and added to the clock as-is, and `-reset-at` was accepted verbatim as an epoch stamp or an ISO date. A garbled value therefore resolved to an arbitrary point in the future — a measured `-reset-after-seconds: 4000000000` produced a reset 127 years out, and `-reset-at: 9999-12-31T00:00:00Z` one 2,912,203 days out. That is not merely a long backoff: the value is written into the persisted `rateLimitResetTimes` map through a deliberately monotonic writer, and expiry only ever drops resets that are already in the past, so nothing in the product could shorten it again. One malformed header — from the backend, an intermediary, or a configured `OPENAI_BASE_URL` gateway — removed the account from rotation until the user edited the state file by hand. The same value also reached the retry-after delay derived from those headers. Reset times further out than any real Codex window are now rejected rather than clamped: an implausible header says nothing about when the account actually recovers, so recording no reset at all (and letting the next request rediscover the truth) is safer than recording a month-long block on the strength of a garbled number. Plausible values are unaffected — a 5h window, a full 7d weekly window, and a reset exactly on the horizon are all still honored.
- **A backwards clock jump turned account health recovery into a penalty.** Passive recovery scaled the elapsed time since an account's last health update, without clamping it at zero. `lastUpdated` is stamped from the local clock, so an NTP correction or a resumed VM makes that interval negative and the recovery term subtracts instead of adding, driving the score arbitrarily below its floor (a measured -17440 against a minimum of 0) and leaving the account ranked last in selection long after the clock settled.
- **`NaN` and `Infinity` reached users verbatim in wait-time messages.** A non-finite duration rendered as the literal strings `NaNs` and `Infinitym NaNs` in toasts, status lines and log warnings. Non-finite input now reads as zero. The same formatter also had no unit above minutes, so a weekly quota block and process uptime both printed as a five-figure minute count (`10080m 0s`); hours and days are now split out.
- **Stale quota headers on an entitlement error blocked healthy accounts.** A response refused for a subscription entitlement problem can still carry the account's last-known `x-codex-*` quota snapshot. Those headers were consumed unconditionally, so an entitlement failure recorded a quota block against an account that had quota left. Quota headers are now believed only on a response the backend actually served, or one it refused with a confirmed usage limit — HTTP 429, including a 404 remapped to one. Entitlement failures, auth failures, 5xx, and upstream overloads dressed up as a 429 are all ignored for this purpose. (#237)

### Internal
- The decision about whether a response's quota headers are authoritative is made once, in the error classifier, and reported to the caller as `quotaHeadersAuthoritative`. It previously lived at a single call site, which left the two other consumers of the same headers on the old behavior: the retry-after parser still read the exhausted-window reset uncapped — in two separate places — and the TUI quota snapshot was still written from headers the router had just discarded, so the status line could report "0% left" for an account rotation considered healthy. The classifier derives the flag from the same overload verdict the caller branches on, so the durable block and the retry delay can no longer disagree. (#237)
- The short 429 retry no longer replays a request on an account whose quota window it has just blocked. That block is monotonic, so a retry that happened to succeed could not walk it back, leaving the account serving traffic while rotation still considered it blocked. (#237)
- The rotation selectors' contracts are documented accurately. `getCurrentOrNextForFamilySticky` claimed to match "the other selectors' contract" in returning null when no account is available; `getCurrentOrNextForFamilyHybrid` deliberately does the opposite, falling back to the least-recently-used account rather than hard-failing — which is what keeps a single-account pool usable when its only account is cooling down. Both now state the difference, and the hybrid selector documents that a returned account is not a promise that it is selectable.

## [6.14.2] - 2026-08-25

### Fixed
- **Pool-exhaustion diagnostics could contradict themselves, and undercounted Business seats.** The identity these counters are keyed on was not stable for the lifetime of a request: it was derived in part from the refresh token, which is single-use and rotates on exchange, and a rotation propagates to every sibling account that shared the old grant. An account fetched earlier in the traversal therefore stopped matching its own recorded identity as soon as any sibling refreshed, and the strict-pool message could report "the model was unsupported on 2 of 2 attempted pooled account(s)" immediately followed by "1 pooled account(s) were never attempted". The key is now built from identity that does not rotate, so two legacy Business seats sharing one workspace id still count as two accounts while a mid-request token rotation leaves the counts alone. Accounts that were never attempted are also counted against the accounts still present rather than by subtracting attempts from a total, so an account removed mid-request no longer hides a live account that never got a turn. (#236)

### Changed
- **Terminal routing diagnostics no longer degrade silently when account state is unreadable.** The strict-pool and exhaustion messages guarded their account lookup and fell back to an empty account list, which made every configured pool entry look like it matched no known account — turning a message that should explain an exhausted pool into one that blames the operator's configuration. The lookup is now unconditional. (#236)

## [6.14.1] - 2026-08-25

### Fixed
- **A rate-limited strict model pool answered `503` with no retry hint instead of `429`.** The pool wait-time lookup resolved its members by comparing configured pool entries against an account's raw account id, while routing resolves them through the member-scoped seat identity that `codex-pool` actually writes. For any pool whose accounts have a resolvable member id the two never matched, so the lookup saw an empty pool, reported no wait at all, and the request failed with a `503` telling the operator to check `codex-health` rather than a `429` carrying `Try again in <time>` — costing clients both the retry-after signal and the correct status class for backoff. Pools configured with legacy workspace-wide entries were unaffected, which is why it went unnoticed. (#235)
- **Pool-exhaustion diagnostics could describe the wrong accounts, or a previous request.** The counts behind these messages were keyed on rotation index, which is reassigned when an account is removed mid-request, so a count recorded before a removal referred to a different account afterwards. Pool size was read off the number of configured entries, which is a different quantity again: one legacy workspace-wide entry can resolve to several Business seats, and two entries can resolve to one seat. The strict-pool message now reports configured entries and resolved accounts separately, names entries that match no known account instead of folding them into an "unavailable" total, and distinguishes accounts that were never attempted from ones that were tried and failed. The general exhaustion message no longer inherits an earlier request's "model not supported" verdict — that state is plugin-scoped, so a request that never reached an account could report a rejection on "0 of 0 attempted account(s)" — and it again states how many accounts are configured. (#234)

## [6.14.0] - 2026-08-21

### Added
- **Trusted OpenAI-compatible gateways for ChatGPT OAuth inference.** `OPENAI_BASE_URL` is now honored for ChatGPT OAuth requests, but only when `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` explicitly opts in — a pre-existing `OPENAI_BASE_URL` set for an unrelated tool cannot silently capture ChatGPT OAuth credentials. The override is fail-closed: remote gateways require HTTPS; cleartext HTTP is accepted only for *literal* loopback addresses — any address in `127.0.0.0/8`, `::1`, and their IPv4-mapped spellings, which WHATWG serializes in hex (`::ffff:127.0.0.2` becomes `::ffff:7f00:2`) — and never for hostnames such as `localhost`, because a host file or resolver can point those at a remote peer and leak the access token in cleartext; embedded credentials, query strings and fragments are rejected; and redirects are not followed, so a `3xx` from the gateway yields a `502` naming the redirect origin rather than replaying the OAuth token to an endpoint the operator never configured. A rejected value fails the auth loader with a `[oc-codex-multi-auth]`-prefixed reason and an error toast instead of silently falling back to the default endpoint, and the value itself is never echoed — it can carry a token in its query string. A one-time warning records the gateway origin. (#232)

### Fixed
- **Two OpenCode processes sharing one account file could burn each other's refresh tokens.** OpenAI refresh tokens are single-use and rotate on exchange, so when two processes exchanged the same token one of them received `refresh_token_reused` and that account was dead until the user logged in again. Refreshes now run under a cross-process lease that serializes the exchange itself, with an authoritative reload before it and a durable commit after it. A process that finds a rotation another process already committed adopts it instead of spending a second token. The guarantee is same-host and local-filesystem: cross-host or network-filesystem coordination still needs an external coordinator, and a process killed between the provider accepting a token and the replacement being committed still requires reauthentication. (#233)
- **Unrelated storage writes no longer queue behind a network round trip.** The refresh lease is deliberately separate from the storage transaction lease, so `codex-note`, `codex-tag`, account enable/disable, rotation stamps and TUI quota writes never wait on a multi-second OAuth exchange. Holding one lease across both would have turned ordinary contention into user-visible `StorageTransactionContentionError` failures. The storage acquisition budget was also widened from roughly half a second to roughly five, and the lock directory is created up front — `proper-lockfile` creates its lockfile with a non-recursive `mkdir`, so the first mutation on a fresh per-project profile previously failed with a bare `ENOENT`. (#233)
- **A consumed refresh token could be written back over a newer one, in four separate paths.** The `codex-health` merge, the startup email-hydration merge, refresh-target resolution, and flagged-account cleanup each restored or misrouted a credential that another process had already rotated — every one of them costing the user a re-login. Credential writes are now gated on the `tokenRotatedAt` rotation stamp so a stale snapshot can never overwrite a newer commit; hydration updates are keyed by stable workspace identity rather than by the refresh token, which had let a sibling record in a *different* organization receive another workspace's access token; refresh-target resolution never widens a seat key to a workspace-level key and refuses an ambiguous `organizationId:` match rather than exchanging against another member's credentials; and flagged-account cleanup deletes only records it positively restored, instead of dropping one whose token a sibling had rotated in place. (#233)
- **A live OAuth access token was written to `flagged-accounts.json`.** Quarantined records are credential-light by design and `normalizeFlaggedStorage` discards those fields on read, so the token was persisted only to be thrown away — while sitting on disk in the meantime. The flagged refresh path no longer writes it. The rotation stamp *is* now persisted there, so rotation ordering survives a round trip through that file. (#233)
- **A lost refresh lease no longer lets the exchange proceed.** If the lease heartbeat is starved past its stale window another process can reclaim it, and continuing would put two processes on the same single-use token. The lease is now asserted valid immediately before the token is spent, and the resulting error is classified retryable so the caller retries with a fresh lease. (#233)

### Internal
- The refresh lease and the storage transaction lease take their locks on *distinct* target paths. `proper-lockfile` keys its in-process registry by the target path rather than by `lockfilePath`, so nesting two leases on one target made the inner release delete the outer's registry entry; the outer release then failed with `ENOTACQUIRED` and leaked its lockfile until it went stale, stalling every other process on the host for the full stale window. (#233)
- `persistRefreshResult` was removed. Its concurrent-rotation guard is subsumed by the coordinator, which owns the reload, exchange and commit, and the function was reachable only from its own test. (#233)
- `test/index.test.ts` stubs the refresh lease. `getStoragePath()` is mocked there to a path that does not exist, so acquiring a real cross-process lease created a directory outside the test sandbox on every run. (#233)

## [6.13.0] - 2026-08-18

### Added
- **Business workspace seats are now first-class identities.** Every OAuth access token issued for a ChatGPT Business workspace carries a per-member `chatgpt_account_user_id` alongside the workspace-wide `chatgpt_account_id`. That member id is now extracted, persisted as `accountUserId`, and participates in account identity, deduplication, model-pool routing, quota accounting and diagnostics. Records written by earlier releases are backfilled from their stored access token wherever it still decodes; a record whose token has expired or is opaque keeps no member id and behaves exactly as it did before. (#230, #231)
- **`codex-doctor` and `codex-health` report colliding Business credentials.** A new `business-member-credential-conflict` finding, and a `businessMemberConflictSlots` field in `codex-health --json`, flag account slots whose tokens resolve to the same member of the same workspace — records that cannot consume separate quotas and must be re-authenticated independently. Distinct workspace variants of a single OAuth grant, separated by `organizationId`, are legitimate and are not reported. (#231)

### Fixed
- **Logging in as a second member of a Business workspace overwrote the first member's credential instead of adding a separate account.** Every affected record ended up carrying the last logged-in user's email, access token and refresh token, so one seat was billed for the whole workspace and the displaced member's single-use refresh token was lost. Business members share one `chatgpt_account_id`, and account identity keyed on that value alone, so every member of a workspace resolved to the same stored record — the collision was silent because the shared id is a legitimate value, not a missing one. Identity now keys on the workspace *and* the token's `chatgpt_account_user_id`, so each seat occupies its own slot, keeps its own refresh token, and is metered against its own quota. Reported by @proamo, who traced it to the host auth fallback; fixed by @lubshad. (#230, #231)
- **A model pool could not target an individual Business seat.** `codex-pool` stored the workspace-wide account id, which matches every member of that workspace, so a pool the operator scoped to one seat silently routed to all of them. Pool entries are now member-scoped `seat:` keys. Legacy workspace-wide entries deliberately keep matching every seat in their workspace, and are migrated to seat keys on the next `codex-pool add`/`remove` — except while project-scoped account storage is active, since `modelAccountPools` lives in the global config and expanding it against one project's visible seats would rewrite routing that other projects depend on. (#231)
- **A per-account circuit breaker could be inherited by an unrelated account.** The breaker key embedded the positional account index, which `removeAccount` reassigns to survivors. Unlike the health, token and rate-limit trackers — all explicitly remapped after a removal — the breaker map is not, so whichever account shifted into a removed slot inherited that slot's OPEN breaker and was short-circuited out of rotation until the breaker half-opened. The key is now derived from the account's stable workspace identity, which no removal can change. (#231)
- **Three advisories reached consumers through the production dependency tree**, and `npm run audit:ci` failed. Two were `hono` advisories (ReDoS in the CORS middleware, plus the same advisory reached transitively). `@openauthjs/openauth` was in the production tree for exactly one function — `generatePKCE`, called once from `createAuthorizationFlow` — and declared `hono` as a peer dependency, which was the only reason `hono` was a direct dependency and an override at all; nothing imports it. PKCE generation now lives in `lib/auth/auth.ts` with the wire format preserved exactly: 64 random bytes base64url-encoded to an 86-character verifier (RFC 7636 allows 43-128), challenge = `base64url(SHA-256(ASCII(verifier)))`, both encoders unpadded. The upstream helper also returned `method: "S256"`, which nothing read — the authorize request already hardcodes `code_challenge_method=S256`. Removing the package takes 11 packages out of the tree; the gate now reports 0. (#229)

### Internal
Review follow-ups on the seat-identity work, each a correctness defect in the new code rather than a change of intent (#231):
- The bare `accountUserId:` identity key is ranked **below** `organizationId:` and `accountId:`. One OAuth grant can back several workspace variants that all carry the same member id, and `findAccountIndexByIdentityKeys` returns the first key that matches, so at rank 2 the member key could resolve a single-use refresh-token write onto another workspace's record and leave that workspace holding a consumed token — a permanent auth failure.
- A memberless legacy record is merged into its workspace's seat record when that workspace has exactly one seat. Because `toAccountIdentityKey` now returns a `seat:` key, a legacy twin whose access token no longer decodes kept the older `organizationId:` key and stopped deduplicating against its own newer entry, surviving as a live rotation slot with a dead refresh token. With two or more seats the record is left alone: there is no way to tell which member it belongs to, and a wrong merge is worse than a duplicate.
- accountId-only fallback matching is retained when the fallback token carries a member id. The candidate set already excludes every record with a *different* member id, so matching on accountId cannot bind two seats together; refusing to match at all stranded records that predate member ids and pushed a duplicate slot for a credential that should have been hydrated in place.
- `accountUserId` is guarded the way `accountId` already was, in both `updateFromAuth` and the Codex CLI cache hydration. A manually- or org-pinned record must not be re-identified by a token minted for a different workspace, which would move its pool key, usage dedupe key and workspace identity key while the accountId pin appeared to hold. The CLI cache is keyed by *email*, so one person's personal account and their Business seat both resolve there.
- `getModelPoolAccountKey` falls back to the bearer token for the member id, matching every other member-id read in the codebase. Without the fallback, a record that bypassed the normalize backfill produced the bare workspace key, which then matched every seat in that workspace instead of the one the operator selected.
- The usage-quota dedupe key retains `organizationId`. Replacing workspace identity with seat identity collapsed one member's two workspaces into a single quota row, contradicting both the rule that key had always documented and the per-workspace binding added in #227; the seat id now disambiguates members *within* a workspace rather than replacing it. The test that pinned the collapse was inverted, with the genuine split and collapse cases pinned alongside it.
- `findConflictingBusinessMemberCredentials` no longer requires the grouped records to carry differing emails. #230 reports that every affected record ends up with the *last* login's email, so the differing-email gate stayed silent on exactly the corruption the scan exists to surface; distinct workspace variants, separated by `organizationId`, remain excluded.
- `updateModelAccountPool` reports the account ids that were actually on disk. `previousAccountIds` may be expanded from legacy workspace keys purely to compute the next set, which made `codex-pool` print a "previous" count, and emit a `previousConfiguredCount`, that the config file never contained.
- `accountUserId` is declared on `AccountMetadataV3Schema` and `AccountMetadataV1Schema`. Both interfaces persist it but zod strips undeclared keys, so any loader, import validator or migration routed through those schemas would have silently erased every seat identity and collapsed Business members back to the pre-fix behaviour.
- The test suite must be run against a built tree. `test/standalone-cli.test.ts` exercises the packaged CLI and requires `dist/`, so its 12 cases fail in a clean checkout until `npm run build` has run.

### Notes
- Model pools are **not** rewritten on upgrade. A legacy workspace-wide pool entry keeps matching every seat in its workspace until the next `codex-pool add`/`remove` migrates it, and that migration is skipped entirely while project-scoped account storage is active.
- Records already corrupted by #230 share one credential across several slots. They are reported by `codex-doctor` and `codex-health` but are deliberately **not** auto-collapsed: merging stored account records risks discarding a single-use refresh token, which would permanently break the account — the same reasoning applied to the duplicate rows left in place by #227. Remove the affected slots and re-login each member separately.

## [6.12.1] - 2026-08-12

### Fixed
- **A pool mutation that had already been written to disk could be reported as a fatal lock error.** `updateModelAccountPool` classified only lock *acquisition* failures, so the `release()` in its `finally` block could still reject and replace the mutation's return value — proper-lockfile rejects with `ERELEASED` when the lock was compromised mid-mutation, with `ENOTACQUIRED` when the entry was dropped, and `removeLock` propagates any non-`ENOENT` error straight from `rmdir`, which on Windows means a lock directory held open by an antivirus scanner or the search indexer surfaces as `EPERM`/`EBUSY`. The change landed, the tool said it had not. Release failures are now downgraded to a warning: the config is already durable at that point, and a leftover lock directory is reclaimed by `stale` within ten seconds. Reported by @AceRothstein71. (#224, #225)
- **A lock going stale mid-mutation killed the plugin process.** `lock()` was called without an `onCompromised` handler, so proper-lockfile's default `(err) => { throw err }` fired from inside an fs callback. Nothing in this process installs an `uncaughtException` handler, so a blocked event loop or another process reclaiming the entry took the whole plugin down instead of failing one call — the "afterwards it completely stalls the sub tasks" half of the report. The mutation is already in flight and cannot be rolled back, so a compromised lock is now recorded and the subsequent `ERELEASED` tolerated. (#224, #225)
- **Windows lock contention was not recognised as contention at all.** `ELOCKED` was the sole classifier, but proper-lockfile forwards raw fs errors from the lock directory's `mkdir`/`stat`/`rmdir` into its retry loop, so the error that finally escapes is not always `ELOCKED`. On Windows a lock directory held open by another process surfaces as `EPERM`/`EBUSY` rather than `EEXIST` — the same class `renameWithWindowsRetry` already tolerates one layer down — so the retry-guidance path was skipped entirely and users saw a hard error. Now classified with the existing `isWindowsLockError` predicate, guarded to win32 so a POSIX `EPERM` stays fatal. (#224, #228)
- **Concurrent `codex-pool` callers each paid the full retry budget, one after another.** Every mutation serializes behind an in-process queue, and each queued caller independently waited out roughly three seconds of retries against *the same* foreign holder — ten parallel calls blocked for ten times the budget and then all failed anyway. Once one call establishes that the lock is held externally, callers arriving within the next second use a short probe budget and degrade immediately; any successful acquisition restores the full budget, so an isolated collision still gets the patient path. (#224, #228)
- **The lock-contention response broke callers harder than the error it replaced.** The degraded JSON dropped `pool`, `dryRun`, `restartRequired`, `previousConfiguredCount` and `previousPoolMode`, so a consumer reading `pool.accounts` got a `TypeError` where it had previously seen a plain lock error. Nothing is mutated on that path, so the response now reports the pool still on disk, in the same shape as a successful mutation. It also emitted `error: "config_locked"` while the class was `ConfigLockContentionError` and the code `CODEX_CONFIG_LOCK_CONTENTION` — three spellings of one condition, none of which could be traced from tool output to the codebase or the logs. The wire format now carries `CODEX_CONFIG_LOCK_CONTENTION`. (#228)
- **Lock contention was modelled as a configuration error.** `ConfigLockContentionError` extended `ConfigError`, whose documented meaning is non-retryable bad user configuration — missing TTY, malformed CLI input, bad format flags. Any handler catching `ConfigError` to advise "fix your configuration" and stop retrying would have given exactly the wrong advice for a condition that resolves on its own. It now sits with the transient family and carries `retryable: true`. (#228)
- **The multi-worktree collision warning never actually throttled.** The throttle keyed on the foreign process's `pid` and `startedAt`, so a peer that restarted — or a series of short-lived sessions — minted a fresh identity on every probe and the log spam the throttle exists to suppress continued unabated. Those dead identities also evicted live ones from the bounded map, which could stop a genuinely recurring collision from ever being deduped. Now keyed on storage path and host. Separately, the check recorded the warning as delivered *before* the caller emitted it, so a logger that threw silently suppressed the next sixty seconds of collisions; the check and the record are now separate, with the record after the emit. (#228)
- **One ChatGPT login holding two workspace subscriptions collapsed onto a single quota pool.** With one email or Apple ID on, say, Team and Plus, `codex-limits` reported the same plan and percentage for every entry, `codex-switch` kept draining the same pool, and logging in under the other workspace appeared to overwrite every entry. The OAuth flow requests `id_token_add_organizations=true`, so the id_token lists every organization the login belongs to, and account selection persisted one entry per organization — but all of those entries shared the login's single OAuth token. The Codex backend meters quota by the `chatgpt-account-id` header and ignores organization ids, so an entry whose id was an organization id did not fail loudly; it silently fell back to the token's default subscription. Each workspace subscription is a distinct ChatGPT account with its own `chatgpt_account_id` claim, so separate tokens are what produce separate quotas. One login now persists exactly one account, bound to the token-scoped account id and labelled with the workspace that was selected; a second `opencode auth login` under the other workspace appends a separate account with its own token, while re-login under the same workspace still updates in place. Entries persisted by an earlier release keep their stored organization id but are now routed through the token's account id, so they reach a real pool instead of being silently mis-billed. Reported by @JackTheCoconut, who identified the root cause empirically against `/backend-api/wham/usage`. (#226, #227)

### Internal
- Duplicate account rows written by the previous one-entry-per-organization behaviour are deliberately left in place rather than auto-collapsed: merging stored account records risks discarding a single-use refresh token, which would permanently break the account. `docs/troubleshooting.md` documents the fresh-login path to a clean pool. (#227)
- Regression coverage for every fix above is pinned against the pre-fix build rather than merely asserting the fixed behaviour: each fix was reverted in isolation and the corresponding test confirmed to fail. Three tests that shipped with the original lock work did not discriminate — one passed unchanged against `main`, one asserted a hardcoded forward-slash path and failed on every Windows run, and the contention suite mocked `proper-lockfile` entirely, so nothing verified the single assumption the whole degrade path rests on. A real, unmocked foreign lock that outlasts the retry budget now covers it. (#228)
- The four tests that asserted one account entry per organization encoded the behaviour #226 corrects, so they were rewritten to the new contract rather than deleted, and the `persistAccountPool` deduplication they incidentally covered is now pinned directly. (#227)

## [6.12.0](https://github.com/ndycode/oc-codex-multi-auth/compare/v6.11.4...v6.12.0) (2026-08-08)


### Added

* add strict model account pool routing ([#222](https://github.com/ndycode/oc-codex-multi-auth/issues/222)) ([dcc1e59](https://github.com/ndycode/oc-codex-multi-auth/commit/dcc1e5979eea0b737e2b66ae4da182ac97507f0e))


### Fixed

* **release:** preserve unprefixed release tags ([3c5f71d](https://github.com/ndycode/oc-codex-multi-auth/commit/3c5f71d0a1b44ad28490b6519777ae5b21ee9627))

## [6.11.4] - 2026-08-04

### Fixed
- **An account with no weekly quota left was tried again on every prompt.** The request failed, the plugin rotated away, and the cycle repeated on the next prompt — the account was never remembered as spent. Two independent defects on the same path produced it. First, nothing consumed the quota headers the backend puts on *every* response: `x-codex-secondary-used-percent: 100` and its reset time were parsed only for the TUI status line, so the rotation layer could rediscover exhaustion only by failing another request, however recently the server had reported it. Second, when a `429` did arrive, `parseRetryAfterMs` collapsed the primary (5h) and secondary (weekly) reset-at headers with `Math.min`; the 5h reset is always the sooner one, so the persisted block expired with the wrong window and the spent account walked straight back into rotation. A body-supplied `retry-after` was worse still, being capped at five minutes. A shared parser for the `x-codex-{primary,secondary}-*` headers now backs both the request path and the TUI cache, so the two cannot drift on what "exhausted" means, and it accepts the `-reset-after-seconds` and ISO-8601 `-reset-at` forms the request path previously ignored. A window reporting `used-percent >= 100` now outranks every other signal, uncapped, and when several windows are spent the *latest* reset wins rather than the soonest. The block is applied on every response, success or failure, so an account that reports 0% left leaves rotation before the next prompt instead of after another failed request. Windows the plan has switched off (`window-minutes: 0`, which still report a used percent) are excluded, so they cannot block an account that has quota. Reported by @Grelo4ka. (#218, #219)
- **A short rate limit could shorten a week-long quota block.** The new block preserved the longer reset only within its own method, while `markRateLimitedWithReason` still assigned the same `rateLimitResetTimes` keys unconditionally — so a concurrent in-flight request landing an ordinary `429` with a 30-second retry-after overwrote a weekly block and made the account selectable again almost immediately, reproducing the original bug through a second door. Every writer now goes through one helper that keeps whichever block runs longer. A zero-length retry keeps its existing meaning of "the window has elapsed" and clears the keys explicitly; the previous code wrote `nowMs()` and let `clearExpiredRateLimits` drop it, which a monotonic write would otherwise defeat. Nothing in the request path passes zero — every server-derived delay is at least 1ms. (#219)
- **An ordinary throttle ignored two of the three reset formats.** When no window reported exhaustion, the fallback read only numeric `x-codex-*-reset-at` values, so a `429` carrying just `-reset-after-seconds` or an ISO stamp produced no candidate at all and fell back to the 60-second default — retrying before the reset the backend had actually given. It now reads the windows through the shared parser, skipping plan-disabled windows, and keeps `x-ratelimit-reset` as its own candidate. (#219)
- **A second opencode process could erase a weekly quota block.** `saveToDisk` blind-overwrote `rateLimitResetTimes` from the saving process's snapshot; rate-limit state was deliberately last-writer-wins, which is fine for a 5h window both processes rediscover within minutes and not fine for a block worth days. A process holding a stale snapshot saved over the block another had just recorded, and the exhausted account returned to rotation on the next reload. Saves now merge the on-disk resets, keeping the longer block per quota key, inside the storage transaction that already adopts newer credentials — running before it, because for records without workspace ids the refresh token participates in the identity key and adopting a rotated token first would change which disk record an account matches. Only blocks still in the future are adopted, so an expired entry another process has not pruned cannot be resurrected. Live in-memory state is deliberately untouched: unlike a consumed refresh token, a missing block is self-correcting, because the next response re-applies it from the quota headers. `codex-doctor --fix` is unaffected — it persists through its own transaction, so an explicit repair still clears blocks. (#219)

### Internal
- Regression coverage for every fix above is pinned against the pre-fix build rather than merely asserting the fixed behavior: each new assertion was run against the preceding commit and confirmed to fail there. The proactive gate is additionally covered end-to-end through the request path, which is where a wiring defect would hide — the first attempt at that test passed against a fully mocked `AccountManager` that had no `markQuotaExhausted` at all, with the resulting `TypeError` swallowed by the surrounding bookkeeping guard.
- A known limitation of the cross-process merge is pinned rather than papered over. A record carrying neither `organizationId` nor `accountId` is identified by its refresh token, so once another process rotates that token the two records share no identifier and the merge cannot match them. Verified empirically: the merge no-ops and the on-disk block is dropped — never mis-assigned to a different account — which is also why a positional fallback would be worse, since account order is not stable across processes. The same identity miss makes `adoptNewerDiskCredentials` overwrite a newly rotated single-use refresh token, which is the higher-severity failure that method exists to prevent; it is pre-existing, tracked separately, and asserted in the same test so both expectations flip together when storage carries a rotation-invariant account id. (#221)
- `ci.yml` gained a `workflow_dispatch` trigger, so the full gate can be started on demand from the Actions tab instead of by pushing a throwaway commit. The existing concurrency block needed no change: `cancel-in-progress` evaluates `github.event_name == 'pull_request'`, which is false for a manual run. (#220)

## [6.11.3] - 2026-08-02

### Fixed
- **A successful `opencode auth login` could add an account that was already disabled**, annotated `Re-auth required for missing OAuth scope(s): openid, profile, email, offline_access.` All four required scopes reported missing at once is the signature of scope metadata being *absent*, not denied — `getMissingRequiredOAuthScopes(undefined)` returns the entire required set. `initializeFromStorage` enforced the requirement asymmetrically: the stored-account path guarded on whether a scope had actually been recorded, but the two `authFallback` paths did not, so a scope-less host credential was read as "nothing was granted" and the account was pushed with `enabled: false`. A scope-less credential is normal rather than suspicious — `refreshAccessToken` deliberately omits `scope` when the token response does, because callers resolve it as `result.scope ?? existing.oauthScope`, and the host OpenAI backfill wrote its `auth.json` entry without one; either is enough to reach the fallback path with no scope. Enforcement now fires only when the granted scope is genuinely known, and the stored pool scope and the matching host credential are weighed together, since they describe one grant and a partial value on either side alone must not strand an account the other already vouches for. An explicit partial grant still disables and still annotates, unchanged. Accounts wrongly disabled by 6.11.2 are re-enabled and their generated note stripped, in memory and flushed to disk so the TUI, the CLI, and every other direct storage reader stop reporting stale state — re-login alone could not clear it, because the disabled state was persisted. An account disabled by hand, carrying no generated note, is left disabled. `scope` is also normalized at every boundary where it enters the system: a blank value previously survived `json.scope ?? SCOPE` and then overwrote known-good metadata through the `?? existing.oauthScope` chains, and the host backfill now carries the pool's scope across so a restored credential is not scope-less on the next load. Reported by @Grelo4ka. (#213, #214)
- **A record could carry two contradictory re-auth notes, the stale one first.** Note de-duplication matched on an exact sentence, so a record whose missing-scope set had changed since the note was written kept both — the 6.11.2 population claims all four scopes are missing, so the moment a real but partial scope became known the sets differed and both sentences stuck, telling the user to re-authenticate for scopes that were not in fact missing. The note is now replaced rather than appended to, preserving any operator-authored text ahead of it. (#215)
- **One transient storage read failure disabled the plugin until OpenCode was restarted.** `loader()` assigns its account-manager promise to the module-level cache *before* awaiting it, and nothing cleared that cache when the load rejected — `invalidateAccountManagerCache()` only runs on explicit account mutations. A rejected promise therefore stayed parked in the cache and every later request re-awaited the same rejection, so the failure outlived its own cause: a momentary Windows file lock or a partially-written save during a concurrent write was enough to break every subsequent request indefinitely. This repo already treats Windows lock contention as expected — `lib/storage.ts` retries renames for exactly that reason — so the trigger was realistic rather than theoretical. The cached promise is now evicted on rejection, guarded by identity so a concurrent reload's newer promise is not discarded. The failing call still rejects; only the next one gets a fresh attempt. (#216)

### Internal
- Regression coverage for the scope paths is pinned against the pre-fix build rather than merely asserting the fixed behavior. An initial integration test seeded the pool *with* a scope and asserted the account stayed enabled — which passed against the broken code too, since that path resolved the stored scope, found it complete, and left the account alone. The account in the report is *added*, which places it in the host-fallback branch, reached only when the credential matches nothing in the pool; the suite now drives that branch, and 6 of its 11 cases fail against the previous release while the other 5 are deliberate controls that must pass on both sides. (#214)
- `eslint.config.js` ignored `dist/` but not `coverage/`, so `eslint . --max-warnings=0` — what the pre-commit hook runs — failed on vitest's generated HTML report and its vendored JavaScript after any `npm run test:coverage`. `coverage/` is gitignored, so this was purely a lint-configuration gap. (#216)

## [6.11.2] - 2026-07-31

### Fixed
- **`warm` still failed every account with `HTTP 400`, and the cause was never the model.** The warm ping sent its JSON body without a `content-type` header, so `fetch` applied its default for a string body — `text/plain;charset=UTF-8` — and the backend rejected the request with `{"detail":"Unsupported content type"}` before it ever read the model. This was invisible on the live request path, which wraps OpenCode's own `RequestInit` and therefore inherits a content type; `warmAccountWindow` is the only caller that builds its headers from nothing and sends a body, so it was the only one affected. The header is now set explicitly, matching `codex-reset.ts`, the one other bodied POST built on `createCodexHeaders`. Verified against the live API: the identical request body returns `400 {"detail":"Unsupported content type"}` without the header and `200` with it, on an account fully entitled to `gpt-5.5` — confirming this was never account-, plan-, or entitlement-specific. Reported by @Grelo4ka. (#210)
- **A warm `400` that was not an entitlement error was reported as a model problem.** The `400` branch classified every response as `unsupported-model`, so a transport-level failure entered the entitlement fallback path and surfaced as though the account lacked the model. It now gates on `getUnsupportedCodexModelInfo`, the same predicate `resolveUnsupportedCodexFallbackModel` already applies internally, so entitlement `400`s keep the 6.11.1 fallback behavior unchanged and everything else fails immediately carrying its real upstream message. (#210)

### Internal
- Warm request tests now pin the outgoing content type by materializing a real `Request` from the captured init. Asserting on the header object alone could not catch the defect, because the `text/plain` default is applied by `fetch` at send time rather than by the header builder — the suite passed against a mock while the shipped request was rejected. The new assertion fails against 6.11.1 with `expected 'text/plain;charset=UTF-8' to be 'application/json'`. The 6.11.1 note attributing #210 to the retired `gpt-5.4` entry point was corrected in-code; that change was still worth keeping on its own merits, but it was not what #210 was.

## [6.11.1] - 2026-07-30

### Fixed
- **`warm` failed every account with `HTTP 400`**, from two independent causes. The warm ping was pinned to `gpt-5.4`, an id no longer present in the installer's shipped model catalog and listed in the installer's stale managed keys, so it is actively removed from user config — accounts without that entitlement were being pinged with a model they could not use. The entry point is now `gpt-5.5`, the generally-available anchor that every GPT-5.6 preview tier already degrades toward in the shared fallback chain. Separately, `warmAccountWindow` classified only `429` and dead-ended every other status, so an entitlement `400` could not recover the way live chat traffic does: a `model_not_supported_with_chatgpt_account` response now walks the shared unsupported-model chain (`gpt-5.5` → `gpt-5.4` → `gpt-5.4-mini` → `gpt-5.4-nano`), bounded by an attempt budget derived from the chain itself rather than hardcoded, since `warm` fans out across accounts concurrently. Because the warm body is built outside the request transformer, it now asks the transformer's canonical clamp what `"none"` resolves to on the target model instead of keeping a private copy of that rule — a fallback hop onto a model that rejects `"none"` would otherwise be a fresh `400`. Warm failures now report the sanitized upstream response body instead of a bare status code. Reported by @Grelo4ka. (#210)
- **`limits` printed the account list and no limits at all.** The command computed rate-limit state into its payload but the printer never rendered that field, so its output was byte-identical to `list`. Rendering it alone would not have been sufficient: the persisted `rateLimitResetTimes` stays empty until an account has already been rate-limited, and it holds reset timestamps rather than the weekly and 5-hour usage the command advertises. `limits` now reads the model-independent `/wham/usage` endpoint through the same compiled runtime the in-conversation `codex-limits` tool uses, with matching workspace deduplication, window titles, and summaries, and reports per-account failures inline with a non-zero exit. This makes `limits` a network call that can refresh a token where it was previously a purely local read; `rateLimitResetTimes` is retained in the `--json` payload for existing consumers, and `--tag` now gates which accounts are contacted rather than only which are displayed, so an untagged account is neither billed a usage fetch nor has its credentials refreshed. Reported by @Grelo4ka. (#209)

### Security
- **Per-account `limits` errors are redacted before output.** The error path formatted messages with a helper that performs no redaction, and `ensureCodexUsageAccessToken` can surface a raw OAuth refresh response body — truncation alone does not protect bearer, JWT, API-key, or refresh-token material from stdout, `--json` output, terminal history, or CI logs. Messages now pass through the logger's token patterns.

### Internal
- CI runs `npm run build` before `npm test`. `dist/` is gitignored and the standalone CLI tests load the compiled warm/limits runtime out of it, so the previous step order could not have passed on a clean checkout; removing `dist/` fails 12 of the 14 standalone tests, confirming the ordering was load-bearing rather than cosmetic.

## [6.11.0] - 2026-07-28

### Added
- Added a cache-only `update` command and provider-preserving `install --plugin-only` mode. Updating no longer requires invoking the provider/model installer, and manual update notifications now recommend the config-safe command. Contributed by @lubshad. (#207)

### Changed
- **Default install now manages only the OpenCode/TUI plugin entries and preserves `provider.openai`**; model catalogs require explicit `--modern`, `--full`, or `--legacy`. Installer writes and backups are skipped when merged configuration is semantically unchanged, plugin-only mode rejects non-object JSON roots, dry-run diffs report changed paths without values, and managed cache cleanup covers bare and `@latest` layouts with retries for transient Windows cache locks. Note that the `--variant` reasoning presets and `gpt-5.5-fast` are defined only by the shipped catalogs, so a flagless install leaves model definitions entirely to OpenCode — install with `--modern` if you want them. Contributed by @lubshad. (#207)

### Fixed
- **Terminal quota checks no longer send a synthetic model request.** Checking quotas from the account menu previously POSTed a "quota ping" completion to `/codex/responses`, walking a list of candidate models until one was accepted, purely to scrape `x-codex-*` rate-limit headers off the response. It now reads the model-independent `/wham/usage` endpoint directly and formats the shared usage windows, plan type, credits, code-review limit, and any additional limits. Free-plan accounts are handled without selecting a model at all. Deactivated-workspace and invalidated-token responses are still normalized to the canonical errors that flag an account for `codex-doctor --fix`, and the sanitized `codex-limits` error path is unchanged. Contributed by @lubshad. (#208)
- Corrected the install documentation for the new plugin-only default: the getting-started quickstart now leads with `--modern` so the `--variant` presets it demonstrates actually exist, and `config/README.md`, `CONFIG_FIELDS.md`, `troubleshooting.md`, and the `ARCHITECTURE.md` CLI diagram no longer attribute the base OAuth catalog to a flagless install or imply `update` accepts `--no-cache-clear`.

### Security
- **Cleared every outstanding dependency advisory; `npm run audit:ci` now reports 0 vulnerabilities.** `hono` moved to 4.12.32, resolving a `hono/jsx` cross-request context disclosure, a server-side XSS via the `cx()` escaping bypass, and a header de-duplication defect — this also cleared the advisory inherited by `@openauthjs/openauth`. `seroval`/`seroval-plugins` moved to 1.5.6, resolving a critical `fromJSON()` promise-resolver type confusion that could invoke attacker-controlled methods during deserialization (CVSS 9.8) reached through `solid-js`. `brace-expansion` and `postcss` were also pinned to patched releases.

## [6.10.1] - 2026-07-23

### Fixed
- **Account verification consumed single-use refresh tokens without persisting the rotation**, so `codex-health`, `codex-doctor --fix`, and `codex-refresh` bricked the accounts they checked: verifying an account exchanges its refresh token, which OpenAI rotates and invalidates on use, but health and doctor treated the check as read-only and never saved the new credential. The consumed token stayed on disk and the next load returned `refresh_token_reused` for every verified account until re-login. All three tools now persist the rotated credential in a storage transaction before reporting, through a shared refresh/persist path that skips intentionally-disabled accounts without touching their token, propagates a rotated token shared by workspace-sibling records, and reconciles concurrent storage changes by stable account identity (organizationId → accountId → refreshToken) rather than list position. `codex-doctor --fix` reloads diagnostics after applying fixes so the reported health can never contradict the live verification result, and marks refresh-verification failures as blocked with a re-login next action. (#205)
- **The cached account-manager reload leaked a shutdown handler on every `codex-health`/`codex-refresh` call and could overwrite freshly rotated tokens.** It now flushes the outgoing manager's pending debounced save and disposes its shutdown handler before installing the reloaded instance — mirroring `invalidateAccountManagerCache` — and is error-guarded so a reload failure degrades gracefully instead of crashing an already-successful response. The `account.select` event handler reuses the same safe reload. A duplicate `refresh-verification-failed` finding in `codex-doctor` output was also removed. (#205)
- **The OAuth callback success page was broken by the strict callback Content-Security-Policy**: it depended on inline scripts, external Google Fonts, and inline styles the CSP blocked, so it rendered as an unstyled white page exposing raw unicode escape sequences. It is now a compact static page whose only stylesheet is bound to a per-request CSP nonce, with the policy tightened to `default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` and `Cache-Control: no-store` / `Referrer-Policy: no-referrer` added to the response. No external font or script is loaded. (#206)

## [6.10.0] - 2026-07-20

### Added
- **`accountToasts` — opt out of the account-selection toast**: a new boolean config field (default `true`) with env override `CODEX_AUTH_ACCOUNT_TOASTS` gates only the informational `Using <account> (N/N)` toast the plugin renders when it selects or rotates to an account. Because OpenCode draws that toast over the output rather than reserving layout space, during a large diff it could cover several lines until it faded, and there was previously no way to disable it — `CODEX_AUTH_TOAST_DURATION_MS` has a 1000 ms floor and the debounce only suppresses repeats. Setting `accountToasts: false` (or `CODEX_AUTH_ACCOUNT_TOASTS=0`) hides just that informational toast while every warning and error toast — rate-limit switches, expired-auth recovery, unsupported-model and retry notices — stays visible. Resolution follows the standard env-over-config precedence (`"1"` enables, `"0"` disables), and like the other plugin settings it lives in `openai-codex-auth-config.json`, which the installer never rewrites, so the opt-out persists across upgrades. Reported by @aic0d3r. (#203)

## [6.9.1] - 2026-07-18

### Fixed
- **`gpt-5.6-sol` still rejected through the plugin after the 6.8.2 identity fix** (`model_not_supported_with_chatgpt_account` on every pooled account while terra/luna pass, and sol works in the Codex TUI and in plain opencode on the same accounts): the remaining difference was *who the plugin claims to be*, not the request version or payload. The upstream model catalog gates sol, terra, and luna identically (`minimal_client_version: 0.144.0`, `use_responses_lite: true`), so no version- or shape-level cause can produce a sol-only failure; and plain opencode's native ChatGPT-Codex path does not imitate the Codex CLI at all — it sends `originator: opencode` with an `opencode/<version> (<platform> <release>; <arch>)` `User-Agent` to the same `/backend-api/codex/responses` endpoint. The backend evaluates sol entitlement per originator, and for some account cohorts the `codex_cli_rs` claim from a non-Codex client fails that check while the host identity passes. The GPT-5.6 (responses-lite) tiers therefore now present the host (opencode) identity by default — the identity affected accounts are proven to pass sol with — while every other model keeps the Codex CLI identity from 6.8.2. Verified live on a sol-entitled account: both identities return 200 there, so accounts where `codex_cli_rs` already works are unaffected. `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode` (alias `host`) forces one identity for all models. (#196, #201)
- The advertised opencode version self-syncs with the real host build: when the host runtime injects its own `opencode/<version>` `User-Agent` on the incoming request, that version is reused in the emitted identity instead of a baked-in constant; `CODEX_AUTH_HOST_VERSION` overrides both. (#201)
- `CODEX_AUTH_CLIENT_VERSION` and `CODEX_AUTH_HOST_VERSION` values are sanitized to safe product-token characters (whitespace and junk stripped, empty results fall back to the default), so a badly quoted environment value can no longer split the `User-Agent` product token and silently break the version the backend parses. (#201)

## [6.9.0] - 2026-07-17

### Added
- **Model-specific account pools**: a new `modelAccountPools` config field maps an effective model ID to a preferred set of accounts, so a model can be routed through the accounts entitled to it (e.g. pin `gpt-5.6-sol` to the accounts inside the Sol preview) instead of burning rotation attempts on accounts that will reject it. All three rotation strategies (`sticky`, `round-robin`, `hybrid`) restrict selection to healthy, selectable accounts in the preferred pool while one is available; existing quota, cooldown, and token-health rules still apply within the pool. If every preferred account is unavailable — disabled, unknown in this project, cooling down, or rate-limited — selection falls back transparently to the healthy general pool rather than failing the request. Model keys match case-insensitively against the effective model after request-model normalization; unmapped models and empty lists use the general pool directly. Pool references are stable account IDs, not indexes, so adding, removing, or reordering accounts never silently changes a model's routing. Contributed by @lubshad. (#200)
- **`codex-pool` tool** (the 24th `codex-*` tool): inspects and mutates those mappings with ordinary 1-based account numbers (`status`, `set`, `add`, `remove`, `clear`, plus `dryRun=true` previews) while resolving and persisting only stable IDs. Config writes are atomic and serialized — an in-process promise queue plus a `proper-lockfile` cross-process file lock (new runtime dependency) — preserve every unrelated raw config key, and refuse to replace malformed JSON or an invalid existing pool rather than clobbering it. JSON output redacts stable account IDs unless `includeSensitive=true`. Because the plugin config is global while account storage is per-project by default, references that don't resolve in the current project are reported but never automatically pruned — they may be valid elsewhere. Mutations require an OpenCode restart to take effect. (#200)
- Routing diagnostics (`codex-status`, `codex-dashboard`, `codex-metrics` text and TUI views) now report `accountPoolMode` — `general`, `preferred`, or `general-fallback` — and `configuredAccountPoolSize`, so a fallback out of a configured pool is visible instead of silent. (#200)

## [6.8.2] - 2026-07-16

### Fixed
- **`gpt-5.6-sol` rejected through the plugin while working in the Codex CLI/TUI for the same account**: two request-identity mismatches versus upstream Codex could make the backend evaluate a sol request against the wrong client or workspace context and return `model_not_supported_with_chatgpt_account` for an entitled account. First, the plugin declared `originator: codex_cli_rs` but sent the host runtime's `User-Agent`, while the backend reads the client version from the UA product token and the model catalog gates the 5.6 tiers on `minimal_client_version: 0.144.0`; requests now carry a Codex CLI `User-Agent` (`codex_cli_rs/<version> (<os>; <arch>)`), with `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` to opt out and `CODEX_AUTH_CLIENT_VERSION` to override the advertised version. Second, the plugin pinned `openai-organization` on every request for accounts whose token carries an organization claim — a header upstream Codex never sends on ChatGPT-Codex requests (workspace routing is carried entirely by `chatgpt-account-id`), and one that can shift the backend's entitlement evaluation to a workspace outside the narrow sol preview while the broader terra/luna preview still passes. The header is no longer sent by default; multi-org setups that relied on it can restore it with `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1`. Follow-up to the #196 auto-fallback fix in 6.8.1, prompted by the report that sol works in the Codex TUI and in opencode without the plugin but not through it; needs verification by an affected preview account. (#196)

## [6.8.1] - 2026-07-15

### Fixed
- `gpt-5.6-sol` (and the other 5.6 tiers) no longer hard-fails with `model not supported` when the account is outside the GPT-5.6 preview. 6.7.0 documented that an account without access "degrades `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.6-luna` → `gpt-5.5` through the unsupported-model fallback chain", but the chain was only traversed under `unsupportedCodexPolicy: "fallback"`: the default-selector auto-fallback allowlist listed only `gpt-5.5` and `gpt-5-codex`, so under the default `strict` policy a Sol request burned through every pooled account and returned an entitlement error. The three 5.6 tiers are now on the same auto-fallback path as `gpt-5.5`/`gpt-5-codex`, so the documented degradation works out of the box; opt out with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`. Bare `gpt-5.6` is also canonicalized to `gpt-5.6-sol` inside the fallback resolver, matching the request path, so custom chains keyed as `gpt-5.6` resolve correctly. (#196)
- **Multi-process refresh-token clobber**: a process persisting its in-memory account pool blind-overwrote the accounts file, including a refresh token another process had rotated after this process loaded its snapshot. Refresh tokens are single-use, so the clobbered token was dead on arrival — the next refresh with it failed and the auth-failure path eventually removed a still-valid workspace. Accounts now carry a persisted `tokenRotatedAt` stamp (written on rotation and propagated to token-sharing siblings), and every save runs as a read-modify-write transaction under the storage lock that adopts newer on-disk credentials into both the persisted payload and live memory. Files from older builds have no stamp and keep the previous behavior.
- **Refresh queue burned consumed tokens after settlement**: in-flight deduplication protected concurrent callers, but a caller that captured the pre-rotation token just before a rotation and refreshed after it settled re-consumed the single-use token and took a spurious 401. Settled rotations are now remembered for the queue's 30s entry TTL and served to late callers.
- **Mutating tools clobbered concurrent rotation state**: `codex-switch`, `codex-remove`, `codex-label`, and `codex-refresh` loaded the accounts file and saved a mutated snapshot as two independent lock acquisitions, silently overwriting rate-limit/cooldown/active-index state persisted in between. They now mutate and persist inside a single storage transaction against a freshly re-read snapshot (`codex-refresh` applies only the refreshed credential fields after its unlocked network calls).
- **`codex-keychain` migrate/rollback TOCTOU**: neither ran under the storage lock its docstring claimed; rollback's existence check and rename could silently overwrite a rotation save landing in between. Both now run as one critical section, and the keychain entry is deleted only after the rollback rename succeeds.
- **Reasoning effort leaked onto fallback models**: the unsupported-model fallback carried the original model's `reasoning.effort` onto the target, so a `gpt-5.6-sol-max` request degrading to `gpt-5.5` sent `max` to a model that rejects it, turning the graceful degrade into a hard 400. Effort is re-clamped per fallback hop through the transformer's own family rules.
- **Truncated SSE streams misreported as success**: a non-streaming response whose SSE stream ended without any terminal event was returned as the raw SSE text at the original 2xx status — the rotation loop recorded an account success for a failed turn and the client got an unparseable body. Such streams now surface as a 502 `incomplete_stream` error; bodies with no SSE framing still pass through as plain JSON.
- **Uncapped `retry-after` headers**: the body `retry_after_ms`/`retry_after` fields were capped at 5 minutes but the equivalent headers were not, so a bogus header (e.g. `retry-after: 86400`) benched a healthy account for hours, persisted across processes. Header values now get the same cap; quota reset-at headers remain uncapped since those windows legitimately reset hours out.
- **TUI status line trusted idle-stale quota snapshots**: the 5-minute refresh returned any fingerprint-matching shared snapshot as current with no age check, so once the file existed the `/wham/usage` fetch never ran again and an hours-old percentage (with a reset time already in the past) rendered as fresh. Snapshots older than one refresh interval now trigger a live re-fetch and render as stale only as a fallback.
- **`codex-reset` idempotency key regenerated per invocation**: the documented double-spend protection was inert because each attempt sent a fresh random `redeem_request_id`. The key is now derived deterministically from the credit id, so a retry of the same credit is recognizable to the backend; a failed consume POST also reports the redemption outcome as unknown (`redeemed: null`) instead of `false`, since the request may have reached the backend.
- **Proactive refresh skipped tokenless accounts**: the missing-access-token check was unreachable when no expiry was recorded, so such an account only recovered through the reactive path.

## [6.8.0] - 2026-07-14

### Added
- `codex-reset` tool: view banked Codex rate-limit reset credits and redeem one to clear the current usage windows. OpenAI grants eligible plans a small number of reset credits, but exposes redemption only in the Codex desktop app, the IDE extensions, and the Codex CLI `/usage` screen — so users of this plugin, Linux users in particular, had no way to spend a credit they already own without switching tools. The tool wraps the same two endpoints those clients use (`GET /wham/rate-limit-reset-credits`, `POST /wham/rate-limit-reset-credits/consume`), which authenticate exactly like the existing `/wham/usage` call and therefore reuse its credentials, timeout, and error-body sanitization. Redeeming is irreversible and spends a finite credit, so it is never implicit: `action="consume"` only issues the POST when `confirm=true`, and otherwise renders the same preview `dryRun` does. Each redemption carries a fresh `redeem_request_id` so a retry cannot spend two credits, a credit id that is not currently available is refused rather than posted, and once the POST returns, a failure of the follow-up usage read is surfaced as `usageError` alongside `redeemed: true` rather than reporting a spent credit as unredeemed. The listing path is verified against the live backend; the redeem path is covered by tests against a mocked `fetch`. (#193, #195)

### Fixed
- A rate-limit window the server reports as disabled is no longer rendered as a full quota. OpenAI encodes a switched-off window as `window-minutes: 0` / `limit_window_seconds: 0` with `used-percent: 0` rather than omitting it, and both quota paths retained that window because `used-percent` was numeric — surfacing a phantom `quota 100%` segment in the TUI status line next to the real weekly window (`7d 77% · quota 100%`). A window is now rejected on its *explicit* zero length; a window whose length header is *absent* is merely unknown and is still shown under the generic `quota` label. Two sibling defects of the same cause are fixed alongside the reported one: the `/wham/usage` path rounded a zero-second window up to one minute via `Math.max(1, …)`, surfacing a disabled window as a real `1m` limit, and `codex-limits` printed both windows unconditionally, so it showed the same phantom row. Snapshots already written by an older build are filtered on read, so a poisoned `oc-codex-multi-auth-tui-quota.json` heals without the user deleting it. Reported by @aic0d3r, correlated with OpenAI temporarily disabling the 5-hour Codex limit for some paid plans. (#194, #195)

## [6.7.1] - 2026-07-10

### Fixed
- GPT-5.6 requests no longer fail with HTTP 400. The backend rejects any request carrying the `x-openai-internal-codex-responses-lite` header that does not also set `reasoning.context = "all_turns"`, so every `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` turn in 6.7.0 failed with `unsupported_value` on `reasoning.context`. Because that error is not `model_not_supported_with_chatgpt_account`, the `sol → terra → luna → gpt-5.5` degradation never triggered and every turn hard-failed. This matches upstream `codex-rs/core/src/client.rs` (`build_reasoning`), where `context` is set to `AllTurns` exactly when `use_responses_lite` is true and omitted otherwise. The field is written inside the responses-lite reshape, which is applied to a `structuredClone` for lite models only, so the canonical body and the 5.6 → 5.5 fallback remain free of `context`. Reported and fixed by @UnknOownU, verified against the live Codex backend. (#191, #192)

## [6.7.0] - 2026-07-10

### Added
- GPT-5.6 support: `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, plus bare `gpt-5.6` as an alias for the Sol flagship tier. Reasoning-effort support follows the Codex model catalog (`codex-rs/models-manager/models.json`) rather than the launch coverage: Sol and Terra expose `low`/`medium`/`high`/`xhigh`/`max`/`ultra`, Luna stops at `max`, and no tier accepts `none` or `minimal` (both floor to `low`). Requesting `max` or `ultra` on a pre-5.6 model steps down to `xhigh`, then to `high` where `xhigh` is unsupported. `ultra` is accepted as an alias but never reaches the backend — Codex treats it as a client-side tier and rewrites it to `max` before sending (`codex-rs/core/src/client.rs`, `reasoning_effort_for_request`), and the subagent orchestration that distinguishes it lives in the Codex client, not the request body. It is excluded from `ReasoningConfig["effort"]` so the invariant is enforced at compile time. Each tier gets its own model family, keeping per-family rotation and rate-limit state isolated. (#189)
- 5.6 is opt-in: the legacy `gpt-5` alias and the plugin default still resolve to `gpt-5.5` / `gpt-5.4`. Because GPT-5.6 shipped as a limited preview, an account without access degrades `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.6-luna` → `gpt-5.5` through the unsupported-model fallback chain instead of failing every request. (#189)

### Fixed
- GPT-5.6 models are now served over the **responses-lite** request path. Their catalog entry sets `use_responses_lite: true` and `tool_mode: "code_mode_only"`, and Codex sends those models a materially different body: tool definitions move into `input` as a leading `additional_tools` developer item, the base instructions follow as a developer message, top-level `instructions` becomes `""` and `tools` is omitted, `parallel_tool_calls` is forced off, image `detail` fields are stripped, and an `x-openai-internal-codex-responses-lite: true` header is sent. Sending the classic shape to a `code_mode_only` model hands it tools in a field it does not read. The lite shape is applied at serialization, per request attempt, against the model actually being sent — never to the canonical transformed body — so a `gpt-5.6-sol` request that falls back to `gpt-5.5` is re-serialized in the classic shape and keeps its tools rather than stranding them in an `additional_tools` item. (#189)
- System instructions now come from the Codex model catalog instead of the legacy `*_prompt.md` files, for every model the catalog covers (`gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, and the three 5.6 tiers). Modern Codex carries a full `base_instructions` string per model and sends that; the plugin was sending `gpt_5_2_prompt.md` — which opens *"You are GPT-5.2 running in the Codex CLI"* — to `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.5`, so those models received the wrong system prompt and a false identity. Models absent from the catalog (`gpt-5-codex`, `gpt-5.1*`, `gpt-5.2-codex`, `gpt-5.4-nano`, `gpt-5.4-pro`) keep their prompt file, and a catalog miss falls back to the family prompt file. **This changes the system prompt for existing `gpt-5.2` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.5` users.** (#190)
- Catalog instructions cache per model id rather than per family. `gpt-5.5` and `gpt-5.4` share the `gpt-5.4` family but carry different catalog text, so a family-keyed cache let one serve the other's prompt. Cache keys are additionally namespaced (`catalog:` / `family:`) because slug-space and family-space overlap: `gpt-5.4-nano` has no catalog entry but belongs to the `gpt-5.4` family, which is itself a catalog slug — without namespacing the two shared a `memoryCache`/`refreshPromises` key and served each other's instructions inside the 15-minute TTL, reachable through `prewarmCodexInstructions`. Disk paths gained a `catalog-` prefix, which also stops a pre-upgrade prompt-file cache from being read as catalog content, so no migration step is needed. (#190)
- `models.json` (~300KB) is fetched once per release tag and shared across models. `fetchCatalogText` memoizes the result *and* shares the in-flight promise, so the concurrent fan-out in `prewarmCodexInstructions` collapses to a single download instead of one per catalog model. (#190)
- `minimal` reasoning effort no longer reaches the backend for GPT-5.6. It was clamped only inside the Codex branch, which keys off the model name containing `codex` — 5.6 slugs do not, so `gpt-5.6-sol` at `minimal` sent an effort no 5.6 tier accepts. It now floors to `low`, matching the existing `none` → `low` rule. (#189)
- Consolidated four duplicated reasoning-effort suffix regexes into a single helper. `gpt-5.1-codex-max` is a model id that ends in `-max`, not a `max`-effort variant of `gpt-5.1-codex`; the new `max` suffix is guarded by a negative lookbehind scoped to that branch alone, so `gpt-5-codex-low` and `gpt-5.1-codex-max-xhigh` still parse correctly. (#189)

## [6.6.0] - 2026-07-09

### Fixed
- The plugin no longer calls `process.exit()` from its `SIGINT`/`SIGTERM` handler while running inside the opencode host process. Because the handler hard-exited after cleanup, it won the race against opencode's own asynchronous shutdown, so pressing Ctrl+C exited without opencode printing the session id. Process termination is now owned explicitly rather than inferred from the signal: it defaults to off, so the plugin runs its cleanup and leaves termination to the host, and only an entrypoint that *is* the process opts in. The standalone `warm` CLI — the one `bin` path that installs the handler, because refreshing a token persists credentials under the storage lock — opts in via `setShutdownOwnsProcess(true)` and now exits `130`/`143` (`128 + signo`) on a signal instead of reporting `0`, which masked an interrupt as success. The debounced-save flush is still awaited on shutdown in both modes, so the no-lost-rotations guarantee from #110 holds. (#187)
- `runCleanup()` no longer drops work when a drain overlaps. It emptied the cleanup queue *before* awaiting it, so a `beforeExit` firing during an in-flight signal drain returned immediately against an already-empty queue rather than awaiting the real cleanup. Concurrent callers now share the in-flight promise, which is cleared once settled so sequential calls still re-drain — `AccountManager` re-registers its flush handler after an external `runCleanup()`, and that contract is preserved. (#187)

### Added
- `setShutdownOwnsProcess(boolean)` is exported from `lib/shutdown.ts` (and the `lib/index.ts` barrel) so a standalone entrypoint can claim ownership of process termination. The flag is read at signal time, not captured when the handlers are installed, so an entrypoint may opt in after the first `registerCleanup()`. (#187)

## [6.5.0] - 2026-06-30

### Added
- `oc-codex-multi-auth warm` standalone CLI command runs the account warm-up directly — in plain Node via the package `bin`, with no agent/model in the loop and therefore no token cost. It opens every enabled account's rolling usage window (one minimal `POST /codex/responses` each), skips disabled accounts, classifies a quota/usage-limit `429` as a distinct failure rather than "warmed", supports `--json`, and exits non-zero if any account failed. This addresses the request to run the warm-up as a direct command instead of an agent-invoked tool; the in-conversation `codex-warm` tool remains for users who want it mid-session. (#182)

## [6.4.1] - 2026-06-30

### Fixed
- Local token-bucket depletion no longer leaks into persisted, cross-process state. 6.4.0 made a depleted account rotate by writing a short synthetic window into `rateLimitResetTimes` — but that field is saved to the shared accounts file and reloaded by every process, so one process exhausting its own in-memory proactive limiter could spuriously mark a server-healthy account as rate-limited in OTHER concurrent processes (the multi-process/PID-offset deployment this tool targets). Account selection (`sticky`, `hybrid`, `round-robin`) and `getMinWaitTimeForFamily` are now token-bucket-aware directly: a locally-depleted account is skipped in-memory with no persisted state, and an all-depleted pool waits for token refill instead of returning a spurious 503. The local skip also no longer records a server-429-style health penalty, so a busy-but-healthy account is not deprioritized in `hybrid` scoring. (#183)
- `codex-warm` no longer reports a quota-exhausted account as "warmed". A `429` is now classified by reason: a `quota`/`usage_limit` 429 (the window is already spent) is surfaced as a distinct failure, while a transient `tokens`/`concurrent` 429 (window active) still counts as warmed. (#182)

## [6.4.0] - 2026-06-30

### Added
- `rotationStrategy` config (env `CODEX_AUTH_ROTATION_STRATEGY`) selects the account load-balancing algorithm: `hybrid` (default, unchanged — stick to the current account while healthy, else score-select the next), `sticky` (drain-first — stay on one account until it is rate-limited/cooling down, then move to the lowest-indexed available account so load concentrates and the other accounts keep their quota windows in reserve), or `round-robin` (advance through accounts in order). Sticky directly addresses the "all accounts share an initiation time and hit weekly-quota cooldown together" problem under round-robin. (#183)
- `codex-warm` tool primes every enabled account's usage window by sending one minimal billable request (`POST /codex/responses`, the same shape the live request path uses for its quota probe) to each, so the rolling ~5h quota windows start at session start instead of only when rotation eventually lands on each account. A read-only `GET /wham/usage` only reports server-side windows and does not open one, so warming must send a real inference request; the ping is deliberately tiny (reasoning effort `none`, verbosity `low`, no stored conversation) to keep the quota cost negligible. Disabled accounts are skipped; per-account failures are reported without aborting the batch. Complements `codex-switch index=N`, which already switches the active account on demand. (#182)

### Fixed
- An account whose **local** client-side token bucket (the proactive rate limiter) is depleted is now given a short, auto-expiring rate-limit window so account selection rotates off it. Previously the request loop drained the bucket and skipped the account, but the drain-first `sticky` strategy (and the `hybrid` fast-path) re-selected the same depleted account on the next traversal iteration — the `attempted`-set guard then terminated the loop and returned a spurious 503 while other accounts still had quota. The window also feeds `getMinWaitTimeForFamily`, so an all-depleted pool waits for token refill instead of failing fast. (#183)
- `codex-doctor --fix` now clears stale account-health state on accounts whose token refresh succeeds during the repair: an `auth-failure`/`network-error` cooldown and any `rateLimitResetTimes` markers are removed once the refresh proves the credential is alive. Previously `--fix` refreshed the token and tried to switch to the healthiest account, but left the stale cooldown/rate-limit state in place, so no account was eligible and the dead routing persisted — the only recovery was hand-editing `oc-codex-multi-auth-accounts.json`. The stale TUI quota cache is also cleared so diagnostics no longer reference an account index/count that no longer matches the pool. (fixes #171)
- `codex-doctor` now surfaces a finding when a disabled `accountIdSource: "token"` entry shadows an enabled, org-backed account that shares its email (a leftover a fresh re-login can mint instead of updating the org account). It is flagged with a `codex-remove` hint rather than auto-removed, because the only link between the two records is email and email-only merges must not collapse distinct multi-org accounts (#64). (#171)
- `codex-doctor --fix` no longer fails silently when a stored credential is genuinely dead: a failed token refresh now reports `N account(s) need re-login` and points the user at `opencode auth login`, instead of leaving an all-dark pool unrepaired with no surfaced cause. (#171)
- `codex-health` now surfaces the same recovery diagnostics as `codex-doctor` (read-only): it flags accounts blocked only by a stale cooldown/rate-limit (pointing at `codex-doctor --fix`) and disabled token-source duplicates (pointing at `codex-remove`), and includes `staleRecoverableSlots` / `disabledDuplicateSlots` in JSON output. This addresses the part of the issue that named `codex-health` explicitly. (#171)
- A disabled `accountIdSource: "token"` duplicate (a re-login artifact) merging into the real org-source account by email no longer disables the canonical account. Storage dedup now lets the org account's own `enabled` state govern the merge, so a single-account pool can no longer end up dark and unrecoverable; fail-closed is preserved for genuinely user-disabled accounts. (#171)
- Storage dedup now compares account emails case-insensitively, matching the `codex-doctor`/`codex-health` duplicate detectors. Previously `User@Example.com` (org) and `user@example.com` (token re-login) escaped dedup yet were still flagged as removable, so the two layers disagreed on identity. (#171)
- `codex-doctor` and `codex-health` now surface a disabled account that holds a fresh login credential — the fingerprint of a recent re-login that landed on a deliberately-disabled slot — so the user is told to re-enable it if intended instead of getting no signal at all. (#171)
- Caller-cancellation during a retry/backoff wait now surfaces as a proper `AbortError` carrying the caller's `signal.reason`, instead of an opaque `new Error("Aborted")` that dropped the cause. This aligns the retry-wait path with the fetch path and the `isAbortError` convention in `lib/codex-usage.ts`, improving diagnosability of the `Error: Aborted` symptom. (#176)
- Fixed a flaky email-masking property test (#163) that intermittently failed CI: the assertion used a fragile `masked.includes(local)` substring check that false-positived when the local part repeats in the preserved domain (`abc@abc.com`) or contains the mask character itself (`a.*@a.aa` → `a.***`). It now asserts the exact masking contract (masked local = first ≤2 chars + `***`), with deterministic regression cases. No production code change.

### Security
- Bumped `hono` to 4.12.26, resolving a high-severity Windows `serve-static` path traversal via encoded backslash (`%5C`) and four moderate advisories (GHSA-88fw-hqm2-52qc, GHSA-j6c9-x7qj-28xf, GHSA-rv63-4mwf-qqc2, GHSA-wgpf-jwqj-8h8p, GHSA-wwfh-h76j-fc44). This also clears the transitive `@openauthjs/openauth` advisory inherited via hono.
- Overrode `vite` to ^7.3.5, resolving a high-severity `server.fs.deny` bypass on Windows alternate paths and a moderate advisory (GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3) in the dev/test toolchain.
- Overrode `@babel/core` to ^7.29.6 (transitive via `@opentui/solid`), resolving a low-severity arbitrary file read via `sourceMappingURL` (GHSA-4x5r-pxfx-6jf8) without a major version bump.
- Added a `brace-expansion@>=5.0.0 <5.0.6` override to ^5.0.6, resolving a moderate ReDoS-class advisory in the 5.x line. `npm audit` now reports 0 vulnerabilities.

## [6.3.3] - 2026-06-17

### Fixed
- A stored OAuth account whose access token is invalidated server-side returns HTTP 401 (`Your authentication token has been invalidated. Please try signing in again.`), but the request pipeline had no 401 handler, so persisted family routing kept pinning every request to the dead account slot. A request-path 401 is now treated as an account-health failure: the consumed token is refunded, the auth-failure counter is incremented, the refresh-token group is cooled down (or removed past `MAX_AUTH_FAILURES_BEFORE_REMOVAL`), and the request rotates to the next healthy account. The counter is cleared on a successful request so a recovered account does not accumulate stale failures. (#172, fixes #171)
- `codex-health`/`codex-doctor` now flag `token-invalid` on an invalidated-token error (including a generic `401 Unauthorized` body), so `codex-doctor --fix` repairs the active routing without manual `activeIndex` JSON edits. (#172)

## [6.3.2] - 2026-06-10

### Fixed
- `gpt-5.3-codex-spark`, `gpt-5.3-codex`, and `gpt-5.2-codex` are no longer collapsed to `gpt-5-codex` before sending requests. Accounts where only the versioned model is available (not the base `gpt-5-codex`) no longer receive `model_not_supported_with_chatgpt_account` errors. (#170, fixes #169)
- Added `gpt-5.4-fast` and `gpt-5.4-mini-fast` as explicit model map entries so OpenCode fast-variant selectors resolve correctly.
- Reasoning effort `-none` suffix is intentionally absent for the three Codex families above; `getReasoningConfig()` coerces any `none` request to `low` for these models as before.

## [6.1.8] - 2026-04-29

### Fixed
- Local `npm link` installs now run the CLI wrapper correctly by resolving symlinked bin paths before direct-execution detection.
- Current audit validation follow-ups are resolved, including refreshed docs parity coverage.
- Request filtering now defaults missing or null `function_call.arguments` values to `{}` before forwarding.

## [6.1.7] - 2026-04-25

### Added
- OpenCode TUI prompt status plugin that shows the active Codex quota during sessions, including real response-header quota updates, account-aware display, color thresholds, and a quota details command.
- Daily npm update detection now clears the OpenCode-managed plugin cache on exit when a newer package version is available, so restarting OpenCode installs the latest plugin automatically.

### Changed
- The installer now manages OpenCode `tui.json` alongside the main plugin config so the TUI status module is available from the published package.
- TUI startup keeps the home prompt clean and only shows quota status inside active sessions.
- Added an `autoUpdate` config option and `CODEX_AUTH_AUTO_UPDATE=0` environment override for users who prefer manual update prompts.

### Fixed
- Quota status cache writes no longer block the request response path and coalesce rapid duplicate writes.
- Account switching clears stale TUI quota state so the next session reflects the selected account.
- Multi-account quota status now follows the actual account used by the latest request, including non-`codex` model families, so real response-header quota snapshots are not filtered out as stale.

## [6.1.6] - 2026-04-24

### Added
- OpenCode TUI prompt status plugin that shows the active Codex quota during sessions, including real response-header quota updates, account-aware display, color thresholds, and a quota details command.

### Changed
- The installer now manages OpenCode `tui.json` alongside the main plugin config so the TUI status module is available from the published package.
- TUI startup keeps the home prompt clean and only shows quota status inside active sessions.

### Fixed
- Quota status cache writes no longer block the request response path and coalesce rapid duplicate writes.
- Account switching clears stale TUI quota state so the next session reflects the selected account.
- Multi-account quota status now follows the actual account used by the latest request, including non-`codex` model families, so real response-header quota snapshots are not filtered out as stale.

## [6.1.5] - 2026-04-24

### Changed
- Default installer mode now writes the compact OAuth model catalog so OpenCode's model picker shows base models only; reasoning depth is selected through the variant picker.
- Added `--full` installer mode for users who still want explicit selector IDs such as `gpt-5.5-medium` and `gpt-5.5-fast-medium` installed into the model picker.
- Compact/default installs now prune explicit preset IDs and stale base model IDs from earlier catalogs so rerunning the installer actually cleans up the model picker.

## [6.1.4] - 2026-04-24

### Fixed
- Ship the `gpt-5.5-fast` modern config entry and explicit `gpt-5.5-fast-{none,low,medium,high,xhigh}` legacy selectors so OpenCode resolves `openai/gpt-5.5-fast-medium` before plugin routing.
- Clear OpenCode's newer package cache layout at `~/.cache/opencode/packages/{oc-codex-multi-auth,oc-chatgpt-multi-auth}@latest` during installer cache refresh.
- Normalize stale managed file-path and `file:///.../node_modules/...` plugin entries back to the official `oc-codex-multi-auth` package name when the installer runs.

## [6.1.3] - 2026-04-24

### Added
- Explicit `gpt-5.5-fast` / `gpt-5.5-fast-{none,low,medium,high,xhigh}` entries in the model map, normalizing to `gpt-5.5`. Without the explicit map entry, picking OpenCode's built-in `GPT-5.5 Fast` catalog item fell through the regex fallback with no per-model config lookup, which contributed to the `All N account(s) failed (server errors or auth issues)` symptom.
- Scoped auto-fallback for GPT-5.5: when the backend returns `model_not_supported_with_chatgpt_account` for `gpt-5.5`, the plugin now routes the retry to `gpt-5.4` automatically, even without `unsupportedCodexPolicy: "fallback"` or `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback`. Opt out with `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1`. Legacy family fallback behavior is unchanged.

### Removed
- **GPT-5.5 Pro** model map entries (`gpt-5.5-pro`, `gpt-5.5-pro-{medium,high,xhigh}`, `gpt-5.5-pro-20260423*`), config template entries in `config/opencode-modern.json` and `config/opencode-legacy.json`, the `GPT_55_PRO_MODEL_ID` constant, the `gpt-5.5-pro -> gpt-5.5` fallback chain edge, and the related request-transformer / prompt-family branches. Per OpenAI's 2026-04-23 launch, GPT-5.5 Pro ships to ChatGPT only, not Codex; routing `gpt-5.5-pro*` through the Codex OAuth pipeline was producing `model_not_supported_with_chatgpt_account` on every pooled account. Any user-typed `gpt-5.5-pro*` still canonicalizes to `gpt-5.5` so the scoped auto-fallback chain can rescue it.

### Fixed
- The terminal aggregator message in `index.ts` no longer misreports across-the-pool entitlement 400s as `server errors or auth issues`. When `lastErrorCategory === "unsupported-model"` at exhaustion, the response now names the model and points to the fallback env var.
- Pre-existing `lib/request/fetch-helpers.ts` typecheck regression from the 6.1.2 release: `shouldRefreshToken(auth: Auth, ...)` referenced an `Auth` type that had been removed from the SDK import. Re-imported `Auth` from `@opencode-ai/sdk`.

## [6.1.2] - 2026-04-24

### Added
- GPT-5.5 2026-04-23 release presets in the shipped OpenCode config templates.

### Changed
- Activate GPT-5.5 2026-04-23 across runtime model routing and align the runtime model mapping with the new release family.

### Fixed
- Handle GPT-5.5 gating by falling back cleanly when the requested release is unavailable upstream.

## [6.1.1] - 2026-04-22

### Fixed
- Retry structured `service_unavailable_error` / `server_is_overloaded` payloads as server faults even on non-5xx responses, while preserving overload `retry_after` backoff when the account pool is exhausted.
- Retry live upstream `server_error` payloads that arrive on non-5xx responses instead of falling straight through as unrecoverable failures.
- Stabilize merged retry regression coverage so the overload and live `server_error` fetch-loop cases do not leak module state between tests.

## [6.1.0] - 2026-04-17

### Added
- `codex-keychain` opt-in OS-keychain credential backend via `CODEX_KEYCHAIN=1` (macOS Keychain / Windows Credential Manager / Linux libsecret) (#132, #133, #134)
- `codex-diag` redacted diagnostics snapshot tool for bug reports (#126)
- `codex-diff` redacted config/account comparator (#129)
- `NO_COLOR` and `FORCE_COLOR` environment-variable support in UI rendering (#126)
- Multi-worktree collision detection with non-blocking warning (#130)
- Circuit-breaker half-open gate wired into request pipeline (#123)
- 20-scenario chaos fault-injection test suite (#128)
- Contract tests pinning OpenAI OAuth, Codex chat, and Codex SSE response shapes (#131)
- Dependabot, OpenSSF Scorecard, commit-msg hook, and release-please automation (#125, #127)
- CI matrix: Node 18/20/22 on Ubuntu + Node 20 on Windows (#111)
- Typed error hierarchy (BaseError + domain classes) in `lib/errors.ts` (#120)

### Changed
- Refactor: `index.ts` reduced from 5975 to 3425 lines; all 18 tools extracted to `lib/tools/*` (#115, #121)
- Refactor: `lib/storage.ts` split from 1419 to 79 lines across 12 submodules under `lib/storage/` (#116)
- Refactor: `AccountManager` split into 4 domain services (state, persistence, rotation, recovery) (#122)
- Refactor: `lib/recovery.ts` consolidated to barrel pattern (#117)
- Refactor: renamed `lib/runtime-contracts.ts` into `lib/oauth-constants.ts` + `lib/error-sentinels.ts` (#118)
- Refactor: Zod-validate remaining process boundaries (#119)
- Removed dead modules `lib/auth-rate-limit.ts` and `lib/audit.ts` (854 lines total) (#109)

### Fixed
- **CRITICAL**: Serialize `incrementAuthFailures` via per-refresh-token promise chain to prevent lost auth-failure counts across shared refresh tokens (#108)
- Destructive defaults: `importAccounts` defaults to timestamped backup; `exportAccounts` defaults to `force: false`; `codex-remove` tool requires explicit `confirm: true` (#108)
- Shutdown SIGINT/SIGTERM now awaits debounced `flushPendingSave`, preventing lost rotations (#110)
- `schemaVersion > 3` now throws `StorageError(UNSUPPORTED_SCHEMA_VERSION)` instead of silently nulling data (#110)
- V2 storage files are detected and either migrated or rejected explicitly (no more silent drop) (#113)
- Credential merge: `||` â†’ `??` prevents empty-string tokens resurrecting stale older values (#112)
- `REDIRECT_URI` uses `127.0.0.1` literal for RFC 8252 compliance (#112)
- Codex-CLI cross-process JSON now Zod-validated before merging (#112)
- Logger `TOKEN_PATTERNS` extended to cover OpenAI opaque refresh/access/id tokens (#112, #126)
- Installer `scripts/install-oc-codex-multi-auth-core.js` deep-merges `provider.openai` instead of clobbering user customizations; added `--dry-run` (#114)
- F1 keychain post-merge: partial-migration staleness + `clearAccounts` ordering + rollback silent-clobber + lexicographic-sort bug (#133, #134)

### Documentation
- Full-repository audit delivered in `docs/audits/` (#107)
- README: added CI, Node, Scorecard, npm, license badges; new `Credential Storage` section (#124, #132)
- CONTRIBUTING: local development, contract-fixture update, real-keychain testing sections (#124, #131, #132)
- SECURITY: backend threat-model update (#132)
- ARCHITECTURE.md refreshed to reflect v6 module layout (#124)
- CHANGELOG: restructured to Keep-a-Changelog v1.1.0 (#124)

### Internal
- Per-file coverage floor (70%) for `lib/**` and `index.ts` in `vitest.config.ts` (#125)
- Test count: 2088 â†’ 2234 (+146 regression + chaos + contract tests)

## [6.0.0] - 2026-04-06

### Added

- **beginner operations toolkit**: added `codex-help`, `codex-setup` (with `wizard` mode + fallback), `codex-doctor` (`fix` mode), and `codex-next` for guided onboarding and recovery.
- **account metadata commands**: added `codex-tag` and `codex-note`, plus `codex-list` tag filtering.
- **interactive account pickers**: `codex-switch`, `codex-label`, and `codex-remove` now support optional index with interactive selection in compatible terminals.
- **backup/import safety controls**: `codex-export` now supports auto timestamped backup paths; `codex-import` adds `dryRun` preview and automatic pre-import backup on apply.
- **beginner safe mode config**: new `beginnerSafeMode` config key and `CODEX_AUTH_BEGINNER_SAFE_MODE` env override for conservative retry behavior.
- **startup preflight summary**: one-time startup health summary with recommended next action.
- **breaking rebrand migration**: current runtime storage now uses package-aligned files (`oc-codex-multi-auth-accounts.json`, `oc-codex-multi-auth-flagged-accounts.json`) with automatic migration from legacy package-era and pre-package storage names on first load.

### Changed

- **account storage schema**: V3 account metadata now includes optional `accountTags` and `accountNote`.
- **docs refresh for operational flows**: README + docs portal/development guides updated to reflect beginner commands, safe mode, interactive picker behavior, and backup/import safeguards.
- **repository presentation refresh**: rewrote the README as a landing page, added a public FAQ and code of conduct, refreshed package metadata, and removed stale CI/test claims from public docs surfaces.
- **test matrix expansion**: coverage now includes beginner UI helpers, safe-fix diagnostics edge cases, tag/note command behavior, and timestamped backup/import preview utilities.
- **package line renamed**: the supported package, repo, plugin entry, installer surface, and docs now use `oc-codex-multi-auth` instead of `oc-chatgpt-multi-auth`.
- **codex-first auth wording**: OAuth options, installer guidance, and onboarding docs now describe the Codex-first flow directly instead of the older MULTI-branded labels.

### Fixed

- **non-interactive command guidance**: optional-index commands provide explicit usage guidance when interactive menus are unavailable.
- **doctor safe-fix edge path**: `codex-doctor fix` now reports a clear non-crashing message when no eligible account is available for auto-switch.
- **first-time import flow**: `codex-import` no longer fails with `No accounts to export` when storage is empty; pre-import backup is skipped cleanly in zero-account setups.
- **installer cache hygiene**: the installer now removes both the old and new package names from OpenCode cache metadata so cutover installs do not stay pinned to stale artifacts.

## [5.4.8] - 2026-03-24

### Added

- **json codex-ops automation surfaces**: read-only Codex ops now support `format="json"` and expose routing visibility across status, metrics, dashboard, and doctor flows.
- **device-code login flow**: added a first-party ChatGPT device-code auth path for SSH, WSL, and other headless environments.

### Changed

- **login finalization parity**: regular OAuth, manual fallback, and device-code flows now share the same account-selection and persistence helpers.
- **runtime contract parity hardening**: centralized timeout, deactivated-workspace, and OAuth callback constants with dedicated runtime/doc parity coverage.
- **dependency audit cleanup**: refreshed the shipped dependency tree with updated `hono` and pinned audit overrides for deterministic audit resolution.

### Fixed

- **storage import contract drift**: preview and apply import flows now share one analysis path, keeping deduplication and count reporting aligned while preserving redacted backup failure reporting.
- **deactivated workspace rotation**: grouped refresh-token variants are removed together, traversal restarts onto healthy accounts, and the zero-removal fallback cools down the affected account safely.

## [5.4.3] - 2026-03-06

### Added

- **gpt-5.4 snapshot alias normalization**: added support for `gpt-5.4-2026-03-05*` and `gpt-5.4-pro-2026-03-05*` model IDs (including effort suffix variants).

### Changed

- **legacy GPT-5 alias target updated**: `gpt-5`, `gpt-5-mini`, and `gpt-5-nano` now normalize to `gpt-5.4` as the default general family.
- **gpt-5.4-pro family isolation**: prompt-family detection now keeps `gpt-5.4-pro` separate from `gpt-5.4` for independent prompt/cache handling while preserving fallback policy behavior (`gpt-5.4-pro -> gpt-5.4`).
- **OpenCode 5.4 template limits updated**: shipped OpenCode config templates now set `gpt-5.4*` context to `1,000,000` (output remains `128,000`) and docs now include optional `model_context_window` / `model_auto_compact_token_limit` tuning guidance.

### Fixed

- **5.4.3 regression/test coverage alignment**: expanded and corrected normalization, family-routing, and prompt-mapping tests for snapshot aliases, pro-family separation, and legacy alias behavior.

## [5.4.2] - 2026-03-05

### Added

- **gpt-5.4 + gpt-5.4-pro runtime support**: added model-map normalization and request-transform coverage for `gpt-5.4` (general) and optional `gpt-5.4-pro`.
- **gpt-5.4-pro fallback edge**: default unsupported-model fallback chain now includes `gpt-5.4-pro -> gpt-5.4` when fallback policy is enabled.

### Changed

- **template defaults updated to gpt-5.4**: modern + legacy config templates now use `gpt-5.4` variants as the default general-purpose family.
- **docs refresh for 5.4 rollout**: README, getting-started, configuration, troubleshooting, docs index, and config docs now reflect `gpt-5.4` defaults and optional `gpt-5.4-pro` usage.
- **test matrix expanded for 5.4**: unit, integration, and property tests now explicitly cover `gpt-5.4` and `gpt-5.4-pro` normalization/reasoning/fallback paths.

### Fixed

- **quota probe model order**: quota snapshot probing now includes `gpt-5.4` first before legacy Codex probe models.

## [5.4.0] - 2026-02-28

### Changed

- **organization/account identity matching hardening**: org-scoped matching and collision pruning now enforce accountId-aware compatibility to preserve distinct same-org workspace identities.
- **id-token organization binding source strictness**: id-token candidate org binding now prioritizes `idToken['https://api.openai.com/auth'].organizations[0].id`.

### Fixed

- **organization-scoped account preservation**: account restoration now preserves organization/workspace identity across token refresh and flagged-account recovery paths.
- **no-org duplicate collapse alignment**: fallback no-org duplicates now collapse consistently across storage, authorize, and prune operations.
- **active-index remap stability**: index remapping during collision pruning/dedupe maintains stable active-index selection after account deduplication.

## [5.3.0] - 2026-02-22

### Added

- **workspace-aware account persistence**: oauth workspace candidates are preserved as distinct account entries to keep per-workspace routing stable across multi-account sessions.

### Fixed

- **organization identity reconciliation**: account restoration now preserves organization/workspace identity across token refresh and flagged-account recovery paths.
- **verify-flagged restore identity loss**: flagged-account restore no longer drops `organizationId` when an `accountId` already exists.

### Changed

- **documentation alignment with current runtime structure**: refreshed README and docs portal/architecture guides to reflect native-vs-legacy request transforms, workspace-aware identity behavior, and current preset/test counts.

## [5.2.3] - 2026-02-21

### Fixed

- **tool-call compatibility with current OpenCode runtime**: default request handling now preserves native OpenCode payload/tool definitions, avoiding bridge-side alias rewrites that could trigger invalid tool-call schemas.
- **bridge/tool-name drift failures**: Codex bridge instructions now anchor on the runtime-provided tool manifest and explicitly avoid translating/inventing tool names.

### Changed

- **request transform mode control**: added `requestTransformMode` (`native` default, `legacy` opt-in) plus `CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy` for compatibility fallback.
- **legacy codex-mode scope**: Codex compatibility rewrites and bridge prompt shaping are now legacy-mode behavior; native mode keeps host request shape unchanged.

## [5.2.1] - 2026-02-20

### Fixed

- **tool mapping conflicts in codex bridge/remap prompts**: removed contradictory guidance that treated `patch` as forbidden and aligned instructions so `apply_patch` intent maps to `patch` (preferred) or `edit` for targeted replacements.
- **OpenCode codex prompt source brittleness**: prompt fetch now retries across multiple upstream source URLs instead of relying on a single path that could return 404.

### Changed

- **prompt fetch configurability**: added `OPENCODE_CODEX_PROMPT_URL` override support and source-aware cache metadata so ETag conditional requests stay bound to the same source.
- **regression coverage + docs wording**: updated prompt assertions/tests for the new `patch`+`edit` policy and refreshed architecture documentation text to match.

## [5.2.0] - 2026-02-13

### Added

- **gpt-5.3-codex-spark normalization + routing**: added internal model mapping/family support for `gpt-5.3-codex-spark` and Spark reasoning variants.
- **generic unsupported-model fallback engine**: entitlement rejections now support configurable per-model fallback chains via `fallbackOnUnsupportedCodexModel` and `unsupportedCodexFallbackChain`.

### Changed

- **unsupported-model policy defaults**: introduced `unsupportedCodexPolicy` (`strict`/`fallback`) with strict mode as default; legacy `fallbackOnUnsupportedCodexModel` now maps to policy behavior.
- **entitlement handling flow**: on unsupported-model errors, plugin now tries remaining accounts/workspaces before model fallback, improving Spark entitlement discovery across multi-account setups.
- **fast-session reasoning summary**: fast mode now uses `reasoning.summary = "auto"` (invalid/legacy summary values sanitize to `auto`).
- **legacy fallback compatibility**: `fallbackToGpt52OnUnsupportedGpt53` / `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` now act as a legacy edge toggle inside the generic fallback flow.
- **documentation refresh**: README, configuration, getting-started, troubleshooting, and config template docs now describe strict/fallback controls, Spark entitlement gating, and optional manual Spark template additions.

## [5.1.1] - 2026-02-08

### Fixed

- **provider-prefixed model config resolution**: `openai/<model>` ids now correctly resolve to their base model config instead of falling back to global defaults.
- **codex variant option merging**: variant suffixes like `-xhigh` now apply `models.<base>.variants.<variant>` options during request transformation.

## [5.1.0] - 2026-02-08

### Changed

- **workspace candidate selection hardened**: OAuth workspace auto-selection now prefers org defaults, id-token-selected workspace IDs, and non-personal org candidates before falling back to token-derived personal IDs.

### Fixed

- **business workspace routing**: explicit org/manual workspace bindings are now preserved at request time and no longer overwritten by token `chatgpt_account_id` values.
- **gpt-5.3-codex on Business accounts**: fixed a dual-workspace path where requests could be routed to personal/free workspace IDs and fail with unsupported-model errors.

## [5.0.0] - 2026-02-08

### Changed (BREAKING)

- **auth login interaction redesigned**: `opencode auth login` now defaults to the Codex-style dashboard flow (actions/accounts/danger zone) instead of the legacy add/fresh-only prompt.
- **styled codex tool output default**: `codex-list`, `codex-status`, `codex-health`, `codex-switch`, `codex-remove`, `codex-refresh`, `codex-export`, and `codex-import` now default to the new Codex TUI formatting; scripts parsing legacy plain output should update or set `codexTuiV2: false`.

### Added

- **codex tui runtime controls**: new config + env options for UI behavior: `codexTuiV2`, `codexTuiColorProfile`, `codexTuiGlyphMode`, `CODEX_TUI_V2`, `CODEX_TUI_COLOR_PROFILE`, and `CODEX_TUI_GLYPHS`.
- **full account dashboard actions**: interactive login now supports add/check/deep-check/verify-flagged/start-fresh, plus account-level actions (enable/disable, refresh, delete).
- **dedicated flagged storage**: introduced `openai-codex-flagged-accounts.json` with automatic migration from legacy `openai-codex-blocked-accounts.json`.
- **ui architecture + coverage**: added shared terminal UI runtime/theme/format modules and parity documentation (`TUI_PARITY_CHECKLIST.md`) with focused tests.

### Fixed

- **disabled account safety**: disabled accounts are now excluded from active/current selection and rotation paths.
- **enabled-flag migration**: `enabled` account state now survives v1->v3 storage migration and persists reliably across save/load cycles.

## [4.14.2] - 2026-02-08

### Changed

- **gpt-5.3 fallback default**: fallback from `gpt-5.3-codex` to `gpt-5.2-codex` on ChatGPT entitlement rejection is now enabled by default for all users.
- **strict-mode opt-out**: strict behavior is now opt-out via `fallbackToGpt52OnUnsupportedGpt53: false` or `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0`.

### Fixed

- **unsupported-model handling**: normalized the upstream 400 (`"not supported when using Codex with a ChatGPT account"`) to a clear entitlement-style error instead of generic bad-request handling.

## [4.14.1] - 2026-02-07

### Added

- **fast session mode**: optional low-latency tuning (`fastSession`) with `hybrid`/`always` strategies and configurable history window (`fastSessionMaxInputItems`).

### Changed

- **prompt caching**: codex + opencode bridge prompts now use stale-while-revalidate + in-memory caching; startup prewarms instruction caches to reduce first-turn latency.
- **request parsing**: fetch pipeline now normalizes `Request` inputs and supports non-string bodies (Uint8Array/ArrayBuffer/Blob) without failing request transformations.

### Fixed

- **trivial-turn overhead**: in fast session mode, trivial one-liners can omit tool definitions and compact instructions to reduce roundtrip time.

## [4.14.0] - 2026-02-05

### Added

- **gpt-5.3-codex model support**: added end-to-end normalization and routing for `gpt-5.3-codex` with `low`, `medium`, `high`, and `xhigh` variants.
- **new codex family key**: account rotation/storage now tracks `gpt-5.3-codex` independently in `activeIndexByFamily`.

### Changed

- **reasoning defaults**: `gpt-5.3-codex` now defaults to `xhigh` effort (matching the current codex-family behavior), and `none`/`minimal` are normalized to supported codex levels.
- **prompt fetch/cache mapping**: prompt family detection now …92 tokens truncated…atency counters for the current plugin process.
- **401 diagnostics payload**: normalized 401 errors now include `diagnostics` (for example `requestId`, `cfRay`, `correlationId`, `threadId`) to speed up debugging.
- **stream watchdog controls**: new `fetchTimeoutMs` and `streamStallTimeoutMs` config options (and env overrides) for upstream timeout tuning.

### Changed

- **request correlation**: each upstream fetch now sets a correlation id, reuses `CODEX_THREAD_ID`/`prompt_cache_key` when available, and clears scope after each request.
- **plan-mode tool gating**: `request_user_input` is automatically stripped from tool definitions when collaboration mode is Default (kept in Plan mode).
- **safety prompt hardening**: bridge/remap prompts now explicitly block destructive git commands unless the user asks for them.
- **gpt-5.2-codex default effort**: default reasoning now prefers `xhigh` when no explicit effort/variant is provided.
- **gitignore hygiene**: local planning/release scratch artifacts are now ignored to keep working trees clean.

### Fixed

- **non-stream SSE hangs**: non-streaming SSE parsing now aborts stalled reads instead of waiting indefinitely.

## [4.12.5] - 2026-02-04

### Changed

- **per-project storage location**: project-scoped account files now live under `~/.opencode/projects/<project-key>/openai-codex-accounts.json` instead of writing into `<project>/.opencode/`.

### Added

- **legacy migration**: when the new project-scoped path is empty, the plugin now auto-migrates legacy `<project>/.opencode/openai-codex-accounts.json` data on first load.

## [4.12.4] - 2026-02-03

### Added

- **Empty response retry** - Automatically retries when the API returns empty/malformed responses. Configurable via `emptyResponseMaxRetries` (default: 2) and `emptyResponseRetryDelayMs` (default: 1000ms)
- **PID offset for parallel agents** - When multiple OpenCode instances run in parallel, each process now gets a deterministic offset for account selection, reducing contention. Enable with `pidOffsetEnabled: true`

### Changed

```json
{
  "emptyResponseMaxRetries": 2,
  "emptyResponseRetryDelayMs": 1000,
  "pidOffsetEnabled": false
}
```

- Environment variables:
- `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES`
- `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS`
- `CODEX_AUTH_PID_OFFSET_ENABLED`

- **Test coverage** - 1516 tests across 49 files (up from 1498)

### Fixed

- **PID offset formula** - Fixed bug where all accounts received the same offset (now uses `account.index * 0.131 + pidBonus` for unique distribution)
- **Empty response detection** - Hardened `isEmptyResponse()` to correctly identify empty choice objects (`[{}]`) and whitespace-only content as empty
- **Test mocks** - Fixed `index.test.ts` mocks for `createLogger` and new config getters (55 tests were failing)

### Notes
- npm publish status: not published on npm (tag/release only).

## [4.12.3] - 2026-02-03

### Changed

- **Test coverage** - Up to 89% coverage (1498 tests)
- **Code quality** - Various improvements from audit

### Fixed

- **Account persistence fix** - Accounts were being saved to the wrong location when `perProjectAccounts` was enabled (default). The issue was that `setStoragePath()` only ran in the loader, but authorize runs before that. So accounts got written to the global path, then the loader looked in the per-project path and found nothing. Both OAuth methods (browser and manual URL paste) now init storage path before saving. (#19)

## [4.12.2] - 2026-01-30

### Fixed

- **TUI crash on workspace prompt** - Removed redundant workspace selection prompt (auto-selects default now). Added `isNonInteractiveMode()` to detect TUI/Desktop environments. (#17)
- **Web UI validation error** - Added validate function to manual OAuth flow for proper error messages instead of `[object Object]`.

## [4.12.1] - 2026-01-30

### Changed

- **Audit logging** - Rotating file audit log with structured entries
- **Auth rate limiting** - Token bucket rate limiting (5 req/min/account) 
- **Proactive token refresh** - Refreshes tokens 5 minutes before expiry
- **Zod schemas** - Runtime validation as single source of truth

- ### Stats
- **Tests**: 580 Ã¢â€ â€™ 631 (+51)
- All passing on Windows with `--pool=forks`

### Fixed

- **Business plan workspace fix** - Fixed the "usage not included" errors some Business plan users were hitting. Turns out we were sending a stale stored accountId instead of pulling the fresh one from the token - problematic when you've got multiple workspaces. (#17, h/t @alanzchen for the detailed trace)
- **Persistence errors actually visible now** - Storage failures used to fail silently unless you had debug mode on. Now you get a proper error toast with actionable hints (antivirus exclusions on Windows, chmod suggestions on Unix). (#19)
- **Atomic writes for account storage** - Switched to temp file + rename to avoid corrupted state if a write gets interrupted mid-flight.
- **Fixed a reader lock leak** - The SSE response handler wasn't releasing its lock in the finally block. Small thing but could cause issues over time.
- **Debug logging for rotation** - Added some visibility into which account gets picked and why during rotation.

## [4.12.0] - 2026-01-30

### Changed (BREAKING)

- **tool rename**: all `openai-accounts-*` tools renamed to shorter `codex-*` prefix:
  - `openai-accounts` â†’ `codex-list`
  - `openai-accounts-switch` â†’ `codex-switch`
  - `openai-accounts-status` â†’ `codex-status`
  - `openai-accounts-health` â†’ `codex-health`
  - `openai-accounts-refresh` â†’ `codex-refresh`
  - `openai-accounts-remove` â†’ `codex-remove`

### Added

- **codex-export**: export all accounts to a portable JSON file for backup or migration
- **codex-import**: import accounts from a JSON file, merges with existing accounts (skips duplicates)

## [4.11.2] - 2026-01-30

### Fixed

- **windows account persistence**: fixed silent failure when saving accounts on Windows. errors are now logged at WARN level with storage path in message, and a toast notification appears if persistence fails.

## [4.11.1] - 2026-01-29

### Changed

- This plugin provides 6 built-in tools for managing your OpenAI accounts. Just ask the agent or type the tool name directly.

- | Tool | What It Does | Example Prompt |
- |------|--------------|----------------|
- | `openai-accounts` | List all accounts | "list my accounts" |
- | `openai-accounts-switch` | Switch active account | "switch to account 2" |
- | `openai-accounts-status` | Show rate limits & health | "show account status" |
- | `openai-accounts-health` | Validate tokens (read-only) | "check account health" |
- | `openai-accounts-refresh` | Refresh & save tokens | "refresh my tokens" |
- | `openai-accounts-remove` | Remove an account | "remove account 3" |

### Fixed

- **Zod validation error** - Fixed crash when calling `openai-accounts-status` with no accounts configured

## [4.11.0] - 2026-01-29

### Added

- **Subdirectory detection** - Per-project accounts now work from subdirectories. The plugin walks up the directory tree to find the project root (identified by `.git`, `package.json`, `pyproject.toml`, etc.)
- **Live countdown timer** - Rate limit waits now show a live countdown that updates every 5 seconds: `Waiting for rate limit reset (2m 35s remaining)`
- **Auto-remove on auth failure** - Accounts are automatically removed after 3 consecutive auth failures, with a notification explaining what happened. No more manual cleanup of dead accounts.
- **openai-accounts-refresh tool** - Manually refresh all OAuth tokens to verify they're still valid

## [4.10.0] - 2026-01-29

### Added
- **per-project accounts**: each project gets its own account storage now. no more conflicts when working across different repos with different chatgpt accounts. auto-detects project directories (looks for .git, package.json, etc). falls back to global storage if you're not in a project folder.
- **configurable toast duration**: rate limit notifications stick around longer now (5s default). set `toastDurationMs` in config if you want them longer/shorter.
- **account removal tool**: new `openai-accounts-remove` tool to delete accounts by index. finally.
- **token masking in logs**: all tokens, api keys, and bearer headers are now masked in debug logs. no more accidentally leaking creds.

### Changed
- **account limit bumped to 20**: was 10, now 20. add more accounts if you need them.
- **per-project accounts default on**: `perProjectAccounts` defaults to `true` now. disable with `perProjectAccounts: false` in config if you want the old global behavior.

### Fixed
- **token refresh race condition**: added `tokenRotationMap` to prevent concurrent refresh requests from stepping on each other.
- **rate limit retry jitter**: 20% jitter on retry delays to prevent thundering herd.
- **apply_patch infinite loop**: removed apply_patch references from codex bridge that caused loops in some edge cases.

### Notes
new options in `~/.opencode/openai-codex-auth-config.json`:
```json
{
  "perProjectAccounts": true,
  "toastDurationMs": 5000
}
```

env vars:
- `CODEX_AUTH_PER_PROJECT_ACCOUNTS=1` - enable per-project accounts
- `CODEX_AUTH_TOAST_DURATION_MS=8000` - set toast duration in ms

## [4.9.7] - 2026-01-29

### Fixed
- business/team workspace selection: detect multiple workspace account IDs from oauth tokens and prompt for the correct one.
- prevent refresh/hydration from overwriting selected workspace ids (org/manual choices remain stable).
- persist workspace labels and sources for clearer account listings.

### Added
- `CODEX_AUTH_ACCOUNT_ID` override to force a specific workspace id (non-interactive login).
- troubleshooting guidance for "usage not included in your plan".

## [4.9.6] - 2026-01-27

### Changed

- **tui auth gating**: non-tty/ui auth attempts now return a clear instruction to run `opencode auth login` in a terminal shell.
- **error-mapping simplification**: consolidated entitlement/rate-limit mapping in fetch helpers for a single handling path.

## [4.9.5] - 2026-01-28

### Changed

- When your ChatGPT subscription didn't include Codex access, the plugin kept rotating through all accounts and retrying forever because it thought it was a temporary rate limit.

- You get an immediate, clear error: "This model is not included in your ChatGPT subscription."

### Fixed

- **Account error handling** - Fixes infinite retry loop when account doesn't have access to Codex models. `usage_not_included` errors now return 403 Forbidden instead of being treated as rate limits. Clear error message explaining the subscription issue. Prevents pointless account rotation for non-recoverable errors. (#16, thanks @rainmeter33-jpg!)

## [4.9.4] - 2026-01-27

### Added

- **TUI auth flow disabled** - We now strictly enforce using `opencode auth login` in the terminal for authentication. The UI-based 'Connect' flow is disabled with a clear message to prevent issues with non-interactive environments.

### Changed

- **Strict tool schema validation** - Added filtering of required fields, flattening enums for compatibility with strict models like Claude/Gemini

### Fixed

- **Manual login fixed** - Parsing of OAuth URLs with fragments (`#code=`) is fixed
- **Account switching** - Manual selection is now strictly prioritized over rotation logic
- **apply_patch enabled** - The bridge prompt now allows the `apply_patch` tool

## [4.9.3] - 2026-01-27

### Changed

- **Strict schema validation** - Ported robust tool cleaning logic from `antigravity-auth`. Automatically normalizes tool definitions to prevent errors with strict models (like Claude or Gemini):
  - Filters out `required` fields that are not defined in `properties`
  - Flattens `anyOf` schemas with `const` values into standard `enum` arrays
  - Converts nullable array types into single types with a description note
  - Injects placeholder properties for empty object parameters
- **Enabled apply_patch** - Updated the Codex bridge prompt to allow the `apply_patch` tool

### Fixed

- **Manual login fixed** - The plugin now correctly parses OAuth redirect URLs that use fragments (e.g., `#code=...`). Previously, it only looked for query parameters, which caused manual copy-paste logins to fail with a redirection error.
- **Account switching logic** - Changed account selection logic to strictly respect your manual choice. Before this fix, the hybrid rotation algorithm would sometimes override your selection based on account health or token scores.
- **TUI integration** - Implemented the missing event handler for the TUI. When you click an account in the interface, it now triggers the `openai.account.select` event, saves the new active index to disk, and shows a confirmation toast.
- **Removed API key option** - Removed the 'API Key' authentication method from the list because this plugin is designed for OAuth only.

## [4.9.2] - 2026-01-27

### Fixed

- **Auth prompts moved to TUI** - Avoids readline input conflicts
- **Error payload normalization** - Improves rate-limit handling and rotation

### Notes
- npm publish status: not published on npm (tag/release only).

## [4.9.1] - 2026-01-26

### Changed

- When `opencode auth login` called the authorize function, `inputs` was `undefined`. The code had a conditional check that only entered the multi-account while loop if `inputs` existed with keys. This caused only single-account flow to run.

### Fixed

- **Multi-account flow always runs** - authorize() now always uses multi-account flow regardless of inputs parameter. (#12)

- Removed the conditional check so multi-account flow always runs, allowing users to add multiple ChatGPT accounts.

## [4.9.0] - 2026-01-26

**breaking: package renamed from `opencode-openai-codex-auth-multi` to `oc-chatgpt-multi-auth`**

### Changed
- **package renamed** to bypass opencode's plugin blocking. opencode skips any plugin with `opencode-openai-codex-auth` in the name. the new name `oc-chatgpt-multi-auth` works correctly.
- updated all documentation, configs, and references to use new package name.
- added `multiAccount` flag check in loader to coexist with opencode's built-in auth.

### Fixed
- removed debug console.log statements from loader.
- plugin now properly detects when it should handle auth vs deferring to built-in.

### Notes
update your `~/.config/opencode/opencode.json`:
```json
{
  "plugin": ["oc-chatgpt-multi-auth@latest"]
}
```

## Legacy 4.8.2 (Package-Only) - 2026-01-25

### Changed
- fix node esm plugin load by importing tool from `@opencode-ai/plugin/tool` and ensuring runtime dependency is installed.
- correct package metadata (repository links, update-check package name) and add troubleshooting guidance for plugin install/load.

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## [4.7.0] - 2026-01-25

**feature release**: full session recovery system ported from opencode-antigravity-auth.

### Added
- **session recovery system**: automatic recovery from common api errors that would previously crash sessions:
  - `tool_result_missing`: handles interrupted tool executions (esc during tool run)
  - `thinking_block_order`: fixes corrupted thinking blocks in message history
  - `thinking_disabled_violation`: strips thinking blocks when switching to non-thinking models
- **new recovery module** (`lib/recovery/`):
  - `types.ts` - type definitions for stored messages, parts, and recovery
  - `constants.ts` - storage paths (xdg-compliant) and type sets
  - `storage.ts` - filesystem operations for reading/writing opencode session data
  - `index.ts` - module re-exports
- **main recovery logic** (`lib/recovery.ts`):
  - `detectErrorType()` - identifies recoverable error patterns from api responses
  - `isRecoverableError()` - quick check for recovery eligibility
  - `createSessionRecoveryHook()` - creates hook for session-level error recovery
  - toast notifications during recovery attempts
- **new configuration options**:
  - `sessionRecovery` (default: `true`) - enable/disable session recovery
  - `autoResume` (default: `true`) - auto-resume session after thinking block recovery
  - environment variables: `CODEX_AUTH_SESSION_RECOVERY`, `CODEX_AUTH_AUTO_RESUME`
- **26 new unit tests** for recovery system

### Changed
- **account label format**: changed from `Account N (email)` to `N. email` for cleaner display
- **error response handling**: `handleErrorResponse()` now returns `errorBody` for recovery detection
- enhanced error logging with recoverable error detection in fetch flow

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## [4.6.0] - 2026-01-25

**feature release**: context overflow handling and missing tool result injection.

### Added
- **context overflow handler**: gracefully handles "prompt too long" / context length exceeded errors:
  - returns synthetic sse response with helpful instructions instead of raw 400 error
  - suggests `/compact`, `/clear`, or `/undo` commands to reduce context size
  - prevents opencode session from getting locked on context overflow
  - new module: `lib/context-overflow.ts`
- **missing tool result injection**: automatically handles cancelled tool calls (esc mid-execution):
  - detects orphaned `function_call` items (calls without matching outputs)
  - injects synthetic output: `"Operation cancelled by user"`
  - prevents "missing tool_result" api errors when user cancels mid-tool
  - new function: `injectMissingToolOutputs()` in `lib/request/helpers/input-utils.ts`
- **34 new unit tests** for context overflow and tool injection

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## [4.5.0] - 2026-01-24

### Added
- **strict tool validation**: automatically cleans tool schemas for compatibility with strict models (claude, gemini)
- **auto-update notifications**: get notified when a new version is available
- **22 model presets**: full variant system with reasoning levels (none/low/medium/high/xhigh)

### Changed
- health-aware account rotation with automatic failover
- hybrid selection prefers healthy accounts with available tokens

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## Legacy 4.4.0 (Package-Only) - 2026-01-23

### Added
- **health scoring**: tracks success/failure per account
- **token bucket**: prevents hitting rate limits
- **always retries** when all accounts are rate-limited (waits for reset)

### Notes
new retry options:
- `retryAllAccountsRateLimited` (default: `true`)
- `retryAllAccountsMaxWaitMs` (default: `0` = unlimited)
- `retryAllAccountsMaxRetries` (default: `Infinity`)

### Notes
- npm publish status: not published on npm (tag/release only).

## [4.3.1] - 2026-01-23

### Added

- **openai-accounts-status --json** - Scriptable status output with email/ID labels

### Changed

- **Account labels** - Now prefer email and show ID suffix when available; list/status outputs are columnized for readability
- **Email normalization** - Stored account emails are trimmed/lowercased when present

- @opencode-ai plugin/sdk 1.1.34
- hono 4.11.5
- vitest 4.0.18
- @types/node 25.0.10
- @typescript-eslint 8.53.1

- @andremxmx for reporting the multi-account ID issue (#4)

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.
