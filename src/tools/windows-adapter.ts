/**
 * Desktop tool handlers over the pinned Windows-MCP backend.
 *
 * The adapter owns:
 * - the observation registry with opaque element refs
 * - image-to-screen coordinate transforms (physical virtual-desktop pixels)
 * - freshness/lease/window validation before input
 * - mapping of upstream argument quirks into the stable broker contract
 */
import sharp from "sharp";
import { AppConfig } from "../config.js";
import { Logger } from "../logging.js";
import { AgentToolError } from "./errors.js";
import type { BrokerContext, ToolBroker } from "./broker.js";
import type { DesktopLease } from "./desktop-lease.js";
import type { WindowsBackend } from "./windows-mcp.js";
import type { McpContentBlock } from "./mcp-client.js";

export interface DesktopToolDeps {
  windows: WindowsBackend;
  lease: DesktopLease;
  logger: Logger;
  config: AppConfig;
}

interface ParsedDisplay {
  index: number;
  device: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  primary: boolean;
}

interface ParsedWindow {
  windowId: string;
  name: string;
  status: string;
  width: number;
  height: number;
  handle: string;
}

interface ParsedElement {
  ref: string;
  x: number;
  y: number;
  controlType: string;
  name: string;
  action?: string;
  focused: boolean;
  password: boolean;
  value?: string;
}

interface ParsedSnapshot {
  cursor?: { x: number; y: number };
  originalSize?: { width: number; height: number };
  coordinateScale: number;
  displays: ParsedDisplay[];
  selectedDisplays: number[];
  region?: { left: number; top: number; right: number; bottom: number };
  focusedWindow?: ParsedWindow;
  windows: ParsedWindow[];
  elements: ParsedElement[];
  uiTreePresent: boolean;
  rawText: string;
}

interface Observation {
  id: string;
  jobId: string;
  capturedAt: number;
  epoch: number;
  artifactId: string;
  imageWidth: number;
  imageHeight: number;
  captureBounds: { left: number; top: number; width: number; height: number };
  coordinateScale: number;
  foregroundHandle?: string | null;
  elements: Map<string, ParsedElement>;
  windows: ParsedWindow[];
  stale: boolean;
  cleanImage: boolean;
  cursor?: { x: number; y: number };
}

const WINDOW_ROW = /^(.*?)\s{2,}(\d+)\s{2,}(\S+)\s{2,}(\d+)\s{2,}(\d+)\s{2,}(\S+)\s*$/;
const ELEMENT_LINE = /\((-?\d+),\s*(-?\d+)\)\s+([A-Za-z_]+)\s+"((?:[^"\\]|\\.)*)"(?:\s+\[action:\s*([^\]]+)\])?(.*)$/;
const DISPLAY_LINE = /(\d+):(\S+)\s+\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)(\s+primary)?/g;

