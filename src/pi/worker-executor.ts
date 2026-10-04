/**
 * Supervisor-side worker manager: forks one disposable Pi worker per job,
 * relays validated tool requests to the broker, and enforces hard termination.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppConfig, DataPaths } from "../config.js";
import { Logger, redactString } from "../logging.js";
import { JobRepository, type JobRow } from "../jobs/repository.js";
import type { JobExecutor, JobOutcome } from "../jobs/scheduler.js";
import { parseWorkerMessage, IPC_PROTOCOL_VERSION, type ToolResultMessage, type StartJobMessage, type WorkerToSupervisorMessage, type ModelUsageMessage } from "../ipc.js";
import type { ToolBroker } from "../tools/broker.js";
import type { DesktopLease } from "../tools/desktop-lease.js";
import type { ArtifactRegistry } from "../artifacts/registry.js";
import { findCachedModel } from "./models.js";

export interface WorkerExecutorDeps {
  config: AppConfig;
  paths: DataPaths;
  logger: Logger;
  repo: JobRepository;
  broker: ToolBroker;
  lease: DesktopLease;
  artifacts: ArtifactRegistry;
  /** Optional inbound image loader (Phase 6). */
  loadImages?: (job: JobRow) => Promise<Array<{ data: string; mimeType: string }>>;
  /** Optional progress sink for owner notifications. */
  onProgress?: (jobId: string, summary: string) => void;
  /** Live stream for the local dashboard (thinking/answer/tool/state). */
  onStream?: (jobId: string, kind: "thinking" | "answer" | "tool" | "state" | "error", text: string) => void;
  /** Exact usage/cost of one assistant response. */
  onModelUsage?: (jobId: string, usage: ModelUsageMessage) => void;
  /** Decrypt provider API keys (DPAPI) so the worker can use them without auth.json. */
  resolveApiKeys?: () => Promise<Array<{ provider: string; key: string }>>;
}

interface WorkerHandle {
  jobId: string;
  leaseGeneration: number;
  child: ChildProcess;
  aborting: boolean;
  killed: boolean;
  lastModelTurns: number;
  settled: Promise<{ resultText: string }>;
}

export class WorkerExecutor implements JobExecutor {
  private readonly workers = new Map<string, WorkerHandle>();
  private counter = 0;

  constructor(private readonly deps: WorkerExecutorDeps) {}

