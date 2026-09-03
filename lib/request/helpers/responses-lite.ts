/**
 * Responses-lite request shaping.
 *
 * GPT-5.6 models carry `use_responses_lite: true` in the Codex model catalog
 * (openai/codex `codex-rs/models-manager/models.json`). Codex sends those
 * models a materially different request body — see
 * `codex-rs/core/src/client.rs`:
 *
 *   let (instructions, tools) = if model_info.use_responses_lite {
 *       let mut prefix = vec![ResponseItem::AdditionalTools { .. }];
 *       if !prompt.base_instructions.text.is_empty() { prefix.push(developer message) }
 *       input.splice(0..0, prefix);
 *       (String::new(), None)
 *   } else {
 *       (prompt.base_instructions.text.clone(), Some(tools))
 *   };
 *   ...
 *   parallel_tool_calls: prompt.parallel_tool_calls && !model_info.use_responses_lite,
 *
 * So for a lite model the tool definitions move *into* `input` as a leading
 * `additional_tools` developer item, the base instructions follow as a
 * developer message, top-level `instructions` becomes an empty string and
 * `tools` is omitted entirely. Codex also strips image `detail` fields and
 * sends an `x-openai-internal-codex-responses-lite: true` header.
 *
 * Sending the classic shape to a lite model is what this module exists to
 * prevent: `gpt-5.6-*` is `tool_mode: "code_mode_only"`, so tools declared at
 * the top level rather than as `additional_tools` are not guaranteed to be
 * honored.
 */
import {
	DAYBREAK_BLUE_MODEL_ID,
	DAYBREAK_RED_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
	GPT_6_ASTRA_MODEL_ID,
	getNormalizedModel,
} from "./model-map.js";
import { stripEffortSuffix } from "./effort-suffix.js";
import type { InputItem, RequestBody } from "../../types.js";

/** Canonical model ids whose catalog entry sets `use_responses_lite: true`. */
const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	// Both Daybreak tiers are `use_responses_lite: true`, `tool_mode:
	// "code_mode_only"` in the catalog — read directly from models.json.
	DAYBREAK_BLUE_MODEL_ID,
	DAYBREAK_RED_MODEL_ID,
]);

/**
 * Env override for Astra's request shape.
 *
 * Unlike every other id in {@link RESPONSES_LITE_MODELS}, Astra's lite
 * membership is inferred, not read: OpenAI shipped GPT-6 Astra on 2026-09-03
 * and the public Codex catalog has carried no `gpt-6-astra` entry since its
 * 2026-08-20 refresh, so `use_responses_lite` cannot be verified for it.
 *
 * The inference: every catalog model of the 5.6 generation and later — sol,
 * terra, luna, and both Daybreak tiers — is `use_responses_lite: true` with
 * `tool_mode: "code_mode_only"`, and Astra exposes `ultra`, which the catalog
 * only ever pairs with `multi_agent_version: "v2"` lite models. Defaulting
 * Astra to lite therefore matches every neighbour it has.
 *
 * Getting this wrong strands tool definitions in either direction, so the guess
 * is overridable: `CODEX_AUTH_ASTRA_RESPONSES_LITE=0` sends Astra the classic
 * shape, `=1` forces lite. Drop this switch and hardcode membership once a
 * catalog entry for `gpt-6-astra` lands.
 */
function astraUsesResponsesLite(): boolean {
	return process.env.CODEX_AUTH_ASTRA_RESPONSES_LITE?.trim() !== "0";
}

/** Header Codex sets on every responses-lite request. */
export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const RESPONSES_LITE_HEADER_VALUE = "true";

/**
 * Whether a model expects the responses-lite request shape.
 *
 * Accepts raw selectors (`openai/gpt-5.6-sol-xhigh`) as well as canonical ids.
 */
export function usesResponsesLite(model: string | undefined): boolean {
	if (!model) return false;
	const trimmed = model.trim();
	if (!trimmed) return false;
	const withoutPrefix = trimmed.includes("/")
		? (trimmed.split("/").pop() ?? trimmed)
		: trimmed;
	const stripped = stripEffortSuffix(withoutPrefix).toLowerCase();
	const canonical = getNormalizedModel(stripped) ?? stripped;
	if (canonical === GPT_6_ASTRA_MODEL_ID) return astraUsesResponsesLite();
	return RESPONSES_LITE_MODELS.has(canonical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop `detail` from every input image, mirroring `strip_image_details` in
 * `codex-rs/core/src/client_common.rs`. Applies to message content and to
 * function/custom tool call outputs.
 */
function stripImageDetails(items: InputItem[]): void {
	const stripContent = (content: unknown): void => {
		if (!Array.isArray(content)) return;
		for (const entry of content) {
			if (isRecord(entry) && entry.type === "input_image" && "detail" in entry) {
				delete entry.detail;
			}
		}
	};

	for (const item of items) {
		if (!isRecord(item)) continue;
		stripContent(item.content);

		if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			const output = item.output;
			if (isRecord(output)) {
				stripContent(output.content);
			}
		}
	}
}

/**
 * Serialize-time shaping: return the body as it should go on the wire for
 * `body.model`.
 *
 * The canonical transformed body is always kept in the classic shape. Lite is a
 * per-attempt, model-dependent view of it, derived from a deep copy so the
 * canonical body is never mutated.
 *
 * This matters for the unsupported-model fallback: a `gpt-5.6-sol` request that
 * degrades to `gpt-5.5` must be sent in the classic shape. If the canonical
 * body had been reshaped in place, the fallback would ship a non-lite model a
 * body with no top-level `tools` — its tool definitions stranded in an
 * `additional_tools` item that a non-lite model does not interpret.
 */
export function shapeBodyForModel(body: RequestBody): RequestBody {
	if (!usesResponsesLite(body.model)) return body;
	return applyResponsesLite(structuredClone(body));
}

/**
 * Rewrite a request body into the responses-lite shape, in place.
 *
 * Prefer {@link shapeBodyForModel} at call sites; this is exported for tests
 * and for callers that already own a throwaway copy. Mutates and returns the
 * same body object.
 */
export function applyResponsesLite(body: RequestBody): RequestBody {
	const tools = Array.isArray(body.tools) ? body.tools : [];

	// Codex emits the additional_tools item even when the tool list is empty.
	const prefix: InputItem[] = [
		{
			type: "additional_tools",
			role: "developer",
			tools,
		} as unknown as InputItem,
	];

	// Upstream checks `!text.is_empty()`, not a trimmed check.
	const instructions =
		typeof body.instructions === "string" ? body.instructions : "";
	if (instructions.length > 0) {
		prefix.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: instructions }],
		} as unknown as InputItem);
	}

	const existingInput = Array.isArray(body.input) ? body.input : [];
	body.input = [...prefix, ...existingInput];

	// Top-level instructions become empty and tools are omitted; both now live
	// in `input`. `undefined` drops the key entirely on JSON.stringify.
	body.instructions = "";
	body.tools = undefined;

	// Lite requests never fan out tool calls.
	body.parallel_tool_calls = false;

	stripImageDetails(body.input);

	body.reasoning = { ...body.reasoning, context: "all_turns" };

	return body;
}
