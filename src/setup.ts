/**
 * First-run setup service powering the dashboard's Setup tab and slot changes.
 *
 * Handles: prerequisite checks, the Telegram bot token (verified then stored
 * with DPAPI), model provider API keys (verified against the provider, stored
 * with DPAPI), model slot management (cloud + local OpenAI-compatible
 * endpoints), and the pairing handshake.
 *
 * The dashboard is localhost-only and token-protected; everything here is a
 * local operator action, equivalent to the terminal scripts or Telegram
 * commands.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppConfig, DataPaths, ModelSlotConfig, loadConfig, projectRoot, saveConfigAtomic, validateConfig } from "./config.js";
import { Database } from "./storage/database.js";
import { Logger } from "./logging.js";
import { JobRepository } from "./jobs/repository.js";
import { PairingService, generatePairingCode } from "./telegram/auth.js";
import { TelegramClient, TelegramApiError } from "./telegram/api.js";
import { DpapiSecretStore, runDpapi } from "./platform/secrets.js";
import { ensureRemoteModelFiles, findCachedModel } from "./pi/models.js";
import { getCatalogModel, invalidateCatalogCache, listEndpointModels, listProviderModels, type CatalogModelInfo } from "./pi/catalog.js";

export interface SetupDeps {
  configPath: string;
  paths: DataPaths;
  db: Database;
  logger: Logger;
}

export const TELEGRAM_TOKEN_SECRET = "alfred/bot-token";

/** Cloud providers whose keys can be stored in DPAPI. */
export const API_KEY_PROVIDERS = ["deepseek", "openrouter", "zai", "anthropic", "openai"] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export function apiKeySecretName(provider: string): string {
  return `alfred/api-key/${provider}`;
}

export function readCurrentConfig(deps: SetupDeps): AppConfig {
  return loadConfig(deps.configPath);
}

function secrets(deps: SetupDeps): DpapiSecretStore {
  return new DpapiSecretStore(deps.paths.secretsDir);
}

