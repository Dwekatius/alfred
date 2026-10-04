/**
 * `npm run doctor` - local diagnostics without printing secrets.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataPaths, defaultConfigPath, loadConfig, type AppConfig } from "./config.js";
import { runDpapi, resolvePython, dpapiScriptPath } from "./platform/secrets.js";
import { TelegramClient } from "./telegram/api.js";
import { readLockInfo } from "./platform/lockfile.js";
import { findCachedModel, ensureRemoteModelFiles } from "./pi/models.js";
import { getCatalogModel } from "./pi/catalog.js";
import { WindowsHelper } from "./tools/windows-helper.js";
import { CreateWindowsBackend, projectRoot, venvExecutable } from "./tools/windows-mcp.js";
import { Logger } from "./logging.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function check(name: string, status: Check["status"], detail: string): Check {
  return { name, status, detail };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function packageVersion(path: string): string {
  const pkg = readJson(path) as { version?: string } | undefined;
  return pkg?.version ?? "unknown";
}

function commandOutput(command: string, args: string[], timeout = 15000): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: output.trim() };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return { ok: false, output: stderr.toString().trim() || (error as Error).message };
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const configPath = args.includes("--config") ? (args[args.indexOf("--config") + 1] ?? defaultConfigPath()) : defaultConfigPath();
  const screenshotSmoke = args.includes("--screenshot");
  const checks: Check[] = [];
  const root = projectRoot();

  checks.push(check("Node.js", process.version.startsWith("v24.") ? "ok" : "warn", process.version));
  const python = resolvePython();
  const pythonVersion = commandOutput(python[0] as string, [...python.slice(1), "--version"]);
  checks.push(check("Python", pythonVersion.ok ? "ok" : "fail", pythonVersion.output));
  checks.push(check("Pi SDK", "ok", packageVersion(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))));
  checks.push(check("@playwright/mcp", "ok", packageVersion(join(root, "node_modules", "@playwright", "mcp", "package.json"))));
  const venvPython = venvExecutable("python.exe");
  if (existsSync(venvPython)) {
    const winmcp = commandOutput(venvPython, ["-c", "import importlib.metadata as m; print(m.version('windows-mcp'))"]);
    checks.push(check("windows-mcp", winmcp.ok ? "ok" : "fail", winmcp.output));
  } else {
    checks.push(check("windows-mcp", "fail", "Project .venv is missing; run scripts/setup.ps1"));
  }
  const dpapiBlob = await runDpapi("protect", Buffer.from("probe", "utf8"))
    .then((blob) => runDpapi("unprotect", blob))
    .then((value) => value.toString("utf8") === "probe")
    .catch(() => false);
  checks.push(check("DPAPI", dpapiBlob ? "ok" : "fail", dpapiBlob ? `available (${dpapiScriptPath()})` : "protect/unprotect probe failed"));

  let config: AppConfig | undefined;
  try {
    config = loadConfig(configPath);
    checks.push(check("Config", "ok", `${configPath} (slot=${config.models.selectedSlot}, dryRun=${config.dryRun})`));
  } catch (error) {
    checks.push(check("Config", "fail", (error as Error).message));
  }

  if (config) {
    const paths = dataPaths(config);
    ensureRemoteModelFiles(config, paths);
    checks.push(check("Owner paired", config.telegram.ownerUserId ? "ok" : "warn", config.telegram.ownerUserId ? `user ${config.telegram.ownerUserId}` : "not paired; run npm run pair"));
    checks.push(check("Controller lock", readLockInfo(paths.lockPath) ? "ok" : "warn", readLockInfo(paths.lockPath) ? `running (pid ${readLockInfo(paths.lockPath)?.pid})` : "not running"));

    const auth = readJson(config.models.authPath) as Record<string, unknown> | undefined;
    checks.push(check("Model credentials", auth && Object.keys(auth).length > 0 ? "ok" : "fail", auth ? `providers present: ${Object.keys(auth).join(", ")}` : `auth file missing: ${config.models.authPath}`));
    for (const [slotName, slot] of Object.entries(config.models.slots)) {
      // Prefer the live bundled catalog (covers all built-in providers), then the
      // cached store, then the slot's own endpoint declaration for local models.
      const catalog = slot.endpoint ? undefined : await getCatalogModel(config, paths, slot.provider, slot.modelId);
      const cached = findCachedModel(paths, slot.provider, slot.modelId);
      const info = catalog
        ? { input: catalog.input, cost: catalog.cost as Record<string, number> | null, levels: catalog.thinkingLevels }
        : cached
          ? {
              input: cached.input ?? [],
              cost: (cached.cost as Record<string, number> | undefined) ?? null,
              levels: cached.thinkingLevelMap ? Object.entries(cached.thinkingLevelMap).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k) : [],
            }
          : null;
      if (!info) {
        const declared = slot.endpoint?.models?.find((model) => model.id === slot.modelId);
        checks.push(
          declared
            ? check(`Model ${slotName}`, "ok", `${slot.provider}/${slot.modelId} (local endpoint; ${declared.input?.includes("image") ? "vision" : "text only"})`)
            : check(`Model ${slotName}`, "warn", `${slot.provider}/${slot.modelId}: not in the catalog; check the model id or refresh the catalog`),
        );
        continue;
      }
      const vision = info.input.includes("image") ? "vision" : "NO VISION";
      const cost = info.cost ? `in=${info.cost.input} out=${info.cost.output}` : "cost unknown";
      const levels = info.levels.length > 0 ? info.levels.join(",") : "unknown";
      checks.push(check(`Model ${slotName}`, vision === "NO VISION" ? "fail" : "ok", `${slot.provider}/${slot.modelId} (${vision}; ${cost}; thinking: ${levels})`));
    }

    const logger = new Logger({ component: "doctor" }, { toStderr: false });
    const helper = new WindowsHelper(join(root, "python", "windows_adapter", "desktop_helper.py"), logger);
    try {
      const session = await helper.sessionState();
      checks.push(check("Interactive session", session.locked === true ? "warn" : "ok", session.locked === true ? "locked right now; desktop tools will wait" : `desktop=${session.desktop ?? "unknown"}`));
      const monitors = await helper.monitors();
      const layout = monitors.map((monitor) => `${monitor.device} ${monitor.width}x${monitor.height}@${monitor.scale}x${monitor.primary ? " primary" : ""}`).join("; ");
      checks.push(check("Displays", monitors.length > 0 ? "ok" : "warn", layout || "no monitors reported"));
      const controllerLock = readLockInfo(paths.lockPath);
      const hotkey = await helper.hotkeyCheck(config.desktop.localStopHotkey);
      if (hotkey.available) {
        checks.push(check("Emergency hotkey", "ok", `${config.desktop.localStopHotkey} registered`));
      } else if (controllerLock) {
        checks.push(check("Emergency hotkey", "ok", `${config.desktop.localStopHotkey} is held by the running controller watchdog (expected while running)`));
      } else {
        checks.push(check("Emergency hotkey", "warn", `${config.desktop.localStopHotkey} is unavailable (taken by another app?); change desktop.localStopHotkey or use npm run stop`));
      }
    } catch (error) {
      checks.push(check("Windows helper", "fail", (error as Error).message));
    }

    const dedicatedLock = join(config.browser.profileDir, "SingletonLock");
    checks.push(check("Dedicated Chrome profile", "ok", existsSync(dedicatedLock) ? "profile lock present (browser may be running)" : "profile directory initialized or not yet created"));
    const zedProfile = join(homedir(), ".pi", "browser", "profile");
    checks.push(check("Zed browser profile", "ok", existsSync(zedProfile) ? "present; the Telegram agent never opens it" : "not found"));

    const token = process.env.PI_TG_BOT_TOKEN ?? (await (async () => {
      try {
        const { createSecretStore } = await import("./platform/secrets.js");
        return await createSecretStore(paths.secretsDir).get(config.telegram.tokenSecretName);
      } catch {
        return undefined;
      }
    })());
    if (!token) {
      checks.push(check("Telegram token", "warn", "not stored; run npm run pair"));
    } else {
      const client = new TelegramClient(token, { logger });
      try {
        const me = await client.getMe();
        checks.push(check("Telegram API", "ok", `authenticated as @${me.username ?? me.id}`));
        const webhook = await client.getWebhookInfo();
        checks.push(check("Telegram webhook", webhook.url ? "fail" : "ok", webhook.url ? "a webhook is configured; polling cannot coexist" : "none (long polling)")); 
      } catch (error) {
        checks.push(check("Telegram API", "fail", (error as Error).message));
      }
    }

    const startup = commandOutput("schtasks", ["/query", "/tn", "Alfred"]);
    checks.push(check("Startup task", startup.ok ? "ok" : "warn", startup.ok ? "registered" : "not registered; run npm run install-startup"));

    if (screenshotSmoke) {
      try {
        const windows = CreateWindowsBackend({ config, paths, logger });
        const result = await windows.call("Screenshot", { use_annotation: false }, { timeoutMs: 30000 });
        const image = result.content.find((block) => block.type === "image" && block.data);
        checks.push(check("Screenshot smoke", image?.data ? "ok" : "fail", image?.data ? `captured ${Math.round(((image.data.length * 3) / 4) / 1024)} KiB PNG` : "no image returned"));
        await windows.dispose();
      } catch (error) {
        checks.push(check("Screenshot smoke", "fail", (error as Error).message));
      }
    }
  }

  const failures = checks.filter((entry) => entry.status === "fail").length;
  console.log("");
  console.log("Alfred doctor");
  console.log("========================");
  for (const entry of checks) {
    const marker = entry.status === "ok" ? "[ok]  " : entry.status === "warn" ? "[warn]" : "[FAIL]";
    console.log(`${marker} ${entry.name}: ${entry.detail}`);
  }
  console.log("");
  console.log(`${checks.length - failures}/${checks.length} checks passed${failures > 0 ? ` (${failures} failures)` : ""}.`);
  return failures > 0 ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
});
