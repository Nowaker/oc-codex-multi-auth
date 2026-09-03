import { describe, expect, it } from "vitest";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/fetch-helpers.js";
import { getUnsupportedCodexFallbackChain } from "../lib/config.js";

/**
 * Model ids reach the fallback chain raw from the caller: the proxy copies
 * `body.model` verbatim. So the string indexing this plain object can be any
 * `Object.prototype` member name, and a bare index returns that member rather
 * than `undefined`. It is truthy and has a `.length`, so the emptiness check
 * passes it through.
 *
 * Found by porting a release-gate stress probe from the sibling repo, where the
 * same defect was fixed. Both cases below failed before this change.
 */
const PROTOTYPE_KEYS = [
	"constructor",
	"__proto__",
	"toString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
];

describe("prototype keys cannot masquerade as model ids", () => {
	const unsupportedBody = {
		error: {
			message: "model is not supported when using codex with a chatgpt account",
		},
	};

	it("resolves no fallback instead of throwing `targets is not iterable`", () => {
		for (const key of PROTOTYPE_KEYS) {
			const resolve = () =>
				resolveUnsupportedCodexFallbackModel({
					requestedModel: key,
					errorBody: unsupportedBody,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});

			expect(resolve, key).not.toThrow();
			expect(resolve(), key).toBeUndefined();
		}
	});

	it("survives a custom chain carrying a non-array value", () => {
		expect(() =>
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.5",
				errorBody: unsupportedBody,
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
				customChain: { "gpt-5.5": "gpt-5.4" } as unknown as Record<
					string,
					string[]
				>,
			}),
		).not.toThrow();
	});

	it("does not let a `__proto__` config key reassign the returned prototype", () => {
		// JSON.parse, deliberately, not an object literal. A literal `__proto__:`
		// key sets THAT literal's prototype and never becomes an own property, so
		// `Object.entries` in the function under test would not see it and this
		// case would pass with or without the fix. settings.json reaches the
		// function through JSON.parse, which does create a real own property.
		const chain = getUnsupportedCodexFallbackChain({
			unsupportedCodexFallbackChain: JSON.parse(
				'{"__proto__": ["gpt-5.4"], "gpt-5.5": ["gpt-5.4"]}',
			),
		} as never);

		expect(Array.isArray(Object.getPrototypeOf(chain))).toBe(false);
		expect(chain["gpt-5.5"]).toEqual(["gpt-5.4"]);
		// Nothing inherited leaks through as a row.
		expect(chain["toString"]).toBeUndefined();
	});
});
