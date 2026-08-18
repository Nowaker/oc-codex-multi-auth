/**
 * `codex-tag` tool — set or clear account tags.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, withAccountStorageTransaction } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { logWarn } from "../logger.js";
import { getWorkspaceIdentityKey } from "../storage/identity.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

export function createCodexTagTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		promptAccountIndexSelection,
		supportsInteractiveMenus,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		normalizeAccountTags,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	return tool({
		description: "Set or clear account tags for filtering and grouping.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to update (1-based, e.g., 1 for first account)",
				),
			tags: tool.schema
				.string()
				.describe(
					"Comma-separated tags (e.g., work,team-a). Empty string clears tags.",
				),
		},
		async execute({ index, tags }: { index?: number; tags: string }) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Set account tags"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					storage,
					"Set account tags",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) {
						return ui.v2Enabled
							? [
									...formatUiHeader(ui, "Set account tags"),
									"",
									formatUiItem(ui, "No account selected.", "warning"),
								].join("\n")
							: "No account selected.";
					}
					return 'Missing account number. Use: codex-tag index=2 tags="work,team-a"';
				}
				resolvedIndex = selectedIndex + 1;
			}

			const targetIndex = Math.floor((resolvedIndex ?? 0) - 1);
			if (
				!Number.isFinite(targetIndex) ||
				targetIndex < 0 ||
				targetIndex >= storage.accounts.length
			) {
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${storage.accounts.length}`;
			}

			const account = storage.accounts[targetIndex];
			if (!account) return `Account ${resolvedIndex} not found.`;
			const normalizedTags = normalizeAccountTags(tags ?? "");
			const identityKey = getWorkspaceIdentityKey(account);
			let previousTags: string[] = [];
			let persistedAccount = account;

			try {
				await withAccountStorageTransaction(async (current, persist) => {
					const currentAccount = current?.accounts.find(
						(candidate) => getWorkspaceIdentityKey(candidate) === identityKey,
					);
					if (!current || !currentAccount) {
						throw new Error("Account changed before tags could be updated");
					}
					previousTags = Array.isArray(currentAccount.accountTags)
						? [...currentAccount.accountTags]
						: [];
					if (normalizedTags.length === 0) {
						delete currentAccount.accountTags;
					} else {
						currentAccount.accountTags = normalizedTags;
					}
					await persist(current);
					persistedAccount = currentAccount;
				});
			} catch (error) {
				logWarn("Failed to save account tag update", { error: String(error) });
				return "Tag update failed to persist. Changes may be lost on restart.";
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			const accountLabel = formatCommandAccountLabel(persistedAccount, targetIndex, { maskEmail });
			const previousText =
				previousTags.length > 0 ? previousTags.join(", ") : "none";
			const nextText =
				normalizedTags.length > 0 ? normalizedTags.join(", ") : "none";
			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Set account tags"),
					"",
					formatUiItem(
						ui,
						`${getStatusMarker(ui, "ok")} Updated tags for ${accountLabel}`,
						"success",
					),
					formatUiKeyValue(ui, "Previous tags", previousText, "muted"),
					formatUiKeyValue(
						ui,
						"Current tags",
						nextText,
						normalizedTags.length > 0 ? "accent" : "muted",
					),
				].join("\n");
			}
			return `Updated tags for ${accountLabel}\nPrevious tags: ${previousText}\nCurrent tags: ${nextText}`;
		},
	});
}
