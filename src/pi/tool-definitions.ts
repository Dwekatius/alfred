/**
 * Broker tool catalog. The same schemas are used by the Pi worker to declare
 * tools and by the supervisor broker to re-validate every tool request.
 */
import { Type, type TSchema } from "typebox";

export interface TargetPoint {
  x: number;
  y: number;
}

export interface ElementRef {
  elementRef: string;
}

export type ObservedTarget = ({ point: TargetPoint } | { elementRef: string }) & { observationId: string };

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  promptSnippet?: string;
  /** Desktop input tools are strictly sequential. */
  sequential: boolean;
  /** Read-only tools may run while a job is paused; mutating tools wait. */
  readOnly?: boolean;
}

const observationId = Type.String({ minLength: 1 });
const pointSchema = Type.Object({ x: Type.Number(), y: Type.Number() });
const elementOrPoint = Type.Union([
  Type.Object({ elementRef: Type.String({ minLength: 1 }) }),
  Type.Object({ point: pointSchema }),
]);

const observationOptions = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("window"), Type.Literal("region")])),
  windowId: Type.Optional(Type.String({ minLength: 1 })),
  region: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) })),
  annotate: Type.Optional(Type.Boolean()),
  includeUiTree: Type.Optional(Type.Boolean()),
});

const readinessOptions = Type.Object({
  condition: Type.Union([Type.Literal("window"), Type.Literal("element")]),
  windowId: Type.Optional(Type.String({ minLength: 1 })),
  text: Type.Optional(Type.String({ minLength: 1 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
  pollIntervalMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 1000 })),
});

