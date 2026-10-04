/**
 * Local operator CLI over the authenticated named pipe:
 *   npm run status | npm run stop | pause | resume | shutdown | logs
 */
import { dataPaths, defaultConfigPath, loadConfig } from "./config.js";
import { localIpcRequest, readLocalIpcInfo } from "./platform/local-ipc.js";
import { readLockInfo } from "./platform/lockfile.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let configPath = defaultConfigPath();
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configPath = argv[index + 1] as string;
      index += 1;
    } else {
      args.push(argv[index] as string);
    }
  }
  const command = args[0] ?? "status";
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error(`Configuration error: ${(error as Error).message}`);
    return 2;
  }
  const paths = dataPaths(config);
  const info = readLocalIpcInfo(paths.stateDir);
  if (!info) {
    const lock = readLockInfo(paths.lockPath);
    console.error(lock ? `Controller (pid ${lock.pid}) is running but has not published a local control endpoint yet.` : "Controller is not running.");
    return 3;
  }
  const commandMap: Record<string, string> = { status: "status", stop: "stop", pause: "pause", resume: "resume", shutdown: "shutdown" };
  const mapped = commandMap[command];
  if (!mapped) {
    console.error("Usage: local-cli.js status|stop|pause|resume|shutdown");
    return 2;
  }
  try {
    const response = await localIpcRequest(info, mapped);
    if (!response.ok) {
      console.error(`Command failed: ${response.error}`);
      return 4;
    }
    console.log(JSON.stringify(response.result, null, 2));
    return 0;
  } catch (error) {
    console.error(`Local IPC failed: ${(error as Error).message}`);
    return 5;
  }
}

main().then((code) => {
  process.exitCode = code;
});
