/**
 * Controller entry point.
 *
 * Loads validated configuration, acquires the single-instance lock, opens and
 * migrates SQLite, wires the broker/worker/IPC, and starts the supervisor.
 */
import { randomUUID } from "node:crypto";
import { AppConfig, dataPaths, defaultConfigPath, ensureDataDirs, loadConfig } from "./config.js";
import { Logger, levelFromEnv } from "./logging.js";
import { acquireControllerLock, LockError, releaseControllerLock } from "./platform/lockfile.js";
import { createSecretStore, restrictPathToOwner, type SecretStore } from "./platform/secrets.js";
import { defaultPipeName, generateIpcToken, startLocalIpcServer, writeLocalIpcInfo } from "./platform/local-ipc.js";
import { Database } from "./storage/database.js";
import { runMigrations } from "./storage/migrations.js";
import { JobRepository } from "./jobs/repository.js";
import { Supervisor } from "./supervisor.js";
import { ApprovalRepository } from "./jobs/approvals.js";
import { QuestionRepository } from "./jobs/questions.js";
import { ArtifactRegistry } from "./artifacts/registry.js";
import { DesktopLease } from "./tools/desktop-lease.js";
import { ToolBroker } from "./tools/broker.js";
import { registerFakeTools } from "./tools/fake-tools.js";
import { registerTelegramTools } from "./tools/telegram-tools.js";
import { WorkerExecutor } from "./pi/worker-executor.js";
import { installDesktopTools } from "./tools/windows-adapter.js";
import { installBrowserTools } from "./tools/browser-tools.js";
import { CreateWindowsBackend } from "./tools/windows-mcp.js";
import { CreateBrowserBackend } from "./tools/browser-mcp.js";
import { installFileTools } from "./tools/files.js";
import { installPowerShellTools } from "./tools/powershell.js";
import { ScreenshotService } from "./artifacts/screenshot.js";
import { ProcessManager } from "./platform/process-manager.js";
import { SessionMonitor } from "./platform/session-monitor.js";

export interface CliOptions {
  configPath: string;
  dryRun: boolean;
  noTelegram: boolean;
  once: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { configPath: defaultConfigPath(), dryRun: false, noTelegram: false, once: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" && argv[index + 1]) {
      options.configPath = argv[index + 1] as string;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-telegram") {
      options.noTelegram = true;
    } else if (arg === "--once") {
      options.once = true;
    }
  }
  if (process.env.PI_TG_DRY_RUN === "1") options.dryRun = true;
  return options;
}

