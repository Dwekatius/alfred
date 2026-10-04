import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSnapshotText } from "../../src/tools/windows-adapter.js";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures", "snapshot-sample.txt"), "utf8");

test("real snapshot text parses geometry, windows, and elements", () => {
  const parsed = parseSnapshotText(fixture);
  assert.deepEqual(parsed.cursor, { x: 1144, y: 1079 });
  assert.equal(parsed.displays.length, 1);
  assert.equal((parsed.displays[0]!.right - parsed.displays[0]!.left), 1920);
  assert.equal(parsed.displays[0]?.primary, true);
  assert.equal(parsed.selectedDisplays.length, 0);
  assert.equal(parsed.focusedWindow?.name, "sample.txt - Notepad");
  assert.equal(parsed.focusedWindow?.width, 1440);
  assert.ok(parsed.windows.some((window) => window.name === "SampleApp"));
  assert.ok(parsed.elements.length > 20);
  const editor = parsed.elements.find((element) => element.name === "Text editor");
  assert.ok(editor);
  assert.equal(editor?.focused, true);
  assert.equal(editor?.x, 890);
  assert.equal(editor?.y, 614);
  const closeButton = parsed.elements.find((element) => element.name === "Close Tab");
  assert.ok(closeButton);
  // Window ids are opaque handles.
  assert.match(parsed.focusedWindow?.windowId ?? "", /^W:/);
});

test("truncated or empty snapshot text parses without throwing", () => {
  const parsed = parseSnapshotText("Error capturing desktop state: boom");
  assert.equal(parsed.displays.length, 0);
  assert.equal(parsed.windows.length, 0);
  assert.equal(parsed.elements.length, 0);
  assert.equal(parsed.cursor, undefined);
});
