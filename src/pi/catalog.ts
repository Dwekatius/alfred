/**
 * Model catalog access for setup/UI and Telegram commands.
 *
 * A single cached (unauthenticated) ModelRuntime lists the bundled + cached
 * catalog for any built-in provider, so capabilities and thinking maps are real
 * values rather than guesses. Custom OpenAI/Anthropic-compatible endpoints are
 * queried directly for their model list.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppConfig, DataPaths } from "../config.js";

export interface CatalogModelInfo {
  id: string;
  name: string;
  provider: string;
  input: string[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  contextWindow: number | null;
  maxTokens: number | null;
  thinkingLevels: string[];
}

let cachedRuntime: { key: string; runtime: ModelRuntime; at: number } | undefined;

function runtimeKey(config: AppConfig, paths: DataPaths): string {
  return `${paths.modelsPath}|${paths.modelsStorePath}|${config.models.authPath}`;
}

export async function getCatalogRuntime(config: AppConfig, paths: DataPaths, force = false): Promise<ModelRuntime> {
  const key = runtimeKey(config, paths);
  if (!force && cachedRuntime && cachedRuntime.key === key && Date.now() - cachedRuntime.at < 60000) {
    return cachedRuntime.runtime;
  }
  const runtime = await ModelRuntime.create({
    authPath: config.models.authPath,
    modelsPath: paths.modelsPath,
    modelsStorePath: paths.modelsStorePath,
    allowModelNetwork: false,
  });
  cachedRuntime = { key, runtime, at: Date.now() };
  return runtime;
}

export function invalidateCatalogCache(): void {
  cachedRuntime = undefined;
}

function toInfo(model: { id: string; name?: string; provider: string; input?: string[]; reasoning?: boolean; cost?: unknown; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }): CatalogModelInfo {
  const cost = model.cost as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: model.provider,
    input: model.input ?? ["text"],
    reasoning: Boolean(model.reasoning),
    cost: cost ? { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 } : null,
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    thinkingLevels: model.thinkingLevelMap
      ? Object.entries(model.thinkingLevelMap)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key]) => key)
      : [],
  };
}

export async function listProviderModels(config: AppConfig, paths: DataPaths, provider: string): Promise<CatalogModelInfo[]> {
  try {
    const runtime = await getCatalogRuntime(config, paths);
    return runtime
      .getModels(provider)
      .map((model) => toInfo(model as never))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function getCatalogModel(config: AppConfig, paths: DataPaths, provider: string, modelId: string): Promise<CatalogModelInfo | undefined> {
  try {
    const runtime = await getCatalogRuntime(config, paths);
    const model = runtime.getModel(provider, modelId);
    return model ? toInfo(model as never) : undefined;
  } catch {
    return undefined;
  }
}

export interface EndpointModelInfo {
  id: string;
  name: string;
}

/** Query an OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, ...) for its models. */
export async function listEndpointModels(baseUrl: string, timeoutMs = 5000): Promise<EndpointModelInfo[]> {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  const url = /\/v\d+$/u.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Endpoint returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string; name?: string }> } | Array<{ id?: string; name?: string }>;
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows
    .map((row) => ({ id: String(row.id ?? ""), name: String(row.name ?? row.id ?? "") }))
    .filter((row) => row.id.length > 0);
}
