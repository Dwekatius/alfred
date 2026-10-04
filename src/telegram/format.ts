/**
 * Plain-text formatting helpers: Unicode-safe message splitting and captions.
 * Telegram limits: message text 4096 chars; media caption 1024 chars.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const DEFAULT_TEXT_TARGET = 3500;

/** Returns the largest index <= max that does not split a surrogate pair. */
function safeBoundary(text: string, max: number): number {
  if (max >= text.length) return text.length;
  let index = max;
  const code = text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) index -= 1; // low surrogate: back up before the pair
  return index;
}

function chooseSplitIndex(text: string, target: number): number {
  const boundary = safeBoundary(text, target);
  const window = text.slice(0, boundary);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > target * 0.5) return paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line > target * 0.5) return line + 1;
  const sentence = window.search(/[.!?][)\]"'\u201d\u2019]?\s[^\s]*$/u);
  if (sentence > target * 0.6) {
    const match = /[.!?][)\]"'\u201d\u2019]?\s/u.exec(window.slice(sentence));
    if (match) return sentence + match.index + match[0].length;
  }
  const space = window.lastIndexOf(" ");
  if (space > target * 0.4) return space + 1;
  return boundary;
}

/** Split long text into parts, preserving code points and preferring paragraph boundaries. */
export function splitMessage(text: string, target = DEFAULT_TEXT_TARGET, hardLimit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const limit = Math.min(target, hardLimit);
    if (remaining.length <= limit) {
      parts.push(remaining);
      break;
    }
    const index = chooseSplitIndex(remaining, limit);
    parts.push(remaining.slice(0, index).replace(/\s+$/u, ""));
    remaining = remaining.slice(index).replace(/^\s+/u, "");
  }
  return parts.filter((part) => part.length > 0);
}

export function withPartNumbering(parts: string[]): string[] {
  if (parts.length <= 1) return parts;
  const total = parts.length;
  return parts.map((part, index) => `[part ${index + 1}/${total}]\n${part}`);
}

export function caption(text: string, max = TELEGRAM_CAPTION_LIMIT): string {
  if (text.length <= max) return text;
  const boundary = safeBoundary(text, max - 1);
  return text.slice(0, boundary).replace(/\s+$/u, "") + "\u2026";
}

/** Short human label for a task, used in queue listings and captions. */
export function taskLabel(text: string, max = 60): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= max) return singleLine || "(empty task)";
  return singleLine.slice(0, safeBoundary(singleLine, max - 1)) + "\u2026";
}

export function nowInTimeZone(timeZone: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
