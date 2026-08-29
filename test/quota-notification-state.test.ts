import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	readQuotaNotificationState,
	updateQuotaNotificationState,
} from "../lib/quota-notification-state.js";

describe("quota notification state", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await fs.rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("atomically creates and reads validated state", async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "quota-state-"));
		const statePath = join(directory, "state.json");
		const state = {
			fiveHour: { lastPercent: 20, activeThreshold: 25 },
			weekly: { lastPercent: 50 },
			lastDeliveredAt: 100,
			updatedAt: 123,
		};

		const result = await updateQuotaNotificationState(statePath, (previous) => {
			expect(previous).toBeUndefined();
			return { state, result: "written" };
		});

		expect(result).toBe("written");
		expect(await readQuotaNotificationState(statePath)).toEqual(state);
	});

	it("rejects the obsolete shared-band state shape", async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "quota-state-"));
		const statePath = join(directory, "state.json");
		await fs.writeFile(
			statePath,
			JSON.stringify({ activeThresholdBands: [25], updatedAt: 123 }),
			"utf-8",
		);
		expect(await readQuotaNotificationState(statePath)).toBeUndefined();
	});
});