export function parseSnapshotText(text: string): ParsedSnapshot {
  // FastMCP can return a single-item list as a JSON-encoded string block; unwrap it.
  let unwrapped = text;
  const trimmed = text.trim();
  if (trimmed.startsWith('[\"') && trimmed.endsWith('\"]')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && typeof parsed[0] === "string") unwrapped = parsed[0];
    } catch {
      /* keep original */
    }
  }
  text = unwrapped;
  const result: ParsedSnapshot = { coordinateScale: 1, displays: [], selectedDisplays: [], windows: [], elements: [], uiTreePresent: false, rawText: text };
  const cursor = /Cursor Position:\s*\((-?\d+),\s*(-?\d+)\)/.exec(text);
  if (cursor) result.cursor = { x: Number(cursor[1]), y: Number(cursor[2]) };
  const original = /Screenshot Original Size:\s*\((\d+),(\d+)\)/.exec(text) ?? /Screenshot Size:\s*\((\d+),(\d+)\)/.exec(text);
  if (original) result.originalSize = { width: Number(original[1]), height: Number(original[2]) };
  const scale = /Screenshot Coordinate Scale:\s*([0-9.]+)/.exec(text);
  if (scale) result.coordinateScale = Number(scale[1]);
  const region = /Screenshot Region:\s*\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/.exec(text);
  if (region) result.region = { left: Number(region[1]), top: Number(region[2]), right: Number(region[3]), bottom: Number(region[4]) };

  const visibleIndex = text.indexOf("Visible Displays:");
  if (visibleIndex >= 0) {
    const lineEnd = text.indexOf("\n", visibleIndex);
    const line = text.slice(visibleIndex, lineEnd < 0 ? undefined : lineEnd);
    DISPLAY_LINE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DISPLAY_LINE.exec(line)) !== null) {
      result.displays.push({
        index: Number(match[1]),
        device: match[2] ?? "",
        left: Number(match[3]),
        top: Number(match[4]),
        right: Number(match[5]),
        bottom: Number(match[6]),
        primary: Boolean(match[7]),
      });
    }
  }
  const selected = /Selected Displays:\s*([0-9,\s]+)/.exec(text);
  if (selected?.[1]) {
    result.selectedDisplays = selected[1]
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));
  }

  // Windows tables: rows in the "Focused Window" and "Opened Windows" sections.
  const lines = text.split(/\r?\n/u);
  let currentSection: "focused" | "windows" | "other" | "ui" = "other";
  for (const line of lines) {
    const sectionLine = line.trimStart();
    if (sectionLine.startsWith("Focused Window:")) {
      currentSection = "focused";
      continue;
    }
    if (sectionLine.startsWith("Opened Windows:")) {
      currentSection = "windows";
      continue;
    }
    if (sectionLine.startsWith("UI Tree:")) {
      currentSection = "ui";
      continue;
    }
    if (currentSection === "ui") {
      if (!result.uiTreePresent) result.uiTreePresent = true;
      const elementMatch = ELEMENT_LINE.exec(line);
      if (elementMatch) {
        const meta = elementMatch[6] ?? "";
        result.elements.push({
          ref: `E${result.elements.length + 1}`,
          x: Number(elementMatch[1]),
          y: Number(elementMatch[2]),
          controlType: elementMatch[3] ?? "control",
          name: elementMatch[4] ?? "",
          action: elementMatch[5],
          focused: meta.includes("[focused]"),
          password: meta.includes("[password]"),
          value: /value:"([^"]*)"/.exec(meta)?.[1],
        });
      }
      continue;
    }
    const windowMatch = WINDOW_ROW.exec(line);
    if (windowMatch && currentSection !== "other") {
      const parsed: ParsedWindow = {
        windowId: `W:${windowMatch[6]}`,
        name: (windowMatch[1] ?? "").trim(),
        status: windowMatch[3] ?? "",
        width: Number(windowMatch[4]),
        height: Number(windowMatch[5]),
        handle: windowMatch[6] ?? "",
      };
      if (currentSection === "focused") result.focusedWindow = parsed;
      else if (parsed.status !== "Minimized") result.windows.push(parsed);
    }
  }
  return result;
}

