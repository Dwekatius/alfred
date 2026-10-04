/**
 * Filesystem tools. All paths must be absolute. The controller's private state
 * (config, secrets, database, sessions) is protected from model edits.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { AppConfig, DataPaths } from "../config.js";
import { Logger } from "../logging.js";
import { AgentToolError } from "./errors.js";
import type { ToolBroker } from "./broker.js";

const MAX_TEXT_BYTES = 200 * 1024;

interface FileToolDeps {
  config: AppConfig;
  paths: DataPaths;
  logger: Logger;
}

function isInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent.endsWith(sep) ? normalizedParent : normalizedParent + sep);
}

export function resolveSafePath(input: string, deps: FileToolDeps, mode: "read" | "write"): string {
  if (!isAbsolute(input)) throw new AgentToolError({ code: "VALIDATION_ERROR", message: `Path must be absolute: ${input}`, retryable: false, actionOutcome: "not_started" });
  const resolved = resolve(input);
  const protectedRoots = [deps.paths.dataRoot, resolve(deps.config.models.authPath, "..")];
  for (const root of protectedRoots) {
    if (isInside(resolved, root)) {
      throw new AgentToolError({ code: "POLICY_BLOCKED", message: `Path is inside protected agent state: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    }
  }
  if (mode === "write") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    for (const forbidden of [systemRoot, programFiles, programFilesX86]) {
      if (resolved.toLowerCase() === forbidden.toLowerCase() || isInside(resolved, forbidden)) {
        throw new AgentToolError({ code: "POLICY_BLOCKED", message: `Refusing to write inside ${forbidden} without explicit administrative tooling.`, retryable: false, actionOutcome: "not_started" });
      }
    }
  }
  return resolved;
}

function textResult(text: string, details: Record<string, unknown> = {}): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details };
}

export function installFileTools(broker: ToolBroker, deps: FileToolDeps): void {
  broker.registerHandler("system_read", async (args) => {
    const { path, offset, limit } = args as { path: string; offset?: number; limit?: number };
    const resolved = resolveSafePath(path, deps, "read");
    if (!existsSync(resolved)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `File not found: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    const stat = statSync(resolved);
    if (stat.isDirectory()) throw new AgentToolError({ code: "VALIDATION_ERROR", message: `Path is a directory: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    const raw = readFileSync(resolved);
    const slice = raw.subarray(0, Math.min(raw.byteLength, MAX_TEXT_BYTES));
    const text = slice.toString("utf8");
    const lines = text.split(/\r?\n/u);
    const start = offset ?? 0;
    const end = limit ? start + limit : lines.length;
    const selected = lines.slice(start, end);
    const truncated = raw.byteLength > MAX_TEXT_BYTES || end < lines.length;
    return textResult(
      `File: ${resolved}\nLines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}${truncated ? " (truncated)" : ""}\n\n${selected.map((line, index) => `${start + index + 1}\t${line}`).join("\n")}`,
      { path: resolved, totalLines: lines.length, truncated },
    );
  });

  broker.registerHandler("system_list", async (args) => {
    const { path, pattern } = args as { path: string; pattern?: string };
    const resolved = resolveSafePath(path, deps, "read");
    if (!existsSync(resolved)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Directory not found: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    const entries = readdirSync(resolved, { withFileTypes: true });
    const filtered = pattern ? entries.filter((entry) => entry.name.includes(pattern)) : entries;
    const lines = filtered
      .slice(0, 500)
      .map((entry) => {
        if (entry.isDirectory()) return `[dir]  ${entry.name}`;
        try {
          const stat = statSync(join(resolved, entry.name));
          return `[file] ${entry.name} (${stat.size} bytes)`;
        } catch {
          return `[file] ${entry.name}`;
        }
      });
    return textResult(`Directory: ${resolved}\nEntries: ${filtered.length}${filtered.length > 500 ? " (showing first 500)" : ""}\n\n${lines.join("\n")}`, { path: resolved, count: filtered.length });
  });

  broker.registerHandler("system_write", async (args) => {
    const { path, content, encoding, overwrite } = args as { path: string; content: string; encoding?: "utf8" | "utf16le"; overwrite?: boolean };
    const resolved = resolveSafePath(path, deps, "write");
    if (existsSync(resolved) && !overwrite) throw new AgentToolError({ code: "POLICY_BLOCKED", message: `File exists; pass overwrite=true to replace: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    mkdirSync(resolve(resolved, ".."), { recursive: true });
    const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, content, { encoding: encoding ?? "utf8" });
      renameSync(tmp, resolved);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw new AgentToolError({ code: "INTERNAL_ERROR", message: `Write failed: ${(error as Error).message}`, retryable: false, actionOutcome: "not_started" });
    }
    deps.logger.info("files.written", "File written", { eventCode: "FILE_WRITTEN", path: resolved, sizeBytes: Buffer.byteLength(content) });
    return textResult(`Wrote ${resolved} (${Buffer.byteLength(content)} bytes).`, { path: resolved });
  });

  broker.registerHandler("system_edit", async (args) => {
    const { path, oldText, newText, replaceAll } = args as { path: string; oldText: string; newText: string; replaceAll?: boolean };
    const resolved = resolveSafePath(path, deps, "write");
    if (!existsSync(resolved)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `File not found: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    const original = readFileSync(resolved, "utf8");
    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `The exact text was not found in ${resolved}.`, retryable: false, actionOutcome: "not_started" });
    if (occurrences > 1 && !replaceAll) throw new AgentToolError({ code: "VALIDATION_ERROR", message: `The text occurs ${occurrences} times; pass replaceAll=true or provide more context.`, retryable: false, actionOutcome: "not_started" });
    const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
    const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, updated, "utf8");
      renameSync(tmp, resolved);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw new AgentToolError({ code: "INTERNAL_ERROR", message: `Edit failed: ${(error as Error).message}`, retryable: false, actionOutcome: "not_started" });
    }
    return textResult(`Edited ${resolved} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`, { path: resolved, replacements: occurrences });
  });

  broker.registerHandler("system_move", async (args) => {
    const { source, target, overwrite } = args as { source: string; target: string; overwrite?: boolean };
    const from = resolveSafePath(source, deps, "write");
    const to = resolveSafePath(target, deps, "write");
    if (!existsSync(from)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Source not found: ${from}`, retryable: false, actionOutcome: "not_started" });
    if (existsSync(to) && !overwrite) throw new AgentToolError({ code: "POLICY_BLOCKED", message: `Target exists; pass overwrite=true: ${to}`, retryable: false, actionOutcome: "not_started" });
    mkdirSync(resolve(to, ".."), { recursive: true });
    renameSync(from, to);
    return textResult(`Moved ${from} -> ${to}`, { source: from, target: to });
  });

  broker.registerHandler("system_copy", async (args) => {
    const { source, target, overwrite } = args as { source: string; target: string; overwrite?: boolean };
    const from = resolveSafePath(source, deps, "read");
    const to = resolveSafePath(target, deps, "write");
    if (!existsSync(from)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Source not found: ${from}`, retryable: false, actionOutcome: "not_started" });
    if (existsSync(to) && !overwrite) throw new AgentToolError({ code: "POLICY_BLOCKED", message: `Target exists; pass overwrite=true: ${to}`, retryable: false, actionOutcome: "not_started" });
    mkdirSync(resolve(to, ".."), { recursive: true });
    copyFileSync(from, to);
    return textResult(`Copied ${from} -> ${to}`, { source: from, target: to });
  });

  broker.registerHandler("system_delete", async (args, context) => {
    const { path, recursive, useRecycleBin } = args as { path: string; recursive?: boolean; useRecycleBin?: boolean };
    const resolved = resolveSafePath(path, deps, "write");
    if (!existsSync(resolved)) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Path not found: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    const stat = statSync(resolved);
    if (stat.isDirectory() && !recursive) throw new AgentToolError({ code: "VALIDATION_ERROR", message: `Path is a directory; pass recursive=true to delete: ${resolved}`, retryable: false, actionOutcome: "not_started" });
    // Deleting a whole tree is treated as materially irreversible; require approval unless inside workRoot.
    if (stat.isDirectory()) {
      const insideWorkRoot = isInside(resolved, deps.paths.workRoot);
      if (!insideWorkRoot) {
        await context.requireApproval({
          actionType: "system_delete_recursive",
          preview: `Delete directory and all contents:\n${resolved}`,
          payload: { path: resolved, recursive: true },
        });
      }
    }
    if (useRecycleBin !== false) {
      const ok = await moveToRecycleBin(resolved);
      if (ok) return textResult(`Moved to recycle bin: ${resolved}`, { path: resolved, recyclable: true });
    }
    rmSync(resolved, { recursive: Boolean(recursive), force: true });
    deps.logger.warn("files.deleted", "Deleted path permanently", { eventCode: "FILE_DELETED", path: resolved });
    return textResult(`Deleted: ${resolved}`, { path: resolved, recyclable: false });
  });
}

/** Use the Windows Shell to move a file/directory to the recycle bin via PowerShell. */
async function moveToRecycleBin(path: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
  const dirScript = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${path.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
  const command = path.endsWith("\\") || path.endsWith("/") ? dirScript : `if (Test-Path -LiteralPath '${path.replace(/'/g, "''")}' -PathType Container) { ${dirScript} } else { ${script} }`;
  return await new Promise<boolean>((resolvePromise) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(false);
    }, 15000);
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0);
    });
  });
}