  private workerMainPath(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "worker-main.js");
  }

  async execute(context: { job: JobRow; signal: AbortSignal; deadline: number }): Promise<JobOutcome> {
    const { job } = context;
    const { repo, broker, lease, logger } = this.deps;
    const current = repo.getJob(job.id);
    if (!current) return { state: "failed", errorCode: "INTERNAL_ERROR", errorMessage: "Job disappeared before start." };
    const leaseGeneration = current.lease_generation;
    lease.grant(job.id, leaseGeneration);

    const sessionFile = this.sessionFileFor(current);
    const slot = this.modelSnapshot(current);
    const metadata = findCachedModel(this.deps.paths, slot.provider, slot.modelId);

    const env = { ...process.env, PI_TG_WORKER: "1" };
    const child = fork(this.workerMainPath(), [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
      windowsHide: true,
      serialization: "json",
    });
    const handle: WorkerHandle = { jobId: job.id, leaseGeneration, child, aborting: false, killed: false, lastModelTurns: 0, settled: Promise.resolve({ resultText: "" }) };

    let settledResolve: (value: { resultText: string }) => void = () => undefined;
    let settledReject: (error: Error) => void = () => undefined;
    handle.settled = new Promise<{ resultText: string }>((resolve, reject) => {
      settledResolve = resolve;
      settledReject = reject;
    });

    child.stderr?.setEncoding("utf8");
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) logger.debug("worker.stderr", "Worker process wrote to stderr.", { jobId: job.id, message: redactString(line).slice(0, 2000), eventCode: "WORKER_STDERR" });
      }
    });

    const onMessage = async (raw: unknown): Promise<void> => {
      const message = parseWorkerMessage(raw);
      if (!message) {
        logger.warn("worker.bad_message", "Worker sent an invalid IPC message; ignoring.", { jobId: job.id, eventCode: "WORKER_BAD_MESSAGE" });
        return;
      }
      if (message.jobId !== job.id || message.leaseGeneration !== leaseGeneration) {
        logger.warn("worker.stale_message", "Worker sent a message from a stale lease; ignoring.", { jobId: job.id, eventCode: "WORKER_STALE_MESSAGE" });
        return;
      }
      try {
        await this.handleWorkerMessage(handle, message, context.signal, settledResolve, settledReject);
      } catch (error) {
        logger.error("worker.message_failed", "Failed to handle worker message.", { jobId: job.id, message: redactString((error as Error).message), eventCode: "WORKER_MESSAGE_FAILED" });
      }
    };
    child.on("message", (raw: unknown) => void onMessage(raw));

    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        logger.info("worker.exited", "Worker process exited.", { jobId: job.id, exitCode: code ?? undefined, eventCode: "WORKER_EXITED", attempt: undefined });
        if (!handle.killed) {
          settledReject(new Error(handle.aborting ? "cancelled" : `Worker exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"})`));
        }
        resolve();
      });
    });

    const startMessage: StartJobMessage = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "start_job",
      jobId: job.id,
      leaseGeneration,
      requestId: this.nextRequestId(),
      taskText: current.task_text,
      workRoot: this.deps.paths.workRoot,
      sessionDir: this.deps.paths.sessionsDir,
      sessionFile,
      authPath: this.deps.config.models.authPath,
      modelsPath: this.deps.paths.modelsPath,
      modelsStorePath: this.deps.paths.modelsStorePath,
      model: { provider: slot.provider, modelId: slot.modelId, thinking: slot.thinking },
      images: this.deps.loadImages ? await this.deps.loadImages(current) : [],
      apiKeys: this.deps.resolveApiKeys ? await this.deps.resolveApiKeys() : [],
      limits: {
        maxToolCalls: this.deps.config.jobs.maxToolCalls,
        maxModelTurns: this.deps.config.jobs.maxModelTurns,
        maxRunSeconds: this.deps.config.jobs.maxRunSeconds,
      },
    };
    if (metadata?.input && !metadata.input.includes("image") && startMessage.images.length > 0) {
      logger.warn("worker.vision_unsupported", "Selected model does not declare image input; inbound images may be rejected.", { jobId: job.id, eventCode: "VISION_UNSUPPORTED" });
    }

    const abortListener = () => {
      void this.cancelHandle(handle, "deadline or job abort");
    };
    context.signal.addEventListener("abort", abortListener, { once: true });
    this.workers.set(job.id, handle);
    // The worker exists and has been given its start message: this is the
    // point where the job leaves "starting" so success/failure transitions
    // are valid from here on.
    try {
      if (repo.getJob(job.id)?.state === "starting") repo.transitionJob(job.id, "running", { reason: "worker started" });
    } catch (error) {
      logger.warn("worker.running_transition_failed", "Could not move the job to running.", { jobId: job.id, detail: (error as Error).message, eventCode: "WORKER_RUNNING_TRANSITION" });
    }
    child.send(startMessage);

    try {
      const settled = await handle.settled;
      return { state: "succeeded", resultText: settled.resultText };
    } catch (error) {
      const messageText = (error as Error).message;
      if (handle.aborting || messageText === "cancelled") {
        return { state: "cancelled", errorCode: "CANCELLED", errorMessage: "Job was cancelled." };
      }
      return { state: "failed", errorCode: "WORKER_ERROR", errorMessage: messageText };
    } finally {
      context.signal.removeEventListener("abort", abortListener);
      this.workers.delete(job.id);
      await this.terminateIfAlive(child);
      lease.revoke();
    }
  }

  private async handleWorkerMessage(
    handle: WorkerHandle,
    message: WorkerToSupervisorMessage,
    signal: AbortSignal,
    settledResolve: (value: { resultText: string }) => void,
    settledReject: (error: Error) => void,
  ): Promise<void> {
    const { repo, broker, logger } = this.deps;
    switch (message.type) {
      case "ready":
        logger.debug("worker.ready", "Worker reported ready.", { jobId: handle.jobId, eventCode: "WORKER_READY" });
        return;
      case "session_mapped": {
        const job = repo.getJob(handle.jobId);
        if (job) repo.setConversationSessionFile(job.conversation_id, message.sessionFile ?? "");
        repo.appendEvent(handle.jobId, { eventType: "session", summary: `model ${message.effectiveModel.provider}/${message.effectiveModel.modelId} thinking=${message.effectiveModel.thinking}` });
        return;
      }
      case "progress": {
        repo.appendEvent(handle.jobId, { eventType: message.kind, toolName: message.toolName, summary: message.summary });
        if (message.kind === "tool_start" || message.kind === "tool_end") this.deps.onStream?.(handle.jobId, "tool", message.summary);
        else if (message.kind === "state") this.deps.onStream?.(handle.jobId, "state", message.summary);
        if (message.kind === "state") this.deps.onProgress?.(handle.jobId, message.summary);
        return;
      }
      case "stream": {
        this.deps.onStream?.(handle.jobId, message.streamKind, message.text);
        return;
      }
      case "model_usage": {
        this.deps.onModelUsage?.(handle.jobId, message);
        return;
      }
      case "usage": {
        const delta = Math.max(0, message.modelTurns - handle.lastModelTurns);
        handle.lastModelTurns = message.modelTurns;
        if (delta > 0) repo.incrementJobCounters(handle.jobId, { modelTurns: delta });
        if (message.modelTurns > this.deps.config.jobs.maxModelTurns) {
          logger.warn("worker.model_turn_limit", "Model turn limit reached; cancelling job.", { jobId: handle.jobId, eventCode: "MODEL_TURN_LIMIT" });
          void this.cancelHandle(handle, "model turn limit reached");
        }
        return;
      }
      case "settled":
        settledResolve({ resultText: message.resultText });
        return;
      case "fatal":
        this.deps.onStream?.(handle.jobId, "error", message.message);
        settledReject(new Error(message.message));
        return;
      case "tool_request": {
        const result = await broker.execute({
          jobId: handle.jobId,
          leaseGeneration: handle.leaseGeneration,
          requestId: message.requestId,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          args: message.args,
          signal,
        });
        const reply: ToolResultMessage = {
          protocolVersion: IPC_PROTOCOL_VERSION,
          type: "tool_result",
          jobId: handle.jobId,
          leaseGeneration: handle.leaseGeneration,
          requestId: message.requestId,
          toolCallId: message.toolCallId,
          ok: result.ok,
          ...(result.ok ? { result: result.result } : { error: result.error }),
        };
        if (!handle.child.connected) return;
        handle.child.send(reply);
        return;
      }
    }
  }

  async cancel(jobId: string, reason: string): Promise<void> {
    const handle = this.workers.get(jobId);
    if (!handle) return;
    await this.cancelHandle(handle, reason);
  }

  private async cancelHandle(handle: WorkerHandle, reason: string): Promise<void> {
    if (handle.aborting) return;
    handle.aborting = true;
    this.deps.logger.info("worker.cancel", "Requesting worker cancellation.", { jobId: handle.jobId, reason, eventCode: "WORKER_CANCEL" });
    try {
      if (handle.child.connected) {
        handle.child.send({ protocolVersion: IPC_PROTOCOL_VERSION, type: "abort", jobId: handle.jobId, leaseGeneration: handle.leaseGeneration, requestId: this.nextRequestId(), reason });
      }
    } catch {
      /* process may already be gone */
    }
    const graceMs = this.deps.config.jobs.stopGraceMs;
    const exited = await Promise.race([new Promise<boolean>((resolve) => handle.child.once("exit", () => resolve(true))), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs))]);
    if (!exited) {
      this.deps.logger.warn("worker.hard_kill", "Worker did not stop within the grace period; killing it.", { jobId: handle.jobId, eventCode: "WORKER_HARD_KILL" });
      handle.killed = true;
      try {
        handle.child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  async pause(jobId: string): Promise<void> {
    this.deps.broker.setPaused(jobId, true);
    this.deps.lease.pause(jobId);
  }

  async resume(jobId: string): Promise<void> {
    this.deps.broker.setPaused(jobId, false);
    this.deps.lease.resume(jobId);
  }

  async steer(jobId: string, instruction: string): Promise<boolean> {
    const handle = this.workers.get(jobId);
    if (!handle || !handle.child.connected) return false;
    handle.child.send({ protocolVersion: IPC_PROTOCOL_VERSION, type: "steer", jobId, leaseGeneration: handle.leaseGeneration, requestId: this.nextRequestId(), text: instruction });
    return true;
  }

  notifyApproval(approvalId: string, decision: "approve" | "reject"): void {
    this.deps.broker.resolveApproval(approvalId, decision);
  }

  notifyOwnerAnswer(questionId: string, answer: string): void {
    this.deps.broker.resolveOwnerAnswer(questionId, answer);
  }

  async dispose(): Promise<void> {
    for (const handle of [...this.workers.values()]) {
      await this.cancelHandle(handle, "executor dispose");
    }
    this.workers.clear();
  }

  private async terminateIfAlive(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private nextRequestId(): string {
    this.counter += 1;
    return `s-${this.counter}`;
  }

  private sessionFileFor(job: JobRow): string | null {
    const conversation = this.deps.repo.getConversation(job.conversation_id);
    const sessionFile = conversation?.session_file;
    if (!sessionFile || sessionFile.length === 0) return null;
    if (!existsSync(sessionFile)) {
      // A moved or deleted session (for example after renaming the data root)
      // must not fail the job: start a fresh session instead.
      this.deps.logger.warn("worker.session_missing", "Mapped session file is missing; starting a fresh session.", { jobId: job.id, eventCode: "SESSION_MISSING", path: sessionFile });
      return null;
    }
    return sessionFile;
  }

  private modelSnapshot(job: JobRow): { provider: string; modelId: string; thinking: StartJobMessage["model"]["thinking"] } {
    const config = this.deps.config;
    const fallbackSlot = config.models.slots[config.models.selectedSlot] ?? Object.values(config.models.slots)[0];
    const fallbackThinking = (fallbackSlot?.thinking ?? config.models.thinking) as StartJobMessage["model"]["thinking"];
    const fallback = fallbackSlot
      ? { provider: fallbackSlot.provider, modelId: fallbackSlot.modelId, thinking: fallbackThinking }
      : { provider: "deepseek", modelId: "deepseek-flash", thinking: fallbackThinking };
    try {
      const parsed = job.model_json ? (JSON.parse(job.model_json) as { slot?: string; provider?: string; modelId?: string; thinking?: string }) : {};
      if (parsed.provider && parsed.modelId) {
        return { provider: parsed.provider, modelId: parsed.modelId, thinking: (parsed.thinking as StartJobMessage["model"]["thinking"]) ?? fallbackThinking };
      }
      const slotName = parsed.slot ?? config.models.selectedSlot;
      const slot = config.models.slots[slotName] ?? fallbackSlot;
      if (!slot) return fallback;
      return { provider: slot.provider, modelId: slot.modelId, thinking: (parsed.thinking as StartJobMessage["model"]["thinking"]) ?? ((slot.thinking ?? config.models.thinking) as StartJobMessage["model"]["thinking"]) };
    } catch {
      return fallback;
    }
  }
}
