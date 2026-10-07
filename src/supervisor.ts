/**
 * Supervisor: owns Telegram transport, authorization, durable admission, the
 * job scheduler, the tool broker lifecycle, and outbound delivery.
 *
 * It never runs a model loop itself and never awaits a job from the receive
 * path. All side effects are deterministic and persisted before execution.
 */
import { AppConfig, DataPaths, loadConfig, saveConfigAtomic, validateConfig } from "./config.js";
import { Logger, redactString } from "./logging.js";
import { statSync } from "node:fs";
import { Database } from "./storage/database.js";
import { JobRepository, type JobRow, type UpdateDecision } from "./jobs/repository.js";
import { NullExecutor, type JobExecutor, type SchedulerEvent, Scheduler } from "./jobs/scheduler.js";
import { ApprovalRepository } from "./jobs/approvals.js";
import { QuestionRepository } from "./jobs/questions.js";
import { decodeControl, encodeControl, isHighPriority, type StoredControl } from "./jobs/controls.js";
import { Outbox } from "./telegram/outbox.js";
import { TelegramClient, type TgMessage, type TgUpdate } from "./telegram/api.js";
import { TelegramPoller, type Admission } from "./telegram/poller.js";
import { Authorizer, PairingService, type OwnerIds } from "./telegram/auth.js";
import { buildHelpText, buildModelHelpText, parseCallbackData, parseCommandText, type ParsedCommand } from "./telegram/commands.js";
import { formatDuration, nowInTimeZone, splitMessage, taskLabel, withPartNumbering } from "./telegram/format.js";
import { ArtifactRegistry } from "./artifacts/registry.js";
import { ensureRemoteModelFiles, findCachedModel, updateOpenRouterRouting } from "./pi/models.js";
import { getCatalogModel, listProviderModels } from "./pi/catalog.js";
import type { SecretStore } from "./platform/secrets.js";
import { InboundMediaLoader } from "./telegram/inbound-media.js";
import type { ModelUsageMessage } from "./ipc.js";

export interface DesktopProbeResult {
  available: boolean;
  reason?: string;
  detail?: string;
}

export interface ScreenshotCaptureResult {
  artifactId: string;
  caption: string;
}

export interface ScreenshotProvider {
  capture(scope: "desktop" | "window"): Promise<ScreenshotCaptureResult | { error: string }>;
}

export interface ModelValidator {
  validate(provider: string, modelId: string): Promise<{ ok: boolean; message: string }>;
}

export interface SupervisorDeps {
  config: AppConfig;
  configPath: string;
  paths: DataPaths;
  db: Database;
  repo: JobRepository;
  secrets: SecretStore;
  logger: Logger;
  runId: string;
  /** Test seam: supply the outbox without starting Telegram. */
  outboxOverride?: Outbox;
}

