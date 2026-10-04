/**
 * Repository for conversations, jobs, job events, updates, and control intents.
 * All mutations are short and synchronous; no awaits inside transactions.
 */
import { randomUUID } from "node:crypto";
import { Database, getBoolMeta, setBoolMeta } from "../storage/database.js";
import { assertTransition, isActiveState, isTerminal, type JobState } from "./state-machine.js";

export interface ConversationRow {
  id: string;
  owner_user_id: string;
  owner_chat_id: string;
  session_file: string | null;
  created_at: string;
  archived_at: string | null;
  next_model_json: string | null;
}

export interface JobRow {
  id: string;
  source_update_id: number | null;
  source_message_id: number | null;
  conversation_id: string;
  task_text: string;
  task_label: string;
  kind: string;
  state: JobState;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  config_hash: string | null;
  model_json: string | null;
  lease_generation: number;
  result_text: string | null;
  error_code: string | null;
  error_message: string | null;
  linked_job_id: string | null;
  stale: number;
  tool_calls: number;
  model_turns: number;
  paused_at: string | null;
  cancel_reason: string | null;
  attachments_json: string | null;
}

export interface JobEventInput {
  eventType: string;
  toolName?: string;
  observationId?: string;
  artifactId?: string;
  summary?: string;
}

export interface CreateJobInput {
  sourceUpdateId?: number | null;
  sourceMessageId?: number | null;
  conversationId: string;
  taskText: string;
  taskLabel: string;
  kind?: string;
  state?: JobState;
  configHash: string;
  modelJson: string;
  stale?: boolean;
  linkedJobId?: string | null;
  attachmentsJson?: string | null;
}

export type UpdateDecision = "job" | "control" | "rejected" | "paired" | "question_answer" | "approval" | "noop";

export class JobRepository {
  constructor(readonly db: Database) {}

  now(): string {
    return new Date().toISOString();
  }

