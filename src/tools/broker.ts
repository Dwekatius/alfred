/**
 * Tool broker: validates and executes typed tool requests from the Pi worker.
 *
 * The broker is deterministic infrastructure. It never calls a model. Handlers
 * for desktop, browser, filesystem, and Telegram tools register themselves.
 */
import { Database } from "../storage/database.js";
import { AppConfig } from "../config.js";
import { Logger } from "../logging.js";
import { JobRepository } from "../jobs/repository.js";
import { ApprovalRepository, digestAction } from "../jobs/approvals.js";
import { QuestionRepository } from "../jobs/questions.js";
import { ArtifactRegistry } from "../artifacts/registry.js";
import { Outbox } from "../telegram/outbox.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AgentToolError, type AgentToolErrorData, type ErrorCode } from "./errors.js";
import { DesktopLease } from "./desktop-lease.js";
import { toolSpecByName, type ToolSpec } from "../pi/tool-definitions.js";
import type { ToolResultPayload } from "../ipc.js";

export interface BrokerRequest {
  jobId: string;
  leaseGeneration: number;
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  signal: AbortSignal;
}

export interface BrokerContext {
  jobId: string;
  requestId: string;
  toolCallId: string;
  leaseGeneration: number;
  signal: AbortSignal;
  /** Run a desktop/browser action under the global mutex after lease re-check. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Check that the lease is still valid immediately before acting. */
  assertLease(): void;
  logger: Logger;
  config: AppConfig;
  repo: JobRepository;
  artifacts: ArtifactRegistry;
  outbox: Outbox | undefined;
  approvals: ApprovalRepository;
  questions: QuestionRepository;
  /** Ask the owner to approve an action; throws APPROVAL_REQUIRED with details attached for the pending record. */
  requireApproval(input: { actionType: string; preview: string; payload: unknown }): Promise<void>;
  /** Ask the owner a question and wait for the answer. */
  requestOwnerInput(input: { question: string; options?: string[] }): Promise<string>;
  /** Send a progress message to the owner. */
  notifyOwner(text: string): void;
}

export type ToolHandler = (args: unknown, context: BrokerContext, spec: ToolSpec) => Promise<ToolResultPayload>;

export interface BrokerDeps {
  db: Database;
  repo: JobRepository;
  approvals: ApprovalRepository;
  questions: QuestionRepository;
  artifacts: ArtifactRegistry;
  getOutbox: () => Outbox | undefined;
  config: AppConfig;
  logger: Logger;
  lease: DesktopLease;
  onJobWaiting?: (jobId: string, waiting: boolean) => void;
}

export class ToolBroker {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly pendingQuestions = new Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>();
  private readonly pendingApprovals = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly pauseGates = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  constructor(private readonly deps: BrokerDeps) {}

  registerHandler(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  registerHandlers(handlers: Record<string, ToolHandler>): void {
    for (const [name, handler] of Object.entries(handlers)) this.registerHandler(name, handler);
  }

  hasHandler(toolName: string): boolean {
    return this.handlers.has(toolName);
  }

  listHandlers(): string[] {
    return [...this.handlers.keys()].sort();
  }

  get pendingQuestionCount(): number {
    return this.pendingQuestions.size;
  }

  get pendingApprovalCount(): number {
    return this.pendingApprovals.size;
  }

  resolveOwnerAnswer(questionId: string, answer: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      this.pendingQuestions.delete(questionId);
      pending.resolve(answer);
    }
  }

