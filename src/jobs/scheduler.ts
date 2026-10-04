/**
 * Job scheduler: one active job at a time, bounded queue, freshness checks,
 * deadlines, and cooperative-then-hard cancellation.
 */
import { Logger, redactString } from "../logging.js";
import { AppConfig } from "../config.js";
import { JobRepository, JobRow } from "./repository.js";
import { isTerminal, type JobState } from "./state-machine.js";

export interface JobOutcome {
  state: "succeeded" | "failed" | "cancelled" | "interrupted";
  resultText?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobExecutionContext {
  job: JobRow;
  signal: AbortSignal;
  deadline: number;
}

export interface JobExecutor {
  execute(context: JobExecutionContext): Promise<JobOutcome>;
  /** Request cancellation: cooperative first, hard kill after the grace period. */
  cancel(jobId: string, reason: string): Promise<void>;
  pause(jobId: string): Promise<void>;
  resume(jobId: string): Promise<void>;
  steer(jobId: string, instruction: string): Promise<boolean>;
  /** Notify a blocked tool request that its approval was decided. */
  notifyApproval?(approvalId: string, decision: "approve" | "reject"): void;
  /** Notify a blocked tool request that the owner answered a question. */
  notifyOwnerAnswer?(questionId: string, answer: string): void;
  dispose(): Promise<void>;
}

export type SchedulerEvent =
  | { type: "job_started"; job: JobRow }
  | { type: "job_finished"; job: JobRow }
  | { type: "job_failed"; job: JobRow; error: JobOutcome }
  | { type: "job_cancelled"; job: JobRow; reason: string }
  | { type: "job_interrupted"; job: JobRow; reason: string }
  | { type: "stale_awaiting_start"; job: JobRow }
  | { type: "queue_changed" };

export interface SchedulerOptions {
  repository: JobRepository;
  executor: JobExecutor;
  config: AppConfig;
  logger: Logger;
  onEvent: (event: SchedulerEvent) => void;
  /** Optional desktop availability probe. Return false to pause dispatch. */
  isDesktopAvailable?: () => { available: boolean; reason?: string };
}

export class Scheduler {
  private ticking = false;
  private tickQueued = false;
  private activeJobId: string | null = null;
  private starting = false;
  private config: AppConfig;

  constructor(private readonly options: SchedulerOptions) {
    this.config = options.config;
  }

  /** Swap in a reloaded configuration (model selection, limits) without dropping the queue. */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /** Request a scheduling pass. Safe to call from anywhere. */
  notify(): void {
    if (this.ticking) {
      this.tickQueued = true;
      return;
    }
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.tickQueued = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickQueued = false;
        await this.tickOnce();
      } while (this.tickQueued);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const { repository, logger } = this.options;
    if (this.starting) return;
    const active = repository.getActiveJob();
    if (active) {
      this.activeJobId = active.id;
      return;
    }
    this.activeJobId = null;
    if (repository.isDispatchSuspended()) return;
    if (repository.isPairingMode()) return;

    const next = repository.getNextQueuedJob();
    if (!next) return;

    const ageSeconds = (Date.now() - Date.parse(next.created_at)) / 1000;
    if (this.config.jobs.autoStartMaxAgeSeconds > 0 && ageSeconds > this.config.jobs.autoStartMaxAgeSeconds) {
      repository.transitionJob(next.id, "awaiting_start", { reason: "stale request" });
      repository.markJobStale(next.id, true);
      this.options.onEvent({ type: "stale_awaiting_start", job: repository.getJob(next.id)! });
      return;
    }

    const availability = this.options.isDesktopAvailable?.();
    if (availability && !availability.available && next.kind !== "text") {
      logger.info("scheduler.desktop_unavailable", "Desktop unavailable; not starting desktop job now.", { jobId: next.id, reason: availability.reason, eventCode: "DESKTOP_UNAVAILABLE" });
      return;
    }

