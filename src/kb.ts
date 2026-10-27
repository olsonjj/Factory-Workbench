import * as path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { slugify } from "./frontmatter.js";
import type { FactoryPaths } from "./paths.js";

/**
 * Dated, append-only markdown knowledge base with global and per-project
 * layers. Agents author entries at three write-moments; this flow only ever
 * appends — no code path rewrites or removes existing content. Humans may
 * edit files directly; every read is fresh from disk.
 */

export type KbMoment = "failed-gate" | "post-rework" | "pr-outcome";

export function globalKbFile(p: FactoryPaths): string {
  return path.join(p.kb, "global.md");
}

export function repoSlug(repo: string): string {
  const lastSegment = repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
  return slugify(lastSegment);
}

export function projectKbFile(p: FactoryPaths, repo: string): string {
  return path.join(p.kb, "projects", `${repoSlug(repo)}.md`);
}

export function dateStamp(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One dated entry header + body. Append-only. */
export function appendEntry(kbFile: string, moment: KbMoment, scope: string, content: string): void {
  mkdirSync(path.dirname(kbFile), { recursive: true });
  const header = `## ${dateStamp()} — ${moment} (${scope})\n\n${content.trim()}\n\n`;
  appendFileSync(kbFile, header, "utf8");
}

export function readKbFile(kbFile: string, limitChars?: number): string {
  if (!existsSync(kbFile)) return "";
  const text = readFileSync(kbFile, "utf8");
  return limitChars === undefined || text.length <= limitChars ? text : text.slice(0, limitChars);
}

/**
 * Read the KB layers a consuming stage should see.
 * - triage gets the global layer lightly (truncated).
 * - spec/implement/review get global + project, in full.
 */
export function loadKbSnapshot(
  p: FactoryPaths,
  repo: string | undefined,
  opts: { lightweight?: boolean } = {},
): { global: string; project: string } {
  const globalLimit = opts.lightweight ? 2000 : undefined;
  // Triage is deliberately lightweight: global layer only, truncated; it also
  // never sees the project layer up front.
  return {
    global: readKbFile(globalKbFile(p), globalLimit),
    project: opts.lightweight ? "" : repo ? readKbFile(projectKbFile(p, repo)) : "",
  };
}