export async function readTelegramToken(deps: SetupDeps): Promise<string | undefined> {
  if (process.env.PI_TG_BOT_TOKEN) return process.env.PI_TG_BOT_TOKEN;
  try {
    return await secrets(deps).get(TELEGRAM_TOKEN_SECRET);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ presets

export interface ProviderPreset {
  slot: string;
  provider: string;
  label: string;
  description: string;
  modelId: string;
  requiresKey: boolean;
  keyUrl?: string;
  endpoint?: ModelSlotConfig["endpoint"];
  routing?: ModelSlotConfig["routing"];
  requireZeroTokenPrice?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    slot: "deepseek",
    provider: "deepseek",
    label: "DeepSeek V4.1 Flash",
    description: "Paid API, strong reasoning, vision, thinking up to max.",
    modelId: "deepseek-flash",
    requiresKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    slot: "zai",
    provider: "zai",
    label: "ZAI GLM Flash",
    description: "GLM-5.3-Flash: fast, vision, cheap per million tokens.",
    modelId: "glm-5.3-flash",
    requiresKey: true,
    keyUrl: "https://z.ai/",
  },
  {
    slot: "anthropic",
    provider: "anthropic",
    label: "Anthropic Claude",
    description: "Claude Sonnet: excellent computer-use and vision.",
    modelId: "claude-sonnet-5-5",
    requiresKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    slot: "openai",
    provider: "openai",
    label: "OpenAI",
    description: "GPT models with vision and tool use.",
    modelId: "gpt-6.1-sol",
    requiresKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    slot: "openrouter",
    provider: "openrouter",
    label: "OpenRouter (free model)",
    description: "Zero-price model slot; availability and rate limits vary.",
    modelId: "stealth/space-bunny-alpha",
    requiresKey: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    routing: { only: ["stealth"], allow_fallbacks: false },
    requireZeroTokenPrice: true,
  },
  {
    slot: "lmstudio",
    provider: "lmstudio",
    label: "LM Studio (local)",
    description: "Any model served locally over the OpenAI-compatible API. No API key, no cloud cost.",
    modelId: "local-model",
    requiresKey: false,
    endpoint: { baseUrl: "http://127.0.0.1:1234/v1", api: "openai-completions", apiKey: "lm-studio" },
  },
];

// ------------------------------------------------------------------ status

export interface PrerequisiteCheck {
  ok: boolean;
  detail: string;
}

export interface SlotStatus {
  name: string;
  label: string;
  provider: string;
  modelId: string;
  thinking: string;
  active: boolean;
  endpoint: boolean;
  endpointInfo: ModelSlotConfig["endpoint"] | null;
  keyRequired: boolean;
  keyStored: boolean;
  keySource: "dpapi" | "existing-pi-credentials" | "not-required" | "none";
  vision: boolean | null;
  reasoning: boolean | null;
  cost: Record<string, number> | null;
  contextWindow: number | null;
  thinkingLevels: string[];
}

export interface SetupStatus {
  configPath: string;
  dataRoot: string;
  prerequisites: {
    node: PrerequisiteCheck;
    python: PrerequisiteCheck;
    venv: PrerequisiteCheck;
    chrome: PrerequisiteCheck;
  };
  telegram: { tokenStored: boolean };
  owner: { paired: boolean; userId: string | null };
  apiKeys: Record<string, { stored: boolean; source: "dpapi" | "existing-pi-credentials" | "none" }>;
  slots: SlotStatus[];
  presets: Array<{ slot: string; provider: string; label: string; description: string; modelId: string; requiresKey: boolean; keyUrl?: string; configured: boolean }>;
  pairing: {
    state: "idle" | "waiting" | "candidate" | "accepted";
    candidate?: { userId: string; chatId: string; displayName: string };
    expiresAt?: string;
  };
}

async function keyState(deps: SetupDeps, provider: string): Promise<{ stored: boolean; source: "dpapi" | "existing-pi-credentials" | "none" }> {
  const config = readCurrentConfig(deps);
  let viaDpapi = false;
  try {
    viaDpapi = Boolean(await secrets(deps).get(apiKeySecretName(provider)));
  } catch {
    viaDpapi = false;
  }
  if (viaDpapi) return { stored: true, source: "dpapi" };
  let globalProviders: string[] = [];
  try {
    globalProviders = Object.keys(JSON.parse(readFileSync(config.models.authPath, "utf8")) as Record<string, unknown>);
  } catch {
    globalProviders = [];
  }
  if (globalProviders.includes(provider)) return { stored: true, source: "existing-pi-credentials" };
  return { stored: false, source: "none" };
}

export async function getSetupStatus(deps: SetupDeps): Promise<SetupStatus> {
  const config = readCurrentConfig(deps);
  let tokenStored = false;
  try {
    tokenStored = Boolean(await readTelegramToken(deps));
  } catch {
    tokenStored = false;
  }

  const apiKeys: SetupStatus["apiKeys"] = {};
  for (const provider of API_KEY_PROVIDERS) {
    const state = await keyState(deps, provider);
    apiKeys[provider] = { stored: state.stored, source: state.source };
  }

  const slots: SlotStatus[] = [];
  for (const [name, slot] of Object.entries(config.models.slots ?? {})) {
    const requiresKey = !slot.endpoint;
    const state = requiresKey ? await keyState(deps, slot.provider) : { stored: true, source: "not-required" as const };
    let info: CatalogModelInfo | undefined;
    if (slot.endpoint) {
      const declared = slot.endpoint.models?.find((model) => model.id === slot.modelId);
      info = declared
        ? {
            id: declared.id,
            name: declared.name ?? declared.id,
            provider: slot.provider,
            input: declared.input ?? ["text"],
            reasoning: declared.reasoning ?? false,
            cost: null,
            contextWindow: declared.contextWindow ?? null,
            maxTokens: declared.maxTokens ?? null,
            thinkingLevels: [],
          }
        : undefined;
    } else {
      info = await getCatalogModel(config, deps.paths, slot.provider, slot.modelId);
      if (!info) {
        const cached = findCachedModel(deps.paths, slot.provider, slot.modelId);
        if (cached) {
          const cost = cached.cost as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
          info = {
            id: cached.id,
            name: cached.name ?? cached.id,
            provider: slot.provider,
            input: cached.input ?? ["text"],
            reasoning: Boolean((cached as { reasoning?: boolean }).reasoning),
            cost: cost ? { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 } : null,
            contextWindow: cached.contextWindow ?? null,
            maxTokens: cached.maxTokens ?? null,
            thinkingLevels: cached.thinkingLevelMap ? Object.entries(cached.thinkingLevelMap).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k) : [],
          };
        }
      }
    }
    slots.push({
      name,
      label: slot.label ?? `${slot.provider}/${slot.modelId}`,
      provider: slot.provider,
      modelId: slot.modelId,
      thinking: slot.thinking ?? config.models.thinking,
      active: config.models.selectedSlot === name,
      endpoint: Boolean(slot.endpoint),
      endpointInfo: slot.endpoint ?? null,
      keyRequired: requiresKey,
      keyStored: state.stored,
      keySource: state.source,
      vision: info?.input?.includes("image") ?? null,
      reasoning: info?.reasoning ?? null,
      cost: info?.cost ?? null,
      contextWindow: info?.contextWindow ?? null,
      thinkingLevels: info?.thinkingLevels ?? [],
    });
  }

  const venvPython = join(projectRoot(), ".venv", "Scripts", "python.exe");
  const venvOk = existsSync(venvPython);
  const chromeOk = existsSync(config.browser.executablePath) && statSync(config.browser.executablePath).isFile();

  const repository = new JobRepository(deps.db);
  const pairingService = new PairingService({ repository });
  const candidate = pairingService.getPendingCandidate();
  const row = deps.db.prepare("SELECT status, expires_at FROM pairing ORDER BY rowid DESC LIMIT 1").get() as { status: string; expires_at: string } | undefined;
  let pairingState: SetupStatus["pairing"]["state"] = "idle";
  if (candidate) pairingState = "candidate";
  else if (row?.status === "waiting") pairingState = "waiting";
  else if (config.telegram.ownerUserId) pairingState = "accepted";

  return {
    configPath: deps.configPath,
    dataRoot: deps.paths.dataRoot,
    prerequisites: {
      node: { ok: Number(process.versions.node.split(".")[0]) >= 24, detail: `v${process.versions.node}` },
      python: { ok: venvOk, detail: venvOk ? `venv ready (${venvPython})` : "not found; run the setup launcher again" },
      venv: { ok: venvOk, detail: venvOk ? "installed" : "missing" },
      chrome: { ok: chromeOk, detail: config.browser.executablePath },
    },
    telegram: { tokenStored },
    owner: { paired: Boolean(config.telegram.ownerUserId), userId: config.telegram.ownerUserId },
    apiKeys,
    slots,
    presets: PROVIDER_PRESETS.map((preset) => ({
      slot: preset.slot,
      provider: preset.provider,
      label: preset.label,
      description: preset.description,
      modelId: preset.modelId,
      requiresKey: preset.requiresKey,
      ...(preset.keyUrl ? { keyUrl: preset.keyUrl } : {}),
      configured: Object.prototype.hasOwnProperty.call(config.models.slots ?? {}, preset.slot),
    })),
    pairing: {
      state: pairingState,
      ...(candidate ? { candidate } : {}),
      ...(row && (pairingState === "waiting" || pairingState === "candidate") ? { expiresAt: row.expires_at } : {}),
    },
  };
}

