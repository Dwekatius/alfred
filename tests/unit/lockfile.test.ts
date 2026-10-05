import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { acquireControllerLock, LockError, readLockInfo, type LockInfo, type LockProcessProbe } from "../../src/platform/lockfile.js";

const oldStart = "2026-01-01T00:00:00.000Z";
const newStart = "2026-02-01T00:00:00.000Z";

function withLock(body: (path: string) => void): void {
  const tempRoot = resolve(tmpdir());
  const root = mkdtempSync(join(tempRoot, "alfred-lock-"));
  try { body(join(root, "controller.lock")); }
  finally { assert.equal(dirname(root), tempRoot); rmSync(root, { recursive: true, force: true }); }
}

function owner(extra: Partial<LockInfo> = {}): LockInfo {
  return { pid: 12345, runId: "previous", startedAt: "2026-01-01T00:01:00.000Z", hostname: hostname(), ...extra };
}

function probe(start: string | undefined, alive = true): LockProcessProbe {
  return { isAlive: () => alive, startedAt: (pid) => pid === process.pid ? newStart : start };
}

test("new controller locks preserve the process creation identity", () => withLock((path) => {
  const lock = acquireControllerLock(path, "new", probe(newStart));
  assert.equal(lock.processStartedAt, newStart);
  assert.deepEqual(readLockInfo(path), lock);
}));

test("a matching live process identity keeps its controller lock", () => withLock((path) => {
  const lock = owner({ processStartedAt: oldStart });
  writeFileSync(path, JSON.stringify(lock));
  assert.throws(() => acquireControllerLock(path, "new", probe(oldStart)), LockError);
  assert.deepEqual(readLockInfo(path), lock);
}));

test("a recycled PID cannot hold an old controller lock", () => withLock((path) => {
  writeFileSync(path, JSON.stringify(owner({ processStartedAt: oldStart })));
  assert.equal(acquireControllerLock(path, "new", probe(newStart)).runId, "new");
}));

test("legacy locks distinguish a process created after the old lock from a live owner", () => withLock((path) => {
  writeFileSync(path, JSON.stringify(owner()));
  assert.throws(() => acquireControllerLock(path, "new", probe(oldStart)), LockError);
  assert.equal(acquireControllerLock(path, "new", probe(newStart)).runId, "new");
}));

test("failed process identity checks preserve a live owner's lock", () => withLock((path) => {
  const lock = owner({ processStartedAt: oldStart });
  writeFileSync(path, JSON.stringify(lock));
  assert.throws(() => acquireControllerLock(path, "new", probe(undefined)), LockError);
  assert.deepEqual(readLockInfo(path), lock);
}));

test("missing legacy timestamps cannot evict a live owner", () => withLock((path) => {
  const { startedAt: _omitted, ...legacy } = owner();
  writeFileSync(path, JSON.stringify(legacy));
  assert.throws(() => acquireControllerLock(path, "new", probe(newStart)), LockError);
  assert.equal(readLockInfo(path)?.runId, "previous");
}));

test("a dead owner releases its lock even without creation-time metadata", () => withLock((path) => {
  writeFileSync(path, JSON.stringify(owner()));
  assert.equal(acquireControllerLock(path, "new", probe(undefined, false)).runId, "new");
}));
