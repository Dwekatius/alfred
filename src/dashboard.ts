/**
 * Local dashboard server for the Alfred.
 *
 * Binds to 127.0.0.1 only, requires a per-run token for every API/SSE call,
 * and is the UI companion to the tray: start/stop the agent, watch live model
 * output, and inspect token/cost usage from the same SQLite database.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "./storage/database.js";
import { runMigrations } from "./storage/migrations.js";
import { dataPaths, defaultConfigPath, ensureDataDirs, loadConfig, saveConfigAtomic, createDefaultConfig, type AppConfig, type DataPaths } from "./config.js";
import { Logger } from "./logging.js";
import { localIpcRequest, readLocalIpcInfo } from "./platform/local-ipc.js";
import { restrictPathToOwner } from "./platform/secrets.js";
import { findCachedModel, ensureRemoteModelFiles } from "./pi/models.js";
import {
  acceptPairing,
  cancelPairing,
  checkTelegram,
  deleteApiKey,
  deleteSlot,
  deleteTelegramWebhook,
  dpapiHealth,
  getPairingStatus,
  getSetupStatus,
  listModelsForProvider,
  openBrowserSignIn,
  saveApiKey,
  saveTelegramToken,
  selectSlot,
  startPairing,
  upsertSlot,
  type SetupDeps,
} from "./setup.js";
import { getSettings, openTarget, setStartup, updateSettings } from "./settings.js";

const DEFAULT_PORT = Number.parseInt(process.env.PI_TG_DASHBOARD_PORT ?? "8787", 10);
const TASK_NAME = "Alfred";

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function parseArgs(argv: string[]): { configPath: string; port: number } {
  let configPath = defaultConfigPath();
  let port = DEFAULT_PORT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configPath = argv[index + 1] as string;
      index += 1;
    } else if (argv[index] === "--port" && argv[index + 1]) {
      port = Number.parseInt(argv[index + 1] as string, 10);
      index += 1;
    }
  }
  return { configPath, port: Number.isFinite(port) ? port : DEFAULT_PORT };
}

interface DashboardInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let config: AppConfig;
  let configCreated = false;
  try {
    if (!existsSync(options.configPath)) {
      config = createDefaultConfig();
      saveConfigAtomic(options.configPath, config);
      configCreated = true;
    } else {
      config = loadConfig(options.configPath);
    }
  } catch (error) {
    console.error(`Configuration error: ${(error as Error).message}`);
    process.exit(2);
  }
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  ensureRemoteModelFiles(config, paths, undefined);
  const logger = new Logger({ component: "dashboard" }, { logDir: paths.logsDir });
  const db = Database.open(paths.databasePath);
  runMigrations(db);

  const token = randomBytes(24).toString("base64url");
  const info: DashboardInfo = { port: options.port, token, pid: process.pid, startedAt: new Date().toISOString() };
  const infoPath = join(paths.stateDir, "dashboard.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(infoPath, JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
  restrictPathToOwner(infoPath);

  const staticRoot = join(projectRoot(), "dashboard");
  if (configCreated) {
    logger.info("dashboard.config_created", "Created a default configuration for this user.", { eventCode: "DASHBOARD_CONFIG_CREATED", configPath: options.configPath });
    console.log(`Created default configuration at ${options.configPath}`);
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, { config, configPath: options.configPath, paths, db, token, logger, staticRoot }).catch((error) => {
      logger.error("dashboard.request_failed", "Dashboard request failed.", { eventCode: "DASHBOARD_REQUEST", path: request.url?.split("?")[0] ?? "unknown", method: request.method ?? "GET", detail: (error as Error).message });
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("Internal error");
    });
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${options.port} is already in use; the dashboard is probably already running.`);
      process.exit(3);
    }
    console.error(`Dashboard server error: ${error.message}`);
    process.exit(4);
  });

  server.listen(options.port, "127.0.0.1", () => {
    logger.info("dashboard.ready", "Dashboard listening.", { eventCode: "DASHBOARD_READY", port: options.port });
    console.log(`Alfred dashboard: http://127.0.0.1:${options.port}/?token=${token}`);
  });

  const shutdown = (): void => {
    logger.info("dashboard.stopped", "Dashboard shutting down.", { eventCode: "DASHBOARD_STOPPED" });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

interface RequestContext {
  config: AppConfig;
  configPath: string;
  paths: DataPaths;
  db: Database;
  token: string;
  logger: Logger;
  staticRoot: string;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function authorized(url: URL, request: IncomingMessage, token: string): boolean {
  const fromQuery = url.searchParams.get("token");
  const fromHeader = request.headers["x-pi-token"];
  return fromQuery === token || fromHeader === token;
}

async function readBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: RequestContext): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort ?? 0}`);
  const { config, paths, db, token, logger, staticRoot } = context;

  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, pid: process.pid });
    return;
  }

  // Static assets (no secrets inside; the page itself needs the token to work).
  if (url.pathname === "/style.css" || url.pathname === "/app.js" || url.pathname === "/chart.js" || url.pathname === "/logo.png" || url.pathname === "/logo-dark.png" || url.pathname === "/favicon.png" || url.pathname === "/favicon-dark.png") {
    try {
      const isPng = url.pathname.endsWith(".png");
      const file = readFileSync(join(staticRoot, url.pathname.slice(1)));
      response.writeHead(200, {
        "content-type": isPng ? "image/png" : url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (!authorized(url, request, token)) {
      response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body style='font-family:Segoe UI;background:#0f1115;color:#e6edf3;padding:40px'><h2>Open this page from the &quot;Alfred&quot; shortcut.</h2><p>The dashboard requires its local access token.</p></body></html>");
      return;
    }
    try {
      const html = readFileSync(join(staticRoot, "index.html"), "utf8").replaceAll("__PI_TOKEN__", token);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    } catch (error) {
      response.writeHead(500);
      response.end(`Dashboard UI files missing: ${(error as Error).message}`);
    }
    return;
  }

  if (!authorized(url, request, token)) {
    sendJson(response, 403, { ok: false, error: "unauthorized" });
    return;
  }

  if (url.pathname.startsWith("/api/setup/")) {
    await handleSetupRequest(url, request, response, context);
    return;
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    sendJson(response, 200, await buildStatus(context));
    return;
  }

  if (url.pathname === "/api/action" && request.method === "POST") {
    const body = await readBody(request);
    const action = String(body.action ?? "");
    const result = await runAction(action, context);
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "GET") {
    const config = readConfigSafe(context);
    sendJson(response, 200, getSettings(config, paths, context.configPath));
    return;
  }

  if (url.pathname === "/api/settings" && request.method === "POST") {
    const body = await readBody(request);
    const config = readConfigSafe(context);
    const patch: Record<string, unknown> = {};
    if (body.pauseOnObservedHumanInput !== undefined) patch.pauseOnObservedHumanInput = Boolean(body.pauseOnObservedHumanInput);
    if (body.localStopHotkey !== undefined) patch.localStopHotkey = String(body.localStopHotkey);
    if (body.maxRunSeconds !== undefined) patch.maxRunSeconds = Number(body.maxRunSeconds);
    if (body.maxQueued !== undefined) patch.maxQueued = Number(body.maxQueued);
    if (body.retentionDays !== undefined) patch.retentionDays = Number(body.retentionDays);
    const result = updateSettings(config, paths, context.configPath, logger, patch as never);
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === "/api/settings/startup" && request.method === "POST") {
    const body = await readBody(request);
    const result = setStartup(Boolean(body.enabled), context.configPath);
    sendJson(response, result.ok ? 200 : 500, result);
    return;
  }

  if (url.pathname === "/api/settings/open" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, openTarget(String(body.target ?? ""), paths, context.configPath));
    return;
  }

  if (url.pathname === "/api/usage" && request.method === "GET") {
    const bucket = url.searchParams.get("bucket") ?? "day";
    sendJson(response, 200, buildUsage(db, bucket === "week" ? "week" : bucket === "month" ? "month" : "day"));
    return;
  }

  if (url.pathname === "/api/clear" && request.method === "POST") {
    db.prepare("DELETE FROM stream_events").run();
    logger.info("dashboard.cleared", "Terminal cleared from dashboard.", { eventCode: "DASHBOARD_CLEAR" });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/events" && request.method === "GET") {
    streamEvents(request, response, db);
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

// ------------------------------------------------------------------ status/actions

async function controllerStatus(paths: DataPaths): Promise<Record<string, unknown> | null> {
  const info = readLocalIpcInfo(paths.stateDir);
  if (!info) return null;
  try {
    const result = await localIpcRequest(info, "status", undefined, 2500);
    return result.ok ? (result.result as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface CachedTaskState {
  state: string;
  at: number;
}
let taskStateCache: CachedTaskState | undefined;

async function getTaskState(): Promise<string> {
  const now = Date.now();
  if (taskStateCache && now - taskStateCache.at < 4000) return taskStateCache.state;
  const state = await new Promise<string>((resolveState) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-ScheduledTask -TaskName '${TASK_NAME}').State`], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", () => resolveState("Unknown"));
    child.on("exit", () => resolveState(output.trim() || "Unknown"));
  });
  taskStateCache = { state, at: now };
  return state;
}

async function runPowerShell(command: string | string[]): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolveResult) => {
    const arguments_ = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...(typeof command === "string" ? ["-Command", command] : ["-File", ...command])];
    const child = spawn("powershell.exe", arguments_, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolveResult({ ok: false, error: error.message }));
    child.on("exit", (code) => resolveResult(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().slice(0, 300) || `exit ${code}` }));
  });
}

function setupDeps(context: RequestContext): SetupDeps {
  return { configPath: context.configPath, paths: context.paths, db: context.db, logger: context.logger };
}

async function handleSetupRequest(url: URL, request: IncomingMessage, response: ServerResponse, context: RequestContext): Promise<void> {
  const deps = setupDeps(context);
  const path = url.pathname;
  if (path === "/api/setup/status" && request.method === "GET") {
    const status = await getSetupStatus(deps);
    sendJson(response, 200, { ok: true, status, dpapi: await dpapiHealth() });
    return;
  }
  if (path === "/api/setup/telegram" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await saveTelegramToken(deps, String(body.token ?? "")));
    return;
  }
  if (path === "/api/setup/telegram/check" && request.method === "POST") {
    sendJson(response, 200, await checkTelegram(deps));
    return;
  }
  if (path === "/api/setup/telegram/webhook-delete" && request.method === "POST") {
    sendJson(response, 200, await deleteTelegramWebhook(deps));
    return;
  }
  if (path === "/api/setup/api-key" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await saveApiKey(deps, String(body.provider ?? ""), String(body.key ?? "")));
    return;
  }
  if (path === "/api/setup/api-key/delete" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await deleteApiKey(deps, String(body.provider ?? "")));
    return;
  }
  if (path === "/api/setup/slot" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(
      response,
      200,
      await upsertSlot(deps, {
        name: String(body.name ?? ""),
        provider: String(body.provider ?? ""),
        modelId: String(body.modelId ?? ""),
        label: body.label === undefined ? undefined : String(body.label),
        thinking: body.thinking === undefined || body.thinking === null ? null : String(body.thinking),
        endpoint: (body.endpoint ?? null) as never,
        activate: Boolean(body.activate),
      }),
    );
    return;
  }
  if (path === "/api/setup/slot/select" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await selectSlot(deps, String(body.name ?? "")));
    return;
  }
  if (path === "/api/setup/slot/delete" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, await deleteSlot(deps, String(body.name ?? "")));
    return;
  }
  if (path === "/api/setup/models" && request.method === "GET") {
    const provider = url.searchParams.get("provider") ?? "";
    const baseUrl = url.searchParams.get("baseUrl") ?? undefined;
    sendJson(response, 200, await listModelsForProvider(deps, provider, baseUrl));
    return;
  }
  if (path === "/api/setup/pair/start" && request.method === "POST") {
    sendJson(response, 200, await startPairing(deps));
    return;
  }
  if (path === "/api/setup/pair/status" && request.method === "GET") {
    sendJson(response, 200, { ok: true, pairing: getPairingStatus(deps) });
    return;
  }
  if (path === "/api/setup/pair/accept" && request.method === "POST") {
    sendJson(response, 200, await acceptPairing(deps));
    return;
  }
  if (path === "/api/setup/pair/cancel" && request.method === "POST") {
    sendJson(response, 200, cancelPairing(deps));
    return;
  }
  if (path === "/api/setup/browser-signin" && request.method === "POST") {
    sendJson(response, 200, await openBrowserSignIn(deps));
    return;
  }
  sendJson(response, 404, { ok: false, error: "unknown setup endpoint" });
}

function readConfigSafe(context: RequestContext): AppConfig {
  try {
    return loadConfig(context.configPath);
  } catch {
    return context.config;
  }
}

async function buildStatus(context: RequestContext): Promise<Record<string, unknown>> {
  const { paths } = context;
  let config = context.config;
  try {
    config = loadConfig(context.configPath);
  } catch {
    /* keep the startup snapshot if the file is mid-edit */
  }
  const status = await controllerStatus(paths);
  const taskState = await getTaskState();
  const slot = config.models.slots[config.models.selectedSlot] ?? Object.values(config.models.slots)[0];
  const metadata = slot ? findCachedModel(paths, slot.provider, slot.modelId) : undefined;
  return {
    ok: true,
    controller: status,
    controllerRunning: Boolean(status),
    taskState,
    paired: Boolean(config.telegram.ownerUserId),
    owner: config.telegram.ownerUserId,
    model: slot
      ? {
          slot: config.models.selectedSlot,
          provider: slot.provider,
          modelId: slot.modelId,
          thinking: slot.thinking ?? config.models.thinking,
          vision: metadata?.input?.includes("image") ?? false,
          cost: metadata?.cost ?? null,
        }
      : { slot: config.models.selectedSlot, provider: "unknown", modelId: "unknown", thinking: config.models.thinking, vision: false, cost: null },
    time: new Date().toISOString(),
  };
}

