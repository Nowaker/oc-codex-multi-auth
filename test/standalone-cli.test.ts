import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function createTempHome() {
	return mkdtemp(join(tmpdir(), "oc-codex-standalone-"));
}

describe("standalone oc-codex-multi-auth CLI commands", () => {
	let tempHome: string | null = null;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it("runs status as JSON without installer writes", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						accountLabel: "Personal",
						email: "user@example.com",
						accountId: "acct_123456789",
						accountIdSource: "token",
						refreshToken: "refresh-token",
						accessToken: "access-token",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			}, null, 2),
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ action: "status", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.totalAccounts).toBe(1);
		expect(output.accounts[0].email).toBe("user....com");
	});

	it("rejects unknown positional commands instead of installing", async () => {
		vi.resetModules();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["wat"])).rejects.toThrow("Unknown command: wat");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
	});

	async function writeAccounts(home: string, accounts: unknown[]) {
		const opencodeDir = join(home, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({ version: 3, activeIndex: 0, accounts }, null, 2),
			"utf-8",
		);
	}

	const freshAccount = (over: Record<string, unknown> = {}) => ({
		email: "warm@example.com",
		accountId: "acct_warm",
		refreshToken: "rt-warm",
		accessToken: "at-warm",
		// Far-future expiry so ensureCodexUsageAccessToken skips a real refresh
		// and the warm path reaches the (mocked) fetch deterministically.
		expiresAt: Date.now() + 3_600_000,
		addedAt: Date.now(),
		lastUsed: Date.now(),
		...over,
	});

	it("warm: empty pool reports 0/0/0 and exits 0 (no network)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 0, warmed: 0, failed: 0, skipped: 0 });
	});

	it("warm: opens the window for an enabled account when upstream returns 200", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue({
				ok: true,
				status: 200,
				body: { cancel: async () => undefined },
				text: async () => "",
			} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 1, warmed: 1, failed: 0, skipped: 0 });
		expect(output.results[0]).toMatchObject({ index: 0, status: "warmed" });
		// Hit the real /codex/responses endpoint, not a usage GET.
		expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("/codex/responses");
		expect(fetchSpy.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST" });
	});

	it("warm: a quota-429 account is reported failed (NOT warmed) and exits 1", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 429,
			body: { cancel: async () => undefined },
			text: async () => JSON.stringify({ error: { code: "usage_limit_reached" } }),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 1 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ warmed: 0, failed: 1 });
		expect(output.results[0].detail).toMatch(/quota|usage/i);
	});

	it("warm: skips a disabled account without any upstream call", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ enabled: false })]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ warmed: 0, failed: 0, skipped: 1 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("warm: masks emails by default in output", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ enabled: false })]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["warm", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.results[0].email).not.toBe("warm@example.com");
		expect(output.results[0].email).toContain("...");
	});

	const usagePayload = {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 18,
				limit_window_seconds: 18_000,
				reset_at: Math.floor(Date.now() / 1000) + 3_600,
			},
			secondary_window: {
				used_percent: 42,
				limit_window_seconds: 604_800,
				reset_at: Math.floor(Date.now() / 1000) + 86_400,
			},
		},
	};

	it("limits: empty pool reports no accounts and exits 0 (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 0, accounts: [] });
	});

	it("limits: reports live 5h and weekly windows per account (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.totalAccounts).toBe(1);
		const names = output.accounts[0].limits.map((limit: { name: string }) => limit.name);
		expect(names).toContain("5h limit");
		expect(names).toContain("Weekly limit");
		expect(output.accounts[0].limits[0].leftPercent).toBe(82);
		expect(output.accounts[0].planType).toBe("plus");
		expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("/wham/usage");
	});

	it("limits: renders the windows in text output rather than a bare account list (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("5h limit: 82% left");
		expect(printed).toContain("Weekly limit: 58% left");
	});

	it("limits: --tag only contacts matching accounts", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [
			freshAccount({ email: "tagged@example.com", accountTags: ["work"] }),
			freshAccount({
				email: "untagged@example.com",
				accountId: "acct_other",
				refreshToken: "rt-other",
			}),
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--tag", "work", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// The untagged account must not be fetched: that would bill it a usage
		// request and could persist refreshed credentials for it.
		expect(output.accounts).toHaveLength(1);
		expect(output.accounts[0].index).toBe(0);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("limits: redacts token material leaked by a failing refresh", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 401,
			text: async () =>
				'{"error":"invalid_grant","refresh_token":"rt-super-secret-value"}',
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].error).not.toContain("rt-super-secret-value");
	});

	it("limits: an account whose usage fetch fails is reported and exits 1 (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "upstream boom",
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 1 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].error).toContain("500");
	});
});

