/**
 * Browser tool handlers over the pinned Playwright MCP backend.
 *
 * The manipulated tab is the visible Chrome window. DOM actions do not move the
 * physical cursor; the action-only overlay from browser/init-page.cjs shows the
 * interaction. Coordinate actions are page-viewport coordinates, never desktop
 * coordinates.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { AppConfig, DataPaths } from "../config.js";
import { Logger } from "../logging.js";
import { AgentToolError } from "./errors.js";
import type { BrokerContext, ToolBroker } from "./broker.js";
import type { DesktopLease } from "./desktop-lease.js";
import type { BrowserBackend } from "./browser-mcp.js";
import type { WindowsBackend } from "./windows-mcp.js";
import type { McpContentBlock } from "./mcp-client.js";
import type { ArtifactRegistry } from "../artifacts/registry.js";
import { resolveSafePath } from "./files.js";
import { inlineBrowserSnapshot } from "./browser-snapshot.js";
import { projectRoot } from "./windows-mcp.js";

export interface BrowserToolDeps {
  browser: BrowserBackend;
  windows: WindowsBackend;
  lease: DesktopLease;
  logger: Logger;
  config: AppConfig;
  paths: DataPaths;
  artifacts: ArtifactRegistry;
}

const TEXT_LIMIT = 60000;

export function installBrowserTools(broker: ToolBroker, deps: BrowserToolDeps): void {
  const browser = deps.browser;
  const foregroundAttempted = new Set<string>();

  const call = async (tool: string, args: Record<string, unknown>, context: BrokerContext, timeoutMs = 60000) => {
    context.assertLease();
    try {
      const result = await browser.call(tool, args, { signal: context.signal, timeoutMs });
      if (result.isError) {
        const text = textOf(result.content) || `Browser tool ${tool} failed.`;
        if (/browser.*(closed|disconnected)|Target (page|closed)|Protocol error/i.test(text)) {
          throw new AgentToolError({ code: "BROWSER_DISCONNECTED", message: text.slice(0, 300), retryable: true, actionOutcome: "not_started" });
        }
        throw new AgentToolError({ code: "BACKEND_ERROR", message: text.slice(0, 300), retryable: true, actionOutcome: "not_started" });
      }
      return result;
    } catch (error) {
      if (error instanceof AgentToolError) throw error;
      const message = (error as Error).message;
      if (/browser.*(closed|disconnected)|Target (page|closed)|Protocol error|ECONNREFUSED/i.test(message)) {
        throw new AgentToolError({ code: "BROWSER_DISCONNECTED", message: message.slice(0, 300), retryable: true, actionOutcome: "not_started" });
      }
      if (/user data directory is already in use|ProcessSingleton|profile.*lock/i.test(message)) {
        throw new AgentToolError({ code: "PROFILE_IN_USE", message: "The dedicated Chrome profile is in use by another process. Close that instance; the agent will not delete profile locks.", retryable: true, actionOutcome: "not_started" });
      }
      throw new AgentToolError({ code: "BACKEND_ERROR", message: message.slice(0, 300), retryable: true, actionOutcome: "not_started" });
    }
  };

  const ensureVisible = async (context: BrokerContext): Promise<void> => {
    if (foregroundAttempted.has(context.jobId)) return;
    foregroundAttempted.add(context.jobId);
    try {
      const foreground = await deps.windows.helper.foregroundWindow();
      if (foreground.title && /chrome/i.test(foreground.title)) return;
      await deps.windows.mcp.callTool("App", { mode: "switch", name: "Chrome" }, { signal: context.signal, timeoutMs: 15000 });
    } catch {
      // Non-fatal: visibility is best effort; DOM actions still work.
      deps.logger.debug("browser.foreground_failed", "Could not bring Chrome to the foreground.", { eventCode: "BROWSER_FOREGROUND" });
    }
  };

  const textResult = (text: string, details: Record<string, unknown> = {}) => {
    const snapshot = inlineBrowserSnapshot(text, deps.config.browser.outputDir, projectRoot());
    return { content: [{ type: "text" as const, text: snapshot.text.slice(0, TEXT_LIMIT) }], details: { ...details, ...(snapshot.expanded ? { hasSnapshot: true } : {}) } };
  };

  broker.registerHandler("browser_navigate", async (args, context) => {
    await ensureVisible(context);
    const result = await call("browser_navigate", args as Record<string, unknown>, context, 90000);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_navigate_back", async (_args, context) => {
    await ensureVisible(context);
    const result = await call("browser_navigate_back", {}, context, 60000);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_snapshot", async (args, context) => {
    const result = await call("browser_snapshot", args as Record<string, unknown>, context);
    const image = imageOf(result.content);
    if (image) {
      const artifact = registerImage(context, deps.artifacts, image, "browser-snapshot.png");
      return { content: [{ type: "text", text: textOf(result.content) }, { type: "image", data: image.data, mimeType: image.mimeType }], details: { artifactId: artifact.id } };
    }
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_click", async (args, context) => {
    const result = await call("browser_click", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_type", async (args, context) => {
    const result = await call("browser_type", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_fill_form", async (args, context) => {
    const result = await call("browser_fill_form", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_press_key", async (args, context) => {
    const result = await call("browser_press_key", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_hover", async (args, context) => {
    const result = await call("browser_hover", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_select_option", async (args, context) => {
    const result = await call("browser_select_option", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_drag", async (args, context) => {
    const result = await call("browser_drag", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_take_screenshot", async (args, context) => {
    await ensureVisible(context);
    const parsed = args as { filename?: string; type?: "png" | "jpeg" };
    // Playwright resolves explicit relative names against its workspace, whereas
    // unnamed captures go to outputDir. Keep both forms in our artifact directory.
    const captureArgs = { ...args as Record<string, unknown> };
    let filename = parsed.filename ? basename(parsed.filename) : undefined;
    if (filename) {
      if (filename === "." || filename === "..") throw new AgentToolError({ code: "VALIDATION_ERROR", message: "A screenshot filename must name an image file.", retryable: false, actionOutcome: "not_started" });
      if (!/\.(png|jpe?g|webp)$/i.test(filename)) filename += parsed.type === "jpeg" ? ".jpg" : ".png";
      captureArgs.filename = join(deps.config.browser.outputDir, filename);
    }
    const result = await call("browser_take_screenshot", captureArgs, context, 90000);
    const image = imageOf(result.content);
    if (image) {
      const artifact = registerImage(context, deps.artifacts, image, (args as { filename?: string }).filename ?? "page-screenshot.png");
      return {
        content: [{ type: "text", text: `${textOf(result.content)}\nartifact: ${artifact.id}` }, { type: "image", data: image.data, mimeType: image.mimeType }],
        details: { artifactId: artifact.id },
      };
    }
    const saved = registerNewestOutputFile(context, deps, filename ?? "page-screenshot.png", "screenshot", Boolean(filename), parsed.type ? `image/${parsed.type}` : undefined);
    const bytes = saved ? await deps.artifacts.readBytes(saved.id) : undefined;
    if (!saved || !bytes) throw new AgentToolError({ code: "ARTIFACT_NOT_FOUND", message: "The browser did not produce a usable screenshot image.", retryable: true, actionOutcome: "not_started" });
    return { content: [{ type: "text", text: `${textOf(result.content)}\nartifact: ${saved.id}` }, { type: "image", data: bytes.bytes.toString("base64"), mimeType: bytes.mime }], details: { artifactId: saved.id } };
  });

  broker.registerHandler("browser_tabs", async (args, context) => {
    await ensureVisible(context);
    const result = await call("browser_tabs", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_wait_for", async (args, context) => {
    const result = await call("browser_wait_for", args as Record<string, unknown>, context, 60000);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_handle_dialog", async (args, context) => {
    const result = await call("browser_handle_dialog", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_file_upload", async (args, context) => {
    const parsed = args as { paths?: string[] };
    for (const path of parsed.paths ?? []) {
      if (!existsSync(path)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Upload file not found: ${path}`, retryable: false, actionOutcome: "not_started" });
      // Same path policy as file tools: absolute, outside protected agent state.
      resolveSafePath(path, { config: deps.config, paths: deps.paths, logger: deps.logger }, "read");
    }
    const result = await call("browser_file_upload", parsed as Record<string, unknown>, context, 120000);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_console_messages", async (args, context) => {
    const result = await call("browser_console_messages", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_network_requests", async (args, context) => {
    const result = await call("browser_network_requests", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_network_request", async (args, context) => {
    const result = await call("browser_network_request", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_evaluate", async (args, context) => {
    context.repo.appendEvent(context.jobId, { eventType: "browser_evaluate", summary: `evaluate: ${String((args as { function?: string }).function ?? "").slice(0, 120)}` });
    const result = await call("browser_evaluate", args as Record<string, unknown>, context, 120000);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_pdf_save", async (args, context) => {
    const result = await call("browser_pdf_save", args as Record<string, unknown>, context, 120000);
    const saved = registerNewestOutputFile(context, deps, (args as { filename?: string }).filename ?? "page.pdf", "document");
    if (saved) return textResult(`${textOf(result.content)}\nartifact: ${saved.id}`, { artifactId: saved.id });
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_resize", async (args, context) => {
    const result = await call("browser_resize", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_find", async (args, context) => {
    const result = await call("browser_find", args as Record<string, unknown>, context);
    return textResult(textOf(result.content));
  });

  broker.registerHandler("browser_close", async (_args, context) => {
    const result = await call("browser_close", {}, context, 30000);
    return textResult(textOf(result.content));
  });
}

function textOf(content: McpContentBlock[]): string {
  return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n");
}

function imageOf(content: McpContentBlock[]): { data: string; mimeType: string } | undefined {
  const block = content.find((entry) => entry.type === "image" && typeof entry.data === "string");
  return block?.data ? { data: block.data as string, mimeType: block.mimeType ?? "image/png" } : undefined;
}

function registerImage(context: BrokerContext, artifacts: ArtifactRegistry, image: { data: string; mimeType: string }, filename: string) {
  return artifacts.register({ jobId: context.jobId, kind: "screenshot", mime: image.mimeType, filename, bytes: Buffer.from(image.data, "base64") });
}

function registerNewestOutputFile(context: BrokerContext, deps: BrowserToolDeps, filename: string, kind: "screenshot" | "document" = "screenshot", exact = false, mimeOverride?: string) {
  const outputDir = resolve(deps.config.browser.outputDir);
  if (!existsSync(outputDir)) return undefined;
  const candidates = readdirSync(outputDir)
    .map((name) => join(outputDir, name))
    .filter((path) => existsSync(path) && statSync(path).isFile() && (kind === "screenshot" ? /\.(png|jpe?g|webp)$/i.test(path) : /\.pdf$/i.test(path)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const target = candidates.find((path) => basename(path) === basename(filename)) ?? (exact ? undefined : candidates[0]);
  if (!target) return undefined;
  const resolved = resolve(target);
  if (!resolved.startsWith(outputDir + sep)) return undefined;
  const mime = mimeOverride ?? (resolved.toLowerCase().endsWith(".pdf") ? "application/pdf" : resolved.toLowerCase().endsWith(".jpg") || resolved.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : resolved.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png");
  try {
    return deps.artifacts.register({ jobId: context.jobId, kind, mime, filename: basename(resolved), sourcePath: resolved });
  } catch (error) {
    deps.logger.warn("browser.artifact_failed", "Could not register browser output file.", { eventCode: "BROWSER_ARTIFACT", message: (error as Error).message });
    return undefined;
  }
}