async function runAction(action: string, context: RequestContext): Promise<{ ok: boolean; message: string }> {
  const { paths, logger } = context;
  switch (action) {
    case "start": {
      if (await controllerStatus(paths)) return { ok: true, message: "Already running." };
      const start = await runPowerShell([join(projectRoot(), "scripts", "start-controller.ps1"), "-ConfigPath", context.configPath]);
      if (!start.ok) return { ok: false, message: `Could not start the task: ${start.error}` };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(500);
        if (await controllerStatus(paths)) return { ok: true, message: "Assistant started." };
      }
      return { ok: false, message: "Task started but the controller did not come up; check the logs." };
    }
    case "stop": {
      const status = await controllerStatus(paths);
      if (status) {
        const info = readLocalIpcInfo(paths.stateDir);
        if (info) await localIpcRequest(info, "shutdown", undefined, 3000).catch(() => undefined);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await sleep(400);
          if (!(await controllerStatus(paths))) return { ok: true, message: "Assistant stopped." };
        }
        return { ok: false, message: "Stop requested, but the controller is still answering." };
      }
      await runPowerShell(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
      return { ok: true, message: "Assistant was already stopped." };
    }
    case "restart": {
      await runAction("stop", context);
      await sleep(800);
      return await runAction("start", context);
    }
    case "pause":
    case "resume": {
      const info = readLocalIpcInfo(paths.stateDir);
      if (!info) return { ok: false, message: "Assistant is not running." };
      try {
        const result = await localIpcRequest(info, action, undefined, 5000);
        return result.ok ? { ok: true, message: action === "pause" ? "Pause requested." : "Resume requested." } : { ok: false, message: result.error ?? "Control failed." };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    }
    default:
      logger.warn("dashboard.bad_action", "Unknown dashboard action.", { eventCode: "DASHBOARD_BAD_ACTION", action });
      return { ok: false, message: `Unknown action: ${action}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// ------------------------------------------------------------------ usage

type BucketSize = "day" | "week" | "month";

interface UsageBucket {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

const BUCKET_COUNTS: Record<BucketSize, number> = { day: 30, week: 12, month: 12 };

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Monday of the week containing the date. */
function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

function isoWeekLabel(date: Date): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `W${String(week).padStart(2, "0")}`;
}

interface DailyTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

const EMPTY_DAY: DailyTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 };

function buildUsage(db: Database, size: BucketSize): Record<string, unknown> {
  // Always aggregate locally by day, then roll up to weeks/months in JS so the
  // buckets follow the machine's local time zone and ISO week rules.
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', datetime(timestamp, 'localtime')) AS day,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(reasoning_tokens) AS reasoning_tokens,
              SUM(cost_usd) AS cost_usd
         FROM usage_events
        GROUP BY day`,
    )
    .all() as Array<Record<string, number | string>>;

  const daily = new Map<string, DailyTotals>();
  for (const row of rows) {
    daily.set(String(row.day ?? ""), {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
      reasoningTokens: Number(row.reasoning_tokens ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
    });
  }

  const sumDays = (keys: string[]): DailyTotals => {
    const total: DailyTotals = { ...EMPTY_DAY };
    for (const key of keys) {
      const value = daily.get(key);
      if (!value) continue;
      total.inputTokens += value.inputTokens;
      total.outputTokens += value.outputTokens;
      total.cacheReadTokens += value.cacheReadTokens;
      total.cacheWriteTokens += value.cacheWriteTokens;
      total.reasoningTokens += value.reasoningTokens;
      total.costUsd += value.costUsd;
    }
    return total;
  };

  const now = new Date();
  const buckets: UsageBucket[] = [];
  if (size === "day") {
    for (let index = BUCKET_COUNTS.day - 1; index >= 0; index -= 1) {
      const date = addDays(now, -index);
      const key = dayKey(date);
      buckets.push({ key, label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), ...sumDays([key]) });
    }
  } else if (size === "week") {
    const thisMonday = startOfWeek(now);
    for (let index = BUCKET_COUNTS.week - 1; index >= 0; index -= 1) {
      const monday = addDays(thisMonday, -index * 7);
      const keys: string[] = [];
      for (let offset = 0; offset < 7; offset += 1) keys.push(dayKey(addDays(monday, offset)));
      buckets.push({ key: `${monday.getFullYear()}-${isoWeekLabel(monday)}`, label: isoWeekLabel(monday), ...sumDays(keys) });
    }
  } else {
    for (let index = BUCKET_COUNTS.month - 1; index >= 0; index -= 1) {
      const first = new Date(now.getFullYear(), now.getMonth() - index, 1);
      const keys: string[] = [];
      for (let day = 1; day <= 31; day += 1) {
        const date = new Date(first.getFullYear(), first.getMonth(), day);
        if (date.getMonth() !== first.getMonth()) break;
        keys.push(dayKey(date));
      }
      buckets.push({ key: monthKey(first), label: first.toLocaleDateString(undefined, { month: "short", year: "2-digit" }), ...sumDays(keys) });
    }
  }

  const sumSince = (since: Date): { costUsd: number; tokens: number } => {
    const row = db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens FROM usage_events WHERE timestamp >= ?").get(since.toISOString()) as { cost: number; tokens: number };
    return { costUsd: row.cost, tokens: row.tokens };
  };
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeekDate = startOfWeek(now);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const allTime = db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens FROM usage_events").get() as { cost: number; tokens: number };

  return {
    bucketSize: size,
    buckets,
    totals: {
      today: sumSince(startOfDay),
      week: sumSince(startOfWeekDate),
      month: sumSince(startOfMonth),
      all: { costUsd: allTime.cost, tokens: allTime.tokens },
    },
  };
}

// ------------------------------------------------------------------ SSE

function streamEvents(request: IncomingMessage, response: ServerResponse, db: Database): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");

  // Rows are blocks now (a whole thinking chain is one row that grows).
  // Poll for new ids AND for updates to existing rows, and let the client merge
  // by id, so history and live streaming are both complete.
  let lastId = 0;
  let lastUpdatedAt = new Date(0).toISOString();
  try {
    const snapshot = db.prepare("SELECT id, timestamp, updated_at, job_id, kind, text FROM (SELECT * FROM stream_events ORDER BY id DESC LIMIT 200) ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of snapshot) {
      lastId = Math.max(lastId, Number(row.id));
      const updated = String(row.updated_at ?? row.timestamp ?? "");
      if (updated > lastUpdatedAt) lastUpdatedAt = updated;
      response.write(`data: ${JSON.stringify(row)}\n\n`);
    }
  } catch {
    /* no telemetry yet */
  }

  const timer = setInterval(() => {
    try {
      const rows = db
        .prepare("SELECT id, timestamp, updated_at, job_id, kind, text FROM stream_events WHERE id > ? OR updated_at > ? ORDER BY id LIMIT 1000")
        .all(lastId, lastUpdatedAt) as Array<Record<string, unknown>>;
      for (const row of rows) {
        lastId = Math.max(lastId, Number(row.id));
        const updated = String(row.updated_at ?? row.timestamp ?? "");
        if (updated > lastUpdatedAt) lastUpdatedAt = updated;
        response.write(`data: ${JSON.stringify(row)}\n\n`);
      }
    } catch {
      /* ignore transient read errors */
    }
  }, 250);
  timer.unref?.();

  const heartbeat = setInterval(() => {
    try {
      response.write(": keep-alive\n\n");
    } catch {
      /* connection may be gone */
    }
  }, 15000);
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(timer);
    clearInterval(heartbeat);
  };
  request.on("close", cleanup);
  request.on("error", cleanup);
}

main().catch((error) => {
  console.error(`Dashboard failed: ${(error as Error).message}`);
  process.exit(1);
});
