import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { Supervisor } from "../../src/supervisor.js";
import { Logger } from "../../src/logging.js";
import { dataPaths, type AppConfig } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";
import type { SecretStore } from "../../src/platform/secrets.js";

function setup() {
  const config: AppConfig = testConfig();
  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const secrets = { get: async () => undefined, set: async () => undefined, delete: () => undefined, healthCheck: async () => true } as unknown as SecretStore;
  const supervisor = new Supervisor({ config, configPath: join(config.dataRoot, "config.json"), paths: dataPaths(config), db, repo, secrets, logger: new Logger({}, { toStderr: false }), runId: `run-${randomUUID().slice(0, 6)}` });
  const flush = () => (supervisor as unknown as { flushStreamEvents(): void }).flushStreamEvents();
  return { db, supervisor, flush };
}

function rows(db: Database) {
  return db.prepare("SELECT id, kind, text, updated_at FROM stream_events ORDER BY id").all() as Array<{ id: number; kind: string; text: string; updated_at: string }>;
}

test("request timings and projection sizes persist with exact usage", () => {
  const { db, supervisor, flush } = setup();
  supervisor.recordModelUsage("J-test", { protocolVersion: 1, type: "model_usage", jobId: "J-test", leaseGeneration: 1, requestId: "metric", provider: "deepseek", model: "deepseek-flash", inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 10, costUsd: 0.001, durationMs: 1200, ttftMs: 900, streamMs: 300, responseOpenMs: 750, preparationMs: 12, contextBytes: 4096, imageCount: 1, imageBase64Bytes: 2048 });
  flush();
  const row = db.prepare("SELECT * FROM usage_events").get() as Record<string, unknown>;
  assert.equal(row.duration_ms, 1200); assert.equal(row.ttft_ms, 900); assert.equal(row.response_open_ms, 750);
  assert.equal(row.context_bytes, 4096); assert.equal(row.image_count, 1); assert.equal(row.image_base64_bytes, 2048);
  assert.equal(row.reasoning_tokens, 10);
  db.close();
});

test("thinking deltas aggregate into one row and end markers close the block", () => {
  const { db, supervisor, flush } = setup();
  supervisor.recordStream("J-1", "thinking", "Let me ");
  supervisor.recordStream("J-1", "thinking", "think about ");
  flush();
  let list = rows(db);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, "thinking");
  assert.equal(list[0]!.text, "Let me think about ");

  supervisor.recordStream("J-1", "thinking", "this.");
  flush();
  list = rows(db);
  assert.equal(list.length, 1, "continuation appends to the same row");
  assert.equal(list[0]!.text, "Let me think about this.");

  supervisor.recordStream("J-1", "thinking_end", "");
  flush();
  list = rows(db);
  assert.equal(list.length, 2);
  assert.equal(list[1]!.kind, "thinking_end");

  // A second chain starts a fresh row.
  supervisor.recordStream("J-1", "thinking", "Second chain");
  supervisor.recordStream("J-1", "answer", "The answer");
  flush();
  list = rows(db);
  assert.equal(list.filter((row) => row.kind === "thinking").length, 2);
  assert.equal(list.filter((row) => row.kind === "answer").length, 1);
  assert.ok(list.every((row) => typeof row.updated_at === "string" && row.updated_at.length > 0));
  db.close();
});

test("switching kind and single-shot events close open blocks", () => {
  const { db, supervisor, flush } = setup();
  supervisor.recordStream("J-1", "thinking", "first");
  flush();
  supervisor.recordStream("J-1", "tool", "running desktop_observe");
  flush();
  supervisor.recordStream("J-1", "thinking", "second");
  flush();
  const list = rows(db);
  assert.deepEqual(list.map((row) => row.kind), ["thinking", "tool", "thinking"]);
  assert.equal(list[0]!.text, "first");
  assert.equal(list[2]!.text, "second");
  db.close();
});

test("usage lines are recorded as single rows", () => {
  const { db, supervisor, flush } = setup();
  supervisor.recordStream("J-1", "answer", "done");
  supervisor.recordStream("J-1", "usage", "deepseek/deepseek-flash — in=1,000 · out=250 · 41.7 tok/s · 6.0s · $0.0006");
  flush();
  const list = rows(db);
  assert.deepEqual(list.map((row) => row.kind), ["answer", "usage"]);
  assert.match(list[1]!.text, /tok\/s/);
  db.close();
});
