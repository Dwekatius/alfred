import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DisposableWorkerPool, terminateWorker } from "../../src/pi/worker-pool.js";
import { Logger } from "../../src/logging.js";

const fixture = fileURLToPath(new URL("../fixtures/worker-process.js", import.meta.url));
function setup(mode = "ready", enabled = true, timeout = 2000) {
  const children: ChildProcess[] = [];
  const ready: Promise<unknown[]>[] = [];
  const pool = new DisposableWorkerPool({ mainPath: fixture, enabled, logger: new Logger({}, { toStderr: false }), readyTimeoutMs: timeout,
    spawn: () => {
      const child = fork(fixture, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, env: { ...process.env, ALFRED_TEST_WORKER_MODE: mode } });
      children.push(child);
      ready.push(once(child, "message"));
      void ready.at(-1)!.catch(() => undefined);
      return child;
    },
  });
  return { pool, children, ready };
}

test("prewarm is idempotent, assignment consumes once, and replacement is disposable", { timeout: 5000 }, async () => {
  const s = setup();
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    s.pool.prewarm(); s.pool.prewarm();
    await s.ready[0];
    const taken = await s.pool.take(new AbortController().signal);
    first = taken.child;
    assert.equal(s.children.length, 1);
    assert.equal(taken.wasWarm, true);
    assert.ok(taken.poolWaitMs < 200);
    s.pool.prewarm();
    await s.ready[1];
    second = (await s.pool.take(new AbortController().signal)).child;
    assert.notEqual(first.pid, second.pid);
    await terminateWorker(first);
    assert.equal(second.exitCode, null, "terminating one job cannot kill the next worker");
  } finally {
    await s.pool.dispose();
    await Promise.all(s.children.map(terminateWorker));
  }
});

test("cancel during initialization promptly terminates the unassigned process", { timeout: 5000 }, async () => {
  const s = setup("never_ready");
  const abort = new AbortController();
  const started = Date.now();
  const pending = s.pool.take(abort.signal);
  abort.abort(new Error("test stop"));
  await assert.rejects(pending, /test stop/);
  assert.ok(Date.now() - started < 500);
  await s.pool.dispose();
  await Promise.all(s.children.map(terminateWorker));
});

test("dispose cancels a pending take and kills idle processes", { timeout: 5000 }, async () => {
  const s = setup("never_ready");
  const pending = s.pool.take(new AbortController().signal);
  const rejected = assert.rejects(pending, /exited|unavailable/);
  await s.pool.dispose();
  await rejected;
  assert.ok(s.children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test("failed and timed-out initialization does not respawn in a loop", { timeout: 5000 }, async () => {
  for (const mode of ["fail", "never_ready"]) {
    const s = setup(mode, true, 250);
    try {
      await assert.rejects(s.pool.take(new AbortController().signal), /exited|timed out/);
      assert.equal(s.children.length, 1);
    } finally { await s.pool.dispose(); await Promise.all(s.children.map(terminateWorker)); }
  }
});

test("disabled prewarming only spawns when a job is assigned", { timeout: 5000 }, async () => {
  const s = setup("ready", false);
  s.pool.prewarm();
  assert.equal(s.children.length, 0);
  const taken = await s.pool.take(new AbortController().signal);
  assert.equal(taken.wasWarm, false);
  await terminateWorker(taken.child);
  await s.pool.dispose();
});
