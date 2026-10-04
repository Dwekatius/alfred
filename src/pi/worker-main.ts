/**
 * Disposable Pi worker process.
 *
 * Runs exactly one job with an explicit, remote-only SDK configuration:
 * - explicit auth/models/stores paths (never Zed's defaults)
 * - custom broker tools only; built-in read/bash/edit/write tools disabled
 * - controlled system prompt; no automatic extensions/skills/context files
 * - structured events and tool requests over Node IPC
 */
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { Value } from "typebox/value";
import { buildSystemPrompt } from "./prompt.js";
import { productionToolNames, toolSpecByName, TOOL_SPECS } from "./tool-definitions.js";
import { IPC_PROTOCOL_VERSION, parseSupervisorMessage, type SettledMessage, type StartJobMessage, type SteerMessage, type ToolResultMessage } from "../ipc.js";

const jobContext = { jobId: "", leaseGeneration: 0 };
let requestCounter = 0;
const pendingToolRequests = new Map<string, { resolve: (message: ToolResultMessage) => void; reject: (error: Error) => void }>();

function send(message: Record<string, unknown>): void {
  if (!process.send) return;
  try {
    process.send({ protocolVersion: IPC_PROTOCOL_VERSION, jobId: jobContext.jobId, leaseGeneration: jobContext.leaseGeneration, requestId: `w-${++requestCounter}`, ...message });
  } catch {
    /* channel closed */
  }
}

function fatal(message: string): never {
  send({ type: "fatal", message });
  setTimeout(() => process.exit(1), 50);
  throw new Error(message);
}

function buildResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

function buildTools(enabledNames: string[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const name of enabledNames) {
    const spec = toolSpecByName(name);
    if (!spec) continue;
    tools.push({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      promptSnippet: spec.promptSnippet,
      executionMode: spec.sequential ? "sequential" : "parallel",
      execute: async (toolCallId, params) => {
        const requestId = `w-${++requestCounter}`;
        const reply = await new Promise<ToolResultMessage>((resolve, reject) => {
          pendingToolRequests.set(requestId, { resolve, reject });
          if (!process.send) {
            pendingToolRequests.delete(requestId);
            reject(new Error("IPC channel is not available"));
            return;
          }
          process.send({
            protocolVersion: IPC_PROTOCOL_VERSION,
            type: "tool_request",
            jobId: jobContext.jobId,
            leaseGeneration: jobContext.leaseGeneration,
            requestId,
            toolCallId,
            toolName: spec.name,
            args: params,
          });
        });
        if (!reply.ok || !reply.result) {
          const error = reply.error ?? { code: "INTERNAL_ERROR", message: "Unknown broker error", retryable: false, actionOutcome: "not_started" };
          throw new Error(`${error.code}: ${error.message} (retryable=${error.retryable}, outcome=${error.actionOutcome})`);
        }
        return { content: reply.result.content, details: reply.result.details ?? {} };
      },
    });
  }
  return tools;
}

