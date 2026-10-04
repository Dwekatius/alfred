/**
 * Tracked child-process management.
 *
 * Short-lived automation children are registered per job. Killing a child uses
 * the Windows taskkill tree command on a PID we still hold a live ChildProcess
 * reference for, so a recycled PID is never targeted.
 *
 * Phase 4 adds a Windows Job Object helper for descendants that outlive their
 * direct parent; this manager remains the fallback and the inventory.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface TrackedProcess {
  pid: number | undefined;
  jobId: string;
  command: string;
  startedAt: string;
  child: ChildProcess;
}

export class ProcessManager {
  private readonly tracked = new Map<number, TrackedProcess>();

  track(child: ChildProcess, jobId: string, command: string): void {
    if (typeof child.pid === "number") {
      this.tracked.set(child.pid, { pid: child.pid, jobId, command, startedAt: new Date().toISOString(), child });
      child.once("exit", () => {
        if (typeof child.pid === "number") this.tracked.delete(child.pid);
      });
    }
  }

  list(): Array<Omit<TrackedProcess, "child">> {
    return [...this.tracked.values()].map(({ child: _child, ...rest }) => rest);
  }

  listForJob(jobId: string): Array<Omit<TrackedProcess, "child">> {
    return this.list().filter((entry) => entry.jobId === jobId);
  }

  /** Kill a child and its descendants. Returns true when a kill was issued. */
  async killTree(child: ChildProcess): Promise<boolean> {
    const pid = child.pid;
    if (typeof pid !== "number" || child.exitCode !== null || child.signalCode !== null) return false;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => resolve());
        killer.on("exit", () => resolve());
      });
      return true;
    }
    try {
      child.kill("SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  async killForJob(jobId: string): Promise<number> {
    let killed = 0;
    for (const entry of [...this.tracked.values()]) {
      if (entry.jobId !== jobId) continue;
      if (await this.killTree(entry.child)) killed += 1;
    }
    return killed;
  }

  async disposeAll(): Promise<void> {
    for (const entry of [...this.tracked.values()]) {
      await this.killTree(entry.child);
    }
    this.tracked.clear();
  }
}
