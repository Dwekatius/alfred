import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Logger, redactString } from "../../src/logging.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("telegram bot tokens are redacted", () => {
  const token = "123456789:AAFakeTokenValueThatIsLongEnough1234567890";
  const redacted = redactString(`send failed for ${token} now`);
  assert.equal(redacted.includes("AAFakeToken"), false);
  assert.ok(redacted.includes("[REDACTED]"));
});

test("telegram file URLs are redacted", () => {
  const url = "https://api.telegram.org/file/bot123456789:AAsecretsecretsecretsecretsecret/x/y.png";
  const redacted = redactString(url);
  assert.equal(redacted.includes("AAsecret"), false);
});

test("authorization headers and api keys are redacted", () => {
  assert.equal(redactString('Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz').includes("sk-abc"), false);
  assert.equal(redactString('x-api-key: sk-or-v1-abcdefghijklmnopqrstuvwxyz').includes("abcdefghij"), false);
});

test("secret query parameters are redacted", () => {
  const redacted = redactString("https://x.test/cb?access_token=abcd1234&next=2");
  assert.equal(redacted.includes("abcd1234"), false);
  assert.ok(redacted.includes("next=2"));
});

test("only allowlisted finite numeric token metrics bypass secret-key redaction", () => {
  const root = mkdtempSync(join(tmpdir(), "alfred-logs-"));
  try {
    const logger = new Logger({}, { toStderr: false, logDir: root, now: () => new Date("2026-01-01T00:00:00Z") });
    logger.info("metrics", "Counts only.", { inputTokens: 123, outputTokens: 45, reasoningTokens: 12, tokensPerSecond: 200, apiKey: 123, botToken: "private", nested: { inputTokens: "private", outputTokens: NaN, tokensPerSecond: -1 } });
    const line = JSON.parse(readFileSync(join(root, "controller-2026-01-01.jsonl"), "utf8"));
    assert.equal(line.inputTokens, 123); assert.equal(line.tokensPerSecond, 200);
    assert.equal(line.apiKey, "[REDACTED]"); assert.equal(line.botToken, "[REDACTED]");
    assert.deepEqual(line.nested, { inputTokens: "[REDACTED]", outputTokens: "[REDACTED]", tokensPerSecond: "[REDACTED]" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
