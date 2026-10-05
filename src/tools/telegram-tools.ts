/**
 * Telegram delivery tools. All destinations are bound to the paired owner chat;
 * the model can only name registered artifacts, never paths or destinations.
 */
import { caption as makeCaption } from "../telegram/format.js";
import { AgentToolError } from "./errors.js";
import type { BrokerContext, ToolBroker } from "./broker.js";

function assertArtifactAccess(artifactId: string, context: BrokerContext): { path: string; mime: string } {
  const artifact = context.artifacts.get(artifactId);
  if (!artifact) throw new AgentToolError({ code: "ARTIFACT_NOT_FOUND", message: `No artifact ${artifactId}.`, retryable: false, actionOutcome: "not_started" });
  const job = context.repo.getJob(context.jobId);
  const artifactConversation = artifact.conversation_id ?? (artifact.job_id ? context.repo.getJob(artifact.job_id)?.conversation_id : undefined);
  const allowed = !artifact.job_id || artifact.job_id === job?.id || (artifactConversation && artifactConversation === job?.conversation_id);
  if (!allowed) throw new AgentToolError({ code: "ARTIFACT_NOT_FOUND", message: `Artifact ${artifactId} is not available to this job.`, retryable: false, actionOutcome: "not_started" });
  return { path: artifact.relative_path, mime: artifact.mime };
}

export function registerTelegramTools(broker: ToolBroker): void {
  broker.registerHandler("artifact_read_image", async (args, context) => {
    const { artifactId } = args as { artifactId: string };
    const artifact = assertArtifactAccess(artifactId, context);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(artifact.mime)) throw new AgentToolError({ code: "ARTIFACT_REJECTED", message: "The requested artifact is not a supported image.", retryable: false, actionOutcome: "not_started" });
    const saved = await context.artifacts.readBytes(artifactId);
    if (!saved) throw new AgentToolError({ code: "ARTIFACT_NOT_FOUND", message: "The saved image is no longer available.", retryable: false, actionOutcome: "not_started" });
    return { content: [{ type: "text", text: `Historical image ${artifactId}. Take a fresh observation before any desktop input.` }, { type: "image", data: saved.bytes.toString("base64"), mimeType: saved.mime }], details: { artifactId } };
  });
  broker.registerHandler("telegram_send_image", async (args, context) => {
    const { artifactId, caption, exact } = args as { artifactId: string; caption?: string; exact?: boolean };
    assertArtifactAccess(artifactId, context);
    const artifact = context.artifacts.get(artifactId)!;
    const kind = exact || artifact.mime !== "image/png" && artifact.mime !== "image/jpeg" ? "document" : "photo";
    const ok = context.outbox?.enqueue({
      logicalKey: `tool-image:${context.jobId}:${context.requestId}`,
      kind,
      artifactId,
      payload: { variant: "image", caption: caption ? makeCaption(caption) : undefined },
    });
    if (!ok) throw new AgentToolError({ code: "INTERNAL_ERROR", message: "Outbox is not available.", retryable: true, actionOutcome: "not_started" });
    return { content: [{ type: "text", text: `Image ${artifactId} queued for delivery to the owner.` }], details: { artifactId, mode: kind } };
  });

  broker.registerHandler("telegram_send_file", async (args, context) => {
    const { artifactId, caption } = args as { artifactId: string; caption?: string };
    assertArtifactAccess(artifactId, context);
    const artifact = context.artifacts.get(artifactId)!;
    if (artifact.kind !== "document" && artifact.kind !== "other") {
      throw new AgentToolError({ code: "ARTIFACT_REJECTED", message: `Artifact ${artifactId} is a ${artifact.kind}, not a document.`, retryable: false, actionOutcome: "not_started" });
    }
    const ok = context.outbox?.enqueue({
      logicalKey: `tool-file:${context.jobId}:${context.requestId}`,
      kind: "document",
      artifactId,
      payload: { variant: "file", caption: caption ? makeCaption(caption) : undefined },
    });
    if (!ok) throw new AgentToolError({ code: "INTERNAL_ERROR", message: "Outbox is not available.", retryable: true, actionOutcome: "not_started" });
    return { content: [{ type: "text", text: `Document ${artifactId} queued for delivery to the owner.` }], details: { artifactId } };
  });

  broker.registerHandler("telegram_notify", async (args, context) => {
    const { text } = args as { text: string };
    context.notifyOwner(text);
    return { content: [{ type: "text", text: "Notification queued." }], details: {} };
  });

  broker.registerHandler("request_owner_input", async (args, context) => {
    const { question, options } = args as { question: string; options?: string[] };
    const answer = await context.requestOwnerInput({ question, options });
    return { content: [{ type: "text", text: `Owner answered: ${answer}` }], details: { question, answer } };
  });
}
