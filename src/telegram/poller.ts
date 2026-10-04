/**
 * Durable Telegram long-polling loop.
 *
 * Receive sequence (per the implementation contract):
 *   receive batch -> for each update in update_id order:
 *     short transaction: insert update_id (unique), persist deterministic
 *     intent, advance receive cursor, commit
 *   after the whole batch: apply high-priority controls, then notify scheduler
 *
 * The poller never awaits a job. Network failures back off with jitter.
 */
import { Logger, redactString } from "../logging.js";
import { JobRepository } from "../jobs/repository.js";
import { TelegramApiError, TelegramAuthError, TelegramConflictError, TelegramNetworkError, TelegramRateLimitError, TelegramClient, type TgUpdate } from "./api.js";

export interface Admission {
  updateId: number;
  decision: "job" | "control" | "rejected" | "paired" | "question_answer" | "approval" | "noop";
  jobId?: string;
  controlId?: string;
  highPriority?: boolean;
  /** Persistent user-visible effect produced by admission (queued outbox etc.). */
  note?: string;
}

export interface PollerHost {
  /** Synchronous: performs short durable transactions. Never awaits I/O. */
  admitBatch(updates: TgUpdate[]): Admission[];
  /** Called after the batch is committed and high-priority controls applied. */
  onAdmitted(admissions: Admission[]): Promise<void> | void;
  /** High-priority persisted controls (stop/pause/resume/screenshot) applied immediately. */
  onHighPriorityControl(admission: Admission): Promise<void> | void;
  /** Transport-level fatal condition (bad token, competing poller). */
  onFatal(error: Error): void;
}

export interface PollerOptions {
  pollTimeoutSeconds: number;
  allowedUpdates: Array<"message" | "callback_query">;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  conflictMaxAttempts?: number;
}

export class TelegramPoller {
  private stopped = false;
  private conflictAttempts = 0;
  private currentAbort: AbortController | undefined;

  constructor(
    private readonly client: TelegramClient,
    private readonly repository: JobRepository,
    private readonly host: PollerHost,
    private readonly options: PollerOptions,
    private readonly logger: Logger,
  ) {}

  stop(): void {
    this.stopped = true;
    this.currentAbort?.abort();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  async run(): Promise<void> {
    let backoffMs = this.options.baseBackoffMs ?? 1000;
    const maxBackoff = this.options.maxBackoffMs ?? 60000;
    const conflictMax = this.options.conflictMaxAttempts ?? 3;
    while (!this.stopped) {
      try {
        await this.pollOnce();
        backoffMs = this.options.baseBackoffMs ?? 1000;
        this.conflictAttempts = 0;
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof TelegramAuthError) {
          this.logger.error("telegram.auth_failed", "Telegram rejected the bot token; polling stopped. Re-run setup or re-pair locally.", { eventCode: "TELEGRAM_AUTH" });
          this.host.onFatal(error);
          return;
        }
        if (error instanceof TelegramConflictError) {
          this.conflictAttempts += 1;
          this.logger.error("telegram.conflict", "Another poller or a webhook is using this bot token.", { attempt: this.conflictAttempts, eventCode: "TELEGRAM_CONFLICT" });
          if (this.conflictAttempts >= conflictMax) {
            this.host.onFatal(new Error("Telegram polling conflict: another consumer is using this bot token. Stop it and restart the controller."));
            return;
          }
        } else if (error instanceof TelegramRateLimitError) {
          backoffMs = Math.max(backoffMs, (error.retryAfter + 1) * 1000);
          this.logger.warn("telegram.rate_limited", "Telegram rate limited getUpdates; backing off.", { retryAfterSeconds: error.retryAfter, eventCode: "TELEGRAM_RATE_LIMIT" });
        } else if (error instanceof TelegramNetworkError || error instanceof TelegramApiError) {
          this.logger.warn("telegram.poll_error", "Telegram polling error; backing off.", { message: redactString(error.message), eventCode: "TELEGRAM_POLL_ERROR" });
        } else {
          this.logger.warn("telegram.poll_error", "Unexpected polling error; backing off.", { message: redactString((error as Error).message), eventCode: "TELEGRAM_POLL_ERROR" });
        }
        const jitter = Math.floor(Math.random() * 1000);
        await this.sleep(Math.min(maxBackoff, backoffMs) + jitter);
        backoffMs = Math.min(maxBackoff, Math.max(1000, backoffMs * 2));
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const cursor = this.repository.getReceiveCursor();
    const offset = cursor !== undefined ? cursor + 1 : undefined;
    this.currentAbort = new AbortController();
    let updates: TgUpdate[];
    try {
      updates = await this.client.getUpdates(offset, this.options.pollTimeoutSeconds, this.options.allowedUpdates, this.currentAbort.signal);
    } finally {
      this.currentAbort = undefined;
    }
    if (this.stopped || updates.length === 0) return;
    const admissions = this.host.admitBatch(updates);
    const highPriority = admissions.filter((admission) => admission.highPriority && admission.controlId);
    for (const admission of highPriority) {
      try {
        await this.host.onHighPriorityControl(admission);
      } catch (error) {
        this.logger.error("control.apply_failed", "Failed to apply high-priority control", { controlId: admission.controlId, message: redactString((error as Error).message), eventCode: "CONTROL_FAILED" });
      }
    }
    try {
      await this.host.onAdmitted(admissions);
    } catch (error) {
      this.logger.error("admission.notify_failed", "Failed to notify scheduler about admitted jobs", { message: redactString((error as Error).message), eventCode: "SCHEDULER_NOTIFY_FAILED" });
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (this.stopped) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 200);
      timer.unref?.();
      check.unref?.();
    });
  }
}
