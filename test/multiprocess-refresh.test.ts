import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	loadAccounts,
	setStoragePathDirect,
	withAccountStorageTransaction,
} from "../lib/storage.js";
import { waitForFile } from "./support/wait-for-file.js";

type ChildResult = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly output: string;
};

type ChildRun = {
	readonly process: ChildProcessWithoutNullStreams;
	readonly completed: Promise<ChildResult>;
};

function runChild(environment: Readonly<Record<string, string>>): ChildRun {
	const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
	const vitestCli = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
	const child = spawn(
		process.execPath,
		[
			vitestCli,
			"run",
			"test/multiprocess-refresh-child.test.ts",
			"--reporter=dot",
			"--pool=forks",
			"--maxWorkers=1",
		],
		{
			cwd: repositoryRoot,
			env: { ...process.env, ...environment },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	const completed = new Promise<ChildResult>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal, output }));
	});
	return { process: child, completed };
}

async function expectReady(run: ChildRun, readyPath: string): Promise<void> {
	const ready = await Promise.race([
		waitForFile(readyPath).then(() => true),
		run.completed.then(() => false),
	]);
	if (!ready) {
		const result = await run.completed;
		throw new Error(`Child exited before becoming ready:\n${result.output}`);
	}
}

function accountStorage(): object {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				organizationId: "organization-1",
				accountId: "workspace-1",
				accountUserId: "member-1",
				refreshToken: "refresh-0",
				accessToken: "access-0",
				expiresAt: 0,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
}

describe("same-host multiprocess account coordination", () => {
	let directory: string;
	let storagePath: string;
	const children = new Set<ChildRun>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-multiprocess-"));
		storagePath = join(directory, "accounts.json");
		await writeFile(storagePath, JSON.stringify(accountStorage()), { mode: 0o600 });
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		for (const run of children) {
			if (run.process.exitCode === null && run.process.signalCode === null) {
				run.process.kill("SIGKILL");
			}
		}
		await Promise.allSettled([...children].map((run) => run.completed));
		children.clear();
		setStoragePathDirect(null);
		await rm(directory, { recursive: true, force: true });
	});

	it("exchanges a shared current refresh token only once across two processes", async () => {
		// given
		const exchangeLog = join(directory, "exchange.log");
		await writeFile(exchangeLog, "", "utf8");
		const paths = [0, 1].map((index) => ({
			ready: join(directory, `ready-${index}`),
			go: join(directory, `go-${index}`),
			result: join(directory, `result-${index}.json`),
		}));
		const runs = paths.map((pathSet) => {
			const run = runChild({
				MULTIPROCESS_CHILD_MODE: "refresh",
				MULTIPROCESS_STORAGE_PATH: storagePath,
				MULTIPROCESS_EXCHANGE_LOG: exchangeLog,
				MULTIPROCESS_READY_PATH: pathSet.ready,
				MULTIPROCESS_GO_PATH: pathSet.go,
				MULTIPROCESS_RESULT_PATH: pathSet.result,
			});
			children.add(run);
			return run;
		});
		await Promise.all(runs.map((run, index) => expectReady(run, paths[index]?.ready ?? "")));

		// when
		await Promise.all(paths.map((pathSet) => writeFile(pathSet.go, "go", "utf8")));
		const childResults = await Promise.all(runs.map((run) => run.completed));

		// then
		for (const result of childResults) {
			expect(result.code, result.output).toBe(0);
		}
		const outcomes = await Promise.all(
			paths.map(async (pathSet) => JSON.parse(await readFile(pathSet.result, "utf8"))),
		);
		const exchanges = (await readFile(exchangeLog, "utf8")).trim().split("\n").filter(Boolean);
		expect(exchanges, JSON.stringify(outcomes)).toHaveLength(1);
		for (const outcome of outcomes) {
			expect(outcome).toMatchObject({ status: "refreshed" });
		}
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-1");
		expect(stored?.accounts[0]?.tokenRotatedAt).toBeTypeOf("number");
	}, 20_000);

	it("reclaims a stale transaction lease after its owner crashes", async () => {
		// given
		const readyPath = join(directory, "holder-ready");
		const goPath = join(directory, "holder-go");
		const exchangeLog = join(directory, "unused-exchange.log");
		await writeFile(exchangeLog, "", "utf8");
		const holder = runChild({
			MULTIPROCESS_CHILD_MODE: "lease-holder",
			MULTIPROCESS_STORAGE_PATH: storagePath,
			MULTIPROCESS_EXCHANGE_LOG: exchangeLog,
			MULTIPROCESS_READY_PATH: readyPath,
			MULTIPROCESS_GO_PATH: goPath,
		});
		children.add(holder);
		await expectReady(holder, readyPath);
		const leasePath = `${storagePath}.transaction.lock`;
		await stat(leasePath);

		// when
		holder.process.kill("SIGKILL");
		await holder.completed;
		const staleTime = new Date(Date.now() - 60_000);
		await utimes(leasePath, staleTime, staleTime);
		await withAccountStorageTransaction(async (current, persist) => {
			if (!current?.accounts[0]) throw new Error("Expected account fixture");
			current.accounts[0].accountLabel = "survived-crash";
			await persist(current);
		});

		// then
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.accountLabel).toBe("survived-crash");
	}, 20_000);
});