// ------------------------------------------------------------------ telegram token

export interface TokenSaveResult {
  ok: boolean;
  message: string;
  botUsername?: string;
  botId?: number;
  webhookUrl?: string;
}

function sanitizeToken(raw: string): string {
  return raw.trim().replace(/^['"]+|['"]+$/g, "").trim();
}

const BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{25,}$/;

export async function saveTelegramToken(deps: SetupDeps, rawToken: string): Promise<TokenSaveResult> {
  const token = sanitizeToken(rawToken);
  if (!BOT_TOKEN_PATTERN.test(token)) {
    return { ok: false, message: "That does not look like a BotFather token. Copy the full value after 'Use this token to access the HTTP API:'." };
  }
  const client = new TelegramClient(token, { logger: deps.logger });
  let me;
  try {
    me = await client.getMe();
  } catch (error) {
    if (error instanceof TelegramApiError && error.status === 401) {
      return { ok: false, message: "Telegram rejected this token (401). Check for missing characters, or create a fresh token with @BotFather → /mybots → API Token." };
    }
    return { ok: false, message: `Could not reach Telegram: ${(error as Error).message}` };
  }
  let webhookUrl: string | undefined;
  try {
    const webhook = await client.getWebhookInfo();
    if (webhook.url && webhook.url.length > 0) webhookUrl = webhook.url;
  } catch {
    /* non-fatal */
  }
  await secrets(deps).set(TELEGRAM_TOKEN_SECRET, token);
  deps.logger.info("setup.token_saved", "Telegram bot token verified and stored with DPAPI.", { eventCode: "SETUP_TOKEN_SAVED", botId: String(me.id) });
  return {
    ok: true,
    message: webhookUrl ? "Token verified and stored. This bot still has a webhook configured; remove it below to use polling." : "Token verified and stored securely (DPAPI).",
    botUsername: me.username,
    botId: me.id,
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

export async function deleteTelegramWebhook(deps: SetupDeps): Promise<{ ok: boolean; message: string }> {
  const token = await readTelegramToken(deps);
  if (!token) return { ok: false, message: "No bot token stored yet." };
  try {
    await new TelegramClient(token, { logger: deps.logger }).deleteWebhook(false);
    return { ok: true, message: "Webhook deleted; long polling can now be used." };
  } catch (error) {
    return { ok: false, message: `Could not delete the webhook: ${(error as Error).message}` };
  }
}

export async function checkTelegram(deps: SetupDeps): Promise<{ ok: boolean; message: string; botUsername?: string; webhookUrl?: string }> {
  const token = await readTelegramToken(deps);
  if (!token) return { ok: false, message: "No bot token stored yet." };
  try {
    const client = new TelegramClient(token, { logger: deps.logger });
    const me = await client.getMe();
    const webhook = await client.getWebhookInfo().catch(() => undefined);
    return { ok: true, message: `Connected as @${me.username ?? me.id}.`, botUsername: me.username, ...(webhook?.url ? { webhookUrl: webhook.url } : {}) };
  } catch (error) {
    return { ok: false, message: `Telegram check failed: ${(error as Error).message}` };
  }
}

// ------------------------------------------------------------------ api keys

export interface ApiKeySaveResult {
  ok: boolean;
  message: string;
  detail?: string;
}

interface KeyValidator {
  url: string;
  headers: (key: string) => Record<string, string>;
}

const KEY_VALIDATORS: Record<string, KeyValidator> = {
  deepseek: { url: "https://api.deepseek.com/models", headers: (key) => ({ authorization: `Bearer ${key}` }) },
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: (key) => ({ authorization: `Bearer ${key}` }) },
  zai: { url: "https://api.z.ai/api/coding/paas/v4/models", headers: (key) => ({ authorization: `Bearer ${key}` }) },
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=5", headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }) },
  openai: { url: "https://api.openai.com/v1/models", headers: (key) => ({ authorization: `Bearer ${key}` }) },
};

const PROVIDER_LABELS: Record<string, string> = { deepseek: "DeepSeek", openrouter: "OpenRouter", zai: "Z.AI", anthropic: "Anthropic", openai: "OpenAI" };

export async function saveApiKey(deps: SetupDeps, provider: string, rawKey: string): Promise<ApiKeySaveResult> {
  const validator = KEY_VALIDATORS[provider];
  if (!validator) return { ok: false, message: `Unsupported provider "${provider}".` };
  const key = sanitizeToken(rawKey);
  if (key.length < 12 || /\s/.test(key)) {
    return { ok: false, message: "That key looks too short or contains spaces; paste the full key." };
  }
  let response: Response;
  try {
    response = await fetch(validator.url, { headers: validator.headers(key), signal: AbortSignal.timeout(15000) });
  } catch (error) {
    return { ok: false, message: `Could not reach ${PROVIDER_LABELS[provider] ?? provider}: ${(error as Error).message}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: `${PROVIDER_LABELS[provider] ?? provider} rejected this key (${response.status}). Check that you copied the whole key and that the account has access.` };
  }
  let detail = "Key accepted.";
  if (response.ok) {
    try {
      const body = (await response.json()) as { data?: unknown[] | { label?: string; limit?: number | null; usage?: number } };
      if (provider === "openrouter" && body.data && !Array.isArray(body.data)) {
        const data = body.data;
        detail = typeof data.limit === "number" && typeof data.usage === "number" ? `Key valid · usage $${data.usage.toFixed(2)} of $${data.limit.toFixed(2)} limit.` : "Key valid (no fixed credit limit reported).";
      } else if (Array.isArray(body.data)) {
        detail = `Key valid · ${body.data.length} models visible.`;
      }
    } catch {
      /* keep generic detail */
    }
  } else {
    detail = `Key stored, but the provider returned HTTP ${response.status} during validation.`;
  }
  await secrets(deps).set(apiKeySecretName(provider), key);
  deps.logger.info("setup.api_key_saved", "Provider API key stored with DPAPI.", { eventCode: "SETUP_API_KEY_SAVED", provider, validated: response.ok });
  return { ok: true, message: `${PROVIDER_LABELS[provider] ?? provider} key stored securely (DPAPI).`, detail };
}

export async function deleteApiKey(deps: SetupDeps, provider: string): Promise<{ ok: boolean; message: string }> {
  if (!KEY_VALIDATORS[provider]) return { ok: false, message: "Unsupported provider." };
  try {
    secrets(deps).delete(apiKeySecretName(provider));
    return { ok: true, message: `${PROVIDER_LABELS[provider] ?? provider} key removed.` };
  } catch (error) {
    return { ok: false, message: `Could not remove the key: ${(error as Error).message}` };
  }
}

// ------------------------------------------------------------------ model slots

const SLOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface SlotSaveResult {
  ok: boolean;
  message: string;
  slots?: SlotStatus[];
}

export interface UpsertSlotInput {
  name: string;
  provider: string;
  modelId: string;
  label?: string;
  thinking?: string | null;
  routing?: ModelSlotConfig["routing"] | null;
  endpoint?: ModelSlotConfig["endpoint"] | null;
  activate?: boolean;
}

export async function upsertSlot(deps: SetupDeps, input: UpsertSlotInput): Promise<SlotSaveResult> {
  const config = readCurrentConfig(deps);
  const name = input.name.trim().toLowerCase();
  if (!SLOT_NAME_PATTERN.test(name)) return { ok: false, message: "Slot name must be lowercase letters, digits, or hyphens (max 32)." };
  if (!input.modelId?.trim()) return { ok: false, message: "Choose or enter a model id." };
  const slot: ModelSlotConfig = {
    ...(config.models.slots[name] ?? {}),
    provider: input.provider,
    modelId: input.modelId.trim(),
  };
  if (input.label !== undefined) slot.label = input.label;
  if (input.thinking) slot.thinking = input.thinking as ModelSlotConfig["thinking"];
  if (input.routing !== undefined) slot.routing = input.routing ?? undefined;
  if (input.endpoint !== undefined) slot.endpoint = input.endpoint ?? undefined;
  if (input.endpoint === null) delete slot.endpoint;

  const candidate = validateConfig({
    ...config,
    models: {
      ...config.models,
      selectedSlot: input.activate ? name : config.models.selectedSlot,
      slots: { ...config.models.slots, [name]: slot },
    },
  });
  saveConfigAtomic(deps.configPath, candidate);
  invalidateCatalogCache();
  ensureRemoteModelFiles(candidate, deps.paths);
  deps.logger.info("setup.slot_saved", "Model slot saved.", { eventCode: "SETUP_SLOT_SAVED", slot: name, provider: slot.provider, modelId: slot.modelId });
  const status = await getSetupStatus(deps);
  return { ok: true, message: `Saved ${name}: ${slot.provider}/${slot.modelId}.`, slots: status.slots };
}

export async function selectSlot(deps: SetupDeps, name: string): Promise<SlotSaveResult> {
  const config = readCurrentConfig(deps);
  if (!config.models.slots[name]) return { ok: false, message: `Unknown slot "${name}".` };
  saveConfigAtomic(deps.configPath, validateConfig({ ...config, models: { ...config.models, selectedSlot: name } }));
  const status = await getSetupStatus(deps);
  const slotStatus = status.slots.find((slot) => slot.name === name);
  const warning = slotStatus && slotStatus.keyRequired && !slotStatus.keyStored ? " No API key is stored for this provider yet — add one here before sending tasks." : "";
  return { ok: true, message: `Active model: ${name}.${warning}`, slots: status.slots };
}

export async function deleteSlot(deps: SetupDeps, name: string): Promise<SlotSaveResult> {
  const config = readCurrentConfig(deps);
  if (!config.models.slots[name]) return { ok: false, message: `Unknown slot "${name}".` };
  const remaining = { ...config.models.slots };
  delete remaining[name];
  if (Object.keys(remaining).length === 0) return { ok: false, message: "At least one model slot must remain." };
  const nextActive = config.models.selectedSlot === name ? Object.keys(remaining)[0]! : config.models.selectedSlot;
  const candidate = validateConfig({ ...config, models: { ...config.models, selectedSlot: nextActive, slots: remaining } });
  saveConfigAtomic(deps.configPath, candidate);
  invalidateCatalogCache();
  ensureRemoteModelFiles(candidate, deps.paths);
  const status = await getSetupStatus(deps);
  return { ok: true, message: `Removed slot ${name}.`, slots: status.slots };
}

export interface ModelListResult {
  ok: boolean;
  message: string;
  models: CatalogModelInfo[];
  endpointModels?: Array<{ id: string; name: string }>;
}

export async function listModelsForProvider(deps: SetupDeps, provider: string, baseUrl?: string): Promise<ModelListResult> {
  const config = readCurrentConfig(deps);
  const models = await listProviderModels(config, deps.paths, provider);
  if (baseUrl) {
    try {
      const endpointModels = await listEndpointModels(baseUrl);
      return { ok: true, message: `${endpointModels.length} models at the endpoint.`, models, endpointModels };
    } catch (error) {
      return { ok: false, message: `Could not reach the local endpoint: ${(error as Error).message}`, models };
    }
  }
  if (models.length === 0) {
    return { ok: false, message: `No catalog models found for "${provider}". Check the provider name or paste a model id manually.`, models };
  }
  return { ok: true, message: `${models.length} models available.`, models };
}

// ------------------------------------------------------------------ pairing

export interface PairStartResult {
  ok: boolean;
  message: string;
  code?: string;
  botUsername?: string;
  deepLink?: string;
  expiresAt?: string;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;

export async function startPairing(deps: SetupDeps): Promise<PairStartResult> {
  const token = await readTelegramToken(deps);
  if (!token) return { ok: false, message: "Save the Telegram bot token first." };
  let botUsername: string | undefined;
  try {
    const me = await new TelegramClient(token, { logger: deps.logger }).getMe();
    botUsername = me.username;
  } catch (error) {
    return { ok: false, message: `Could not verify the bot token: ${(error as Error).message}` };
  }
  const repository = new JobRepository(deps.db);
  const pairing = new PairingService({ repository });
  const code = generatePairingCode();
  pairing.startPairing(code);
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  deps.logger.info("setup.pairing_started", "Pairing window opened from the dashboard.", { eventCode: "SETUP_PAIRING_STARTED" });
  return {
    ok: true,
    message: "Pairing window open for 10 minutes.",
    code,
    botUsername,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : undefined,
    expiresAt,
  };
}

export function getPairingStatus(deps: SetupDeps): { state: "idle" | "waiting" | "candidate" | "accepted"; candidate?: { userId: string; chatId: string; displayName: string }; expiresAt?: string } {
  const repository = new JobRepository(deps.db);
  const pairing = new PairingService({ repository });
  const candidate = pairing.getPendingCandidate();
  const row = deps.db.prepare("SELECT status, expires_at FROM pairing ORDER BY rowid DESC LIMIT 1").get() as { status: string; expires_at: string } | undefined;
  if (candidate) return { state: "candidate", candidate, ...(row ? { expiresAt: row.expires_at } : {}) };
  if (row?.status === "waiting") return { state: "waiting", ...(row ? { expiresAt: row.expires_at } : {}) };
  const config = readCurrentConfig(deps);
  if (config.telegram.ownerUserId) return { state: "accepted" };
  return { state: "idle" };
}

export async function acceptPairing(deps: SetupDeps): Promise<{ ok: boolean; message: string; userId?: string; displayName?: string }> {
  const status = getPairingStatus(deps);
  if (status.state !== "candidate" || !status.candidate) {
    return { ok: false, message: "There is no pending pairing candidate to accept." };
  }
  const config = readCurrentConfig(deps);
  const next = validateConfig({
    ...config,
    telegram: { ...config.telegram, ownerUserId: status.candidate.userId, ownerChatId: status.candidate.chatId },
  });
  saveConfigAtomic(deps.configPath, next);
  const repository = new JobRepository(deps.db);
  const pairing = new PairingService({ repository });
  pairing.acceptCandidate();
  deps.logger.info("setup.paired", "Owner accepted from the dashboard.", { eventCode: "SETUP_PAIRED", userId: status.candidate.userId });
  try {
    const token = await readTelegramToken(deps);
    if (token) {
      await new TelegramClient(token, { logger: deps.logger }).sendMessage(
        status.candidate.chatId,
        ["Paired successfully. I'm Alfred, your assistant on this PC.", "", "/status - current state", "/help - commands", "/screenshot - capture this screen", "/stop - cancel and suspend"].join("\n"),
      );
    }
  } catch {
    /* best effort */
  }
  return { ok: true, message: `Paired with ${status.candidate.displayName || status.candidate.userId}.`, userId: status.candidate.userId, displayName: status.candidate.displayName };
}

export function cancelPairing(deps: SetupDeps): { ok: boolean; message: string } {
  const repository = new JobRepository(deps.db);
  new PairingService({ repository }).cancelPairing();
  return { ok: true, message: "Pairing cancelled." };
}

// ------------------------------------------------------------------ misc

export async function openBrowserSignIn(deps: SetupDeps): Promise<{ ok: boolean; message: string }> {
  const script = join(projectRoot(), "scripts", "browser-signin.ps1");
  if (!existsSync(script)) return { ok: false, message: "browser-signin.ps1 is missing from the project." };
  return await new Promise((resolveResult) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", (error) => resolveResult({ ok: false, message: error.message }));
    child.unref();
    setTimeout(() => resolveResult({ ok: true, message: "Opening the dedicated Chrome profile for sign-in. Close it when you are done." }), 600);
  });
}

export async function dpapiHealth(): Promise<boolean> {
  try {
    const probe = `pi-tg-${Date.now()}`;
    const back = await runDpapi("unprotect", await runDpapi("protect", Buffer.from(probe, "utf8")));
    return back.toString("utf8") === probe;
  } catch {
    return false;
  }
}