    this.starting = true;
    try {
      await this.runJob(next);
    } finally {
      this.starting = false;
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    const { repository, executor, logger } = this.options;
    const config = this.config;
    const leaseGeneration = job.lease_generation + 1;
    repository.setJobLeaseGeneration(job.id, leaseGeneration);
    repository.transitionJob(job.id, "starting", { reason: "scheduler dispatch" });
    this.activeJobId = job.id;
    this.options.onEvent({ type: "job_started", job: repository.getJob(job.id)! });
    this.options.onEvent({ type: "queue_changed" });

    const controller = new AbortController();
    const deadline = Date.now() + config.jobs.maxRunSeconds * 1000;
    const timer = setTimeout(() => {
      logger.warn("scheduler.deadline", "Job exceeded maxRunSeconds; cancelling.", { jobId: job.id, eventCode: "DEADLINE" });
      controller.abort();
    }, config.jobs.maxRunSeconds * 1000);
    timer.unref?.();

    let outcome: JobOutcome;
    try {
      // The executor is responsible for transitioning starting -> running.
      outcome = await executor.execute({ job: repository.getJob(job.id)!, signal: controller.signal, deadline });
    } catch (error) {
      outcome = { state: "failed", errorCode: "WORKER_ERROR", errorMessage: redactString((error as Error).message) };
    } finally {
      clearTimeout(timer);
      this.activeJobId = null;
    }

    const current = repository.getJob(job.id);
    if (!current) return;
    if (isTerminal(current.state)) {
      // Executor already recorded a terminal state (cancellation path).
      this.options.onEvent(this.eventForTerminal(current, outcome));
      this.options.onEvent({ type: "queue_changed" });
      return;
    }

    const targetState: JobState = outcome.state;
    try {
      repository.transitionJob(job.id, targetState, {
        reason: "executor finished",
        resultText: outcome.resultText,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
      });
    } catch (error) {
      logger.error("scheduler.transition_failed", "Failed to persist final job state.", { jobId: job.id, detail: redactString((error as Error).message), eventCode: "TRANSITION_FAILED" });
      // Never leave a job non-terminal when the executor has returned: force a
      // truthful failure so the queue can move and the owner is told.
      try {
        repository.transitionJob(job.id, "failed", {
          reason: "final transition fallback",
          errorCode: "TRANSITION_FAILED",
          errorMessage: `Could not persist ${targetState}: ${redactString((error as Error).message)}`,
        });
      } catch {
        /* the job may already be terminal after a race */
      }
    }
    const finished = repository.getJob(job.id)!;
    this.options.onEvent(this.eventForTerminal(finished, outcome));
    this.options.onEvent({ type: "queue_changed" });
  }

  private eventForTerminal(job: JobRow, outcome: JobOutcome): SchedulerEvent {
    // Terminal event choice mirrors the persisted state when available.
    const state = job.state;
    if (state === "cancelled") {
      return { type: "job_cancelled", job, reason: job.cancel_reason ?? outcome.errorMessage ?? "cancelled" };
    }
    if (state === "failed") {
      return { type: "job_failed", job, error: { ...outcome, state: "failed" } };
    }
    if (state === "interrupted") {
      return { type: "job_interrupted", job, reason: outcome.errorMessage ?? "controller restart" };
    }
    if (state === "succeeded") {
      return { type: "job_finished", job };
    }
    // Terminal states are exhaustive; default to failed for safety.
    return { type: "job_failed", job, error: { ...outcome, state: "failed" } };
  }

  /**
   * Cancel the active job through the executor, then persist the outcome.
   * Used by /stop, /stop all, local stop, and shutdown.
   */
  async stopActive(reason: string): Promise<JobRow | undefined> {
    const { repository, executor, logger } = this.options;
    const active = repository.getActiveJob();
    if (!active) return undefined;
    if (active.state !== "cancelling") {
      try {
        repository.transitionJob(active.id, "cancelling", { reason, cancelReason: reason });
      } catch {
        repository.appendEvent(active.id, { eventType: "cancel", summary: `cancel requested while ${active.state}` });
      }
    }
    // Revoke the lease immediately so queued broker requests are rejected.
    repository.setJobLeaseGeneration(active.id, active.lease_generation + 1);
    try {
      await executor.cancel(active.id, reason);
    } catch (error) {
      logger.error("scheduler.cancel_failed", "Executor cancellation failed; persisting cancelled anyway.", { jobId: active.id, message: redactString((error as Error).message), eventCode: "CANCEL_FAILED" });
    }
    const current = repository.getJob(active.id);
    if (!current) return undefined;
    if (!isTerminal(current.state)) {
      try {
        repository.transitionJob(active.id, "cancelled", { reason, cancelReason: reason, errorCode: "CANCELLED", errorMessage: reason });
      } catch (error) {
        logger.error("scheduler.cancel_transition_failed", "Failed to persist cancelled state.", { jobId: active.id, message: redactString((error as Error).message), eventCode: "CANCEL_TRANSITION_FAILED" });
      }
    }
    const finished = repository.getJob(active.id);
    if (finished) {
      this.options.onEvent({ type: "job_cancelled", job: finished, reason });
      this.options.onEvent({ type: "queue_changed" });
    }
    return finished;
  }

  async cancelQueued(jobId: string): Promise<JobRow | undefined> {
    const job = this.options.repository.getJob(jobId);
    if (!job || !["queued", "awaiting_start"].includes(job.state)) return undefined;
    this.options.repository.transitionJob(jobId, "cancelled", { reason: "cancelled from queue", cancelReason: "cancelled from queue", errorCode: "CANCELLED", errorMessage: "Cancelled before start." });
    const finished = this.options.repository.getJob(jobId);
    if (finished) this.options.onEvent({ type: "job_cancelled", job: finished, reason: "cancelled from queue" });
    return finished;
  }

  async cancelAll(reason: string): Promise<void> {
    const queued = this.options.repository.listQueuedJobs();
    for (const job of queued) {
      await this.cancelQueued(job.id);
    }
    await this.stopActive(reason);
  }

  getActiveJobId(): string | null {
    return this.activeJobId;
  }
}

export class NullExecutor implements JobExecutor {
  async execute(): Promise<JobOutcome> {
    return { state: "succeeded", resultText: "No executor configured." };
  }
  async cancel(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async steer(): Promise<boolean> {
    return false;
  }
  async dispose(): Promise<void> {}
}
