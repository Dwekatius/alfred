/**
 * Durable outbound delivery queue.
 *
 * Every user-visible message is enqueued with a unique logical key so a
 * restart or retry cannot enqueue the same logical response twice. Delivery is
 * separate from task execution: a completed result is never re-run because its
 * delivery failed.
 */
import { randomUUID } from "node:crypto";
import { Logger, redactString } from "../logging.js";
import { Database } from "../storage/database.js";
import { TelegramApiError, TelegramAuthError, TelegramNetworkError, TelegramRateLimitError, TelegramClient } from "./api.js";

export type OutboxState = "pending" | "sending" | "sent" | "failed" | "delivery_unknown";

export interface OutboxPayload {
  text?: string;
  caption?: string;
  filename?: string;
  mime?: string;
  replyToMessageId?: number;
  /**
   * Which logical deliverable this is: "final", "progress", "ack", "screenshot",
   * "question", "approval", "error", ...
   */
  variant: string;
}

export interface EnqueueInput {
  logicalKey: string;
  kind: "text" | "photo" | "document";
  payload: OutboxPayload;
  artifactId?: string;
  /** Override destination (used only during pairing replies). */
  chatId?: string;
}

export interface OutboxRow {
  id: string;
  logical_key: string;
  owner_chat_id: string;
  kind: "text" | "photo" | "document";
  payload_json: string;
  artifact_id: string | null;
  state: OutboxState;
  attempts: number;
  next_attempt_at: string | null;
  telegram_message_id: number | null;
  last_error: string | null;
  delivery_unknown: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactBytesProvider {
  readBytes(artifactId: string): Promise<{ bytes: Buffer; filename: string; mime: string } | undefined>;
  markUploaded?(artifactId: string): void;
}

export interface OutboxOptions {
  /** Resolved at enqueue time so pairing can change the owner chat. */
  getOwnerChatId: () => string | null;
  artifacts: ArtifactBytesProvider;
  logger: Logger;
  /** Minimum spacing between ordinary messages. */
  minimumIntervalMs?: number;
  maxAttempts?: number;
  onAuthError?: (error: Error) => void;
}

export class Outbox {
  private stopped = false;
  private lastSendAt = 0;

  constructor(
    private readonly db: Database,
    private readonly client: TelegramClient,
    private readonly options: OutboxOptions,
  ) {}

