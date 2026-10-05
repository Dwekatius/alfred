import { fork, type ChildProcess } from "node:child_process";
import { Logger, redactString } from "../logging.js";
import { parsePoolReadyMessage } from "../ipc.js";

interface Spare {
  child: ChildProcess;
  ready: Promise<void>;
  spawnedAt: number;
  readyAt?: number;
  discarded?: boolean;
}

export interface WorkerPoolOptions {
  mainPath: string;
  logger: Logger;
  enabled: boolean;
  readyTimeoutMs?: number;
  /** Test seam; production always forks the disposable worker. */
  spawn?: () => ChildProcess;
}

/** One unused, credential-free process; each assigned process runs ONE job. */
export class DisposableWorkerPool {
  private spare: Spare | undefined;
  private disposed = false;
  private readonly assigning = new Set<Spare>();
  constructor(private readonly options: WorkerPoolOptions) {}

  prewarm(): Promise<void> {
    if (this.disposed || !this.options.enabled) return Promise.resolve();
    this.spare ??= this.spawn();
    return this.spare.ready.catch(() => undefined);
  }

  private spawn(): Spare {
    const child = this.options.spawn?.() ?? fork(this.options.mainPath, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, PI_TG_WORKER: "1" },
      windowsHide: true,
      serialization: "json",
      // The worker runs compiled JS; parent CLI/test/inline flags do not apply.
      execArgv: [],
    });
    const spare: Spare = { child, ready: Promise.resolve(), spawnedAt: Date.now() };
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
      const lines = stderr.split("\n");
      stderr = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.options.logger.debug("worker.stderr", "Worker diagnostic.", { detail: redactString(line).slice(0, 2000) });
    });
    spare.ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const onMessage = (raw: unknown) => {
        const ready = parsePoolReadyMessage(raw);
        if (!ready || ready.pid !== child.pid) return;
        spare.readyAt = Date.now();
        cleanup();
        this.options.logger.info("worker.pool_ready", "Unused worker ready.", { durationMs: spare.readyAt - spare.spawnedAt });
        resolve();
      };
      const onExit = () => fail(new Error("Worker exited before pool readiness."));
      const onError = (error: Error) => fail(error);
      const timer = setTimeout(() => {
        fail(new Error("Worker initialization timed out."));
        child.kill();
      }, this.options.readyTimeoutMs ?? 30000);
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
    });
    // Idle failures must never become unhandled rejections or a respawn loop.
    void spare.ready.catch((error: Error) => {
      if (this.spare === spare) this.spare = undefined;
      if (!this.disposed && !spare.discarded) this.options.logger.warn("worker.pool_failed", "Worker initialization failed.", { detail: error.message });
    });
    child.once("exit", () => { if (this.spare === spare) this.spare = undefined; });
    // Keep an error listener after readiness too (e.g. IPC send failures).
    child.on("error", () => undefined);
    return spare;
  }

  async take(signal: AbortSignal): Promise<{ child: ChildProcess; poolWaitMs: number; processAgeMs: number; wasWarm: boolean }> {
    if (this.disposed) throw new Error("Worker pool is disposed.");
    signal.throwIfAborted();
    const startedAt = Date.now();
    const spare = this.spare ?? this.spawn();
    this.spare = undefined;
    const wasWarm = spare.readyAt !== undefined;
    this.assigning.add(spare);
    try {
      await abortable(spare.ready, signal);
      signal.throwIfAborted();
      if (this.disposed || !spare.child.connected || spare.child.exitCode !== null || spare.child.killed) throw new Error("Worker is unavailable.");
      return { child: spare.child, poolWaitMs: Date.now() - startedAt, processAgeMs: Date.now() - spare.spawnedAt, wasWarm };
    } catch (error) {
      spare.discarded = true;
      spare.child.kill();
      throw error;
    } finally {
      this.assigning.delete(spare);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const spare = this.spare;
    this.spare = undefined;
    if (spare) await terminateWorker(spare.child);
    await Promise.all([...this.assigning].map((pending) => terminateWorker(pending.child)));
  }
}

export async function terminateWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); child.off("exit", done); resolve(); };
    const timer = setTimeout(done, 1000);
    child.once("exit", done);
    try { child.kill(); } catch { done(); }
  });
}

/** Stop waiting immediately; the underlying read-only operation may finish later. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("Cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
