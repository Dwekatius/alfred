/**
 * Structured, redacting logger.
 *
 * Rules:
 * - Never log bot tokens, API keys, Authorization headers, or Telegram file URLs.
 * - Never log message bodies or model reasoning by default.
 * - stdout is reserved for protocol data in helper processes; diagnostics go to
 *   stderr and to JSONL files under <dataRoot>/logs.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  controllerRunId?: string;
  jobId?: string;
  requestId?: string;
  component?: string;
  eventCode?: string;
  toolName?: string;
  durationMs?: number;
  stateTransition?: string;
  observationId?: string;
  artifactId?: string;
  attempt?: number;
  [key: string]: unknown;
}

const REDACTED = "[REDACTED]";
const NUMERIC_METRICS = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "tokensPerSecond"]);

const REDACTION_RULES: Array<{ re: RegExp; replacement: string }> = [
  // Telegram bot token: 123456789:AA... (inside URLs or standalone)
  { re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, replacement: REDACTED },
  // Telegram file download URLs
  { re: /https?:\/\/api\.telegram\.org\/file\/bot\S+/gi, replacement: `https://api.telegram.org/file/bot${REDACTED}` },
  // Authorization headers / bearer tokens
  { re: /(authorization["'\s:=]+)(bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED}` },
  { re: /(x-api-key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED}` },
  // Common API key shapes
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  { re: /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  // Query parameters that often carry secrets
  {
    re: /([?&](?:access_token|token|api_key|apikey|key|signature|sig|password|secret|code)=)[^&\s"']+/gi,
    replacement: `$1${REDACTED}`,
  },
  // URL userinfo
  { re: /(\/\/)[^/@\s]+:[^/@\s]+@/g, replacement: `$1${REDACTED}@` },
];

export function redactString(value: string): string {
  let out = value;
  for (const rule of REDACTION_RULES) out = out.replace(rule.re, rule.replacement);
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 60);
    for (const [k, v] of entries) {
      if (NUMERIC_METRICS.has(k) && typeof v === "number" && Number.isFinite(v) && v >= 0) {
        out[k] = v;
      } else if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[FUNCTION]";
  if (value === undefined) return undefined;
  return "[UNSUPPORTED]";
}

export interface LoggerOptions {
  level?: LogLevel;
  logDir?: string;
  toStderr?: boolean;
  now?: () => Date;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly logDir: string | undefined;
  private readonly toStderr: boolean;
  private readonly baseFields: LogFields;
  private readonly now: () => Date;

  constructor(baseFields: LogFields = {}, options: LoggerOptions = {}) {
    this.baseFields = baseFields;
    this.level = options.level ?? levelFromEnv();
    this.logDir = options.logDir;
    this.toStderr = options.toStderr ?? true;
    this.now = options.now ?? (() => new Date());
  }

  child(fields: LogFields): Logger {
    return new Logger({ ...this.baseFields, ...fields }, { level: this.level, logDir: this.logDir, toStderr: this.toStderr, now: this.now });
  }

  getLevel(): LogLevel {
    return this.level;
  }

  debug(eventCode: string, message: string, fields: LogFields = {}): void {
    this.write("debug", eventCode, message, fields);
  }
  info(eventCode: string, message: string, fields: LogFields = {}): void {
    this.write("info", eventCode, message, fields);
  }
  warn(eventCode: string, message: string, fields: LogFields = {}): void {
    this.write("warn", eventCode, message, fields);
  }
  error(eventCode: string, message: string, fields: LogFields = {}): void {
    this.write("error", eventCode, message, fields);
  }

  private write(level: LogLevel, eventCode: string, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    // A caller field named "message" must not clobber the human message; keep
    // it as `detail` so error texts survive.
    const { message: fieldDetail, ...restFields } = fields as LogFields & { message?: unknown };
    const record = {
      timestamp: this.now().toISOString(),
      level,
      eventCode,
      ...(redactValue({ ...this.baseFields, ...restFields }) as Record<string, unknown>),
      ...(fieldDetail !== undefined ? { detail: redactString(String(fieldDetail)) } : {}),
      message: redactString(message),
    };
    const line = JSON.stringify(record);
    if (this.toStderr && LEVEL_ORDER[level] >= LEVEL_ORDER.warn) {
      // eslint-disable-next-line no-console
      console.error(line);
    }
    if (this.logDir) {
      try {
        mkdirSync(this.logDir, { recursive: true });
        const day = record.timestamp.slice(0, 10);
        const file = join(this.logDir, `controller-${day}.jsonl`);
        appendFileSync(file, line + "\n", "utf8");
      } catch {
        // Logging must never take down the controller.
      }
    }
  }
}

export function levelFromEnv(): LogLevel {
  const raw = (process.env.PI_TG_LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export function ensureDirFor(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
