import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
	createState,
	parseAuthorizationInput,
	decodeJWT,
	createAuthorizationFlow,
	refreshAccessToken,
	exchangeAuthorizationCode,
	CLIENT_ID,
	AUTHORIZE_URL,
	REDIRECT_URI,
	SCOPE,
} from '../lib/auth/auth.js';

describe('Auth Module', () => {
	describe('createState', () => {
		it('should generate a random 32-character hex string', () => {
			const state = createState();
			expect(state).toMatch(/^[a-f0-9]{32}$/);
		});

		it('should generate unique states', () => {
			const state1 = createState();
			const state2 = createState();
			expect(state1).not.toBe(state2);
		});
	});

	describe('parseAuthorizationInput', () => {
		it.each([
			{
				name: 'full OAuth callback URL with query parameters',
				input: 'http://localhost:1455/auth/callback?code=abc123&state=xyz789',
				expected: { source: 'url', code: 'abc123', state: 'xyz789' },
			},
			{
				name: 'full OAuth callback URL with fragment parameters',
				input: 'http://localhost:1455/auth/callback#code=abc123&state=xyz789',
				expected: { source: 'url', code: 'abc123', state: 'xyz789' },
			},
			{
				name: 'query string',
				input: 'code=abc123&state=xyz789',
				expected: { source: 'query', code: 'abc123', state: 'xyz789' },
			},
			{
				name: 'bare fragment parameters',
				input: '#code=abc123&state=xyz789',
				expected: { source: 'fragment', code: 'abc123', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand',
				input: 'abc123#xyz789',
				expected: { source: 'fragment', code: 'abc123', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand whose code contains a space',
				input: 'abc def#xyz789',
				expected: { source: 'fragment', code: 'abc def', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand whose code contains a backslash',
				input: 'abc\\def#xyz789',
				expected: { source: 'fragment', code: 'abc\\def', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand whose code contains dot segments',
				input: 'a/../b#xyz789',
				expected: { source: 'fragment', code: 'a/../b', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand whose code opens with a double slash',
				input: '//abc#xyz789',
				expected: { source: 'fragment', code: '//abc', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand whose code contains a question mark',
				input: 'abc?x#xyz789',
				expected: { source: 'fragment', code: 'abc?x', state: 'xyz789' },
			},
			{
				name: 'code#state shorthand whose state contains a space',
				input: 'abc123#xyz 789',
				expected: { source: 'fragment', code: 'abc123', state: 'xyz 789' },
			},
			{
				name: 'raw code',
				input: 'abc123',
				expected: { source: 'raw', code: 'abc123', state: undefined },
			},
			{
				name: 'opaque raw code containing equals signs',
				input: 'opaque=part==',
				expected: { source: 'raw', code: 'opaque=part==', state: undefined },
			},
			{
				name: 'opaque raw code containing a colon',
				input: 'ac:1a2b3c',
				expected: { source: 'raw', code: 'ac:1a2b3c', state: undefined },
			},
			{
				name: 'opaque raw code shaped like a non-special URL scheme',
				input: 'v2:abcdef',
				expected: { source: 'raw', code: 'v2:abcdef', state: undefined },
			},
			{
				name: 'opaque raw code followed by an unrelated ampersand parameter',
				input: 'Zm9vYmFy&state=YmFy',
				expected: { source: 'raw', code: 'Zm9vYmFy&state=YmFy', state: undefined },
			},
			{
				name: 'fragment carrying a bare value rather than parameters',
				input: '#abc123',
				expected: { source: 'raw', code: 'abc123', state: undefined },
			},
			{
				name: 'malformed URL-shaped raw code',
				input: 'https://[invalid',
				expected: { source: 'raw', code: 'https://[invalid', state: undefined },
			},
			{
				name: 'malformed URL-shaped raw code containing a fragment separator',
				input: 'https://[invalid#state',
				expected: { source: 'raw', code: 'https://[invalid#state', state: undefined },
			},
		])('preserves $name input', ({ input, expected }) => {
			// Given the authorization input and expected parse result above
			// When
			const result = parseAuthorizationInput(input);

			// Then
			expect(result).toEqual(expected);
		});

		it.each([
			{
				name: 'URL with unrelated parameters',
				input: 'http://localhost:1455/auth/callback?error=access_denied',
				expected: { source: 'url', code: undefined, state: undefined },
			},
			{
				name: 'URL with code and omitted state',
				input: 'http://localhost:1455/auth/callback?code=abc123',
				expected: { source: 'url', code: 'abc123', state: undefined },
			},
			{
				name: 'URL with code and empty state',
				input: 'http://localhost:1455/auth/callback?code=abc123&state=',
				expected: { source: 'url', code: 'abc123', state: '' },
			},
			{
				name: 'code-only query',
				input: 'code=abc123',
				expected: { source: 'query', code: 'abc123', state: undefined },
			},
			{
				name: 'state-only query',
				input: 'state=test-state',
				expected: { source: 'query', code: undefined, state: 'test-state' },
			},
			{
				name: 'code with empty shorthand state',
				input: 'abc123#',
				expected: { source: 'fragment', code: 'abc123', state: '' },
			},
			{
				name: 'fragment separator carrying no value',
				input: '#',
				expected: { source: 'raw', code: undefined, state: undefined },
			},
			{
				name: 'URL query code with fragment state fallback',
				input: 'http://localhost:1455/auth/callback?code=querycode#state=hashstate',
				expected: { source: 'url', code: 'querycode', state: 'hashstate' },
			},
			{
				name: 'URL query state with fragment code fallback',
				input: 'http://localhost:1455/auth/callback?state=querystate#code=hashcode',
				expected: { source: 'url', code: 'hashcode', state: 'querystate' },
			},
			{
				name: 'URL query parameters taking precedence over fragment parameters',
				input: 'http://localhost:1455/auth/callback?code=querycode&state=querystate#code=hashcode&state=hashstate',
				expected: { source: 'url', code: 'querycode', state: 'querystate' },
			},
			{
				name: 'URL carrying only a fragment state',
				input: 'http://localhost:1455/auth/callback#state=hashstate',
				expected: { source: 'url', code: undefined, state: 'hashstate' },
			},
			{
				name: 'URL carrying only a fragment code',
				input: 'http://localhost:1455/auth/callback#code=abc123',
				expected: { source: 'url', code: 'abc123', state: undefined },
			},
			{
				name: 'URL whose fragment names no parameter',
				input: 'http://localhost:1455/auth/callback#invalid',
				expected: { source: 'url', code: undefined, state: undefined },
			},
			{
				name: 'callback URL pasted without its scheme',
				input: 'localhost:1455/auth/callback?code=abc123&state=xyz789',
				expected: { source: 'url', code: 'abc123', state: 'xyz789' },
			},
			{
				name: 'callback URL pasted without its scheme against a numeric host',
				input: '127.0.0.1:1455/auth/callback?code=abc123&state=xyz789',
				expected: { source: 'url', code: 'abc123', state: 'xyz789' },
			},
		])('classifies $name without changing supplied values', ({ input, expected }) => {
			// Given the structured authorization input and expected parse result above
			// When
			const result = parseAuthorizationInput(input);

			// Then
			expect(result).toEqual(expected);
		});

		it.each(['', '  '])('classifies empty input as an empty raw value for %j', (input) => {
			// Given empty or whitespace-only authorization input
			// When
			const result = parseAuthorizationInput(input);

			// Then
			expect(result).toEqual({ source: 'raw', code: undefined, state: undefined });
		});

		it.each([undefined, null])('retains the runtime empty-input fallback for %s', (input) => {
			// Given a nullish value from an untyped JavaScript caller
			// When
			const result = parseAuthorizationInput(input as unknown as string);

			// Then
			expect(result).toEqual({ source: 'raw', code: undefined, state: undefined });
		});
	});

	describe('decodeJWT', () => {
		it('should decode valid JWT token', () => {
			// Create a simple JWT token: header.payload.signature
			const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
			const payload = Buffer.from(JSON.stringify({ sub: '1234567890', name: 'Test User' })).toString('base64');
			const signature = 'fake-signature';
			const token = `${header}.${payload}.${signature}`;

			const decoded = decodeJWT(token);
			expect(decoded).toEqual({ sub: '1234567890', name: 'Test User' });
		});

		it('should decode JWT with ChatGPT account info', () => {
			const payload = Buffer.from(JSON.stringify({
				'https://api.openai.com/auth': {
					chatgpt_account_id: 'account-123',
				},
			})).toString('base64');
			const token = `header.${payload}.signature`;

			const decoded = decodeJWT(token);
			expect(decoded?.['https://api.openai.com/auth']?.chatgpt_account_id).toBe('account-123');
		});

		it('should decode base64url JWT payloads', () => {
			const payload = Buffer.from(
				JSON.stringify({ sub: '1234567890', name: 'Test User' }),
				'utf8',
			).toString('base64url');
			const token = `header.${payload}.signature`;

			const decoded = decodeJWT(token);
			expect(decoded).toEqual({ sub: '1234567890', name: 'Test User' });
		});

		it('should return null for invalid JWT', () => {
			const result = decodeJWT('invalid-token');
			expect(result).toBeNull();
		});

		it('should return null for malformed JWT', () => {
			const result = decodeJWT('header.payload');
			expect(result).toBeNull();
		});

		it('should return null for non-JSON payload', () => {
			const token = 'header.not-json.signature';
			const result = decodeJWT(token);
			expect(result).toBeNull();
		});
	});

	describe('createAuthorizationFlow', () => {
		it('should create authorization flow with PKCE', async () => {
			const flow = await createAuthorizationFlow();

			expect(flow).toHaveProperty('pkce');
			expect(flow).toHaveProperty('state');
			expect(flow).toHaveProperty('url');

			expect(flow.pkce).toHaveProperty('challenge');
			expect(flow.pkce).toHaveProperty('verifier');
			expect(flow.state).toMatch(/^[a-f0-9]{32}$/);
		});

		it('should generate URL with correct parameters', async () => {
			const flow = await createAuthorizationFlow();
			const url = new URL(flow.url);

			expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
			expect(url.searchParams.get('response_type')).toBe('code');
			expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
			expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
			expect(url.searchParams.get('scope')).toBe(SCOPE);
			expect(SCOPE).not.toContain('api.connectors.read');
			expect(SCOPE).not.toContain('api.connectors.invoke');
			expect(url.searchParams.get('code_challenge_method')).toBe('S256');
			expect(url.searchParams.get('code_challenge')).toBe(flow.pkce.challenge);
			expect(url.searchParams.get('state')).toBe(flow.state);
			expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
			expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
			expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
			expect(url.searchParams.has('prompt')).toBe(false);
		});

		it('should include prompt=login when forceNewLogin is true', async () => {
			const flow = await createAuthorizationFlow({ forceNewLogin: true });
			const url = new URL(flow.url);
			expect(url.searchParams.get('prompt')).toBe('login');
		});

		it('should generate unique flows', async () => {
			const flow1 = await createAuthorizationFlow();
			const flow2 = await createAuthorizationFlow();

			expect(flow1.state).not.toBe(flow2.state);
			expect(flow1.pkce.verifier).not.toBe(flow2.pkce.verifier);
			expect(flow1.url).not.toBe(flow2.url);
		});

		// The PKCE pair was produced by @openauthjs/openauth until that package
		// was dropped. Every assertion above passes for a challenge that is not
		// actually derived from the verifier - the server would reject the token
		// exchange and nothing here would notice. Pin the derivation itself,
		// recomputed through a different crypto API than the implementation uses.
		it('derives the challenge as base64url(SHA-256(verifier))', async () => {
			const { pkce } = await createAuthorizationFlow();

			const expected = createHash('sha256')
				.update(pkce.verifier, 'ascii')
				.digest('base64url');

			expect(pkce.challenge).toBe(expected);
		});

		it('emits an RFC 7636-conformant verifier and challenge', async () => {
			const { pkce } = await createAuthorizationFlow();

			// Unpadded base64url only - no "+", "/" or "=".
			expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);

			// 64 random bytes -> 86 chars, inside the 43-128 the RFC allows.
			expect(pkce.verifier).toHaveLength(86);
			expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
			expect(pkce.verifier.length).toBeLessThanOrEqual(128);

			// A SHA-256 digest is 32 bytes -> 43 unpadded base64url chars.
			expect(pkce.challenge).toHaveLength(43);
		});
	});

	describe('exchangeAuthorizationCode', () => {
		it('returns success with tokens on valid response', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'access-123',
					refresh_token: 'refresh-456',
					expires_in: 3600,
					id_token: 'id-token-789',
					scope: SCOPE,
				}), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
				expect(result).toEqual({
					type: 'success',
					access: 'access-123',
					refresh: 'refresh-456',
					expires: 3_601_000,
					idToken: 'id-token-789',
					scope: SCOPE,
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it('returns success with empty refresh token when not provided', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'access-123',
					expires_in: 3600,
				}), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
				expect(result).toEqual({
					type: 'success',
					access: 'access-123',
					refresh: '',
					expires: 3_601_000,
					idToken: undefined,
					scope: SCOPE,
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		// Issue #213: `??` let a blank scope through, and that blank value then
		// overwrote known-good scope metadata via `result.scope ?? existing`.
		it('falls back to the requested scope when the response scope is blank', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'access-123',
					refresh_token: 'refresh-123',
					expires_in: 3600,
					scope: '   ',
				}), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('auth-code', 'verifier-123');
				expect(result.type).toBe('success');
				if (result.type === 'success') {
					expect(result.scope).toBe(SCOPE);
				}
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it('returns failed for HTTP error response', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response('Bad Request', { status: 400 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('bad-code', 'verifier');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
					expect(result.statusCode).toBe(400);
					expect(result.message).toBe('Bad Request');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed with undefined message when text read fails', async () => {
			const originalFetch = globalThis.fetch;
			const mockResponse = {
				ok: false,
				status: 500,
				text: vi.fn().mockRejectedValue(new Error('Read failed')),
			};
			globalThis.fetch = vi.fn(async () => mockResponse) as never;

			try {
				const result = await exchangeAuthorizationCode('code', 'verifier');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeUndefined();
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed for invalid response schema', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ wrong: 'schema' }), { status: 200 }),
			) as never;

			try {
				const result = await exchangeAuthorizationCode('code', 'verifier');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('invalid_response');
					expect(result.message).toBe('Response failed schema validation');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('uses custom redirect URI when provided', async () => {
			const originalFetch = globalThis.fetch;
			let capturedBody: URLSearchParams | undefined;
			globalThis.fetch = vi.fn(async (_url, init) => {
				capturedBody = init?.body as URLSearchParams;
				return new Response(JSON.stringify({
					access_token: 'access',
					expires_in: 3600,
				}), { status: 200 });
			}) as never;

			try {
				await exchangeAuthorizationCode('code', 'verifier', 'http://custom:8080/callback');
				expect(capturedBody?.get('redirect_uri')).toBe('http://custom:8080/callback');
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe('refreshAccessToken', () => {
		it('keeps existing refresh token when missing in response', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ access_token: 'new-access', expires_in: 60 }), {
					status: 200,
				}),
			) as never;

			try {
				const result = await refreshAccessToken('existing-refresh');
			expect(result).toEqual({
				type: 'success',
				access: 'new-access',
				refresh: 'existing-refresh',
				expires: 61_000,
				idToken: undefined,
				multiAccount: true,
			});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});

		it('returns failed for HTTP 400 invalid_grant', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
			) as never;

			try {
				const result = await refreshAccessToken('bad-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed for invalid response schema', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({ wrong: 'schema' }), { status: 200 }),
			) as never;

			try {
				const result = await refreshAccessToken('some-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('invalid_response');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed for network errors', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () => {
				throw new Error('Network failed');
			}) as never;

			try {
				const result = await refreshAccessToken('some-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('network_error');
					expect(result.message).toBe('Network failed');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns failed when both response and input have no refresh token', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'new-access',
					expires_in: 60,
					// no refresh_token in response
				}), { status: 200 }),
			) as never;

			try {
				// Pass empty string as refresh token to trigger missing_refresh branch
				const result = await refreshAccessToken('');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('missing_refresh');
					expect(result.message).toBe('No refresh token in response or input');
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns http_error with undefined message when response text is empty', async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response('', { status: 500 }),
			) as never;

			try {
				const result = await refreshAccessToken('some-token');
				expect(result.type).toBe('failed');
				if (result.type === 'failed') {
					expect(result.reason).toBe('http_error');
					expect(result.statusCode).toBe(500);
					expect(result.message).toBeUndefined();
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('returns success with new refresh token from response', async () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					access_token: 'new-access',
					refresh_token: 'new-refresh',
					expires_in: 60,
					id_token: 'new-id-token',
				}), { status: 200 }),
			) as never;

			try {
				const result = await refreshAccessToken('old-refresh');
				expect(result).toEqual({
					type: 'success',
					access: 'new-access',
					refresh: 'new-refresh',
					expires: 61_000,
					idToken: 'new-id-token',
					multiAccount: true,
				});
			} finally {
				globalThis.fetch = originalFetch;
				vi.restoreAllMocks();
			}
		});
	});
});
