/**
 * Generic MCP stdio backend with lazy start, tool discovery, timeouts,
 * cancellation, and restart-after-fault. The supervisor owns each backend's
 * lifetime; manifests are saved for version reports.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Logger, redactString } from "../logging.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError: boolean;
}

export interface McpBackendOptions {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger: Logger;
  manifestPath: string;
  defaultTimeoutMs?: number;
  /** Extra client name/version metadata. */
  version?: string;
}

export class McpStdioBackend {
  private transport: StdioClientTransport | undefined;
  private client: Client | undefined;
  private starting: Promise<void> | undefined;
  private tools = new Map<string, McpToolInfo>();
  private lastFault: Error | undefined;
  private disposing = false;

  constructor(private readonly options: McpBackendOptions) {}

  get name(): string {
    return this.options.name;
  }

  isStarted(): boolean {
    return this.client !== undefined;
  }

  getLastFault(): Error | undefined {
    return this.lastFault;
  }

  listTools(): McpToolInfo[] {
    return [...this.tools.values()];
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (this.starting) return await this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return await this.starting;
  }

  private async start(): Promise<void> {
    const logger = this.options.logger;
    logger.info("mcp.starting", "Starting MCP backend.", { eventCode: "MCP_STARTING", backend: this.options.name });
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      env: this.options.env,
      stderr: "pipe",
      maxBufferSize: 64 * 1024 * 1024,
    });
    const stderr = transport.stderr;
    if (stderr && "on" in stderr) {
      (stderr as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line.length > 0) logger.debug("mcp.stderr", "MCP backend wrote to stderr.", { eventCode: "MCP_STDERR", backend: this.options.name, message: redactString(line).slice(0, 1000) });
      });
    }
    const client = new Client({ name: `alfred/${this.options.name}`, version: this.options.version ?? "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (error) {
      this.lastFault = error as Error;
      throw error;
    }
    const listed = await client.listTools();
    this.tools.clear();
    for (const tool of listed.tools) {
      this.tools.set(tool.name, { name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    this.client = client;
    this.transport = transport;
    transport.onclose = () => {
      if (!this.disposing) {
        logger.warn("mcp.closed", "MCP backend connection closed.", { eventCode: "MCP_CLOSED", backend: this.options.name });
      }
      this.client = undefined;
      this.transport = undefined;
    };
    transport.onerror = (error: Error) => {
      this.lastFault = error;
      logger.error("mcp.error", "MCP backend transport error.", { eventCode: "MCP_ERROR", backend: this.options.name, message: redactString(error.message) });
    };
    this.writeManifest();
    logger.info("mcp.ready", "MCP backend ready.", { eventCode: "MCP_READY", backend: this.options.name, toolCount: this.tools.size });
  }

  private writeManifest(): void {
    try {
      mkdirSync(dirname(this.options.manifestPath), { recursive: true });
      writeFileSync(
        this.options.manifestPath,
        JSON.stringify(
          {
            backend: this.options.name,
            command: this.options.command,
            args: this.options.args,
            capturedAt: new Date().toISOString(),
            tools: [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (error) {
      this.options.logger.warn("mcp.manifest_failed", "Could not write MCP manifest.", { eventCode: "MCP_MANIFEST", backend: this.options.name, message: (error as Error).message });
    }
  }

  async callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    await this.ensureStarted();
    const client = this.client;
    if (!client) throw new Error(`MCP backend ${this.options.name} is not connected`);
    try {
      const result = (await client.callTool({ name, arguments: args }, undefined, {
        signal: options.signal,
        timeout: options.timeoutMs ?? this.options.defaultTimeoutMs ?? 60000,
      })) as { content?: McpContentBlock[]; structuredContent?: unknown; isError?: boolean };
      return { content: result.content ?? [], structuredContent: result.structuredContent, isError: Boolean(result.isError) };
    } catch (error) {
      this.lastFault = error as Error;
      throw error;
    }
  }

  async restart(): Promise<void> {
    await this.dispose();
    await this.ensureStarted();
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.client = undefined;
    this.transport = undefined;
    this.disposing = false;
  }
}
