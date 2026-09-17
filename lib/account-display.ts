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

import { createHash } from "node:crypto";

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
/**
 * Hard ceiling on a rendered seat, independent of how long the member id is.
 *
 * Without it the search below returns whatever length separates the ids, and
 * for a real ChatGPT member id - `<one distinguishing character>__<the 36-char
 * workspace uuid>` - that is the whole 39-character string, because the one
 * character that names the seat sits at the head and no tail short of the
 * entire id reaches it. Every seat then renders as its own workspace id, which
 * is both unreadable and the field already printed beside it.
 */
const SEAT_RENDER_MAX_LENGTH = 12;
/**
 * Hash prefix lengths for the last-resort renderer. 32 hex characters is 128
 * bits of SHA-256, so the list is exhausted only by a collision that cannot be
 * reached with ids a backend hands out.
 */
const SEAT_HASH_LENGTHS: readonly number[] = [8, 12, 16, 24, 32];

function normalizeSeatIdentity(accountUserId: string | undefined): string | undefined {
	const trimmed = accountUserId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function sliceSeatSuffix(accountUserId: string, length: number): string {
	return accountUserId.length > length ? accountUserId.slice(-length) : accountUserId;
}

/**
 * `length` characters starting at `start`, slid left when the id is too short
 * to hold that window whole. Never padded: a short id renders as itself.
 */
function sliceSeatWindow(accountUserId: string, start: number, length: number): string {
	if (accountUserId.length <= length) return accountUserId;
	const begin = Math.max(0, Math.min(start, accountUserId.length - length));
	return accountUserId.slice(begin, begin + length);
}

function hashSeatIdentity(accountUserId: string, length: number): string {
	return createHash("sha256").update(accountUserId).digest("hex").slice(0, length);
}

/** Index of the first character at which the given ids are not all equal. */
function commonPrefixLength(values: readonly string[]): number {
	const [first] = values;
	if (first === undefined) return 0;
	let shared = first.length;
	for (const value of values) {
		let index = 0;
		while (index < shared && index < value.length && first[index] === value[index]) {
			index += 1;
		}
		shared = index;
		if (shared === 0) break;
	}
	return shared;
}

/**
 * A renderer that gives every distinct member id in `accountUserIds` a
 * different string, short enough to sit in a column beside the account.
 *
 * Three strategies, each capped, tried in order:
 *
 *  1. A tail. This is what the surfaces already print for `accountId`, so it
 *     is preferred wherever it works, which is wherever the ids differ near
 *     their end.
 *  2. A window anchored where the ids first diverge. Real member ids carry
 *     their distinguishing character at the HEAD followed by a long shared
 *     tail, so no tail separates them and only an anchored window stays short.
 *  3. A SHA-256 prefix, for ids that no capped window separates - one id being
 *     another with a prefix bolted on, which a backend does not produce but a
 *     fixture can.
 *
 * Returning the id whole is kept as the final fallback so two distinct ids can
 * never render alike; reaching it needs a 128-bit SHA-256 prefix collision.
 */
function resolveSeatRenderer(
	accountUserIds: readonly (string | undefined)[],
): (accountUserId: string) => string {
	const distinct: string[] = [];
	const seen = new Set<string>();
	for (const accountUserId of accountUserIds) {
		const normalized = normalizeSeatIdentity(accountUserId);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		distinct.push(normalized);
	}
	const tailAtMinLength = (accountUserId: string) =>
		sliceSeatSuffix(accountUserId, SEAT_SUFFIX_MIN_LENGTH);
	if (distinct.length <= 1) return tailAtMinLength;

	const separates = (render: (accountUserId: string) => string): boolean =>
		new Set(distinct.map(render)).size === distinct.length;

	for (let length = SEAT_SUFFIX_MIN_LENGTH; length <= SEAT_RENDER_MAX_LENGTH; length += 1) {
		const render = (accountUserId: string) => sliceSeatSuffix(accountUserId, length);
		if (separates(render)) return render;
	}

	const start = commonPrefixLength(distinct);
	for (let length = SEAT_SUFFIX_MIN_LENGTH; length <= SEAT_RENDER_MAX_LENGTH; length += 1) {
		const render = (accountUserId: string) => sliceSeatWindow(accountUserId, start, length);
		if (separates(render)) return render;
	}

	for (const length of SEAT_HASH_LENGTHS) {
		const render = (accountUserId: string) => hashSeatIdentity(accountUserId, length);
		if (separates(render)) return render;
	}

	return (accountUserId: string) => accountUserId;
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
 * A six-character tail by default, matching what the surfaces already print
 * for `accountId`. Six characters are not an identity on their own - member
 * ids sharing a six-character tail were observed, which is the same false
 * "these are duplicates" reading this suffix exists to prevent - so pass
 * `peerAccountUserIds` (the other accounts rendered alongside this one) and
 * the rendering widens or moves until it tells them all apart, within
 * {@link SEAT_RENDER_MAX_LENGTH}.
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
	if (!peerAccountUserIds) return sliceSeatSuffix(trimmed, SEAT_SUFFIX_MIN_LENGTH);
	// This id joins the set the rendering is chosen against, so the guarantee
	// holds even for a caller whose peer list is the OTHER accounts rather than
	// all of them. Already being there makes it a no-op.
	return resolveSeatRenderer([...peerAccountUserIds, trimmed])(trimmed);
}

/**
 * Seat suffixes for a whole rendered set, all built the same way so the rows
 * line up and no two distinct member ids share a rendering. Entries without a
 * member id come back `undefined`, holding their position.
 */
export function resolveSeatSuffixes(
	accountUserIds: readonly (string | undefined)[],
): (string | undefined)[] {
	const render = resolveSeatRenderer(accountUserIds);
	return accountUserIds.map((accountUserId) => {
		const trimmed = normalizeSeatIdentity(accountUserId);
		return trimmed ? render(trimmed) : undefined;
	});
}
