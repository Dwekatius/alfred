/**
 * Control intents are persisted as JSON in the controls table so they survive
 * a crash between Telegram receipt and application.
 */
import type { ParsedCommand } from "../telegram/commands.js";

export type ExecutableCommand = Exclude<ParsedCommand, { type: "task" } | { type: "unknown_command" }>;

export type StoredControl =
  | ExecutableCommand
  | { type: "approval"; approvalId: string; decision: "approve" | "reject" }
  | { type: "start_job"; jobId: string }
  | { type: "discard_job"; jobId: string }
  | { type: "resume_job"; jobId: string }
  | { type: "answer_question"; questionId: string; answer: string };

const HIGH_PRIORITY: ReadonlySet<string> = new Set([
  "stop",
  "stop_all",
  "pause",
  "resume",
  "screenshot",
  "run_next",
  "cancel",
  "approval",
  "start_job",
  "discard_job",
  "resume_job",
  "answer_question",
]);

export function isHighPriority(command: StoredControl): boolean {
  return HIGH_PRIORITY.has(command.type);
}

export function encodeControl(command: StoredControl): string {
  return JSON.stringify(command);
}

export function decodeControl(raw: string): StoredControl | undefined {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (!parsed || typeof parsed.type !== "string") return undefined;
    if (parsed.type === "task" || parsed.type === "unknown_command") return undefined;
    return parsed as StoredControl;
  } catch {
    return undefined;
  }
}
