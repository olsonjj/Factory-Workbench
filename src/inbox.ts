import * as path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { parseItemMarkdown, slugify } from "./frontmatter.js";
import type { FactoryDb } from "./db.js";
import type { FactoryPaths } from "./paths.js";
import { itemDir, itemFile } from "./paths.js";
import type { ItemRecord } from "./types.js";

/** Sorted list of claim-candidate markdown files in the inbox. Shared by
 *  `scanInbox` (mutating) and `wb status`'s read-only preview so the two
 *  iterate the inbox identically. */
export function listInboxFiles(inboxDir: string): string[] {
  return readdirSync(inboxDir).filter((f) => f.toLowerCase().endsWith(".md")).sort();
}

/** Whether an item found at a claimed slug blocks a new claim. The single
 *  source of truth shared by `scanInbox` (mutating) and `wb status`'s
 *  read-only inbox preview — they must never diverge. Type-guard so callers
 *  get narrowing. */
export function claimBlocked(existing: ItemRecord | undefined): existing is ItemRecord {
  return existing !== undefined && existing.status !== "rejected";
}

export interface InboxReport {
  claimed: { slug: string; file: string }[];
  malformed: { slug: string; file: string; reason: string }[];
  resurrected: { slug: string; file: string }[];
  skipped: { slug: string; file: string; reason: string }[];
}

/**
 * Rescan-on-startup claim pass. Idempotent: claimed files physically move out
 * of the inbox into the item store, so nothing can be claimed twice. An
 * archived (triage-rejected) item re-dropped in the inbox gets a fresh claim
 * — resurrection.
 */
export function scanInbox(p: FactoryPaths, db: FactoryDb): InboxReport {
  const report: InboxReport = { claimed: [], malformed: [], resurrected: [], skipped: [] };
  if (!existsSync(p.inbox)) return report;

  for (const fileName of listInboxFiles(p.inbox)) {
    const filePath = path.join(p.inbox, fileName);
    const raw = readFileSafe(filePath);
    const baseSlug = slugify(path.basename(fileName));
    const existing = db.findBySlug(baseSlug);

    if (claimBlocked(existing)) {
      report.skipped.push({ slug: baseSlug, file: filePath, reason: `slug already claimed (item #${existing.id}, ${existing.status})` });
      continue;
    }

    const parsed = parseItemMarkdown(raw);
    const slug = existing ? uniqueSlug(db, baseSlug) : baseSlug;
    mkdirSync(itemDir(p, slug), { recursive: true });
    const dest = itemFile(p, slug);
    renameSync(filePath, dest);

    if (!parsed.ok) {
      const item = db.insertItem({
        slug,
        title: path.basename(fileName, path.extname(fileName)).replace(/-/g, " ").trim() || slug,
        repo: "(unknown)",
        base: "main",
        approvals: [],
        stage: "triage",
        status: "malformed",
        sourceFile: dest,
      });
      db.appendHistory(item.id, "claimed", null, { file: fileName, malformed: parsed.reason });
      db.parkMalformed(item, parsed.reason);
      report.malformed.push({ slug, file: dest, reason: parsed.reason });
      continue;
    }

    const item = db.insertItem({
      slug,
      title: parsed.item.title,
      repo: parsed.item.repo,
      base: parsed.item.base,
      approvals: parsed.item.approvals,
      stage: "triage",
      status: "queued",
      sourceFile: dest,
    });
    db.appendHistory(item.id, existing ? "resurrected" : "claimed", null, { file: fileName });
    const bucket = existing ? report.resurrected : report.claimed;
    bucket.push({ slug, file: dest });
  }
  return report;
}

function uniqueSlug(db: FactoryDb, base: string): string {
  let n = 2;
  let candidate = `${base}-${n}`;
  while (db.findBySlug(candidate) !== undefined) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

function readFileSafe(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}