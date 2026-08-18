/** Stable model-pool identities for individual ChatGPT accounts and Business seats. */

export type ModelPoolAccount = {
	accountId?: string;
	accountUserId?: string;
};

const BUSINESS_SEAT_PREFIX = "seat:";

export function getModelPoolAccountKey(
	account: ModelPoolAccount,
): string | undefined {
	const accountId = account.accountId?.trim();
	const accountUserId = account.accountUserId?.trim();
	if (accountUserId) {
		return `${BUSINESS_SEAT_PREFIX}${JSON.stringify([accountId ?? "", accountUserId])}`;
	}
	return accountId || undefined;
}

export function matchesModelPoolAccountKey(
	account: ModelPoolAccount,
	key: string,
): boolean {
	const normalizedKey = key.trim();
	if (!normalizedKey) return false;
	if (getModelPoolAccountKey(account) === normalizedKey) return true;

	// Legacy pools stored only accountId, which intentionally matches every
	// Business seat in that workspace until the next pool mutation migrates it.
	return account.accountId?.trim() === normalizedKey;
}

export function expandLegacyModelPoolKeys(
	keys: readonly string[],
	accounts: readonly ModelPoolAccount[],
): string[] {
	const expanded: string[] = [];
	for (const rawKey of keys) {
		const key = rawKey.trim();
		if (!key) continue;
		const matchingKeys = accounts
			.filter((account) => matchesModelPoolAccountKey(account, key))
			.map(getModelPoolAccountKey)
			.filter((candidate): candidate is string => candidate !== undefined);
		expanded.push(...(matchingKeys.length > 0 ? matchingKeys : [key]));
	}
	return [...new Set(expanded)];
}
