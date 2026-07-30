import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prompts/codex.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/prompts/codex.js")>();
	return {
		...actual,
		getCodexInstructions: vi.fn(async () => "test-instructions"),
	};
});

import {
	buildWarmRequestBody,
	warmAccountWindow,
} from "../lib/accounts/warm-request.js";
import { CODEX_BASE_URL } from "../lib/constants.js";

function fakeResponse(status: number, bodyText = ""): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		body: { cancel: vi.fn(async () => undefined) },
		text: vi.fn(async () => bodyText),
	} as unknown as Response;
}

const PARAMS = {
	accountId: "acct-1",
	accessToken: "tok-1",
	organizationId: undefined as string | undefined,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("buildWarmRequestBody (#182)", () => {
	it("builds a minimal billable /responses body", async () => {
		const body = await buildWarmRequestBody();
		expect(body.model).toBe("gpt-5.5");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
		expect(body.input?.[0]).toMatchObject({ role: "user", type: "message" });
	});

	it("keeps effort 'none' for every model the default chain can reach", async () => {
		for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]) {
			const body = await buildWarmRequestBody(model);
			expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
		}
	});

	it("clamps effort to 'low' for a model that rejects 'none' (#210)", async () => {
		const body = await buildWarmRequestBody("gpt-5.6-sol");
		expect(body.reasoning).toMatchObject({ effort: "low" });
	});
});

describe("warmAccountWindow (#182)", () => {
	it("POSTs to /codex/responses with auth headers and returns true on 2xx", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("opened");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${CODEX_BASE_URL}/codex/responses`);
		expect(init.method).toBe("POST");
		const headers = init.headers as Headers;
		expect(headers.get("Authorization")).toBe("Bearer tok-1");
		expect(headers.get("chatgpt-account-id")).toBe("acct-1");
	});

	it("treats a token/concurrency 429 as opened (window already active)", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })),
		);
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("opened");
	});

	it("treats a quota/usage-limit 429 as exhausted (NOT warmed)", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(429, JSON.stringify({ error: { code: "usage_limit_reached" } })),
		);
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("exhausted");
		expect(result.detail).toMatch(/quota|usage/i);
	});

	it("treats a bare 429 with no parseable reason as opened", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(429, ""));
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("opened");
	});

	it("throws on other non-2xx (e.g. 401)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(401));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/HTTP 401/);
	});

	it("throws on a 500", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(500));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/HTTP 500/);
	});

	it("cancels the SSE stream body on success", async () => {
		const cancel = vi.fn(async () => undefined);
		const fetchImpl = vi.fn(
			async () =>
				({ ok: true, status: 200, body: { cancel } }) as unknown as Response,
		);
		await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("propagates a network error from fetch", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/ECONNRESET/);
	});

	it("does not pin openai-organization by default (Codex CLI parity, #196)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		await warmAccountWindow({ ...PARAMS, organizationId: "org-9", fetchImpl });
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("openai-organization")).toBeNull();
	});

	it("falls back down the model chain on an unsupported-model 400 (#210)", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				fakeResponse(
					400,
					JSON.stringify({
						error: { code: "model_not_supported_with_chatgpt_account" },
					}),
				),
			)
			.mockResolvedValueOnce(fakeResponse(200));

		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });

		expect(result.status).toBe("opened");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(
			(fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		const secondBody = JSON.parse(
			(fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(firstBody.model).toBe("gpt-5.5");
		expect(secondBody.model).toBe("gpt-5.4");
	});

	it("stops after the bounded attempt budget when no model is entitled (#210)", async () => {
		const unsupported = () =>
			fakeResponse(
				400,
				JSON.stringify({
					error: { code: "model_not_supported_with_chatgpt_account" },
				}),
			);
		const fetchImpl = vi.fn(async () => unsupported());

		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/tried gpt-5\.5, gpt-5\.4, gpt-5\.4-mini, gpt-5\.4-nano/,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("does not retry a 400 that is not an entitlement error, and surfaces its detail", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(400, JSON.stringify({ error: { message: "bad input" } })),
		);

		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/HTTP 400.*bad input/,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("redacts bearer tokens leaked in an error body", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(401, "Bearer sk-secret-token-value"),
		);
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/Bearer \[redacted\]/,
		);
	});

	it("passes organizationId into the request headers when CODEX_AUTH_SEND_ORGANIZATION_HEADER=1", async () => {
		try {
			vi.stubEnv("CODEX_AUTH_SEND_ORGANIZATION_HEADER", "1");
			const fetchImpl = vi.fn(async () => fakeResponse(200));
			await warmAccountWindow({ ...PARAMS, organizationId: "org-9", fetchImpl });
			const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Headers;
			expect(headers.get("openai-organization")).toBe("org-9");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
