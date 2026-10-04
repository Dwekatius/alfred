/**
 * Tracked PowerShell execution. One bounded command per call, with a finite
 * timeout, output caps, cancellation, and process-tree cleanup.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AppConfig, DataPaths } from "../config.js";
import { Logger } from "../logging.js";
import { AgentToolError } from "./errors.js";
import type { ToolBroker } from "./broker.js";
import { ProcessManager } from "../platform/process-manager.js";

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface PowerShellToolDeps {
  config: AppConfig;
  paths: DataPaths;
  logger: Logger;
}

export function installPowerShellTools(broker: ToolBroker, deps: PowerShellToolDeps, sharedProcessManager?: ProcessManager): void {
  const manager = sharedProcessManager ?? new ProcessManager();
  broker.registerHandler("system_processes", async (args) => {
    const parsed = args as { filter?: string; terminate?: boolean; pid?: number; expectedName?: string; force?: boolean };
    if (parsed.terminate) {
      if (!parsed.pid || !parsed.expectedName) {
        throw new AgentToolError({ code: "VALIDATION_ERROR", message: "Terminating a process requires pid and expectedName so a reused PID is never targeted.", retryable: false, actionOutcome: "not_started" });
      }
      const check = await runPowerShell(`Get-Process -Id ${parsed.pid} -ErrorAction Stop | Select-Object -ExpandProperty ProcessName`, { cwd: deps.paths.workRoot, timeoutMs: 15000, signal: AbortSignal.timeout(20000), jobId: "processes", manager });
      const actualName = check.stdout.trim();
      if (check.exitCode !== 0 || actualName.length === 0) {
        throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `No process with PID ${parsed.pid}.`, retryable: false, actionOutcome: "not_started" });
      }
      if (actualName.toLowerCase() !== parsed.expectedName.toLowerCase()) {
        throw new AgentToolError({ code: "POLICY_BLOCKED", message: `PID ${parsed.pid} is now "${actualName}", not "${parsed.expectedName}". Refusing to terminate.`, retryable: false, actionOutcome: "not_started" });
      }
      const forceFlag = parsed.force ? " -Force" : "";
      const kill = await runPowerShell(`Stop-Process -Id ${parsed.pid}${forceFlag} -ErrorAction Stop`, { cwd: deps.paths.workRoot, timeoutMs: 15000, signal: AbortSignal.timeout(20000), jobId: "processes", manager });
      if (kill.exitCode !== 0) {
        throw new AgentToolError({ code: "BACKEND_ERROR", message: kill.stderr.trim().slice(0, 200) || "Stop-Process failed", retryable: false, actionOutcome: "unknown" });
      }
      return { content: [{ type: "text" as const, text: `Terminated ${actualName} (PID ${parsed.pid}).` }], details: { pid: parsed.pid, processName: actualName } };
    }
    const filterClause = parsed.filter ? ` | Where-Object { $_.ProcessName -like '*${parsed.filter.replace(/'/g, "''")}*' }` : "";
    const command = `Get-Process${filterClause} | Sort-Object -Property WorkingSet -Descending | Select-Object -First 60 Id,ProcessName,CPU,@{Name='WorkingSetMiB';Expression={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json -Compress`;
    const result = await runPowerShell(command, { cwd: deps.paths.workRoot, timeoutMs: 20000, signal: AbortSignal.timeout(30000), jobId: "processes", manager });
    if (result.exitCode !== 0) {
      throw new AgentToolError({ code: "BACKEND_ERROR", message: result.stderr.trim().slice(0, 200) || "Get-Process failed", retryable: true, actionOutcome: "not_started" });
    }
    return { content: [{ type: "text" as const, text: result.stdout.trim().slice(0, 20000) || "No processes." }], details: {} };
  });

  broker.registerHandler("system_exec", async (args, context) => {
    const { command, cwd, timeoutMs } = args as { command: string; cwd?: string; timeoutMs?: number };
    if (cwd) {
      if (!isAbsolute(cwd)) throw new AgentToolError({ code: "VALIDATION_ERROR", message: "cwd must be an absolute path.", retryable: false, actionOutcome: "not_started" });
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Working directory not found: ${cwd}`, retryable: false, actionOutcome: "not_started" });
      }
    }
    const effectiveTimeout = Math.min(timeoutMs ?? 60000, deps.config.desktop.nativeToolTimeoutMs * 5, 600000);
    return await context.runExclusive(async () => {
      context.assertLease();
      const result = await runPowerShell(command, {
        cwd: cwd ? resolve(cwd) : deps.paths.workRoot,
        timeoutMs: effectiveTimeout,
        signal: context.signal,
        jobId: context.jobId,
        manager,
      });
      const header = `exit code: ${result.exitCode}${result.timedOut ? " (timed out and was terminated)" : ""}${result.truncated ? " (output truncated)" : ""}`;
      const body = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n--- stderr ---\n");
      return {
        content: [{ type: "text" as const, text: `${header}\n\n${body || "(no output)"}` }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, cwd },
      };
    });
  });
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export async function runPowerShell(
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; jobId: string; manager: ProcessManager },
): Promise<RunResult> {
  return await new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.manager.track(child, options.jobId, command.slice(0, 200));
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    const append = (target: "out" | "err", chunk: Buffer): void => {
      const current = target === "out" ? stdout : stderr;
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const remaining = MAX_OUTPUT_BYTES - current.length;
      const value = text.length > remaining ? text.slice(0, remaining) : text;
      if (text.length > remaining) truncated = true;
      if (target === "out") stdout += value;
      else stderr += value;
    };

    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

    const onAbort = (): void => {
      void options.manager.killTree(child).then(() => {
        finish({ exitCode: null, stdout, stderr, truncated, timedOut: false });
      });
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      void options.manager.killTree(child).then(() => {
        finish({ exitCode: null, stdout, stderr, truncated, timedOut: true });
      });
    }, options.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(new AgentToolError({ code: "INTERNAL_ERROR", message: `PowerShell failed to start: ${error.message}`, retryable: false, actionOutcome: "not_started" }));
    });

    child.on("exit", (code) => {
      finish({ exitCode: code, stdout, stderr, truncated, timedOut });
    });
  });
}
