/**
 * Shared status layer — the single source both `wb status` (CLI renderer)
 * and the `wb serve` web API render from, so the two surfaces can never
 * disagree about factory state (wb-serve spec, user story 33).
 *
 * The CLI presentation helpers (`classifyInbox`, `formatAge`,
 * `printStatusItems`) are a verbatim move from `src/cli/index.ts` — `wb
 * status` output must stay byte-identical. `buildStatusPayload` is the web
 * snapshot serializer: read-only DB calls only, no factory lock, no writes
 * (the same discipline as `wb status`).
 */

import * as path from "node:path";
import { listInboxFiles, claimBlocked } from "./inbox.js";
import { slugify } from "./frontmatter.js";
import { lockHolderAlive, readLockInfo, STALE_LOCK_MS } from "./lock.js";
import { ACTIONABLE_STATUSES, STAGES, TERMINAL_STATUSES, type ItemRecord, type StageName } from "./types.js";
import type { FactoryDb } from "./db.js";
import type { FactoryPaths } from "./paths.js";

// ---------------------------------------------------------------- CLI render

/** Classify unclaimed inbox files without mutating anything (read-only peer of `scanInbox`).
 *  Matches scanInbox's skip rule via the shared `claimBlocked` predicate and
 *  shares `listInboxFiles`, so "awaiting claim" means `wb run` will actually claim it.
 *  `opts.bySlug`: an in-memory slug → item map (e.g. the items a caller already
 *  read from a `getWatchSnapshot`); when present it replaces the per-file
 *  `db.findBySlug` lookup so a per-tick caller pays one query, not one per
 *  inbox file (rework finding 2). */
export function classifyInbox(
  db: FactoryDb,
  inboxDir: string,
  opts: { bySlug?: ReadonlyMap<string, ItemRecord> } = {},
): {
  claimable: string[];
  alreadyClaimed: { file: string; item: ItemRecord }[];
  error: NodeJS.ErrnoException | null;
} {
  let files: string[];
  try {
    // listInboxFiles throws ENOENT when the inbox doesn't exist yet — a normal
    // settled state. Any other read error must surface, otherwise status makes
    // an unreadable inbox look empty.
    files = listInboxFiles(inboxDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { claimable: [], alreadyClaimed: [], error: null };
    }
    return { claimable: [], alreadyClaimed: [], error: err as NodeJS.ErrnoException };
  }
  const claimable: string[] = [];
  const alreadyClaimed: { file: string; item: ItemRecord }[] = [];
  for (const fileName of files) {
    const existing = opts.bySlug
      ? opts.bySlug.get(slugify(path.basename(fileName)))
      : db.findBySlug(slugify(path.basename(fileName)));
    if (claimBlocked(existing)) {
      alreadyClaimed.push({ file: fileName, item: existing });
    } else {
      claimable.push(fileName);
    }
  }
  return { claimable, alreadyClaimed, error: null };
}

/** Human age for a lock timestamp. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "just started";
  return `${Math.round(ms / 60_000)} min ago`;
}

/** Shared item listing used by `wb status` (read-only, no lock needed). */
export function printStatusItems(db: FactoryDb, opts: { all?: boolean }): void {
  const items = db.listItems().filter((i) => opts.all || i.status !== "done");
  if (items.length === 0) {
    console.log("No items. Drop a markdown file in the inbox: `wb template`");
  }
  for (const item of items) {
    console.log(`#${item.id} ${item.slug} [${item.status}] stage=${item.stage} repo=${item.repo}`);
    console.log(`    title: ${item.title}`);
    if (item.sourceFile) console.log(`    source: ${item.sourceFile}`);
    if (item.parkedReason) console.log(`    parked: ${item.parkedReason}`);
    if (item.parkedDetail) {
      const d = item.parkedDetail;
      if (item.parkedReason === "stale-base" && typeof d.base === "string" && typeof d.repo === "string") {
        console.log(
          `    stale base: ${d.base} (${d.localTip ?? "?"}) behind origin/${d.base} (${d.upstreamTip ?? "?"}) — git pull in ${d.repo}`,
        );
      }
      if (Array.isArray(d.questions) && d.questions.length > 0) {
        console.log("    questions:");
        for (const q of d.questions as string[]) console.log(`      - ${q}`);
      }
      if (typeof d.stage === "string" && d.stage !== item.stage) {
        console.log(`    completed stage: ${d.stage}`);
      }
      if (item.parkedReason === "awaiting-approval") {
        const artifacts = db.getArtifacts(item.id).filter((a) => a.stage === d.stage);
        if (artifacts.length > 0) {
          console.log(`    artifact from ${d.stage}: ` + artifacts.map((a) => a.path).join(", "));
        }
      }
    }
    const attempts = Object.entries(item.gateAttempts);
    if (attempts.length > 0) {
      console.log(`    gate attempts: ${attempts.map(([s, n]) => `${s}=${n}`).join(", ")}`);
    }
    if (item.infraAttempts > 0) console.log(`    infra retries so far: ${item.infraAttempts}`);
  }
}

