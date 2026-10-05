/**
 * Local single-instance lock for the controller, plus small helpers used by
 * the local CLI to check the running instance.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  runId: string;
  startedAt: string;
  hostname: string;
  /** OS creation time distinguishes a live controller from a recycled PID. */
  processStartedAt?: string;
}

export interface LockProcessProbe {
  isAlive(pid: number): boolean;
  startedAt(pid: number): string | undefined;
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

function processStartedAt(pid: number): string | undefined {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `try { [Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o') } catch { exit 1 }`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) return undefined;
  const time = Date.parse(result.stdout.trim());
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

const defaultProbe: LockProcessProbe = { isAlive: isProcessAlive, startedAt: processStartedAt };

function ownerIsAlive(info: LockInfo, probe: LockProcessProbe): boolean {
  if (!probe.isAlive(info.pid)) return false;
  const actualStart = probe.startedAt(info.pid);
  if (!actualStart) return true; // Cannot establish identity: preserve the lock.
  const actual = Date.parse(actualStart);
  const recorded = Date.parse(info.processStartedAt ?? info.startedAt);
  if (!Number.isFinite(actual) || !Number.isFinite(recorded)) return true;
  if (!info.processStartedAt && recorded <= 0) return true; // Missing legacy timestamp.
  // Legacy records contain only the lock time, which follows process creation.
  return info.processStartedAt ? actual === recorded : actual <= recorded;
}

export function readLockInfo(lockPath: string): LockInfo | undefined {
  try {
    if (!existsSync(lockPath)) return undefined;
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockInfo>;
    if (typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 0 || typeof raw.runId !== "string") return undefined;
    return { pid: raw.pid, runId: raw.runId, startedAt: raw.startedAt ?? new Date(0).toISOString(), hostname: raw.hostname ?? "unknown", ...(typeof raw.processStartedAt === "string" ? { processStartedAt: raw.processStartedAt } : {}) };
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
 * owns it. Removes a stale lock when the owner is dead or its PID was recycled.
 */
export function acquireControllerLock(lockPath: string, runId: string, probe: LockProcessProbe = defaultProbe): LockInfo {
  mkdirSync(dirname(lockPath), { recursive: true });
  const creationTime = probe.startedAt(process.pid);
  const info: LockInfo = { pid: process.pid, runId, startedAt: new Date().toISOString(), hostname: hostname(), ...(creationTime ? { processStartedAt: creationTime } : {}) };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLockInfo(lockPath);
      if (existing && ownerIsAlive(existing, probe)) {
        throw new LockError(`Another controller is running (pid ${existing.pid}, run ${existing.runId}, started ${existing.startedAt})`, existing);
      }
      // A different launcher may have replaced the stale record during probing.
      const latest = readLockInfo(lockPath);
      if (latest?.runId !== existing?.runId || latest?.pid !== existing?.pid || latest?.startedAt !== existing?.startedAt) continue;
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
