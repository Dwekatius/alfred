/**
 * Harmless fake tools: used by tests, dry-run, and IPC smoke checks.
 */
import sharp from "sharp";
import { AgentToolError } from "./errors.js";
import type { ToolBroker } from "./broker.js";

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char] ?? char);
}

export function registerFakeTools(broker: ToolBroker): void {
  broker.registerHandler("fake_echo", async (args) => {
    const { text } = args as { text: string };
    return { content: [{ type: "text", text: `echo: ${text}` }], details: { length: text.length } };
  });

  broker.registerHandler("fake_image", async (args, context) => {
    const { code } = (args ?? {}) as { code?: string };
    const label = code && code.length > 0 ? code : `TEST-${Math.floor(Math.random() * 100000)}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="#101828"/>
      <rect x="20" y="20" width="600" height="320" rx="16" fill="#1d2939" stroke="#475467" stroke-width="2"/>
      <text x="320" y="160" font-family="Consolas, monospace" font-size="48" fill="#f2f4f7" text-anchor="middle">${escapeXml(label)}</text>
      <text x="320" y="220" font-family="Segoe UI, sans-serif" font-size="22" fill="#98a2b3" text-anchor="middle">alfred test image</text>
    </svg>`;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    let artifactId = "A-unknown";
    try {
      const artifact = context.artifacts.register({ jobId: context.jobId, kind: "observation", mime: "image/png", filename: "test-image.png", bytes, width: 640, height: 360, captureMeta: { source: "fake_image", code: label } });
      artifactId = artifact.id;
    } catch (error) {
      throw new AgentToolError({ code: "INTERNAL_ERROR", message: `Could not register test image: ${(error as Error).message}`, retryable: false, actionOutcome: "not_started" });
    }
    return {
      content: [
        { type: "text", text: `Generated test image ${artifactId} with code "${label}".` },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ],
      details: { artifactId, code: label, width: 640, height: 360 },
    };
  });
}
