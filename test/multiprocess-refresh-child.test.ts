import { access, appendFile, writeFile, watch } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { describe, it, vi } from "vitest";

vi.mock("../lib/auth/auth.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/auth/auth.js")>()),
	refreshAccessToken: vi.fn(async () => {
		const exchangeLog = process.env["MULTIPROCESS_EXCHANGE_LOG"];
		if (!exchangeLog) {
			throw new Error("MULTIPROCESS_EXCHANGE_LOG is required");
		}
		await appendFile(exchangeLog, `${process.pid}\n`, "utf8");
		return {
			type: "success" as const,
			access: `access-${process.pid}`,
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		};
	}),
}));

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function waitForFile(filePath: string): Promise<void> {
	const controller = new AbortController();
	const watcher = watch(dirname(filePath), { signal: controller.signal });
	try {
		try {
			await access(filePath);
			return;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}

		for await (const event of watcher) {
			if (event.filename === basename(filePath)) return;
		}
	} finally {
		controller.abort();
	}
}

const childMode = process.env["MULTIPROCESS_CHILD_MODE"];

describe.skipIf(childMode === undefined)("multiprocess refresh child", () => {
	it("runs the requested child-process operation", async () => {
		// given
		const storagePath = requiredEnvironment("MULTIPROCESS_STORAGE_PATH");
		const readyPath = requiredEnvironment("MULTIPROCESS_READY_PATH");
		const goPath = requiredEnvironment("MULTIPROCESS_GO_PATH");
		const { setStoragePathDirect, withAccountStorageTransaction } = await import(
			"../lib/storage.js"
		);
		setStoragePathDirect(storagePath);

		try {
			if (childMode === "lease-holder") {
				await withAccountStorageTransaction(async () => {
					await writeFile(readyPath, "ready", "utf8");
					await waitForFile(goPath);
				});
				return;
			}

			const resultPath = requiredEnvironment("MULTIPROCESS_RESULT_PATH");
			const { refreshAndPersistAccount } = await import(
				"../lib/tools/refresh-account.js"
			);
			await writeFile(readyPath, "ready", "utf8");
			await waitForFile(goPath);

			// when
			const outcome = await refreshAndPersistAccount({
				index: 0,
				identity: {
					organizationId: "organization-1",
					accountId: "workspace-1",
					accountUserId: "member-1",
					refreshToken: "refresh-0",
				},
			});
			await writeFile(resultPath, JSON.stringify(outcome), "utf8");

		} finally {
			setStoragePathDirect(null);
		}
	}, 20_000);
});
