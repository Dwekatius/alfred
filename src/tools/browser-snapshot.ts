import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Pinned Playwright writes automatic action snapshots to .yml files and returns
 * a link. Inline that SAME evidence so no extra snapshot/model turn is needed.
 * Only read bounded snapshot files inside the configured output directory.
 */
export function inlineBrowserSnapshot(text: string, outputDir: string, cwd: string, maxBytes = 60000): { text: string; expanded: boolean } {
  let expanded = false;
  const projected = text.replace(/(### Snapshot\s*\n)(?:-\s*)?\[([^\]\n]+)\]\(([^)\n]+\.yml)\)/g, (original, heading: string, label: string, link: string) => {
    let fd: number | undefined;
    try {
      const decoded = decodeURIComponent(link);
      // Only local filesystem paths; never follow URLs from tool text.
      if (/^[a-z]+:\/\//i.test(decoded)) return original;
      const path = isAbsolute(decoded) ? decoded : resolve(/[\\/]/.test(decoded) ? cwd : outputDir, decoded);
      if (!existsSync(path)) return original;
      const real = realpathSync(path);
      const root = realpathSync(outputDir);
      if (!real.toLowerCase().startsWith((root + sep).toLowerCase())) return original;
      const stat = statSync(real);
      if (!stat.isFile()) return original;
      fd = openSync(real, "r");
      const bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const snapshot = bytes.subarray(0, length).toString("utf8");
      expanded = true;
      return `${heading}[${label}](${link})\n${snapshot}${stat.size > maxBytes ? "\n[snapshot truncated; request browser_snapshot for the needed part]" : ""}`;
    } catch {
      // Keep the original link; the explicit snapshot tool is always available.
      return original;
    } finally { if (fd !== undefined) closeSync(fd); }
  });
  return { text: projected, expanded };
}