  resolveApproval(approvalId: string, decision: "approve" | "reject"): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    this.pendingApprovals.delete(approvalId);
    pending.resolve();
  }

  /** Pause mutating tools for a job; read-only tools and Telegram remain usable. */
  setPaused(jobId: string, paused: boolean): void {
    if (paused) {
      if (!this.pauseGates.has(jobId)) {
        let resolveGate: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
        this.pauseGates.set(jobId, { promise, resolve: resolveGate });
      }
    } else {
      const gate = this.pauseGates.get(jobId);
      if (gate) {
        this.pauseGates.delete(jobId);
        gate.resolve();
      }
    }
  }

  private async waitIfPaused(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.deps.repo.getJob(jobId);
    if (!job || (job.state !== "paused" && job.state !== "waiting_for_unlock")) return;
    const gate = this.pauseGates.get(jobId);
    if (!gate) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error("Paused job cancelled"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      gate.promise.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /** Execute one validated tool request. Never throws; returns a structured result. */
  async execute(request: BrokerRequest): Promise<{ ok: true; result: ToolResultPayload } | { ok: false; error: AgentToolErrorData }> {
    const { repo, logger, config } = this.deps;
    const job = repo.getJob(request.jobId);
    if (!job) return this.error("VALIDATION_ERROR", `Unknown job ${request.jobId}`, false, "not_started");
    if (job.lease_generation !== request.leaseGeneration) {
      return this.error("LEASE_REVOKED", "The job lease was revoked before this action started.", false, "not_started");
    }
    if (["cancelled", "failed", "succeeded", "interrupted", "cancelling"].includes(job.state)) {
      return this.error("LEASE_REVOKED", `Job is ${job.state}; no further tools are permitted.`, false, "not_started");
    }

    const spec = toolSpecByName(request.toolName);
    if (!spec) return this.error("VALIDATION_ERROR", `Unknown tool "${request.toolName}"`, false, "not_started");

    if (job.tool_calls + 1 > config.jobs.maxToolCalls) {
      repo.appendEvent(job.id, { eventType: "limit", toolName: spec.name, summary: `tool call limit ${config.jobs.maxToolCalls} reached` });
      return this.error("WORK_LIMIT_REACHED", `Tool call limit (${config.jobs.maxToolCalls}) reached. Report progress and stop.`, false, "not_started");
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = Value.Parse(spec.parameters, request.args);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n").slice(0, 3).join(" ").slice(0, 300) : "Invalid tool arguments";
      return this.error("VALIDATION_ERROR", `Invalid arguments for ${spec.name}: ${message}`, false, "not_started");
    }

    const handler = this.handlers.get(spec.name);
    if (!handler) {
      return this.error("NOT_IMPLEMENTED", `Tool ${spec.name} is not implemented in this build.`, false, "not_started");
    }

    repo.incrementJobCounters(job.id, { toolCalls: 1 });
    repo.appendEvent(job.id, { eventType: "tool_start", toolName: spec.name, summary: `started ${spec.name}` });
    const startedAt = Date.now();

    const context = this.createContext(request);
    try {
      if (!spec.readOnly) await this.waitIfPaused(job.id, request.signal);
      context.assertLease();
      const result = await handler(parsedArgs, context, spec);
      repo.appendEvent(job.id, { eventType: "tool_end", toolName: spec.name, summary: `${spec.name} completed`, observationId: this.extractObservationId(result) });
      logger.debug("broker.tool_ok", "Tool completed", { jobId: job.id, toolName: spec.name, durationMs: Date.now() - startedAt, eventCode: "TOOL_OK" });
      return { ok: true, result: this.boundResult(result) };
    } catch (error) {
      const structured = AgentToolError.from(error);
      repo.appendEvent(job.id, {
        eventType: "tool_error",
        toolName: spec.name,
        summary: `${spec.name} failed: ${structured.code} (${structured.actionOutcome})`,
        observationId: structured.observationId,
      });
      logger.warn("broker.tool_error", "Tool failed", { jobId: job.id, toolName: spec.name, durationMs: Date.now() - startedAt, code: structured.code, eventCode: "TOOL_ERROR" });
      return { ok: false, error: structured.toData() };
    }
  }

  private createContext(request: BrokerRequest): BrokerContext {
    const deps = this.deps;
    return {
      jobId: request.jobId,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      leaseGeneration: request.leaseGeneration,
      signal: request.signal,
      logger: deps.logger.child({ jobId: request.jobId, requestId: request.requestId }),
      config: deps.config,
      repo: deps.repo,
      artifacts: deps.artifacts,
      outbox: deps.getOutbox(),
      approvals: deps.approvals,
      questions: deps.questions,
      runExclusive: (fn) => deps.lease.mutex.runExclusive(fn),
      assertLease: () => {
        if (request.signal.aborted) throw new AgentToolError({ code: "CANCELLED", message: "Job cancelled before the next operation.", retryable: false, actionOutcome: "not_started" });
        const job = deps.repo.getJob(request.jobId);
        if (!job) throw new AgentToolError({ code: "LEASE_REVOKED", message: "Job no longer exists.", retryable: false, actionOutcome: "not_started" });
        if (job.lease_generation !== request.leaseGeneration) {
          throw new AgentToolError({ code: "LEASE_REVOKED", message: "The desktop lease was revoked.", retryable: false, actionOutcome: "not_started" });
        }
        if (["cancelled", "failed", "succeeded", "interrupted", "cancelling"].includes(job.state)) {
          throw new AgentToolError({ code: "LEASE_REVOKED", message: `Job is ${job.state}.`, retryable: false, actionOutcome: "not_started" });
        }
        if (!toolSpecByName(request.toolName)?.readOnly && (["paused", "waiting_for_unlock"].includes(job.state) || deps.lease.isPaused(request.jobId))) {
          throw new AgentToolError({ code: "PAUSED", message: "Job paused before the next operation.", retryable: false, actionOutcome: "not_started" });
        }
      },
      requireApproval: async (input) => {
        const job = deps.repo.getJob(request.jobId);
        const conversation = job ? deps.repo.getConversation(job.conversation_id) : undefined;
        if (!job || !conversation) throw new AgentToolError({ code: "INTERNAL_ERROR", message: "Job conversation missing.", retryable: false, actionOutcome: "not_started" });
        const approval = deps.approvals.create({
          jobId: job.id,
          ownerUserId: conversation.owner_user_id,
          ownerChatId: conversation.owner_chat_id,
          actionType: input.actionType,
          preview: input.preview,
          payload: input.payload,
          ttlMs: 10 * 60 * 1000,
          requestId: request.requestId,
        });
        deps.repo.appendEvent(job.id, { eventType: "approval_requested", summary: `${input.actionType}: ${input.preview.slice(0, 120)}` });
        deps.repo.transitionJob(job.id, "waiting_for_owner", { reason: "approval requested" });
        deps.onJobWaiting?.(job.id, true);
        const outbox = deps.getOutbox();
        outbox?.enqueue({
          logicalKey: `approval:${approval.id}`,
          kind: "text",
          payload: {
            variant: "approval",
            text: `${input.preview}\n\nTo approve, send /approve ${approval.id}\nTo reject, send /reject ${approval.id}\nThis request expires in 10 minutes.`,
          },
        });
        await new Promise<void>((resolve, reject) => {
          this.pendingApprovals.set(approval.id, { resolve, reject });
          const onAbort = () => {
            this.pendingApprovals.delete(approval.id);
            reject(new Error("Approval wait cancelled"));
          };
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
        });
        const current = deps.approvals.get(approval.id);
        if (!current || current.decision !== "approve") {
          throw new AgentToolError({ code: "POLICY_BLOCKED", message: `The owner did not approve: ${input.preview.slice(0, 200)}`, retryable: false, actionOutcome: "not_started" });
        }
        const consumed = deps.approvals.consume(approval.id, digestAction(input.actionType, input.payload));
        if (!consumed) {
          throw new AgentToolError({ code: "POLICY_BLOCKED", message: "The approval expired, was already used, or the action changed.", retryable: false, actionOutcome: "not_started" });
        }
        if (job.id) {
          try {
            if (deps.repo.getJob(job.id)?.state === "waiting_for_owner") deps.repo.transitionJob(job.id, "running", { reason: "approval granted" });
          } catch {
            /* job may have been paused meanwhile */
          }
        }
        deps.onJobWaiting?.(job.id, false);
      },
      requestOwnerInput: async (input) => {
        const job = deps.repo.getJob(request.jobId);
        const conversation = job ? deps.repo.getConversation(job.conversation_id) : undefined;
        if (!job || !conversation) throw new AgentToolError({ code: "INTERNAL_ERROR", message: "Job conversation missing.", retryable: false, actionOutcome: "not_started" });
        const question = deps.questions.create({
          jobId: job.id,
          ownerUserId: conversation.owner_user_id,
          ownerChatId: conversation.owner_chat_id,
          question: input.question,
          options: input.options,
          ttlMs: 30 * 60 * 1000,
        });
        try {
          deps.repo.transitionJob(job.id, "waiting_for_owner", { reason: "owner question" });
        } catch {
          /* already waiting */
        }
        deps.onJobWaiting?.(job.id, true);
        const optionsText = input.options && input.options.length > 0 ? `\nOptions:\n${input.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}` : "";
        deps.getOutbox()?.enqueue({
          logicalKey: `question:${question.id}`,
          kind: "text",
          payload: { variant: "question", text: `${input.question}${optionsText}\n\nReply in this chat to answer (question ${question.id}).` },
        });
        const answer = await new Promise<string>((resolve, reject) => {
          const cleanup = () => {
            clearInterval(timer);
            request.signal.removeEventListener("abort", onAbort);
            this.pendingQuestions.delete(question.id);
          };
          const succeed = (value: string) => { cleanup(); resolve(value); };
          const fail = (error: Error) => { cleanup(); reject(error); };
          const onAbort = () => fail(new Error("Question wait cancelled"));
          const timer = setInterval(() => {
            const row = deps.questions.get(question.id);
            if (row && row.status === "answered" && row.answer !== null) {
              succeed(row.answer);
              return;
            }
            if (row && (row.status === "expired" || row.status === "cancelled")) {
              fail(new Error("Question expired or was cancelled"));
            }
          }, 1000);
          timer.unref?.();
          this.pendingQuestions.set(question.id, { resolve: succeed, reject: fail });
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          if (deps.repo.getJob(job.id)?.state === "waiting_for_owner") deps.repo.transitionJob(job.id, "running", { reason: "owner answered" });
        } catch {
          /* may be paused */
        }
        deps.onJobWaiting?.(job.id, false);
        return answer;
      },
      notifyOwner: (text) => {
        deps.getOutbox()?.enqueue({ logicalKey: `tool:${request.jobId}:${request.requestId}`, kind: "text", payload: { variant: "progress", text } });
      },
    };
  }

  private extractObservationId(result: ToolResultPayload): string | undefined {
    const details = result.details;
    if (details && typeof details.observationId === "string") return details.observationId;
    return undefined;
  }

  /** Bound payload size: images can be large but must not freeze the controller. */
  private boundResult(result: ToolResultPayload, maxBytes = 12 * 1024 * 1024): ToolResultPayload {
    let total = 0;
    for (const block of result.content) {
      total += block.type === "text" ? Buffer.byteLength(block.text) : Math.ceil((block.data.length * 3) / 4);
      if (total > maxBytes) {
        throw new AgentToolError({ code: "INTERNAL_ERROR", message: "Tool result exceeded the IPC size limit.", retryable: false, actionOutcome: "not_started" });
      }
    }
    return result;
  }

  private error(code: ErrorCode, message: string, retryable: boolean, actionOutcome: AgentToolErrorData["actionOutcome"]): { ok: false; error: AgentToolErrorData } {
    return { ok: false, error: { code, message, retryable, actionOutcome } };
  }

  /** Tool schema for approval commands parsed from plain text (used by supervisor). */
  static approvalCommandSchema = Type.Object({ approvalId: Type.String(), decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]) });
}
