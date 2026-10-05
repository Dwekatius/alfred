import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Messages = AgentSession["agent"]["state"]["messages"];
type Message = Messages[number];

/**
 * Freeze an image-free projection of PREVIOUS jobs at assignment time. The
 * canonical transcript, text, tool pairs and reasoning signatures stay intact.
 * Current-job images (including explicit artifact retrieval) are never stripped.
 * The fixed projection also keeps the request prefix stable throughout a job.
 */
export class HistoricalImageProjection {
  private readonly projected = new Map<string, Message>();
  readonly removedImages: number;
  readonly removedBase64Bytes: number;

  constructor(history: Messages, enabled = true) {
    let images = 0;
    let bytes = 0;
    if (enabled) {
      for (const message of history) {
        if (message.role !== "toolResult" || !message.content.some((block) => block.type === "image")) continue;
        const content = message.content.map((block) => {
          if (block.type !== "image") return block;
          images += 1;
          bytes += Buffer.byteLength(block.data, "utf8");
          return { type: "text" as const, text: "[Screenshot from a previous task omitted from active context. Its original remains in the saved transcript and registered artifact. Use artifact_read_image with its artifactId if the owner needs this image again. Take a fresh observation before controlling the PC.]" };
        });
        this.projected.set(this.key(message), { ...message, content });
      }
    }
    this.removedImages = images;
    this.removedBase64Bytes = bytes;
  }

  private key(message: Extract<Message, { role: "toolResult" }>): string {
    return JSON.stringify([message.toolCallId, message.timestamp]);
  }

  apply(messages: Messages): Messages {
    if (this.projected.size === 0) return messages;
    return messages.map((message) => message.role === "toolResult" ? (this.projected.get(this.key(message)) ?? message) : message);
  }
}

/** Projection size, not HTTP wire size. Never records message bodies. */
export function measureContext(messages: Messages): { contextBytes: number; imageCount: number; imageBase64Bytes: number } {
  let imageCount = 0;
  let imageBase64Bytes = 0;
  for (const message of messages) {
    if (!("content" in message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "image") {
        imageCount += 1;
        imageBase64Bytes += Buffer.byteLength(block.data, "utf8");
      }
    }
  }
  return { contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"), imageCount, imageBase64Bytes };
}
