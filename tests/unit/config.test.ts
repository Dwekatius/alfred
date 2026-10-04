import { strict as assert } from "node:assert";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig, saveConfigAtomic, validateConfig } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";

test("valid configuration loads from disk", () => {
  const path = join(tmpdir(), `pi-tg-config-${Date.now()}.json`);
  const config = testConfig();
  writeFileSync(path, JSON.stringify(config));
  const loaded = loadConfig(path);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.models.selectedSlot, "openrouter");
});

test("unknown security-sensitive keys are rejected", () => {
  const config = testConfig() as unknown as Record<string, unknown>;
  config.telegram = { ...(config.telegram as Record<string, unknown>), extraSecretKey: "x" };
  assert.throws(() => validateConfig(config), /validation failed/i);
});

test("relative paths are rejected", () => {
  const config = testConfig();
  assert.throws(() => validateConfig({ ...config, dataRoot: "relative\\path" }), /absolute path/);
});

test("invalid time zone is rejected", () => {
  const config = testConfig();
  assert.throws(() => validateConfig({ ...config, timeZone: "Not/AZone" }), /IANA time zone/);
});

test("owner id without chat id is rejected", () => {
  const config = testConfig();
  assert.throws(() => validateConfig({ ...config, telegram: { ...config.telegram, ownerChatId: null } }), /ownerChatId must be set/);
});

test("atomic save writes the validated candidate", () => {
  const path = join(tmpdir(), `pi-tg-config-${Date.now()}-atomic.json`);
  const saved = saveConfigAtomic(path, testConfig());
  const loaded = loadConfig(path);
  assert.deepEqual(loaded, saved);
});

test("invalid selectedSlot is rejected", () => {
  const config = testConfig();
  assert.throws(() => validateConfig({ ...config, models: { ...config.models, selectedSlot: "other" } }));
});