async function runJob(start: StartJobMessage): Promise<void> {
  jobContext.jobId = start.jobId;
  jobContext.leaseGeneration = start.leaseGeneration;

  const runtime = await ModelRuntime.create({
    authPath: start.authPath,
    modelsPath: start.modelsPath,
    modelsStorePath: start.modelsStorePath,
    allowModelNetwork: false,
  });
  // Provider keys stored with DPAPI by the setup wizard. Applied in memory only.
  for (const entry of start.apiKeys ?? []) {
    try {
      await runtime.setRuntimeApiKey(entry.provider, entry.key);
    } catch (error) {
      fatal(`MODEL_UNAVAILABLE: could not apply the ${entry.provider} API key: ${(error as Error).message}`);
    }
  }
  const model = runtime.getModel(start.model.provider, start.model.modelId);
  if (!model) fatal(`MODEL_UNAVAILABLE: ${start.model.provider}/${start.model.modelId} was not found in the remote model configuration.`);
  if (!runtime.hasConfiguredAuth(start.model.provider)) fatal(`MODEL_UNAVAILABLE: no credentials configured for provider ${start.model.provider}.`);
  if (!model.input.includes("image") && start.images.length > 0) {
    // The broker also has fake tools; a text-only model would fail on images.
    fatal(`VISION_UNSUPPORTED: ${model.provider}/${model.id} does not accept image input but the job includes images.`);
  }
  if (!model.reasoning && start.model.thinking !== "off") {
    // Thinking level will be clamped by the SDK; not fatal.
    send({ type: "progress", kind: "state", summary: `model does not declare reasoning; thinking clamped from ${start.model.thinking}` });
  }

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 2 },
  });

  const enabledNames = process.env.PI_TG_ENABLE_FAKE_TOOLS === "1" ? [...productionToolNames(), "fake_echo", "fake_image"] : productionToolNames();
  const tools = buildTools(enabledNames);
  const systemPrompt = buildSystemPrompt({ workRoot: start.workRoot, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC" });
  const resourceLoader = buildResourceLoader(systemPrompt);

  const sessionManager = start.sessionFile && existsSync(start.sessionFile)
    ? SessionManager.open(start.sessionFile, start.sessionDir, start.workRoot)
    : SessionManager.create(start.workRoot, start.sessionDir);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: start.workRoot,
    agentDir: start.modelsPath.replace(/[\\/][^\\/]+$/, ""),
    modelRuntime: runtime,
    model,
    thinkingLevel: start.model.thinking,
    settingsManager,
    resourceLoader,
    sessionManager,
    customTools: tools,
    tools: enabledNames,
    noTools: "builtin",
  });

  if (modelFallbackMessage) {
    session.dispose();
    fatal(`MODEL_UNAVAILABLE: the SDK reported a model fallback: ${modelFallbackMessage}`);
  }
  const effectiveModel = session.model;
  if (!effectiveModel || effectiveModel.provider !== start.model.provider || effectiveModel.id !== start.model.modelId) {
    session.dispose();
    fatal(`MODEL_UNAVAILABLE: resolved model mismatch (wanted ${start.model.provider}/${start.model.modelId}, got ${effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : "none"}).`);
  }
  const activeTools = [...session.getActiveToolNames()].sort();
  const expected = [...enabledNames].sort();
  if (JSON.stringify(activeTools) !== JSON.stringify(expected)) {
    session.dispose();
    fatal(`TOOLS_UNSUPPORTED: active tool mismatch (expected ${expected.join(",")}, got ${activeTools.join(",")}).`);
  }

  let modelTurns = 0;
  let toolCalls = 0;
  let responseStartedAt = 0;
  let firstDeltaAt = 0;
  let lastDeltaAt = 0;
  let settled = false;
  let settledResolve: () => void = () => undefined;
  const settledPromise = new Promise<void>((resolve) => {
    settledResolve = resolve;
  });

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_start": {
        if ((event.message as { role?: string }).role === "assistant") {
          responseStartedAt = Date.now();
          firstDeltaAt = 0;
          lastDeltaAt = 0;
        }
        return;
      }
      case "message_update": {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "start") {
          if (responseStartedAt === 0) responseStartedAt = Date.now();
        } else if (streamEvent.type === "thinking_delta" && streamEvent.delta) {
          if (firstDeltaAt === 0) firstDeltaAt = Date.now();
          lastDeltaAt = Date.now();
          send({ type: "stream", streamKind: "thinking", text: streamEvent.delta });
        } else if (streamEvent.type === "thinking_end") {
          send({ type: "stream", streamKind: "thinking_end", text: "" });
        } else if (streamEvent.type === "text_delta" && streamEvent.delta) {
          if (firstDeltaAt === 0) firstDeltaAt = Date.now();
          lastDeltaAt = Date.now();
          send({ type: "stream", streamKind: "answer", text: streamEvent.delta });
        } else if (streamEvent.type === "text_end") {
          send({ type: "stream", streamKind: "answer_end", text: "" });
        }
        return;
      }
      case "message_end": {
        const message = event.message as {
          role?: string;
          provider?: string;
          model?: string;
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } };
        };
        if (message.role === "assistant") {
          modelTurns += 1;
          send({ type: "usage", modelTurns, toolCalls });
          const usage = message.usage;
          if (usage) {
            const finishedAt = Date.now();
            const durationMs = responseStartedAt > 0 ? finishedAt - responseStartedAt : undefined;
            const ttftMs = responseStartedAt > 0 && firstDeltaAt > 0 ? firstDeltaAt - responseStartedAt : undefined;
            const streamMs = firstDeltaAt > 0 && lastDeltaAt > firstDeltaAt ? lastDeltaAt - firstDeltaAt : undefined;
            responseStartedAt = 0;
            firstDeltaAt = 0;
            lastDeltaAt = 0;
            send({
              type: "model_usage",
              provider: message.provider ?? start.model.provider,
              model: message.model ?? start.model.modelId,
              inputTokens: usage.input ?? 0,
              outputTokens: usage.output ?? 0,
              cacheReadTokens: usage.cacheRead ?? 0,
              cacheWriteTokens: usage.cacheWrite ?? 0,
              reasoningTokens: usage.reasoning ?? 0,
              costUsd: usage.cost?.total ?? 0,
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(ttftMs !== undefined ? { ttftMs } : {}),
              ...(streamMs !== undefined ? { streamMs } : {}),
            });
          }
        }
        return;
      }
      case "tool_execution_start":
        toolCalls += 1;
        send({ type: "progress", kind: "tool_start", toolName: event.toolName, summary: `running ${event.toolName}` });
        return;
      case "tool_execution_end":
        send({ type: "progress", kind: "tool_end", toolName: event.toolName, summary: `${event.toolName} ${event.isError ? "failed" : "completed"}` });
        return;
      case "auto_retry_start":
        send({ type: "progress", kind: "state", summary: `model request retry ${event.attempt}/${event.maxAttempts}` });
        return;
      case "compaction_start":
        send({ type: "progress", kind: "state", summary: `compacting context (${event.reason})` });
        return;
      case "agent_settled":
        settled = true;
        settledResolve();
        return;
      default:
        return;
    }
  });

  send({
    type: "session_mapped",
    sessionFile: session.sessionFile ?? null,
    effectiveModel: { provider: effectiveModel.provider, modelId: effectiveModel.id, thinking: session.thinkingLevel },
    activeTools,
  });

  process.on("message", (raw: unknown) => {
    const message = parseSupervisorMessage(raw);
    if (!message || message.jobId !== jobContext.jobId) return;
    if (message.type === "tool_result") {
      const pending = pendingToolRequests.get(message.requestId);
      if (pending) {
        pendingToolRequests.delete(message.requestId);
        pending.resolve(message);
      }
      return;
    }
    if (message.type === "steer") {
      void handleSteer(session, message);
      return;
    }
    if (message.type === "abort") {
      void session.abort().catch(() => undefined);
      return;
    }
  });

  const images = start.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
  try {
    await session.prompt(start.taskText, { images, expandPromptTemplates: false, source: "rpc" });
  } catch (error) {
    // Aborts and provider failures surface here; still report the partial transcript.
    send({ type: "progress", kind: "state", summary: `prompt ended: ${(error as Error).message.slice(0, 160)}` });
  }

  await Promise.race([settledPromise, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  await session.waitForIdle().catch(() => undefined);
  const resultText = session.getLastAssistantText() ?? "";
  const settledMessage: SettledMessage = {
    protocolVersion: IPC_PROTOCOL_VERSION,
    type: "settled",
    jobId: jobContext.jobId,
    leaseGeneration: jobContext.leaseGeneration,
    requestId: `w-${++requestCounter}`,
    resultText,
  };
  if (process.send) process.send(settledMessage);
  unsubscribe();
  session.dispose();
  // Give the parent a moment to receive the settled message before exiting.
  setTimeout(() => process.exit(0), 100);
}

async function handleSteer(session: Awaited<ReturnType<typeof createAgentSession>>["session"], message: SteerMessage): Promise<void> {
  try {
    if (session.isStreaming) {
      await session.steer(message.text, undefined, { source: "rpc" });
    } else {
      await session.followUp(message.text, undefined, { source: "rpc" });
    }
    send({ type: "progress", kind: "state", summary: "steering instruction queued" });
  } catch (error) {
    send({ type: "progress", kind: "state", summary: `steering failed: ${(error as Error).message.slice(0, 160)}` });
  }
}

async function main(): Promise<void> {
  const startPromise = new Promise<StartJobMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("start_job was not received within 30 seconds")), 30000);
    process.on("message", (raw: unknown) => {
      const message = parseSupervisorMessage(raw);
      if (!message) return;
      if (message.type === "start_job") {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });

  const start = await startPromise;
  await runJob(start);
}

process.on("disconnect", () => process.exit(0));
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("MODEL_UNAVAILABLE") || message.startsWith("VISION_UNSUPPORTED") || message.startsWith("TOOLS_UNSUPPORTED")) {
    fatal(message);
  }
  fatal(`INTERNAL_ERROR: ${message}`);
});
