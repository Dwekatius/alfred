import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { installBrowserTools } from "../../src/tools/browser-tools.js";
import type { BrokerContext, ToolBroker, ToolHandler } from "../../src/tools/broker.js";
import type { WindowsBackend } from "../../src/tools/windows-mcp.js";
import type { BrowserBackend } from "../../src/tools/browser-mcp.js";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { DesktopLease } from "../../src/tools/desktop-lease.js";
import { Logger } from "../../src/logging.js";
import { dataPaths } from "../../src/config.js";
import { testConfig } from "../fixtures/config.js";
import { toolSpecByName } from "../../src/pi/tool-definitions.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=", "base64");

for (const [producesImage, filename] of [[true, "named.png"], [true, "named"], [false, "named.png"]] as const) {
  test(`screenshot ${filename} ${producesImage ? "registers its image and returns vision content" : "rejects text output when the image is missing"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "alfred-shot-test-"));
    const db = Database.open(":memory:");
    try {
      runMigrations(db);
      const config = testConfig({ dataRoot: root, browser: { ...testConfig().browser, outputDir: join(root, "output") } });
      mkdirSync(config.browser.outputDir);
      const logger = new Logger({}, { toStderr: false });
      const artifacts = new ArtifactRegistry(db, join(root, "artifacts"), logger);
      const handlers = new Map<string, ToolHandler>();
      const browser = { call: async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "browser_take_screenshot");
        assert.equal(args.filename, join(config.browser.outputDir, "named.png"));
        if (producesImage) writeFileSync(args.filename as string, png);
        // Automatic YAML snapshots may be newer than the requested screenshot.
        writeFileSync(join(config.browser.outputDir, "page-newest.yml"), "not an image");
        return { content: [{ type: "text", text: "Screenshot saved" }] };
      } } as unknown as BrowserBackend;
      installBrowserTools({ registerHandler: (name: string, handler: ToolHandler) => handlers.set(name, handler) } as unknown as ToolBroker, {
        browser, windows: { helper: { foregroundWindow: async () => ({ title: "Test - Chrome" }) } } as unknown as WindowsBackend,
        config, paths: dataPaths(config), artifacts, lease: new DesktopLease(), logger,
      });
      const context = { jobId: "benchmark", signal: new AbortController().signal, assertLease: () => undefined } as unknown as BrokerContext;
      const execute = () => handlers.get("browser_take_screenshot")!({ filename }, context, toolSpecByName("browser_take_screenshot")!);
      if (!producesImage) {
        await assert.rejects(execute, { code: "ARTIFACT_NOT_FOUND" });
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as { count: number }).count, 0);
        return;
      }
      const result = await execute();
      const artifact = artifacts.get(result.details?.artifactId as string)!;
      assert.equal(artifact.mime, "image/png");
      assert.deepEqual(readFileSync(artifacts.absolutePath(artifact)), png);
      const image = result.content.find(block => block.type === "image");
      assert.ok(image && image.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert.deepEqual(Buffer.from(image.data, "base64"), png);
    } finally {
      db.close();
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("alfred-shot-test-"));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
