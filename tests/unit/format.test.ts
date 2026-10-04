import { strict as assert } from "node:assert";
import { test } from "node:test";
import { splitMessage, withPartNumbering, caption, taskLabel, formatDuration, DEFAULT_TEXT_TARGET } from "../../src/telegram/format.js";

test("short text is not split", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
});

test("long text splits at paragraph boundaries with part numbering", () => {
  const paragraph = "Sentence with some words. ".repeat(120);
  const text = [paragraph, paragraph, paragraph].join("\n\n");
  const parts = splitMessage(text);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= DEFAULT_TEXT_TARGET + 1);
  const numbered = withPartNumbering(parts);
  assert.match(numbered[0]!, /^\[part 1\//);
});

test("emoji and arabic text survive splitting", () => {
  const text = "مرحبا بالعالم 👨‍👩‍👧‍👦 ".repeat(400);
  const parts = splitMessage(text);
  const rejoined = parts.join("");
  // No replacement characters or lone surrogates.
  assert.equal(/\uFFFD/.test(rejoined), false);
  for (let index = 0; index < rejoined.length; index += 1) {
    const code = rejoined.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = rejoined.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${index}`);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = rejoined.charCodeAt(index - 1);
      assert.ok(prev >= 0xd800 && prev <= 0xdbff, `lone low surrogate at ${index}`);
    }
  }
});

test("caption truncates at 1024 characters", () => {
  const text = "a".repeat(2000);
  assert.equal(caption(text).length, 1024);
  assert.ok(caption(text).endsWith("\u2026"));
});

test("taskLabel collapses whitespace", () => {
  assert.equal(taskLabel("  hello   world \n"), "hello world");
  assert.ok(taskLabel("x".repeat(200)).length <= 60);
});

test("duration formatting", () => {
  assert.equal(formatDuration(45000), "45s");
  assert.equal(formatDuration(125000), "2m 5s");
  assert.equal(formatDuration(3700000), "1h 1m");
});
