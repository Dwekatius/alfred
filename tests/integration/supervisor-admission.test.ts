import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { NullExecutor } from "../../src/jobs/scheduler.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { Outbox } from "../../src/telegram/outbox.js";
import { Supervisor } from "../../src/supervisor.js";
import { generatePairingCode } from "../../src/telegram/auth.js";
import { Logger } from "../../src/logging.js";
import { dataPaths } from "../../src/config.js";
import { ToolBroker } from "../../src/tools/broker.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { registerTelegramTools } from "../../src/tools/telegram-tools.js";
import { testConfig } from "../fixtures/config.js";
import type { SecretStore } from "../../src/platform/secrets.js";
import type { TelegramClient, TgUpdate } from "../../src/telegram/api.js";

function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(overrides);
  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const logger = new Logger({}, { toStderr: false });
  const artifacts = new ArtifactRegistry(db, join(tmpdir(), `pi-tg-sup-${randomUUID()}`), logger);
  const secrets: SecretStore = { get: async () => undefined, set: async () => undefined, delete: () => undefined, healthCheck: async () => true };
  const fakeClient = { answerCallbackQuery: async () => true, sendMessage: async () => ({ message_id: 1 }) } as unknown as TelegramClient;
  const outbox = new Outbox(db, fakeClient, { getOwnerChatId: () => config.telegram.ownerChatId, artifacts, logger, minimumIntervalMs: 1 });
  const supervisor = new Supervisor({ config, configPath: join(tmpdir(), `pi-tg-cfg-${randomUUID()}.json`), paths: dataPaths(config), db, repo, secrets, logger, runId: "run-test", outboxOverride: outbox });
  return { config, db, repo, supervisor, outbox };
}

function ownerMessage(updateId: number, text: string, date = Math.floor(Date.now() / 1000)): TgUpdate {
  return {
    update_id: updateId,
    message: { message_id: updateId, date, chat: { id: 1001, type: "private" }, from: { id: 1001, is_bot: false, first_name: "Owner" }, text },
  };
}

test("owner task is admitted once; an immediately starting job has no queue ack", () => {
  const { db, repo, supervisor, outbox } = setup();
  const admissions = supervisor.admitBatch([ownerMessage(1, "Summarize my email")]);
  assert.equal(admissions[0]?.decision, "job");
  const jobs = repo.listQueuedJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.task_text, "Summarize my email");
  // Chat-style UX: an immediate job answers directly instead of an ack.
  assert.equal(outbox.getByLogicalKey(`ack:${jobs[0]!.id}`), undefined);
  db.close();
});

test("a job admitted while another is active gets a queue acknowledgement", () => {
  const { db, repo, supervisor, outbox } = setup();
  supervisor.admitBatch([ownerMessage(1, "first task")]);
  const first = repo.listQueuedJobs()[0]!;
  repo.transitionJob(first.id, "starting");
  repo.transitionJob(first.id, "running");
  const admissions = supervisor.admitBatch([ownerMessage(2, "second task")]);
  assert.equal(admissions[0]?.decision, "job");
  const second = repo.listQueuedJobs().find((job) => job.id !== first.id)!;
  assert.ok(outbox.getByLogicalKey(`ack:${second.id}`));
  db.close();
});

test("duplicate update ids are never admitted twice", () => {
  const { db, repo, supervisor } = setup();
  supervisor.admitBatch([ownerMessage(7, "task one")]);
  const second = supervisor.admitBatch([ownerMessage(7, "task one")]);
  assert.equal(second[0]?.decision, "noop");
  assert.equal(repo.listQueuedJobs().length, 1);
  db.close();
});

test("unauthorized users create no job and no side effects", () => {
  const { db, repo, supervisor, outbox } = setup();
  const update: TgUpdate = {
    update_id: 2,
    message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false, first_name: "Mallory" }, text: "do bad things" },
  };
  const admissions = supervisor.admitBatch([update]);
  assert.equal(admissions[0]?.decision, "rejected");
  assert.equal(repo.listQueuedJobs().length, 0);
  assert.equal(outbox.countPending(), 0);
  db.close();
});

test("group messages are rejected before any work", () => {
  const { db, repo, supervisor } = setup();
  const update: TgUpdate = {
    update_id: 3,
    message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: "group" }, from: { id: 1001, is_bot: false, first_name: "Owner" }, text: "hello group" },
  };
  assert.equal(supervisor.admitBatch([update])[0]?.decision, "rejected");
  assert.equal(repo.listQueuedJobs().length, 0);
  db.close();
});

test("stale tasks wait for explicit start", () => {
  const { db, repo, supervisor } = setup();
  const longAgo = Math.floor(Date.now() / 1000) - 3600;
  supervisor.admitBatch([ownerMessage(4, "old task", longAgo)]);
  const job = repo.listQueuedJobs()[0]!;
  assert.equal(job.state, "awaiting_start");
  assert.equal(job.stale, 1);
  db.close();
});