function unionDisplays(displays: ParsedDisplay[], selected: number[]): { left: number; top: number; width: number; height: number } | undefined {
  const chosen = selected.length > 0 ? displays.filter((display) => selected.includes(display.index)) : displays;
  if (chosen.length === 0) return undefined;
  const left = Math.min(...chosen.map((display) => display.left));
  const top = Math.min(...chosen.map((display) => display.top));
  const right = Math.max(...chosen.map((display) => display.right));
  const bottom = Math.max(...chosen.map((display) => display.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

export class DesktopTools {
  private observations = new Map<string, Observation>();
  private epoch = 0;
  private observationCounter = 0;
  private windowRegistry = new Map<string, ParsedWindow>();

  constructor(private readonly deps: DesktopToolDeps) {}

  private nextObservationId(): string {
    this.observationCounter += 1;
    return `O-${this.observationCounter}`;
  }

  private invalidateObservations(jobId: string): void {
    this.epoch += 1;
    for (const observation of this.observations.values()) {
      if (observation.jobId === jobId) observation.stale = true;
    }
  }

  private getObservation(jobId: string, observationId: string): Observation {
    const observation = this.observations.get(observationId);
    if (!observation || observation.jobId !== jobId) {
      throw new AgentToolError({ code: "STALE_OBSERVATION", message: `Observation ${observationId} is unknown. Call desktop_observe again.`, retryable: true, actionOutcome: "not_started", observationId });
    }
    if (observation.stale || observation.epoch !== this.epoch) {
      throw new AgentToolError({ code: "STALE_OBSERVATION", message: `Observation ${observationId} was invalidated by a later action. Call desktop_observe again.`, retryable: true, actionOutcome: "not_started", observationId });
    }
    if (Date.now() - observation.capturedAt > this.deps.config.desktop.observationMaxAgeMs) {
      throw new AgentToolError({ code: "STALE_OBSERVATION", message: `Observation ${observationId} is older than ${this.deps.config.desktop.observationMaxAgeMs}ms. Call desktop_observe again.`, retryable: true, actionOutcome: "not_started", observationId });
    }
    return observation;
  }

  private async assertDesktopAvailable(): Promise<void> {
    if (!this.deps.config.desktop.requireUnlockedSession) return;
    const state = await this.deps.windows.helper.sessionState();
    if (state.locked === true) {
      throw new AgentToolError({ code: "DESKTOP_LOCKED", message: "The PC is locked. Unlock it to continue.", retryable: false, actionOutcome: "not_started" });
    }
  }

  private async assertTargetStillValid(observation: Observation): Promise<void> {
    const foreground = await this.deps.windows.helper.foregroundWindow();
    if (observation.foregroundHandle && foreground.handle && normalizeHandle(observation.foregroundHandle) !== normalizeHandle(foreground.handle)) {
      throw new AgentToolError({
        code: "STALE_OBSERVATION",
        message: `The foreground window changed since observation ${observation.id} (was ${observation.foregroundHandle}, now ${foreground.handle}). Call desktop_observe again.`,
        retryable: true,
        actionOutcome: "not_started",
        observationId: observation.id,
      });
    }
  }

  private imageToScreen(observation: Observation, point: { x: number; y: number }): { x: number; y: number } {
    const { captureBounds, imageWidth, imageHeight } = observation;
    if (imageWidth <= 0 || imageHeight <= 0) throw new AgentToolError({ code: "INTERNAL_ERROR", message: "Observation has no image dimensions.", retryable: false, actionOutcome: "not_started" });
    if (point.x < 0 || point.y < 0 || point.x > imageWidth || point.y > imageHeight) {
      throw new AgentToolError({ code: "VALIDATION_ERROR", message: `Point (${point.x},${point.y}) is outside the observed image ${imageWidth}x${imageHeight}.`, retryable: false, actionOutcome: "not_started", observationId: observation.id });
    }
    const x = Math.round(captureBounds.left + (point.x * captureBounds.width) / imageWidth);
    const y = Math.round(captureBounds.top + (point.y * captureBounds.height) / imageHeight);
    return { x, y };
  }

  private resolveTarget(observation: Observation, target: { point?: { x: number; y: number }; elementRef?: string }): { x: number; y: number; element?: ParsedElement } {
    if (target.elementRef) {
      const element = observation.elements.get(target.elementRef);
      if (!element) {
        throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Element ${target.elementRef} is not in observation ${observation.id}.`, retryable: true, actionOutcome: "not_started", observationId: observation.id });
      }
      return { x: element.x, y: element.y, element };
    }
    if (target.point) return this.imageToScreen(observation, target.point);
    throw new AgentToolError({ code: "VALIDATION_ERROR", message: "Exactly one of elementRef or point is required.", retryable: false, actionOutcome: "not_started" });
  }

  private async snapshot(args: Record<string, unknown>, options: { signal: AbortSignal; includeUiTree: boolean; useVision: boolean; annotate: boolean }): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
    const result = await this.callTool(
      "Snapshot",
      {
        use_vision: options.useVision,
        use_dom: false,
        use_annotation: options.annotate,
        use_ui_tree: options.includeUiTree,
        ...args,
      },
      { signal: options.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs },
    );
    if (result.isError) {
      const text = result.content.find((block) => block.type === "text")?.text ?? "Snapshot failed";
      throw new AgentToolError({ code: "BACKEND_ERROR", message: text.slice(0, 400), retryable: true, actionOutcome: "not_started" });
    }
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    const imageBlock = result.content.find((block) => block.type === "image" && block.data) as McpContentBlock | undefined;
    if (text.startsWith("Error capturing desktop state")) {
      throw new AgentToolError({ code: "BACKEND_ERROR", message: text.slice(0, 400), retryable: true, actionOutcome: "not_started" });
    }
    return { text, image: imageBlock?.data ? { data: imageBlock.data, mimeType: imageBlock.mimeType ?? "image/png" } : undefined };
  }

  async observe(args: { scope?: "desktop" | "window" | "region"; windowId?: string; region?: { x: number; y: number; width: number; height: number }; annotate?: boolean; includeUiTree?: boolean }, context: BrokerContext, interactionMode: "model" | "clean" = "model"): Promise<{ observation: Observation; text: string; image?: { data: string; mimeType: string } }> {
    await this.assertDesktopAvailable();
    const scope = args.scope ?? "desktop";
    const snapshotArgs: Record<string, unknown> = {};
    if (scope === "region" && args.region) {
      snapshotArgs.region = [args.region.x, args.region.y, args.region.x + args.region.width, args.region.y + args.region.height];
    }
    return await context.runExclusive(async () => {
      context.assertLease();
      const { text, image } = await this.snapshot(snapshotArgs, {
        signal: context.signal,
        includeUiTree: args.includeUiTree ?? interactionMode === "model",
        useVision: true,
        annotate: interactionMode === "model" ? (args.annotate ?? true) : false,
      });
      const parsed = parseSnapshotText(text);
      const monitors = await this.deps.windows.helper.monitors();
      let captureBounds: { left: number; top: number; width: number; height: number };
      if (parsed.region) {
        captureBounds = { left: parsed.region.left, top: parsed.region.top, width: parsed.region.right - parsed.region.left, height: parsed.region.bottom - parsed.region.top };
      } else {
        const union = unionDisplays(parsed.displays, parsed.selectedDisplays) ?? { left: 0, top: 0, width: parsed.originalSize?.width ?? 0, height: parsed.originalSize?.height ?? 0 };
        captureBounds = union;
      }
      let imageWidth = parsed.originalSize?.width ?? captureBounds.width;
      let imageHeight = parsed.originalSize?.height ?? captureBounds.height;
      let imageBytes: Buffer | undefined;
      if (image) {
        imageBytes = Buffer.from(image.data, "base64");
        const metadata = await sharp(imageBytes).metadata();
        imageWidth = metadata.width ?? imageWidth;
        imageHeight = metadata.height ?? imageHeight;
      }
      if (captureBounds.width <= 0 || captureBounds.height <= 0 || imageWidth <= 0) {
        throw new AgentToolError({ code: "BACKEND_ERROR", message: "Snapshot returned no usable geometry.", retryable: true, actionOutcome: "not_started" });
      }
      const artifact = context.artifacts.register({
        jobId: context.jobId,
        kind: interactionMode === "model" ? "observation" : "screenshot",
        mime: "image/png",
        filename: `observation-${Date.now()}.png`,
        bytes: imageBytes ?? Buffer.alloc(0),
        width: imageWidth,
        height: imageHeight,
        captureMeta: {
          captureBounds,
          coordinateScale: parsed.coordinateScale,
          monitors: monitors.map((monitor) => ({ device: monitor.device, left: monitor.left, top: monitor.top, width: monitor.width, height: monitor.height, dpi: monitor.dpi, scale: monitor.scale })),
          cursor: parsed.cursor,
          foreground: parsed.focusedWindow?.windowId,
          selectedDisplays: parsed.selectedDisplays,
          region: parsed.region,
        },
      });
      const id = this.nextObservationId();
      const elements = new Map<string, ParsedElement>();
      for (const element of parsed.elements) elements.set(element.ref, element);
      const observation: Observation = {
        id,
        jobId: context.jobId,
        capturedAt: Date.now(),
        epoch: this.epoch,
        artifactId: artifact.id,
        imageWidth,
        imageHeight,
        captureBounds,
        coordinateScale: parsed.coordinateScale,
        foregroundHandle: parsed.focusedWindow?.handle ?? null,
        elements,
        windows: parsed.windows,
        stale: false,
        cleanImage: interactionMode === "clean",
        cursor: parsed.cursor,
      };
      this.observations.set(id, observation);
      for (const window of parsed.windows) this.windowRegistry.set(window.windowId, window);
      // Keep at most 8 observations per job.
      const jobObservations = [...this.observations.entries()].filter(([, value]) => value.jobId === context.jobId);
      if (jobObservations.length > 8) {
        for (const [key] of jobObservations.slice(0, jobObservations.length - 8)) this.observations.delete(key);
      }
      return { observation, text, image };
    });
  }

  buildObservationText(observation: Observation, parsedText: string, maxChars = 6000): string {
    const elementLines = [...observation.elements.values()]
      .slice(0, 120)
      .map((element) => `${element.ref} (${element.x},${element.y}) ${element.controlType} "${element.name}"${element.focused ? " [focused]" : ""}${element.password ? " [password]" : ""}${element.action ? ` [action: ${element.action}]` : ""}`)
      .join("\n");
    const header = [
      `observationId: ${observation.id}`,
      `artifactId: ${observation.artifactId}`,
      `capturedAtUtc: ${new Date(observation.capturedAt).toISOString()}`,
      `desktopEpoch: ${observation.epoch}`,
      `coordinateSpace: image (screenX = ${observation.captureBounds.left} + imageX * ${observation.captureBounds.width}/${observation.imageWidth}; screenY = ${observation.captureBounds.top} + imageY * ${observation.captureBounds.height}/${observation.imageHeight})`,
      `captureBoundsPhysical: ${JSON.stringify(observation.captureBounds)}`,
      `imageSize: ${observation.imageWidth}x${observation.imageHeight}`,
      `windows: ${observation.windows.map((window) => `${window.windowId} "${window.name}"`).join("; ") || "none"}`,
    ].join("\n");
    const trimmedText = parsedText.length > maxChars ? `${parsedText.slice(0, maxChars)}\n[metadata truncated]` : parsedText;
    return `${header}\n\nelementRefs:\n${elementLines || "(no interactive elements captured)"}\n\nbackendMetadata:\n${trimmedText}`;
  }

  async click(args: { observationId: string; target: { point?: { x: number; y: number }; elementRef?: string }; button?: "left" | "right" | "middle"; count?: number }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    const observation = this.getObservation(context.jobId, args.observationId);
    return await context.runExclusive(async () => {
      context.assertLease();
      await this.assertTargetStillValid(observation);
      const target = this.resolveTarget(observation, args.target);
      const clicks = args.count === 2 ? 2 : args.count === 3 ? 2 : (args.count ?? 1);
      await this.callTool(
        "Click",
        { loc: [target.x, target.y], button: args.button ?? "left", clicks },
        { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs },
      );
      this.invalidateObservations(context.jobId);
      return `Clicked ${args.button ?? "left"} at (${target.x},${target.y})${target.element ? ` on ${target.element.ref} "${target.element.name}"` : ""}.`;
    });
  }

  async move(args: { observationId: string; target: { point?: { x: number; y: number }; elementRef?: string }; durationMs?: number }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    const observation = this.getObservation(context.jobId, args.observationId);
    return await context.runExclusive(async () => {
      context.assertLease();
      await this.assertTargetStillValid(observation);
      const target = this.resolveTarget(observation, args.target);
      await this.callTool("Move", { loc: [target.x, target.y] }, { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs });
      return `Moved pointer to (${target.x},${target.y}).`;
    });
  }

  async drag(args: { observationId: string; from: { point?: { x: number; y: number }; elementRef?: string }; to: { point?: { x: number; y: number }; elementRef?: string }; durationMs?: number }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    const observation = this.getObservation(context.jobId, args.observationId);
    return await context.runExclusive(async () => {
      context.assertLease();
      await this.assertTargetStillValid(observation);
      const from = this.resolveTarget(observation, args.from);
      const to = this.resolveTarget(observation, args.to);
      await this.callTool(
        "Move",
        { loc: [to.x, to.y], from_loc: [from.x, from.y], drag: true, duration: Math.min(5, Math.max(0.05, (args.durationMs ?? 600) / 1000)) },
        { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs },
      );
      this.invalidateObservations(context.jobId);
      return `Dragged from (${from.x},${from.y}) to (${to.x},${to.y}).`;
    });
  }

  async type(args: { observationId: string; target?: { point?: { x: number; y: number }; elementRef?: string }; text: string; mode?: "replace" | "append" }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    const observation = this.getObservation(context.jobId, args.observationId);
    return await context.runExclusive(async () => {
      context.assertLease();
      await this.assertTargetStillValid(observation);
      const target = args.target ? this.resolveTarget(observation, args.target) : this.focusedOrCursorTarget(observation);
      if (args.target) {
        await this.callTool("Click", { loc: [target.x, target.y], button: "left", clicks: 1 }, { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs });
      }
      if (args.mode === "replace") {
        await this.callTool("Shortcut", { shortcut: "ctrl+a" }, { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs });
      } else {
        // Append: move the caret to the end of the existing content first.
        await this.callTool("Shortcut", { shortcut: "ctrl+end" }, { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs });
      }
      // Native Unicode typing into the focused control: no click, no layout drift.
      await this.deps.windows.helper.typeText(args.text);
      this.invalidateObservations(context.jobId);
      return `Typed ${JSON.stringify(args.text.slice(0, 80))}${args.mode === "replace" ? " after selecting existing text" : ""}.`;
    });
  }

  async key(args: { keys: string; observationId?: string; holdMs?: number; repeat?: number }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    if (args.observationId) this.getObservation(context.jobId, args.observationId);
    return await context.runExclusive(async () => {
      context.assertLease();
      if (args.holdMs && args.holdMs > 0) {
        await this.deps.windows.helper.keyHold(args.keys, Math.min(args.holdMs, 10000));
      } else {
        const times = Math.min(args.repeat ?? 1, 50);
        for (let index = 0; index < times; index += 1) {
          if (context.signal.aborted) throw new AgentToolError({ code: "CANCELLED", message: "Cancelled between key presses.", retryable: false, actionOutcome: "unknown" });
          await this.callTool("Shortcut", { shortcut: args.keys }, { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs });
        }
      }
      this.invalidateObservations(context.jobId);
      return `Pressed ${args.keys}${args.repeat && args.repeat > 1 ? ` x${args.repeat}` : ""}.`;
    });
  }

  async scroll(args: { observationId: string; target: { point?: { x: number; y: number }; elementRef?: string }; direction: "up" | "down" | "left" | "right"; amount?: number }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    const observation = this.getObservation(context.jobId, args.observationId);
    return await context.runExclusive(async () => {
      context.assertLease();
      await this.assertTargetStillValid(observation);
      const target = this.resolveTarget(observation, args.target);
      const type = args.direction === "left" || args.direction === "right" ? "horizontal" : "vertical";
      await this.callTool(
        "Scroll",
        { loc: [target.x, target.y], type, direction: args.direction, wheel_times: Math.min(args.amount ?? 3, 50) },
        { signal: context.signal, timeoutMs: this.deps.config.desktop.nativeToolTimeoutMs },
      );
      this.invalidateObservations(context.jobId);
      return `Scrolled ${type} ${args.direction} by ${args.amount ?? 3} at (${target.x},${target.y}).`;
    });
  }

  async listWindows(context: BrokerContext, includeMinimized = false): Promise<{ text: string; windows: ParsedWindow[] }> {
    await this.assertDesktopAvailable();
    return await context.runExclusive(async () => {
      context.assertLease();
      const { text } = await this.snapshot({}, { signal: context.signal, includeUiTree: false, useVision: false, annotate: false });
      const parsed = parseSnapshotText(text);
      const windows = includeMinimized ? [...parsed.windows, ...(parsed.focusedWindow ? [parsed.focusedWindow] : [])] : parsed.windows;
      const unique = new Map(windows.map((window) => [window.windowId, window]));
      for (const window of unique.values()) this.windowRegistry.set(window.windowId, window);
      const lines = [...unique.values()].map((window) => `${window.windowId} "${window.name}" ${window.width}x${window.height} status=${window.status}`);
      return { text: lines.join("\n") || "No windows found.", windows: [...unique.values()] };
    });
  }

  async app(args: { action: "launch" | "focus" | "move" | "resize" | "close"; executable?: string; args?: string[]; windowId?: string; bounds?: { x: number; y: number; width: number; height: number } }, context: BrokerContext): Promise<string> {
    await this.assertDesktopAvailable();
    return await context.runExclusive(async () => {
      context.assertLease();
      switch (args.action) {
        case "launch": {
          if (!args.executable) throw new AgentToolError({ code: "VALIDATION_ERROR", message: "executable is required for launch.", retryable: false, actionOutcome: "not_started" });
          const result = await this.callTool("App", { mode: "launch_executable", executable: args.executable, args: args.args ?? [] }, { signal: context.signal, timeoutMs: 30000 });
          this.invalidateObservations(context.jobId);
          return result.content.find((block) => block.type === "text")?.text ?? `Launched ${args.executable}.`;
        }
        case "focus": {
          if (!args.windowId) throw new AgentToolError({ code: "VALIDATION_ERROR", message: "windowId is required for focus.", retryable: false, actionOutcome: "not_started" });
          const window = this.windowRegistry.get(args.windowId);
          if (!window) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Unknown window ${args.windowId}. Call desktop_windows first.`, retryable: true, actionOutcome: "not_started" });
          try {
            await this.callTool("App", { mode: "switch", name: window.name }, { signal: context.signal, timeoutMs: 20000 });
          } catch (error) {
            throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Could not focus "${window.name}": ${(error as Error).message}`, retryable: true, actionOutcome: "not_started" });
          }
          this.invalidateObservations(context.jobId);
          return `Focused "${window.name}".`;
        }
        case "move":
        case "resize": {
          if (!args.windowId) throw new AgentToolError({ code: "VALIDATION_ERROR", message: "windowId is required for move/resize.", retryable: false, actionOutcome: "not_started" });
          const window = this.windowRegistry.get(args.windowId);
          if (!window) throw new AgentToolError({ code: "TARGET_NOT_FOUND", message: `Unknown window ${args.windowId}.`, retryable: true, actionOutcome: "not_started" });
          if (!args.bounds) throw new AgentToolError({ code: "VALIDATION_ERROR", message: "bounds are required for move/resize.", retryable: false, actionOutcome: "not_started" });
          const params: Record<string, unknown> = { mode: "resize", name: window.name, window_loc: [args.bounds.x, args.bounds.y] };
          if (args.action === "resize") params.window_size = [args.bounds.width, args.bounds.height];
          await this.callTool("App", params, { signal: context.signal, timeoutMs: 20000 });
          this.invalidateObservations(context.jobId);
          return `${args.action === "resize" ? "Resized" : "Moved"} "${window.name}".`;
        }
        case "close":
          throw new AgentToolError({ code: "NOT_IMPLEMENTED", message: "Closing arbitrary windows is not supported by the pinned backend. Use desktop_key alt+f4 on a focused window, or system_processes for a verified process.", retryable: false, actionOutcome: "not_started" });
      }
    });
  }

  async clipboard(args: { action: "read" | "write"; text?: string }, context: BrokerContext): Promise<string> {
    return await context.runExclusive(async () => {
      context.assertLease();
      if (args.action === "read") {
        const result = await this.callTool("Clipboard", { mode: "get" }, { signal: context.signal, timeoutMs: 10000 });
        const text = result.content.find((block) => block.type === "text")?.text ?? "";
        return `Clipboard: ${text}`;
      }
      if (args.text === undefined) throw new AgentToolError({ code: "VALIDATION_ERROR", message: "text is required for clipboard write.", retryable: false, actionOutcome: "not_started" });
      await this.callTool("Clipboard", { mode: "set", text: args.text }, { signal: context.signal, timeoutMs: 10000 });
      return "Clipboard updated.";
    });
  }

  async wait(args: { condition: "time" | "window" | "element"; ms?: number; windowId?: string; text?: string; timeoutMs?: number }, context: BrokerContext): Promise<string> {
    if (args.condition === "time") {
      const ms = Math.min(args.ms ?? 1000, 30000);
      await cancellableSleep(ms, context.signal);
      return `Waited ${ms}ms.`;
    }
    const timeoutMs = Math.min(args.timeoutMs ?? 10000, 120000);
    const windowName = args.windowId ? this.windowRegistry.get(args.windowId)?.name : undefined;
    const condition = args.condition === "window" ? "active_window" : "element_exists";
    const result = await this.callTool(
      "WaitFor",
      { condition, ...(windowName ? { window_name: windowName } : {}), ...(args.text ? { text: args.text } : {}), timeout: timeoutMs / 1000 },
      { signal: context.signal, timeoutMs: timeoutMs + 5000 },
    );
    return result.content.find((block) => block.type === "text")?.text ?? "Wait condition satisfied.";
  }

  private focusedOrCursorTarget(observation: Observation): { x: number; y: number; element?: ParsedElement } {
    const focused = [...observation.elements.values()].find((element) => element.focused);
    if (focused) return { x: focused.x, y: focused.y, element: focused };
    if (observation.cursor) return { x: observation.cursor.x, y: observation.cursor.y };
    throw new AgentToolError({ code: "VALIDATION_ERROR", message: "No target was provided and the observation has no focused element or cursor position.", retryable: false, actionOutcome: "not_started", observationId: observation.id });
  }

  /** Call the backend and convert error results into structured tool errors. */
  private async callTool(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError: boolean }> {
    const result = await this.deps.windows.mcp.callTool(tool, args, options);
    if (result.isError) {
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      throw new AgentToolError({ code: "BACKEND_ERROR", message: (text || `${tool} failed`).slice(0, 400), retryable: true, actionOutcome: "not_started" });
    }
    return result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError: boolean };
  }

  getObservationPublic(observationId: string): { artifactId: string } | undefined {
    const observation = this.observations.get(observationId);
    return observation ? { artifactId: observation.artifactId } : undefined;
  }
}

/** Window handles appear as decimal (backend tables) or hex (helper); compare numerically. */
function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.startsWith("0x")) return String(Number.parseInt(trimmed, 16));
  if (/^\d+$/.test(trimmed)) return trimmed;
  return trimmed;
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AgentToolError({ code: "CANCELLED", message: "Wait cancelled.", retryable: false, actionOutcome: "not_started" }));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function installDesktopTools(broker: ToolBroker, deps: DesktopToolDeps): DesktopTools {
  const tools = new DesktopTools(deps);
  broker.registerHandlers({
    desktop_observe: async (args, context) => {
      const parsed = args as { scope?: "desktop" | "window" | "region"; windowId?: string; region?: { x: number; y: number; width: number; height: number }; annotate?: boolean; includeUiTree?: boolean };
      const { observation, text, image } = await tools.observe(parsed, context, "model");
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: tools.buildObservationText(observation, text) },
      ];
      if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      return { content, details: { observationId: observation.id, artifactId: observation.artifactId, captureBounds: observation.captureBounds, imageSize: { width: observation.imageWidth, height: observation.imageHeight } } };
    },
    desktop_click: async (args, context) => ({ content: [{ type: "text", text: await tools.click(args as never, context) }], details: {} }),
    desktop_move: async (args, context) => ({ content: [{ type: "text", text: await tools.move(args as never, context) }], details: {} }),
    desktop_drag: async (args, context) => ({ content: [{ type: "text", text: await tools.drag(args as never, context) }], details: {} }),
    desktop_type: async (args, context) => ({ content: [{ type: "text", text: await tools.type(args as never, context) }], details: {} }),
    desktop_key: async (args, context) => ({ content: [{ type: "text", text: await tools.key(args as never, context) }], details: {} }),
    desktop_scroll: async (args, context) => ({ content: [{ type: "text", text: await tools.scroll(args as never, context) }], details: {} }),
    desktop_windows: async (args, context) => {
      const { text } = await tools.listWindows(context, (args as { includeMinimized?: boolean }).includeMinimized ?? false);
      return { content: [{ type: "text", text }], details: {} };
    },
    desktop_app: async (args, context) => ({ content: [{ type: "text", text: await tools.app(args as never, context) }], details: {} }),
    desktop_clipboard: async (args, context) => ({ content: [{ type: "text", text: await tools.clipboard(args as never, context) }], details: {} }),
    desktop_wait: async (args, context) => ({ content: [{ type: "text", text: await tools.wait(args as never, context) }], details: {} }),
  });
  return tools;
}
