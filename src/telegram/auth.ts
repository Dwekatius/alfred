/**
 * Owner authorization and local pairing.
 *
 * Authorization requires, for every inbound message/callback:
 *   chat.type == "private"
 *   decimalString(from.id) == config.telegram.ownerUserId
 *   decimalString(chat.id) == config.telegram.ownerChatId
 *
 * Pairing never uses "first user wins": a random 128-bit code must be created
 * locally and explicitly accepted locally.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Logger } from "../logging.js";
import { JobRepository } from "../jobs/repository.js";
import type { TgCallbackQuery, TgMessage, TgUpdate, TgUser } from "./api.js";

export interface OwnerIds {
  ownerUserId: string;
  ownerChatId: string;
}

export function decimalId(id: number | string): string {
  return String(id);
}

export function isPrivateChat(chat: { type: string } | undefined): boolean {
  return chat?.type === "private";
}

export interface AuthorizationResult {
  ok: boolean;
  reason?: "unpaired" | "group_or_channel" | "wrong_user" | "wrong_chat" | "no_sender" | "unknown_update";
}

export class Authorizer {
  constructor(
    private readonly getOwner: () => OwnerIds | null,
    private readonly logger?: Logger,
  ) {}

  checkMessage(message: TgMessage | undefined): AuthorizationResult {
    if (!message) return { ok: false, reason: "unknown_update" };
    if (!isPrivateChat(message.chat)) return { ok: false, reason: "group_or_channel" };
    const owner = this.getOwner();
    if (!owner) return { ok: false, reason: "unpaired" };
    if (!message.from) return { ok: false, reason: "no_sender" };
    if (decimalId(message.from.id) !== owner.ownerUserId) return { ok: false, reason: "wrong_user" };
    if (decimalId(message.chat.id) !== owner.ownerChatId) return { ok: false, reason: "wrong_chat" };
    return { ok: true };
  }

  checkCallback(query: TgCallbackQuery | undefined): AuthorizationResult {
    if (!query) return { ok: false, reason: "unknown_update" };
    const result = this.checkMessage(query.message);
    if (!result.ok) return result;
    const owner = this.getOwner();
    if (!owner) return { ok: false, reason: "unpaired" };
    if (decimalId(query.from.id) !== owner.ownerUserId) return { ok: false, reason: "wrong_user" };
    return { ok: true };
  }

  describeUpdate(update: TgUpdate): string {
    if (update.message) return "message";
    if (update.callback_query) return "callback_query";
    return "other";
  }

  logRejection(kind: string, reason: string | undefined, updateId: number): void {
    this.logger?.warn("auth.rejected", "Rejected unauthorized update", { kind, reason: reason ?? "unknown", updateId, eventCode: "AUTH_REJECTED" });
  }
}

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export function generatePairingCode(): string {
  return randomBytes(16).toString("base64url");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export function verifyPairingCode(code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPairingCode(code));
  const expected = Buffer.from(expectedHash);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface PairingCandidate {
  userId: string;
  chatId: string;
  displayName: string;
}

/** Compute a display name without storing usernames as identity. */
export function displayNameFor(user: TgUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return user.username ? `${name} (@${user.username})` : name || `user ${user.id}`;
}

export interface PairingServiceOptions {
  repository: JobRepository;
  logger?: Logger;
}

/**
 * Pairing state machine backed by SQLite so the local pair command and the
 * running controller can cooperate through the same database.
 */
export class PairingService {
  constructor(private readonly options: PairingServiceOptions) {}

  private get db() {
    return this.options.repository.db;
  }

  /** Start a pairing window with a fresh code (called by the local pair script). */
  startPairing(code: string): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    const codeHash = hashPairingCode(code);
    this.db.transaction(() => {
      // Clear any previous pairing attempt (waiting/candidate/pending); accepted
      // rows are historical and unused. The placeholder PK must be unique.
      this.db.prepare("DELETE FROM pairing WHERE status != 'accepted'").run();
      this.db
        .prepare("INSERT INTO pairing(candidate_user_id, candidate_chat_id, display_name, code_hash, created_at, expires_at, status) VALUES (?, '', NULL, ?, ?, ?, 'waiting')")
        .run(`waiting:${codeHash.slice(0, 16)}`, codeHash, now.toISOString(), expiresAt);
      this.options.repository.setPairingMode(true);
    });
  }

  /** Validate a /start <code> message and record the candidate. Returns a user-facing result. */
  submitPairingCode(code: string, user: TgUser, chatId: string): { ok: boolean; message: string } {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT rowid, * FROM pairing WHERE status = 'waiting' ORDER BY rowid DESC LIMIT 1")
        .get() as { rowid: number; code_hash: string; expires_at: string } | undefined;
      if (!row) return { ok: false, message: "Pairing is not active. Run the local pairing command first." };
      if (row.expires_at < now) return { ok: false, message: "The pairing code has expired. Run the local pairing command again." };
      if (!verifyPairingCode(code, row.code_hash)) return { ok: false, message: "Invalid pairing code." };
      this.db
        .prepare("UPDATE pairing SET candidate_user_id = ?, candidate_chat_id = ?, display_name = ?, status = 'candidate' WHERE rowid = ?")
        .run(decimalId(user.id), chatId, displayNameFor(user), row.rowid);
      return { ok: true, message: "Code accepted. Confirm on the PC to finish pairing." };
    });
  }

  getPendingCandidate(): PairingCandidate | undefined {
    const row = this.db
      .prepare("SELECT candidate_user_id, candidate_chat_id, display_name FROM pairing WHERE status = 'candidate' ORDER BY created_at DESC LIMIT 1")
      .get() as { candidate_user_id: string; candidate_chat_id: string; display_name: string | null } | undefined;
    if (!row || !row.candidate_user_id) return undefined;
    return { userId: row.candidate_user_id, chatId: row.candidate_chat_id, displayName: row.display_name ?? "" };
  }

  /** Locally confirmed: invalidate the code and return the accepted candidate. */
  acceptCandidate(): PairingCandidate | undefined {
    const candidate = this.getPendingCandidate();
    if (!candidate) return undefined;
    this.db.transaction(() => {
      this.db.prepare("UPDATE pairing SET status = 'accepted' WHERE candidate_user_id = ?").run(candidate.userId);
      this.options.repository.setPairingMode(false);
    });
    return candidate;
  }

  cancelPairing(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM pairing WHERE status IN ('waiting','candidate')").run();
      this.options.repository.setPairingMode(false);
    });
  }

  isWaiting(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pairing WHERE status = 'waiting'").get() as { n: number };
    return row.n > 0;
  }
}
