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
  if (limitChars === undefined || text.length <= limitChars) return text;
  return `<!-- older KB content elided (${text.length - limitChars} chars) -->\n\n${text.slice(-limitChars)}`;
}

/**
 * Split a KB layer into chunks of at most maxChars, ALWAYS at entry
 * boundaries ("## " headers). Chunks concatenate back to the original text
 * byte-for-byte. Only a single entry larger than the whole budget overhangs
 * (truncated with a marker, never silently dropped). Used by the KB curator:
 * stage prompts must stay bounded, but curation still has to inspect every
 * entry ever appended.
 */
export function chunkKbLayer(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length === 0 ? [] : [text];
  // Entry starts: offsets of "## " lines (plus offset 0 for any preamble).
  const starts: number[] = [0];
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    if (atLineStart && text[i] === "#" && text.startsWith("## ", i)) starts.push(i);
    atLineStart = text[i] === "\n";
  }
  const marker = (withheld: number): string => `\n<!-- oversized content truncated (${withheld} chars withheld from this batch) -->`;
  const chunks: string[] = [];
  let from = 0;
  for (let i = 1; i < starts.length; i++) {
    const start = starts[i]!;
    if (start - from < maxChars) continue;
    const piece = text.slice(from, start);
    chunks.push(piece.length > maxChars ? piece.slice(0, maxChars) + marker(piece.length - maxChars) : piece);
    from = start;
  }
  const tail = text.slice(from);
  chunks.push(tail.length > maxChars ? tail.slice(0, maxChars) + marker(tail.length - maxChars) : tail);
  return chunks;
}

/** Char budget for triage's lightweight global-KB-only view. */
export const KB_TRIAGE_LIGHT_LIMIT = 2000;

export interface KbLoadOptions {
  lightweight?: boolean;
  maxGlobalChars?: number;
  maxProjectChars?: number;
}

/**
 * Read the KB layers a consuming stage should see.
 * - triage gets the global layer lightly (tail-truncated).
 * - spec/implement/review get global + project, capped to the configured sizes.
 */
export function loadKbSnapshot(
  p: FactoryPaths,
  repo: string | undefined,
  opts: KbLoadOptions = {},
): { global: string; project: string } {
  const globalLimit = opts.lightweight ? KB_TRIAGE_LIGHT_LIMIT : opts.maxGlobalChars;
  const projectLimit = opts.maxProjectChars;
  // Triage is deliberately lightweight: global layer only, truncated; it also
  // never sees the project layer up front.
  return {
    global: readKbFile(globalKbFile(p), globalLimit),
    project: opts.lightweight ? "" : repo ? readKbFile(projectKbFile(p, repo), projectLimit) : "",
  };
}