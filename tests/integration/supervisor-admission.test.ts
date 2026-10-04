import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { Outbox } from "../../src/telegram/outbox.js";
import { Supervisor } from "../../src/supervisor.js";
import { generatePairingCode } from "../../src/telegram/auth.js";
import { Logger } from "../../src/logging.js";
import { dataPaths } from "../../src/config.js";
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
