/**
 * Owner approvals for irreversible/outgoing actions. The supervisor stores and
 * consumes them; the model can never approve itself.
 */
import { createHash, randomBytes } from "node:crypto";
import { Database } from "../storage/database.js";

export interface ApprovalRow {
  id: string;
  job_id: string;
  owner_user_id: string;
  owner_chat_id: string;
  action_type: string;
  action_digest: string;
  preview: string;
  created_at: string;
  expires_at: string;
  decision: "approve" | "reject" | null;
  decided_at: string | null;
  used_at: string | null;
  request_id: string | null;
}

export interface CreateApprovalInput {
  jobId: string;
  ownerUserId: string;
  ownerChatId: string;
  actionType: string;
  preview: string;
  /** The exact payload being approved; hashed so a changed action invalidates the approval. */
  payload: unknown;
  ttlMs: number;
  requestId?: string;
}

export function digestAction(actionType: string, payload: unknown): string {
  return createHash("sha256").update(actionType).update("\u0000").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateApprovalInput): ApprovalRow {
    const id = randomBytes(9).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals(id, job_id, owner_user_id, owner_chat_id, action_type, action_digest, preview, created_at, expires_at, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.jobId, input.ownerUserId, input.ownerChatId, input.actionType, digestAction(input.actionType, input.payload), input.preview, now.toISOString(), expiresAt, input.requestId ?? null);
    return this.get(id)!;
  }

  get(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as ApprovalRow | undefined;
  }

  findPendingForJob(jobId: string): ApprovalRow | undefined {
    return this.db
      .prepare("SELECT * FROM approvals WHERE job_id = ? AND decision IS NULL AND used_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(jobId) as unknown as ApprovalRow | undefined;
  }

  recordDecision(id: string, decision: "approve" | "reject"): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ? AND decision IS NULL AND used_at IS NULL")
      .run(decision, new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /**
   * Consume an approved record exactly once. Returns the row when valid:
   * approved, unexpired, unused, and matching the expected action digest.
   */
  consume(id: string, expectedDigest: string): ApprovalRow | undefined {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row) return undefined;
      if (row.decision !== "approve" || row.used_at) return undefined;
      if (row.expires_at < new Date().toISOString()) return undefined;
      if (row.action_digest !== expectedDigest) return undefined;
      const result = this.db.prepare("UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL AND decision = 'approve'").run(new Date().toISOString(), id);
      if (Number(result.changes) === 0) return undefined;
      return row;
    });
  }

  expireStale(nowIso = new Date().toISOString()): number {
    const result = this.db.prepare("UPDATE approvals SET decision = 'reject', decided_at = ? WHERE decision IS NULL AND expires_at < ?").run(nowIso, nowIso);
    return Number(result.changes);
  }

  invalidateForJob(jobId: string): number {
    const result = this.db.prepare("UPDATE approvals SET decision = 'reject', decided_at = ? WHERE job_id = ? AND decision IS NULL").run(new Date().toISOString(), jobId);
    return Number(result.changes);
  }
}
