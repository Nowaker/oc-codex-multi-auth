import { readFileSync, existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import type { PluginConfig } from "./types.js";
import {
	normalizeRetryBudgetValue,
	type RetryBudgetOverrides,
	type RetryProfile,
} from "./request/retry-budget.js";
import { logWarn } from "./logger.js";
import { stripEffortSuffix } from "./request/helpers/effort-suffix.js";
import {
	isWindowsLockError,
	renameWithWindowsRetry,
} from "./storage/atomic-write.js";
import { ConfigLockContentionError } from "./errors.js";
import {
	PluginConfigSchema,
	getValidationErrors,
	EnvBooleanSchema,
	EnvNumberSchema,
	makeEnvEnumSchema,
} from "./schemas.js";

const CONFIG_PATH = join(homedir(), ".opencode", "openai-codex-auth-config.json");
const TUI_COLOR_PROFILES = new Set(["truecolor", "ansi16", "ansi256"]);
const TUI_GLYPH_MODES = new Set(["ascii", "unicode", "auto"]);
const REQUEST_TRANSFORM_MODES = new Set(["native", "legacy"]);
const UNSUPPORTED_CODEX_POLICIES = new Set(["strict", "fallback"]);
const RETRY_PROFILES = new Set(["conservative", "balanced", "aggressive"]);

export type UnsupportedCodexPolicy = "strict" | "fallback";

export type ModelAccountPoolMode = "preferred" | "strict";

export type ModelAccountPoolMutation =
	| "set"
	| "add"
	| "remove"
	| "clear"
	| "set-mode";

export interface ModelAccountPoolMutationResult {
	model: string;
	previousAccountIds: string[];
	accountIds: string[];
	previousPoolMode: ModelAccountPoolMode;
	poolMode: ModelAccountPoolMode;
	changed: boolean;
	dryRun: boolean;
}

export interface ModelAccountPoolMutationOptions {
	dryRun?: boolean;
	poolMode?: ModelAccountPoolMode;
	normalizeExistingAccountIds?: (accountIds: readonly string[]) => readonly string[];
}

let modelAccountPoolMutationQueue: Promise<void> = Promise.resolve();

/**
 * Default plugin configuration
 * CODEX_MODE is enabled by default for better Codex CLI parity
 */
const DEFAULT_CONFIG: PluginConfig = {
	codexMode: true,
	requestTransformMode: "native",
	codexTuiV2: true,
	codexTuiColorProfile: "truecolor",
	codexTuiGlyphMode: "ascii",
	maskEmail: false,
	maskEmailInQuotaDetails: false,
	beginnerSafeMode: false,
	fastSession: false,
	fastSessionStrategy: "hybrid",
	rotationStrategy: "hybrid",
	fastSessionMaxInputItems: 30,
	retryProfile: "balanced",
	retryBudgetOverrides: {},
	retryAllAccountsRateLimited: true,
	retryAllAccountsMaxWaitMs: 0,
	retryAllAccountsMaxRetries: Infinity,
	unsupportedCodexPolicy: "strict",
	fallbackOnUnsupportedCodexModel: false,
	fallbackToGpt52OnUnsupportedGpt53: true,
	unsupportedCodexFallbackChain: {},
	tokenRefreshSkewMs: 60_000,
	rateLimitToastDebounceMs: 60_000,
	toastDurationMs: 5_000,
	accountToasts: true,
	perProjectAccounts: true,
	sessionRecovery: true,
	autoResume: true,
	autoUpdate: true,
	parallelProbing: false,
	parallelProbingMaxConcurrency: 2,
	emptyResponseMaxRetries: 2,
	emptyResponseRetryDelayMs: 1_000,
	pidOffsetEnabled: false,
	fetchTimeoutMs: 60_000,
	streamStallTimeoutMs: 45_000,
};

/**
 * Load plugin configuration from ~/.opencode/openai-codex-auth-config.json
 * Falls back to defaults if file doesn't exist or is invalid
 *
 * @returns Plugin configuration
 */
export function loadPluginConfig(): PluginConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			return DEFAULT_CONFIG;
		}

		const fileContent = readFileSync(CONFIG_PATH, "utf-8");
		const normalizedFileContent = stripUtf8Bom(fileContent);
		const userConfig = JSON.parse(normalizedFileContent) as unknown;
		const hasFallbackEnvOverride =
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL !== undefined ||
			process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52 !== undefined;
		if (isRecord(userConfig)) {
			const hasPolicyKey = Object.hasOwn(userConfig, "unsupportedCodexPolicy");
			const hasLegacyFallbackKey =
				Object.hasOwn(userConfig, "fallbackOnUnsupportedCodexModel") ||
				Object.hasOwn(userConfig, "fallbackToGpt52OnUnsupportedGpt53") ||
				Object.hasOwn(userConfig, "unsupportedCodexFallbackChain");
			if (!hasPolicyKey && (hasLegacyFallbackKey || hasFallbackEnvOverride)) {
				logWarn(
					"Legacy unsupported-model fallback settings detected without unsupportedCodexPolicy. " +
						'Using backward-compat behavior; prefer unsupportedCodexPolicy: "strict" | "fallback".',
				);
			}
		}

		// RC-9: validate at the process boundary. Reject anything that is not
		// a JSON object, then route through PluginConfigSchema so bad values
		// from an external config file never flow into the merged runtime
		// config. Callers still see DEFAULT_CONFIG as the base, so an invalid
		// file degrades gracefully instead of silently mis-configuring retry
		// budgets, timeouts, or feature flags.
		if (!isRecord(userConfig)) {
			logWarn(
				`Plugin config at ${CONFIG_PATH} is not a JSON object; using defaults.`,
			);
			return DEFAULT_CONFIG;
		}

		const parseResult = PluginConfigSchema.safeParse(userConfig);
		if (parseResult.success) {
			return {
				...DEFAULT_CONFIG,
				...parseResult.data,
			};
		}

		// Top-level schema failed. Preserve legacy logging so existing
		// operators still see the familiar "validation warnings" string, then
		// salvage the subset of keys that individually pass validation so a
		// single bad field does not wipe out every other user setting.
		const schemaErrors = getValidationErrors(PluginConfigSchema, userConfig);
		logWarn(
			`Plugin config validation warnings: ${schemaErrors.slice(0, 3).join(", ")}`,
		);
		const salvaged = salvageValidKeys(userConfig);
		return { ...DEFAULT_CONFIG, ...salvaged };
	} catch (error) {
		logWarn(
			`Failed to load config from ${CONFIG_PATH}: ${(error as Error).message}`,
		);
		return DEFAULT_CONFIG;
	}
}

