import { withAccountStorageTransaction, type AccountMetadataV3 } from "../storage.js";
import { findAccountIndexByIdentity } from "../tools/refresh-account.js";
import { getModelFamily } from "../prompts/codex.js";
import { getQuotaKey } from "./rate-limits.js";
import {
	fetchCodexUsage, parseCodexUsagePayload, isUsageQuotaRecovered,
	persistUsageQuotaRecovery, resolveCodexUsageAccountId,
} from "../codex-usage.js";

export interface WarmRecoveryObservation {
	account: AccountMetadataV3;
	model: string;
	accessToken: string;
}

export async function recoverWarmedAccount(observation: WarmRecoveryObservation): Promise<boolean> {
	const { account, model, accessToken } = observation;
	let quotaCleared = false;
	// A warm 200 may spend credits. Confirm suspected subscription recovery
	// through usage rather than treating a successful model call as free quota.
	if (account.quotaExhaustedUntil !== undefined) {
		const accountId = resolveCodexUsageAccountId({ account, accessToken });
		if (!accountId) throw new Error("Cannot identify warmed account for quota recovery");
		const usage = parseCodexUsagePayload(await fetchCodexUsage({
			accountId, accessToken, organizationId: account.organizationId,
		}));
		if (isUsageQuotaRecovered([usage.primary, usage.secondary])) {
			quotaCleared = await persistUsageQuotaRecovery(account);
		}
	}
	const modelKey = getQuotaKey(getModelFamily(model), model);
	const modelCleared = await withAccountStorageTransaction(async (current, persist) => {
		if (!current) return false;
		const record = current.accounts[findAccountIndexByIdentity(current.accounts, account)];
		if (!record || record.enabled === false) return false;
		let changed = false;
		const before = account.rateLimitResetTimes?.[modelKey];
		if (before !== undefined && record.rateLimitResetTimes?.[modelKey] === before) {
			delete record.rateLimitResetTimes[modelKey];
			changed = true;
		}
		if (account.coolingDownUntil !== undefined && record.coolingDownUntil === account.coolingDownUntil &&
			record.cooldownReason === account.cooldownReason) {
			delete record.coolingDownUntil;
			delete record.cooldownReason;
			changed = true;
		}
		if (changed) await persist(current);
		return changed;
	});
	return quotaCleared || modelCleared;
}
