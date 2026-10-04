/**
 * Live Windows desktop validation. Gated: PI_TG_LIVE_DESKTOP=1.
 * Full native input (Notepad typing) additionally requires PI_TG_LIVE_DESKTOP_FULL=1.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { ApprovalRepository } from "../../src/jobs/approvals.js";
import { QuestionRepository } from "../../src/jobs/questions.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { ToolBroker } from "../../src/tools/broker.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { CreateWindowsBackend } from "../../src/tools/windows-mcp.js";
import { installDesktopTools } from "../../src/tools/windows-adapter.js";
import { installFileTools } from "../../src/tools/files.js";
import { installPowerShellTools } from "../../src/tools/powershell.js";
import { ScreenshotService } from "../../src/artifacts/screenshot.js";
import { Logger } from "../../src/logging.js";
import { dataPaths, ensureDataDirs, type AppConfig } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";

const enabled = process.env.PI_TG_LIVE_DESKTOP === "1";
const full = process.env.PI_TG_LIVE_DESKTOP_FULL === "1";

function setup() {
  const root = join(tmpdir(), "pi-tg-desktop", randomUUID());
  const piAgent = join(homedir(), ".pi", "agent");
  const config: AppConfig = testConfig({
    dryRun: false,
    dataRoot: root,
    workRoot: join(root, "work"),
    models: { ...testConfig().models, authPath: join(piAgent, "auth.json"), baseModelsPath: join(piAgent, "models.json"), catalogSeedPath: join(piAgent, "models-store.json") },
  });
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const logger = new Logger({}, { toStderr: true });
  const artifacts = new ArtifactRegistry(db, paths.artifactsDir, logger);
  const lease = new DesktopLease();
  const windows = CreateWindowsBackend({ config, paths, logger });
  const broker = new ToolBroker({ db, repo, approvals: new ApprovalRepository(db), questions: new QuestionRepository(db), artifacts, getOutbox: () => undefined, config, logger, lease });
  installDesktopTools(broker, { windows, lease, logger, config });
  installFileTools(broker, { config, paths, logger });
  installPowerShellTools(broker, { config, paths, logger });
  const conversation = repo.ensureConversation("1", "1");
  const job = repo.createJob({ conversationId: conversation.id, taskText: "desktop smoke", taskLabel: "desktop smoke", configHash: "live", modelJson: "{}" });
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  repo.setJobLeaseGeneration(job.id, 1);
  return { config, paths, db, repo, artifacts, lease, windows, broker, job: repo.getJob(job.id)!, logger };
}

function request(s: ReturnType<typeof setup>, toolName: string, args: unknown, requestId = "r1") {
  return { jobId: s.job.id, leaseGeneration: s.job.lease_generation, requestId, toolCallId: `t-${requestId}`, toolName, args, signal: new AbortController().signal };
}

test("live desktop observation returns geometry, elements, and an image artifact", { skip: !enabled, timeout: 120000 }, async () => {
  const s = setup();
  await s.windows.ensureStarted();
  const tools = s.windows.listTools().map((tool) => tool.name);
  assert.ok(tools.includes("Snapshot"));
  assert.ok(tools.includes("Click"));
  assert.ok(tools.includes("Type"));
  assert.ok(existsSync(join(s.paths.manifestsDir, "windows-mcp-tools.json")));

  const result = await s.broker.execute(request(s, "desktop_observe", { scope: "desktop", annotate: false, includeUiTree: true }));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    const image = result.result.content.find((block) => block.type === "image");
    assert.ok(image && image.type === "image" && image.data.length > 1000, "expected a real PNG image block");
    const bounds = result.result.details?.captureBounds as { left: number; top: number; width: number; height: number };
    const size = result.result.details?.imageSize as { width: number; height: number };
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(size.width > 0 && size.height > 0);
    const text = result.result.content.find((block) => block.type === "text")?.text ?? "";
    assert.match(text, /elementRefs:/);
    assert.match(text, /E\d+ \(-?\d+,-?\d+\)/);
  }
  await s.windows.dispose();
  s.db.close();
});

test("live screenshot service captures the desktop and focused window", { skip: !enabled, timeout: 120000 }, async () => {
  const s = setup();
  const service = new ScreenshotService({ config: s.config, artifacts: s.artifacts, windows: s.windows, lease: s.lease, logger: s.logger });
  const desktop = await service.capture("desktop");
  assert.ok("artifactId" in desktop, JSON.stringify(desktop));
  const window = await service.capture("window");
  assert.ok("artifactId" in window, JSON.stringify(window));
  await s.windows.dispose();
  s.db.close();
});

test("live native input types into Notepad and saves", { skip: !(enabled && full), timeout: 180000 }, async () => {
  const s = setup();
  try {
    const file = join(s.paths.workRoot, "desktop-smoke.txt");
    writeFileSync(file, "start-marker\n", "utf8");

    const launch = await s.broker.execute(request(s, "desktop_app", { action: "launch", executable: "C:\\Windows\\System32\\notepad.exe", args: [file] }, "r-launch"));
    assert.equal(launch.ok, true, JSON.stringify(launch));

    // Give Notepad time to appear, then observe and type at the focused editor.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const observe = await s.broker.execute(request(s, "desktop_observe", { scope: "desktop", includeUiTree: true, annotate: false }, "r-observe"));
    assert.equal(observe.ok, true, JSON.stringify(observe));
    const observationId = observe.ok ? (observe.result.details?.observationId as string) : undefined;
    assert.ok(observationId);

    const typed = await s.broker.execute(request(s, "desktop_type", { observationId, text: "typed-by-pi-42", mode: "append" }, "r-type"));
    assert.equal(typed.ok, true, JSON.stringify(typed));

    // Typing invalidates the observation by design: save with a key-only action.
    const saved = await s.broker.execute(request(s, "desktop_key", { keys: "ctrl+s" }, "r-save"));
    assert.equal(saved.ok, true, JSON.stringify(saved));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const content = readFileSync(file, "utf8");
    assert.match(content, /typed-by-pi-42/);

    // Close the Notepad tab we used (already saved, so no prompt).
    await s.broker.execute(request(s, "desktop_key", { keys: "ctrl+w" }, "r-close"));
  } finally {
    await s.windows.dispose().catch(() => undefined);
    s.db.close();
  }
});
