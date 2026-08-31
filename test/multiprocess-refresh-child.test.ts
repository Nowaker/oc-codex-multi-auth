import { appendFile, writeFile } from "node:fs/promises";

import { describe, it, vi } from "vitest";

import { waitForFile } from "./support/wait-for-file.js";

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
