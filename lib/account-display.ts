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
 * Six characters, matching what the surfaces already print for `accountId`.
 * Returns `undefined` when there is no member id, so a token-only record
 * renders exactly as it did before.
 */
export function formatSeatSuffix(accountUserId: string | undefined): string | undefined {
	const trimmed = accountUserId?.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 6 ? trimmed.slice(-6) : trimmed;
}
