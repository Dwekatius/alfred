/**
 * Live Playwright MCP validation with the dedicated visible Chrome profile.
 * Gated: PI_TG_LIVE_BROWSER=1. Opens a real Chrome window.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { ApprovalRepository } from "../../src/jobs/approvals.js";
import { QuestionRepository } from "../../src/jobs/questions.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { ToolBroker } from "../../src/tools/broker.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { CreateWindowsBackend } from "../../src/tools/windows-mcp.js";
import { CreateBrowserBackend } from "../../src/tools/browser-mcp.js";
import { installBrowserTools } from "../../src/tools/browser-tools.js";
import { installDesktopTools } from "../../src/tools/windows-adapter.js";
import { Logger } from "../../src/logging.js";
import { dataPaths, ensureDataDirs, type AppConfig } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";

const enabled = process.env.PI_TG_LIVE_BROWSER === "1";

test("live browser returns action snapshots and preserves cookies after restart", { skip: !enabled, timeout: 300000 }, async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><title>Alfred speed test</title><h1>Alfred speed test</h1><button onclick="document.querySelector(\'p\').textContent=\'Ready now\'">Show ready</button><p>Waiting for click</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const root = join(tmpdir(), "pi-tg-browser", randomUUID());
  const config: AppConfig = testConfig({ dryRun: false, dataRoot: root, workRoot: join(root, "work"), browser: { ...testConfig().browser, profileDir: join(root, "browser", "profile"), outputDir: join(root, "browser", "output") } });
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  const db = Database.open(":memory:");
  runMigrations(db);
  const repo = new JobRepository(db);
  const logger = new Logger({}, { toStderr: true });
  const artifacts = new ArtifactRegistry(db, paths.artifactsDir, logger);
  const lease = new DesktopLease();
  const windows = CreateWindowsBackend({ config, paths, logger });
  const browser = CreateBrowserBackend({ config, paths, logger });
  const broker = new ToolBroker({ db, repo, approvals: new ApprovalRepository(db), questions: new QuestionRepository(db), artifacts, getOutbox: () => undefined, config, logger, lease });
  installDesktopTools(broker, { windows, lease, logger, config });
  installBrowserTools(broker, { browser, windows, lease, logger, config, paths, artifacts });
  const conversation = repo.ensureConversation("1", "1");
  const job = repo.createJob({ conversationId: conversation.id, taskText: "browser smoke", taskLabel: "browser smoke", configHash: "live", modelJson: "{}" });
  repo.transitionJob(job.id, "starting");
  repo.transitionJob(job.id, "running");
  repo.setJobLeaseGeneration(job.id, 1);
  const J = repo.getJob(job.id)!;
  const req = (tool: string, args: unknown, id: string) => ({ jobId: J.id, leaseGeneration: J.lease_generation, requestId: id, toolCallId: id, toolName: tool, args, signal: new AbortController().signal });

  try {
    const nav = await broker.execute(req("browser_navigate", { url }, "b1"));
    assert.equal(nav.ok, true, JSON.stringify(nav));
    const navText = nav.ok ? nav.result.content.find((block) => block.type === "text")?.text ?? "" : "";
    assert.match(navText, /Alfred speed test/i, "navigation already includes page evidence");

    const snapshot = await broker.execute(req("browser_snapshot", {}, "b2"));
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    if (snapshot.ok) {
      const text = snapshot.result.content.find((block) => block.type === "text")?.text ?? "";
      assert.match(text, /Alfred speed test/i);
    }

    const target = /button "Show ready"[^\n]*\[ref=([^\]]+)\]/.exec(navText)?.[1];
    assert.ok(target, "expected button reference in returned navigation snapshot");
    const clicked = await broker.execute(req("browser_click", { element: "Show ready button", target }, "b-click"));
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    if (clicked.ok) assert.match(clicked.result.content.find((block) => block.type === "text")?.text ?? "", /Ready now/, "click returns fresh state without another snapshot request");

    const cookie = await broker.execute(req("browser_evaluate", { function: "() => { document.cookie = 'alfred_speed_test=persisted; max-age=3600; path=/'; return document.cookie; }" }, "b-cookie"));
    assert.equal(cookie.ok, true, JSON.stringify(cookie));
    if (cookie.ok) assert.match(cookie.result.content.find((block) => block.type === "text")?.text ?? "", /alfred_speed_test=persisted/, "cookie was created before restart");

    const shot = await broker.execute(req("browser_take_screenshot", { fullPage: true, filename: "alfred-named-smoke.png" }, "b3"));
    assert.equal(shot.ok, true, JSON.stringify(shot));
    if (shot.ok) {
      assert.ok(typeof shot.result.details?.artifactId === "string");
      const artifact = artifacts.get(shot.result.details.artifactId as string);
      assert.ok(artifact && artifact.size_bytes > 1000);
      assert.equal(artifact.mime, "image/png");
      assert.ok(shot.result.content.some((block) => block.type === "image"), "named screenshots return the real image, not an output text file");
    }

    const tabs = await broker.execute(req("browser_tabs", { action: "list" }, "b4"));
    assert.equal(tabs.ok, true, JSON.stringify(tabs));

    await browser.restart();
    const reopened = await broker.execute(req("browser_navigate", { url }, "b-reopen"));
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    const persisted = await broker.execute(req("browser_evaluate", { function: "() => document.cookie" }, "b-cookie-check"));
    assert.equal(persisted.ok, true, JSON.stringify(persisted));
    if (persisted.ok) assert.match(persisted.result.content.find((block) => block.type === "text")?.text ?? "", /alfred_speed_test=persisted/);

    const closed = await broker.execute(req("browser_close", {}, "b5"));
    assert.equal(closed.ok, true, JSON.stringify(closed));
  } finally {
    await browser.dispose().catch(() => undefined);
    await windows.dispose().catch(() => undefined);
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
