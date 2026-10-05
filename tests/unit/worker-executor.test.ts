import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { WorkerExecutor } from "../../src/pi/worker-executor.js";
import { Logger } from "../../src/logging.js";
import { dataPaths } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";
import type { ToolBroker } from "../../src/tools/broker.js";

function setup(mode = "ready", resolveApiKeys: (provider: string) => Promise<Array<{ provider: string; key: string }>> = async () => []) {
  const previousMode = process.env.ALFRED_TEST_WORKER_MODE;
  process.env.ALFRED_TEST_WORKER_MODE = mode;
  const root = mkdtempSync(join(tmpdir(), "alfred-worker-unit-"));
  const config = testConfig({ dataRoot: root, jobs: { ...testConfig().jobs, stopGraceMs: 250 } });
  const db = Database.open(":memory:"); runMigrations(db);
  const repo = new JobRepository(db);
  const logger = new Logger({}, { toStderr: false });
  const lease = new DesktopLease();
  const artifacts = new ArtifactRegistry(db, join(root, "artifacts"), logger);
  const executor = new WorkerExecutor({ config, paths: dataPaths(config), repo, logger, lease, artifacts, broker: {} as ToolBroker, resolveApiKeys, workerMainPath: fileURLToPath(new URL("../fixtures/worker-process.js", import.meta.url)) });
  const conversation = repo.ensureConversation("1", "1");
  const newJob = (provider = "deepseek") => {
    const job = repo.createJob({ conversationId: conversation.id, taskText: "fixture", taskLabel: "fixture", configHash: "fixture", modelJson: JSON.stringify({ provider, modelId: "fixture-model", thinking: "max" }) });
    repo.transitionJob(job.id, "starting"); repo.setJobLeaseGeneration(job.id, 1);
    return repo.getJob(job.id)!;
  };
  const dispose = async () => { await executor.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); if (previousMode === undefined) delete process.env.ALFRED_TEST_WORKER_MODE; else process.env.ALFRED_TEST_WORKER_MODE = previousMode; };
  return { executor, lease, newJob, dispose };
}

test("jobs consume distinct warm workers and inject only the selected provider", { timeout: 6000 }, async () => {
  const requested: string[] = [];
  const s = setup("ready", async (provider) => { requested.push(provider); return [{ provider: "deepseek", key: "test-only" }, { provider: "openrouter", key: "test-only" }]; });
  try {
    await s.executor.prewarm();
    const first = await s.executor.execute({ job: s.newJob(), signal: new AbortController().signal, deadline: Date.now() + 3000 });
    assert.equal(first.state, "succeeded");
    const firstData = JSON.parse(first.resultText!);
    assert.deepEqual(firstData.providers, ["deepseek"]);
    await s.executor.prewarm();
    const second = await s.executor.execute({ job: s.newJob("openrouter"), signal: new AbortController().signal, deadline: Date.now() + 3000 });
    assert.equal(second.state, "succeeded");
    const secondData = JSON.parse(second.resultText!);
    assert.deepEqual(secondData.providers, ["openrouter"]);
    assert.notEqual(firstData.pid, secondData.pid);
    assert.deepEqual(requested, ["deepseek", "openrouter"]);
    assert.equal(s.lease.getActiveJobId(), null);
  } finally { await s.dispose(); }
});

test("stop during credential resolution cancels promptly and revokes the lease", { timeout: 6000 }, async () => {
  let resolving: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { resolving = resolve; });
  const s = setup("ready", () => { resolving(); return new Promise(() => undefined); });
  try {
    await s.executor.prewarm();
    const abort = new AbortController();
    const pending = s.executor.execute({ job: s.newJob(), signal: abort.signal, deadline: Date.now() + 3000 });
    await entered;
    const started = Date.now(); abort.abort();
    assert.equal((await pending).state, "cancelled");
    assert.ok(Date.now() - started < 1500);
    assert.equal(s.lease.getActiveJobId(), null);
  } finally { await s.dispose(); }
});

test("hard termination settles an uncooperative job and leaves the next spare usable", { timeout: 6000 }, async () => {
  const s = setup("ignore_abort");
  try {
    await s.executor.prewarm();
    const job = s.newJob();
    const pending = s.executor.execute({ job, signal: new AbortController().signal, deadline: Date.now() + 3000 });
    // Wait for assignment/input resolution without touching any external state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await s.executor.cancel(job.id, "test emergency stop");
    assert.equal((await pending).state, "cancelled");
    await s.executor.prewarm();
  } finally { await s.dispose(); }
});

test("shutdown cancels worker initialization even before a handle exists", { timeout: 6000 }, async () => {
  const s = setup("never_ready");
  try {
    const pending = s.executor.execute({ job: s.newJob(), signal: new AbortController().signal, deadline: Date.now() + 3000 });
    await s.executor.dispose();
    assert.equal((await pending).state, "cancelled");
    assert.equal(s.lease.getActiveJobId(), null);
  } finally { await s.dispose(); }
});
