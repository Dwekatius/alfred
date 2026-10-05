import { strict as assert } from "node:assert";
import { test } from "node:test";
import { closeBrowserBackend } from "../../src/tools/browser-mcp.js";
import { Logger } from "../../src/logging.js";

test("browser shutdown closes its context before terminating MCP; idle shutdown opens nothing", async () => {
  for (const started of [true, false]) {
    const calls: string[] = [];
    await closeBrowserBackend({ isStarted: () => started, callTool: async (name) => { calls.push(name); return { content: [], isError: false }; }, dispose: async () => { calls.push("dispose"); } }, new Logger({}, { toStderr: false }));
    assert.deepEqual(calls, started ? ["browser_close", "dispose"] : ["dispose"]);
  }
});

test("broken browser close still terminates the transport", async () => {
  let disposed = false;
  await closeBrowserBackend({ isStarted: () => true, callTool: async () => { throw new Error("backend unavailable"); }, dispose: async () => { disposed = true; } }, new Logger({}, { toStderr: false }));
  assert.equal(disposed, true);
});
