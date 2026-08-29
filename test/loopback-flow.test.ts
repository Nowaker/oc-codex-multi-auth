/**
 * Failing-first tests for the loopback OAuth session primitive.
 *
 * Pins the lifecycle contract of `startLoopbackFlow`: listener readiness
 * precedes any browser open, manual mode never opens, an unavailable listener
 * returns a typed lifecycle marker without opening, a matching callback
 * exchanges with the same verifier and REDIRECT_URI, a null callback surfaces
 * as a typed cancelled result (not a TokenResult), wait/exchange exceptions
 * do not leak the listener, and every ready session closes exactly once.
 *
 * The primitive returns lifecycle MARKERS rather than user-facing strings so
 * label/policy wording stays at the auth-method boundary in index.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type { OAuthServerInfo, AuthorizationFlow, TokenResult } from "../lib/types.js";
import { REDIRECT_URI } from "../lib/auth/auth.js";
import {
	startLoopbackFlow,
	type LoopbackFlowSession,
} from "../lib/auth/loopback-flow.js";

interface CallLog {
	events: string[];
}

function makeFlow(overrides: Partial<AuthorizationFlow> = {}): AuthorizationFlow {
	return {
		pkce: { verifier: "verifier-xyz", challenge: "challenge-xyz" },
		state: "state-abc",
		url: "https://auth.openai.com/oauth/authorize?state=state-abc",
		...overrides,
	};
}

function makeTokenResult(
	overrides: Partial<Extract<TokenResult, { type: "success" }>> = {},
): TokenResult {
	return {
		type: "success",
		access: "access-token",
		refresh: "refresh-token",
		expires: 1,
		...overrides,
	};
}

function makeReadyServer(
	log: CallLog,
	options: {
		code?: string | null;
		waitThrows?: Error;
	} = {},
): OAuthServerInfo & { closeMock: ReturnType<typeof vi.fn>; waitMock: ReturnType<typeof vi.fn> } {
	const closeMock = vi.fn(() => {
		log.events.push("close");
	});
	const waitMock = vi.fn(async () => {
		log.events.push("wait");
		if (options.waitThrows) throw options.waitThrows;
		if (options.code === undefined) return { code: "code-123" };
		if (options.code === null) return null;
		return { code: options.code };
	});
	return {
		port: 1455,
		ready: true,
		close: closeMock,
		waitForCode: waitMock,
		closeMock,
		waitMock,
	};
}

/**
 * `close()` settling the pending wait with null is fidelity, not convenience:
 * the real listener sets `pollAborted` on close and `waitForCode` then returns
 * null on its next poll (lib/auth/server.ts).
 */
function makeDeferredServer(log: CallLog): OAuthServerInfo & {
	closeMock: ReturnType<typeof vi.fn>;
	waitMock: ReturnType<typeof vi.fn>;
	resolveWith: (value: { code: string } | null) => void;
	rejectWith: (error: Error) => void;
} {
	let settle: (value: { code: string } | null) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const pending = new Promise<{ code: string } | null>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const closeMock = vi.fn(() => {
		log.events.push("close");
		settle(null);
	});
	const waitMock = vi.fn(() => {
		log.events.push("wait");
		return pending;
	});
	return {
		port: 1455,
		ready: true,
		close: closeMock,
		waitForCode: waitMock,
		closeMock,
		waitMock,
		resolveWith: settle,
		rejectWith: fail,
	};
}

function makeUnavailableServer(log: CallLog): OAuthServerInfo & { closeMock: ReturnType<typeof vi.fn> } {
	const closeMock = vi.fn(() => {
		log.events.push("close-unavailable");
	});
	return {
		port: 1455,
		ready: false,
		close: closeMock,
		waitForCode: async () => null,
		closeMock,
	};
}

function assertReady(session: LoopbackFlowSession): asserts session is Extract<
	LoopbackFlowSession,
	{ type: "ready" }
> {
	if (session.type !== "ready") {
		throw new Error(`expected ready session, got ${session.type}`);
	}
}

