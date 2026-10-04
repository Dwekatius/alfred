/**
 * Artifact registry: immutable local files (screenshots/images/documents)
 * referenced by opaque IDs. Model and Telegram tools accept IDs, never paths.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Logger } from "../logging.js";
import { Database } from "../storage/database.js";
import type { ArtifactBytesProvider } from "../telegram/outbox.js";

export interface ArtifactRow {
  id: string;
  job_id: string | null;
  conversation_id: string | null;
  relative_path: string;
  kind: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  checksum: string | null;
  capture_meta_json: string | null;
  upload_state: string;
  created_at: string;
}

export interface RegisterArtifactInput {
  jobId?: string | null;
  conversationId?: string | null;
  kind: "screenshot" | "observation" | "inbound_image" | "document" | "other";
  mime: string;
  filename?: string;
  bytes?: Buffer;
  sourcePath?: string;
  width?: number;
  height?: number;
  captureMeta?: Record<string, unknown>;
}

function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return base.length > 0 ? base : "file";
}

export class ArtifactRegistry implements ArtifactBytesProvider {
  constructor(
    private readonly db: Database,
    private readonly artifactsRoot: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(artifactsRoot, { recursive: true });
  }

  private allocateId(): string {
    return `A-${randomBytes(5).toString("hex")}`;
  }

  register(input: RegisterArtifactInput): ArtifactRow {
    const id = this.allocateId();
    const jobDirName = input.jobId ?? "shared";
    const dir = join(this.artifactsRoot, jobDirName);
    mkdirSync(dir, { recursive: true });
    const filename = `${id}-${sanitizeFilename(input.filename ?? "artifact.bin")}`;
    const target = join(dir, filename);
    let bytes: Buffer;
    if (input.bytes) {
      bytes = input.bytes;
      writeFileSync(target, bytes, { mode: 0o600 });
    } else if (input.sourcePath) {
      const realSource = realpathSync(input.sourcePath);
      bytes = readFileSync(realSource);
      writeFileSync(target, bytes, { mode: 0o600 });
    } else {
      throw new Error("Artifact registration requires bytes or a sourcePath");
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const relativePath = join(jobDirName, filename);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO artifacts(id, job_id, conversation_id, relative_path, kind, mime, size_bytes, width, height, checksum, capture_meta_json, upload_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?)`,
      )
      .run(
        id,
        input.jobId ?? null,
        input.conversationId ?? null,
        relativePath,
        input.kind,
        input.mime,
        bytes.byteLength,
        input.width ?? null,
        input.height ?? null,
        checksum,
        input.captureMeta ? JSON.stringify(input.captureMeta) : null,
        now,
      );
    this.logger.debug("artifact.registered", "Registered artifact", { artifactId: id, jobId: input.jobId ?? undefined, eventCode: "ARTIFACT_REGISTERED", kind: input.kind, sizeBytes: bytes.byteLength });
    return this.get(id)!;
  }

  get(id: string): ArtifactRow | undefined {
    return this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as ArtifactRow | undefined;
  }

  absolutePath(row: ArtifactRow): string {
    const candidate = resolve(this.artifactsRoot, row.relative_path);
    const root = resolve(this.artifactsRoot);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error("Artifact path escapes the artifacts root");
    }
    return candidate;
  }

  /** Validate the on-disk path (including symlinks/junctions) stays inside the root. */
  private validateRealPath(row: ArtifactRow): string {
    const candidate = this.absolutePath(row);
    if (!existsSync(candidate)) throw new Error(`Artifact file is missing: ${row.id}`);
    const real = realpathSync(candidate);
    const root = realpathSync(this.artifactsRoot);
    if (!real.startsWith(root + sep)) throw new Error("Artifact real path escapes the artifacts root");
    return real;
  }

  async readBytes(id: string): Promise<{ bytes: Buffer; filename: string; mime: string } | undefined> {
    const row = this.get(id);
    if (!row) return undefined;
    const real = this.validateRealPath(row);
    const bytes = readFileSync(real);
    const filename = basename(row.relative_path).replace(/^A-[0-9a-f]+-/, "");
    return { bytes, filename, mime: row.mime };
  }

  markUploaded(id: string): void {
    this.db.prepare("UPDATE artifacts SET upload_state = 'sent' WHERE id = ?").run(id);
  }

  listForJob(jobId: string): ArtifactRow[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC").all(jobId) as unknown as ArtifactRow[];
  }

  totalSizeBytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM artifacts").get() as { total: number };
    return row.total;
  }

  /**
   * Expire artifacts older than retentionDays with no pending outbox reference.
   * Files and rows are removed; pending deliveries are protected.
   */
  cleanup(retentionDays: number, maxTotalBytes: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts WHERE created_at < ? AND id NOT IN (SELECT artifact_id FROM outbox WHERE state IN ('pending','sending') AND artifact_id IS NOT NULL) ORDER BY created_at ASC`,
      )
      .all(cutoff) as unknown as ArtifactRow[];
    let removed = 0;
    for (const row of rows) {
      try {
        const path = this.absolutePath(row);
        if (existsSync(path)) rmSync(path, { force: true });
        this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(row.id);
        removed += 1;
      } catch (error) {
        this.logger.warn("artifact.cleanup_failed", "Failed to remove artifact", { artifactId: row.id, eventCode: "ARTIFACT_CLEANUP", message: (error as Error).message });
      }
    }
    // Enforce total size cap by removing oldest artifacts first (still protecting pending uploads).
    let total = this.totalSizeBytes();
    if (total > maxTotalBytes) {
      const candidates = this.db
        .prepare(
          `SELECT * FROM artifacts WHERE id NOT IN (SELECT artifact_id FROM outbox WHERE state IN ('pending','sending') AND artifact_id IS NOT NULL) ORDER BY created_at ASC`,
        )
        .all() as unknown as ArtifactRow[];
      for (const row of candidates) {
        if (total <= maxTotalBytes) break;
        try {
          const path = this.absolutePath(row);
          if (existsSync(path)) rmSync(path, { force: true });
          this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(row.id);
          total -= row.size_bytes;
          removed += 1;
        } catch {
          /* best effort */
        }
      }
    }
    return removed;
  }
}
