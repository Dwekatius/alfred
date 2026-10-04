/**
 * Desktop operation lease and mutex.
 *
 * - A job holds a lease generation. Every brokered desktop/browser request is
 *   checked against the current generation; revocation invalidates queued work.
 * - `runExclusive` serializes observations, input, screenshots, and browser
 *   actions so backend state (element maps, snapshots) never races.
 */
export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

export interface LeaseCheckResult {
  ok: boolean;
  code?: "LEASE_REVOKED" | "PAUSED" | "NO_ACTIVE_JOB";
  message?: string;
}

export class DesktopLease {
  private currentGeneration = 0;
  private activeJobId: string | null = null;
  private pausedJobs = new Set<string>();
  readonly mutex = new AsyncMutex();

  /** Grant the lease to a job at the given (already persisted) generation. */
  grant(jobId: string, generation: number): void {
    this.activeJobId = jobId;
    this.currentGeneration = generation;
    this.pausedJobs.delete(jobId);
  }

  /** Revoke immediately: queued requests from the old generation are rejected. */
  revoke(): number {
    this.currentGeneration += 1;
    this.activeJobId = null;
    this.pausedJobs.clear();
    return this.currentGeneration;
  }

  getGeneration(): number {
    return this.currentGeneration;
  }

  getActiveJobId(): string | null {
    return this.activeJobId;
  }

  pause(jobId: string): void {
    this.pausedJobs.add(jobId);
  }

  resume(jobId: string): void {
    this.pausedJobs.delete(jobId);
  }

  isPaused(jobId: string): boolean {
    return this.pausedJobs.has(jobId);
  }

  check(jobId: string, generation: number): LeaseCheckResult {
    if (this.activeJobId === null) return { ok: false, code: "NO_ACTIVE_JOB", message: "No active desktop job." };
    if (this.activeJobId !== jobId) return { ok: false, code: "LEASE_REVOKED", message: "Another job currently holds the desktop lease." };
    if (this.currentGeneration !== generation) return { ok: false, code: "LEASE_REVOKED", message: "The desktop lease was revoked (job stopped or paused requirement changed)." };
    if (this.pausedJobs.has(jobId)) return { ok: false, code: "PAUSED", message: "Job is paused; no new side effects are permitted." };
    return { ok: true };
  }
}
