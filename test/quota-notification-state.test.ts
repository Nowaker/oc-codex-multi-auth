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
			fiveHour: { lastPercent: 20 },
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

	it("keeps a state file written by an older version that carried activeThreshold", async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "quota-state-"));
		const statePath = join(directory, "state.json");
		await fs.writeFile(
			statePath,
			JSON.stringify({
				fiveHour: { lastPercent: 20, activeThreshold: 25 },
				weekly: { lastPercent: 50, activeThreshold: 999 },
				updatedAt: 123,
			}),
			"utf-8",
		);

		expect(await readQuotaNotificationState(statePath)).toEqual({
			fiveHour: { lastPercent: 20 },
			weekly: { lastPercent: 50 },
			lastDeliveredAt: undefined,
			updatedAt: 123,
		});
	});

	it("treats an unreadable state file as absent instead of throwing", async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "quota-state-"));
		const statePath = join(directory, "state.json");
		await fs.writeFile(statePath, "{ not json", "utf-8");

		expect(await readQuotaNotificationState(statePath)).toBeUndefined();

		// A corrupt file must not wedge the monitor: the next update overwrites
		// it with a well-formed state.
		const written = await updateQuotaNotificationState(statePath, (previous) => {
			expect(previous).toBeUndefined();
			return {
				state: { fiveHour: { lastPercent: 10 }, weekly: {}, updatedAt: 5 },
				result: "recovered",
			};
		});

		expect(written).toBe("recovered");
		expect(await readQuotaNotificationState(statePath)).toMatchObject({
			fiveHour: { lastPercent: 10 },
			updatedAt: 5,
		});
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