  allocateSeq(name: string): number {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`seq.${name}`) as { value: string } | undefined;
      const next = (row ? Number.parseInt(row.value, 10) : 0) + 1;
      this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`seq.${name}`, String(next));
      return next;
    });
  }

  allocateJobId(): string {
    return `J-${this.allocateSeq("job")}`;
  }

  // ---------------------------------------------------------------- conversations

  getActiveConversation(): ConversationRow | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as ConversationRow | undefined;
    return row;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
  }

  ensureConversation(ownerUserId: string, ownerChatId: string): ConversationRow {
    const existing = this.getActiveConversation();
    if (existing) return existing;
    return this.createNewConversation(ownerUserId, ownerChatId);
  }

  createNewConversation(ownerUserId: string, ownerChatId: string): ConversationRow {
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE conversations SET archived_at = ? WHERE archived_at IS NULL").run(now);
      const id = randomUUID();
      this.db.prepare("INSERT INTO conversations(id, owner_user_id, owner_chat_id, session_file, created_at) VALUES (?, ?, ?, NULL, ?)").run(id, ownerUserId, ownerChatId, now);
      return this.getConversation(id)!;
    });
  }

  setConversationSessionFile(id: string, sessionFile: string): void {
    this.db.prepare("UPDATE conversations SET session_file = ? WHERE id = ?").run(sessionFile, id);
  }

  setConversationNextModel(id: string, modelJson: string | null): void {
    this.db.prepare("UPDATE conversations SET next_model_json = ? WHERE id = ?").run(modelJson, id);
  }

  // ---------------------------------------------------------------- updates

  hasUpdate(updateId: number): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM updates WHERE update_id = ?").get(updateId) as { present: number } | undefined;
    return Boolean(row);
  }

  /** Insert an admitted update; returns false when the update_id was already admitted. */
  admitUpdate(updateId: number, input: { messageTs?: number | null; kind: string; decision: UpdateDecision; jobId?: string | null; controlId?: string | null }): boolean {
    try {
      this.db
        .prepare("INSERT INTO updates(update_id, received_at, message_ts, kind, decision, job_id, control_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(updateId, this.now(), input.messageTs ?? null, input.kind, input.decision, input.jobId ?? null, input.controlId ?? null);
      return true;
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) return false;
      throw error;
    }
  }

  // ---------------------------------------------------------------- jobs

  createJob(input: CreateJobInput): JobRow {
    const id = this.allocateJobId();
    const now = this.now();
    const state: JobState = input.state ?? "queued";
    this.db
      .prepare(
        `INSERT INTO jobs(id, source_update_id, source_message_id, conversation_id, task_text, task_label, kind, state, created_at, updated_at, config_hash, model_json, stale, linked_job_id, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceUpdateId ?? null,
        input.sourceMessageId ?? null,
        input.conversationId,
        input.taskText,
        input.taskLabel,
        input.kind ?? "task",
        state,
        now,
        now,
        input.configHash,
        input.modelJson,
        input.stale ? 1 : 0,
        input.linkedJobId ?? null,
        input.attachmentsJson ?? null,
      );
    this.appendEvent(id, { eventType: "state", summary: `created in state ${state}` });
    return this.getJob(id)!;
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  findJobByUpdateId(updateId: number): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE source_update_id = ?").get(updateId) as JobRow | undefined;
  }

  getActiveJob(): JobRow | undefined {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('starting','running','waiting_for_owner','waiting_for_unlock','paused','cancelling') ORDER BY created_at ASC")
      .all() as unknown as JobRow[];
    return rows[0];
  }

  getNextQueuedJob(): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'queued' AND stale = 0 ORDER BY created_at ASC LIMIT 1").get() as JobRow | undefined;
  }

  listQueuedJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','awaiting_start') ORDER BY created_at ASC").all() as unknown as JobRow[];
  }

  listActiveJobs(): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('starting','running','waiting_for_owner','waiting_for_unlock','paused','cancelling') ORDER BY created_at ASC")
      .all() as unknown as JobRow[];
  }

  countQueued(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','awaiting_start')").get() as { n: number };
    return row.n;
  }

  /** Apply a state transition with validation and an audit event. */
  transitionJob(jobId: string, to: JobState, options: { reason?: string; errorCode?: string; errorMessage?: string; resultText?: string; cancelReason?: string } = {}): JobRow {
    return this.db.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      if (job.state === to) return job;
      assertTransition(job.state, to);
      const now = this.now();
      const finished = isTerminal(to) ? now : null;
      const started = job.started_at ?? (to === "running" ? now : null);
      const pausedAt = to === "paused" ? now : job.paused_at;
      this.db
        .prepare(
          `UPDATE jobs SET state = ?, updated_at = ?, started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at),
             error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message), result_text = COALESCE(?, result_text),
             paused_at = ?, cancel_reason = COALESCE(?, cancel_reason)
           WHERE id = ?`,
        )
        .run(
          to,
          now,
          started,
          finished,
          options.errorCode ?? null,
          options.errorMessage ?? null,
          options.resultText ?? null,
          pausedAt,
          options.cancelReason ?? null,
          jobId,
        );
      this.appendEvent(jobId, { eventType: "state", summary: `${job.state} -> ${to}${options.reason ? ` (${options.reason})` : ""}` });
      return this.getJob(jobId)!;
    });
  }

  setJobLeaseGeneration(jobId: string, generation: number): void {
    this.db.prepare("UPDATE jobs SET lease_generation = ?, updated_at = ? WHERE id = ?").run(generation, this.now(), jobId);
  }

  incrementJobCounters(jobId: string, delta: { toolCalls?: number; modelTurns?: number }): void {
    this.db
      .prepare("UPDATE jobs SET tool_calls = tool_calls + ?, model_turns = model_turns + ?, updated_at = ? WHERE id = ?")
      .run(delta.toolCalls ?? 0, delta.modelTurns ?? 0, this.now(), jobId);
  }

  markJobStale(jobId: string, stale: boolean): void {
    this.db.prepare("UPDATE jobs SET stale = ?, updated_at = ? WHERE id = ?").run(stale ? 1 : 0, this.now(), jobId);
  }

  /** Merge additional inbound attachments (media groups) into an existing job. */
  mergeJobAttachments(jobId: string, extraJson: string): void {
    const job = this.getJob(jobId);
    if (!job) return;
    const merge = (current: string | null, extra: string): string => {
      try {
        const a = current ? (JSON.parse(current) as { photos?: unknown[]; documents?: unknown[]; mediaGroupId?: string | null }) : {};
        const b = JSON.parse(extra) as { photos?: unknown[]; documents?: unknown[]; mediaGroupId?: string | null };
        return JSON.stringify({
          photos: [...(a.photos ?? []), ...(b.photos ?? [])],
          documents: [...(a.documents ?? []), ...(b.documents ?? [])],
          mediaGroupId: a.mediaGroupId ?? b.mediaGroupId ?? null,
        });
      } catch {
        return extra;
      }
    };
    this.db.prepare("UPDATE jobs SET attachments_json = ?, updated_at = ? WHERE id = ?").run(merge(job.attachments_json, extraJson), this.now(), jobId);
  }

  appendEvent(jobId: string, event: JobEventInput): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?").get(jobId) as { seq: number };
      this.db
        .prepare("INSERT INTO job_events(job_id, seq, timestamp, event_type, tool_name, observation_id, artifact_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(jobId, row.seq + 1, this.now(), event.eventType, event.toolName ?? null, event.observationId ?? null, event.artifactId ?? null, event.summary ?? null);
    });
  }

  listJobEvents(jobId: string, limit = 50): Array<{ seq: number; timestamp: string; event_type: string; tool_name: string | null; summary: string | null }> {
    return this.db.prepare("SELECT seq, timestamp, event_type, tool_name, summary FROM job_events WHERE job_id = ? ORDER BY seq DESC LIMIT ?").all(jobId, limit) as Array<{
      seq: number;
      timestamp: string;
      event_type: string;
      tool_name: string | null;
      summary: string | null;
    }>;
  }

  lastEventSummary(jobId: string): string | undefined {
    const row = this.db.prepare("SELECT summary, event_type FROM job_events WHERE job_id = ? ORDER BY seq DESC LIMIT 1").get(jobId) as { summary: string | null; event_type: string } | undefined;
    return row?.summary ?? row?.event_type;
  }

  // ---------------------------------------------------------------- controls

  insertControl(input: { sourceUpdateId?: number | null; jobId?: string | null; command: string; id?: string }): string {
    const id = input.id ?? randomUUID();
    this.db
      .prepare("INSERT INTO controls(id, source_update_id, job_id, command, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.sourceUpdateId ?? null, input.jobId ?? null, input.command, this.now());
    return id;
  }

  listPendingControls(): Array<{ id: string; job_id: string | null; command: string; created_at: string }> {
    return this.db.prepare("SELECT id, job_id, command, created_at FROM controls WHERE applied_at IS NULL ORDER BY created_at ASC").all() as Array<{
      id: string;
      job_id: string | null;
      command: string;
      created_at: string;
    }>;
  }

  getControl(id: string): { id: string; job_id: string | null; command: string; created_at: string; applied_at: string | null } | undefined {
    return this.db.prepare("SELECT id, job_id, command, created_at, applied_at FROM controls WHERE id = ?").get(id) as
      | { id: string; job_id: string | null; command: string; created_at: string; applied_at: string | null }
      | undefined;
  }

  markControlApplied(id: string): void {
    this.db.prepare("UPDATE controls SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(this.now(), id);
  }

  // ---------------------------------------------------------------- dispatch suspension

  isDispatchSuspended(): boolean {
    return getBoolMeta(this.db, "dispatch_suspended") ?? false;
  }

  setDispatchSuspended(value: boolean): void {
    setBoolMeta(this.db, "dispatch_suspended", value);
  }

  isPairingMode(): boolean {
    return getBoolMeta(this.db, "pairing_mode") ?? false;
  }

  setPairingMode(value: boolean): void {
    setBoolMeta(this.db, "pairing_mode", value);
  }

  getReceiveCursor(): number | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'receive_cursor'").get() as { value: string } | undefined;
    if (!row) return undefined;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : undefined;
  }

  setReceiveCursor(updateId: number): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('receive_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(updateId));
  }

  // ---------------------------------------------------------------- recovery

  /** Mark jobs that were mid-flight when the previous controller died as interrupted. */
  recoverInterruptedJobs(): JobRow[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE state IN ('starting','running','waiting_for_owner','cancelling') OR state = 'paused'").all() as unknown as JobRow[];
    const interrupted: JobRow[] = [];
    for (const row of rows) {
      if (row.state === "paused" || row.state === "waiting_for_owner") {
        // Paused/waiting states survive a restart and require explicit owner resume.
        this.appendEvent(row.id, { eventType: "recovery", summary: `restored ${row.state} after controller restart` });
        continue;
      }
      try {
        this.transitionJob(row.id, "interrupted", { reason: "controller restart", errorCode: "INTERRUPTED", errorMessage: "Controller restarted while this job was active." });
        interrupted.push(this.getJob(row.id)!);
      } catch {
        // If the transition is invalid for a race, leave the row untouched but do not crash recovery.
      }
    }
    return interrupted;
  }

  stateCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as Array<{ state: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.state] = row.n;
    return out;
  }

  isActive(state: JobState): boolean {
    return isActiveState(state);
  }
}