describe("startLoopbackFlow", () => {
	it("emits a ready session whose URL matches the created flow and opens the browser only after the listener is ready", async () => {
		const log: CallLog = { events: [] };
		const flow = makeFlow();
		const server = makeReadyServer(log);
		const openBrowserUrl = vi.fn(() => {
			log.events.push("open");
			return true;
		});

		const session = await startLoopbackFlow({
			openBrowser: true,
			deps: {
				createAuthorizationFlow: async () => {
					log.events.push("createFlow");
					return flow;
				},
				startLocalOAuthServer: async ({ state }) => {
					log.events.push(`startServer:${state}`);
					return server;
				},
				openBrowserUrl,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		assertReady(session);
		expect(session.url).toBe(flow.url);
		expect(log.events.slice(0, 3)).toEqual([
			"createFlow",
			"startServer:state-abc",
			"wait",
		]);
		expect(log.events.indexOf("startServer:state-abc")).toBeLessThan(
			log.events.indexOf("open"),
		);
		expect(openBrowserUrl).toHaveBeenCalledWith(flow.url);

		session.close();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("never opens the browser in manual mode (openBrowser=false) even when the listener is ready", async () => {
		const log: CallLog = { events: [] };
		const server = makeReadyServer(log);
		const openBrowserUrl = vi.fn(() => {
			log.events.push("open");
			return true;
		});

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		assertReady(session);
		expect(openBrowserUrl).not.toHaveBeenCalled();
		expect(log.events).not.toContain("open");

		session.close();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("returns a typed unavailable lifecycle marker and never opens the browser when the listener cannot bind", async () => {
		const log: CallLog = { events: [] };
		const server = makeUnavailableServer(log);
		const openBrowserUrl = vi.fn(() => true);

		const session = await startLoopbackFlow({
			openBrowser: true,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		expect(session.type).toBe("unavailable");
		if (session.type === "unavailable") {
			expect(session.lifecycle).toBe("listener_unavailable");
		}
		expect(openBrowserUrl).not.toHaveBeenCalled();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("waitAndExchange exchanges the callback code with the same PKCE verifier and REDIRECT_URI", async () => {
		const log: CallLog = { events: [] };
		const flow = makeFlow({ pkce: { verifier: "verifier-match", challenge: "chal" } });
		const server = makeReadyServer(log, { code: "code-match" });
		const exchangeAuthorizationCode = vi.fn(async () => {
			log.events.push("exchange");
			return makeTokenResult({ access: "a", refresh: "r" });
		});

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => flow,
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode,
			},
		});

		assertReady(session);
		const result = await session.waitAndExchange();
		expect(result.type).toBe("success");
		expect(exchangeAuthorizationCode).toHaveBeenCalledWith("code-match", "verifier-match", REDIRECT_URI);
		expect(server.closeMock).toHaveBeenCalledTimes(1);
		expect(log.events.filter((e) => e === "close")).toHaveLength(1);
	});

	it("maps a null callback (timeout / cancel) to a typed cancelled lifecycle marker and closes exactly once", async () => {
		const log: CallLog = { events: [] };
		const server = makeReadyServer(log, { code: null });
		const exchangeAuthorizationCode = vi.fn(async () => makeTokenResult());

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode,
			},
		});

		assertReady(session);
		const result = await session.waitAndExchange();
		expect(result.type).toBe("cancelled");
		if (result.type === "cancelled") {
			expect(result.lifecycle).toBe("callback_timeout_or_cancelled");
		}
		expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("closes exactly once when waitForCode throws", async () => {
		const log: CallLog = { events: [] };
		const server = makeReadyServer(log, { waitThrows: new Error("wait boom") });

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		assertReady(session);
		await expect(session.waitAndExchange()).rejects.toThrow("wait boom");
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("closes exactly once when exchangeAuthorizationCode throws", async () => {
		const log: CallLog = { events: [] };
		const server = makeReadyServer(log, { code: "code-x" });
		const exchangeAuthorizationCode = vi.fn(async () => {
			throw new Error("exchange boom");
		});

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode,
			},
		});

		assertReady(session);
		await expect(session.waitAndExchange()).rejects.toThrow("exchange boom");
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("session.close() before waitAndExchange closes the ready listener exactly once", async () => {
		const log: CallLog = { events: [] };
		const server = makeReadyServer(log);

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		assertReady(session);
		session.close();
		session.close();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("waitAndExchange after an external session.close() does not double-close the listener", async () => {
		const log: CallLog = { events: [] };
		const server = makeReadyServer(log, { code: null });

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		assertReady(session);
		session.close();
		await session.waitAndExchange();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("starts callback observation at session creation, so an abandoned authorization still closes its listener", async () => {
		// Given a ready session whose host never calls waitAndExchange
		const log: CallLog = { events: [] };
		const server = makeDeferredServer(log);

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		// When the listener's own deadline expires with the session abandoned
		assertReady(session);
		expect(server.waitMock).toHaveBeenCalledTimes(1);
		expect(server.waitMock).toHaveBeenCalledWith("state-abc");
		server.resolveWith(null);
		await vi.waitFor(() => expect(server.closeMock).toHaveBeenCalled());

		// Then the port was released without the host ever awaiting the flow
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("returns cancellation without exchanging when the host calls back after expiry", async () => {
		// Given a ready session whose callback observation already expired
		const log: CallLog = { events: [] };
		const server = makeDeferredServer(log);
		const exchangeAuthorizationCode = vi.fn(async () => makeTokenResult());

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode,
			},
		});

		assertReady(session);
		server.resolveWith(null);
		await vi.waitFor(() => expect(server.closeMock).toHaveBeenCalled());

		// When the host invokes its stored callback afterwards
		const result = await session.waitAndExchange();

		// Then it observes the settled cancellation and never exchanges
		expect(result.type).toBe("cancelled");
		if (result.type === "cancelled") {
			expect(result.lifecycle).toBe("callback_timeout_or_cancelled");
		}
		expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("stores a wait rejection without an unhandled rejection and surfaces it on the later callback", async () => {
		// Given a ready session whose wait rejects before the host calls back
		const log: CallLog = { events: [] };
		const server = makeDeferredServer(log);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const session = await startLoopbackFlow({
				openBrowser: false,
				deps: {
					createAuthorizationFlow: async () => makeFlow(),
					startLocalOAuthServer: async () => server,
					openBrowserUrl: () => true,
					exchangeAuthorizationCode: async () => makeTokenResult(),
				},
			});

			assertReady(session);
			server.rejectWith(new Error("wait boom"));
			await vi.waitFor(() => expect(server.closeMock).toHaveBeenCalled());
			await new Promise((resolve) => setImmediate(resolve));

			// When the host invokes its stored callback afterwards
			// Then the stored error surfaces and nothing went unhandled
			await expect(session.waitAndExchange()).rejects.toThrow("wait boom");
			expect(unhandled).toEqual([]);
			expect(server.closeMock).toHaveBeenCalledTimes(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("closes and reports browser_open_failed when the opener returns false", async () => {
		// Given a ready listener whose default browser will not launch
		const log: CallLog = { events: [] };
		const server = makeDeferredServer(log);
		const openBrowserUrl = vi.fn(() => false);

		// When the automatic-browser session starts
		const session = await startLoopbackFlow({
			openBrowser: true,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		// Then it fails immediately with a typed marker and releases the port
		expect(session.type).toBe("unavailable");
		if (session.type === "unavailable") {
			expect(session.lifecycle).toBe("browser_open_failed");
		}
		expect(openBrowserUrl).toHaveBeenCalledTimes(1);
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("closes and reports browser_open_failed when the opener throws", async () => {
		// Given a ready listener whose opener throws
		const log: CallLog = { events: [] };
		const server = makeDeferredServer(log);
		const openBrowserUrl = vi.fn(() => {
			throw new Error("spawn boom");
		});

		// When the automatic-browser session starts
		const session = await startLoopbackFlow({
			openBrowser: true,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		// Then the throw is mapped to the same typed marker and cleanup
		expect(session.type).toBe("unavailable");
		if (session.type === "unavailable") {
			expect(session.lifecycle).toBe("browser_open_failed");
		}
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("lets an external close win over a callback that arrives afterwards", async () => {
		// Given a ready session the caller closes while the wait is pending
		const log: CallLog = { events: [] };
		const server = makeDeferredServer(log);
		const exchangeAuthorizationCode = vi.fn(async () => makeTokenResult());

		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				createAuthorizationFlow: async () => makeFlow(),
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode,
			},
		});

		assertReady(session);
		session.close();

		// When a code arrives after that close and the host calls back
		server.resolveWith({ code: "late-code" });
		const result = await session.waitAndExchange();

		// Then cancellation wins, nothing is exchanged, and close ran once
		expect(result.type).toBe("cancelled");
		expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
		expect(server.closeMock).toHaveBeenCalledTimes(1);
	});

	it("forwards forceNewLogin to createAuthorizationFlow", async () => {
		const log: CallLog = { events: [] };
		const createAuthorizationFlow = vi.fn(async (opts?: { forceNewLogin?: boolean }) => {
			log.events.push(`createFlow:${opts?.forceNewLogin ?? false}`);
			return makeFlow();
		});
		const server = makeReadyServer(log);

		const session = await startLoopbackFlow({
			openBrowser: false,
			forceNewLogin: true,
			deps: {
				createAuthorizationFlow,
				startLocalOAuthServer: async () => server,
				openBrowserUrl: () => true,
				exchangeAuthorizationCode: async () => makeTokenResult(),
			},
		});

		assertReady(session);
		expect(createAuthorizationFlow).toHaveBeenCalledWith({ forceNewLogin: true });
		session.close();
	});
});
