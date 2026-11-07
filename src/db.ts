import Database from "better-sqlite3";
import * as path from "node:path";
import { mkdirSync } from "node:fs";
import type {
  ArtifactRecord,
  HistoryEvent,
  HistoryRecord,
  ItemRecord,
  ItemStatus,
  QuestionAnswer,
  StageName,
} from "./types.js";

export type ItemRow = {
  id: number;
  slug: string;
  title: string;
  repo: string;
  base: string;
  approvals: string;
  stage: StageName;
  status: ItemStatus;
  parked_reason: string | null;
  parked_detail: string | null;
  feedback: string | null;
  answers: string;
  source_file: string | null;
  branch_name: string;
  gate_attempts: string;
  infra_attempts: number;
  created_at: string;
  updated_at: string;
};

/** Global history row (all items) for read-only consumers like `wb watch`. */
export interface HistoryFeedRow {
  id: number;
  item_id: number;
  ts: string;
  event: string;
  stage: string | null;
  detail: Record<string, unknown>;
}

/** Consistent read snapshot for read-only consumers like `wb watch`. */
export interface WatchSnapshot {
  items: ItemRecord[];
  maxHistoryId: number | null;
  historySince: HistoryFeedRow[];
}

/** Detail JSON is always stringified by `appendHistory`, but parse defensively. */
function parseHistoryDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toItem(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    repo: row.repo,
    base: row.base,
    approvals: JSON.parse(row.approvals) as string[],
    stage: row.stage,
    status: row.status,
    parkedReason: row.parked_reason,
    parkedDetail: row.parked_detail ? (JSON.parse(row.parked_detail) as Record<string, unknown>) : null,
    feedback: row.feedback,
    answers: JSON.parse(row.answers) as QuestionAnswer[],
    sourceFile: row.source_file,
    branchName: row.branch_name,
    gateAttempts: JSON.parse(row.gate_attempts) as Partial<Record<StageName, number>>,
    infraAttempts: row.infra_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SQLite is the only stateful database. The schema is intentionally
 * dashable/readable by a future web UI: flat item columns, append-only
 * history and artifact tables.
 */
export class FactoryDb {
  readonly db: Database.Database;

  /** SQL → prepared statement, prepared once per connection and reused.
     better-sqlite3 re-prepares on every `prepare()` call; a live-polling
     consumer (wb watch / wb serve) hitting the read API per tick must not
     multiply that work (rework: statement cache). */
  private readonly statements = new Map<string, Database.Statement>();

  /** Cached `getWatchSnapshot` transaction (BEGIN/COMMIT plumbing is built
   *  once, not per poll). Undefined until first use; the bound `this` in the
   *  closure stays valid for the connection's lifetime. */
  private snapshotTxn: ((afterId: number | null) => WatchSnapshot) | undefined;

  constructor(root: string, options: { readonly?: boolean } = {}) {
    const dbPath = path.join(root, "factory.db");
    if (options.readonly) {
      // A read-only connection never blocks a writer (WAL mode) and never
      // writes itself: no mkdir, no schema migration. Used by `wb status`
      // so state inspection works while `wb run` holds the factory lock.
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } else {
      mkdirSync(root, { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.migrate();
    }
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
  }

  /** Read-only handle for inspection commands (`wb status`). */
  static openReadonly(root: string): FactoryDb {
    return new FactoryDb(root, { readonly: true });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        slug          TEXT NOT NULL UNIQUE,
        title         TEXT NOT NULL,
        repo          TEXT NOT NULL,
        base          TEXT NOT NULL,
        approvals     TEXT NOT NULL DEFAULT '[]',
        stage         TEXT NOT NULL,
        status        TEXT NOT NULL,
        parked_reason TEXT,
        parked_detail TEXT,
        feedback      TEXT,
        answers       TEXT NOT NULL DEFAULT '[]',
        source_file   TEXT,
        branch_name   TEXT NOT NULL,
        gate_attempts TEXT NOT NULL DEFAULT '{}',
        infra_attempts INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id),
        ts      TEXT NOT NULL,
        event   TEXT NOT NULL,
        stage   TEXT,
        detail  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items(id),
        stage      TEXT,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_locks (
        repo         TEXT PRIMARY KEY,
        item_id      INTEGER NOT NULL REFERENCES items(id),
        acquired_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_item ON history(item_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_item ON artifacts(item_id);
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Cached prepare: each SQL text is compiled once per connection. The keys
   *  are bounded (a fixed set of queries; `itemsWithStatus` adds at most one
   *  per distinct status-list length). */
  private stmt(sql: string): Database.Statement {
    let s = this.statements.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private now(): string {
    return new Date().toISOString();
  }

  insertItem(
    d: Pick<ItemRecord, "slug" | "title" | "repo" | "base" | "approvals" | "stage" | "status"> & {
      sourceFile?: string;
      parkedReason?: string;
      parkedDetail?: Record<string, unknown>;
      branchName?: string;
    },
  ): ItemRecord {
    const ts = this.now();
    const branchName = d.branchName ?? `factory/${d.slug}`;
    const info = this.stmt(
      `INSERT INTO items
         (slug, title, repo, base, approvals, stage, status, parked_reason, parked_detail,
          source_file, branch_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .run(
        d.slug,
        d.title,
        d.repo,
        d.base,
        JSON.stringify(d.approvals),
        d.stage,
        d.status,
        d.parkedReason ?? null,
        d.parkedDetail ? JSON.stringify(d.parkedDetail) : null,
        d.sourceFile ?? null,
        branchName,
        ts,
        ts,
      );
    return this.getItem(Number(info.lastInsertRowid))!;
  }

  getItem(id: number): ItemRecord | undefined {
    const row = this.stmt("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Exact match first, then unique-prefix match. */
  findItemBySlugPrefix(slugOrPrefix: string): ItemRecord | undefined {
    const exact = this.stmt("SELECT * FROM items WHERE slug = ?").get(slugOrPrefix) as ItemRow | undefined;
    if (exact) return toItem(exact);
    const rows = this.stmt("SELECT * FROM items WHERE slug LIKE ? ORDER BY id")
      .all(`${slugOrPrefix}%`) as ItemRow[];
    return rows.length === 1 ? toItem(rows[0]!) : undefined;
  }

  findBySlug(slug: string): ItemRecord | undefined {
    const row = this.stmt("SELECT * FROM items WHERE slug = ?").get(slug) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  listItems(): ItemRecord[] {
    const rows = this.stmt("SELECT * FROM items ORDER BY id").all() as ItemRow[];
    return rows.map(toItem);
  }

  itemsWithStatus(statuses: readonly ItemStatus[]): ItemRecord[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.stmt(`SELECT * FROM items WHERE status IN (${placeholders}) ORDER BY id`)
      .all(...statuses) as ItemRow[];
    return rows.map(toItem);
  }

  updateItem(id: number, patch: Partial<ItemRecord>): void {
    const item = this.getItem(id);
    if (!item) throw new Error(`unknown item id ${id}`);
    const merged: ItemRecord = { ...item, ...patch };
    this.stmt(
      `UPDATE items SET slug=?, title=?, repo=?, base=?, approvals=?, stage=?, status=?,
         parked_reason=?, parked_detail=?, feedback=?, answers=?, source_file=?, branch_name=?,
         gate_attempts=?, infra_attempts=?, updated_at=? WHERE id=?`,
    ).run(
        merged.slug,
        merged.title,
        merged.repo,
        merged.base,
        JSON.stringify(merged.approvals),
        merged.stage,
        merged.status,
        merged.parkedReason,
        merged.parkedDetail ? JSON.stringify(merged.parkedDetail) : null,
        merged.feedback,
        JSON.stringify(merged.answers),
        merged.sourceFile,
        merged.branchName,
        JSON.stringify(merged.gateAttempts),
        merged.infraAttempts,
        this.now(),
        id,
      );
  }

  appendHistory(itemId: number, event: HistoryEvent, stage: StageName | null, detail: Record<string, unknown>): void {
    this.stmt("INSERT INTO history (item_id, ts, event, stage, detail) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, this.now(), event, stage, JSON.stringify(detail));
  }

  /** Park an item as malformed front-matter: persist the parked state on the
   *  item row and emit the `parked` history row. Single shared implementation
   *  for both park sites — the claim path (`scanInbox`, src/inbox.ts) and the
   *  re-parse path (`refreshFromSource`, src/pipeline.ts) — so `wb watch`
   *  renders the parked line, fix hint, and OS notification for malformed
   *  items the same way regardless of where parking happened. The row's stage
   *  is `item.stage`: the stage the item was inserted with (claim path) or was
   *  working in (re-parse path). */
  parkMalformed(item: ItemRecord, reason: string): void {
    this.updateItem(item.id, {
      status: "malformed",
      parkedReason: `malformed front-matter: ${reason}`,
      parkedDetail: null,
    });
    this.appendHistory(item.id, "parked", item.stage, { reason });
  }

  getHistory(itemId: number): HistoryRecord[] {
    const rows = this.stmt("SELECT ts, event, stage, detail FROM history WHERE item_id = ? ORDER BY id")
      .all(itemId) as { ts: string; event: string; stage: string | null; detail: string }[];
    return rows.map((r) => ({
      ts: r.ts,
      event: r.event as HistoryEvent,
      stage: (r.stage as StageName | null) ?? null,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
    }));
  }

  /** History rows after `afterId`, across all items, in id order. Read-only. */
  getHistorySince(afterId: number): HistoryFeedRow[] {
    const rows = this.stmt("SELECT id, item_id, ts, event, stage, detail FROM history WHERE id > ? ORDER BY id")
      .all(afterId) as { id: number; item_id: number; ts: string; event: string; stage: string | null; detail: string }[];
    return rows.map((r) => ({
      id: r.id,
      item_id: r.item_id,
      ts: r.ts,
      event: r.event,
      stage: r.stage,
      detail: parseHistoryDetail(r.detail),
    }));
  }

  /** Highest history row id (null when the history table is empty). */
  getMaxHistoryId(): number | null {
    const row = this.stmt("SELECT MAX(id) AS maxId FROM history").get() as
      | { maxId: number | null }
      | undefined;
    return row?.maxId ?? null;
  }

  /**
   * Read-only snapshot for `wb watch`: all items plus history rows after
   * `afterId` (when non-null), taken inside a single read transaction so the
   * event feed and item state cannot interleave with a concurrent `wb run`.
   * Never acquires the factory lock.
   */
  getWatchSnapshot(afterId: number | null): WatchSnapshot {
    if (this.snapshotTxn === undefined) {
      // BEGIN/COMMIT plumbing and the read statements are compiled once and
      // reused by every poll (wb watch / the wb serve SSE ticker).
      this.snapshotTxn = this.db.transaction((aid: number | null): WatchSnapshot => {
        const items = this.listItems();
        const maxHistoryId = this.getMaxHistoryId();
        const historySince = aid === null ? [] : this.getHistorySince(aid);
        return { items, maxHistoryId, historySince };
      });
    }
    return this.snapshotTxn(afterId);
  }

  addArtifact(itemId: number, stage: StageName | null, name: string, absPath: string): ArtifactRecord {
    const ts = this.now();
    this.stmt("INSERT INTO artifacts (item_id, stage, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, stage, name, absPath, ts);
    return { stage, name, path: absPath, createdAt: ts };
  }

  getArtifacts(itemId: number): ArtifactRecord[] {
    const rows = this.stmt("SELECT stage, name, path, created_at FROM artifacts WHERE item_id = ? ORDER BY id")
      .all(itemId) as { stage: string | null; name: string; path: string; created_at: string }[];
    return rows.map((r) => ({ stage: (r.stage as StageName | null) ?? null, name: r.name, path: r.path, createdAt: r.created_at }));
  }

  /** All artifacts grouped by item id, in one query (order preserved within
   *  an item: item_id, then row id — same order as `getArtifacts`). The
   *  whole-store snapshot serializers (`buildStatusPayload`) use this instead
   *  of a `getArtifacts` call per item — one artifacts query per payload, not
   *  N+1 (rework finding 1). */
  listArtifactsByItem(): Map<number, ArtifactRecord[]> {
    const rows = this.stmt("SELECT item_id, stage, name, path, created_at FROM artifacts ORDER BY item_id, id")
      .all() as { item_id: number; stage: string | null; name: string; path: string; created_at: string }[];
    const byItem = new Map<number, ArtifactRecord[]>();
    for (const r of rows) {
      const record: ArtifactRecord = {
        stage: (r.stage as StageName | null) ?? null,
        name: r.name,
        path: r.path,
        createdAt: r.created_at,
      };
      const list = byItem.get(r.item_id);
      if (list) list.push(record);
      else byItem.set(r.item_id, [record]);
    }
    return byItem;
  }

  /** Per-repo lock bookkeeping (day-one concept; strictly sequential for now). */
  acquireRepoLock(repo: string, itemId: number): boolean {
    const info = this.stmt("INSERT OR IGNORE INTO repo_locks (repo, item_id, acquired_at) VALUES (?, ?, ?)")
      .run(repo, itemId, this.now());
    return Number(info.changes) > 0;
  }

  releaseRepoLock(repo: string, itemId: number): void {
    this.stmt("DELETE FROM repo_locks WHERE repo = ? AND item_id = ?").run(repo, itemId);
  }

  knownRepos(): { repo: string; count: number }[] {
    const rows = this.stmt("SELECT repo, COUNT(*) AS count FROM items GROUP BY repo ORDER BY repo")
      .all() as { repo: string; count: number }[];
    return rows;
  }

  /**
   * Distinct target repos from the item store, newest item first. Excludes the
   * "(unknown)" placeholder that scanInbox records for malformed items.
   */
  knownReposNewestFirst(): { repo: string; count: number }[] {
    const rows = this.stmt(
      `SELECT repo, COUNT(*) AS count, MAX(id) AS latest_id
       FROM items
       WHERE repo <> '(unknown)'
       GROUP BY repo
       ORDER BY latest_id DESC, repo ASC`,
    ).all() as { repo: string; count: number; latest_id: number }[];
    return rows.map((r) => ({ repo: r.repo, count: r.count }));
  }
}