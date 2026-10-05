import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { ApprovalRepository } from "../../src/jobs/approvals.js";
import { QuestionRepository } from "../../src/jobs/questions.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { ToolBroker } from "../../src/tools/broker.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { installDesktopTools } from "../../src/tools/windows-adapter.js";
import type { WindowsBackend } from "../../src/tools/windows-mcp.js";
import { Logger } from "../../src/logging.js";
import { testConfig } from "../fixtures/config.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "alfred-desktop-unit-"));
  const png = (await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");
  const db = Database.open(":memory:"); runMigrations(db);
  const repo = new JobRepository(db);
  const config = testConfig();
  const logger = new Logger({}, { toStderr: false });
  const lease = new DesktopLease();
  const artifacts = new ArtifactRegistry(db, root, logger);
  const broker = new ToolBroker({ db, repo, config, lease, artifacts, logger, approvals: new ApprovalRepository(db), questions: new QuestionRepository(db), getOutbox: () => undefined });
  const conversation = repo.ensureConversation("1", "1");
  const job = repo.createJob({ conversationId: conversation.id, taskText: "test", taskLabel: "test", configHash: "test", modelJson: "{}" });
  repo.transitionJob(job.id, "starting"); repo.transitionJob(job.id, "running");
  const generation = repo.getJob(job.id)!.lease_generation;
  lease.grant(job.id, generation);
  const state = { clicks: 0, snapshots: 0, polls: 0, readyAfter: 0, title: "Test window", element: "Ready input", failCapture: false, moved: false, clickArgs: {} as Record<string, unknown>, captureArgs: {} as Record<string, unknown>, afterClick: () => undefined as void };
  const rect = { left: -100, top: -50, right: 100, bottom: 50, width: 200, height: 100 };
  const windowInfo = () => ({ handle: "0x64", title: state.title, rect: { ...rect, ...(state.moved ? { left: -90, right: 110 } : {}) } });
  const windows = {
    helper: { sessionState: async () => ({ locked: false }), foregroundWindow: async () => windowInfo(), windowInfo: async () => windowInfo(), windowsList: async () => { state.polls += 1; return [{ ...windowInfo(), title: state.polls >= state.readyAfter ? state.title : "Loading" }]; }, monitors: async () => [], typeText: async () => ({ typed: 1 }), keyHold: async () => ({}) },
    mcp: { callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === "Click") { state.clicks += 1; state.clickArgs = args; state.afterClick(); }
      if (name !== "Snapshot") return { content: [{ type: "text", text: "Action completed" }], isError: false };
      state.snapshots += 1;
      state.captureArgs = args;
      if (args.use_vision && state.failCapture) return { content: [{ type: "text", text: "Snapshot failed" }], isError: true };
      if (!args.use_vision) state.polls += 1;
      const ready = state.polls >= state.readyAfter;
      const title = ready ? state.title : "Loading";
      const region = args.region as number[] | undefined;
      const text = `Screenshot Original Size: (200,100)\n${region ? `Screenshot Region: (${region.join(",")})\n` : ""}Visible Displays: 1:DISPLAY (-100,-50,100,50) primary\nFocused Window:\n${title}  1  Normal  200  100  100\nOpened Windows:\n${title}  1  Normal  200  100  100\nUI Tree:\n${args.use_ui_tree ? `(0,0) Edit \"${ready ? state.element : "Loading"}\" [focused] value:\"text-content\"\nNoninteractive document evidence.` : ""}`;
      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [{ type: "text", text }];
      if (args.use_vision) content.push({ type: "image", data: png, mimeType: "image/png" });
      return { content, isError: false };
    } },
  } as unknown as WindowsBackend;
  installDesktopTools(broker, { config, windows, lease, logger });
  let counter = 0;
  const request = (toolName: string, args: unknown, signal = new AbortController().signal) => broker.execute({ jobId: job.id, leaseGeneration: generation, requestId: `r-${++counter}`, toolCallId: `t-${counter}`, toolName, args, signal });
  const observe = async () => {
    const result = await request("desktop_observe", {});
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("observation failed");
    return result.result.details!.observationId as string;
  };
  const dispose = () => { db.close(); rmSync(root, { recursive: true, force: true }); };
  return { state, request, observe, dispose, repo, job, broker, lease };
}

