import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { Logger } from "../../src/logging.js";
import { openDashboardWindow } from "../../src/platform/dashboard-window.js";

test("the hidden dashboard launcher executes its PowerShell script with paths containing spaces", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const tempRoot = resolve(tmpdir());
  const root = mkdtempSync(join(tempRoot, "alfred dashboard launcher "));
  try {
    const script = join(root, "dashboard probe.ps1");
    const marker = join(root, "launch evidence.txt");
    writeFileSync(script, "param([string]$ConfigPath)\n[IO.File]::WriteAllText($ConfigPath, 'script executed')\n", "utf8");
    const logger = new Logger({ component: "dashboard-launch-test" }, { logDir: root });
    const child = openDashboardWindow(marker, logger, script);
    assert.ok(child);
    child.ref();
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 0);
    // Detached PowerShell can exit successfully without running the script.
    assert.equal(readFileSync(marker, "utf8"), "script executed");
  } finally {
    assert.equal(dirname(root), tempRoot);
    rmSync(root, { recursive: true, force: true });
  }
});
