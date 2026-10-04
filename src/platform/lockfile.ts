/**
 * Local single-instance lock for the controller, plus small helpers used by
 * the local CLI to check the running instance.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  runId: string;
  startedAt: string;
  hostname: string;
}

export class LockError extends Error {
  readonly info: LockInfo | undefined;
  constructor(message: string, info?: LockInfo) {
    super(message);
    this.name = "LockError";
    this.info = info;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we may not signal it.
    return code === "EPERM";
  }
}

export function readLockInfo(lockPath: string): LockInfo | undefined {
  try {
    if (!existsSync(lockPath)) return undefined;
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockInfo>;
    if (typeof raw.pid !== "number" || typeof raw.runId !== "string") return undefined;
    return { pid: raw.pid, runId: raw.runId, startedAt: raw.startedAt ?? new Date(0).toISOString(), hostname: raw.hostname ?? "unknown" };
  } catch {
    return undefined;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows can transiently hold a file (AV/share); retry deletion briefly. */
function removeWithRetry(path: string, attempts = 5): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch (error) {
      if (attempt === attempts - 1) return false;
      sleepSync(120);
    }
  }
  return false;
}

/**
 * Acquire the controller lock. Throws LockError when another live controller
 * owns it. Removes a stale lock only when its PID is not alive.
 */
export function acquireControllerLock(lockPath: string, runId: string): LockInfo {
  mkdirSync(dirname(lockPath), { recursive: true });
  const info: LockInfo = { pid: process.pid, runId, startedAt: new Date().toISOString(), hostname: hostname() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLockInfo(lockPath);
      if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        throw new LockError(`Another controller is running (pid ${existing.pid}, run ${existing.runId}, started ${existing.startedAt})`, existing);
      }
      // Stale: either unreadable or the owning process is gone.
      if (!removeWithRetry(lockPath)) {
        throw new LockError(`Controller lock exists but could not be removed (still in use): ${lockPath}`, existing);
      }
    }
  }
  throw new LockError("Could not acquire controller lock");
}

export function releaseControllerLock(lockPath: string, runId: string): void {
  const existing = readLockInfo(lockPath);
  if (existing && existing.runId === runId) {
    removeWithRetry(lockPath);
  }
}
