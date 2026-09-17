/**
 * Shared account-display helpers.
 *
 * Account identity is rendered across several UI surfaces (interactive auth
 * menu, command output, runtime/log messages, standalone CLI login menu, TUI
 * quota status). Historically each surface formatted the email independently
 * and only the TUI quota path honored the `maskEmail` config, so full emails
 * could still leak into screenshots, screen shares, and terminal recordings.
 *
 * These helpers centralize the privacy behavior so every human-facing surface
 * masks the email consistently when `maskEmail` is enabled, while preferring a
 * user-defined account label when one exists.
 */

/**
 * Mask an email for display while preserving the domain so collisions between
 * accounts on the same provider remain distinguishable.
 *
 * `user@example.com` -> `us***@example.com`
 * `a@example.org`    -> `a***@example.org`
 * `not-an-email`     -> `*****`
 *
 * Returns `undefined` for empty/whitespace input so callers can fall back to
 * other identity fields.
 */
export function maskEmailForDisplay(email: string | undefined): string | undefined {
	const trimmed = email?.trim();
	if (!trimmed) return undefined;
	const atIndex = trimmed.indexOf("@");
	if (atIndex <= 0) return "*****";
	// Slice by code points, not UTF-16 units: an astral character at the
	// boundary would otherwise split into a lone surrogate.
	const prefix = Array.from(trimmed.slice(0, atIndex)).slice(0, 2).join("");
	const domain = trimmed.slice(atIndex);
	return `${prefix}***${domain}`;
}

/**
 * Resolve the email value to display for an account, applying masking when
 * requested. Returns `undefined` when there is no email to show.
 */
export function resolveDisplayEmail(
	email: string | undefined,
	maskEmail: boolean,
): string | undefined {
	const trimmed = email?.trim();
	if (!trimmed) return undefined;
	return maskEmail ? maskEmailForDisplay(trimmed) : trimmed;
}

const SEAT_SUFFIX_MIN_LENGTH = 6;

function normalizeSeatIdentity(accountUserId: string | undefined): string | undefined {
	const trimmed = accountUserId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function sliceSeatSuffix(accountUserId: string, length: number): string {
	return accountUserId.length > length ? accountUserId.slice(-length) : accountUserId;
}

/**
 * Shortest tail, at least six characters, that renders every distinct member
 * id in `accountUserIds` as a different string.
 *
 * It terminates because the search stops at the longest id present, and at
 * that length every id is rendered whole - distinct strings by definition. So
 * a length always exists, and the first one found is the shortest.
 */
function resolveSeatSuffixLength(accountUserIds: readonly (string | undefined)[]): number {
	const distinct = new Set<string>();
	for (const accountUserId of accountUserIds) {
		const normalized = normalizeSeatIdentity(accountUserId);
		if (normalized) distinct.add(normalized);
	}
	if (distinct.size <= 1) return SEAT_SUFFIX_MIN_LENGTH;

	let longest = SEAT_SUFFIX_MIN_LENGTH;
	for (const accountUserId of distinct) {
		longest = Math.max(longest, accountUserId.length);
	}
	for (let length = SEAT_SUFFIX_MIN_LENGTH; length < longest; length += 1) {
		const rendered = new Set<string>();
		for (const accountUserId of distinct) {
			rendered.add(sliceSeatSuffix(accountUserId, length));
		}
		if (rendered.size === distinct.size) return length;
	}
	return longest;
}

/**
 * Render the short seat suffix that separates two accounts sharing one
 * workspace `accountId`.
 *
 * A ChatGPT Business workspace is a single `accountId` shared by every member
 * of it; `accountUserId` is that member's own id and the only stored field
 * that tells their seats apart. Upstream meters each seat separately - its own
 * quota, its own weekly reset - so seats sharing a workspace are distinct
 * accounts, not copies of one.
 *
 * Every display surface used to render `accountId` alone, so four members of
 * one Business workspace printed an identical `id:` string and read as the
 * same account duplicated four times. Appending this suffix is what makes the
 * rendered rows match the accounts they describe.
 *
 * Six characters by default, matching what the surfaces already print for
 * `accountId`. Six is not unique on its own - real member ids were observed
 * sharing a six-character tail, which is the same false "these are duplicates"
 * reading this suffix exists to prevent - so pass `peerAccountUserIds` (the
 * other accounts rendered alongside this one) and the suffix grows to whatever
 * length tells them all apart.
 *
 * Returns `undefined` when there is no member id, so a token-only record
 * renders exactly as it did before.
 */
export function formatSeatSuffix(
	accountUserId: string | undefined,
	peerAccountUserIds?: readonly (string | undefined)[],
): string | undefined {
	const trimmed = normalizeSeatIdentity(accountUserId);
	if (!trimmed) return undefined;
	return sliceSeatSuffix(
		trimmed,
		peerAccountUserIds
			// This id joins the set the length is measured against, so the
			// guarantee holds even for a caller whose peer list is the OTHER
			// accounts rather than all of them. A set makes the common case,
			// where it is already there, a no-op.
			? resolveSeatSuffixLength([...peerAccountUserIds, trimmed])
			: SEAT_SUFFIX_MIN_LENGTH,
	);
}

/**
 * Seat suffixes for a whole rendered set, all cut to one length so the rows
 * line up and no two distinct member ids share a rendering. Entries without a
 * member id come back `undefined`, holding their position.
 */
export function resolveSeatSuffixes(
	accountUserIds: readonly (string | undefined)[],
): (string | undefined)[] {
	const length = resolveSeatSuffixLength(accountUserIds);
	return accountUserIds.map((accountUserId) => {
		const trimmed = normalizeSeatIdentity(accountUserId);
		return trimmed ? sliceSeatSuffix(trimmed, length) : undefined;
	});
}
