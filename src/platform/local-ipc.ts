/**
 * Authenticated local IPC over a Windows named pipe. Never listens on the
 * network. A random token is written to the private state directory with
 * owner-only permissions.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";

export interface LocalIpcInfo {
  pipeName: string;
  token: string;
  pid: number;
  startedAt: string;
}

export function defaultPipeName(dataRoot: string): string {
  const digest = createHash("sha256").update(dataRoot.toLowerCase()).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\alfred-${digest}`;
}

export function localIpcInfoPath(stateDir: string): string {
  return join(stateDir, "local-ipc.json");
}

export function writeLocalIpcInfo(stateDir: string, info: LocalIpcInfo): void {
  writeFileSync(localIpcInfoPath(stateDir), JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function readLocalIpcInfo(stateDir: string): LocalIpcInfo | undefined {
  const path = localIpcInfoPath(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LocalIpcInfo;
    if (!parsed.pipeName || !parsed.token) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface LocalIpcRequest {
  token: string;
  command: string;
  args?: Record<string, unknown>;
}

export interface LocalIpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type LocalIpcHandler = (request: LocalIpcRequest) => Promise<LocalIpcResponse> | LocalIpcResponse;

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Start the local pipe server. Returns a close function. */
export async function startLocalIpcServer(pipeName: string, token: string, handler: LocalIpcHandler): Promise<{ close: () => Promise<void> }> {
  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void (async () => {
        let response: LocalIpcResponse;
        try {
          const request = JSON.parse(line) as LocalIpcRequest;
          if (!request || typeof request.token !== "string" || !tokensMatch(request.token, token)) {
            response = { ok: false, error: "unauthorized" };
          } else {
            response = await handler(request);
          }
        } catch (error) {
          response = { ok: false, error: (error as Error).message };
        }
        socket.end(JSON.stringify(response) + "\n");
      })();
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, () => resolve());
  });
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function localIpcRequest(info: LocalIpcInfo, command: string, args?: Record<string, unknown>, timeoutMs = 10000): Promise<LocalIpcResponse> {
  return await new Promise<LocalIpcResponse>((resolve, reject) => {
    const socket = connect(info.pipeName);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Local IPC request timed out"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ token: info.token, command, args } satisfies LocalIpcRequest) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        resolve(JSON.parse(line) as LocalIpcResponse);
      } catch (error) {
        reject(new Error(`Invalid local IPC response: ${(error as Error).message}`));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function generateIpcToken(): string {
  return randomBytes(32).toString("base64url");
}
