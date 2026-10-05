import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { registerTelegramTools } from "../../src/tools/telegram-tools.js";
import { Logger } from "../../src/logging.js";
import { testConfig } from "../fixtures/config.js";

test("saved image retrieval works across owner jobs and refuses another conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "alfred-artifact-unit-"));
  const db = Database.open(":memory:"); runMigrations(db);
  try {
    const repo = new JobRepository(db); const logger = new Logger({}, { toStderr: false }); const config = testConfig(); const lease = new DesktopLease();
    const artifacts = new ArtifactRegistry(db, root, logger);
    const broker = new ToolBroker({ db, repo, config, logger, lease, artifacts, approvals: new ApprovalRepository(db), questions: new QuestionRepository(db), getOutbox: () => undefined });
    registerTelegramTools(broker);
    const owner = repo.ensureConversation("1", "1"); const other = repo.createNewConversation("2", "2");
    const jobFor = (id: string) => repo.createJob({ conversationId: id, taskText: "test", taskLabel: "test", configHash: "test", modelJson: "{}" });
    const past = jobFor(owner.id); const foreign = jobFor(other.id); const current = jobFor(owner.id);
    repo.transitionJob(current.id, "starting"); repo.transitionJob(current.id, "running");
    const original = artifacts.register({ jobId: past.id, kind: "observation", mime: "image/png", bytes: Buffer.from("saved-test-image") });
    const forbidden = artifacts.register({ jobId: foreign.id, kind: "observation", mime: "image/png", bytes: Buffer.from("foreign-test-image") });
    const read = (artifactId: string) => broker.execute({ jobId: current.id, leaseGeneration: current.lease_generation, requestId: artifactId, toolCallId: artifactId, toolName: "artifact_read_image", args: { artifactId }, signal: new AbortController().signal });
    const result = await read(original.id);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.result.content.find((block) => block.type === "image")?.data, Buffer.from("saved-test-image").toString("base64"));
    const denied = await read(forbidden.id);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "ARTIFACT_NOT_FOUND");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