test("stop suspends dispatch and lists queued work", async () => {
  const { db, repo, supervisor } = setup();
  supervisor.admitBatch([ownerMessage(5, "task")]);
  supervisor.admitBatch([ownerMessage(6, "/stop")]);
  const control = repo.listPendingControls().find((entry) => entry.command.includes("\"stop\""));
  assert.ok(control);
  await supervisor.applyControlById(control.id);
  assert.equal(repo.isDispatchSuspended(), true);
  db.close();
});

test("pause and resume transition the active job and broker gate", async () => {
  const { db, repo, supervisor } = setup();
  supervisor.admitBatch([ownerMessage(8, "task")]);
  const job = repo.listQueuedJobs()[0]!;
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  const pauseId = repo.insertControl({ jobId: job.id, command: JSON.stringify({ type: "pause" }) });
  await supervisor.applyControlById(pauseId);
  assert.equal(repo.getJob(job.id)!.state, "paused");
  const resumeId = repo.insertControl({ jobId: job.id, command: JSON.stringify({ type: "resume" }) });
  await supervisor.applyControlById(resumeId);
  assert.equal(repo.getJob(job.id)!.state, "running");
  db.close();
});

test("pairing accepts only the locally generated code and records the candidate", () => {
  const { db, repo, supervisor } = setup({ telegram: { tokenSecretName: "x", ownerUserId: null, ownerChatId: null, pollTimeoutSeconds: 25, allowedUpdates: ["message", "callback_query"] } });
  const code = generatePairingCode();
  supervisor.pairing.startPairing(code);
  const update: TgUpdate = {
    update_id: 20,
    message: { message_id: 20, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Owner" }, text: `/start ${code}` },
  };
  assert.equal(supervisor.admitBatch([update])[0]?.decision, "paired");
  const candidate = supervisor.pairing.getPendingCandidate();
  assert.equal(candidate?.userId, "42");
  assert.equal(repo.isPairingMode(), true);
  db.close();
});

test("plain text answers a pending owner question instead of creating a job", () => {
  const { db, repo, supervisor } = setup();
  supervisor.admitBatch([ownerMessage(30, "task")]);
  const job = repo.listQueuedJobs()[0]!;
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  repo.transitionJob(job.id, "waiting_for_owner");
  supervisor.questions.create({ jobId: job.id, ownerUserId: "1001", ownerChatId: "1001", question: "Which account?", ttlMs: 60000 });
  const admissions = supervisor.admitBatch([ownerMessage(31, "the work account")]);
  assert.equal(admissions[0]?.decision, "question_answer");
  assert.equal(repo.listQueuedJobs().length, 0);
  db.close();
});

for (const notifyImmediately of [true, false]) {
  test(`an owner reply resumes the waiting tool through ${notifyImmediately ? "notification" : "database polling"}`, { timeout: 5000 }, async (t) => {
    const { config, db, repo, supervisor, outbox } = setup();
    supervisor.admitBatch([ownerMessage(40, "check repository traffic")]);
    const job = repo.listQueuedJobs()[0]!;
    repo.transitionJob(job.id, "starting");
    repo.transitionJob(job.id, "running");
    const lease = new DesktopLease();
    lease.grant(job.id, job.lease_generation);
    const broker = new ToolBroker({ db, repo, config, logger: new Logger({}, { toStderr: false }), lease,
      approvals: supervisor.approvals, questions: supervisor.questions, artifacts: supervisor.artifacts, getOutbox: () => outbox });
    registerTelegramTools(broker);
    let notifications = 0;
    if (notifyImmediately) supervisor.setExecutor(Object.assign(new NullExecutor(), {
      notifyOwnerAnswer(questionId: string, answer: string) {
        const saved = supervisor.questions.get(questionId);
        assert.equal(saved?.status, "answered", "persist before waking the worker");
        assert.equal(saved.answer, answer);
        notifications += 1;
        broker.resolveOwnerAnswer(questionId, answer);
      },
    }));
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 3000);
    const pending = broker.execute({ jobId: job.id, leaseGeneration: job.lease_generation,
      requestId: "owner-input", toolCallId: "owner-input", toolName: "request_owner_input",
      args: { question: "Which repository?" }, signal: abort.signal });
    t.after(async () => { clearTimeout(deadline); abort.abort(); await pending; db.close(); });
    // The tool may yield once at its pause gate before creating the question.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(repo.getJob(job.id)?.state, "waiting_for_owner");
    const question = supervisor.questions.findPendingForJob(job.id)!;
    assert.ok(question);
    const admission = supervisor.admitBatch([ownerMessage(41, "the project repository")])[0]!;
    assert.equal(admission.decision, "question_answer");
    await supervisor.applyControlById(admission.controlId!);
    assert.equal(supervisor.questions.get(question.id)?.status, "answered");
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.result.details?.answer, "the project repository");
    assert.equal(supervisor.questions.get(question.id)?.status, "answered");
    assert.ok(supervisor.questions.get(question.id)?.answered_at);
    assert.equal(repo.getJob(job.id)?.state, "running");
    assert.equal(broker.pendingQuestionCount, 0);
    assert.equal(repo.listQueuedJobs().length, 0);
    assert.equal(notifications, notifyImmediately ? 1 : 0);
    assert.match(outbox.getByLogicalKey(`ctl:${admission.controlId}:reply`)!.payload_json, /Answer delivered/);
    await supervisor.applyControlById(admission.controlId!);
    assert.equal(notifications, notifyImmediately ? 1 : 0, "replaying an applied control cannot deliver it twice");
  });
}

