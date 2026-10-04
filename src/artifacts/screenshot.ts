/**
 * Screenshot service: captures the visible desktop or focused window directly
 * from the supervisor, without a model turn. Uses the fast Screenshot path so
 * it never disturbs a UI element map used by an in-flight action.
 */
import sharp from "sharp";
import { AppConfig } from "../config.js";
import { Logger } from "../logging.js";
import { ArtifactRegistry } from "./registry.js";
import type { ScreenshotCaptureResult, ScreenshotProvider, DesktopProbeResult } from "../supervisor.js";
import type { WindowsBackend } from "../tools/windows-mcp.js";
import type { DesktopLease } from "../tools/desktop-lease.js";

export interface ScreenshotServiceDeps {
  config: AppConfig;
  artifacts: ArtifactRegistry;
  windows: WindowsBackend;
  lease: DesktopLease;
  logger: Logger;
}

export class ScreenshotService implements ScreenshotProvider {
  constructor(private readonly deps: ScreenshotServiceDeps) {}

  availability(): DesktopProbeResult {
    // Synchronous status from the last known session state; the detailed probe
    // is async and refreshed by the session monitor.
    return this.lastAvailability;
  }

  private lastAvailability: DesktopProbeResult = { available: true, reason: "not yet probed" };

  async probe(): Promise<DesktopProbeResult> {
    try {
      const state = await this.deps.windows.helper.sessionState();
      if (state.locked === true) {
        this.lastAvailability = { available: false, reason: "PC is locked", detail: state.desktop ?? undefined };
      } else if (state.locked === null) {
        this.lastAvailability = { available: true, reason: "session state unknown", detail: state.error ?? undefined };
      } else {
        this.lastAvailability = { available: true, detail: state.desktop ?? "Default" };
      }
    } catch (error) {
      this.lastAvailability = { available: false, reason: `Windows helper unavailable: ${(error as Error).message}` };
    }
    return this.lastAvailability;
  }

  async capture(scope: "desktop" | "window"): Promise<ScreenshotCaptureResult | { error: string }> {
    return await this.deps.lease.mutex.runExclusive(async () => {
      try {
        const availability = await this.probe();
        if (!availability.available) return { error: availability.reason ?? "desktop unavailable" };
        let region: number[] | undefined;
        let windowTitle: string | undefined;
        if (scope === "window") {
          const foreground = await this.deps.windows.helper.foregroundWindow();
          if (!foreground.handle || !foreground.rect) return { error: "No focused normal window was found." };
          if (foreground.rect.width <= 0 || foreground.rect.height <= 0) return { error: "The focused window has no capturable area." };
          region = [foreground.rect.left, foreground.rect.top, foreground.rect.right, foreground.rect.bottom];
          windowTitle = foreground.title;
        }
        const result = await this.deps.windows.mcp.callTool(
          "Screenshot",
          { use_annotation: false, ...(region ? { region } : {}) },
          { timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs },
        );
        if (result.isError) {
          const text = result.content.find((block) => block.type === "text")?.text ?? "Screenshot failed";
          return { error: text.slice(0, 300) };
        }
        const imageBlock = result.content.find((block) => block.type === "image" && block.data);
        if (!imageBlock?.data) return { error: "The screenshot backend returned no image." };
        const bytes = Buffer.from(imageBlock.data, "base64");
        const metadata = await sharp(bytes).metadata();
        const artifact = this.deps.artifacts.register({
          jobId: null,
          kind: "screenshot",
          mime: imageBlock.mimeType ?? "image/png",
          filename: `screenshot-${scope}-${Date.now()}.png`,
          bytes,
          width: metadata.width,
          height: metadata.height,
          captureMeta: { scope, region, windowTitle, capturedAtUtc: new Date().toISOString() },
        });
        const caption = scope === "window" ? `Focused window screenshot${windowTitle ? `: ${windowTitle}` : ""} (${artifact.id})` : `Desktop screenshot (${artifact.id})`;
        return { artifactId: artifact.id, caption };
      } catch (error) {
        this.deps.logger.warn("screenshot.failed", "Screenshot capture failed.", { eventCode: "SCREENSHOT_FAILED", message: (error as Error).message });
        return { error: (error as Error).message.slice(0, 300) };
      }
    });
  }
}
