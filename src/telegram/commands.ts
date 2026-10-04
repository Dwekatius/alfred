/**
 * Deterministic command parsing. Commands are handled by the supervisor,
 * never passed to the model as plain task text.
 */
export type ParsedCommand =
  | { type: "help" }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "stop_all" }
  | { type: "queue" }
  | { type: "cancel"; jobId: string }
  | { type: "run_next" }
  | { type: "screenshot"; scope: "desktop" | "window" }
  | { type: "new" }
  | { type: "model_show" }
  | { type: "model_select"; slot: string; modelId?: string }
  | { type: "provider"; value: string }
  | { type: "thinking"; level: string }
  | { type: "tell"; instruction: string }
  | { type: "approve"; approvalId: string }
  | { type: "reject"; approvalId: string }
  | { type: "start"; code?: string }
  | { type: "task"; text: string }
  | { type: "unknown_command"; command: string };

function stripBotMention(command: string): string {
  const at = command.indexOf("@");
  return at >= 0 ? command.slice(0, at) : command;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/u);
}

export function parseCommandText(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { type: "task", text: trimmed };
  const [firstToken = "", ...rest] = tokenize(trimmed);
  const command = stripBotMention(firstToken).toLowerCase();
  const restText = rest.join(" ").trim();
  switch (command) {
    case "/help":
      return { type: "help" };
    case "/status":
      return { type: "status" };
    case "/pause":
      return { type: "pause" };
    case "/resume":
      return { type: "resume" };
    case "/stop":
      return rest[0]?.toLowerCase() === "all" ? { type: "stop_all" } : { type: "stop" };
    case "/queue":
      return { type: "queue" };
    case "/cancel":
      return { type: "cancel", jobId: restText || "" };
    case "/run-next":
      return { type: "run_next" };
    case "/screenshot":
      return rest[0]?.toLowerCase() === "window" ? { type: "screenshot", scope: "window" } : { type: "screenshot", scope: "desktop" };
    case "/new":
      return { type: "new" };
    case "/model": {
      const slot = rest[0]?.toLowerCase();
      if (!slot) return { type: "model_show" };
      // Slots are simple lowercase names; /model <slot> [<model-id>] selects or configures one.
      if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(slot)) {
        return { type: "model_select", slot, modelId: rest.slice(1).join(" ") || undefined };
      }
      return { type: "model_show" };
    }
    case "/provider": {
      return { type: "provider", value: restText };
    }
    case "/thinking": {
      return { type: "thinking", level: restText.toLowerCase() };
    }
    case "/tell": {
      return { type: "tell", instruction: restText };
    }
    case "/approve": {
      return { type: "approve", approvalId: restText };
    }
    case "/reject": {
      return { type: "reject", approvalId: restText };
    }
    case "/start": {
      return { type: "start", code: rest[0] };
    }
    default:
      return { type: "unknown_command", command };
  }
}

export type CallbackAction =
  | { type: "approval"; approvalId: string; decision: "approve" | "reject" }
  | { type: "start_job"; jobId: string }
  | { type: "discard_job"; jobId: string }
  | { type: "resume_job"; jobId: string }
  | { type: "invalid" };

/** Callback data is intentionally tiny (<= 64 bytes, Telegram limit). */
export function parseCallbackData(data: string | undefined): CallbackAction {
  if (!data) return { type: "invalid" };
  const [prefix, id, extra] = data.split(":");
  switch (prefix) {
    case "ap":
      if (!id || (extra !== "a" && extra !== "r")) return { type: "invalid" };
      return { type: "approval", approvalId: id, decision: extra === "a" ? "approve" : "reject" };
    case "sj":
      if (!id) return { type: "invalid" };
      return { type: "start_job", jobId: id };
    case "dj":
      if (!id) return { type: "invalid" };
      return { type: "discard_job", jobId: id };
    case "rj":
      if (!id) return { type: "invalid" };
      return { type: "resume_job", jobId: id };
    default:
      return { type: "invalid" };
  }
}

export function buildHelpText(): string {
  return [
    "Alfred commands:",
    "/status - current job, model, queue, desktop availability",
    "/pause and /resume - stop/continue new side effects",
    "/stop - cancel the active job and suspend dispatch",
    "/stop all - cancel active and queued jobs",
    "/queue - list queued jobs",
    "/cancel <job-id> - cancel one queued job",
    "/run-next - start the next valid queued task",
    "/screenshot [window] - capture the desktop or focused window",
    "/new - start a new conversation when idle",
    "/model - show model slots; /model deepseek; /model openrouter <model-id>",
    "/provider <slug|auto> - OpenRouter inference provider routing",
    "/thinking <level> - set the model thinking level",
    "/tell <instruction> - steer the active job",
    "",
    "Desktop tasks need an unlocked, signed-in session. UAC/elevated windows cannot be automated. The agent pauses when the PC is locked.",
  ].join("\n");
}

export function buildModelHelpText(
  selectedSlot: string,
  slots: Record<string, { provider: string; modelId: string; label?: string; thinking?: string; routing?: { only?: string[]; allow_fallbacks?: boolean } }>,
  thinking: string,
): string {
  const lines = [`Active model slot: ${selectedSlot} (thinking: ${thinking})`, "", "Configured slots:"];
  for (const [name, slot] of Object.entries(slots)) {
    const routing = slot.routing?.only?.length ? ` · provider only=${slot.routing.only.join(",")}${slot.routing.allow_fallbacks === false ? ", fallbacks off" : ""}` : "";
    const marker = name === selectedSlot ? "*" : " ";
    lines.push(`${marker} ${name}: ${slot.provider}/${slot.modelId}${slot.label ? ` (${slot.label})` : ""}${routing}`);
  }
  lines.push("", "Switch/add: /model <slot> [model-id]   e.g. /model deepseek, /model zai glm-5.3-flash");
  lines.push("OpenRouter routing: /provider <slug> | /provider auto", "Thinking: /thinking <level>");
  lines.push("Add or remove slots, keys, and local models in the desktop UI → Setup guide.");
  return lines.join("\n");
}
