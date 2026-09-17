import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	describePluginOrigin,
	findReplacedLocalCheckout,
	getPluginOriginHistoryPath,
	isPackageManagerRoot,
	readPluginOriginHistory,
	recordPluginOrigin,
	resolvePluginOrigin,
	withSighting,
	type PluginOrigin,
	type PluginOriginHistory,
} from "../lib/plugin-origin.js";

async function createTempRoot() {
	return mkdtemp(join(tmpdir(), "oc-codex-origin-"));
}

async function createPackage(root: string, name: string, version: string) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({ name, version }), "utf-8");
	return root;
}

function localCheckout(root: string): PluginOrigin {
	return { name: "oc-codex-multi-auth", version: "1.0.0", root, isLocalCheckout: true };
}

function installedPackage(root: string): PluginOrigin {
	return { name: "oc-codex-multi-auth", version: "2.0.0", root, isLocalCheckout: false };
}

function historyOf(...sightings: PluginOriginHistory["sightings"]): PluginOriginHistory {
	return { version: 1, sightings };
}

describe("plugin-origin", () => {
	let tempRoot: string | null = null;

	afterEach(async () => {
		if (tempRoot) {
			await rm(tempRoot, { recursive: true, force: true });
			tempRoot = null;
		}
	});

	describe("resolvePluginOrigin", () => {
		it("reads the name and version off the nearest enclosing package", async () => {
			tempRoot = await createTempRoot();
			const packageRoot = await createPackage(
				join(tempRoot, "checkout"),
				"oc-codex-multi-auth",
				"6.21.0",
			);
			const moduleUrl = pathToFileURL(join(packageRoot, "dist", "lib", "plugin-origin.js")).href;

			expect(resolvePluginOrigin(moduleUrl)).toEqual({
				name: "oc-codex-multi-auth",
				version: "6.21.0",
				root: packageRoot,
				isLocalCheckout: true,
			});
		});

		it("reports a package-manager root as not a local checkout", async () => {
			tempRoot = await createTempRoot();
			const packageRoot = await createPackage(
				join(tempRoot, "node_modules", "oc-codex-multi-auth"),
				"oc-codex-multi-auth",
				"6.21.0",
			);
			const moduleUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;

			expect(resolvePluginOrigin(moduleUrl)?.isLocalCheckout).toBe(false);
		});

		it("returns null when no enclosing package declares a name", async () => {
			tempRoot = await createTempRoot();
			const orphan = join(tempRoot, "a", "b", "c");
			await mkdir(orphan, { recursive: true });

			expect(resolvePluginOrigin(pathToFileURL(join(orphan, "index.js")).href)).toBeNull();
			expect(resolvePluginOrigin("not-a-url")).toBeNull();
		});
	});

	describe("isPackageManagerRoot", () => {
		it.each([
			["/home/dev/node_modules/oc-codex-multi-auth", true],
			["/home/dev/.cache/opencode/packages/oc-codex-multi-auth@latest", true],
			["/home/dev/src/oc-codex-multi-auth", false],
			["/home/dev/workspace/packages/oc-codex-multi-auth", false],
		])("classifies %s", (root, expected) => {
			expect(isPackageManagerRoot(root)).toBe(expected);
		});
	});

	describe("withSighting", () => {
		it("keeps the original firstSeen when the same root is seen again", () => {
			const origin = localCheckout("/src/plugin");
			const first = withSighting(historyOf(), origin, "2026-01-01T00:00:00.000Z");
			const second = withSighting(first, origin, "2026-02-01T00:00:00.000Z");

			expect(second.sightings).toEqual([
				{ ...origin, firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-02-01T00:00:00.000Z" },
			]);
		});

		it("appends a new root instead of replacing the previous one", () => {
			const checkout = localCheckout("/src/plugin");
			const installed = installedPackage("/cache/node_modules/oc-codex-multi-auth");
			const history = withSighting(
				withSighting(historyOf(), checkout, "2026-01-01T00:00:00.000Z"),
				installed,
				"2026-03-01T00:00:00.000Z",
			);

			expect(history.sightings.map((sighting) => sighting.root)).toEqual([
				checkout.root,
				installed.root,
			]);
		});

		it("caps the recorded history", () => {
			let history = historyOf();
			for (let index = 0; index < 25; index += 1) {
				history = withSighting(
					history,
					localCheckout(`/src/plugin-${index}`),
					`2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
				);
			}

			expect(history.sightings).toHaveLength(10);
			expect(history.sightings.at(-1)?.root).toBe("/src/plugin-24");
		});
	});

	describe("readPluginOriginHistory", () => {
		it("returns an empty history for a missing or unreadable file", async () => {
			tempRoot = await createTempRoot();

			expect(readPluginOriginHistory(join(tempRoot, "absent.json")).sightings).toEqual([]);

			const malformed = join(tempRoot, "malformed.json");
			await writeFile(malformed, "{ not json", "utf-8");
			expect(readPluginOriginHistory(malformed).sightings).toEqual([]);
		});

		it("drops entries that do not carry a full sighting", async () => {
			tempRoot = await createTempRoot();
			const historyPath = join(tempRoot, "origin.json");
			const valid = {
				...localCheckout("/src/plugin"),
				firstSeen: "2026-01-01T00:00:00.000Z",
				lastSeen: "2026-01-01T00:00:00.000Z",
			};
			await writeFile(
				historyPath,
				JSON.stringify({ version: 1, sightings: [valid, { root: "/src/other" }, null, 42] }),
				"utf-8",
			);

			expect(readPluginOriginHistory(historyPath).sightings).toEqual([valid]);
		});
	});

	describe("recordPluginOrigin", () => {
		it("persists a sighting that reads back unchanged", async () => {
			tempRoot = await createTempRoot();
			const historyPath = join(tempRoot, "state", "origin.json");
			const origin = localCheckout("/src/plugin");

			const written = await recordPluginOrigin(
				origin,
				historyPath,
				() => new Date("2026-05-05T10:00:00.000Z"),
			);

			expect(written.sightings).toEqual([
				{ ...origin, firstSeen: "2026-05-05T10:00:00.000Z", lastSeen: "2026-05-05T10:00:00.000Z" },
			]);
			expect(readPluginOriginHistory(historyPath)).toEqual(written);
			await expect(readFile(historyPath, "utf-8")).resolves.toContain("\n");
		});

		it("leaves no temporary file behind", async () => {
			tempRoot = await createTempRoot();
			const historyPath = join(tempRoot, "origin.json");

			await recordPluginOrigin(localCheckout("/src/plugin"), historyPath);

			await expect(readFile(`${historyPath}.${process.pid}.tmp`, "utf-8")).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});

	describe("findReplacedLocalCheckout", () => {
		const checkoutSighting = {
			...localCheckout("/src/plugin"),
			firstSeen: "2026-01-01T00:00:00.000Z",
			lastSeen: "2026-02-01T00:00:00.000Z",
		};

		it("reports the checkout that an installed package took over from", () => {
			const installed = installedPackage("/cache/node_modules/oc-codex-multi-auth");

			expect(findReplacedLocalCheckout(installed, historyOf(checkoutSighting))).toEqual(
				checkoutSighting,
			);
		});

		it("stays silent while a checkout is the live origin", () => {
			const other = localCheckout("/src/another-plugin");

			expect(findReplacedLocalCheckout(other, historyOf(checkoutSighting))).toBeNull();
		});

		it("ignores a checkout of a different package", () => {
			const installed = installedPackage("/cache/node_modules/oc-codex-multi-auth");
			const unrelated = { ...checkoutSighting, name: "some-other-plugin" };

			expect(findReplacedLocalCheckout(installed, historyOf(unrelated))).toBeNull();
		});

		it("reports the most recently seen checkout when several are on record", () => {
			const older = { ...checkoutSighting, root: "/src/old", lastSeen: "2026-01-15T00:00:00.000Z" };
			const newer = { ...checkoutSighting, root: "/src/new", lastSeen: "2026-04-01T00:00:00.000Z" };
			const installed = installedPackage("/cache/node_modules/oc-codex-multi-auth");

			expect(findReplacedLocalCheckout(installed, historyOf(older, newer))?.root).toBe("/src/new");
		});
	});

	it("describes each origin in terms a reader can act on", () => {
		expect(describePluginOrigin(localCheckout("/src/plugin"))).toBe(
			"local checkout at /src/plugin (v1.0.0)",
		);
		expect(describePluginOrigin(installedPackage("/cache/pkg"))).toBe("installed package v2.0.0");
		expect(describePluginOrigin(null)).toBe("unknown");
	});

	it("keeps the history beside the other plugin state", () => {
		expect(getPluginOriginHistoryPath("/home/dev")).toBe(
			join("/home", "dev", ".opencode", "oc-codex-multi-auth-origin.json"),
		);
	});
});
