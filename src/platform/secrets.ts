/**
 * Secret storage using Windows DPAPI (CurrentUser) through the local Python
 * helper. Plaintext never appears on a command line: bytes go over stdin.
 *
 * Directory and files are restricted to the current user with icacls on a
 * best-effort basis; DPAPI remains the actual protection.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

function projectRootFromHere(): string {
  // dist/src/platform/secrets.js -> project root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function resolvePython(): string[] {
  if (process.env.PI_TG_PYTHON) return [process.env.PI_TG_PYTHON];
  const venv = join(projectRootFromHere(), ".venv", "Scripts", "python.exe");
  if (existsSync(venv)) return [venv];
  return ["python"];
}

export function dpapiScriptPath(): string {
  return join(projectRootFromHere(), "python", "dpapi_tool.py");
}

export async function runDpapi(mode: "protect" | "unprotect", input: Buffer, timeoutMs = 20000): Promise<Buffer> {
  const python = resolvePython();
  const exe = python[0] as string;
  const args = [...python.slice(1), dpapiScriptPath(), mode];
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new SecretStoreError(`DPAPI helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SecretStoreError(`DPAPI helper failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new SecretStoreError(`DPAPI helper exited with code ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 300)}`));
        return;
      }
      resolvePromise(Buffer.concat(out));
    });
    child.stdin.on("error", () => {
      /* EPIPE surfaces through close */
    });
    child.stdin.end(input);
  });
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): void;
  healthCheck(): Promise<boolean>;
}

export class DpapiSecretStore implements SecretStore {
  constructor(readonly secretsDir: string) {}

  private fileFor(name: string): string {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "__");
    return join(this.secretsDir, `${safe}.dpapi`);
  }

  async get(name: string): Promise<string | undefined> {
    const file = this.fileFor(name);
    if (!existsSync(file)) return undefined;
    const blob = readFileSync(file);
    const plain = await runDpapi("unprotect", blob);
    return plain.toString("utf8");
  }

  async set(name: string, value: string): Promise<void> {
    mkdirSync(this.secretsDir, { recursive: true });
    const blob = await runDpapi("protect", Buffer.from(value, "utf8"));
    const file = this.fileFor(name);
    writeFileSync(file, blob, { mode: 0o600 });
    restrictPathToOwner(this.secretsDir);
    restrictPathToOwner(file);
  }

  delete(name: string): void {
    rmSync(this.fileFor(name), { force: true });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const probe = `pi-tg-probe-${Date.now()}`;
      const blob = await runDpapi("protect", Buffer.from(probe, "utf8"));
      const back = await runDpapi("unprotect", blob);
      return back.toString("utf8") === probe;
    } catch {
      return false;
    }
  }
}

/** Env-var backed store for initial development. Never logged. */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly map: Record<string, string | undefined>) {}
  async get(name: string): Promise<string | undefined> {
    const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return this.map[key];
  }
  async set(): Promise<void> {
    throw new SecretStoreError("Cannot persist secrets while using the environment-variable store");
  }
  delete(): void {
    /* no-op */
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Prefer an explicit environment variable for development, then DPAPI.
 */
export function createSecretStore(secretsDir: string): SecretStore {
  if (process.env.PI_TG_BOT_TOKEN) {
    return new EnvSecretStore({ PI_TELEGRAM_AGENT_BOT_TOKEN: process.env.PI_TG_BOT_TOKEN });
  }
  return new DpapiSecretStore(secretsDir);
}

export function restrictPathToOwner(path: string): void {
  if (process.platform !== "win32") return;
  try {
    const user = userInfo().username;
    const isDirectory = existsSync(path) && statSync(path).isDirectory();
    // Inheritable entries for directories: without (OI)(CI), children created
    // later would receive an empty DACL and become unreadable even to the owner.
    const grant = isDirectory ? `${user}:(OI)(CI)F` : `${user}:F`;
    const result = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grant], { windowsHide: true, stdio: "ignore" });
    if (result.error) {
      /* best effort */
    }
  } catch {
    /* best effort */
  }
}
