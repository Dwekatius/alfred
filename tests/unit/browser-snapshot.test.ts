import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { inlineBrowserSnapshot } from "../../src/tools/browser-snapshot.js";

test("action snapshot links expand to the same evidence with bounded file reads", () => {
  const root = mkdtempSync(join(tmpdir(), "alfred-browser-unit-"));
  try {
    const output = join(root, "output"); mkdirSync(output);
    const file = join(output, "page-test.yml");
    writeFileSync(file, '- button "Show ready" [ref=e1]\n- paragraph: Ready now');
    for (const path of [file, relative(root, file), "page-test.yml"]) {
      const text = `### Page\nAlfred test\n### Snapshot\n- [Snapshot](${path})`;
      const result = inlineBrowserSnapshot(text, output, root);
      assert.equal(result.expanded, true);
      assert.match(result.text, /Ready now/);
    }
    const limited = inlineBrowserSnapshot(`### Snapshot\n[Snapshot](${file})`, output, root, 8);
    assert.match(limited.text, /snapshot truncated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot expansion refuses outside/missing files and leaves inline snapshots intact", () => {
  const root = mkdtempSync(join(tmpdir(), "alfred-browser-unit-"));
  try {
    const output = join(root, "output"); mkdirSync(output);
    const outside = join(root, "private.yml"); writeFileSync(outside, "private contents");
    for (const path of [outside, "missing.yml", "https://example.invalid/private.yml"]) {
      const text = `### Snapshot\n[Snapshot](${path})`;
      assert.deepEqual(inlineBrowserSnapshot(text, output, root), { text, expanded: false });
    }
    const inline = '### Snapshot\n```yaml\n- button "Ready" [ref=e1]\n```';
    assert.deepEqual(inlineBrowserSnapshot(inline, output, root), { text: inline, expanded: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
