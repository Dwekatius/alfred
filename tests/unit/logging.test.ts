import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactString } from "../../src/logging.js";

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