const afterActionFields = {
  observeAfter: Type.Optional(Type.Boolean({ description: "Default true: return a fresh observation immediately. False skips verification; observe before acting again." })),
  observation: Type.Optional(observationOptions),
  waitFor: Type.Optional(readinessOptions),
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "desktop_observe",
    label: "Observe desktop",
    description:
      "Capture the current desktop, focused window, or a region. Returns an observationId, an image for vision, window/monitor metadata, and image-to-screen coordinate transforms. Always observe before acting.",
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("window"), Type.Literal("region")])),
      windowId: Type.Optional(Type.String({ minLength: 1 })),
      region: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) })),
      annotate: Type.Optional(Type.Boolean()),
      includeUiTree: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Capture desktop/window state and coordinates.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "desktop_click",
    label: "Click",
    description: "Click one observed element or point using a fresh observationId. Returns the new screen and observationId in the SAME call. Optional waitFor waits only until a named window/element is ready. Do not call desktop_observe again when this result already contains the needed state.",
    parameters: Type.Object({
      observationId,
      target: elementOrPoint,
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      ...afterActionFields,
    }),
    promptSnippet: "Click an observed element/point.",
    sequential: true,
  },
  {
    name: "desktop_move",
    label: "Move pointer",
    description: "Move the real mouse pointer to an observed element or point with an optional short visible motion.",
    parameters: Type.Object({
      observationId,
      target: elementOrPoint,
      durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3000 })),
      ...afterActionFields,
    }),
    promptSnippet: "Move the mouse pointer to an observed target.",
    sequential: true,
  },
  {
    name: "desktop_drag",
    label: "Drag",
    description: "Drag between two observed elements/points. The mouse button is always released, including on cancellation.",
    parameters: Type.Object({
      observationId,
      from: elementOrPoint,
      to: elementOrPoint,
      durationMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 5000 })),
      ...afterActionFields,
    }),
    promptSnippet: "Drag between observed targets.",
    sequential: true,
  },
  {
    name: "desktop_type",
    label: "Type text",
    description: "Type Unicode text into an observed target. mode=replace selects existing text first; mode=append keeps it. Returns a fresh screen and observationId in the same call. Never submits with Enter.",
    parameters: Type.Object({
      observationId,
      target: Type.Optional(elementOrPoint),
      text: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
      ...afterActionFields,
    }),
    promptSnippet: "Type text into an observed control.",
    sequential: true,
  },
  {
    name: "desktop_key",
    label: "Press keys",
    description: "Press a validated key or shortcut such as 'enter', 'ctrl+s', or 'alt+f4'. Optional holdMs for key-down length; always released.",
    parameters: Type.Object({
      keys: Type.String({ minLength: 1 }),
      observationId: Type.Optional(observationId),
      holdMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      ...afterActionFields,
    }),
    promptSnippet: "Press a key or shortcut.",
    sequential: true,
  },
  {
    name: "desktop_scroll",
    label: "Scroll",
    description: "Scroll at an observed target in a validated direction with a bounded amount.",
    parameters: Type.Object({
      observationId,
      target: elementOrPoint,
      direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
      amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      ...afterActionFields,
    }),
    promptSnippet: "Scroll an observed area.",
    sequential: true,
  },
  {
    name: "desktop_windows",
    label: "List windows",
    description: "Enumerate normal top-level windows with opaque window IDs, titles, and process metadata.",
    parameters: Type.Object({
      includeMinimized: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "List open windows.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "desktop_app",
    label: "Manage application windows",
    description: "Launch a known executable, focus a window by opaque ID, or move/resize a window. Returns a fresh screen in the same call. For launch, set waitFor to a window/element name so verification waits for readiness without a fixed sleep.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("launch"), Type.Literal("focus"), Type.Literal("move"), Type.Literal("resize"), Type.Literal("close")]),
      executable: Type.Optional(Type.String({ minLength: 1 })),
      args: Type.Optional(Type.Array(Type.String())),
      windowId: Type.Optional(Type.String({ minLength: 1 })),
      bounds: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) })),
      ...afterActionFields,
    }),
    promptSnippet: "Launch/focus/move windows.",
    sequential: true,
  },
  {
    name: "desktop_clipboard",
    label: "Clipboard",
    description: "Read or write plain text on the clipboard. Prefer typing; use the clipboard only when the target requires paste.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      text: Type.Optional(Type.String()),
    }),
    promptSnippet: "Read/write clipboard text.",
    sequential: true,
  },
  {
    name: "desktop_wait",
    label: "Wait",
    description: "Prefer condition=window with a title in text (or known windowId), or condition=element with text. Polls without screenshots and returns as soon as ready, followed by a fresh observation. Use condition=time with explicit ms only when no readiness condition is available. Cancellable and bounded.",
    parameters: Type.Object({
      condition: Type.Union([Type.Literal("time"), Type.Literal("window"), Type.Literal("element")]),
      ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
      windowId: Type.Optional(Type.String({ minLength: 1 })),
      text: Type.Optional(Type.String({ minLength: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
      pollIntervalMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 1000 })),
      observeAfter: Type.Optional(Type.Boolean()),
      observation: Type.Optional(observationOptions),
    }),
    promptSnippet: "Wait for a bounded condition.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "system_read",
    label: "Read file",
    description: "Read a bounded range of a local file. Returns text with an explicit truncation marker.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    }),
    promptSnippet: "Read a local file.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "system_list",
    label: "List directory",
    description: "List a local directory with names, sizes, and types.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      pattern: Type.Optional(Type.String()),
    }),
    promptSnippet: "List a directory.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "system_write",
    label: "Write file",
    description: "Create or atomically replace a file with explicit encoding. Refuses to overwrite unless overwrite=true.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("utf16le")])),
      overwrite: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Write a file atomically.",
    sequential: true,
  },
  {
    name: "system_edit",
    label: "Edit file",
    description: "Replace exact text in a file; fails when the old text is missing or ambiguous unless replaceAll=true.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String(),
      replaceAll: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Edit a file by exact replacement.",
    sequential: true,
  },
  {
    name: "system_move",
    label: "Move file",
    description: "Move a file or directory to an absolute target path.",
    parameters: Type.Object({
      source: Type.String({ minLength: 1 }),
      target: Type.String({ minLength: 1 }),
      overwrite: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Move a file/directory.",
    sequential: true,
  },
  {
    name: "system_copy",
    label: "Copy file",
    description: "Copy a file or directory to an absolute target path.",
    parameters: Type.Object({
      source: Type.String({ minLength: 1 }),
      target: Type.String({ minLength: 1 }),
      overwrite: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Copy a file/directory.",
    sequential: true,
  },
  {
    name: "system_delete",
    label: "Delete file",
    description: "Delete a file or directory. Prefer the recycle bin; recursive delete requires recursive=true and a checked path.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      recursive: Type.Optional(Type.Boolean()),
      useRecycleBin: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Delete a file/directory (reversible when possible).",
    sequential: true,
  },
  {
    name: "system_exec",
    label: "Run PowerShell",
    description: "Run a tracked PowerShell command with a working directory, finite timeout, output cap, and cancellation. Long-lived GUIs are launched with desktop_app, not this tool.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String({ minLength: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 500, maximum: 600000 })),
    }),
    promptSnippet: "Run a tracked PowerShell command.",
    sequential: true,
  },
  {
    name: "system_processes",
    label: "Inspect processes",
    description: "List processes, or terminate exactly one precisely identified process when terminate=true and pid matches.",
    parameters: Type.Object({
      filter: Type.Optional(Type.String()),
      terminate: Type.Optional(Type.Boolean()),
      pid: Type.Optional(Type.Integer({ minimum: 1 })),
      expectedName: Type.Optional(Type.String()),
      force: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Inspect or terminate a process.",
    sequential: true,
  },
  {
    name: "artifact_read_image",
    label: "Retrieve saved image",
    description: "Read a registered image by artifactId from this owner's conversation. Use when an image from a previous task is needed again. Returns the original image; it is historical evidence, not a fresh desktop observation.",
    parameters: Type.Object({ artifactId: Type.String({ minLength: 1 }) }),
    sequential: true,
    readOnly: true,
  },
  {
    name: "telegram_send_image",
    label: "Send image",
    description: "Send a registered image artifact to the owner's private chat as a photo, or as an exact document when exact=true.",
    parameters: Type.Object({
      artifactId: Type.String({ minLength: 1 }),
      caption: Type.Optional(Type.String({ maxLength: 1000 })),
      exact: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Send an image to the owner.",
    sequential: true,
  },
  {
    name: "telegram_send_file",
    label: "Send file",
    description: "Send a registered document artifact to the owner's private chat.",
    parameters: Type.Object({
      artifactId: Type.String({ minLength: 1 }),
      caption: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    promptSnippet: "Send a file to the owner.",
    sequential: true,
  },
  {
    name: "telegram_notify",
    label: "Notify owner",
    description: "Send a short progress update or clarification to the owner's chat. Throttled; do not use for every step.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 3500 }),
    }),
    promptSnippet: "Send a progress update to the owner.",
    sequential: false,
  },
  {
    name: "request_owner_input",
    label: "Ask owner",
    description: "Ask the owner one concrete question and wait for the answer. The desktop lease is released while waiting.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 1000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 6 })),
    }),
    promptSnippet: "Ask the owner a question and wait.",
    sequential: true,
  },
  // ------------------------------------------------------------ browser tools
  {
    name: "browser_navigate",
    label: "Navigate",
    description: "Navigate the visible Chrome page to a URL. Brings Chrome to the foreground. Navigation invalidates previous element references.",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
    promptSnippet: "Navigate the visible browser.",
    sequential: true,
  },
  {
    name: "browser_navigate_back",
    label: "Back",
    description: "Go back in the visible browser history.",
    parameters: Type.Object({}),
    sequential: true,
  },
  {
    name: "browser_snapshot",
    label: "Page snapshot",
    description: "Accessibility snapshot of the current page with element references. Prefer this over screenshots for structured content.",
    parameters: Type.Object({
      target: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Integer({ minimum: 1 })),
      boxes: Type.Optional(Type.Boolean()),
      filename: Type.Optional(Type.String()),
    }),
    promptSnippet: "Read the visible page structure.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "browser_click",
    label: "Browser click",
    description: "Click an element on the page. Pass the exact element reference from the most recent snapshot and a short description.",
    parameters: Type.Object({
      element: Type.String({ minLength: 1 }),
      target: Type.String({ minLength: 1 }),
      doubleClick: Type.Optional(Type.Boolean()),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
      modifiers: Type.Optional(Type.Array(Type.String())),
    }),
    promptSnippet: "Click a page element reference.",
    sequential: true,
  },
  {
    name: "browser_type",
    label: "Browser type",
    description: "Type text into a page element. Set submit=true to press Enter after typing; slowly=true types character by character.",
    parameters: Type.Object({
      element: Type.String({ minLength: 1 }),
      target: Type.String({ minLength: 1 }),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
      slowly: Type.Optional(Type.Boolean()),
    }),
    promptSnippet: "Type into a page element.",
    sequential: true,
  },
  {
    name: "browser_fill_form",
    label: "Fill form",
    description: "Fill multiple form fields at once. Each field names its element reference and value.",
    parameters: Type.Object({
      fields: Type.Array(
        Type.Object({
          name: Type.String(),
          target: Type.String(),
          type: Type.Union([Type.Literal("textbox"), Type.Literal("checkbox"), Type.Literal("radio"), Type.Literal("combobox"), Type.Literal("slider")]),
          value: Type.String(),
          element: Type.Optional(Type.String()),
        }),
        { minItems: 1 },
      ),
    }),
    promptSnippet: "Fill several form fields.",
    sequential: true,
  },
  {
    name: "browser_press_key",
    label: "Page key",
    description: "Press a key in the browser, such as ArrowLeft or Enter.",
    parameters: Type.Object({ key: Type.String({ minLength: 1 }) }),
    promptSnippet: "Press a key in the browser.",
    sequential: true,
  },
  {
    name: "browser_hover",
    label: "Browser hover",
    description: "Hover over an element on the page.",
    parameters: Type.Object({ element: Type.String({ minLength: 1 }), target: Type.String({ minLength: 1 }) }),
    sequential: true,
  },
  {
    name: "browser_select_option",
    label: "Select option",
    description: "Select one or more options in a page dropdown.",
    parameters: Type.Object({ element: Type.String({ minLength: 1 }), target: Type.String({ minLength: 1 }), values: Type.Array(Type.String(), { minItems: 1 }) }),
    sequential: true,
  },
  {
    name: "browser_drag",
    label: "Browser drag",
    description: "Drag and drop between two page elements.",
    parameters: Type.Object({
      startElement: Type.String({ minLength: 1 }),
      startTarget: Type.String({ minLength: 1 }),
      endElement: Type.String({ minLength: 1 }),
      endTarget: Type.String({ minLength: 1 }),
    }),
    sequential: true,
  },
  {
    name: "browser_take_screenshot",
    label: "Page screenshot",
    description: "Take a page screenshot. fullPage captures beyond the viewport; element captures one element. Returns image content and a registered artifact.",
    parameters: Type.Object({
      element: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      type: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
      filename: Type.Optional(Type.String()),
      fullPage: Type.Optional(Type.Boolean()),
      scale: Type.Optional(Type.Union([Type.Literal("css"), Type.Literal("device")])),
    }),
    promptSnippet: "Screenshot the page.",
    sequential: true,
  },
  {
    name: "browser_tabs",
    label: "Tabs",
    description: "List, create, close, or select browser tabs. The selected tab must be the one you act on.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("close"), Type.Literal("select")]),
      index: Type.Optional(Type.Integer({ minimum: 0 })),
      url: Type.Optional(Type.String()),
    }),
    promptSnippet: "Manage browser tabs.",
    sequential: true,
  },
  {
    name: "browser_wait_for",
    label: "Wait for page",
    description: "Wait for text to appear or disappear, or wait a bounded number of seconds.",
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      textGone: Type.Optional(Type.String()),
      time: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
    }),
    promptSnippet: "Wait for page state.",
    sequential: true,
    readOnly: true,
  },
  {
    name: "browser_handle_dialog",
    label: "Handle dialog",
    description: "Accept or dismiss a browser dialog such as alert, confirm, or prompt.",
    parameters: Type.Object({ accept: Type.Boolean(), promptText: Type.Optional(Type.String()) }),
    sequential: true,
  },
  {
    name: "browser_file_upload",
    label: "Upload files",
    description: "Upload one or more local files to a file chooser. Paths must be absolute and outside protected agent state.",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String(), { minItems: 1 })) }),
    sequential: true,
  },
  {
    name: "browser_console_messages",
    label: "Console messages",
    description: "Read browser console messages, optionally filtered by level.",
    parameters: Type.Object({ level: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()), filename: Type.Optional(Type.String()) }),
    sequential: true,
    readOnly: true,
  },
  {
    name: "browser_network_requests",
    label: "Network requests",
    description: "List network requests made by the page since loading.",
    parameters: Type.Object({ static: Type.Optional(Type.Boolean()), filter: Type.Optional(Type.String()), filename: Type.Optional(Type.String()) }),
    sequential: true,
    readOnly: true,
  },
  {
    name: "browser_network_request",
    label: "Network request detail",
    description: "Get full details for one network request by index.",
    parameters: Type.Object({ index: Type.Integer({ minimum: 1 }), part: Type.Optional(Type.String()), filename: Type.Optional(Type.String()) }),
    sequential: true,
    readOnly: true,
  },
  {
    name: "browser_evaluate",
    label: "Evaluate JS",
    description: "Run a JavaScript function on the page or element. Brokered and logged; use only when DOM-based tools cannot do the job.",
    parameters: Type.Object({
      function: Type.String({ minLength: 1 }),
      element: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
    }),
    sequential: true,
  },
  {
    name: "browser_pdf_save",
    label: "Save page PDF",
    description: "Save the current page as a PDF artifact in the browser output directory.",
    parameters: Type.Object({ filename: Type.Optional(Type.String()) }),
    sequential: true,
  },
  {
    name: "browser_resize",
    label: "Resize window",
    description: "Resize the visible browser window.",
    parameters: Type.Object({ width: Type.Integer({ minimum: 200 }), height: Type.Integer({ minimum: 200 }), }),
    sequential: true,
  },
  {
    name: "browser_find",
    label: "Find on page",
    description: "Search the page accessibility snapshot for text or a regular expression.",
    parameters: Type.Object({ text: Type.Optional(Type.String()), regex: Type.Optional(Type.String()), filename: Type.Optional(Type.String()) }),
    sequential: true,
    readOnly: true,
  },
  {
    name: "browser_close",
    label: "Close browser",
    description: "Close the current browser page.",
    parameters: Type.Object({}),
    sequential: true,
  },
  // Fake tools used by tests and dry-run/self-check. Harmless and text-only.
  {
    name: "fake_echo",
    label: "Echo (test)",
    description: "Test tool: returns the provided text unchanged. Harmless.",
    parameters: Type.Object({ text: Type.String() }),
    sequential: true,
    readOnly: true,
  },
  {
    name: "fake_image",
    label: "Image (test)",
    description: "Test tool: returns a generated test image with a visible code. Harmless.",
    parameters: Type.Object({ code: Type.Optional(Type.String({ maxLength: 40 })) }),
    sequential: true,
    readOnly: true,
  },
];

export function toolSpecByName(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.name === name);
}

export function sequentialToolNames(): string[] {
  return TOOL_SPECS.filter((spec) => spec.sequential).map((spec) => spec.name);
}

/** Tools exposed in production; fake tools are only exposed when explicitly enabled. */
export function productionToolNames(): string[] {
  return TOOL_SPECS.filter((spec) => !spec.name.startsWith("fake_")).map((spec) => spec.name);
}
