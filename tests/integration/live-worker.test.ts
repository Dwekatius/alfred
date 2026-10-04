/**
 * Live SDK integration: a real Pi worker, the free OpenRouter slot, and fake
 * broker tools. Gated by PI_TG_LIVE_TEST=1 so ordinary test runs stay offline.
 *
 * Evidence for the Phase 3 gate: two tool turns, an image result the model can
 * read, IPC tool requests, and a settled final transcript.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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
import { WorkerExecutor } from "../../src/pi/worker-executor.js";
import { Logger } from "../../src/logging.js";
import { dataPaths, ensureDataDirs, type AppConfig } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";

const enabled = process.env.PI_TG_LIVE_TEST === "1";
const deepseekEnabled = process.env.PI_TG_LIVE_DEEPSEEK === "1";

test("live worker runs two fake tool turns including an image", { skip: !enabled, timeout: 300000 }, async () => {
  process.env.PI_TG_ENABLE_FAKE_TOOLS = "1";
  const root = join(tmpdir(), "pi-tg-live", randomUUID());
  const piAgent = join(homedir(), ".pi", "agent");
  const config: AppConfig = testConfig({
    dataRoot: root,
    workRoot: join(root, "work"),
    models: {
      authPath: join(piAgent, "auth.json"),
      baseModelsPath: join(piAgent, "models.json"),
      catalogSeedPath: join(piAgent, "models-store.json"),
      selectedSlot: "openrouter",
      thinking: "low",
      allowAutomaticModelFallback: false,
      slots: {
        deepseek: { provider: "deepseek", modelId: "deepseek-flash" },
        openrouter: { provider: "openrouter", modelId: "stealth/space-bunny-alpha", routing: { only: ["stealth"], allow_fallbacks: false }, requireZeroTokenPrice: true },
      },
    },
  });
  const paths = dataPaths(config);
  ensureDataDirs(paths);

  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const logger = new Logger({}, { toStderr: false });
  const artifacts = new ArtifactRegistry(db, paths.artifactsDir, logger);
  const approvals = new ApprovalRepository(db);
  const questions = new QuestionRepository(db);
  const lease = new DesktopLease();
  const broker = new ToolBroker({ db, repo, approvals, questions, artifacts, getOutbox: () => undefined, config, logger, lease });
  registerFakeTools(broker);

  const executor = new WorkerExecutor({ config, paths, logger: new Logger({}, { toStderr: true }), repo, broker, lease, artifacts });
  const conversation = repo.ensureConversation("1", "1");
  const job = repo.createJob({ conversationId: conversation.id, taskText: "Use the fake_echo tool once with text alpha-42. Then use the fake_image tool once with code VIS-77. Then reply with exactly the echoed text and the code you saw in the image.", taskLabel: "live smoke", configHash: "live", modelJson: JSON.stringify({ slot: "openrouter", thinking: "low" }) });
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  repo.setJobLeaseGeneration(job.id, 1);
  const running = repo.getJob(job.id)!;

  const controller = new AbortController();
  const outcome = await executor.execute({ job: running, signal: controller.signal, deadline: Date.now() + 280000 });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome));
  const text = outcome.resultText ?? "";
  assert.match(text, /alpha-42/i);
  assert.match(text, /VIS-77/i);
  const events = repo.listJobEvents(job.id, 200);
  assert.ok(events.some((event) => event.tool_name === "fake_echo"));
  assert.ok(events.some((event) => event.tool_name === "fake_image"));
  await executor.dispose();
  db.close();
});

test("live worker on DeepSeek Flash with max thinking answers directly", { skip: !deepseekEnabled, timeout: 300000 }, async () => {
  process.env.PI_TG_ENABLE_FAKE_TOOLS = "1";
  const streamEvents: Array<{ kind: string; text: string }> = [];
  const usages: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs?: number; ttftMs?: number; streamMs?: number }> = [];
  const root = join(tmpdir(), "pi-tg-live-ds", randomUUID());
  const piAgent = join(homedir(), ".pi", "agent");
  const config: AppConfig = testConfig({
    dataRoot: root,
    workRoot: join(root, "work"),
    models: {
      authPath: join(piAgent, "auth.json"),
      baseModelsPath: join(piAgent, "models.json"),
      catalogSeedPath: join(piAgent, "models-store.json"),
      selectedSlot: "deepseek",
      thinking: "max",
      allowAutomaticModelFallback: false,
      slots: {
        deepseek: { provider: "deepseek", modelId: "deepseek-flash" },
        openrouter: { provider: "openrouter", modelId: "stealth/space-bunny-alpha" },
      },
    },
  });
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const logger = new Logger({}, { toStderr: false });
  const artifacts = new ArtifactRegistry(db, paths.artifactsDir, logger);
  const lease = new DesktopLease();
  const broker = new ToolBroker({ db, repo, approvals: new ApprovalRepository(db), questions: new QuestionRepository(db), artifacts, getOutbox: () => undefined, config, logger, lease });
  registerFakeTools(broker);
  const executor = new WorkerExecutor({ config, paths, logger: new Logger({}, { toStderr: true }), repo, broker, lease, artifacts, onStream: (jobId, kind, text) => streamEvents.push({ kind, text }), onModelUsage: (jobId, usage) => usages.push(usage) });
  const conversation = repo.ensureConversation("1", "1");
  const job = repo.createJob({ conversationId: conversation.id, taskText: "Think briefly, then reply with exactly one short sentence: which model and thinking level are you using?", taskLabel: "deepseek live", configHash: "live", modelJson: JSON.stringify({ slot: "deepseek", thinking: "max" }) });
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  repo.setJobLeaseGeneration(job.id, 1);
  const controller = new AbortController();
  const outcome = await executor.execute({ job: repo.getJob(job.id)!, signal: controller.signal, deadline: Date.now() + 280000 });
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome));
  assert.ok((outcome.resultText ?? "").length > 0);
  // Dashboard telemetry: streamed answer text and exact token/cost usage.
  assert.ok(streamEvents.some((event) => event.kind === "answer" && event.text.length > 0), "expected streamed answer deltas");
  assert.ok(streamEvents.some((event) => event.kind === "answer_end" || event.kind === "thinking_end"), "expected a block end marker");
  assert.ok(usages.length > 0, "expected at least one usage record");
  assert.ok(usages[0]!.outputTokens > 0, "expected output tokens");
  assert.ok((usages[0]!.durationMs ?? 0) > 0, "expected a measured response duration for tokens/second");
  const sample = usages[0]!;
  const decodeSeconds = (sample.streamMs ?? sample.durationMs ?? 1) / 1000;
  console.log(`live metrics: out=${sample.outputTokens} · ttftMs=${sample.ttftMs ?? "n/a"} · streamMs=${sample.streamMs ?? "n/a"} · wallMs=${sample.durationMs} · decode≈${(sample.outputTokens / decodeSeconds).toFixed(1)} tok/s`);
  assert.equal(usages[0]!.provider, "deepseek");
  await executor.dispose();
  db.close();
});
