import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../../src/config.js";

function runLauncherFixture(options: { task: boolean; taskFails?: boolean; alreadyRunning?: boolean; launchFails?: boolean; neverReady?: boolean }) {
  const tempRoot = resolve(tmpdir());
  const dir = mkdtempSync(join(tempRoot, "alfred launcher "));
  const library = join(projectRoot(), "scripts", "controller-control.ps1").replace(/'/g, "''");
  const fixture = join(dir, "probe.ps1");
  try {
    writeFileSync(fixture, `
$ErrorActionPreference = 'Stop'
$ProjectRoot = 'C:\\fixture root\\alfred'
$ConfigPath = 'C:\\fixture data\\config.json'
. '${library}'
$script:taskStarts = 0
$script:processStarts = 0
$script:statusCalls = 0
$script:launch = $null
function Get-AgentStatus {
  $script:statusCalls += 1
  if (${options.alreadyRunning ? "$true" : "$false"} -or (-not ${options.neverReady ? "$true" : "$false"} -and ($script:taskStarts -gt 0 -or $script:processStarts -gt 0))) { return @{ pid = 1 } }
  return $null
}
function Get-ScheduledTask { param($TaskName, $ErrorAction); ${options.task ? "return @{ TaskName = $TaskName }" : "return $null"} }
function Start-ScheduledTask {
  param($TaskName, $ErrorAction)
  ${options.taskFails ? "throw 'fixture task failure'" : "$script:taskStarts += 1"}
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $ErrorAction)
  ${options.launchFails ? "throw 'fixture launch failure'" : "$script:processStarts += 1"}
  $script:launch = @{ file = $FilePath; arguments = $ArgumentList; directory = $WorkingDirectory; windowStyle = $WindowStyle }
}
function Start-Sleep { param($Milliseconds, $Seconds) }
$result = Start-Agent
@{ ok = $result; taskStarts = $script:taskStarts; processStarts = $script:processStarts; statusCalls = $script:statusCalls; launch = $script:launch } | ConvertTo-Json -Depth 4 -Compress
`, "utf8");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as {
      ok: boolean; taskStarts: number; processStarts: number; statusCalls: number;
      launch: { file: string; arguments: string; directory: string; windowStyle: string } | null;
    };
  } finally {
    assert.equal(dirname(dir), tempRoot);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("manual launch without a startup task uses a hidden controller and quotes paths with spaces", { skip: process.platform !== "win32" }, () => {
  const result = runLauncherFixture({ task: false });
  assert.equal(result.ok, true); assert.equal(result.taskStarts, 0); assert.equal(result.processStarts, 1);
  assert.equal(result.launch?.windowStyle, "Hidden");
  assert.equal(result.launch?.directory, "C:\\fixture root\\alfred");
  assert.ok(result.launch?.arguments.includes('-File "C:\\fixture root\\alfred\\scripts\\run-controller.ps1"'));
  assert.ok(result.launch?.arguments.includes('-ConfigPath "C:\\fixture data\\config.json"'));
});

test("installed startup task is used without launching another controller", { skip: process.platform !== "win32" }, () => {
  const result = runLauncherFixture({ task: true });
  assert.equal(result.ok, true); assert.equal(result.taskStarts, 1); assert.equal(result.processStarts, 0);
});

test("a rejected scheduled-task start falls back to a direct launch", { skip: process.platform !== "win32" }, () => {
  const result = runLauncherFixture({ task: true, taskFails: true });
  assert.equal(result.ok, true); assert.equal(result.taskStarts, 0); assert.equal(result.processStarts, 1);
});

test("repeated starts leave an existing controller alone", { skip: process.platform !== "win32" }, () => {
  const result = runLauncherFixture({ task: false, alreadyRunning: true });
  assert.equal(result.ok, true); assert.equal(result.taskStarts, 0); assert.equal(result.processStarts, 0);
});

test("launcher failure and readiness timeout report failure without repeated launches", { skip: process.platform !== "win32" }, () => {
  const failed = runLauncherFixture({ task: false, launchFails: true });
  assert.equal(failed.ok, false); assert.equal(failed.processStarts, 0);
  const timeout = runLauncherFixture({ task: false, neverReady: true });
  assert.equal(timeout.ok, false); assert.equal(timeout.processStarts, 1); assert.equal(timeout.statusCalls, 31);
});