export async function runController(options: CliOptions): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig(options.configPath);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Configuration error: ${(error as Error).message}`);
    const details = (error as { issues?: string[] }).issues;
    if (details && details.length > 0) console.error(details.map((issue) => `  - ${issue}`).join("\n"));
    return 2;
  }
  if (options.dryRun) config = { ...config, dryRun: true };

  const paths = dataPaths(config);
  ensureDataDirs(paths);
  restrictPathToOwner(paths.secretsDir);
  restrictPathToOwner(paths.stateDir);

  const runId = `run-${randomUUID().slice(0, 8)}`;
  const logger = new Logger({ component: "controller", controllerRunId: runId }, { level: levelFromEnv(), logDir: paths.logsDir, toStderr: true });

  let lock;
  try {
    lock = acquireControllerLock(paths.lockPath, runId);
  } catch (error) {
    if (error instanceof LockError) {
      logger.error("controller.lock_held", "Another controller instance is already running.", { eventCode: "LOCK_HELD" });
      // eslint-disable-next-line no-console
      console.error(`Another controller is already running. ${error.message}`);
      return 3;
    }
    throw error;
  }

  logger.info("controller.starting", "Controller starting.", { eventCode: "CONTROLLER_START", dryRun: config.dryRun });

  const db = Database.open(paths.databasePath);
  const migrationVersion = runMigrations(db);
  logger.info("storage.migrated", "SQLite schema is up to date.", { eventCode: "MIGRATED", version: migrationVersion });
  const repo = new JobRepository(db);
  const approvals = new ApprovalRepository(db);
  const questions = new QuestionRepository(db);
  const artifacts = new ArtifactRegistry(db, paths.artifactsDir, logger);
  const secrets: SecretStore = createSecretStore(paths.secretsDir);

  const supervisor = new Supervisor({ config, configPath: options.configPath, paths, db, repo, secrets, logger, runId });
  const lease = new DesktopLease();
  const broker = new ToolBroker({
    db,
    repo,
    approvals,
    questions,
    artifacts,
    getOutbox: () => supervisor.outboxForBroker(),
    config,
    logger,
    lease,
    onJobWaiting: () => undefined,
  });

  let workerExecutor: WorkerExecutor | undefined;
  let sessionMonitor: SessionMonitor | undefined;
  let probeTimer: NodeJS.Timeout | undefined;
  let windowsBackend: ReturnType<typeof CreateWindowsBackend> | undefined;
  let browserBackend: ReturnType<typeof CreateBrowserBackend> | undefined;
  const processManager = new ProcessManager();
  if (!config.dryRun) {
    const windows = CreateWindowsBackend({ config, paths, logger });
    const browser = CreateBrowserBackend({ config, paths, logger });
    windowsBackend = windows;
    browserBackend = browser;
    installDesktopTools(broker, { windows, lease, logger, config });
    installBrowserTools(broker, { browser, windows, lease, logger, config, paths, artifacts });
    installFileTools(broker, { config, paths, logger });
    installPowerShellTools(broker, { config, paths, logger }, processManager);

    const screenshotService = new ScreenshotService({ config, artifacts, windows, lease, logger });
    supervisor.setScreenshotProvider(screenshotService);
    supervisor.setDesktopProbe(() => screenshotService.availability());
    workerExecutor = new WorkerExecutor({
      config,
      paths,
      logger,
      repo,
      broker,
      lease,
      artifacts,
      loadImages: (job) => supervisor.loadJobImages(job),
      resolveApiKeys: () => supervisor.resolveApiKeys(),
      onProgress: (jobId, summary) => supervisor.notifyProgress(jobId, summary),
      onStream: (jobId, kind, text) => supervisor.recordStream(jobId, kind, text),
      onModelUsage: (jobId, usage) => supervisor.recordModelUsage(jobId, usage),
    });
    supervisor.setExecutor(workerExecutor);

    sessionMonitor = new SessionMonitor({
      config,
      paths,
      logger,
      processManager,
      onHumanActivity: (kind) => supervisor.handleHumanTakeover(kind),
      onEmergencyStop: (source) => supervisor.handleEmergencyStop(source),
    });
    await sessionMonitor.start();
    void screenshotService.probe();
    probeTimer = setInterval(() => void screenshotService.probe(), 5000);
    probeTimer.unref?.();
  } else {
    registerFakeTools(broker);
    logger.info("controller.dry_run", "Dry-run mode: no desktop/browser helpers, no OS side effects.", { eventCode: "DRY_RUN" });
  }
  registerTelegramTools(broker);
  if (config.dryRun || process.env.PI_TG_ENABLE_FAKE_TOOLS === "1") registerFakeTools(broker);

  // Local IPC for `npm run status` / `npm run stop` etc.
  const ipcToken = generateIpcToken();
  const pipeName = defaultPipeName(config.dataRoot);
  writeLocalIpcInfo(paths.stateDir, { pipeName, token: ipcToken, pid: process.pid, startedAt: new Date().toISOString() });
  restrictPathToOwner(paths.stateDir);
  const ipc = await startLocalIpcServer(pipeName, ipcToken, async (request) => {
    switch (request.command) {
      case "status":
        return { ok: true, result: supervisor.localStatus() };
      case "pause": {
        const active = repo.getActiveJob();
        if (!active) return { ok: false, error: "No active job." };
        const controlId = repo.insertControl({ jobId: active.id, command: JSON.stringify({ type: "pause" }) });
        await supervisor.applyControlById(controlId);
        return { ok: true, result: { paused: active.id } };
      }
      case "resume": {
        const controlId = repo.insertControl({ command: JSON.stringify({ type: "resume" }) });
        await supervisor.applyControlById(controlId);
        return { ok: true, result: { resumed: true } };
      }
      case "stop": {
        const controlId = repo.insertControl({ command: JSON.stringify({ type: "stop" }) });
        await supervisor.applyControlById(controlId);
        return { ok: true, result: { stopping: true } };
      }
      case "shutdown": {
        setTimeout(() => void shutdown("local shutdown"), 50);
        return { ok: true, result: { stopping: true } };
      }
      default:
        return { ok: false, error: `Unknown local command: ${request.command}` };
    }
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("controller.shutdown", "Shutting down.", { reason, eventCode: "SHUTDOWN" });
    try {
      await supervisor.stop(reason);
    } finally {
      if (probeTimer) clearInterval(probeTimer);
      await sessionMonitor?.stop().catch(() => undefined);
      await processManager.disposeAll().catch(() => undefined);
      // MCP children keep the event loop alive; dispose them so the task
      // instance really ends and Task Scheduler can restart it cleanly.
      await windowsBackend?.dispose().catch(() => undefined);
      await browserBackend?.dispose().catch(() => undefined);
      await ipc.close().catch(() => undefined);
      db.close();
      releaseControllerLock(paths.lockPath, runId);
      logger.info("controller.exit", "Controller process exiting.", { reason, eventCode: "CONTROLLER_EXIT" });
      setTimeout(() => process.exit(0), 100).unref?.();
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await supervisor.start();
  } catch (error) {
    logger.error("controller.start_failed", "Controller failed to start.", { message: (error as Error).message, eventCode: "START_FAILED" });
    // eslint-disable-next-line no-console
    console.error(`Start failed: ${(error as Error).message}`);
    await shutdown("start failure");
    return 4;
  }

  if (options.once) {
    await shutdown("once flag");
    return 0;
  }

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (supervisor.isStopped()) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
    timer.unref?.();
    process.on("exit", () => clearInterval(timer));
  });
  return 0;
}

const isMain = true;
if (isMain) {
  void runController(parseArgs(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}
