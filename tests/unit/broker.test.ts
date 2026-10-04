import { strict as assert } from "node:assert";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { ApprovalRepository } from "../../src/jobs/approvals.js";
import { QuestionRepository } from "../../src/jobs/questions.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { ToolBroker } from "../../src/tools/broker.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { registerFakeTools } from "../../src/tools/fake-tools.js";
import { Logger } from "../../src/logging.js";
import { testConfig } from "../fixtures/config.js";
import { IPC_PROTOCOL_VERSION } from "../../src/ipc.js";

function setup(maxToolCalls = 150) {
  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const approvals = new ApprovalRepository(db);
  const questions = new QuestionRepository(db);
  const artifacts = new ArtifactRegistry(db, join(tmpdir(), `pi-tg-broker-${Date.now()}`), new Logger({}, { toStderr: false }));
  const lease = new DesktopLease();
  const config = testConfig({ jobs: { ...testConfig().jobs, maxToolCalls } });
  const broker = new ToolBroker({ db, repo, approvals, questions, artifacts, getOutbox: () => undefined, config, logger: new Logger({}, { toStderr: false }), lease });
  registerFakeTools(broker);
  const conversation = repo.ensureConversation("1", "1");
  const job = repo.createJob({ conversationId: conversation.id, taskText: "t", taskLabel: "t", configHash: "h", modelJson: "{}" });
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  lease.grant(job.id, repo.getJob(job.id)!.lease_generation);
  return { db, repo, broker, lease, job: repo.getJob(job.id)!, config };
}

function request(job: { id: string; lease_generation: number }, toolName: string, args: unknown, requestId = "r1") {
  return {
    jobId: job.id,
    leaseGeneration: job.lease_generation,
    requestId,
    toolCallId: `t-${requestId}`,
    toolName,
    args,
    signal: new AbortController().signal,
  };
}

test("fake_echo returns its input", async () => {
  const { broker, job, db } = setup();
  const result = await broker.execute(request(job, "fake_echo", { text: "hello" }));
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.result.content[0] && "text" in result.result.content[0] ? result.result.content[0].text : "", /echo: hello/);
  db.close();
});

test("invalid arguments are rejected by schema validation", async () => {
  const { broker, job, db } = setup();
  const result = await broker.execute(request(job, "fake_echo", { wrong: 1 }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_ERROR");
  db.close();
});

test("stale lease generations cannot execute", async () => {
  const { broker, job, db } = setup();
  const result = await broker.execute(request({ ...job, lease_generation: job.lease_generation + 1 }, "fake_echo", { text: "x" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "LEASE_REVOKED");
  db.close();
});

test("work limit is enforced", async () => {
  const { broker, job, db, repo } = setup(1);
  const first = await broker.execute(request(job, "fake_echo", { text: "one" }));
  assert.equal(first.ok, true);
  const second = await broker.execute(request(repo.getJob(job.id)!, "fake_echo", { text: "two" }, "r2"));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "WORK_LIMIT_REACHED");
  db.close();
});

test("mutating tools wait while paused and resume after", async () => {
  const { broker, job, db, repo, lease } = setup();
  broker.registerHandler("system_write", async () => ({ content: [{ type: "text", text: "wrote" }], details: {} }));
  repo.transitionJob(job.id, "paused");
  broker.setPaused(job.id, true);
  let settled = false;
  const pending = broker.execute(request(repo.getJob(job.id)!, "system_write", { path: "C:\\x.txt", content: "a" }, "r3")).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "paused mutation must not execute");
  repo.transitionJob(job.id, "running");
  broker.setPaused(job.id, false);
  const result = await pending;
  assert.equal(result.ok, true);
  db.close();
});

test("fake_image returns an image block and registers an artifact", async () => {
  const { broker, job, db, repo } = setup();
  const result = await broker.execute(request(repo.getJob(job.id)!, "fake_image", { code: "CODE-42" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    const image = result.result.content.find((block) => block.type === "image");
    assert.ok(image && image.type === "image" && image.data.length > 0);
    const artifactId = result.result.details?.artifactId;
    assert.ok(typeof artifactId === "string");
  }
  db.close();
});

test("unknown tools and IPC protocol version are handled safely", async () => {
  const { broker, job, db } = setup();
  const unknown = await broker.execute(request(job, "no_such_tool", {}));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "VALIDATION_ERROR");
  assert.equal(IPC_PROTOCOL_VERSION, 1);
  db.close();
});