type LockRetryBudget = {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
	randomize: boolean;
};

/**
 * Full budget: roughly three seconds of retries, enough to ride out another
 * process finishing a mutation of its own.
 */
const LOCK_RETRY_BUDGET_FULL: LockRetryBudget = {
	retries: 20,
	factor: 1.2,
	minTimeout: 25,
	maxTimeout: 200,
	randomize: true,
};

/**
 * Short budget used once contention has just been observed: long enough to win
 * a lock its holder is releasing right now, far short of the full budget.
 */
const LOCK_RETRY_BUDGET_PROBE: LockRetryBudget = {
	retries: 3,
	factor: 1.2,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: true,
};

/** How long one contention observation keeps later mutations on the probe budget. */
const LOCK_CONTENTION_FAST_FAIL_WINDOW_MS = 1_000;

/**
 * When another process was last seen holding the config lock past our budget.
 *
 * `modelAccountPoolMutationQueue` serializes every in-process mutation, so
 * without this each queued caller independently waited out the full budget
 * against the same foreign holder: ten parallel `codex-pool` calls blocked for
 * ten times the budget and then all failed anyway, which is the "completely
 * stalls the sub tasks" half of #224. Once one call has established that the
 * lock is externally held, the rest probe briefly and degrade immediately, so
 * the stall is bounded rather than multiplied by the queue depth.
 */
let lastLockContentionAt: number | null = null;

function nextLockRetryBudget(): LockRetryBudget {
	if (lastLockContentionAt === null) return LOCK_RETRY_BUDGET_FULL;
	if (
		Date.now() - lastLockContentionAt >=
		LOCK_CONTENTION_FAST_FAIL_WINDOW_MS
	) {
		lastLockContentionAt = null;
		return LOCK_RETRY_BUDGET_FULL;
	}
	return LOCK_RETRY_BUDGET_PROBE;
}

