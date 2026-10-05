import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HistoricalImageProjection, measureContext } from "../../src/pi/context-projection.js";

type Messages = ConstructorParameters<typeof HistoricalImageProjection>[0];
const image = { type: "image" as const, data: "YWJjZA==", mimeType: "image/png" };
function transcript(): Messages {
  return [
    { role: "user", content: [{ type: "text", text: "Remember this preference and compare these images." }, image], timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "reasoning to preserve", thinkingSignature: "required-signature" }, { type: "toolCall", id: "call-1", name: "desktop_observe", arguments: {} }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-1", toolName: "desktop_observe", content: [{ type: "text", text: "artifactId: A-original; document.txt saved; observationId: O-1" }, image], details: { artifactId: "A-original" }, isError: false, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "The file was saved. Your preference is remembered." }], timestamp: 4 },
  ] as Messages;
}

test("previous tool images leave the projection without changing canonical history or tool/reasoning pairs", () => {
  const original = transcript();
  const serialized = JSON.stringify(original);
  const projection = new HistoricalImageProjection(original);
  const projected = projection.apply(original);
  assert.equal(projection.removedImages, 1);
  assert.equal(projection.removedBase64Bytes, image.data.length);
  assert.equal(projected.length, original.length);
  assert.equal(projected[0], original[0], "owner image must stay available for a follow-up");
  assert.equal(projected[1], original[1], "thinking signature and tool call are untouched");
  assert.equal(projected[3], original[3], "past answer/preferences remain available");
  const result = projected[2]!;
  assert.equal(result.role, "toolResult");
  if (result.role !== "toolResult") throw new Error("wrong message");
  assert.equal(result.toolCallId, "call-1");
  assert.deepEqual(result.details, { artifactId: "A-original" });
  assert.ok(result.content.every((block) => block.type !== "image"));
  assert.match(JSON.stringify(result.content), /artifactId: A-original/);
  assert.equal(JSON.stringify(original), serialized, "raw archive stays byte-for-byte identical");
  assert.equal(projection.apply(original)[2], result, "stable projected prefix between turns");
});

test("current tool images and explicit retrievals survive, including copied historical messages", () => {
  const original = transcript();
  const projection = new HistoricalImageProjection(original);
  const active = { ...original[2]!, timestamp: 5 } as Messages[number];
  const messages = structuredClone(original).concat(active);
  const result = projection.apply(messages);
  assert.equal(result.at(-1), active);
  assert.equal(measureContext(result).imageCount, 2, "owner and current-task images remain");
  assert.equal(measureContext(result).imageBase64Bytes, 2 * image.data.length);
  assert.equal(measureContext(result).contextBytes, Buffer.byteLength(JSON.stringify(result)));
});

test("disabling the projection preserves every image", () => {
  const original = transcript();
  const projection = new HistoricalImageProjection(original, false);
  assert.equal(projection.apply(original), original);
  assert.equal(projection.removedImages, 0);
});