test("rapid replies keep the original answer and cannot answer a later question", async (t) => {
  const { db, repo, supervisor, outbox } = setup();
  t.after(() => db.close());
  supervisor.admitBatch([ownerMessage(50, "task")]);
  const job = repo.listQueuedJobs()[0]!;
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  repo.transitionJob(job.id, "waiting_for_owner");
  const question = supervisor.questions.create({ jobId: job.id, ownerUserId: "1001", ownerChatId: "1001", question: "Which repository?", ttlMs: 60000 });
  const admissions = supervisor.admitBatch([ownerMessage(51, "the project repository"), ownerMessage(52, "???")]);
  const delivered: string[] = [];
  supervisor.setExecutor(Object.assign(new NullExecutor(), { notifyOwnerAnswer(_questionId: string, answer: string) { delivered.push(answer); } }));
  await supervisor.applyControlById(admissions[0]!.controlId!);
  // Simulate the tool issuing its next question before a delayed control is applied.
  const next = supervisor.questions.create({ jobId: job.id, ownerUserId: "1001", ownerChatId: "1001", question: "Which period?", ttlMs: 60000 });
  await supervisor.applyControlById(admissions[1]!.controlId!);
  assert.equal(supervisor.questions.get(question.id)?.answer, "the project repository");
  assert.equal(supervisor.questions.get(next.id)?.status, "pending");
  assert.equal(supervisor.questions.get(next.id)?.answer, null);
  assert.deepEqual(delivered, ["the project repository", "the project repository"]);
  assert.match(outbox.getByLogicalKey(`ctl:${admissions[1]!.controlId}:reply`)!.payload_json, /original answer was kept/);
});

test("invalid question controls never acknowledge delivery or wake a worker", async (t) => {
  for (const kind of ["expired", "cancelled", "wrong_job", "missing", "finished_job"] as const) {
    await t.test(kind, async (t) => {
      const { db, repo, supervisor, outbox } = setup();
      t.after(() => db.close());
      supervisor.admitBatch([ownerMessage(60, "task")]);
      const job = repo.listQueuedJobs()[0]!;
      repo.transitionJob(job.id, "starting");
      repo.transitionJob(job.id, "running");
      repo.transitionJob(job.id, "waiting_for_owner");
      const question = supervisor.questions.create({ jobId: job.id, ownerUserId: "1001", ownerChatId: "1001", question: "Which repository?", ttlMs: kind === "expired" ? -1 : 60000 });
      if (kind === "cancelled") supervisor.questions.cancelForJob(job.id);
      let controlJobId = job.id;
      if (kind === "wrong_job") {
        const other = repo.createJob({ conversationId: job.conversation_id, taskText: "other", taskLabel: "other", configHash: "test", modelJson: "{}" });
        repo.transitionJob(other.id, "starting");
        repo.transitionJob(other.id, "running");
        controlJobId = other.id;
      }
      if (kind === "finished_job") repo.transitionJob(job.id, "failed");
      let notified = false;
      supervisor.setExecutor(Object.assign(new NullExecutor(), { notifyOwnerAnswer() { notified = true; } }));
      const controlId = repo.insertControl({ jobId: controlJobId, command: JSON.stringify({ type: "answer_question", questionId: kind === "missing" ? "Q-missing" : question.id, answer: "the project repository" }) });
      await supervisor.applyControlById(controlId);
      assert.equal(notified, false);
      assert.equal(supervisor.questions.get(question.id)?.answer, null);
      if (kind === "expired") assert.equal(supervisor.questions.get(question.id)?.status, "expired");
      const reply = outbox.getByLogicalKey(`ctl:${controlId}:reply`)!.payload_json;
      assert.match(reply, /no longer waiting/);
      assert.doesNotMatch(reply, /Answer delivered/);
    });
  }
});
