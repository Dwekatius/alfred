/**
 * Windows-MCP stdio backend from the pinned project virtual environment.
 *
 * Launched as `<project>/.venv/Scripts/windows-mcp.exe serve` with
 * ANONYMIZED_TELEMETRY=false. The supervisor owns its lifetime; a crashed
 * connection is restarted with an explicit error surfaced to the job.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppConfig, DataPaths } from "../config.js";
import { Logger } from "../logging.js";
import { McpStdioBackend, type McpCallResult, type McpToolInfo } from "./mcp-client.js";
import { WindowsHelper } from "./windows-helper.js";

export interface WindowsBackend {
  ensureStarted(): Promise<void>;
  call(tool: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>;
  listTools(): McpToolInfo[];
  restart(): Promise<void>;
  dispose(): Promise<void>;
  isStarted(): boolean;
  helper: WindowsHelper;
  mcp: McpStdioBackend;
}

export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function venvExecutable(name: string): string {
  return join(projectRoot(), ".venv", "Scripts", name);
}

export function CreateWindowsBackend(options: { config: AppConfig; paths: DataPaths; logger: Logger }): WindowsBackend {
  const executable = venvExecutable("windows-mcp.exe");
  const command = existsSync(executable) ? executable : join(projectRoot(), ".venv", "Scripts", "python.exe");
  const args = existsSync(executable) ? ["serve"] : ["-m", "windows_mcp", "serve"];
  const mcp = new McpStdioBackend({
    name: "windows-mcp",
    command,
    args,
    cwd: projectRoot(),
    env: {
      ...process.env as Record<string, string>,
      ANONYMIZED_TELEMETRY: "false",
      WINDOWS_MCP_SCREENSHOT_SCALE: "1.0",
    },
    logger: options.logger,
    manifestPath: join(options.paths.manifestsDir, "windows-mcp-tools.json"),
    defaultTimeoutMs: options.config.desktop.nativeToolTimeoutMs,
  });
  const helper = new WindowsHelper(join(projectRoot(), "python", "windows_adapter", "desktop_helper.py"), options.logger, options.config.desktop.nativeToolTimeoutMs);
  return {
    mcp,
    helper,
    ensureStarted: () => mcp.ensureStarted(),
    call: (tool, toolArgs, callOptions) => mcp.callTool(tool, toolArgs, callOptions),
    listTools: () => mcp.listTools(),
    restart: () => mcp.restart(),
    dispose: () => mcp.dispose(),
    isStarted: () => mcp.isStarted(),
  };
}