/** Test hook: forget any observed contention so budgets start from full. */
export function __resetLockContentionStateForTests(): void {
	lastLockContentionAt = null;
}

/**
 * Update one model pool while preserving every unrelated raw config key.
 * Account indexes are deliberately resolved by the caller; only stable IDs
 * cross this persistence boundary.
 */
export function updateModelAccountPool(
	model: string,
	mutation: ModelAccountPoolMutation,
	accountIds: readonly string[] = [],
	options: ModelAccountPoolMutationOptions = {},
): Promise<ModelAccountPoolMutationResult> {
	const pending = modelAccountPoolMutationQueue.then(async () => {
		if (options.dryRun === true) {
			return performModelAccountPoolMutation(
				model,
				mutation,
				accountIds,
				options,
			);
		}

		await fs.mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
		let release: () => Promise<void>;
		try {
			release = await lock(CONFIG_PATH, {
				realpath: false,
				stale: 10_000,
				update: 2_000,
				// proper-lockfile's default `onCompromised` rethrows from inside an
				// fs callback. Nothing in this process installs an
				// `uncaughtException` handler, so a lock that goes stale mid-mutation
				// (event loop blocked past `stale`, or another process reclaiming the
				// entry) would take the whole plugin down instead of failing this one
				// call. The mutation is already in flight and cannot be rolled back,
				// so the only useful response is to record it; the release below
				// tolerates the ERELEASED that follows.
				onCompromised: (error: Error) => {
					logWarn(
						`Plugin configuration lock at ${CONFIG_PATH} was compromised mid-mutation: ${error.message}`,
					);
				},
				retries: nextLockRetryBudget(),
			});
			lastLockContentionAt = null;
		} catch (error) {
			if (isLockContentionError(error)) {
				lastLockContentionAt = Date.now();
				throw new ConfigLockContentionError(CONFIG_PATH, error);
			}
			throw error;
		}
		try {
			return await performModelAccountPoolMutation(
				model,
				mutation,
				accountIds,
				options,
			);
		} finally {
			// A release failure must never replace the mutation's outcome. By this
			// point the config has already been written, so surfacing ERELEASED (or
			// a Windows EPERM/EBUSY on the lock directory, which `removeLock`
			// propagates straight from `rmdir`) would report a fatal lock error for
			// a change that actually landed - the exact symptom this fix removes.
			await releaseLockQuietly(release);
		}
	});
	modelAccountPoolMutationQueue = pending.then(
		() => undefined,
		() => undefined,
	);
	return pending;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

/**
 * True when a lock acquisition failure means "another process holds it", as
 * opposed to a genuine environment fault the caller must see.
 *
 * proper-lockfile forwards raw fs errors from the lock directory's
 * `mkdir`/`stat`/`rmdir` straight into its retry loop, so the error that
 * finally escapes (`operation.mainError()`) is not always ELOCKED. On Windows a
 * lock directory held open by another process - or by an antivirus scanner or
 * the search indexer - surfaces as EPERM/EBUSY rather than EEXIST, the same
 * class `renameWithWindowsRetry` already tolerates one layer down. Those codes
 * count as contention only on win32; on POSIX an EPERM really is a permission
 * problem and has to stay fatal.
 */
function isLockContentionError(error: unknown): boolean {
	if (hasErrorCode(error, "ELOCKED")) return true;
	return process.platform === "win32" && isWindowsLockError(error);
}

/** Release a config lock, downgrading any failure to a warning. */
async function releaseLockQuietly(release: () => Promise<void>): Promise<void> {
	try {
		await release();
	} catch (error) {
		// Losing the lock directory is recoverable on its own: `stale` reclaims a
		// leftover entry within 10s, and the mutation it guarded is already
		// durable on disk.
		logWarn(
			`Failed to release plugin configuration lock at ${CONFIG_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function performModelAccountPoolMutation(
	model: string,
	mutation: ModelAccountPoolMutation,
	accountIds: readonly string[],
	options: ModelAccountPoolMutationOptions,
): Promise<ModelAccountPoolMutationResult> {
	const normalizedModel = model.trim().toLowerCase();
	if (!normalizedModel) throw new Error("Model is required.");

	let rawConfig: Record<string, unknown> = {};
	try {
		const content = await fs.readFile(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(stripUtf8Bom(content)) as unknown;
		if (!isRecord(parsed) || Array.isArray(parsed)) {
			throw new Error(`Plugin config at ${CONFIG_PATH} is not a JSON object.`);
		}
		rawConfig = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const poolResult = PluginConfigSchema.safeParse({
		modelAccountPools: rawConfig.modelAccountPools,
		modelAccountPoolModes: rawConfig.modelAccountPoolModes,
	});
	if (!poolResult.success) {
		throw new Error(
			`Existing modelAccountPools configuration is invalid: ${getValidationErrors(
				PluginConfigSchema,
				{ modelAccountPools: rawConfig.modelAccountPools },
			)[0] ?? "validation failed"}`,
		);
	}

	const pools = { ...(poolResult.data.modelAccountPools ?? {}) };
	const poolModes = { ...(poolResult.data.modelAccountPoolModes ?? {}) };
	const matchingKeys = Object.keys(pools).filter(
		(key) => key.trim().toLowerCase() === normalizedModel,
	);
	const matchingModeKeys = Object.keys(poolModes).filter(
		(key) => key.trim().toLowerCase() === normalizedModel,
	);
	const storedPreviousAccountIds = Array.from(
		new Set(matchingKeys.flatMap((key) => pools[key] ?? [])),
	);
	const previousAccountIds = Array.from(
		new Set(
			(options.normalizeExistingAccountIds?.(storedPreviousAccountIds) ??
				storedPreviousAccountIds)
				.map((id) => id.trim())
				.filter(Boolean),
		),
	);
	for (const key of matchingKeys) delete pools[key];
	const previousPoolMode = matchingModeKeys
		.map((key) => poolModes[key])
		.find((mode): mode is ModelAccountPoolMode => mode !== undefined) ?? "preferred";
	for (const key of matchingModeKeys) delete poolModes[key];
	if (mutation === "set-mode" && previousAccountIds.length === 0) {
		throw new Error(`No model account pool configured for ${normalizedModel}.`);
	}
	if (mutation === "set-mode" && options.poolMode === undefined) {
		throw new Error("poolMode is required for set-mode.");
	}

	const normalizedAccountIds = Array.from(
		new Set(accountIds.map((id) => id.trim()).filter(Boolean)),
	);
	let nextAccountIds: string[];
	if (mutation === "set-mode") {
		nextAccountIds = previousAccountIds;
	} else if (mutation === "set") {
		nextAccountIds = normalizedAccountIds;
	} else if (mutation === "add") {
		nextAccountIds = Array.from(
			new Set([...previousAccountIds, ...normalizedAccountIds]),
		);
	} else if (mutation === "remove") {
		const removedIds = new Set(normalizedAccountIds);
		nextAccountIds = previousAccountIds.filter((id) => !removedIds.has(id));
	} else {
		nextAccountIds = [];
	}

	const nextPoolMode = mutation === "clear"
		? "preferred"
		: options.poolMode ?? previousPoolMode;
	if (nextAccountIds.length > 0) {
		pools[normalizedModel] = nextAccountIds;
		if (nextPoolMode !== "preferred") {
			poolModes[normalizedModel] = nextPoolMode;
		}
	}
	const changed =
		matchingKeys.length !== (nextAccountIds.length > 0 ? 1 : 0) ||
		storedPreviousAccountIds.length !== nextAccountIds.length ||
		storedPreviousAccountIds.some((id, index) => id !== nextAccountIds[index]) ||
		(matchingKeys[0] !== undefined && matchingKeys[0] !== normalizedModel) ||
		matchingModeKeys.length !== (nextPoolMode !== "preferred" && nextAccountIds.length > 0 ? 1 : 0) ||
		previousPoolMode !== nextPoolMode ||
		(matchingModeKeys[0] !== undefined && matchingModeKeys[0] !== normalizedModel);

	if (changed && options.dryRun !== true) {
		if (Object.keys(pools).length > 0) {
			rawConfig.modelAccountPools = pools;
		} else {
			delete rawConfig.modelAccountPools;
		}
		if (Object.keys(poolModes).length > 0) {
			rawConfig.modelAccountPoolModes = poolModes;
		} else {
			delete rawConfig.modelAccountPoolModes;
		}

		const tempPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tempPath, `${JSON.stringify(rawConfig, null, 2)}\n`, {
				encoding: "utf-8",
				mode: 0o600,
			});
			await renameWithWindowsRetry(tempPath, CONFIG_PATH);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	return {
		model: normalizedModel,
		// Report what the config file actually held. `previousAccountIds` may have
		// been expanded from legacy workspace keys purely to compute the next set;
		// surfacing the expansion would make callers report a "previous" count the
		// file never contained.
		previousAccountIds: storedPreviousAccountIds,
		accountIds: nextAccountIds,
		previousPoolMode,
		poolMode: nextPoolMode,
		changed,
		dryRun: options.dryRun === true,
	};
}

/**
 * Salvage the subset of user-supplied config keys that individually pass
 * schema validation. Used when the top-level parse fails so callers still
 * benefit from valid keys while invalid ones are discarded instead of
 * silently cast into place.
 */
function salvageValidKeys(raw: Record<string, unknown>): Partial<PluginConfig> {
	const salvaged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const probe = PluginConfigSchema.safeParse({ [key]: value });
		if (probe.success) {
			const candidate = (probe.data as Record<string, unknown>)[key];
			if (candidate !== undefined) {
				salvaged[key] = candidate;
			}
		}
	}
	return salvaged as Partial<PluginConfig>;
}

function stripUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

// RC-9: the env-var parsing helpers below are thin wrappers around Zod
// schemas that live in `lib/schemas.ts`. Keeping them here (instead of
// inlining the schema use at every call site) preserves the existing
// `resolveBooleanSetting` / `resolveNumberSetting` call graph while ensuring
// every process-boundary env read flows through a validated schema. Each
// helper surfaces `undefined` on invalid input so callers can fall back to
// the config file / default instead of silently honouring a poisoned value.
function parseBooleanEnv(value: string | undefined): boolean | undefined {
	const result = EnvBooleanSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

function parseNumberEnv(value: string | undefined): number | undefined {
	const result = EnvNumberSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

function parseEnumEnv<T extends string>(
	value: string | undefined,
	allowed: ReadonlySet<T>,
): T | undefined {
	const schema = makeEnvEnumSchema(allowed);
	const result = schema.safeParse(value);
	return result.success ? result.data : undefined;
}

function resolveBooleanSetting(
	envName: string,
	configValue: boolean | undefined,
	defaultValue: boolean,
): boolean {
	const envValue = parseBooleanEnv(process.env[envName]);
	if (envValue !== undefined) return envValue;
	return configValue ?? defaultValue;
}

function resolveNumberSetting(
	envName: string,
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number },
): number {
	const envValue = parseNumberEnv(process.env[envName]);
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min;
	if (min !== undefined) {
		return Math.max(min, candidate);
	}
	// istanbul ignore next -- dead code: all callers pass { min: ... }
	return candidate;
}

function resolveStringSetting<T extends string>(
	envName: string,
	configValue: T | undefined,
	defaultValue: T,
	allowedValues: ReadonlySet<string>,
): T {
	// RC-9: validate the env-supplied enum through a Zod schema so unknown
	// values fall back to the config / default instead of being accepted
	// verbatim.
	const envValue = parseEnumEnv(
		process.env[envName],
		allowedValues as ReadonlySet<T>,
	);
	if (envValue !== undefined) {
		return envValue;
	}
	if (configValue && allowedValues.has(configValue)) {
		return configValue;
	}
	return defaultValue;
}

/**
 * Get the effective CODEX_MODE setting.
 * Priority: environment variable > config file > default (true).
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
export function getCodexMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_MODE", pluginConfig.codexMode, true);
}

export function getRequestTransformMode(pluginConfig: PluginConfig): "native" | "legacy" {
	return resolveStringSetting(
		"CODEX_AUTH_REQUEST_TRANSFORM_MODE",
		pluginConfig.requestTransformMode,
		"native",
		REQUEST_TRANSFORM_MODES,
	);
}

export function getCodexTuiV2(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_TUI_V2", pluginConfig.codexTuiV2, true);
}

export function getCodexTuiColorProfile(
	pluginConfig: PluginConfig,
): "truecolor" | "ansi16" | "ansi256" {
	return resolveStringSetting(
		"CODEX_TUI_COLOR_PROFILE",
		pluginConfig.codexTuiColorProfile,
		"truecolor",
		TUI_COLOR_PROFILES,
	);
}

export function getCodexTuiGlyphMode(
	pluginConfig: PluginConfig,
): "ascii" | "unicode" | "auto" {
	return resolveStringSetting(
		"CODEX_TUI_GLYPHS",
		pluginConfig.codexTuiGlyphMode,
		"ascii",
		TUI_GLYPH_MODES,
	);
}

export function getCodexTuiMaskEmail(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_TUI_MASK_EMAIL",
		pluginConfig.maskEmail,
		false,
	);
}

export function getCodexTuiMaskEmailInQuotaDetails(
	pluginConfig: PluginConfig,
): boolean {
	return resolveBooleanSetting(
		"CODEX_TUI_MASK_EMAIL_DETAILS",
		pluginConfig.maskEmailInQuotaDetails,
		false,
	);
}

export function getFastSession(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FAST_SESSION",
		pluginConfig.fastSession,
		false,
	);
}

export function getBeginnerSafeMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_BEGINNER_SAFE_MODE",
		pluginConfig.beginnerSafeMode,
		false,
	);
}

const FAST_SESSION_STRATEGIES = new Set(["hybrid", "always"] as const);

export function getFastSessionStrategy(pluginConfig: PluginConfig): "hybrid" | "always" {
	// RC-9: validate env-supplied strategy through the shared Zod enum helper
	// so bogus values (e.g. `CODEX_AUTH_FAST_SESSION_STRATEGY=turbo`) fall
	// back to the config / default instead of propagating.
	const envValue = parseEnumEnv(
		process.env.CODEX_AUTH_FAST_SESSION_STRATEGY,
		FAST_SESSION_STRATEGIES as ReadonlySet<"hybrid" | "always">,
	);
	if (envValue !== undefined) return envValue;
	return pluginConfig.fastSessionStrategy === "always" ? "always" : "hybrid";
}

export type RotationStrategy = "hybrid" | "sticky" | "round-robin";

const ROTATION_STRATEGIES = new Set([
	"hybrid",
	"sticky",
	"round-robin",
] as const);

/**
 * Account load-balancing strategy (issue #183).
 *
 * - `hybrid` (default): unchanged historical behavior — stick to the current
 *   account while it is healthy, otherwise score-select the next one
 *   (health + tokens + freshness, which *spreads* load across accounts).
 * - `sticky`: drain-first. Stay on the current account while it has quota,
 *   and when it is exhausted pick the lowest-indexed available account so load
 *   *concentrates* on as few accounts as possible. This staggers weekly-quota
 *   cooldowns instead of exhausting every account at once.
 * - `round-robin`: advance through accounts in order on every selection.
 *
 * Env override `CODEX_AUTH_ROTATION_STRATEGY` wins over config; bogus values
 * fall back to the config / default via the shared Zod enum helper.
 */
export function getRotationStrategy(pluginConfig: PluginConfig): RotationStrategy {
	const envValue = parseEnumEnv(
		process.env.CODEX_AUTH_ROTATION_STRATEGY,
		ROTATION_STRATEGIES as ReadonlySet<RotationStrategy>,
	);
	if (envValue !== undefined) return envValue;
	const configured = pluginConfig.rotationStrategy;
	if (configured === "sticky" || configured === "round-robin") return configured;
	return "hybrid";
}

export function getModelAccountPool(
	pluginConfig: PluginConfig,
	model?: string | null,
): string[] {
	if (!model) return [];
	const normalizedModel = model.trim().toLowerCase();
	for (const [configuredModel, accountIds] of Object.entries(
		pluginConfig.modelAccountPools ?? {},
	)) {
		if (configuredModel.trim().toLowerCase() === normalizedModel) {
			return [...new Set(accountIds.map((id) => id.trim()).filter(Boolean))];
		}
	}
	return [];
}

export function getModelAccountPoolMode(
	pluginConfig: PluginConfig,
	model?: string | null,
): ModelAccountPoolMode {
	if (!model) return "preferred";
	const normalizedModel = model.trim().toLowerCase();
	for (const [configuredModel, mode] of Object.entries(
		pluginConfig.modelAccountPoolModes ?? {},
	)) {
		if (configuredModel.trim().toLowerCase() === normalizedModel) return mode;
	}
	return "preferred";
}

export function getFastSessionMaxInputItems(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
		pluginConfig.fastSessionMaxInputItems,
		30,
		{ min: 8 },
	);
}

export function getRetryProfile(pluginConfig: PluginConfig): RetryProfile {
	return resolveStringSetting(
		"CODEX_AUTH_RETRY_PROFILE",
		pluginConfig.retryProfile,
		"balanced",
		RETRY_PROFILES,
	);
}

export function getRetryBudgetOverrides(
	pluginConfig: PluginConfig,
): RetryBudgetOverrides {
	const source = pluginConfig.retryBudgetOverrides;
	if (!isRecord(source)) return {};

	const normalized: RetryBudgetOverrides = {};
	const authRefresh = normalizeRetryBudgetValue(source.authRefresh);
	const network = normalizeRetryBudgetValue(source.network);
	const server = normalizeRetryBudgetValue(source.server);
	const rateLimitShort = normalizeRetryBudgetValue(source.rateLimitShort);
	const rateLimitGlobal = normalizeRetryBudgetValue(source.rateLimitGlobal);
	const emptyResponse = normalizeRetryBudgetValue(source.emptyResponse);

	if (authRefresh !== undefined) normalized.authRefresh = authRefresh;
	if (network !== undefined) normalized.network = network;
	if (server !== undefined) normalized.server = server;
	if (rateLimitShort !== undefined) normalized.rateLimitShort = rateLimitShort;
	if (rateLimitGlobal !== undefined) normalized.rateLimitGlobal = rateLimitGlobal;
	if (emptyResponse !== undefined) normalized.emptyResponse = emptyResponse;

	return normalized;
}

export function getRetryAllAccountsRateLimited(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		pluginConfig.retryAllAccountsRateLimited,
		true,
	);
}

export function getRetryAllAccountsMaxWaitMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		pluginConfig.retryAllAccountsMaxWaitMs,
		0,
		{ min: 0 },
	);
}

export function getRetryAllAccountsMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		pluginConfig.retryAllAccountsMaxRetries,
		Infinity,
		{ min: 0 },
	);
}

export function getUnsupportedCodexPolicy(
	pluginConfig: PluginConfig,
): UnsupportedCodexPolicy {
	// RC-9: validate the env-supplied policy through the shared Zod enum
	// helper. Unknown policy strings fall back to the config / legacy
	// fallback path rather than being accepted as-is.
	const envPolicy = parseEnumEnv(
		process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY,
		UNSUPPORTED_CODEX_POLICIES as ReadonlySet<UnsupportedCodexPolicy>,
	);
	if (envPolicy !== undefined) {
		return envPolicy;
	}

	const configPolicy =
		typeof pluginConfig.unsupportedCodexPolicy === "string"
			? pluginConfig.unsupportedCodexPolicy.toLowerCase()
			: undefined;
	if (configPolicy && UNSUPPORTED_CODEX_POLICIES.has(configPolicy)) {
		return configPolicy as UnsupportedCodexPolicy;
	}

	const legacyEnvFallback = parseBooleanEnv(
		process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL,
	);
	if (legacyEnvFallback !== undefined) {
		return legacyEnvFallback ? "fallback" : "strict";
	}

	if (typeof pluginConfig.fallbackOnUnsupportedCodexModel === "boolean") {
		return pluginConfig.fallbackOnUnsupportedCodexModel
			? "fallback"
			: "strict";
	}

	return "strict";
}

export function getFallbackOnUnsupportedCodexModel(pluginConfig: PluginConfig): boolean {
	return getUnsupportedCodexPolicy(pluginConfig) === "fallback";
}

export function getFallbackToGpt52OnUnsupportedGpt53(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FALLBACK_GPT53_TO_GPT52",
		pluginConfig.fallbackToGpt52OnUnsupportedGpt53,
		true,
	);
}

export function getUnsupportedCodexFallbackChain(
	pluginConfig: PluginConfig,
): Record<string, string[]> {
	const chain = pluginConfig.unsupportedCodexFallbackChain;
	if (!chain || typeof chain !== "object") {
		return {};
	}

	const normalizeModel = (value: string): string => {
		const trimmed = value.trim().toLowerCase();
		if (!trimmed) return "";
		const stripped = trimmed.includes("/")
			? (trimmed.split("/").pop() ?? trimmed)
			: trimmed;
		return stripEffortSuffix(stripped);
	};

	const normalized: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(chain)) {
		if (typeof key !== "string" || !Array.isArray(value)) continue;
		const normalizedKey = normalizeModel(key);
		if (!normalizedKey) continue;

		const targets = value
			.map((target) => (typeof target === "string" ? normalizeModel(target) : ""))
			.filter((target) => target.length > 0);

		if (targets.length > 0) {
			normalized[normalizedKey] = targets;
		}
	}

	return normalized;
}

export function getTokenRefreshSkewMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		pluginConfig.tokenRefreshSkewMs,
		60_000,
		{ min: 0 },
	);
}

export function getRateLimitToastDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		pluginConfig.rateLimitToastDebounceMs,
		60_000,
		{ min: 0 },
	);
}

export function getSessionRecovery(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_RECOVERY",
		pluginConfig.sessionRecovery,
		true,
	);
}

export function getAutoResume(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_AUTO_RESUME",
		pluginConfig.autoResume,
		true,
	);
}

export function getAutoUpdate(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_AUTO_UPDATE",
		pluginConfig.autoUpdate,
		true,
	);
}

export function getToastDurationMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOAST_DURATION_MS",
		pluginConfig.toastDurationMs,
		5_000,
		{ min: 1_000 },
	);
}

/**
 * Gates only the informational "Using <account> (N/N)" account-selection toast.
 * Warning/error toasts (rate limits, expired auth, recovery, retries) are never
 * affected by this setting.
 */
export function getAccountToastsEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_ACCOUNT_TOASTS",
		pluginConfig.accountToasts,
		true,
	);
}

export function getPerProjectAccounts(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PER_PROJECT_ACCOUNTS",
		pluginConfig.perProjectAccounts,
		true,
	);
}

export function getParallelProbing(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PARALLEL_PROBING",
		pluginConfig.parallelProbing,
		false,
	);
}

export function getParallelProbingMaxConcurrency(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
		pluginConfig.parallelProbingMaxConcurrency,
		2,
		{ min: 1 },
	);
}

export function getEmptyResponseMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
		pluginConfig.emptyResponseMaxRetries,
		2,
		{ min: 0 },
	);
}

export function getEmptyResponseRetryDelayMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS",
		pluginConfig.emptyResponseRetryDelayMs,
		1_000,
		{ min: 0 },
	);
}

export function getPidOffsetEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PID_OFFSET_ENABLED",
		pluginConfig.pidOffsetEnabled,
		false,
	);
}

export function getFetchTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FETCH_TIMEOUT_MS",
		pluginConfig.fetchTimeoutMs,
		60_000,
		{ min: 1_000 },
	);
}

export function getStreamStallTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
		pluginConfig.streamStallTimeoutMs,
		45_000,
		{ min: 1_000 },
	);
}

export interface QuotaNotificationsConfig {
	enabled: boolean;
	intervalMs: number;
	maskAccountEmails: boolean;
	notifyEveryCheck: boolean;
	thresholds: number[];
}

export function getQuotaNotifications(
	pluginConfig: PluginConfig,
): QuotaNotificationsConfig {
	const config = pluginConfig.quotaNotifications;

	let enabled = config?.enabled ?? false;
	const envEnabled = parseBooleanEnv(process.env.CODEX_AUTH_QUOTA_NOTIFICATIONS);
	if (envEnabled !== undefined) {
		enabled = envEnabled;
	}

	const intervalMs = resolveNumberSetting(
		"CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS",
		config?.intervalMs,
		1_800_000,
		{ min: 30_000 },
	);

	let thresholds = config?.thresholds ?? [25, 10, 0];

	// Normalize thresholds: unique, valid range, descending order
	thresholds = Array.from(new Set(thresholds))
		.filter((t) => Number.isFinite(t) && t >= 0 && t <= 100)
		.sort((a, b) => b - a);

	if (thresholds.length === 0) {
		thresholds = [25, 10, 0];
	}

	return {
		enabled,
		intervalMs,
		maskAccountEmails: config?.maskAccountEmails ?? true,
		notifyEveryCheck: config?.notifyEveryCheck ?? false,
		thresholds,
	};
}
