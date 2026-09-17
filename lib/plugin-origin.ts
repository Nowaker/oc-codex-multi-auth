/**
 * Where this plugin is running from, and where it has run from before.
 *
 * OpenCode can load the plugin from the published package or from a checkout
 * a developer points it at, and the two are indistinguishable at runtime
 * unless the plugin asks. Knowing which one is live decides whether offering
 * an update makes sense, and a record of previous origins is what turns "my
 * edits stopped taking effect" into a diagnosable event.
 */

import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renameWithWindowsRetry } from "./storage/atomic-write.js";

const HISTORY_FILE_NAME = "oc-codex-multi-auth-origin.json";
const HISTORY_VERSION = 1;
const MAX_SIGHTINGS = 10;
const PACKAGE_ROOT_LOOKUP_DEPTH = 3;

export interface PluginOrigin {
	name: string;
	version: string;
	root: string;
	isLocalCheckout: boolean;
}

export interface PluginOriginSighting extends PluginOrigin {
	firstSeen: string;
	lastSeen: string;
}

export interface PluginOriginHistory {
	version: number;
	sightings: PluginOriginSighting[];
}

interface PackageManifest {
	name?: unknown;
	version?: unknown;
}

function emptyHistory(): PluginOriginHistory {
	return { version: HISTORY_VERSION, sightings: [] };
}

function readPackageManifest(directory: string): PackageManifest | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as PackageManifest;
	} catch {
		return null;
	}
}

function manifestName(manifest: PackageManifest | null): string | null {
	const name = manifest?.name;
	return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Built output lives inside the package, so the root is at or above it. */
export function findPackageRoot(startDirectory: string): string | null {
	let current = resolve(startDirectory);
	for (let depth = 0; depth <= PACKAGE_ROOT_LOOKUP_DEPTH; depth += 1) {
		if (manifestName(readPackageManifest(current))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

function pathSegments(path: string): string[] {
	return path.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
}

/**
 * A root a package manager chose, as opposed to one a human did. The version
 * suffix is what separates OpenCode's plugin cache from a monorepo that merely
 * keeps its packages in a `packages/` directory.
 */
export function isPackageManagerRoot(root: string): boolean {
	const segments = pathSegments(root);
	return segments.some(
		(segment, index) =>
			segment === "node_modules" ||
			(segments[index - 1] === "packages" && segment.includes("@")),
	);
}

export function resolvePluginOrigin(moduleUrl: string): PluginOrigin | null {
	let moduleDirectory: string;
	try {
		moduleDirectory = dirname(fileURLToPath(moduleUrl));
	} catch {
		return null;
	}

	const root = findPackageRoot(moduleDirectory);
	if (!root) return null;

	const manifest = readPackageManifest(root);
	const name = manifestName(manifest);
	if (!name) return null;
	const version = typeof manifest?.version === "string" ? manifest.version : "0.0.0";

	return { name, version, root, isLocalCheckout: !isPackageManagerRoot(root) };
}

let cachedOrigin: PluginOrigin | null | undefined;

/** The origin of this running build. Fixed for the life of the process. */
export function getPluginOrigin(): PluginOrigin | null {
	if (cachedOrigin === undefined) cachedOrigin = resolvePluginOrigin(import.meta.url);
	return cachedOrigin;
}

export function getPluginOriginHistoryPath(home: string = homedir()): string {
	return join(home, ".opencode", HISTORY_FILE_NAME);
}

function isSighting(value: unknown): value is PluginOriginSighting {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.version === "string" &&
		typeof candidate.root === "string" &&
		typeof candidate.isLocalCheckout === "boolean" &&
		typeof candidate.firstSeen === "string" &&
		typeof candidate.lastSeen === "string"
	);
}

export function readPluginOriginHistory(
	historyPath: string = getPluginOriginHistoryPath(),
): PluginOriginHistory {
	try {
		const parsed: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyHistory();
		const sightings = (parsed as { sightings?: unknown }).sightings;
		if (!Array.isArray(sightings)) return emptyHistory();
		return { version: HISTORY_VERSION, sightings: sightings.filter(isSighting) };
	} catch {
		return emptyHistory();
	}
}

function byLastSeen(left: PluginOriginSighting, right: PluginOriginSighting): number {
	return (Date.parse(left.lastSeen) || 0) - (Date.parse(right.lastSeen) || 0);
}

/**
 * History is appended to rather than overwritten, so one origin replacing
 * another leaves both on record. A last-writer-wins marker would instead
 * confirm whatever state a clobber left behind.
 */
export function withSighting(
	history: PluginOriginHistory,
	origin: PluginOrigin,
	seenAt: string,
): PluginOriginHistory {
	const previous = history.sightings.find((sighting) => sighting.root === origin.root);
	const others = history.sightings.filter((sighting) => sighting.root !== origin.root);
	const current: PluginOriginSighting = {
		...origin,
		firstSeen: previous?.firstSeen ?? seenAt,
		lastSeen: seenAt,
	};
	return {
		version: HISTORY_VERSION,
		sightings: [...others, current].slice(-MAX_SIGHTINGS),
	};
}

export async function recordPluginOrigin(
	origin: PluginOrigin,
	historyPath: string = getPluginOriginHistoryPath(),
	now: () => Date = () => new Date(),
): Promise<PluginOriginHistory> {
	const next = withSighting(readPluginOriginHistory(historyPath), origin, now().toISOString());
	const temporaryPath = `${historyPath}.${process.pid}.tmp`;

	await mkdir(dirname(historyPath), { recursive: true });
	await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	try {
		await renameWithWindowsRetry(temporaryPath, historyPath);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}

	return next;
}

/**
 * The checkout this plugin used to run from and no longer does. Reported only
 * when the current origin is package-manager output, since a move between two
 * checkouts is an ordinary thing to do deliberately.
 */
export function findReplacedLocalCheckout(
	origin: PluginOrigin,
	history: PluginOriginHistory,
): PluginOriginSighting | null {
	if (origin.isLocalCheckout) return null;
	return (
		history.sightings
			.filter(
				(sighting) =>
					sighting.name === origin.name &&
					sighting.isLocalCheckout &&
					sighting.root !== origin.root,
			)
			.sort(byLastSeen)
			.at(-1) ?? null
	);
}

export function describePluginOrigin(origin: PluginOrigin | null): string {
	if (!origin) return "unknown";
	return origin.isLocalCheckout
		? `local checkout at ${origin.root} (v${origin.version})`
		: `installed package v${origin.version}`;
}
