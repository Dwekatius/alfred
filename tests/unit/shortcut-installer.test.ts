import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../../src/config.js";

test("all shortcut installers keep one Alfred launcher and preserve login startup", { skip: process.platform !== "win32", timeout: 30000 }, () => {
  const tempRoot = resolve(tmpdir());
  const root = mkdtempSync(join(tempRoot, "alfred shortcut migration "));
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  try {
    const desktop = join(root, "Desktop");
    const startup = join(root, "Startup");
    const scripts = join(root, "scripts");
    for (const dir of [desktop, startup, scripts]) mkdirSync(dir);
    const installers = ["install-shortcut.ps1", "install-tray.ps1", "install-dashboard.ps1"];
    for (const installer of installers) {
      // Redirect the actual scripts' Windows special folders into this fixture.
      // The old installers also stay inside the fixture when testing regression.
      const source = readFileSync(join(projectRoot(), "scripts", installer), "utf8")
        .replaceAll("[Environment]::GetFolderPath('Desktop')", quote(desktop))
        .replaceAll("[Environment]::GetFolderPath('Startup')", quote(startup));
      writeFileSync(join(scripts, installer), source, "utf8");
    }
    writeFileSync(join(desktop, "Unrelated.lnk"), "unrelated shortcut");
    const inspect = join(root, "inspect.ps1");
    writeFileSync(inspect, `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(join(desktop, "Alfred.lnk"))})\n@{ arguments = $link.Arguments; directory = $link.WorkingDirectory; description = $link.Description } | ConvertTo-Json -Compress\n`, "utf8");
    for (const installer of installers) {
      for (const name of ["Alfred Dashboard.lnk", "Alfred UI.lnk"]) writeFileSync(join(desktop, name), "obsolete shortcut");
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(scripts, installer)], { windowsHide: true, timeout: 10000 });
      assert.deepEqual(readdirSync(desktop).sort(), ["Alfred.lnk", "Unrelated.lnk"]);
      assert.equal(readFileSync(join(desktop, "Unrelated.lnk"), "utf8"), "unrelated shortcut");
      const metadata = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", inspect], { encoding: "utf8", windowsHide: true, timeout: 10000 })) as { arguments: string; directory: string; description: string };
      assert.ok(metadata.arguments.includes(`-File "${join(scripts, "tray.ps1")}"`));
      assert.equal(metadata.directory, root);
      assert.equal(metadata.description, "Start Alfred and open its dashboard");
      if (installer === installers[0]) {
        assert.deepEqual(readdirSync(startup), []);
        writeFileSync(join(startup, "Alfred.lnk"), "existing login preference");
      } else {
        assert.equal(readFileSync(join(startup, "Alfred.lnk"), "utf8"), "existing login preference");
      }
    }
  } finally {
    assert.equal(dirname(root), tempRoot);
    rmSync(root, { recursive: true, force: true });
  }
});
