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
  readonly readonly: boolean;

  constructor(root: string, options: { readonly?: boolean } = {}) {
    const dbPath = path.join(root, "factory.db");
    if (options.readonly) {
      this.readonly = true;
      // A read-only connection never blocks a writer (WAL mode) and never
      // writes itself: no mkdir, no schema migration. Used by `wb status`
      // so state inspection works while `wb run` holds the factory lock.
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      return;
    }
    this.readonly = false;
    mkdirSync(root, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
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
    const info = this.db
      .prepare(
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
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Exact match first, then unique-prefix match. */
  findItemBySlugPrefix(slugOrPrefix: string): ItemRecord | undefined {
    const exact = this.db.prepare("SELECT * FROM items WHERE slug = ?").get(slugOrPrefix) as ItemRow | undefined;
    if (exact) return toItem(exact);
    const rows = this.db
      .prepare("SELECT * FROM items WHERE slug LIKE ? ORDER BY id")
      .all(`${slugOrPrefix}%`) as ItemRow[];
    return rows.length === 1 ? toItem(rows[0]!) : undefined;
  }

  findBySlug(slug: string): ItemRecord | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE slug = ?").get(slug) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  listItems(): ItemRecord[] {
    const rows = this.db.prepare("SELECT * FROM items ORDER BY id").all() as ItemRow[];
    return rows.map(toItem);
  }

  itemsWithStatus(statuses: readonly ItemStatus[]): ItemRecord[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE status IN (${placeholders}) ORDER BY id`)
      .all(...statuses) as ItemRow[];
    return rows.map(toItem);
  }

  updateItem(id: number, patch: Partial<ItemRecord>): void {
    const item = this.getItem(id);
    if (!item) throw new Error(`unknown item id ${id}`);
    const merged: ItemRecord = { ...item, ...patch };
    this.db
      .prepare(
        `UPDATE items SET slug=?, title=?, repo=?, base=?, approvals=?, stage=?, status=?,
         parked_reason=?, parked_detail=?, feedback=?, answers=?, source_file=?, branch_name=?,
         gate_attempts=?, infra_attempts=?, updated_at=? WHERE id=?`,
      )
      .run(
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
    this.db
      .prepare("INSERT INTO history (item_id, ts, event, stage, detail) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, this.now(), event, stage, JSON.stringify(detail));
  }

  getHistory(itemId: number): HistoryRecord[] {
    const rows = this.db
      .prepare("SELECT ts, event, stage, detail FROM history WHERE item_id = ? ORDER BY id")
      .all(itemId) as { ts: string; event: string; stage: string | null; detail: string }[];
    return rows.map((r) => ({
      ts: r.ts,
      event: r.event as HistoryEvent,
      stage: (r.stage as StageName | null) ?? null,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
    }));
  }

  addArtifact(itemId: number, stage: StageName | null, name: string, absPath: string): ArtifactRecord {
    const ts = this.now();
    this.db
      .prepare("INSERT INTO artifacts (item_id, stage, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, stage, name, absPath, ts);
    return { stage, name, path: absPath, createdAt: ts };
  }

  getArtifacts(itemId: number): ArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT stage, name, path, created_at FROM artifacts WHERE item_id = ? ORDER BY id")
      .all(itemId) as { stage: string | null; name: string; path: string; created_at: string }[];
    return rows.map((r) => ({ stage: (r.stage as StageName | null) ?? null, name: r.name, path: r.path, createdAt: r.created_at }));
  }

  /** Per-repo lock bookkeeping (day-one concept; strictly sequential for now). */
  acquireRepoLock(repo: string, itemId: number): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO repo_locks (repo, item_id, acquired_at) VALUES (?, ?, ?)")
      .run(repo, itemId, this.now());
    return Number(info.changes) > 0;
  }

  releaseRepoLock(repo: string, itemId: number): void {
    this.db.prepare("DELETE FROM repo_locks WHERE repo = ? AND item_id = ?").run(repo, itemId);
  }

  knownRepos(): { repo: string; count: number }[] {
    const rows = this.db
      .prepare("SELECT repo, COUNT(*) AS count FROM items GROUP BY repo ORDER BY repo")
      .all() as { repo: string; count: number }[];
    return rows;
  }

  /**
   * Distinct target repos from the item store, newest item first. Excludes the
   * "(unknown)" placeholder that scanInbox records for malformed items.
   */
  knownReposNewestFirst(): { repo: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT repo, COUNT(*) AS count, MAX(id) AS latest_id
         FROM items
         WHERE repo <> '(unknown)'
         GROUP BY repo
         ORDER BY latest_id DESC, repo ASC`,
      )
      .all() as { repo: string; count: number; latest_id: number }[];
    return rows.map((r) => ({ repo: r.repo, count: r.count }));
  }
}