// ------------------------------------------------- web snapshot serializer

/** `classifyInbox` result serialized for JSON: items are summarized to the
 *  fields the UI needs (id/slug/status), errors to their message. */
export interface StatusInbox {
  claimable: string[];
  alreadyClaimed: { file: string; item: { id: number; slug: string; status: string } }[];
  /** Non-null when the inbox directory is unreadable (rendered, never silent). */
  error: string | null;
}

/** `ItemRecord` plus exactly three derived fields (no other enrichment):
 *  artifacts (parked `awaiting-approval` / `done`), prUrl/prDraft (`done`),
 *  questions (`needs-human`). */
export interface StatusItem extends ItemRecord {
  artifacts?: { name: string; stage: StageName | null; path: string; createdAt: string }[];
  prUrl?: string;
  prDraft?: boolean;
  questions?: string[];
}

export interface StatusPayload {
  root: string;
  generatedAt: string;
  maxHistoryId: number | null;
  lock: { pid: number; ts: number; ageMs: number; alive: boolean; stale: boolean } | null;
  counts: { decisions: number; running: number; queued: number; inbox: number; done: number };
  flow: { label: string; n: number }[];
  stages: string[];
  knownRepos: { repo: string; count: number }[];
  inbox: StatusInbox;
  items: StatusItem[];
}

/** The parked / waiting-on-you set: every status that is neither actionable
 *  (queued/running) nor terminal (done/rejected) — identical to `wb watch`'s
 *  card split, so the web decisions count and card set can never diverge
 *  from the CLI's notion of "parked". */
