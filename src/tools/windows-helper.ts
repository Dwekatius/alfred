/**
 * Thin wrapper around the Python Windows capability helper.
 * One-shot JSON CLI; spawned with an argument array (no shell).
 */
import { spawn } from "node:child_process";
import { resolvePython } from "../platform/secrets.js";
import { Logger } from "../logging.js";

export interface MonitorInfo {
  device: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  primary: boolean;
  dpi: number;
  scale: number;
}

export interface ForegroundWindowInfo {
  handle: string | null;
  title?: string;
  pid?: number;
  rect?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

export interface SessionStateInfo {
  locked: boolean | null;
  desktop: string | null;
  error: string | null;
}

export class WindowsHelper {
  constructor(
    private readonly scriptPath: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 15000,
  ) {}

  async run<T>(command: string, payload: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    const python = resolvePython();
    const exe = python[0] as string;
    const args = [...python.slice(1), this.scriptPath, command];
    return await new Promise<T>((resolvePromise, reject) => {
      const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => { finish(() => reject(options.signal?.reason ?? new Error("Windows helper cancelled"))); child.kill(); };
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Windows helper ${command} timed out after ${timeoutMs}ms`)));
        child.kill();
      }, timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => {
        finish(() => reject(new Error(`Windows helper failed to start: ${error.message}`)));
      });
      child.on("close", () => {
        if (settled) return;
        const text = Buffer.concat(out).toString("utf8").trim();
        try {
          const parsed = JSON.parse(text) as T & { error?: string };
          if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
            finish(() => reject(new Error(`Windows helper ${command}: ${parsed.error}`)));
            return;
          }
          finish(() => resolvePromise(parsed));
        } catch (error) {
          const stderr = Buffer.concat(err).toString("utf8").trim().slice(0, 300);
          finish(() => reject(new Error(`Windows helper ${command} returned invalid JSON: ${(error as Error).message}${stderr ? ` (stderr: ${stderr})` : ""}`)));
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async sessionState(): Promise<SessionStateInfo> {
    return await this.run<SessionStateInfo>("session_state");
  }

  async monitors(): Promise<MonitorInfo[]> {
    const result = await this.run<{ monitors: MonitorInfo[] }>("monitors");
    return result.monitors ?? [];
  }

  async foregroundWindow(): Promise<ForegroundWindowInfo> {
    return await this.run<ForegroundWindowInfo>("foreground_window");
  }

  async windowInfo(handle: string): Promise<ForegroundWindowInfo & { visible?: boolean; minimized?: boolean }> {
    return await this.run("window_info", { handle });
  }

  async windowsList(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Array<ForegroundWindowInfo & { visible?: boolean; minimized?: boolean }>> {
    const result = await this.run<{ windows: Array<ForegroundWindowInfo & { visible?: boolean; minimized?: boolean }> }>("windows_list", {}, options);
    return result.windows;
  }

  async keyHold(keys: string, ms: number): Promise<unknown> {
    return await this.run("key_hold", { keys, ms });
  }

  async releaseKeys(keys: string[]): Promise<unknown> {
    return await this.run("release_keys", { keys });
  }

  async hotkeyCheck(hotkey: string): Promise<{ available: boolean; hotkey?: string; error?: string }> {
    return await this.run<{ available: boolean; hotkey?: string; error?: string }>("hotkey_check", { hotkey });
  }

  async typeText(text: string): Promise<{ typed: number; units?: number }> {
    return await this.run<{ typed: number; units?: number }>("type_text", { text });
  }
}