  enqueue(input: EnqueueInput): boolean {
    const ownerChatId = input.chatId ?? this.options.getOwnerChatId();
    if (!ownerChatId) return false;
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO outbox(id, logical_key, owner_chat_id, kind, payload_json, artifact_id, state, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        )
        .run(randomUUID(), input.logicalKey, ownerChatId, input.kind, JSON.stringify(input.payload), input.artifactId ?? null, now, now);
      return true;
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) return false;
      throw error;
    }
  }

  getByLogicalKey(key: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(key) as unknown as OutboxRow | undefined;
  }

  get(id: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as unknown as OutboxRow | undefined;
  }

  listPending(limit = 20): OutboxRow[] {
    const now = new Date().toISOString();
    return this.db
      .prepare("SELECT * FROM outbox WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT ?")
      .all(now, limit) as unknown as OutboxRow[];
  }

  countPending(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','sending')").get() as { n: number };
    return row.n;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Delivery loop. Runs until stop(); call with `void outbox.run()`. */
  async run(): Promise<void> {
    while (!this.stopped) {
      const delivered = await this.runOnce();
      if (!delivered) await sleep(500);
    }
  }

  /** Process currently-due pending items once. Returns true when it handled any item. */
  async runOnce(): Promise<boolean> {
    const items = this.listPending();
    if (items.length === 0) return false;
    for (const item of items) {
      if (this.stopped) return true;
      const elapsed = Date.now() - this.lastSendAt;
      const minInterval = this.options.minimumIntervalMs ?? 1000;
      if (elapsed < minInterval) await sleep(minInterval - elapsed);
      await this.deliver(item);
      this.lastSendAt = Date.now();
    }
    return true;
  }

  private async deliver(item: OutboxRow): Promise<void> {
    const logger = this.options.logger.child({ outboxId: item.id, jobId: undefined });
    this.db.prepare("UPDATE outbox SET state = 'sending', updated_at = ? WHERE id = ? AND state = 'pending'").run(new Date().toISOString(), item.id);
    const payload = JSON.parse(item.payload_json) as OutboxPayload;
    try {
      let messageId: number;
      if (item.kind === "text") {
        const result = await this.client.sendMessage(item.owner_chat_id, payload.text ?? "", { replyToMessageId: payload.replyToMessageId });
        messageId = result.message_id;
      } else {
        if (!item.artifact_id) throw new Error("Media outbox item is missing an artifact reference");
        const artifact = await this.options.artifacts.readBytes(item.artifact_id);
        if (!artifact) throw new Error(`Artifact ${item.artifact_id} is not available`);
        if (item.kind === "photo") {
          const result = await this.client.sendPhoto(item.owner_chat_id, artifact.bytes, payload.filename ?? artifact.filename, {
            caption: payload.caption,
            mime: payload.mime ?? artifact.mime,
            replyToMessageId: payload.replyToMessageId,
          });
          messageId = result.message_id;
        } else {
          const result = await this.client.sendDocument(item.owner_chat_id, artifact.bytes, payload.filename ?? artifact.filename, {
            caption: payload.caption,
            mime: payload.mime ?? artifact.mime,
            replyToMessageId: payload.replyToMessageId,
          });
          messageId = result.message_id;
        }
        this.options.artifacts.markUploaded?.(item.artifact_id);
      }
      this.db
        .prepare("UPDATE outbox SET state = 'sent', telegram_message_id = ?, updated_at = ?, last_error = NULL WHERE id = ?")
        .run(messageId, new Date().toISOString(), item.id);
      logger.info("outbox.sent", "Delivered outbox item", { eventCode: "OUTBOX_SENT", kind: item.kind, variant: payload.variant });
    } catch (error) {
      await this.handleFailure(item, error);
    }
  }

  private async handleFailure(item: OutboxRow, error: unknown): Promise<void> {
    const logger = this.options.logger;
    const attempts = item.attempts + 1;
    const now = new Date();
    const message = redactString(error instanceof Error ? error.message : String(error));

    if (error instanceof TelegramAuthError) {
      this.db
        .prepare("UPDATE outbox SET state = 'pending', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, now.toISOString(), item.id);
      logger.error("outbox.auth_error", "Telegram rejected the bot token while delivering; stopping outbox.", { eventCode: "OUTBOX_AUTH" });
      this.stop();
      this.options.onAuthError?.(error);
      return;
    }

    if (error instanceof TelegramRateLimitError) {
      const next = new Date(now.getTime() + (error.retryAfter + 1) * 1000).toISOString();
      this.db
        .prepare("UPDATE outbox SET state = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, next, message, now.toISOString(), item.id);
      logger.warn("outbox.rate_limited", "Telegram rate limited delivery; retry scheduled.", { retryAfterSeconds: error.retryAfter, eventCode: "OUTBOX_RATE_LIMIT" });
      return;
    }

    const maxAttempts = this.options.maxAttempts ?? 3;
    if (error instanceof TelegramNetworkError && attempts >= 2) {
      // The request may have reached Telegram. Do not retry blindly.
      this.db
        .prepare("UPDATE outbox SET state = 'delivery_unknown', attempts = ?, delivery_unknown = 1, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, now.toISOString(), item.id);
      logger.error("outbox.delivery_unknown", "Delivery outcome uncertain after network failure; not retrying blindly.", { eventCode: "OUTBOX_DELIVERY_UNKNOWN" });
      return;
    }

    if (attempts >= maxAttempts || (error instanceof TelegramApiError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
      this.db
        .prepare("UPDATE outbox SET state = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, now.toISOString(), item.id);
      logger.error("outbox.failed", "Outbox delivery failed permanently.", { eventCode: "OUTBOX_FAILED" });
      return;
    }

    const next = new Date(now.getTime() + Math.min(60000, 2000 * 2 ** (attempts - 1))).toISOString();
    this.db
      .prepare("UPDATE outbox SET state = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, next, message, now.toISOString(), item.id);
    logger.warn("outbox.retry", "Outbox delivery failed; retry scheduled.", { attempt: attempts, eventCode: "OUTBOX_RETRY" });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
