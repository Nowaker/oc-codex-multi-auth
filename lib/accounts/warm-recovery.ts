import { withAccountStorageTransaction, type AccountMetadataV3 } from "../storage.js";
import { findAccountIndexByIdentity } from "../tools/refresh-account.js";
import { getModelFamily } from "../prompts/codex.js";
import { getQuotaKey } from "./rate-limits.js";
import { clearUnchangedRecoveryState } from "./stale-state.js";
import {
	fetchCodexUsage, parseCodexUsagePayload, isUsageQuotaRecovered,
	persistUsageQuotaRecovery, resolveCodexUsageAccountId,
} from "../codex-usage.js";

export interface WarmRecoveryObservation {
	account: AccountMetadataV3;
	model: string;
	accessToken: string;
}

export async function recoverWarmedAccount(
	observation: WarmRecoveryObservation,
	onCleared?: (snapshot: AccountMetadataV3) => void,
): Promise<boolean> {
	const { account, model, accessToken } = observation;
	let quotaCleared = false;
	const clearedSnapshot: AccountMetadataV3 = { ...account, rateLimitResetTimes: {},
		coolingDownUntil: undefined, cooldownReason: undefined,
		quotaExhaustedUntil: undefined, quotaExhaustedStampAt: undefined };
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
			if (quotaCleared) {
				clearedSnapshot.quotaExhaustedUntil = account.quotaExhaustedUntil;
				clearedSnapshot.quotaExhaustedStampAt = account.quotaExhaustedStampAt;
				onCleared?.({ ...clearedSnapshot });
			}
		}
	}
	const modelKey = getQuotaKey(getModelFamily(model), model);
	const modelCleared = await withAccountStorageTransaction(async (current, persist) => {
		if (!current) return false;
		const record = current.accounts[findAccountIndexByIdentity(current.accounts, account)];
		if (!record || record.enabled === false) return false;
		const cleared = clearUnchangedRecoveryState(record, {
			rateLimitResetTimes: { [modelKey]: account.rateLimitResetTimes?.[modelKey] },
			coolingDownUntil: account.coolingDownUntil, cooldownReason: account.cooldownReason,
		});
		if (!cleared) return false;
		await persist(current);
		clearedSnapshot.rateLimitResetTimes = cleared.rateLimitResetTimes ?? {};
		clearedSnapshot.coolingDownUntil = cleared.coolingDownUntil;
		clearedSnapshot.cooldownReason = cleared.cooldownReason ? account.cooldownReason : undefined;
		onCleared?.(clearedSnapshot);
		return true;
	});
	return quotaCleared || modelCleared;
}
