import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IPC_PROTOCOL_VERSION, parseSupervisorMessage, parseWorkerMessage } from "../../src/ipc.js";

const envelope = { protocolVersion: IPC_PROTOCOL_VERSION, jobId: "J-1", leaseGeneration: 1, requestId: "r-1" };

test("valid worker tool requests parse", () => {
  const message = parseWorkerMessage({ ...envelope, type: "tool_request", toolCallId: "t1", toolName: "fake_echo", args: { text: "hi" } });
  assert.ok(message);
  assert.equal(message?.type, "tool_request");
});

test("wrong protocol versions and unknown types are rejected", () => {
  assert.equal(parseWorkerMessage({ ...envelope, protocolVersion: 999, type: "ready", pid: 1 }), undefined);
  assert.equal(parseWorkerMessage({ ...envelope, type: "surprise" }), undefined);
  assert.equal(parseWorkerMessage({ type: "ready", pid: 1 }), undefined);
});

test("malformed start_job messages are rejected", () => {
  assert.equal(parseSupervisorMessage({ ...envelope, type: "start_job", taskText: "x" }), undefined);
  const valid = parseSupervisorMessage({
    ...envelope,
    type: "start_job",
    taskText: "hello",
    workRoot: "C:\\w",
    sessionDir: "C:\\s",
    sessionFile: null,
    authPath: "C:\\a",
    modelsPath: "C:\\m",
    modelsStorePath: "C:\\ms",
    model: { provider: "openrouter", modelId: "x", thinking: "low" },
    images: [],
    limits: { maxToolCalls: 1, maxModelTurns: 1, maxRunSeconds: 10 },
  });
  assert.ok(valid);
});

test("abort and steer parse, garbage does not", () => {
  assert.equal(parseSupervisorMessage({ ...envelope, type: "abort", reason: "stop" })?.type, "abort");
  assert.equal(parseSupervisorMessage({ ...envelope, type: "steer", text: "go left" })?.type, "steer");
  assert.equal(parseSupervisorMessage({ ...envelope, type: "steer", text: 5 }), undefined);
});
