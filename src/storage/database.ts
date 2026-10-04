/**
 * SQLite access layer for durable controller state.
 *
 * Uses node:sqlite behind a small repository-oriented facade:
 * - WAL journal mode, foreign keys, busy timeout
 * - Explicit short transactions; never await network I/O inside a transaction.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export class Database {
  readonly raw: DatabaseSync;
  private inTransaction = false;

  private constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
  }

  static open(path: string): Database {
    return new Database(path);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  /**
   * Run a function inside an IMMEDIATE transaction. Nested calls reuse the
   * outer transaction. The callback must be synchronous: never await inside.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* ignore */
    }
  }
}

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string | null): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getIntMeta(db: Database, key: string): number | undefined {
  const raw = getMeta(db, key);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

export function setIntMeta(db: Database, key: string, value: number): void {
  setMeta(db, key, String(value));
}

export function getBoolMeta(db: Database, key: string): boolean | undefined {
  const raw = getMeta(db, key);
  if (raw === undefined) return undefined;
  return raw === "1" || raw === "true";
}

export function setBoolMeta(db: Database, key: string, value: boolean): void {
  setMeta(db, key, value ? "1" : "0");
}
