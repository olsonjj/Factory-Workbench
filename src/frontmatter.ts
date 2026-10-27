import matter from "gray-matter";
import { APPROVAL_STAGES, type StageName } from "./types.js";

export interface ParsedItem {
  title: string;
  repo: string;
  base: string;
  approvals: StageName[];
  body: string;
  /** Extra unparsed front-matter keys, preserved verbatim. */
  extra: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; item: ParsedItem }
  | { ok: false; reason: string };

/** Lowercase, keep [a-z0-9-], no leading/trailing dashes, no double dashes. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64) || "item";
}

export function isStageName(v: unknown): v is StageName {
  return typeof v === "string" && (APPROVAL_STAGES as readonly string[]).includes(v);
}

/**
 * Parse and validate an inbox markdown work item. Bad front-matter yields a
 * human-readable reason — never a throw — so a malformed item can be parked.
 */
export function parseItemMarkdown(raw: string): ParseResult {
  let fm: { data: Record<string, unknown>; content: string };
  try {
    const m = matter(raw);
    fm = { data: m.data as Record<string, unknown>, content: m.content };
  } catch {
    return { ok: false, reason: "front-matter is not valid YAML" };
  }
  const { data } = fm;

  if (typeof data.title !== "string" || data.title.trim().length === 0) {
    return { ok: false, reason: "front-matter must include a non-empty `title`" };
  }
  if (typeof data.repo !== "string" || data.repo.trim().length === 0) {
    return { ok: false, reason: "front-matter must include a non-empty `repo` (target repository)" };
  }
  const base = typeof data.base === "string" && data.base.trim().length > 0 ? data.base.trim() : "main";

  let approvals: StageName[] = [];
  if (data.approvals !== undefined) {
    if (!Array.isArray(data.approvals) || data.approvals.some((a) => !isStageName(a))) {
      const allowed = APPROVAL_STAGES.join(", ");
      return { ok: false, reason: "`approvals` must be a list of stage names: " + allowed };
    }
    approvals = data.approvals as StageName[];
  }

  const extra: Record<string, unknown> = { ...data };
  delete extra.title;
  delete extra.repo;
  delete extra.base;
  delete extra.approvals;

  return {
    ok: true,
    item: {
      title: data.title.trim(),
      repo: data.repo.trim(),
      base,
      approvals,
      body: fm.content.trim(),
      extra,
    },
  };
}

export interface ItemDraft {
  title: string;
  repo: string;
  base: string;
  approvals: StageName[];
  body: string;
}

/**
 * Slug for a work item authored from a title. Applied twice so the result is
 * a fixed point of slugify(); scanInbox re-derives slugify(basename) and must
 * arrive at the identical value (see §6).
 */
export function slugForTitle(title: string): string {
  return slugify(slugify(title));
}

export function parseApprovalsInput(raw: string):
  | { ok: true; approvals: StageName[] }
  | { ok: false; reason: string } {
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: true, approvals: [] };
  const seen = new Set<StageName>();
  const approvals: StageName[] = [];
  for (const token of tokens) {
    if (!isStageName(token)) {
      return {
        ok: false,
        reason: `unknown approval stage "${token}" (allowed: ${APPROVAL_STAGES.join(", ")})`,
      };
    }
    if (!seen.has(token)) { seen.add(token); approvals.push(token); }
  }
  return { ok: true, approvals };
}

/** Serialize a draft to markdown via gray-matter (same lib that parses). */
export function serializeItemMarkdown(draft: ItemDraft): string {
  const data = {
    title: draft.title,
    repo: draft.repo,
    base: draft.base,
    approvals: draft.approvals,
  };
  return matter.stringify(draft.body, data as Record<string, unknown>);
}

export type DraftValidation =
  | { ok: true; markdown: string; parsed: ParsedItem }
  | { ok: false; reason: string };

/** Reuse the existing parser to prove the bytes we will write are valid. */
export function validateItemDraft(draft: ItemDraft): DraftValidation {
  const markdown = serializeItemMarkdown(draft);
  const parsed = parseItemMarkdown(markdown);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const p = parsed.item;
  if (
    p.title !== draft.title ||
    p.repo !== draft.repo ||
    p.base !== draft.base ||
    p.approvals.length !== draft.approvals.length ||
    p.approvals.some((a, i) => a !== draft.approvals[i])
  ) {
    return { ok: false, reason: "serialized item did not round-trip through front-matter parsing" };
  }
  return { ok: true, markdown, parsed: p };
}

export const ITEM_TEMPLATE = `---
title: Implement the thing
repo: /path/to/target/repo
base: main
approvals: []   # stages that stop for human approval, e.g. [spec, review]
---

Describe the task here. The description is the item's source of truth.
`;