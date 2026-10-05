/** Offline lifecycle fixture. No model, desktop, credentials or network calls. */
import { IPC_PROTOCOL_VERSION } from "../../src/ipc.js";
const mode = process.env.ALFRED_TEST_WORKER_MODE ?? "ready";
process.on("disconnect", () => process.exit(0));
process.on("message", (message: Record<string, unknown>) => {
  if (message.type === "abort") {
    if (mode !== "ignore_abort") process.exit(0);
    return;
  }
  if (message.type !== "start_job" || mode === "hang" || mode === "ignore_abort") return;
  const envelope = { protocolVersion: IPC_PROTOCOL_VERSION, jobId: message.jobId, leaseGeneration: message.leaseGeneration, requestId: "fixture-result" };
  process.send?.({ ...envelope, type: "session_mapped", sessionFile: null, effectiveModel: message.model, activeTools: [] });
  process.send?.({ ...envelope, type: "settled", resultText: JSON.stringify({ pid: process.pid, providers: (message.apiKeys as Array<{ provider: string }> ?? []).map((entry) => entry.provider) }) });
});
if (mode === "fail") process.exit(2);
if (mode !== "never_ready") process.send?.({ protocolVersion: IPC_PROTOCOL_VERSION, type: "pool_ready", pid: process.pid });
