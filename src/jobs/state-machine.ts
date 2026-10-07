/**
 * Central job state machine. Every transition is validated here and persisted
 * with a reason by the repository.
 *
 *   queued -> awaiting_start -> starting -> running
 *   running -> waiting_for_owner | waiting_for_unlock | paused | cancelling
 *   paused -> running
 *   cancelling -> cancelled
 *   terminal: succeeded | failed | cancelled | interrupted
 */
import { ValidationError } from "../tools/errors.js";

export type JobState =
  | "queued"
  | "awaiting_start"
  | "starting"
  | "running"
  | "waiting_for_owner"
  | "waiting_for_unlock"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

const TRANSITIONS: Record<JobState, ReadonlySet<JobState>> = {
  queued: new Set(["awaiting_start", "starting", "cancelling", "cancelled", "failed"]),
  awaiting_start: new Set(["queued", "starting", "cancelling", "cancelled", "failed"]),
  starting: new Set(["running", "failed", "cancelling", "interrupted"]),
  running: new Set(["waiting_for_owner", "waiting_for_unlock", "paused", "cancelling", "succeeded", "failed", "interrupted"]),
  waiting_for_owner: new Set(["running", "paused", "cancelling", "cancelled", "failed", "interrupted"]),
  waiting_for_unlock: new Set(["running", "waiting_for_owner", "paused", "cancelling", "cancelled", "failed", "interrupted"]),
  paused: new Set(["running", "waiting_for_owner", "cancelling", "cancelled", "failed", "interrupted"]),
  cancelling: new Set(["cancelled", "failed", "interrupted"]),
  succeeded: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
  interrupted: new Set([]),
};

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new ValidationError(`Invalid job state transition: ${from} -> ${to}`, { from, to });
  }
}

export function isActiveState(state: JobState): boolean {
  return state === "starting" || state === "running" || state === "waiting_for_owner" || state === "waiting_for_unlock" || state === "paused" || state === "cancelling";
}
