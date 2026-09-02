/**
 * ChatGPT subscription tier, read from the OAuth access token.
 *
 * The `chatgpt_plan_type` claim is the only plan signal the credential itself
 * carries. It agrees with the `plan_type` field the Codex `/wham/usage`
 * endpoint returns for the same account, so the tier is available without a
 * network round trip and stays correct while offline.
 */

import { decodeJWT } from "./auth.js";
import { JWT_CLAIM_PATH } from "../constants.js";

/**
 * `chatgpt_plan_type` slug to the subscription name OpenAI shows for it.
 *
 * `team` is the slug still emitted for what OpenAI now calls Business, and
 * `self_serve_business_prolite` is the premium Business seat - neither name is
 * derivable from its slug, so both are pinned here rather than reformatted.
 */
const PLAN_TYPE_LABELS: ReadonlyMap<string, string> = new Map([
	["free", "Free"],
	["plus", "Plus"],
	["pro", "Pro"],
	["team", "Business"],
	["business", "Business"],
	["self_serve_business_prolite", "Business Premium"],
	["enterprise", "Enterprise"],
]);

export function extractPlanType(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const planType = decodeJWT(accessToken)?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;
	if (typeof planType !== "string") return undefined;
	const normalized = planType.trim().toLowerCase();
	return normalized ? normalized : undefined;
}

/**
 * An unrecognized slug is returned verbatim: a plan we cannot name is still
 * worth showing, and inventing a name for it would misreport the subscription.
 */
export function formatPlanType(planType: string | undefined): string | undefined {
	if (!planType) return undefined;
	const normalized = planType.trim().toLowerCase();
	if (!normalized) return undefined;
	return PLAN_TYPE_LABELS.get(normalized) ?? planType.trim();
}
