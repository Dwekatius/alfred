/**
 * Settings service for the dashboard's Settings tab.
 *
 * The important one is "start with Windows": it registers/removes the same
 * per-user logon task and removes legacy Startup folder shortcuts. Other settings patch the validated
 * configuration atomically; the running controller hot-reloads them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppConfig, DataPaths, ConfigError, defaultConfigPath, projectRoot, saveConfigAtomic, validateConfig } from "./config.js";
import { Logger } from "./logging.js";

const TASK_NAME = "Alfred";

export interface StartupState {
  taskName: string;
  registered: boolean;
  enabled: boolean;
  state: string;
  trigger: string;
  sources: Array<{ kind: "task" | "startup-folder"; enabled: boolean; state: string }>;
  error?: string;
}

export function getStartupState(): StartupState {
  const script = join(projectRoot(), "scripts", "startup-status.ps1");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  try {
    if (result.error || result.status !== 0) throw new Error("Startup inventory failed.");
    const value = JSON.parse(result.stdout.trim()) as StartupState;
    if (typeof value.registered !== "boolean" || typeof value.enabled !== "boolean" || typeof value.state !== "string" || !Array.isArray(value.sources)) throw new Error("Invalid startup inventory.");
    return value;
  } catch {
    return { taskName: TASK_NAME, registered: false, enabled: false, state: "unknown", trigger: "", sources: [], error: "Could not check Windows startup. Try again or run the startup-status script." };
  }
}

export function setStartup(enabled: boolean, configPath: string = defaultConfigPath()): { ok: boolean; message: string; startup: StartupState } {
  const script = join(projectRoot(), "scripts", enabled ? "install-startup.ps1" : "remove-startup.ps1");
  if (!existsSync(script)) return { ok: false, message: `${enabled ? "install-startup" : "remove-startup"}.ps1 is missing from the project.`, startup: getStartupState() };
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...(enabled ? ["-ConfigPath", configPath] : [])];
  const result = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-4).join("\n");
  const startup = getStartupState();
  if (result.error || result.status !== 0 || startup.error || startup.enabled !== enabled || (!enabled && startup.registered)) {
    return { ok: false, message: `Could not change startup${output ? `: ${output}` : ` (exit ${result.status ?? "unknown"})`}`, startup };
  }
  return {
    ok: true,
    message: enabled ? "Startup enabled — the assistant starts automatically when you sign in to Windows." : "Startup disabled — the assistant will not start automatically.",
    startup,
  };
}

export interface AppSettings {
  pauseOnObservedHumanInput: boolean;
  localStopHotkey: string;
  maxRunSeconds: number;
  maxQueued: number;
  retentionDays: number;
  progressMinimumIntervalSeconds: number;
  automaticStepScreenshots: boolean;
}

export interface VersionInfo {
  app: string;
  node: string;
  piSdk: string;
  windowsMcp: string;
  playwrightMcp: string;
}

function readVersion(path: string, fallback = "unknown"): string {
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return pkg.version ?? fallback;
  } catch {
    return fallback;
  }
}

function readWindowsMcpVersion(): string {
  try {
    const lock = readFileSync(join(projectRoot(), "python", "requirements.lock.txt"), "utf8");
    const match = lock.match(/^windows-mcp==(\S+)$/m);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function getVersionInfo(): VersionInfo {
  const root = projectRoot();
  return {
    app: readVersion(join(root, "package.json")),
    node: process.version,
    piSdk: readVersion(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")),
    windowsMcp: readWindowsMcpVersion(),
    playwrightMcp: readVersion(join(root, "node_modules", "@playwright", "mcp", "package.json")),
  };
}

export interface SettingsPayload {
  ok: boolean;
  startup: StartupState;
  settings: AppSettings;
  paths: { dataRoot: string; workRoot: string; configPath: string; logsDir: string; sessionsDir: string; artifactsDir: string; browserProfileDir: string };
  info: { timeZone: string; activeSlot: string; provider: string; modelId: string; thinking: string };
  versions: VersionInfo;
}

export function getSettings(config: AppConfig, paths: DataPaths, configPath: string): SettingsPayload {
  const slot = config.models.slots[config.models.selectedSlot] ?? Object.values(config.models.slots)[0];
  return {
    ok: true,
    startup: getStartupState(),
    settings: {
      pauseOnObservedHumanInput: config.desktop.pauseOnObservedHumanInput,
      localStopHotkey: config.desktop.localStopHotkey,
      maxRunSeconds: config.jobs.maxRunSeconds,
      maxQueued: config.jobs.maxQueued,
      retentionDays: config.artifacts.retentionDays,
      progressMinimumIntervalSeconds: config.notifications.progressMinimumIntervalSeconds,
      automaticStepScreenshots: config.notifications.automaticStepScreenshots,
    },
    paths: {
      dataRoot: paths.dataRoot,
      workRoot: paths.workRoot,
      configPath,
      logsDir: paths.logsDir,
      sessionsDir: paths.sessionsDir,
      artifactsDir: paths.artifactsDir,
      browserProfileDir: paths.browserProfileDir,
    },
    info: {
      timeZone: config.timeZone,
      activeSlot: config.models.selectedSlot,
      provider: slot?.provider ?? "unknown",
      modelId: slot?.modelId ?? "unknown",
      thinking: slot?.thinking ?? config.models.thinking,
    },
    versions: getVersionInfo(),
  };
}

export interface UpdateSettingsResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  settings?: AppSettings;
}

export function updateSettings(
  config: AppConfig,
  paths: DataPaths,
  configPath: string,
  logger: Logger,
  patch: Partial<AppSettings>,
): UpdateSettingsResult {
  const next: AppConfig = {
    ...config,
    desktop: {
      ...config.desktop,
      ...(patch.pauseOnObservedHumanInput === undefined ? {} : { pauseOnObservedHumanInput: patch.pauseOnObservedHumanInput }),
      ...(patch.localStopHotkey === undefined ? {} : { localStopHotkey: patch.localStopHotkey.trim() }),
    },
    jobs: {
      ...config.jobs,
      ...(patch.maxRunSeconds === undefined ? {} : { maxRunSeconds: Math.round(patch.maxRunSeconds) }),
      ...(patch.maxQueued === undefined ? {} : { maxQueued: Math.round(patch.maxQueued) }),
    },
    artifacts: {
      ...config.artifacts,
      ...(patch.retentionDays === undefined ? {} : { retentionDays: Math.round(patch.retentionDays) }),
    },
    notifications: {
      ...config.notifications,
      ...(patch.progressMinimumIntervalSeconds === undefined ? {} : { progressMinimumIntervalSeconds: Math.round(patch.progressMinimumIntervalSeconds) }),
      ...(patch.automaticStepScreenshots === undefined ? {} : { automaticStepScreenshots: patch.automaticStepScreenshots }),
    },
  };
  let validated: AppConfig;
  try {
    validated = validateConfig(next);
  } catch (error) {
    const issues = error instanceof ConfigError ? error.issues : [(error as Error).message];
    return { ok: false, message: `Settings not saved: ${issues.slice(0, 3).join("; ")}`, restartRequired: false };
  }
  saveConfigAtomic(configPath, validated);
  const restartRequired = patch.localStopHotkey !== undefined && patch.localStopHotkey.trim() !== config.desktop.localStopHotkey;
  logger.info("settings.updated", "Settings updated from the dashboard.", { eventCode: "SETTINGS_UPDATED", restartRequired });
  return {
    ok: true,
    message: restartRequired ? "Saved. Restart the assistant to apply the new emergency hotkey."
      : patch.pauseOnObservedHumanInput !== undefined
        ? `Saved. Pause on local input is now ${validated.desktop.pauseOnObservedHumanInput ? "on" : "off"}; applies immediately. An already paused task still needs Resume.`
        : "Saved. Applies to the next job.",
    restartRequired,
    settings: getSettings(validated, paths, configPath).settings,
  };
}

export function openTarget(target: string, paths: DataPaths, configPath: string): { ok: boolean; message: string } {
  if (target === "logs") {
    spawnSync("explorer.exe", [paths.logsDir], { windowsHide: false });
    return { ok: true, message: "Opened the logs folder." };
  }
  if (target === "config") {
    spawnSync("notepad.exe", [configPath], { windowsHide: false });
    return { ok: true, message: "Opened the configuration file." };
  }
  if (target === "doctor") {
    const script = join(projectRoot(), "scripts", "doctor.ps1");
    spawnSync("cmd.exe", ["/c", "start", "", "powershell.exe", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `"${script}"`], { windowsHide: true });
    return { ok: true, message: "Running doctor in a new window." };
  }
  return { ok: false, message: `Unknown target "${target}".` };
}
