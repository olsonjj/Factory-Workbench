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

export const ITEM_TEMPLATE = `---
title: Implement the thing
repo: /path/to/target/repo
base: main
approvals: []   # stages that stop for human approval, e.g. [spec, review]
---

Describe the task here. The description is the item's source of truth.
`;