export class Supervisor {
  private config: AppConfig;
  private readonly db: Database;
  private readonly repo: JobRepository;
  private readonly paths: DataPaths;
  private readonly logger: Logger;
  private readonly deps: SupervisorDeps;
  readonly approvals: ApprovalRepository;
  readonly questions: QuestionRepository;
  readonly artifacts: ArtifactRegistry;
  readonly pairing: PairingService;
  private readonly authorizer: Authorizer;
  private outbox: Outbox | undefined;
  private readonly scheduler: Scheduler;
  private executor: JobExecutor = new NullExecutor();
  private client: TelegramClient | undefined;
  private poller: TelegramPoller | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private fatal: Error | undefined;
  private stopping = false;
  private stopped = false;
  private desktopProbe: (() => DesktopProbeResult) | undefined;
  private screenshotProvider: ScreenshotProvider | undefined;
  private modelValidator: ModelValidator | undefined;
  private pairingWasActive = false;
  private mediaLoader: InboundMediaLoader | undefined;
  private mediaGroups = new Map<string, { jobId: string; at: number }>();
  private configMtimeMs = 0;
  private lastTypingAt = 0;
  private streamBuffer: Array<{ jobId: string; kind: string; text: string }> = [];
  private openStreamRows = new Map<string, { id: number; at: number }>();
  private streamFlushTimer: NodeJS.Timeout | undefined;
  private lastTelemetryPruneAt = 0;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.db = deps.db;
    this.repo = deps.repo;
    this.paths = deps.paths;
    this.logger = deps.logger;
    this.approvals = new ApprovalRepository(deps.db);
    this.questions = new QuestionRepository(deps.db);
    this.artifacts = new ArtifactRegistry(deps.db, deps.paths.artifactsDir, deps.logger);
    this.pairing = new PairingService({ repository: deps.repo, logger: deps.logger });
    this.authorizer = new Authorizer(() => this.getOwnerIds(), deps.logger);
    if (deps.outboxOverride) this.outbox = deps.outboxOverride;
    this.scheduler = new Scheduler({
      repository: deps.repo,
      executor: { execute: (context) => this.executor.execute(context), cancel: (id, reason) => this.executor.cancel(id, reason), pause: (id) => this.executor.pause(id), resume: (id) => this.executor.resume(id), steer: (id, text) => this.executor.steer(id, text), dispose: () => this.executor.dispose() },
      config: this.config,
      logger: deps.logger,
      onEvent: (event) => this.handleSchedulerEvent(event),
      isDesktopAvailable: () => this.desktopProbe?.() ?? { available: true },
    });
  }

  private createClientIfPossible(): TelegramClient | undefined {
    const token = process.env.PI_TG_BOT_TOKEN;
    if (!token) return undefined;
    return new TelegramClient(token, { logger: this.logger });
  }

  private createOutbox(client: TelegramClient): Outbox {
    return new Outbox(this.db, client, {
      getOwnerChatId: () => this.config.telegram.ownerChatId,
      artifacts: this.artifacts,
      logger: this.logger,
      onAuthError: (error) => this.onFatal(error),
    });
  }

  setExecutor(executor: JobExecutor): void {
    this.executor = executor;
  }

  setScreenshotProvider(provider: ScreenshotProvider): void {
    this.screenshotProvider = provider;
  }

  setDesktopProbe(probe: () => DesktopProbeResult): void {
    this.desktopProbe = probe;
  }

  setModelValidator(validator: ModelValidator): void {
    this.modelValidator = validator;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getFatal(): Error | undefined {
    return this.fatal;
  }

  /** Load user-provided provider keys from DPAPI for the next worker. */
  async resolveApiKeys(selectedProvider?: string): Promise<Array<{ provider: string; key: string }>> {
    const providers = new Set<string>(selectedProvider ? [selectedProvider] : ["deepseek", "openrouter", ...Object.values(this.config.models.slots).map((slot) => slot.provider)]);
    const keys: Array<{ provider: string; key: string }> = [];
    for (const provider of providers) {
      try {
        const key = await this.deps.secrets.get(`alfred/api-key/${provider}`);
        if (key && key.trim().length > 0) keys.push({ provider, key: key.trim() });
      } catch {
        /* key not configured for this provider */
      }
    }
    return keys;
  }

  getOwnerIds(): OwnerIds | null {
    const { ownerUserId, ownerChatId } = this.config.telegram;
    if (!ownerUserId || !ownerChatId) return null;
    return { ownerUserId, ownerChatId };
  }

  /** Download and prepare inbound images for a job (empty when none or while offline). */
  async loadJobImages(job: JobRow): Promise<Array<{ data: string; mimeType: string }>> {
    if (!this.client) return [];
    this.mediaLoader ??= new InboundMediaLoader({ client: this.client, artifacts: this.artifacts, config: this.config, paths: this.paths, logger: this.logger });
    const blocks = await this.mediaLoader.loadForJob(job.attachments_json, job.id);
    return blocks.map((block) => ({ data: block.data, mimeType: block.mimeType }));
  }

  /** Merge a media-group message into the job created by the group's first message. */
  private mergeMediaGroup(groupId: string, message: TgMessage): string | undefined {
    const entry = this.mediaGroups.get(groupId);
    if (!entry) return undefined;
    const job = this.repo.getJob(entry.jobId);
    if (!job || !["queued", "awaiting_start"].includes(job.state)) {
      this.mediaGroups.delete(groupId);
      return undefined;
    }
    const extra = this.serializeAttachments(message);
    if (extra) this.repo.mergeJobAttachments(entry.jobId, extra);
    return entry.jobId;
  }

  private serializeAttachments(message: TgMessage): string | null {
    return serializeAttachments(message);
  }

  isStopped(): boolean {
    return this.stopped;
  }

  // ------------------------------------------------------------------ startup

  async start(): Promise<void> {
    ensureRemoteModelFiles(this.config, this.paths, this.logger);

    const recovered = this.repo.recoverInterruptedJobs();
    for (const job of recovered) {
      this.logger.warn("recovery.interrupted", "Job was interrupted by a controller restart.", { jobId: job.id, eventCode: "JOB_INTERRUPTED" });
    }

    const token = await this.resolveToken();
    if (!token) {
      this.logger.warn("telegram.no_token", "No bot token configured. Controller runs local-only until setup stores a token.", { eventCode: "NO_TELEGRAM_TOKEN" });
      this.startLocalTicker();
      return;
    }
    const client = new TelegramClient(token, { logger: this.logger });
    this.client = client;
    const outbox = this.createOutbox(client);
    this.outbox = outbox;

    const me = await client.getMe();
    this.logger.info("telegram.ready", "Telegram bot authenticated.", { eventCode: "TELEGRAM_READY", botId: String(me.id), username: me.username });

    const webhook = await client.getWebhookInfo();
    if (webhook.url && webhook.url.length > 0) {
      throw new Error(
        `This bot has a webhook configured (${redactString(webhook.url)}). Polling and webhooks cannot coexist. Remove the webhook explicitly during local setup, then restart.`,
      );
    }
    await client.setMyCommands([
      { command: "status", description: "Current job, model, and desktop state" },
      { command: "screenshot", description: "Capture and send the current screen" },
      { command: "pause", description: "Stop new side effects" },
      { command: "resume", description: "Resume the paused job" },
      { command: "stop", description: "Cancel active job and suspend dispatch" },
      { command: "queue", description: "List queued jobs" },
      { command: "help", description: "Command reference" },
    ]);

    void outbox.run().catch((error) => {
      this.logger.error("outbox.loop_failed", "Outbox loop crashed.", { message: redactString((error as Error).message), eventCode: "OUTBOX_LOOP_FAILED" });
    });
    this.startLocalTicker();
    this.streamFlushTimer = setInterval(() => {
      this.flushStreamEvents();
      this.pruneTelemetry();
    }, 300);
    this.streamFlushTimer.unref?.();

    this.poller = new TelegramPoller(
      client,
      this.repo,
      {
        admitBatch: (updates) => this.admitBatch(updates),
        onAdmitted: async (admissions) => this.onAdmitted(admissions),
        onHighPriorityControl: async (admission) => this.applyControlById(admission.controlId!),
        onFatal: (error) => this.onFatal(error),
      },
      {
        pollTimeoutSeconds: this.config.telegram.pollTimeoutSeconds,
        allowedUpdates: [...this.config.telegram.allowedUpdates],
      },
      this.logger,
    );
    void this.poller.run().catch((error) => {
      this.logger.error("telegram.poller_failed", "Poller loop crashed.", { message: redactString((error as Error).message), eventCode: "POLLER_FAILED" });
      this.onFatal(error as Error);
    });

    if (recovered.length > 0) {
      const lines = recovered.map((job) => `- ${job.id} (${taskLabel(job.task_label)})`);
      this.enqueueOwnerText(`recovery:${this.deps.runId}`, `Controller restarted. These jobs were interrupted and will not be replayed automatically:\n${lines.join("\n")}\nThey can be continued as a new explicitly linked attempt.`, { variant: "recovery" });
    }
    this.pairingWasActive = this.repo.isPairingMode();
    try {
      this.configMtimeMs = statSync(this.deps.configPath).mtimeMs;
    } catch {
      this.configMtimeMs = 0;
    }
  }

  private async resolveToken(): Promise<string | undefined> {
    if (process.env.PI_TG_BOT_TOKEN) return process.env.PI_TG_BOT_TOKEN;
    const name = this.config.telegram.tokenSecretName;
    try {
      const token = await this.deps.secrets.get(name);
      return token && token.length > 0 ? token : undefined;
    } catch (error) {
      this.logger.error("secrets.read_failed", "Could not read the bot token from DPAPI storage.", { message: redactString((error as Error).message), eventCode: "SECRETS_READ_FAILED" });
      return undefined;
    }
  }

  private startLocalTicker(): void {
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.tickTimer.unref?.();
  }

  /** A typing action roughly every five seconds while a job is active feels like a chat agent. */
  private pumpTypingIndicator(): void {
    const active = this.repo.getActiveJob();
    const chatId = this.config.telegram.ownerChatId;
    if (!active || !chatId || !this.client) return;
    const now = Date.now();
    if (now - this.lastTypingAt < 4500) return;
    this.lastTypingAt = now;
    void this.client.sendChatAction(chatId, "typing").catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      this.reloadConfigIfChanged();
      this.pumpTypingIndicator();
      this.approvals.expireStale();
      this.questions.expireStale();
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [groupId, entry] of this.mediaGroups) {
        if (entry.at < cutoff) this.mediaGroups.delete(groupId);
      }
      await this.applyPendingControls();
      this.scheduler.notify();
    } catch (error) {
      this.logger.error("tick.failed", "Periodic tick failed.", { message: redactString((error as Error).message), eventCode: "TICK_FAILED" });
    }
  }

  async stop(reason = "controller shutdown"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.poller?.stop();
    this.outbox?.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.streamFlushTimer) clearInterval(this.streamFlushTimer);
    this.flushStreamEvents();
    const active = this.repo.getActiveJob();
    if (active) {
      try {
        await this.executor.cancel(active.id, reason);
        const current = this.repo.getJob(active.id);
        if (current && !["succeeded", "failed", "cancelled", "interrupted"].includes(current.state)) {
          this.repo.transitionJob(active.id, "interrupted", { reason, errorCode: "INTERRUPTED", errorMessage: "Controller shut down while this job was active." });
        }
      } catch (error) {
        this.logger.error("shutdown.cancel_failed", "Failed to stop active job cleanly.", { message: redactString((error as Error).message), eventCode: "SHUTDOWN_CANCEL_FAILED" });
      }
    }
    try {
      await this.executor.dispose();
    } catch {
      /* best effort */
    }
    this.stopped = true;
    this.logger.info("controller.stopped", "Controller stopped.", { reason, eventCode: "CONTROLLER_STOPPED" });
  }

  onFatal(error: Error): void {
    this.fatal = error;
    this.logger.error("controller.fatal", "Fatal transport error; polling stopped. Local controls remain available.", { message: redactString(error.message), eventCode: "FATAL" });
  }

  /** Physical owner input was detected: pause the active job at the next boundary. */
  handleHumanTakeover(kind: string): void {
    if (!this.config.desktop.pauseOnObservedHumanInput) return;
    const active = this.repo.getActiveJob();
    if (!active || active.state !== "running") return;
    try {
      this.repo.transitionJob(active.id, "paused", { reason: `local ${kind} input detected` });
    } catch {
      return;
    }
    void this.executor.pause(active.id);
    this.logger.warn("control.human_takeover", "Paused because local input was detected.", { jobId: active.id, eventCode: "HUMAN_TAKEOVER" });
    this.recordStream(active.id, "state", `Paused: local ${kind} input detected.`);
    this.enqueueOwnerText(`human:${active.id}:${Date.now()}`, `Paused job ${active.id}: local ${kind} input was detected. Use /resume to continue.`, { variant: "progress" });
  }

  /** Local emergency stop (hotkey or local CLI): persist a stop intent and apply it. */
  handleEmergencyStop(source: string): void {
    const controlId = this.repo.insertControl({ command: JSON.stringify({ type: "stop_all" }) });
    this.logger.warn("control.emergency_stop", "Emergency stop requested locally.", { eventCode: "EMERGENCY_STOP", source });
    this.recordStream(this.repo.getActiveJob()?.id ?? "controller", "state", `Emergency stop requested locally (${source}).`);
    void this.applyControlById(controlId);
  }

  // ------------------------------------------------------------------ admission

  /** Synchronous, per-update durable admission. Never awaits. */
  admitBatch(updates: TgUpdate[]): Admission[] {
    const sorted = [...updates].sort((a, b) => a.update_id - b.update_id);
    const admissions: Admission[] = [];
    for (const update of sorted) {
      try {
        admissions.push(this.db.transaction(() => this.admitOne(update)));
      } catch (error) {
        this.logger.error("admission.failed", "Update admission failed; recording rejection.", { updateId: update.update_id, message: redactString((error as Error).message), eventCode: "ADMISSION_FAILED" });
        try {
          this.db.transaction(() => {
            this.repo.admitUpdate(update.update_id, { kind: "unknown", decision: "rejected" });
            this.repo.setReceiveCursor(update.update_id);
          });
        } catch {
          /* ignore */
        }
        admissions.push({ updateId: update.update_id, decision: "rejected" });
      }
    }
    return admissions;
  }

  private admitOne(update: TgUpdate): Admission {
    if (this.repo.hasUpdate(update.update_id)) {
      return { updateId: update.update_id, decision: "noop" };
    }
    if (update.message) return this.admitMessage(update);
    if (update.callback_query) return this.admitCallback(update);
    this.repo.admitUpdate(update.update_id, { kind: "other", decision: "noop" });
    this.repo.setReceiveCursor(update.update_id);
    return { updateId: update.update_id, decision: "noop" as const };
  }

  private admitMessage(update: TgUpdate): Admission {
    const message = update.message!;
    const from = message.from;
    const text = message.text ?? message.caption ?? "";
    const owner = this.getOwnerIds();
    const pairingMode = this.repo.isPairingMode();

    // Pairing (or re-pairing) requires the locally generated code; the code is
    // validated before any owner check so a local re-pair can change the owner.
    if (pairingMode && from && message.chat.type === "private") {
      const maybePairing = parseCommandText(text);
      if (maybePairing.type === "start" && maybePairing.code) {
        const result = this.pairing.submitPairingCode(maybePairing.code, from, String(message.chat.id));
        if (result.ok) {
          this.outbox?.enqueue({
            logicalKey: `pair:${update.update_id}`,
            kind: "text",
            chatId: String(message.chat.id),
            payload: { text: "Code accepted. Waiting for local confirmation on the PC.", variant: "pair", replyToMessageId: message.message_id },
          });
          this.repo.admitUpdate(update.update_id, { kind: "message", decision: "paired", messageTs: message.date });
          this.repo.setReceiveCursor(update.update_id);
          this.logger.info("pairing.candidate", "Pairing code accepted; awaiting local confirmation.", { eventCode: "PAIRING_CANDIDATE", chatId: String(message.chat.id) });
          return { updateId: update.update_id, decision: "paired" };
        }
      }
    }

    if (!owner) {
      // Silent rejection: do not reveal controller state to unauthorized senders.
      this.repo.admitUpdate(update.update_id, { kind: "message", decision: "rejected", messageTs: message.date });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "rejected" };
    }

    const auth = this.authorizer.checkMessage(message);
    if (!auth.ok) {
      this.authorizer.logRejection("message", auth.reason, update.update_id);
      this.repo.admitUpdate(update.update_id, { kind: "message", decision: "rejected", messageTs: message.date });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "rejected" };
    }

    // An answer to a pending owner question. Plain text while waiting is the answer.
    const active = this.repo.getActiveJob();
    if (active && active.state === "waiting_for_owner" && !text.startsWith("/")) {
      const pending = this.questions.findPendingForJob(active.id);
      if (pending) {
        const controlId = this.repo.insertControl({ sourceUpdateId: update.update_id, jobId: active.id, command: encodeControl({ type: "answer_question", questionId: pending.id, answer: text }) });
        this.repo.admitUpdate(update.update_id, { kind: "message", decision: "question_answer", messageTs: message.date, controlId, jobId: active.id });
        this.repo.setReceiveCursor(update.update_id);
        return { updateId: update.update_id, decision: "question_answer", controlId, jobId: active.id, highPriority: true };
      }
    }

    const parsed = parseCommandText(text);
    if (parsed.type === "unknown_command") {
      const controlId = this.repo.insertControl({ sourceUpdateId: update.update_id, jobId: active?.id ?? null, command: encodeControl({ type: "help" }) });
      this.repo.admitUpdate(update.update_id, { kind: "message", decision: "control", messageTs: message.date, controlId });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "control", controlId, highPriority: false };
    }
    if (parsed.type !== "task") {
      const stored: StoredControl =
        parsed.type === "approve" ? { type: "approval", approvalId: parsed.approvalId, decision: "approve" } : parsed.type === "reject" ? { type: "approval", approvalId: parsed.approvalId, decision: "reject" } : parsed;
      const controlId = this.repo.insertControl({ sourceUpdateId: update.update_id, jobId: active?.id ?? null, command: encodeControl(stored) });
      this.repo.admitUpdate(update.update_id, { kind: "message", decision: "control", messageTs: message.date, controlId });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "control", controlId, highPriority: isHighPriority(stored) };
    }

    return this.admitTask(update, message, parsed.text);
  }

  private admitTask(update: TgUpdate, message: TgMessage, text: string): Admission {
    const trimmed = text.trim();
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasDocument = Boolean(message.document);

    // Media groups become one ordered job: merge into the group's existing job.
    if (message.media_group_id) {
      const existing = this.mergeMediaGroup(message.media_group_id, message);
      if (existing) {
        this.repo.admitUpdate(update.update_id, { kind: "message", decision: "job", messageTs: message.date, jobId: existing });
        this.repo.setReceiveCursor(update.update_id);
        return { updateId: update.update_id, decision: "job", jobId: existing };
      }
    }

    const taskText = trimmed.length > 0 ? trimmed : hasPhoto || hasDocument ? "Describe the attached image." : "";
    if (taskText.length === 0) {
      const controlId = this.repo.insertControl({ sourceUpdateId: update.update_id, jobId: null, command: encodeControl({ type: "help" }) });
      this.repo.admitUpdate(update.update_id, { kind: "message", decision: "control", messageTs: message.date, controlId });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "control", controlId, highPriority: false };
    }

    if (this.repo.countQueued() >= this.config.jobs.maxQueued) {
      this.outbox?.enqueue({
        logicalKey: `reject-queue-full:${update.update_id}`,
        kind: "text",
        payload: { text: `Queue is full (${this.config.jobs.maxQueued} jobs). Use /stop to cancel the active job or wait for it to finish.`, variant: "reject", replyToMessageId: message.message_id },
      });
      this.repo.admitUpdate(update.update_id, { kind: "message", decision: "rejected", messageTs: message.date });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "rejected" };
    }

    // A new explicit task clears a stop suspension; older queued jobs become
    // explicitly-confirmed starts so they cannot run unexpectedly.
    if (this.repo.isDispatchSuspended()) {
      for (const job of this.repo.listQueuedJobs()) {
        if (job.state === "queued") {
          this.repo.transitionJob(job.id, "awaiting_start", { reason: "dispatch resumed by new task; explicit start required" });
          this.repo.markJobStale(job.id, true);
        }
      }
      this.repo.setDispatchSuspended(false);
    }

    const messageAgeMs = message.date * 1000;
    const stale = this.config.jobs.autoStartMaxAgeSeconds > 0 && Date.now() - messageAgeMs > this.config.jobs.autoStartMaxAgeSeconds * 1000;
    const owner = this.getOwnerIds()!;
    const conversation = this.repo.ensureConversation(owner.ownerUserId, owner.ownerChatId);
    const attachments = serializeAttachments(message);
    const modelSnapshot = conversation.next_model_json ?? JSON.stringify(this.defaultModelSnapshot());
    const job = this.repo.createJob({
      sourceUpdateId: update.update_id,
      sourceMessageId: message.message_id,
      conversationId: conversation.id,
      taskText,
      taskLabel: taskLabel(taskText),
      state: stale ? "awaiting_start" : "queued",
      configHash: this.deps.runId,
      modelJson: modelSnapshot,
      stale,
      attachmentsJson: attachments,
    });
    if (stale) this.repo.markJobStale(job.id, true);
    if (message.media_group_id) this.mediaGroups.set(message.media_group_id, { jobId: job.id, at: Date.now() });

    if (stale) {
      this.outbox?.enqueue({
        logicalKey: `ack:${job.id}`,
        kind: "text",
        payload: {
          text: `Job ${job.id} received, but it is older than ${Math.round(this.config.jobs.autoStartMaxAgeSeconds / 60)} minutes. It will not start automatically. Use /run-next to start it or /cancel ${job.id} to discard it.`,
          variant: "ack",
          replyToMessageId: message.message_id,
        },
      });
    } else if (this.repo.getActiveJob() || this.repo.countQueued() > 1) {
      // Only queue acknowledgements are visible; immediate jobs reply directly.
      this.outbox?.enqueue({
        logicalKey: `ack:${job.id}`,
        kind: "text",
        payload: { text: `Job ${job.id} queued behind current work.`, variant: "ack", replyToMessageId: message.message_id },
      });
    }
    this.repo.admitUpdate(update.update_id, { kind: "message", decision: "job", messageTs: message.date, jobId: job.id });
    this.repo.setReceiveCursor(update.update_id);
    return { updateId: update.update_id, decision: "job", jobId: job.id };
  }

  private admitCallback(update: TgUpdate): Admission {
    const query = update.callback_query!;
    const auth = this.authorizer.checkCallback(query);
    if (!auth.ok || !query.message) {
      this.authorizer.logRejection("callback_query", auth.reason, update.update_id);
      this.repo.admitUpdate(update.update_id, { kind: "callback_query", decision: "rejected" });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "rejected" };
    }
    const action = parseCallbackData(query.data);
    let stored: StoredControl | undefined;
    let jobId: string | null = null;
    let highPriority = true;
    switch (action.type) {
      case "approval": {
        stored = { type: "approval", approvalId: action.approvalId, decision: action.decision };
        const approval = this.approvals.get(action.approvalId);
        jobId = approval?.job_id ?? null;
        break;
      }
      case "start_job":
        stored = { type: "start_job", jobId: action.jobId };
        jobId = action.jobId;
        break;
      case "discard_job":
        stored = { type: "discard_job", jobId: action.jobId };
        jobId = action.jobId;
        break;
      case "resume_job":
        stored = { type: "resume_job", jobId: action.jobId };
        jobId = action.jobId;
        break;
      default:
        stored = undefined;
    }
    if (!stored) {
      this.repo.admitUpdate(update.update_id, { kind: "callback_query", decision: "rejected" });
      this.repo.setReceiveCursor(update.update_id);
      return { updateId: update.update_id, decision: "rejected" };
    }
    const controlId = this.repo.insertControl({ sourceUpdateId: update.update_id, jobId, command: encodeControl(stored) });
    this.repo.admitUpdate(update.update_id, { kind: "callback_query", decision: "approval", controlId, jobId });
    this.repo.setReceiveCursor(update.update_id);
    // Answer the callback promptly so the client spinner stops.
    if (this.client) {
      void this.client.answerCallbackQuery(query.id).catch(() => undefined);
    }
    return { updateId: update.update_id, decision: "approval", controlId, jobId: jobId ?? undefined, highPriority };
  }

  // ------------------------------------------------------------------ scheduling notifications

  async onAdmitted(admissions: Admission[]): Promise<void> {
    const hasJobs = admissions.some((admission) => admission.decision === "job");
    if (hasJobs) this.scheduler.notify();
    // Apply any remaining controls (non-high-priority and any missed).
    await this.applyPendingControls();
  }

  private handleSchedulerEvent(event: SchedulerEvent): void {
    switch (event.type) {
      case "job_started": {
        // Chat-style UX: the typing indicator is the only "started" signal.
        break;
      }
      case "job_finished": {
        const text = event.job.result_text && event.job.result_text.trim().length > 0 ? event.job.result_text.trim() : "Done.";
        const parts = withPartNumbering(splitMessage(text));
        parts.forEach((part, index) => {
          this.enqueueOwnerText(`final:${event.job.id}:${index + 1}`, part, { variant: "final" });
        });
        break;
      }
      case "job_failed": {
        const message = event.error.errorMessage ?? "unknown error";
        this.enqueueOwnerText(`failed:${event.job.id}`, `Job ${event.job.id} failed (${event.error.errorCode ?? "ERROR"}).\n${message}`, { variant: "error" });
        break;
      }
      case "job_cancelled": {
        this.enqueueOwnerText(`cancelled:${event.job.id}`, `Job ${event.job.id} cancelled.\nReason: ${event.reason}`, { variant: "error" });
        break;
      }
      case "job_interrupted": {
        this.enqueueOwnerText(`interrupted:${event.job.id}`, `Job ${event.job.id} was interrupted.\n${event.reason}`, { variant: "error" });
        break;
      }
      case "stale_awaiting_start": {
        const queued = this.repo.listQueuedJobs().map((job) => `- ${job.id} ${job.task_label}`);
        this.enqueueOwnerText(
          `stale:${event.job.id}`,
          `Job ${event.job.id} is older than the automatic-start window and will not start by itself.\nUse /run-next to start it or /cancel ${event.job.id} to discard it.${queued.length ? `\n\nQueued:\n${queued.join("\n")}` : ""}`,
          { variant: "progress" },
        );
        break;
      }
      case "queue_changed":
        break;
    }
  }

  // ------------------------------------------------------------------ controls

  private async applyPendingControls(): Promise<void> {
    for (const pending of this.repo.listPendingControls()) {
      await this.applyControlById(pending.id);
    }
  }

  async applyControlById(controlId: string): Promise<void> {
    const row = this.repo.getControl(controlId);
    if (!row || row.applied_at) return;
    const control = decodeControl(row.command);
    if (!control) {
      this.repo.markControlApplied(controlId);
      return;
    }
    try {
      await this.applyControl(controlId, control);
    } catch (error) {
      this.logger.error("control.failed", "Control execution failed.", { controlId, message: redactString((error as Error).message), eventCode: "CONTROL_FAILED" });
      this.enqueueOwnerText(`control-failed:${controlId}`, `A control command failed: ${redactString((error as Error).message)}`, { variant: "error" });
    } finally {
      this.repo.markControlApplied(controlId);
    }
  }

  private replyForControl(controlId: string, text: string, replyToMessageId?: number, variant = "control"): void {
    this.outbox?.enqueue({ logicalKey: `ctl:${controlId}:reply`, kind: "text", payload: { text, variant, replyToMessageId } });
  }

  private async applyControl(controlId: string, control: StoredControl): Promise<void> {
    switch (control.type) {
      case "help":
        this.replyForControl(controlId, buildHelpText());
        return;
      case "status":
        this.replyForControl(controlId, await this.buildStatusText());
        return;
      case "queue":
        this.replyForControl(controlId, this.buildQueueText());
        return;
      case "pause":
        await this.handlePause(controlId);
        return;
      case "resume":
        await this.handleResume(controlId);
        return;
      case "stop":
        await this.handleStop(controlId, false);
        return;
      case "stop_all":
        await this.handleStop(controlId, true);
        return;
      case "cancel":
        await this.handleCancel(controlId, control.jobId);
        return;
      case "run_next":
        this.repo.setDispatchSuspended(false);
        this.scheduler.notify();
        this.replyForControl(controlId, "Dispatch resumed. Starting the next queued job.");
        return;
      case "screenshot":
        await this.handleScreenshot(controlId, control.scope);
        return;
      case "new":
        this.handleNewConversation(controlId);
        return;
      case "model_show":
        this.replyForControl(controlId, this.buildModelText());
        return;
      case "model_select":
        await this.handleModelSelect(controlId, control);
        return;
      case "provider":
        await this.handleProvider(controlId, control.value);
        return;
      case "thinking":
        await this.handleThinking(controlId, control.level);
        return;
      case "tell":
        await this.handleTell(controlId, control.instruction);
        return;
      case "start":
        this.replyForControl(controlId, buildHelpText());
        return;
      case "start_job": {
        const job = this.repo.getJob(control.jobId);
        if (!job || !["queued", "awaiting_start"].includes(job.state)) {
          this.replyForControl(controlId, `Job ${control.jobId} is not waiting to start.`);
          return;
        }
        this.repo.markJobStale(job.id, false);
        if (job.state === "awaiting_start") this.repo.transitionJob(job.id, "queued", { reason: "owner confirmed start" });
        this.repo.setDispatchSuspended(false);
        this.scheduler.notify();
        this.replyForControl(controlId, `Job ${job.id} will start now.`);
        return;
      }
      case "discard_job": {
        const cancelled = await this.scheduler.cancelQueued(control.jobId);
        this.replyForControl(controlId, cancelled ? `Job ${control.jobId} discarded.` : `Job ${control.jobId} is not in the queue.`);
        return;
      }
      case "resume_job":
        await this.handleResume(controlId, control.jobId);
        return;
      case "approval": {
        const ok = this.approvals.recordDecision(control.approvalId, control.decision);
        if (this.executor.notifyApproval) this.executor.notifyApproval(control.approvalId, control.decision);
        this.replyForControl(controlId, ok ? `Approval ${control.decision === "approve" ? "granted" : "rejected"}.` : "This approval is no longer valid.");
        return;
      }
      case "answer_question": {
        const jobId = this.repo.getControl(controlId)?.job_id;
        const job = jobId ? this.repo.getJob(jobId) : undefined;
        const updated = job && ["running", "waiting_for_owner", "paused", "waiting_for_unlock"].includes(job.state)
          ? this.questions.answerById(control.questionId, job.id, control.answer)
          : undefined;
        if (!updated || updated.answer === null) {
          this.replyForControl(controlId, "This question is no longer waiting for an answer.");
          return;
        }
        // The broker can recover from a missed notification by reading the saved answer.
        this.executor.notifyOwnerAnswer?.(updated.id, updated.answer);
        this.replyForControl(controlId, updated.answer === control.answer ? "Answer delivered." : "This question was already answered. The original answer was kept.");
        return;
      }
    }
  }

  private async handlePause(controlId: string): Promise<void> {
    const active = this.repo.getActiveJob();
    if (!active) {
      this.replyForControl(controlId, "No active job to pause.");
      return;
    }
    if (active.state === "paused" || active.state === "waiting_for_unlock") {
      this.replyForControl(controlId, `Job ${active.id} is already paused. Use /resume to continue.`);
      return;
    }
    this.repo.transitionJob(active.id, "paused", { reason: "owner /pause" });
    await this.executor.pause(active.id);
    this.replyForControl(controlId, `Job ${active.id} paused. No new side effects will run. Use /resume to continue.`);
  }

  private async handleResume(controlId: string, jobId?: string): Promise<void> {
    const active = jobId ? this.repo.getJob(jobId) : this.repo.getActiveJob();
    if (!active) {
      this.replyForControl(controlId, "No paused job to resume.");
      return;
    }
    if (active.state !== "paused" && active.state !== "waiting_for_unlock") {
      this.replyForControl(controlId, `Job ${active.id} is ${active.state}, not paused.`);
      return;
    }
    const availability = this.desktopProbe?.() ?? { available: true };
    if (!availability.available) {
      this.replyForControl(controlId, `Cannot resume: ${availability.reason ?? "desktop unavailable"}.`);
      return;
    }
    this.repo.transitionJob(active.id, "running", { reason: "owner /resume" });
    await this.executor.resume(active.id);
    this.replyForControl(controlId, `Job ${active.id} resumed with a fresh observation.`);
  }

  private async handleStop(controlId: string, all: boolean): Promise<void> {
    this.repo.setDispatchSuspended(true);
    if (all) {
      await this.scheduler.cancelAll("owner /stop all");
      for (const job of this.repo.listActiveJobs()) this.approvals.invalidateForJob(job.id);
      for (const job of this.repo.listQueuedJobs()) this.approvals.invalidateForJob(job.id);
    } else {
      const stopped = await this.scheduler.stopActive("owner /stop");
      if (stopped) this.approvals.invalidateForJob(stopped.id);
    }
    const queued = this.repo.listQueuedJobs();
    const lines = queued.length > 0 ? queued.map((job) => `- ${job.id} ${job.task_label}`).join("\n") : "none";
    this.replyForControl(controlId, `Stopped. Dispatch is suspended.\nQueued: ${lines}\n\nUse /run-next to start the oldest queued task, or send a new task.`);
  }

  private async handleCancel(controlId: string, jobId: string): Promise<void> {
    if (!jobId) {
      this.replyForControl(controlId, "Usage: /cancel <job-id>");
      return;
    }
    const active = this.repo.getActiveJob();
    if (active && active.id === jobId) {
      await this.scheduler.stopActive("owner /cancel");
      this.replyForControl(controlId, `Job ${jobId} cancelled.`);
      return;
    }
    const cancelled = await this.scheduler.cancelQueued(jobId);
    this.replyForControl(controlId, cancelled ? `Job ${jobId} cancelled.` : `Job ${jobId} was not queued.`);
  }

  private async handleScreenshot(controlId: string, scope: "desktop" | "window"): Promise<void> {
    if (!this.screenshotProvider) {
      this.replyForControl(controlId, "Screenshot capture is not available yet (desktop backend not started).");
      return;
    }
    const result = await this.screenshotProvider.capture(scope);
    if ("error" in result) {
      this.replyForControl(controlId, `Screenshot failed: ${result.error}`);
      return;
    }
    this.outbox?.enqueue({
      logicalKey: `ctl:${controlId}:photo`,
      kind: "photo",
      artifactId: result.artifactId,
      payload: { variant: "screenshot", caption: result.caption },
    });
    this.replyForControl(controlId, "Screenshot sent.");
  }

  private handleNewConversation(controlId: string): void {
    const active = this.repo.getActiveJob();
    if (active) {
      this.replyForControl(controlId, `Active job ${active.id}. Stop it first or wait for it to finish before /new.`);
      return;
    }
    const owner = this.getOwnerIds()!;
    const conversation = this.repo.createNewConversation(owner.ownerUserId, owner.ownerChatId);
    this.replyForControl(controlId, `Started a new conversation (${conversation.id.slice(0, 8)}). Old transcripts are preserved.`);
  }

  private buildModelText(): string {
    return buildModelHelpText(this.config.models.selectedSlot, this.config.models.slots, this.config.models.thinking);
  }

  private async handleModelSelect(controlId: string, control: Extract<StoredControl, { type: "model_select" }>): Promise<void> {
    const slotName = control.slot.trim().toLowerCase();
    const slot = this.config.models.slots[slotName];
    if (!slot) {
      this.replyForControl(controlId, `Unknown model slot "${slotName}".\n\n${this.buildModelText()}`);
      return;
    }
    const modelId = (control.modelId ?? "").trim();
    if (!modelId) {
      const next = validateConfig({ ...this.config, models: { ...this.config.models, selectedSlot: slotName } });
      this.saveConfig(next);
      const thinking = slot.thinking ?? next.models.thinking;
      this.replyForControl(controlId, `Active model: ${slotName} → ${slot.provider}/${slot.modelId} (thinking ${thinking}) for the next job.`);
      return;
    }

    // Validate against the real catalog for cloud providers; local endpoints accept any id.
    let note = "";
    let updatedSlot = { ...slot, modelId };
    if (!slot.endpoint) {
      if (this.modelValidator) {
        const validation = await this.modelValidator.validate(slot.provider, modelId);
        if (!validation.ok) {
          this.replyForControl(controlId, `Model not accepted: ${validation.message}`);
          return;
        }
      } else {
        const info = await getCatalogModel(this.config, this.paths, slot.provider, modelId);
        if (!info) {
          const alternatives = (await listProviderModels(this.config, this.paths, slot.provider)).slice(0, 12).map((model) => model.id);
          this.replyForControl(controlId, `Model "${modelId}" was not found for ${slot.provider}.${alternatives.length ? `\nExamples: ${alternatives.join(", ")}` : ""}\n\n${this.buildModelText()}`);
          return;
        }
      }
    } else {
      const declared = slot.endpoint.models ?? [];
      if (!declared.some((model) => model.id === modelId)) {
        updatedSlot = {
          ...updatedSlot,
          endpoint: {
            ...slot.endpoint,
            models: [...declared, { id: modelId, name: modelId, input: ["text"], contextWindow: 32768, maxTokens: 8192, reasoning: false }],
          },
        };
      }
      note = "\nLocal endpoint model; capabilities default to text-only until you refine them in the Setup guide.";
    }

    // Changing the OpenRouter model invalidates a provider restriction.
    if (slot.provider === "openrouter") {
      note = slot.modelId !== modelId ? "\nProvider restriction was reset because the model changed. Choose /provider <slug> or /provider auto." : note;
      updatedSlot = { ...updatedSlot, routing: undefined };
    }
    const next = validateConfig({
      ...this.config,
      models: { ...this.config.models, selectedSlot: slotName, slots: { ...this.config.models.slots, [slotName]: updatedSlot } },
    });
    this.saveConfig(next);
    if (slot.provider === "openrouter") updateOpenRouterRouting(next, this.paths, modelId, undefined);
    this.replyForControl(controlId, `Slot ${slotName} set to ${slot.provider}/${modelId} for the next job.${note}`);
  }

  private async handleProvider(controlId: string, value: string): Promise<void> {
    const slug = value.trim();
    if (!slug) {
      this.replyForControl(controlId, "Usage: /provider <provider-slug> or /provider auto");
      return;
    }
    const openrouterSlot = this.config.models.slots.openrouter;
    if (!openrouterSlot) {
      this.replyForControl(controlId, "No OpenRouter slot is configured. Add one in the Setup guide first.");
      return;
    }
    const modelId = openrouterSlot.modelId;
    if (slug.toLowerCase() === "auto") {
      const next = validateConfig({
        ...this.config,
        models: {
          ...this.config.models,
          slots: { ...this.config.models.slots, openrouter: { ...this.config.models.slots.openrouter, routing: { allow_fallbacks: true } } },
        },
      });
      this.saveConfig(next);
      updateOpenRouterRouting(next, this.paths, modelId, undefined);
      this.replyForControl(controlId, `OpenRouter routing set to automatic for ${modelId}. Fallbacks are allowed. Future jobs only; the current job keeps its snapshot.`);
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      this.replyForControl(controlId, "Provider slug must contain only letters, digits, dots, underscores, or hyphens.");
      return;
    }
    const next = validateConfig({
      ...this.config,
      models: {
        ...this.config.models,
        slots: { ...this.config.models.slots, openrouter: { ...this.config.models.slots.openrouter, routing: { only: [slug], allow_fallbacks: false } } },
      },
    });
    this.saveConfig(next);
    updateOpenRouterRouting(next, this.paths, modelId, { only: [slug], allow_fallbacks: false });
    this.replyForControl(controlId, `OpenRouter restricted to "${slug}" with fallbacks disabled for ${modelId}. An unavailable provider will fail explicitly; no alternate provider is used.`);
  }

  private async handleThinking(controlId: string, level: string): Promise<void> {
    const selectedSlot = this.config.models.selectedSlot;
    const slot = this.config.models.slots[selectedSlot];
    if (!slot) {
      this.replyForControl(controlId, "No active model slot. Configure one in the Setup guide or with /model <slot>.");
      return;
    }
    const metadata = findCachedModel(this.paths, slot.provider, slot.modelId);
    const catalogInfo = slot.endpoint ? undefined : await getCatalogModel(this.config, this.paths, slot.provider, slot.modelId);
    const map: Record<string, string | null> =
      metadata?.thinkingLevelMap ??
      (catalogInfo ? Object.fromEntries(catalogInfo.thinkingLevels.map((levelName) => [levelName, levelName])) : {});
    const valid = Object.entries(map)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}${value === key ? "" : ` -> ${value}`}`);
    let effective = level;
    let note = "";
    if (slot.provider === "deepseek" && level === "xhigh") {
      effective = "max";
      note = "\nDeepSeek uses max; selected max.";
    }
    const accepted = Object.entries(map).some(([key, value]) => value !== null && (key === effective || value === effective));
    if (!effective || (!accepted && valid.length > 0)) {
      this.replyForControl(controlId, `Invalid thinking level for ${slot.provider}/${slot.modelId}. Accepted: ${valid.length ? valid.join(", ") : "unknown (catalog metadata missing)"}.`);
      return;
    }
    if (!accepted && valid.length === 0) {
      note = "\nNo thinking metadata for this model; the level will be clamped by the runtime.";
    }
    const next = validateConfig({
      ...this.config,
      models: {
        ...this.config.models,
        thinking: effective as AppConfig["models"]["thinking"],
        slots: { ...this.config.models.slots, [selectedSlot]: { ...slot, thinking: effective as AppConfig["models"]["thinking"] } },
      },
    });
    this.saveConfig(next);
    this.replyForControl(controlId, `Thinking level for slot ${selectedSlot} set to ${effective} for the next job.${note}`);
  }

  private async handleTell(controlId: string, instruction: string): Promise<void> {
    if (!instruction) {
      this.replyForControl(controlId, "Usage: /tell <instruction>");
      return;
    }
    const active = this.repo.getActiveJob();
    if (!active) {
      this.replyForControl(controlId, "No active job to steer.");
      return;
    }
    const ok = await this.executor.steer(active.id, instruction);
    this.replyForControl(controlId, ok ? `Steering instruction queued for job ${active.id}; it applies at the next safe boundary.` : `Could not steer job ${active.id}; the worker is not accepting steering instructions.`);
  }

  private saveConfig(next: AppConfig): void {
    this.config = saveConfigAtomic(this.deps.configPath, next);
    this.scheduler.updateConfig(this.config);
    try {
      this.configMtimeMs = statSync(this.deps.configPath).mtimeMs;
    } catch {
      /* keep previous mtime */
    }
    this.logger.info("config.updated", "Configuration updated atomically.", { eventCode: "CONFIG_UPDATED" });
  }

  /** Pick up owner IDs and settings written by the local pairing/config flow. */
  private reloadConfigIfChanged(): void {
    try {
      const stat = statSync(this.deps.configPath);
      if (stat.mtimeMs === this.configMtimeMs) return;
      this.configMtimeMs = stat.mtimeMs;
      const next = loadConfig(this.deps.configPath);
      if (next.telegram.tokenSecretName !== this.config.telegram.tokenSecretName) {
        this.logger.warn("config.reload_restart_required", "Token secret name changed; restart the controller to apply it.", { eventCode: "CONFIG_RESTART_REQUIRED" });
      }
      const ownerChanged = next.telegram.ownerUserId !== this.config.telegram.ownerUserId || next.telegram.ownerChatId !== this.config.telegram.ownerChatId;
      this.config = next;
      this.scheduler.updateConfig(next);
      if (ownerChanged) this.logger.info("config.owner_reloaded", "Owner pairing configuration reloaded.", { eventCode: "OWNER_RELOADED", paired: Boolean(next.telegram.ownerUserId) });
    } catch (error) {
      this.logger.warn("config.reload_failed", "Configuration file changed but could not be reloaded.", { eventCode: "CONFIG_RELOAD_FAILED", message: redactString((error as Error).message) });
    }
  }

  // ------------------------------------------------------------------ status text

  private buildQueueText(): string {
    const queued = this.repo.listQueuedJobs();
    if (queued.length === 0) return "Queue is empty.";
    const lines = queued.map((job) => {
      const age = formatDuration(Date.now() - Date.parse(job.created_at));
      return `- ${job.id} [${job.state}] ${job.task_label} (${age} ago)`;
    });
    return `Queued jobs:\n${lines.join("\n")}`;
  }

  async buildStatusText(): Promise<string> {
    const active = this.repo.getActiveJob();
    const availability = this.desktopProbe?.();
    const lines: string[] = [];
    lines.push(`Controller: ${this.deps.runId}${this.fatal ? " (transport error - see local log)" : ""}`);
    lines.push(`Time: ${nowInTimeZone(this.config.timeZone)}`);
    if (active) {
      const elapsed = active.started_at ? formatDuration(Date.now() - Date.parse(active.started_at)) : "not started";
      const last = this.repo.lastEventSummary(active.id) ?? "no events yet";
      lines.push(`Active job: ${active.id} [${active.state}] ${active.task_label}`);
      lines.push(`Elapsed: ${elapsed}; tools: ${active.tool_calls}; model turns: ${active.model_turns}`);
      lines.push(`Last step: ${last}`);
    } else {
      lines.push("Active job: none");
    }
    lines.push(`Queued: ${this.repo.countQueued()}${this.repo.isDispatchSuspended() ? " (dispatch suspended; /run-next to resume)" : ""}`);
    const slotName = this.config.models.selectedSlot;
    const slot = this.config.models.slots[slotName];
    lines.push(`Active slot: ${slotName}`);
    if (slot) {
      lines.push(`Model: ${slot.provider}/${slot.modelId}`);
      lines.push(`Thinking: ${slot.thinking ?? this.config.models.thinking}`);
      if (slot.provider === "openrouter") {
        const routing = slot.routing;
        lines.push(`OpenRouter routing: ${routing?.only?.length ? `only=${routing.only.join(",")}, fallbacks=${routing.allow_fallbacks === false ? "off" : "on"}` : "automatic"}`);
      }
      if (slot.endpoint) lines.push(`Endpoint: ${slot.endpoint.baseUrl} (${slot.endpoint.api})`);
    } else {
      lines.push("Model: not configured (run /model <slot>)");
    }
    lines.push(`Slots: ${Object.keys(this.config.models.slots ?? {}).join(", ")}`);
    lines.push(`Desktop: ${availability ? (availability.available ? `available${availability.detail ? ` (${availability.detail})` : ""}` : `unavailable: ${availability.reason ?? "unknown"}`) : "unknown"}`);
    const owner = this.getOwnerIds();
    lines.push(`Paired: ${owner ? "yes" : "no"}`);
    lines.push(`Outbox pending: ${this.outbox?.countPending() ?? 0}`);
    const counts = this.repo.stateCounts();
    const summary = Object.entries(counts)
      .map(([state, n]) => `${state}=${n}`)
      .join(" ");
    lines.push(`Jobs: ${summary || "none"}`);
    return lines.join("\n");
  }

  /** Outbox access for broker-registered tools (undefined before Telegram starts). */
  outboxForBroker(): Outbox | undefined {
    return this.outbox;
  }

  private lastProgressAt = new Map<string, number>();

  /** Throttled owner-visible progress notification. */
  notifyProgress(jobId: string, summary: string): void {
    const minIntervalMs = this.config.notifications.progressMinimumIntervalSeconds * 1000;
    const now = Date.now();
    const last = this.lastProgressAt.get(jobId) ?? 0;
    if (now - last < minIntervalMs) return;
    this.lastProgressAt.set(jobId, now);
    this.enqueueOwnerText(`progress:${jobId}:${now}`, `Job ${jobId}: ${summary}`, { variant: "progress" });
  }

  /**
   * Record live model/dashboard output. Thinking and answer deltas are aggregated
   * into a single row per contiguous block so history stays complete; explicit
   * *_end markers close a block for the dashboard to collapse.
   */
  recordStream(jobId: string, kind: "thinking" | "thinking_end" | "answer" | "answer_end" | "tool" | "state" | "error" | "usage", text: string): void {
    if (kind === "thinking_end" || kind === "answer_end") {
      // Closing is resolved at flush time so buffered text for this block is
      // appended before the marker is written.
      this.streamBuffer.push({ jobId, kind, text: "" });
      this.flushStreamEvents();
      return;
    }
    if (kind === "thinking" || kind === "answer") {
      if (!text) return;
      const last = this.streamBuffer[this.streamBuffer.length - 1];
      if (last && last.jobId === jobId && last.kind === kind) {
        last.text += text;
      } else {
        // Opening a different run is resolved at flush time, in order, so a
        // partially flushed block is never split into two rows.
        this.streamBuffer.push({ jobId, kind, text });
      }
      if (this.streamBuffer.length >= 200) this.flushStreamEvents();
      return;
    }
    // Single-shot events (tool, state, error, usage) close any open text block.
    this.streamBuffer.push({ jobId, kind, text });
    this.flushStreamEvents();
  }

  /** Record exact provider usage and cost for one assistant response. */
  recordModelUsage(jobId: string, usage: ModelUsageMessage): void {
    try {
      this.db
        .prepare(
          "INSERT INTO usage_events(timestamp, job_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, duration_ms, ttft_ms, stream_ms, response_open_ms, preparation_ms, context_bytes, image_count, image_base64_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(new Date().toISOString(), jobId, usage.provider, usage.model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, usage.costUsd, usage.durationMs ?? null, usage.ttftMs ?? null, usage.streamMs ?? null, usage.responseOpenMs ?? null, usage.preparationMs ?? null, usage.contextBytes ?? null, usage.imageCount ?? null, usage.imageBase64Bytes ?? null);
      const wallSeconds = usage.durationMs && usage.durationMs > 0 ? usage.durationMs / 1000 : undefined;
      // Decode throughput excludes queueing/prefill/network: the streaming window only.
      const decodeSeconds = usage.streamMs && usage.streamMs > 0 ? usage.streamMs / 1000 : wallSeconds;
      const tokensPerSecond = decodeSeconds ? usage.outputTokens / decodeSeconds : undefined;
      const ttftSeconds = usage.ttftMs !== undefined && usage.ttftMs > 0 ? usage.ttftMs / 1000 : undefined;
      this.logger.info("usage.recorded", "Model usage recorded.", {
        jobId,
        eventCode: "USAGE_RECORDED",
        model: `${usage.provider}/${usage.model}`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        contextBytes: usage.contextBytes,
        imageCount: usage.imageCount,
        imageBase64Bytes: usage.imageBase64Bytes,
        responseOpenMs: usage.responseOpenMs,
        preparationMs: usage.preparationMs,
        costUsd: usage.costUsd,
        ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
        ...(usage.ttftMs !== undefined ? { ttftMs: usage.ttftMs } : {}),
        ...(usage.streamMs !== undefined ? { streamMs: usage.streamMs } : {}),
        ...(tokensPerSecond !== undefined ? { tokensPerSecond: Number(tokensPerSecond.toFixed(1)) } : {}),
      });
      const number = (value: number) => value.toLocaleString("en-US");
      const summary = [
        `in=${number(usage.inputTokens)}`,
        `out=${number(usage.outputTokens)}`,
        usage.reasoningTokens > 0 ? `reasoning=${number(usage.reasoningTokens)}` : undefined,
        usage.cacheReadTokens > 0 ? `cache=${number(usage.cacheReadTokens)}` : undefined,
        tokensPerSecond !== undefined ? `${tokensPerSecond.toFixed(1)} tok/s` : undefined,
        ttftSeconds !== undefined ? `ttft ${ttftSeconds.toFixed(1)}s` : undefined,
        wallSeconds !== undefined ? `wall ${wallSeconds.toFixed(1)}s` : undefined,
        usage.costUsd > 0 ? `$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(5) : usage.costUsd.toFixed(4)}` : "$0",
      ]
        .filter(Boolean)
        .join(" · ");
      this.recordStream(jobId, "usage", `${usage.provider}/${usage.model} — ${summary}`);
    } catch (error) {
      this.logger.debug("usage.record_failed", "Could not record model usage.", { jobId, eventCode: "USAGE_RECORD_FAILED", detail: (error as Error).message });
    }
  }

  private flushStreamEvents(): void {
    if (this.streamBuffer.length === 0) return;
    const batch = this.streamBuffer;
    this.streamBuffer = [];
    try {
      this.db.transaction(() => {
        const now = new Date().toISOString();
        const append = this.db.prepare("UPDATE stream_events SET text = CASE WHEN length(text) >= 300000 THEN text ELSE text || ? END, updated_at = ? WHERE id = ?");
        const insert = this.db.prepare("INSERT INTO stream_events(timestamp, updated_at, job_id, kind, text) VALUES (?, ?, ?, ?, ?)");
        for (const event of batch) {
          const text = event.text.length > 8000 ? event.text.slice(0, 8000) : event.text;
          if (event.kind === "thinking" || event.kind === "answer") {
            const key = `${event.jobId}\u0000${event.kind}`;
            // A switch between thinking and answer closes the other run so a
            // later block of that kind starts a fresh row.
            this.openStreamRows.delete(`${event.jobId}\u0000${event.kind === "thinking" ? "answer" : "thinking"}`);
            const open = this.openStreamRows.get(key);
            if (open) {
              append.run(text, now, open.id);
              open.at = Date.now();
            } else {
              const info = insert.run(now, now, event.jobId, event.kind, text);
              this.openStreamRows.set(key, { id: Number(info.lastInsertRowid), at: Date.now() });
            }
          } else {
            const closes = event.kind === "thinking_end" ? ["thinking"] : event.kind === "answer_end" ? ["answer"] : ["thinking", "answer"];
            for (const kind of closes) this.openStreamRows.delete(`${event.jobId}\u0000${kind}`);
            insert.run(now, now, event.jobId, event.kind, text);
          }
        }
      });
    } catch (error) {
      this.logger.debug("stream.flush_failed", "Could not flush dashboard stream events.", { eventCode: "STREAM_FLUSH_FAILED", detail: (error as Error).message });
    }
  }

  /** Keep dashboard telemetry bounded: 24 hours and at most 20k lines. */
  private pruneTelemetry(): void {
    const now = Date.now();
    if (now - this.lastTelemetryPruneAt < 60000) return;
    this.lastTelemetryPruneAt = now;
    try {
      this.db.prepare("DELETE FROM stream_events WHERE timestamp < ?").run(new Date(now - 24 * 3600 * 1000).toISOString());
      this.db.prepare("DELETE FROM stream_events WHERE id < (SELECT COALESCE(MAX(id), 0) FROM stream_events) - 20000").run();
    } catch {
      /* telemetry pruning is best effort */
    }
  }

  /** Snapshot of the active slot for a new job (per-slot thinking falls back to global). */
  private defaultModelSnapshot(): { slot: string; provider: string; modelId: string; thinking: string } {
    const slotName = this.config.models.selectedSlot;
    const slot = this.config.models.slots[slotName];
    if (!slot) return { slot: slotName, provider: "deepseek", modelId: "deepseek-flash", thinking: this.config.models.thinking };
    return { slot: slotName, provider: slot.provider, modelId: slot.modelId, thinking: slot.thinking ?? this.config.models.thinking };
  }

  /** Enqueue a plain text message to the owner (logical key must be unique). */
  enqueueOwnerText(logicalKey: string, text: string, options: { variant: string; replyToMessageId?: number }): void {
    this.outbox?.enqueue({ logicalKey, kind: "text", payload: { text, variant: options.variant, replyToMessageId: options.replyToMessageId } });
  }

  /** Local status snapshot for the local CLI (no Telegram side effects). */
  localStatus(): Record<string, unknown> {
    const active = this.repo.getActiveJob();
    return {
      runId: this.deps.runId,
      pid: process.pid,
      stopping: this.stopping,
      fatal: this.fatal ? redactString(this.fatal.message) : null,
      activeJob: active ? { id: active.id, state: active.state, label: active.task_label } : null,
      queued: this.repo.countQueued(),
      dispatchSuspended: this.repo.isDispatchSuspended(),
      pairing: this.repo.isPairingMode(),
      paired: Boolean(this.getOwnerIds()),
    };
  }
}

function serializeAttachments(message: TgMessage): string | null {
  const photos = (message.photo ?? []).map((photo) => ({ fileId: photo.file_id, width: photo.width, height: photo.height, fileSize: photo.file_size }));
  const documents = message.document ? [{ fileId: message.document.file_id, fileName: message.document.file_name, mimeType: message.document.mime_type, fileSize: message.document.file_size }] : [];
  if (photos.length === 0 && documents.length === 0) return null;
  return JSON.stringify({ photos, documents, mediaGroupId: message.media_group_id ?? null });
}
