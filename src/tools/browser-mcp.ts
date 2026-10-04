/**
 * Playwright MCP stdio backend with a dedicated, persistent, visible Chrome
 * profile. The supervisor owns the browser context across jobs.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppConfig, DataPaths } from "../config.js";
import { Logger } from "../logging.js";
import { McpStdioBackend, type McpCallResult, type McpToolInfo } from "./mcp-client.js";
import { projectRoot } from "./windows-mcp.js";

export interface BrowserBackend {
  ensureStarted(): Promise<void>;
  call(tool: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>;
  listTools(): McpToolInfo[];
  restart(): Promise<void>;
  dispose(): Promise<void>;
  isStarted(): boolean;
  mcp: McpStdioBackend;
}

export function CreateBrowserBackend(options: { config: AppConfig; paths: DataPaths; logger: Logger }): BrowserBackend {
  const cli = join(projectRoot(), "node_modules", "@playwright", "mcp", "cli.js");
  if (!existsSync(cli)) {
    options.logger.warn("browser.missing_cli", "Local @playwright/mcp CLI was not found; run npm ci before using browser tools.", { eventCode: "BROWSER_CLI_MISSING", path: cli });
  }
  const initPage = join(projectRoot(), "browser", "init-page.cjs");
  const args = [
    cli,
    "--browser",
    "chrome",
    "--user-data-dir",
    options.config.browser.profileDir,
    "--caps",
    "vision,pdf,devtools",
    "--output-dir",
    options.config.browser.outputDir,
    "--idle-timeout",
    "0",
  ];
  if (existsSync(initPage)) args.push("--init-page", initPage);
  if (options.config.browser.headed) {
    // Headed is the default; no --headless flag is passed anywhere.
  }
  const mcp = new McpStdioBackend({
    name: "playwright-mcp",
    command: process.execPath,
    args,
    cwd: projectRoot(),
    env: {
      ...(process.env as Record<string, string>),
      // Keep the dedicated profile separate from Zed's Playwright usage.
      PLAYWRIGHT_MCP_DISABLE_TELEMETRY: "1",
    },
    logger: options.logger,
    manifestPath: join(options.paths.manifestsDir, "playwright-mcp-tools.json"),
    defaultTimeoutMs: 60000,
  });
  return {
    mcp,
    ensureStarted: () => mcp.ensureStarted(),
    call: (tool, toolArgs, callOptions) => mcp.callTool(tool, toolArgs, callOptions),
    listTools: () => mcp.listTools(),
    restart: () => mcp.restart(),
    dispose: () => mcp.dispose(),
    isStarted: () => mcp.isStarted(),
  };
}

/** Absolute path helper for browser output-dir files. */
export function browserOutputPath(config: AppConfig, filename: string): string {
  return resolve(config.browser.outputDir, filename);
}
