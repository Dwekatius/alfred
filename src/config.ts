/**
 * Configuration contract: typed schema validation, defaults, and atomic writes.
 *
 * All paths are resolved from validated configuration. Unknown keys inside
 * security-sensitive objects are rejected (additionalProperties: false).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_SCHEMA_VERSION = 1;

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const EndpointModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String()),
    input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1 })),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1024 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 256 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SlotSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    thinking: Type.Optional(ThinkingLevelSchema),
    routing: Type.Optional(
      Type.Object(
        {
          only: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          allow_fallbacks: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    requireZeroTokenPrice: Type.Optional(Type.Boolean()),
    endpoint: Type.Optional(
      Type.Object(
        {
          baseUrl: Type.String({ minLength: 4 }),
          api: Type.Union([Type.Literal("openai-completions"), Type.Literal("openai-responses"), Type.Literal("anthropic-messages")]),
          apiKey: Type.Optional(Type.String()),
          models: Type.Optional(Type.Array(EndpointModelSchema, { minItems: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONFIG_SCHEMA_VERSION),
    dryRun: Type.Optional(Type.Boolean()),
    performance: Type.Optional(Type.Object({
      prewarmWorker: Type.Optional(Type.Boolean()),
      stripHistoricalToolImages: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false })),
    dataRoot: Type.String({ minLength: 3 }),
    workRoot: Type.String({ minLength: 3 }),
    timeZone: Type.String({ minLength: 1 }),
    telegram: Type.Object(
      {
        tokenSecretName: Type.String({ minLength: 1 }),
        ownerUserId: Type.Union([Type.String({ pattern: "^[0-9]+$" }), Type.Null()]),
        ownerChatId: Type.Union([Type.String({ pattern: "^-?[0-9]+$" }), Type.Null()]),
        pollTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 50 }),
        allowedUpdates: Type.Array(Type.Union([Type.Literal("message"), Type.Literal("callback_query")]), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    models: Type.Object(
      {
        authPath: Type.String({ minLength: 3 }),
        baseModelsPath: Type.String({ minLength: 3 }),
        catalogSeedPath: Type.String({ minLength: 3 }),
        selectedSlot: Type.String({ minLength: 1 }),
        thinking: ThinkingLevelSchema,
        allowAutomaticModelFallback: Type.Boolean(),
        slots: Type.Record(Type.String({ minLength: 1, maxLength: 32 }), SlotSchema),
      },
      { additionalProperties: false },
    ),
    desktop: Type.Object(
      {
        requireUnlockedSession: Type.Boolean(),
        observationMaxAgeMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
        nativeToolTimeoutMs: Type.Integer({ minimum: 1000, maximum: 120000 }),
        pauseOnObservedHumanInput: Type.Boolean(),
        localStopHotkey: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    browser: Type.Object(
      {
        executablePath: Type.String({ minLength: 3 }),
        profileDir: Type.String({ minLength: 3 }),
        outputDir: Type.String({ minLength: 3 }),
        headed: Type.Boolean(),
        showActions: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    jobs: Type.Object(
      {
        maxQueued: Type.Integer({ minimum: 1, maximum: 100 }),
        maxRunSeconds: Type.Integer({ minimum: 30, maximum: 86400 }),
        maxToolCalls: Type.Integer({ minimum: 1, maximum: 5000 }),
        maxModelTurns: Type.Integer({ minimum: 1, maximum: 2000 }),
        maxConsecutiveNoProgress: Type.Integer({ minimum: 1, maximum: 20 }),
        autoStartMaxAgeSeconds: Type.Integer({ minimum: 0, maximum: 604800 }),
        stopGraceMs: Type.Integer({ minimum: 250, maximum: 60000 }),
      },
      { additionalProperties: false },
    ),
    artifacts: Type.Object(
      {
        retentionDays: Type.Integer({ minimum: 1, maximum: 3650 }),
        maxTotalMiB: Type.Integer({ minimum: 16, maximum: 1024 * 1024 }),
        inboundMaxMiB: Type.Integer({ minimum: 1, maximum: 20 }),
        photoTargetMiB: Type.Integer({ minimum: 1, maximum: 10 }),
        sendExactPngOnRequest: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    notifications: Type.Object(
      {
        progressMinimumIntervalSeconds: Type.Integer({ minimum: 0, maximum: 3600 }),
        automaticStepScreenshots: Type.Boolean(),
        completionScreenshot: Type.Union([Type.Literal("off"), Type.Literal("when-useful"), Type.Literal("always")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export interface ModelSlotConfig {
  provider: string;
  modelId: string;
  label?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  routing?: { only?: string[]; allow_fallbacks?: boolean };
  requireZeroTokenPrice?: boolean;
  endpoint?: {
    baseUrl: string;
    api: "openai-completions" | "openai-responses" | "anthropic-messages";
    apiKey?: string;
    models?: Array<{ id: string; name?: string; input?: Array<"text" | "image">; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
  };
}

export type AppConfig = {
  schemaVersion: 1;
  dryRun: boolean;
  performance?: { prewarmWorker?: boolean; stripHistoricalToolImages?: boolean };
  dataRoot: string;
  workRoot: string;
  timeZone: string;
  telegram: {
    tokenSecretName: string;
    ownerUserId: string | null;
    ownerChatId: string | null;
    pollTimeoutSeconds: number;
    allowedUpdates: Array<"message" | "callback_query">;
  };
  models: {
    authPath: string;
    baseModelsPath: string;
    catalogSeedPath: string;
    selectedSlot: string;
    thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    allowAutomaticModelFallback: boolean;
    slots: Record<string, ModelSlotConfig>;
  };
  desktop: {
    requireUnlockedSession: boolean;
    observationMaxAgeMs: number;
    nativeToolTimeoutMs: number;
    pauseOnObservedHumanInput: boolean;
    localStopHotkey: string;
  };
  browser: { executablePath: string; profileDir: string; outputDir: string; headed: boolean; showActions: boolean };
  jobs: {
    maxQueued: number;
    maxRunSeconds: number;
    maxToolCalls: number;
    maxModelTurns: number;
    maxConsecutiveNoProgress: number;
    autoStartMaxAgeSeconds: number;
    stopGraceMs: number;
  };
  artifacts: {
    retentionDays: number;
    maxTotalMiB: number;
    inboundMaxMiB: number;
    photoTargetMiB: number;
    sendExactPngOnRequest: boolean;
  };
  notifications: { progressMinimumIntervalSeconds: number; automaticStepScreenshots: boolean; completionScreenshot: "off" | "when-useful" | "always" };
};

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function defaultConfigPath(): string {
  if (process.env.PI_TG_CONFIG) return resolve(process.env.PI_TG_CONFIG);
  return join(homedir(), ".pi", "alfred", "config.json");
}

export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Locate the installed Chrome executable on this machine. */
export function findChromePath(): string {
  const candidates = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"] as string, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

/**
 * Build a working configuration for any Windows user. Reuses the existing global
 * Pi credentials/catalog when present; otherwise points at the agent's private
 * directory and the bundled catalog seed.
 */
export function createDefaultConfig(): AppConfig {
  const root = join(homedir(), ".pi", "alfred");
  const globalAgent = join(homedir(), ".pi", "agent");
  const globalAuth = join(globalAgent, "auth.json");
  const globalModels = join(globalAgent, "models.json");
  const globalStore = join(globalAgent, "models-store.json");
  const bundledSeed = join(projectRoot(), "resources", "models-store.json");
  const raw = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    dryRun: false,
    performance: { prewarmWorker: true, stripHistoricalToolImages: true },
    dataRoot: root,
    workRoot: join(root, "work"),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    telegram: {
      tokenSecretName: "alfred/bot-token",
      ownerUserId: null,
      ownerChatId: null,
      pollTimeoutSeconds: 25,
      allowedUpdates: ["message", "callback_query"],
    },
    models: {
      authPath: existsSync(globalAuth) ? globalAuth : join(root, "agent", "auth.json"),
      baseModelsPath: existsSync(globalModels) ? globalModels : join(root, "agent", "models.json"),
      catalogSeedPath: existsSync(globalStore) ? globalStore : bundledSeed,
      selectedSlot: "deepseek",
      thinking: "high",
      allowAutomaticModelFallback: false,
      slots: {
        deepseek: { provider: "deepseek", modelId: "deepseek-flash", label: "DeepSeek V4.1 Flash" },
        openrouter: {
          provider: "openrouter",
          modelId: "stealth/space-bunny-alpha",
          label: "OpenRouter (free model)",
          routing: { only: ["stealth"], allow_fallbacks: false },
          requireZeroTokenPrice: true,
        },
        zai: { provider: "zai", modelId: "glm-5.3-flash", label: "ZAI GLM Flash" },
        anthropic: { provider: "anthropic", modelId: "claude-sonnet-5-5", label: "Anthropic Claude" },
        openai: { provider: "openai", modelId: "gpt-6.1-sol", label: "OpenAI" },
        lmstudio: {
          provider: "lmstudio",
          modelId: "local-model",
          label: "LM Studio (local)",
          endpoint: {
            baseUrl: "http://127.0.0.1:1234/v1",
            api: "openai-completions",
            apiKey: "lm-studio",
            models: [{ id: "local-model", name: "Local model", input: ["text", "image"], contextWindow: 32768, maxTokens: 8192, reasoning: false }],
          },
        },
      },
    },
    desktop: {
      requireUnlockedSession: true,
      observationMaxAgeMs: 60000,
      nativeToolTimeoutMs: 20000,
      pauseOnObservedHumanInput: true,
      localStopHotkey: "Ctrl+Alt+F9",
    },
    browser: {
      executablePath: findChromePath(),
      profileDir: join(root, "browser", "profile"),
      outputDir: join(root, "browser", "output"),
      headed: true,
      showActions: true,
    },
    jobs: {
      maxQueued: 5,
      maxRunSeconds: 1800,
      maxToolCalls: 150,
      maxModelTurns: 60,
      maxConsecutiveNoProgress: 3,
      autoStartMaxAgeSeconds: 600,
      stopGraceMs: 3000,
    },
    artifacts: { retentionDays: 7, maxTotalMiB: 1024, inboundMaxMiB: 10, photoTargetMiB: 4, sendExactPngOnRequest: true },
    notifications: { progressMinimumIntervalSeconds: 15, automaticStepScreenshots: false, completionScreenshot: "when-useful" },
  };
  return validateConfig(raw);
}

