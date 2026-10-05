/**
 * Versioned, validated IPC between the supervisor and the disposable Pi worker.
 *
 * All messages carry protocolVersion, jobId, leaseGeneration, requestId.
 * Arbitrary IPC data is never cast to trusted values: every message is
 * validated structurally here before use.
 */
export const IPC_PROTOCOL_VERSION = 1;

/** Process readiness is independent of job identity and grants no tool lease. */
export interface PoolReadyMessage {
  protocolVersion: number;
  type: "pool_ready";
  pid: number;
}

export function parsePoolReadyMessage(raw: unknown): PoolReadyMessage | undefined {
  if (!isRecord(raw) || raw.protocolVersion !== IPC_PROTOCOL_VERSION || raw.type !== "pool_ready" || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) return undefined;
  return raw as unknown as PoolReadyMessage;
}

export interface Envelope {
  protocolVersion: number;
  jobId: string;
  leaseGeneration: number;
  requestId: string;
}

export interface StartJobMessage extends Envelope {
  type: "start_job";
  taskText: string;
  workRoot: string;
  sessionDir: string;
  sessionFile: string | null;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  model: { provider: string; modelId: string; thinking: AppThinkingLevel };
  images: Array<{ data: string; mimeType: string }>;
  /** Provider keys decrypted by the supervisor; never written to disk by the worker. */
  apiKeys?: Array<{ provider: string; key: string }>;
  stripHistoricalToolImages?: boolean;
  limits: {
    maxToolCalls: number;
    maxModelTurns: number;
    maxRunSeconds: number;
  };
}

export type AppThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SteerMessage extends Envelope {
  type: "steer";
  text: string;
}

export interface AbortMessage extends Envelope {
  type: "abort";
  reason: string;
}

export interface ToolResultMessage extends Envelope {
  type: "tool_result";
  toolCallId: string;
  ok: boolean;
  result?: ToolResultPayload;
  error?: { code: string; message: string; retryable: boolean; actionOutcome: string; observationId?: string; artifactId?: string };
}

export interface ToolResultPayload {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: Record<string, unknown>;
}

export type SupervisorToWorkerMessage = StartJobMessage | SteerMessage | AbortMessage | ToolResultMessage;

export interface ReadyMessage extends Envelope {
  type: "ready";
  pid: number;
}

export interface SessionMappedMessage extends Envelope {
  type: "session_mapped";
  sessionFile: string | null;
  effectiveModel: { provider: string; modelId: string; thinking: string };
  activeTools: string[];
}

export interface ProgressMessage extends Envelope {
  type: "progress";
  kind: "text" | "tool_start" | "tool_end" | "state";
  toolName?: string;
  summary: string;
}

export type StreamKind = "thinking" | "thinking_end" | "answer" | "answer_end" | "tool" | "state" | "error" | "usage";

/** Streaming model output for the local dashboard only. Never sent to Telegram. */
export interface StreamMessage extends Envelope {
  type: "stream";
  streamKind: "thinking" | "answer";
  text: string;
}

/** Exact provider usage and cost for one assistant response. */
export interface ModelUsageMessage extends Envelope {
  type: "model_usage";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Wall-clock duration of this assistant response, for tokens-per-second. */
  durationMs?: number;
  /** Time from request start to the first streamed token. */
  ttftMs?: number;
  /** Time between the first and last streamed token (the decode window). */
  streamMs?: number;
  /** Request entry to response opening; includes provider setup/upload/queue. */
  responseOpenMs?: number;
  preparationMs?: number;
  /** SDK projection sizes, not HTTP wire sizes. */
  contextBytes?: number;
  imageCount?: number;
  imageBase64Bytes?: number;
}

export interface UsageMessage extends Envelope {
  type: "usage";
  modelTurns: number;
  toolCalls: number;
}

export interface SettledMessage extends Envelope {
  type: "settled";
  resultText: string;
}

export interface FatalMessage extends Envelope {
  type: "fatal";
  message: string;
}

export interface ToolRequestMessage extends Envelope {
  type: "tool_request";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type WorkerToSupervisorMessage =
  | ReadyMessage
  | SessionMappedMessage
  | ProgressMessage
  | StreamMessage
  | ModelUsageMessage
  | UsageMessage
  | SettledMessage
  | FatalMessage
  | ToolRequestMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & Envelope {
  return (
    value.protocolVersion === IPC_PROTOCOL_VERSION &&
    typeof value.jobId === "string" &&
    typeof value.leaseGeneration === "number" &&
    typeof value.requestId === "string" &&
    typeof value.type === "string"
  );
}

export function parseWorkerMessage(raw: unknown): WorkerToSupervisorMessage | undefined {
  if (!isRecord(raw) || !hasEnvelope(raw)) return undefined;
  switch (raw.type) {
    case "ready":
      return typeof raw.pid === "number" ? (raw as unknown as ReadyMessage) : undefined;
    case "session_mapped":
      return isRecord(raw.effectiveModel) ? (raw as unknown as SessionMappedMessage) : undefined;
    case "progress":
      return typeof raw.summary === "string" && typeof raw.kind === "string" ? (raw as unknown as ProgressMessage) : undefined;
    case "stream":
      return typeof raw.streamKind === "string" && typeof raw.text === "string" ? (raw as unknown as StreamMessage) : undefined;
    case "model_usage":
      return typeof raw.provider === "string" && typeof raw.model === "string" && typeof raw.inputTokens === "number" && typeof raw.outputTokens === "number"
        && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "costUsd", "durationMs", "ttftMs", "streamMs", "responseOpenMs", "preparationMs", "contextBytes", "imageCount", "imageBase64Bytes"].every((key) => raw[key] === undefined || (typeof raw[key] === "number" && Number.isFinite(raw[key]) && (raw[key] as number) >= 0))
        ? (raw as unknown as ModelUsageMessage)
        : undefined;
    case "usage":
      return typeof raw.modelTurns === "number" && typeof raw.toolCalls === "number" ? (raw as unknown as UsageMessage) : undefined;
    case "settled":
      return typeof raw.resultText === "string" ? (raw as unknown as SettledMessage) : undefined;
    case "fatal":
      return typeof raw.message === "string" ? (raw as unknown as FatalMessage) : undefined;
    case "tool_request":
      return typeof raw.toolCallId === "string" && typeof raw.toolName === "string" ? (raw as unknown as ToolRequestMessage) : undefined;
    default:
      return undefined;
  }
}

export function parseSupervisorMessage(raw: unknown): SupervisorToWorkerMessage | undefined {
  if (!isRecord(raw) || !hasEnvelope(raw)) return undefined;
  switch (raw.type) {
    case "start_job":
      if (typeof raw.taskText !== "string" || !isRecord(raw.model) || !Array.isArray(raw.images)) return undefined;
      return raw as unknown as StartJobMessage;
    case "steer":
      return typeof raw.text === "string" ? (raw as unknown as SteerMessage) : undefined;
    case "abort":
      return typeof raw.reason === "string" ? (raw as unknown as AbortMessage) : undefined;
    case "tool_result":
      return typeof raw.toolCallId === "string" && typeof raw.ok === "boolean" ? (raw as unknown as ToolResultMessage) : undefined;
    default:
      return undefined;
  }
}
