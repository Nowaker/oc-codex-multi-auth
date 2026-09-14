/**
 * `codex-warm` tool — prime every account's usage window (issue #182).
 *
 * Sends one lightweight authenticated request to each enabled account so its
 * rolling usage window starts immediately, instead of only when rotation
 * eventually lands on it. This lets users "send a hi to each account" at the
 * start of a session to stagger the ~5h quota windows.
 *
 * The decision/iteration logic lives in the pure {@link warmAccounts}
 * orchestrator; this tool supplies the real network adapter (`warmOne`) by
 * composing proven primitives:
 *   1. ensureCodexUsageAccessToken — refresh the OAuth token if near expiry
 *   2. resolveCodexUsageAccountId   — derive the chatgpt-account-id
 *   3. warmAccountWindow            — send a minimal billable POST /codex/responses
 *      that actually starts the rolling usage window
 *
 * A read-only GET /wham/usage does NOT open the window (it only reports
 * server-side windows that already exist), so warming must send a genuine
 * inference request. The warm ping is deliberately tiny (reasoning effort
 * "none", verbosity "low", no stored conversation) to keep the quota cost
 * negligible.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, withAccountStorageTransaction, type AccountMetadataV3, type AccountStorageV3 } from "../storage.js";
import { clearRefreshedAccountStaleState } from "../accounts/stale-state.js";
import { findAccountIndexByIdentity } from "./refresh-account.js";
import {
	ensureCodexUsageAccessToken,
	resolveCodexUsageAccountId,
} from "../codex-usage.js";
import { warmAccountWindow } from "../accounts/warm-request.js";
import { warmAccounts, type WarmOutcome } from "../accounts/warm.js";
import { logWarn } from "../logger.js";
import {
	formatUiHeader,
	formatUiItem,
	paintUiText,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

/**
 * Build the real per-account warm function. Exported for testing so the
 * adapter can be exercised against injected fakes without a live network.
 */
export function createWarmOne(
	storage: AccountStorageV3,
	succeeded?: Set<AccountMetadataV3>,
): (account: AccountMetadataV3) => Promise<WarmOutcome> {
	return async (account: AccountMetadataV3): Promise<WarmOutcome> => {
		const { accessToken } = await ensureCodexUsageAccessToken({ storage, account });
		const accountId = resolveCodexUsageAccountId({ account, accessToken });
		if (!accountId) {
			return {
				status: "failed",
				detail: "could not resolve account id (re-login may be required)",
			};
		}
		const result = await warmAccountWindow({
			accountId,
			accessToken,
			organizationId: account.organizationId,
		});
		if (result.status === "exhausted") {
			return {
				status: "failed",
				detail: result.detail ?? "quota/usage limit reached",
			};
		}
		if (!result.rateLimited) succeeded?.add(account);
		return { status: "warmed" };
	};
}

export function createCodexWarmTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
	} = ctx;
	return tool({
		description:
			"Warm up all accounts by sending one lightweight request to each, starting their usage windows so weekly/5h quotas stagger instead of expiring together.",
		args: { format: tool.schema.enum(["text", "json"]).optional() },
		async execute(args) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (args.format === "json") {
					return JSON.stringify({ total: 0, warmedCount: 0, failedCount: 0, skippedCount: 0, blocksCleared: 0, results: [] });
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Warm accounts"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const succeeded = new Set<AccountMetadataV3>();
			const warmOne = createWarmOne(storage, succeeded);
			const summary = await warmAccounts(storage.accounts, warmOne);
			let blocksCleared = 0;
			let blockClearError: string | undefined;
			try {
				blocksCleared = await withAccountStorageTransaction(async (current, persist) => {
					if (!current) return 0;
					let cleared = 0;
					for (const result of summary.results) {
						if (result.status !== "warmed") continue;
						const account = storage.accounts[result.index];
						if (!account || !succeeded.has(account)) continue;
						const record = current.accounts[findAccountIndexByIdentity(current.accounts, {
							organizationId: account.organizationId, accountId: account.accountId,
							accountUserId: account.accountUserId, refreshToken: account.refreshToken,
						})];
						if (!record || record.enabled === false) continue;
						const hasBlocks = record.coolingDownUntil !== undefined || record.cooldownReason !== undefined ||
							record.quotaExhaustedUntil !== undefined || Object.keys(record.rateLimitResetTimes ?? {}).length > 0;
						clearRefreshedAccountStaleState(record);
						if (hasBlocks) cleared += 1;
					}
					if (cleared > 0) await persist(current);
					return cleared;
				});
				if (blocksCleared > 0) {
					ctx.invalidateAccountManagerCache();
					await ctx.reloadCachedAccountManager();
				}
			} catch {
				blockClearError = "Failed to clear local blocks; warm results are unchanged.";
			}
			if (args.format === "json") {
				return JSON.stringify({ total: summary.total, warmedCount: summary.warmedCount,
					failedCount: summary.failedCount, skippedCount: summary.skippedCount, blocksCleared, blockClearError,
					results: summary.results.map(({ index, status }) => ({ index, status })) });
			}

			const lines: string[] = ui.v2Enabled
				? []
				: [`Warming ${summary.total} account(s):`, ""];

			for (const result of summary.results) {
				const account = storage.accounts[result.index];
				const label = formatCommandAccountLabel(account, result.index, {
					maskEmail,
				});
				if (result.status === "warmed") {
					lines.push(`  ${getStatusMarker(ui, "ok")} ${label}: Window started`);
				} else if (result.status === "skipped") {
					lines.push(
						`  ${getStatusMarker(ui, "warning")} ${label}: Skipped (${result.detail ?? "disabled"})`,
					);
				} else {
					const detail = (result.detail ?? "unknown error").slice(0, 120);
					lines.push(`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${detail}`);
				}
			}

			if (summary.failedCount > 0) {
				logWarn("codex-warm completed with failures", {
					warmed: summary.warmedCount,
					failed: summary.failedCount,
					skipped: summary.skippedCount,
				});
			}

			lines.push("");
			lines.push(
				`Summary: ${summary.warmedCount} warmed, ${summary.failedCount} failed, ${summary.skippedCount} skipped, ${blocksCleared} blocks cleared`,
			);
			if (blockClearError) lines.push(blockClearError);

			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Warm accounts"),
					"",
					...lines.map((line) => paintUiText(ui, line, "normal")),
				].join("\n");
			}
			return lines.join("\n");
		},
	});
}
