/**
 * Session monitor: desktop availability probes, physical-input detection, and
 * the local emergency-stop hotkey.
 *
 * The Python watchdog records only timestamps of non-injected input (no key
 * content) and writes a marker file on the emergency hotkey. This module polls
 * those files and forwards events to the supervisor.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppConfig, DataPaths } from "../config.js";
import { Logger, redactString } from "../logging.js";
import type { ProcessManager } from "./process-manager.js";
import { resolvePython } from "./secrets.js";

export interface SessionMonitorDeps {
  config: AppConfig;
  paths: DataPaths;
  logger: Logger;
  processManager: ProcessManager;
  onHumanActivity: (kind: string) => void;
  onEmergencyStop: (source: string) => void;
}

export class SessionMonitor {
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activityOffset = 0;
  private stopFileSeen = false;
  private hotkeyAvailable: boolean | undefined;

  constructor(private readonly deps: SessionMonitorDeps) {}

  get activityFile(): string {
    return join(this.deps.paths.stateDir, "human-activity.jsonl");
  }

  get stopFile(): string {
    return join(this.deps.paths.stateDir, "emergency-stop.json");
  }

  isHotkeyAvailable(): boolean | undefined {
    return this.hotkeyAvailable;
  }

  async start(): Promise<void> {
    const { config, logger } = this.deps;
    const watchInput = config.desktop.pauseOnObservedHumanInput;
    const hotkey = config.desktop.localStopHotkey;
    if (!watchInput && !hotkey) return;

    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const script = join(projectRoot, "python", "windows_adapter", "input_watch.py");
    if (!existsSync(script)) {
      logger.warn("session.watchdog_missing", "Input watchdog script not found; local takeover detection disabled.", { eventCode: "WATCHDOG_MISSING", path: script });
      return;
    }
    rmSync(this.stopFile, { force: true });
    const python = resolvePython();
    const args = [...python.slice(1), script, "--activity-file", this.activityFile, "--stop-file", this.stopFile, "--hotkey", hotkey, "--verbose"];
    const child = spawn(python[0] as string, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.deps.processManager.track(child, "session-monitor", "input_watch.py");
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { ready?: boolean; hotkey?: boolean; keyboardHook?: boolean; mouseHook?: boolean };
          if (parsed.ready) {
            this.hotkeyAvailable = parsed.hotkey;
            logger.info("session.watchdog_ready", "Local input watchdog started.", {
              eventCode: "WATCHDOG_READY",
              hotkeyRegistered: parsed.hotkey,
              keyboardHook: parsed.keyboardHook,
              mouseHook: parsed.mouseHook,
              hotkey,
            });
            if (!parsed.hotkey) {
              logger.warn("session.hotkey_unavailable", `Emergency hotkey ${hotkey} could not be registered (it may be taken by another app). Change desktop.localStopHotkey or use "npm run stop".`, { eventCode: "HOTKEY_UNAVAILABLE" });
            }
          }
        } catch {
          logger.debug("session.watchdog_output", "Watchdog output", { eventCode: "WATCHDOG_OUTPUT", message: redactString(trimmed).slice(0, 300) });
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) logger.debug("session.watchdog_stderr", "Watchdog stderr", { eventCode: "WATCHDOG_STDERR", message: redactString(line).slice(0, 500) });
    });
    child.on("error", (error) => {
      logger.warn("session.watchdog_error", "Local input watchdog could not start.", { eventCode: "WATCHDOG_ERROR", message: redactString(error.message) });
      this.child = undefined;
    });
    child.on("exit", (code) => {
      logger.warn("session.watchdog_exited", "Local input watchdog exited.", { eventCode: "WATCHDOG_EXITED", exitCode: code ?? undefined });
      this.child = undefined;
    });

    if (existsSync(this.activityFile)) this.activityOffset = readFileSync(this.activityFile).byteLength;
    this.timer = setInterval(() => this.poll(), 1000);
    this.timer.unref?.();
  }

  private poll(): void {
    try {
      if (existsSync(this.activityFile)) {
        const bytes = readFileSync(this.activityFile);
        if (bytes.byteLength > this.activityOffset) {
          const fresh = bytes.subarray(this.activityOffset).toString("utf8");
          this.activityOffset = bytes.byteLength;
          for (const line of fresh.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as { kind?: string };
              this.deps.onHumanActivity(parsed.kind ?? "input");
            } catch {
              /* ignore malformed line */
            }
          }
        }
      }
      if (!this.stopFileSeen && existsSync(this.stopFile)) {
        this.stopFileSeen = true;
        let source = "hotkey";
        try {
          source = (JSON.parse(readFileSync(this.stopFile, "utf8")) as { source?: string }).source ?? "hotkey";
        } catch {
          /* ignore */
        }
        this.deps.logger.warn("session.emergency_stop", "Emergency stop was triggered locally.", { eventCode: "EMERGENCY_STOP", source });
        this.deps.onEmergencyStop(source);
      }
    } catch (error) {
      this.deps.logger.debug("session.poll_failed", "Session monitor poll failed.", { eventCode: "SESSION_POLL", message: (error as Error).message });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.child) {
      await this.deps.processManager.killTree(this.child);
      this.child = undefined;
    }
  }
}