test("one action returns fresh evidence under one mutex, and stale refs cannot be reused", { timeout: 3000 }, async () => {
  const s = await setup();
  try {
    const oldId = await s.observe();
    const before = s.state.snapshots;
    const result = await s.request("desktop_click", { observationId: oldId, target: { elementRef: "E1" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error("click failed");
    const newId = result.result.details!.observationId;
    assert.notEqual(newId, oldId);
    assert.equal(s.state.snapshots, before + 1, "exactly one post-action screen");
    assert.equal(s.state.clicks, 1);
    assert.ok(result.result.content.some((block) => block.type === "image"));
    const stale = await s.request("desktop_click", { observationId: oldId, target: { elementRef: "E1" } });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "STALE_OBSERVATION");
    assert.equal(s.state.clicks, 1);
    const next = await s.request("desktop_click", { observationId: newId, target: { elementRef: "E1" } });
    assert.equal(next.ok, true);
    assert.equal(s.state.clicks, 2);
  } finally { s.dispose(); }
});

test("verification failure reports completed action, never replays it", async () => {
  const s = await setup();
  try {
    const id = await s.observe(); s.state.failCapture = true;
    const result = await s.request("desktop_click", { observationId: id, target: { elementRef: "E1" } });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.actionOutcome, "completed"); assert.equal(result.error.retryable, false); assert.match(result.error.message, /Do not repeat/); }
    assert.equal(s.state.clicks, 1);
  } finally { s.dispose(); }
});

test("stop and pause between input and verification prevent subsequent operations", async () => {
  for (const mode of ["stop", "pause"]) {
    const s = await setup();
    try {
      const id = await s.observe(); const before = s.state.snapshots;
      const abort = new AbortController();
      s.state.afterClick = () => {
        if (mode === "stop") abort.abort();
        else { s.repo.transitionJob(s.job.id, "paused"); s.broker.setPaused(s.job.id, true); s.lease.pause(s.job.id); }
      };
      const result = await s.request("desktop_click", { observationId: id, target: { elementRef: "E1" } }, abort.signal);
      assert.equal(result.ok, false);
      if (!result.ok) { assert.equal(result.error.code, mode === "stop" ? "CANCELLED" : "PAUSED"); assert.equal(result.error.actionOutcome, "completed"); }
      assert.equal(s.state.clicks, 1); assert.equal(s.state.snapshots, before);
    } finally { s.dispose(); }
  }
});

test("readiness exits early without polling screenshots, then captures once", { timeout: 3000 }, async () => {
  const s = await setup();
  try {
    s.state.readyAfter = 3;
    const started = Date.now();
    const result = await s.request("desktop_app", { action: "launch", executable: "test.exe", waitFor: { condition: "element", text: "Ready input", timeoutMs: 2000, pollIntervalMs: 100 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(s.state.polls, 3);
    assert.equal(s.state.snapshots, 4, "three cheap probes and one image");
    assert.ok(Date.now() - started < 1500, "must not sleep the whole timeout");
  } finally { s.dispose(); }
});

test("readiness timeout is bounded and an action is not retried", { timeout: 3000 }, async () => {
  const s = await setup();
  try {
    const id = await s.observe(); s.state.readyAfter = 999;
    const started = Date.now();
    const result = await s.request("desktop_click", { observationId: id, target: { elementRef: "E1" }, waitFor: { condition: "window", text: "Test window", timeoutMs: 150, pollIntervalMs: 100 } });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, "TOOL_TIMEOUT"); assert.equal(result.error.actionOutcome, "completed"); }
    assert.ok(Date.now() - started < 1000);
    assert.equal(s.state.clicks, 1);
  } finally { s.dispose(); }
});

test("invalid conditions are rejected before action; waits cancel promptly", async () => {
  const s = await setup();
  try {
    const id = await s.observe();
    const invalid = await s.request("desktop_click", { observationId: id, target: { elementRef: "E1" }, waitFor: { condition: "window" } });
    assert.equal(invalid.ok, false); assert.equal(s.state.clicks, 0);
    const time = await s.request("desktop_wait", { condition: "time" });
    assert.equal(time.ok, false);
    const abort = new AbortController();
    const pending = s.request("desktop_wait", { condition: "time", ms: 30000 }, abort.signal);
    setTimeout(() => abort.abort(), 10);
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CANCELLED");
  } finally { s.dispose(); }
});

test("window crops preserve negative physical offsets and concise UI text", async () => {
  const s = await setup();
  try {
    const result = await s.request("desktop_observe", { scope: "window" });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error("capture failed");
    assert.deepEqual(s.state.captureArgs.region, [-100, -50, 100, 50]);
    assert.deepEqual(result.result.details!.captureBounds, { left: -100, top: -50, width: 200, height: 100 });
    const text = result.result.content.find((block) => block.type === "text")!.text;
    assert.equal((text.match(/Ready input/g) ?? []).length, 1, "element text is not duplicated");
    assert.match(text, /Noninteractive document evidence/);
    assert.match(text, /text-content/);
    const click = await s.request("desktop_click", { observationId: result.result.details!.observationId, target: { point: { x: 25, y: 50 } }, observeAfter: false });
    assert.equal(click.ok, true);
    assert.deepEqual(s.state.clickArgs.loc, [-75, 0]);
  } finally { s.dispose(); }
});
