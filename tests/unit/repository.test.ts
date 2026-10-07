import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Database } from "../../src/storage/database.js";
import { runMigrations, latestMigrationVersion } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";

function repo(): JobRepository {
  const db = Database.open(":memory:");
  runMigrations(db);
  return new JobRepository(db);
}

test("migrations apply to the latest version", () => {
  const db = Database.open(":memory:");
  const version = runMigrations(db);
  assert.equal(version, latestMigrationVersion());
  // Running again is idempotent.
  assert.equal(runMigrations(db), latestMigrationVersion());
});

test("duplicate telegram update ids are admitted once", () => {
  const r = repo();
  assert.equal(r.admitUpdate(10, { kind: "message", decision: "rejected" }), true);
  assert.equal(r.admitUpdate(10, { kind: "message", decision: "rejected" }), false);
  assert.equal(r.hasUpdate(10), true);
  assert.equal(r.hasUpdate(11), false);
});

test("job lifecycle persists transitions and events", () => {
  const r = repo();
  const conversation = r.ensureConversation("1", "1");
  const job = r.createJob({ sourceUpdateId: 1, conversationId: conversation.id, taskText: "do a thing", taskLabel: "do a thing", configHash: "h", modelJson: "{}" });
  assert.equal(job.state, "queued");
  r.transitionJob(job.id, "starting");
  r.transitionJob(job.id, "running");
  r.incrementJobCounters(job.id, { toolCalls: 2, modelTurns: 1 });
  const running = r.getJob(job.id)!;
  assert.equal(running.tool_calls, 2);
  assert.equal(running.model_turns, 1);
  r.transitionJob(job.id, "succeeded", { resultText: "done" });
  const done = r.getJob(job.id)!;
  assert.equal(done.state, "succeeded");
  assert.equal(done.result_text, "done");
  assert.ok(done.finished_at);
  assert.throws(() => r.transitionJob(job.id, "running"), /Invalid job state transition/);
  const events = r.listJobEvents(job.id);
  assert.ok(events.length >= 4);
});

test("cursor is durable and monotonic", () => {
  const r = repo();
  assert.equal(r.getReceiveCursor(), undefined);
  r.setReceiveCursor(5);
  assert.equal(r.getReceiveCursor(), 5);
  r.setReceiveCursor(9);
  assert.equal(r.getReceiveCursor(), 9);
});

test("recovery interrupts every old worker state, including paused and waiting jobs", () => {
  const r = repo();
  const conversation = r.ensureConversation("1", "1");
  const running = r.createJob({ conversationId: conversation.id, taskText: "a", taskLabel: "a", configHash: "h", modelJson: "{}", state: "starting" });
  r.transitionJob(running.id, "running");
  const paused = r.createJob({ conversationId: conversation.id, taskText: "b", taskLabel: "b", configHash: "h", modelJson: "{}", state: "queued" });
  r.transitionJob(paused.id, "starting");
  r.transitionJob(paused.id, "running");
  r.transitionJob(paused.id, "paused");
  const waiting = ["waiting_for_owner", "waiting_for_unlock"] as const;
  const waitingJobs = waiting.map((state) => {
    const job = r.createJob({ conversationId: conversation.id, taskText: state, taskLabel: state, configHash: "h", modelJson: "{}" });
    r.transitionJob(job.id, "starting"); r.transitionJob(job.id, "running"); r.transitionJob(job.id, state);
    return job;
  });
  const interrupted = r.recoverInterruptedJobs();
  assert.deepEqual(new Set(interrupted.map((job) => job.id)), new Set([running.id, paused.id, ...waitingJobs.map((job) => job.id)]));
  assert.equal(r.getJob(running.id)!.state, "interrupted");
  assert.equal(r.getJob(paused.id)!.state, "interrupted");
  assert.equal(r.getActiveJob(), undefined, "no ghost worker can block the queue or accept Resume");
});

test("control rows persist until applied", () => {
  const r = repo();
  const id = r.insertControl({ command: JSON.stringify({ type: "help" }) });
  assert.equal(r.listPendingControls().length, 1);
  r.markControlApplied(id);
  assert.equal(r.listPendingControls().length, 0);
  assert.ok(r.getControl(id)?.applied_at);
});

test("dispatch suspension and pairing mode persist", () => {
  const r = repo();
  assert.equal(r.isDispatchSuspended(), false);
  r.setDispatchSuspended(true);
  assert.equal(r.isDispatchSuspended(), true);
  r.setPairingMode(true);
  assert.equal(r.isPairingMode(), true);
});
