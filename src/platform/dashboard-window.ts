import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { projectRoot } from "../config.js";
import type { Logger } from "../logging.js";

/** The dashboard is a separate companion; closing it never stops the controller. */
export function openDashboardWindow(configPath: string, logger: Logger, script = join(projectRoot(), "scripts", "dashboard-window.ps1")): ChildProcess | undefined {
  if (process.platform !== "win32") return;
  logger.info("dashboard.open_requested", "Opening the dashboard companion.", { eventCode: "DASHBOARD_OPEN_REQUEST" });
  // DETACHED_PROCESS makes Windows PowerShell silently skip its script on this
  // host. A hidden, unreferenced child runs it and keeps UI startup independent.
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ConfigPath", configPath], {
    windowsHide: true, stdio: "ignore",
  });
  child.once("error", () => logger.warn("dashboard.launch_failed", "Could not open the dashboard window. Use the dashboard shortcut or tray menu.", { eventCode: "DASHBOARD_LAUNCH_FAILED" }));
  child.once("exit", (code) => {
    if (code !== 0) logger.warn("dashboard.launch_failed", "Dashboard launcher failed. Use the dashboard shortcut or tray menu.", { eventCode: "DASHBOARD_LAUNCH_FAILED", exitCode: code });
  });
  child.unref();
  return child;
}
