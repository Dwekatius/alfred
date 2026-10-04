/**
 * Structured error types returned through the broker to the model.
 *
 * `actionOutcome` drives recovery:
 * - not_started: safe to retry after re-observation
 * - completed: action happened; do not repeat blindly
 * - unknown: outcome uncertain; re-observe before any continuation
 */
export type ActionOutcome = "not_started" | "completed" | "unknown";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "POLICY_BLOCKED"
  | "APPROVAL_REQUIRED"
  | "DESKTOP_LOCKED"
  | "SESSION_UNAVAILABLE"
  | "ELEVATION_REQUIRED"
  | "SECURE_DESKTOP"
  | "STALE_OBSERVATION"
  | "TARGET_NOT_FOUND"
  | "HUMAN_TAKEOVER"
  | "BROWSER_DISCONNECTED"
  | "PROFILE_IN_USE"
  | "LOGIN_REQUIRED"
  | "CAPTCHA_OR_MFA"
  | "MODEL_UNAVAILABLE"
  | "VISION_UNSUPPORTED"
  | "TOOLS_UNSUPPORTED"
  | "RATE_LIMITED"
  | "TOOL_TIMEOUT"
  | "CANCELLED"
  | "LEASE_REVOKED"
  | "PAUSED"
  | "WORK_LIMIT_REACHED"
  | "NO_PROGRESS"
  | "DRY_RUN"
  | "NOT_IMPLEMENTED"
  | "INTERNAL_ERROR"
  | "DELIVERY_UNKNOWN"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_REJECTED"
  | "OUTBOX_ERROR"
  | "TELEGRAM_ERROR"
  | "BACKEND_ERROR";

export interface AgentToolErrorData {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  actionOutcome: ActionOutcome;
  observationId?: string;
  artifactId?: string;
  details?: Record<string, unknown>;
}

export class AgentToolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly actionOutcome: ActionOutcome;
  readonly observationId?: string;
  readonly artifactId?: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(data: AgentToolErrorData) {
    super(data.message);
    this.name = "AgentToolError";
    this.code = data.code;
    this.retryable = data.retryable;
    this.actionOutcome = data.actionOutcome;
    this.observationId = data.observationId;
    this.artifactId = data.artifactId;
    this.details = data.details;
  }

  toData(): AgentToolErrorData {
    const data: AgentToolErrorData = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      actionOutcome: this.actionOutcome,
    };
    if (this.observationId !== undefined) data.observationId = this.observationId;
    if (this.artifactId !== undefined) data.artifactId = this.artifactId;
    if (this.details !== undefined) data.details = this.details;
    return data;
  }

  static from(error: unknown, fallbackCode: ErrorCode = "INTERNAL_ERROR", fallbackOutcome: ActionOutcome = "not_started"): AgentToolError {
    if (error instanceof AgentToolError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new AgentToolError({ code: fallbackCode, message, retryable: false, actionOutcome: fallbackOutcome });
  }
}

export class ValidationError extends Error {
  readonly details: Record<string, unknown> | undefined;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class CancellationError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

export class LeaseRevokedError extends Error {
  constructor(message = "Desktop lease revoked") {
    super(message);
    this.name = "LeaseRevokedError";
  }
}