/**
 * Validate an untrusted JSON value as configuration. Returns a normalized copy.
 * Throws ConfigError with human-readable issues.
 */
export function validateConfig(raw: unknown): AppConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("Configuration must be a JSON object");
  }
  const issues: string[] = [];
  if (!Value.Check(ConfigSchema, raw)) {
    for (const error of Value.Errors(ConfigSchema, raw)) {
      // TypeBox paths are JSON pointers; make them readable.
      issues.push(`${error.instancePath || "/"} ${error.message}`.trim());
    }
    throw new ConfigError("Configuration validation failed", issues.slice(0, 40));
  }
  const config = raw as AppConfig;

  const pathFields: Array<[string, string]> = [
    ["dataRoot", config.dataRoot],
    ["workRoot", config.workRoot],
    ["models.authPath", config.models.authPath],
    ["models.baseModelsPath", config.models.baseModelsPath],
    ["models.catalogSeedPath", config.models.catalogSeedPath],
    ["browser.executablePath", config.browser.executablePath],
    ["browser.profileDir", config.browser.profileDir],
    ["browser.outputDir", config.browser.outputDir],
  ];
  for (const [name, value] of pathFields) {
    if (!isAbsolute(value)) issues.push(`${name} must be an absolute path (got "${value}")`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone }).format(new Date());
  } catch {
    issues.push(`timeZone "${config.timeZone}" is not a valid IANA time zone`);
  }
  if (config.models.selectedSlot === "openrouter" && config.models.slots.openrouter?.routing && config.models.slots.openrouter.routing.only?.length === 0) {
    issues.push("models.slots.openrouter.routing.only must not be empty; use /provider auto instead");
  }
  if (config.telegram.ownerUserId !== null && config.telegram.ownerChatId === null) {
    issues.push("telegram.ownerChatId must be set when ownerUserId is set");
  }
  if (config.telegram.ownerUserId === null && config.telegram.ownerChatId !== null) {
    issues.push("telegram.ownerUserId must be set when ownerChatId is set");
  }
  const slotNames = Object.keys(config.models.slots ?? {});
  if (slotNames.length === 0) issues.push("models.slots must contain at least one model slot");
  if (slotNames.length > 0 && !slotNames.includes(config.models.selectedSlot)) {
    issues.push(`models.selectedSlot "${config.models.selectedSlot}" is not defined in models.slots`);
  }
  for (const [name, slot] of Object.entries(config.models.slots ?? {})) {
    if (slot.endpoint && !/^https?:\/\//i.test(slot.endpoint.baseUrl)) {
      issues.push(`models.slots.${name}.endpoint.baseUrl must be an http(s) URL`);
    }
    if (slot.endpoint && slot.routing) {
      issues.push(`models.slots.${name} cannot combine endpoint and routing`);
    }
  }
  if (config.dryRun) {
    // dry run is valid; nothing further
  }
  if (issues.length > 0) {
    const summary = issues.slice(0, 5).join("; ") + (issues.length > 5 ? `; (+${issues.length - 5} more)` : "");
    throw new ConfigError(`Configuration validation failed: ${summary}`, issues);
  }
  return config;
}

