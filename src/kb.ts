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

/** One compact line per entry: `date — scope | first prose line | batch i/N`.
 * Cross-batch digest for the KB curator (ticket 10): when a layer's full text
 * exceeds the prompt budget, this still fits (one short line per entry), so
 * every batch sees all entries lossily and can flag cross-batch findings. */
export interface KbDigestIndex {
  /** One line per entry; if the whole index exceeded `maxChars`, it is cut and
   * a trailing marker records the withheld chars. */
  text: string;
  /** True when `text` was cut to fit `maxChars`. */
  truncated: boolean;
}

const INDEX_PROSE_LIMIT = 100;

/** First prose line of an entry body: skips blanks, code fences, HTML comments
 * and headings; bounded to INDEX_PROSE_LIMIT chars. */
function firstProseLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("```") && !l.startsWith("<!--") && !l.startsWith("#")) ?? "";
  return line.length > INDEX_PROSE_LIMIT ? `${line.slice(0, INDEX_PROSE_LIMIT - 1)}…` : line;
}

/** Split one chunk into entries. Chunks begin at entry boundaries, so every
 * `## ` header inside a chunk starts an entry; text before the first header is
 * preamble and skipped. */
function splitChunkEntries(chunk: string): { header: string; body: string }[] {
  const entries: { header: string; body: string }[] = [];
  for (const part of chunk.split(/\n(?=## )/)) {
    const nl = part.indexOf("\n");
    const header = nl < 0 ? part : part.slice(0, nl);
    if (!header.startsWith("## ")) continue;
    entries.push({ header, body: nl < 0 ? "" : part.slice(nl + 1) });
  }
  return entries;
}

/**
 * Build the cross-batch digest index for one KB layer. `totalBatches` is the
 * unified curator-invocation count (max of both layers' chunk counts); when
 * omitted, the layer's own chunk count is the denominator. The result is
 * always bounded: at most `maxChars` plus a short truncation marker, so index
 * construction can never unbound a curator prompt.
 */
export function kbDigestIndex(text: string, maxChars: number, totalBatches?: number): KbDigestIndex {
  const chunks = chunkKbLayer(text, maxChars);
  const batches = totalBatches ?? Math.max(chunks.length, 1);
  const lines: string[] = [];
  chunks.forEach((chunk, i) => {
    for (const e of splitChunkEntries(chunk)) {
      const head = e.header.replace(/^##\s+/, "").trim();
      const sep = head.indexOf(" — ");
      const date = sep >= 0 ? head.slice(0, sep) : "";
      const scope = sep >= 0 ? head.slice(sep + 3) : head;
      lines.push(`${date} — ${scope} | ${firstProseLine(e.body)} | batch ${i + 1}/${batches}`);
    }
  });
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return { text: joined, truncated: false };
  const withheld = joined.length - maxChars;
  return { text: `${joined.slice(0, maxChars)}\n<!-- digest index truncated (${withheld} chars withheld) -->`, truncated: true };
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