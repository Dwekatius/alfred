/**
 * Pending owner questions from `request_owner_input`. One active question per
 * job. Questions live in the supervisor; tool helpers never block on I/O.
 */
import { randomBytes } from "node:crypto";
import { Database } from "../storage/database.js";

export interface QuestionRow {
  id: string;
  job_id: string;
  owner_user_id: string;
  owner_chat_id: string;
  question: string;
  options_json: string | null;
  created_at: string;
  expires_at: string;
  status: "pending" | "answered" | "expired" | "cancelled";
  answer: string | null;
  answered_at: string | null;
  telegram_message_id: number | null;
}

export class QuestionRepository {
  constructor(private readonly db: Database) {}

  create(input: { jobId: string; ownerUserId: string; ownerChatId: string; question: string; options?: string[]; ttlMs: number }): QuestionRow {
    const id = `Q-${randomBytes(4).toString("hex")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO questions(id, job_id, owner_user_id, owner_chat_id, question, options_json, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(id, input.jobId, input.ownerUserId, input.ownerChatId, input.question, input.options ? JSON.stringify(input.options) : null, now.toISOString(), expiresAt);
    return this.get(id)!;
  }

  get(id: string): QuestionRow | undefined {
    return this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as unknown as QuestionRow | undefined;
  }

  findPendingForJob(jobId: string): QuestionRow | undefined {
    return this.db.prepare("SELECT * FROM questions WHERE job_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(jobId) as unknown as QuestionRow | undefined;
  }

  /** Answer the most recent pending question for a job from the authenticated owner. */
  answerPendingForJob(jobId: string, answer: string): QuestionRow | undefined {
    return this.db.transaction(() => {
      const row = this.findPendingForJob(jobId);
      if (!row) return undefined;
      return this.answerById(row.id, jobId, answer);
    });
  }

  /** Persist an answer to the exact question admitted with the control; keep the first answer on replay. */
  answerById(questionId: string, jobId: string, answer: string): QuestionRow | undefined {
    return this.db.transaction(() => {
      const row = this.get(questionId);
      if (!row || row.job_id !== jobId) return undefined;
      if (row.status === "answered") return row;
      if (row.status !== "pending") return undefined;
      const now = new Date().toISOString();
      if (row.expires_at <= now) {
        this.db.prepare("UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id);
        return undefined;
      }
      this.db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'").run(answer, now, row.id);
      return this.get(row.id);
    });
  }

  cancelForJob(jobId: string): number {
    const result = this.db.prepare("UPDATE questions SET status = 'cancelled' WHERE job_id = ? AND status = 'pending'").run(jobId);
    return Number(result.changes);
  }

  expireStale(nowIso = new Date().toISOString()): number {
    const result = this.db.prepare("UPDATE questions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(nowIso);
    return Number(result.changes);
  }
}
