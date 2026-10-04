/**
 * Remote-only model overlay management.
 *
 * The Telegram agent must never mutate Zed's global Pi configuration. It writes
 * its own models.json/models-store.json under <dataRoot>/agent and points the
 * SDK ModelRuntime at those explicit paths.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Logger } from "../logging.js";
import { AppConfig, DataPaths } from "../config.js";

export interface OpenRouterRouting {
  only?: string[];
  allow_fallbacks?: boolean;
}

interface ProviderOverlay {
  modelOverrides?: Record<string, { compat?: Record<string, unknown> }>;
  [key: string]: unknown;
}

interface ModelsFile {
  providers?: Record<string, ProviderOverlay>;
  [key: string]: unknown;
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(path.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Seed the remote model catalog from the existing nonsecret cache and write the
 * remote-only models overlay. Never copies credentials.
 */
export function ensureRemoteModelFiles(config: AppConfig, paths: DataPaths, logger?: Logger): void {
  mkdirSync(paths.agentDir, { recursive: true });
  if (!existsSync(paths.modelsStorePath) && existsSync(config.models.catalogSeedPath)) {
    copyFileSync(config.models.catalogSeedPath, paths.modelsStorePath);
  }
  const base = (readJsonFile(config.models.baseModelsPath) as ModelsFile | undefined) ?? {};
  writeJsonAtomic(paths.modelsPath, buildOverlay(config, base));
  logger?.info("models.overlay_ready", "Remote-only model overlay written.", { eventCode: "MODELS_OVERLAY", modelsPath: paths.modelsPath });
}

/**
 * Build the overlay: base entries + OpenRouter routing + custom endpoint
 * providers (for example LM Studio, Ollama, vLLM).
 */
function buildOverlay(config: AppConfig, base: ModelsFile, modelId?: string, routing?: OpenRouterRouting): ModelsFile {
  const overlay: ModelsFile = JSON.parse(JSON.stringify(base));
  overlay.providers = overlay.providers ?? {};
  const openrouterSlot = config.models.slots?.openrouter;
  const routingModelId = modelId ?? openrouterSlot?.modelId;
  if (routingModelId) {
    applyRoutingToOverlay(overlay, routingModelId, routing ?? openrouterSlot?.routing);
  }
  applyEndpointProviders(overlay, config);
  return overlay;
}

/** Write custom OpenAI/Anthropic-compatible endpoints declared on model slots. */
function applyEndpointProviders(overlay: ModelsFile, config: AppConfig): void {
  const providers = (overlay.providers = overlay.providers ?? {});
  for (const slot of Object.values(config.models.slots ?? {})) {
    if (!slot.endpoint) continue;
    const existingModels = (providers[slot.provider]?.models as Array<Record<string, unknown>> | undefined) ?? [];
    const declared = slot.endpoint.models ?? [{ id: slot.modelId }];
    const merged = [...existingModels];
    for (const model of declared) {
      const entry: Record<string, unknown> = {
        id: model.id,
        name: model.name ?? model.id,
        input: model.input ?? ["text"],
        contextWindow: model.contextWindow ?? 32768,
        maxTokens: model.maxTokens ?? 8192,
        reasoning: model.reasoning ?? false,
      };
      const index = merged.findIndex((existing) => existing.id === entry.id);
      if (index >= 0) merged[index] = { ...merged[index], ...entry };
      else merged.push(entry);
    }
    providers[slot.provider] = {
      ...(providers[slot.provider] ?? {}),
      baseUrl: slot.endpoint.baseUrl,
      api: slot.endpoint.api,
      apiKey: slot.endpoint.apiKey ?? "local",
      models: merged,
    } as ProviderOverlay;
  }
}

function applyRoutingToOverlay(overlay: ModelsFile, modelId: string, routing: OpenRouterRouting | undefined): void {
  const providers = (overlay.providers = overlay.providers ?? {});
  const openrouter = (providers.openrouter = providers.openrouter ?? {});
  openrouter.modelOverrides = openrouter.modelOverrides ?? {};
  const existing = openrouter.modelOverrides[modelId] ?? {};
  const compat = (existing.compat = existing.compat ?? {});
  if (routing?.only && routing.only.length > 0) {
    compat.openRouterRouting = {
      only: routing.only,
      allow_fallbacks: routing.allow_fallbacks === true,
    };
  } else {
    delete compat.openRouterRouting;
  }
  openrouter.modelOverrides[modelId] = existing;
}

/** Update routing for the currently selected OpenRouter model and persist atomically. */
export function updateOpenRouterRouting(config: AppConfig, paths: DataPaths, modelId: string, routing: OpenRouterRouting | undefined): void {
  const base = (readJsonFile(config.models.baseModelsPath) as ModelsFile | undefined) ?? {};
  writeJsonAtomic(paths.modelsPath, buildOverlay(config, base, modelId, routing));
}

export interface CachedModelMetadata {
  id: string;
  name?: string;
  input?: string[];
  thinkingLevelMap?: Record<string, string | null>;
  cost?: Record<string, number>;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  inputLimits?: Record<string, unknown>;
}

/** Read cached (nonsecret) model metadata from the seeded catalog. */
export function findCachedModel(paths: DataPaths, provider: string, modelId: string): CachedModelMetadata | undefined {
  const store = readJsonFile(paths.modelsStorePath) as Record<string, unknown> | undefined;
  if (!store || typeof store !== "object") return undefined;
  const providerEntry = store[provider] as { models?: unknown } | undefined;
  const models = providerEntry?.models;
  if (!Array.isArray(models)) return undefined;
  for (const entry of models as CachedModelMetadata[]) {
    if (entry && entry.id === modelId) return entry;
  }
  return undefined;
}
