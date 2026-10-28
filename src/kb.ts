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
 * boundaries ("## " headers). Chunks contain whole entries and concatenate
 * back to the original text byte-for-byte, except that a single entry larger
 * than the whole budget is sliced at the budget (truncated with a marker,
 * never silently dropped, and that withheld region belongs to no other
 * chunk). Used by the KB curator: stage prompts must stay bounded, but
 * curation still has to inspect every entry ever appended.
 */
export function chunkKbLayerWithOffsets(text: string, maxChars: number): { text: string; from: number }[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [{ text, from: 0 }];
  // Entry starts: offsets of "## " lines (plus offset 0 for any preamble).
  const starts: number[] = [0];
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    if (atLineStart && text[i] === "#" && text.startsWith("## ", i)) starts.push(i);
    atLineStart = text[i] === "\n";
  }
  const pieces: { from: number; to: number }[] = [];
  for (let i = 0; i < starts.length; i++) {
    pieces.push({ from: starts[i]!, to: i + 1 < starts.length ? starts[i + 1]! : text.length });
  }
  const marker = (withheld: number): string => `\n<!-- oversized content truncated (${withheld} chars withheld from this batch) -->`;
  const chunks: { text: string; from: number }[] = [];
  // Accumulate whole entries: a piece that would push the open chunk past the
  // budget starts a new chunk instead of being cut (the old implementation
  // sliced at maxChars mid-entry, silently withholding that entry's tail
  // from EVERY batch — found by Greptile review on PR #6).
  const emit = (piece: { from: number; to: number }): void => {
    const t = text.slice(piece.from, piece.to);
    chunks.push({ text: t.length > maxChars ? t.slice(0, maxChars) + marker(t.length - maxChars) : t, from: piece.from });
  };
  let cur: { from: number; to: number } | null = null;
  for (const piece of pieces) {
    const len = piece.to - piece.from;
    if (len > maxChars) {
      if (cur && cur.to > cur.from) { emit(cur); cur = null; } // skip empty preambles
      emit(piece); // a single entry larger than the whole budget: sliced, alone
      continue;
    }
    if (cur && piece.to - cur.from <= maxChars) { cur = { from: cur.from, to: piece.to }; continue; }
    if (cur && cur.to > cur.from) emit(cur);
    cur = piece;
  }
  if (cur && cur.to > cur.from) emit(cur);
  return chunks;
}

export function chunkKbLayer(text: string, maxChars: number): string[] {
  return chunkKbLayerWithOffsets(text, maxChars).map((c) => c.text);
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

/** First prose line of an entry body: skips blanks, headings, code fences
 * (including their contents) and HTML comments (including multiline ones);
 * bounded to INDEX_PROSE_LIMIT chars. "Inside a fence" means between an open
 * and a close ``` line, and "inside a comment" means between an unterminated
 * `<!--` line and a `-->` line — content there is an artifact of recording,
 * not a lesson. */
function firstProseLine(body: string): string {
  let inFence = false;
  let inComment = false;
  for (const raw of body.split("\n")) {
    const l = raw.trim();
    if (inComment) {
      if (l.includes("-->")) inComment = false;
      continue;
    }
    if (inFence) {
      if (l.startsWith("```")) inFence = false;
      continue;
    }
    if (!l || l.startsWith("#")) continue;
    if (l.startsWith("```")) { inFence = true; continue; }
    if (l.includes("<!--")) {
      if (l.includes("-->")) continue; // single-line comment: skip the line
      inComment = true;
      continue;
    }
    return l.length > INDEX_PROSE_LIMIT ? `${l.slice(0, INDEX_PROSE_LIMIT - 1)}…` : l;
  }
  return "";
}

/**
 * Build the cross-batch digest index for one KB layer. `totalBatches` is the
 * unified curator-invocation count (max of both layers' chunk counts); when
 * omitted, the layer's own chunk count is the denominator. The result is
 * always bounded: at most `maxChars` plus a short truncation marker, so index
 * construction can never unbound a curator prompt.
 *
 * Entries are parsed from the ORIGINAL full text (never the budget-sliced
 * chunks: a straddled entry's lesson must survive even when its chunk was cut
 * — Greptile review, PR #6). Chunk offsets are used only to assign batch
 * numbers: an entry's header offset falls in exactly one chunk span.
 */
export function kbDigestIndex(text: string, maxChars: number, totalBatches?: number): KbDigestIndex {
  const chunked = chunkKbLayerWithOffsets(text, maxChars);
  const batches = totalBatches ?? Math.max(chunked.length, 1);
  // Chunk i spans [from_i, from_{i+1}) — offsets stay contiguous (markers live
  // inside a chunk's text, never between spans), so every entry start lands in
  // exactly one span.
  const batchOf = (entryStart: number): number => {
    for (let i = 0; i < chunked.length; i++) {
      const to = i + 1 < chunked.length ? chunked[i + 1]!.from : text.length;
      if (entryStart >= chunked[i]!.from && entryStart < to) return i + 1;
    }
    return batches;
  };
  // Entry spans from the ORIGINAL text: start of each "## " line to the next.
  const starts: number[] = [];
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    if (atLineStart && text[i] === "#" && text.startsWith("## ", i)) starts.push(i);
    atLineStart = text[i] === "\n";
  }
  const lines: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : text.length;
    const nl = text.indexOf("\n", from);
    const header = (nl < 0 || nl > to ? text.slice(from, to) : text.slice(from, nl)).replace(/^##\s+/, "").trim();
    const body = nl < 0 || nl > to ? "" : text.slice(nl + 1, to);
    const sep = header.indexOf(" — ");
    const date = sep >= 0 ? header.slice(0, sep) : "";
    const scope = sep >= 0 ? header.slice(sep + 3) : header;
    lines.push(`${date} — ${scope} | ${firstProseLine(body)} | batch ${batchOf(from)}/${batches}`);
  }
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