export function loadConfig(path = defaultConfigPath()): AppConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`Configuration file not found: ${path}. Copy config.example.json and run the setup steps.`);
  }
  let raw: unknown;
  try {
    const text = readFileSync(path, "utf8");
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Configuration file is not valid JSON: ${path} (${(error as Error).message})`);
  }
  return validateConfig(raw);
}

/** Atomically replace the configuration file after validating the candidate. */
export function saveConfigAtomic(path: string, candidate: unknown): AppConfig {
  const validated = validateConfig(candidate);
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
  return validated;
}

/** Stable hash of the security-relevant configuration, recorded per job. */
export function configHash(config: AppConfig): string {
  const relevant = {
    dataRoot: config.dataRoot,
    workRoot: config.workRoot,
    timeZone: config.timeZone,
    models: {
      authPath: config.models.authPath,
      baseModelsPath: config.models.baseModelsPath,
      catalogSeedPath: config.models.catalogSeedPath,
      selectedSlot: config.models.selectedSlot,
      thinking: config.models.thinking,
      allowAutomaticModelFallback: config.models.allowAutomaticModelFallback,
      slots: config.models.slots,
    },
    desktop: config.desktop,
    browser: config.browser,
    jobs: config.jobs,
    artifacts: config.artifacts,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 32);
}

export interface DataPaths {
  dataRoot: string;
  workRoot: string;
  secretsDir: string;
  agentDir: string;
  modelsPath: string;
  modelsStorePath: string;
  stateDir: string;
  databasePath: string;
  lockPath: string;
  sessionsDir: string;
  artifactsDir: string;
  browserProfileDir: string;
  browserOutputDir: string;
  logsDir: string;
  manifestsDir: string;
}

export function dataPaths(config: AppConfig): DataPaths {
  const dataRoot = config.dataRoot;
  return {
    dataRoot,
    workRoot: config.workRoot,
    secretsDir: join(dataRoot, "secrets"),
    agentDir: join(dataRoot, "agent"),
    modelsPath: join(dataRoot, "agent", "models.json"),
    modelsStorePath: join(dataRoot, "agent", "models-store.json"),
    stateDir: join(dataRoot, "state"),
    databasePath: join(dataRoot, "state", "jobs.sqlite"),
    lockPath: join(dataRoot, "state", "controller.lock"),
    sessionsDir: join(dataRoot, "sessions"),
    artifactsDir: join(dataRoot, "artifacts"),
    browserProfileDir: config.browser.profileDir,
    browserOutputDir: config.browser.outputDir,
    logsDir: join(dataRoot, "logs"),
    manifestsDir: join(dataRoot, "manifests"),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.dataRoot, paths.workRoot, paths.secretsDir, paths.agentDir, paths.stateDir, paths.sessionsDir, paths.artifactsDir, paths.browserProfileDir, paths.browserOutputDir, paths.logsDir, paths.manifestsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
