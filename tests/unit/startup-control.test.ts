import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../../src/config.js";
import type { StartupState } from "../../src/settings.js";

function startupFixture(options: { task?: "enabled" | "disabled"; shortcuts?: boolean; remove?: boolean; removalFails?: boolean }): { before: StartupState; after: StartupState; desktopExists: boolean; removalFailed: boolean } {
  const tempRoot = resolve(tmpdir());
  const root = mkdtempSync(join(tempRoot, "alfred startup "));
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  try {
    const folders = [join(root, "user startup"), join(root, "common startup")];
    for (const folder of folders) {
      mkdirSync(folder);
      if (options.shortcuts) writeFileSync(join(folder, "Alfred.lnk"), "fixture");
    }
    const desktop = join(root, "Desktop Alfred.lnk");
    writeFileSync(desktop, "fixture");
    const script = join(root, "probe.ps1");
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
. ${quote(join(projectRoot(), "scripts", "startup-control.ps1"))}
function Get-AlfredStartupFolders { @(${folders.map(quote).join(", ")}) }
function Get-ScheduledTask {
  param($TaskName, $ErrorAction)
  ${options.task ? `return @{ State = '${options.task === "enabled" ? "Ready" : "Disabled"}'; Settings = @{ Enabled = $${options.task === "enabled" ? "true" : "false"} } }` : "return $null"}
}
${options.removalFails ? "function Remove-Item { param($LiteralPath, [switch]$Force, $ErrorAction); throw 'fixture access denied' }" : ""}
$before = Get-AlfredStartupState
$removalFailed = $false
${options.remove ? "try { Remove-AlfredStartupShortcuts } catch { $removalFailed = $true }" : ""}
@{ before = $before; after = Get-AlfredStartupState; desktopExists = Test-Path -LiteralPath ${quote(desktop)}; removalFailed = $removalFailed } | ConvertTo-Json -Depth 6 -Compress
`, "utf8");
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim());
  } finally {
    assert.equal(dirname(root), tempRoot);
    rmSync(root, { recursive: true, force: true });
  }
}

const windowsOnly = { skip: process.platform !== "win32" };

test("a legacy Startup folder launch is visible even without a scheduled task", windowsOnly, () => {
  const { before } = startupFixture({ shortcuts: true });
  assert.equal(before.registered, true);
  assert.equal(before.enabled, true);
  assert.equal(before.state, "Startup folder");
  assert.deepEqual(before.sources.map((source) => source.kind), ["startup-folder", "startup-folder"]);
});

test("a disabled task cannot hide an enabled legacy login shortcut", windowsOnly, () => {
  const { before } = startupFixture({ shortcuts: true, task: "disabled" });
  assert.equal(before.enabled, true);
  assert.equal(before.sources[0]?.enabled, false);
  assert.equal(before.sources.length, 3);
});

test("removing startup deletes both login shortcuts and preserves the desktop shortcut", windowsOnly, () => {
  const result = startupFixture({ shortcuts: true, remove: true });
  assert.equal(result.before.enabled, true);
  assert.equal(result.after.registered, false);
  assert.equal(result.after.enabled, false);
  assert.equal(result.desktopExists, true);
  assert.equal(result.removalFailed, false);
});

test("startup reflects task enablement when there are no legacy shortcuts", windowsOnly, () => {
  const enabled = startupFixture({ task: "enabled" }).before;
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.sources.length, 1);
  const disabled = startupFixture({ task: "disabled" }).before;
  assert.equal(disabled.registered, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.state, "Disabled");
});

test("failed shortcut removal is reported and leaves startup visibly enabled", windowsOnly, () => {
  const result = startupFixture({ shortcuts: true, remove: true, removalFails: true });
  assert.equal(result.removalFailed, true);
  assert.equal(result.after.enabled, true);
});