export function isParkedStatus(status: string): boolean {
  return !(ACTIONABLE_STATUSES as readonly string[]).includes(status) &&
    !(TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The `ItemRecord` → `StatusItem` serializer shared by `buildStatusPayload`
 *  and the web detail endpoint (`GET /api/items/:id`): an `ItemRecord` plus at
 *  most the three derived fields (artifacts/prUrl/questions — see
 *  `StatusItem`). Exported for the detail route; `buildStatusPayload`'s output
 *  and `statusFingerprint` are untouched by this. */
export function toStatusItem(item: ItemRecord, artifactsByItem: ReadonlyMap<number, { name: string; stage: StageName | null; path: string; createdAt: string }[]>): StatusItem {
  const out: StatusItem = { ...item };
  if (item.status === "awaiting-approval") {
    // The parked stage's artifacts — "read the spec before approving".
    const stage = item.parkedDetail?.stage;
    if (typeof stage === "string") {
      const artifacts = (artifactsByItem.get(item.id) ?? []).filter((a) => a.stage === stage);
      if (artifacts.length > 0) out.artifacts = artifacts;
    }
  } else if (item.status === "done") {
    const artifacts = artifactsByItem.get(item.id) ?? [];
    if (artifacts.length > 0) out.artifacts = artifacts;
    const d = item.parkedDetail;
    if (d && typeof d.prUrl === "string") {
      out.prUrl = d.prUrl;
      out.prDraft = d.draft === true;
    }
  } else if (item.status === "needs-human") {
    const questions = item.parkedDetail?.questions;
    if (Array.isArray(questions)) out.questions = questions as string[];
  }
  return out;
}

function serializeLock(root: string, clock: { now(): number }): StatusPayload["lock"] {
  const lock = readLockInfo(root);
  if (!lock) return null;
  const ageMs = Math.max(0, clock.now() - lock.ts);
  return {
    pid: lock.pid,
    ts: lock.ts,
    ageMs,
    alive: lockHolderAlive(lock),
    // Mirrors the CLI's "(possibly stale)" hint threshold.
    stale: ageMs > STALE_LOCK_MS,
  };
}

/** The "did anything change" fingerprint derived from a built payload — the
 *  SSE poller compares each client's copy against it to decide whether the
 *  full `status` event must be re-sent (building the payload once per tick
 *  and deriving the fingerprint from it is what keeps a tick single-read:
 *  rework finding 2). */
export function statusFingerprint(payload: StatusPayload): string {
  const itemPart = payload.items
    .map((i) => [i.id, i.status, i.stage, i.parkedReason, JSON.stringify(i.parkedDetail), i.feedback, i.updatedAt].join("|"))
    .join(";");
  return [itemPart, payload.inbox.claimable.join(","), payload.lock ? `${payload.lock.pid}@${payload.lock.ts}:${payload.lock.alive ? "alive" : "dead"}` : "-"].join("§");
}

/**
 * The one snapshot serializer behind `GET /api/status` and the SSE `status`
 * event. Read-only: one items read (or the caller's prefetched `snapshot`), one
 * artifacts read (`listArtifactsByItem` — never per-item N+1), one known-repos
 * read, one inbox directory scan + a lock read. No factory lock, no writes —
 * the same discipline as `wb status`.
 *
 * `snapshot` lets a per-tick caller (the SSE poller) hand in the
 * `getWatchSnapshot` it already read: the items and `maxHistoryId` are reused,
 * and inbox slugs resolve against them in memory instead of one `findBySlug`
 * per inbox filename — no second `SELECT * FROM items`, no second
 * `MAX(id)`, no per-file queries.
 */
export function buildStatusPayload(input: {
  root: string;
  paths: FactoryPaths;
  db: FactoryDb;
  clock?: { now(): number };
  snapshot?: { items: ItemRecord[]; maxHistoryId: number | null };
}): StatusPayload {
  const clock = input.clock ?? { now: () => Date.now() };
  const db = input.db;
  const items = input.snapshot?.items ?? db.listItems();
  const maxHistoryId = input.snapshot ? input.snapshot.maxHistoryId : db.getMaxHistoryId();
  const bySlug = new Map(items.map((i) => [i.slug, i] as const));
  const classified = classifyInbox(db, input.paths.inbox, { bySlug });
  const artifactsByItem = db.listArtifactsByItem();
  const decisions = items.filter((i) => isParkedStatus(i.status)).length;
  const running = items.filter((i) => i.status === "running");
  const queued = items.filter((i) => i.status === "queued").length;
  const done = items.filter((i) => i.status === "done").length;
  // Flow segments in factory order, zero-count omitted (inbox → queue → one
  // per running stage → parked → done): what the proportional bar renders.
  const flow: { label: string; n: number }[] = [
    { label: "inbox", n: classified.claimable.length },
    { label: "queue", n: queued },
    ...STAGES.map((stage) => ({ label: stage, n: running.filter((i) => i.stage === stage).length })),
    { label: "parked", n: decisions },
    { label: "done", n: done },
  ].filter((s) => s.n > 0);
  return {
    root: input.root,
    generatedAt: new Date(clock.now()).toISOString(),
    maxHistoryId,
    lock: serializeLock(input.root, clock),
    counts: {
      decisions,
      running: running.length,
      queued,
      inbox: classified.claimable.length,
      done,
    },
    flow,
    stages: [...STAGES],
    knownRepos: db.knownReposNewestFirst(),
    inbox: {
      claimable: classified.claimable,
      alreadyClaimed: classified.alreadyClaimed.map(({ file, item }) => ({
        file,
        item: { id: item.id, slug: item.slug, status: item.status },
      })),
      error: classified.error ? (classified.error.message ?? String(classified.error)) : null,
    },
    // ALL items (incl. done), newest-last — the UI filters.
    items: items.map((item) => toStatusItem(item, artifactsByItem)),
  };
}
