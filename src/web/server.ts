/**
 * `wb serve` — local web UI over the factory.
 *
 * One seam: `createServeApp(deps)` takes the same factory context the CLI
 * assembles (resolved root, paths, config, a read-only observation DB handle)
 * plus a runner factory and knobs. All HTTP behavior lives behind it.
 *
 * Lock discipline (spec §0): the server process itself never holds the
 * factory lock — observation goes through the read-only DB exactly like
 * `wb status`, and every mutating request acquires the lock for the
 * duration of that action only, mirroring the CLI command lifecycle
 * (construct → use → dispose → close → release). Run/resume are accepted
 * as POSTs and executed in the background under the lock; progress reaches
 * the page exclusively through the SSE stream.
 */

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import nodeProcess from "node:process";

import { loadConfig, type FactoryConfig } from "../config.js";
import { makePaths, type FactoryPaths } from "../paths.js";
import { FactoryDb, type HistoryFeedRow } from "../db.js";
import {
  acquireFactoryLock,
  FactoryBusyError,
  lockHolderAlive,
  readLockInfo,
  STALE_LOCK_MS,
} from "../lock.js";
import { Orchestrator } from "../pipeline.js";
import type { CuratorRunner, ItemRecord, StageRunner } from "../types.js";
import type { PrPublisher } from "../pipeline.js";
import { ITEM_TEMPLATE, parseApprovalsInput } from "../frontmatter.js";
import { authorItem, validateRepoPath, type AuthoringIO } from "../new.js";
import { scanInbox } from "../inbox.js";
import { GitBaseFreshnessChecker, type BaseFreshnessChecker } from "../baseFreshness.js";
import { parseIntervalSeconds } from "../watch.js";
import { sleep } from "../util.js";
import { buildStatusPayload, classifyInbox, type StatusPayload } from "../status.js";
import { SandcastleStageRunner, GhPrPublisher, SandcastleCurator, agentEnvFor } from "../adapters/sandcastle.js";
import { PAGE_HTML } from "./page.js";

export const DEFAULT_SERVE_PORT = 7466;
export const DEFAULT_SERVE_HOST = "127.0.0.1";
/** Bodies larger than this are rejected before parsing (composer markdown, drops). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** From the 5th consecutive failing DB read, surface once per failing poll (watch parity). */
const READ_FAILURE_NOTICE_THRESHOLD = 5;

// ---------------------------------------------------------------- seam types

export interface ServeAppDeps {
  root: string;
  paths: FactoryPaths;
  config: FactoryConfig;
  /** Read-only observation handle (caller owns it; `wb serve` never writes through it). */
  db: FactoryDb;
  makeRunner: () => {
    runner: StageRunner;
    curator: CuratorRunner | null;
    publisher: PrPublisher;
    /** Freshness-gate override; production omits it (real GitBaseFreshnessChecker).
     *  Tests pass a silent-proceed checker (tests/helpers.ts rationale). */
    baseCheck?: BaseFreshnessChecker | null;
  };
  /** SSE poll interval; 0 disables the timer (tests drive `flush()` directly). */
  intervalMs?: number;
  clock?: { now(): number };
  /** "background" (prod): run/resume answer 202 immediately. "await" (tests): answer after completion. */
  runMode?: "background" | "await";
}

export interface ServeApp {
  handler(req: IncomingMessage, res: ServerResponse): void;
  /** One poll tick: the production interval calls this; tests call it directly. */
  flush(): void;
  /** Stop the poller and end every open SSE response. */
  stop(): void;
}

/** Fixed error carrying an HTTP status and JSON body (central catch renders it). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super("http error");
  }
}

interface SseClient {
  res: ServerResponse;
  /** This client's last delivered history row id (Last-Event-ID position). */
  lastEventId: number;
  /** Last status fingerprint delivered to this client. */
  fingerprint: string;
}

// ---------------------------------------------------------------- app factory

export function createServeApp(deps: ServeAppDeps): ServeApp {
  const intervalMs = deps.intervalMs ?? 2000;
  const clock = deps.clock ?? { now: () => Date.now() };
  const clients = new Set<SseClient>();
  /** The shared poller's own position: max history id it has fetched (and sent). */
  let cursor = 0;
  let consecutiveReadFailures = 0;
  let timer: NodeJS.Timeout | null = null;
  if (intervalMs > 0) timer = setInterval(() => flush(), intervalMs);

  function lockPayload(): StatusPayload["lock"] {
    const lock = readLockInfo(deps.root);
    if (!lock) return null;
    const ageMs = Math.max(0, clock.now() - lock.ts);
    return { pid: lock.pid, ts: lock.ts, ageMs, alive: lockHolderAlive(lock), stale: ageMs > STALE_LOCK_MS };
  }

  function statusPayload(): StatusPayload {
    return buildStatusPayload({ root: deps.root, paths: deps.paths, db: deps.db, clock });
  }

  /** Fingerprint over (items' id/status/stage/parkedReason/parkedDetail/feedback/updatedAt
   *  + claimable inbox filenames + lock pid/ts): the "did anything change"
   *  signal for the per-client status resend decision. */
  function fingerprintOf(
    items: Pick<ItemRecord, "id" | "status" | "stage" | "parkedReason" | "parkedDetail" | "feedback" | "updatedAt">[],
    claimable: string[],
    lock: { pid: number; ts: number } | null,
  ): string {
    const itemPart = items
      .map((i) => [i.id, i.status, i.stage, i.parkedReason, JSON.stringify(i.parkedDetail), i.feedback, i.updatedAt].join("|"))
      .join(";");
    return [itemPart, claimable.join(","), lock ? `${lock.pid}@${lock.ts}` : "-"].join("§");
  }

  function writeHistoryEvent(res: ServerResponse, row: HistoryFeedRow, slug: string): void {
    const data = JSON.stringify({
      id: row.id,
      itemId: row.item_id,
      slug,
      ts: row.ts,
      event: row.event,
      stage: row.stage,
      detail: row.detail,
    });
    // `id:` only ever on history rows, so browser Last-Event-ID means exactly
    // "last history row processed".
    res.write(`id: ${row.id}\nevent: history\ndata: ${data}\n\n`);
  }

  function sendStatus(res: ServerResponse, payload: StatusPayload): void {
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** SSE connect: optional replay (afterId / Last-Event-ID), then one full
   *  status snapshot. Read-only; no factory lock. */
  function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let afterId: number | null = null;
    const q = url.searchParams.get("afterId");
    if (q !== null && q !== "" && Number.isInteger(Number(q))) afterId = Number(q);
    else {
      const header = req.headers["last-event-id"];
      if (typeof header === "string" && Number.isInteger(Number(header))) afterId = Number(header);
    }
    const snap = deps.db.getWatchSnapshot(null);
    const byId = new Map(snap.items.map((i) => [i.id, i] as const));
    let last = snap.maxHistoryId ?? 0;
    if (afterId !== null) {
      // Replay exactly the missed rows before the status event (no gaps, no duplicates).
      for (const row of deps.db.getHistorySince(afterId)) {
        writeHistoryEvent(res, row, byId.get(row.item_id)?.slug ?? "(unknown)");
        last = Math.max(last, row.id);
      }
    }
    const payload = statusPayload();
    sendStatus(res, payload);
    const client: SseClient = {
      res,
      lastEventId: Math.max(afterId ?? 0, last),
      fingerprint: fingerprintOf(payload.items, payload.inbox.claimable, payload.lock),
    };
    clients.add(client);
    res.on("close", () => clients.delete(client));
  }

  /**
   * One poll tick — the single DB poll fanned out to every connected client.
   * DB read failures are swallowed (counter + stderr notice from the 5th),
   * mirroring `wb watch`'s pollOnce; clients stay open.
   */
  function flush(): void {
    let snap: ReturnType<FactoryDb["getWatchSnapshot"]>;
    try {
      snap = deps.db.getWatchSnapshot(cursor);
      consecutiveReadFailures = 0;
    } catch {
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures >= READ_FAILURE_NOTICE_THRESHOLD) {
        console.error("factory: db read failed (repeated) — still polling");
      }
      return;
    }
    const byId = new Map(snap.items.map((i) => [i.id, i] as const));
    for (const client of clients) {
      for (const row of snap.historySince) {
        if (row.id <= client.lastEventId) continue;
        client.lastEventId = row.id;
        writeHistoryEvent(client.res, row, byId.get(row.item_id)?.slug ?? "(unknown)");
      }
    }
    cursor = snap.maxHistoryId ?? cursor;
    if (clients.size === 0) return;
    // Status resend: compute the change fingerprint once, resend the full
    // payload to every client whose copy is stale (no client-side merge).
    const claimable = classifyInbox(deps.db, deps.paths.inbox).claimable;
    const lock = readLockInfo(deps.root);
    const fingerprint = fingerprintOf(snap.items, claimable, lock);
    if (![...clients].some((c) => c.fingerprint !== fingerprint)) return;
    const payload = statusPayload();
    for (const client of clients) {
      if (client.fingerprint === fingerprint) continue;
      sendStatus(client.res, payload);
      client.fingerprint = fingerprint;
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    for (const client of clients) {
      clients.delete(client);
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
  }

  // ------------------------------------------------------------ actions

  /** Shared mutating-action scaffold: factory lock → writable DB → runner →
   *  Orchestrator → body → dispose/close/release (the CLI `withFactory`
   *  lifecycle, minus the inbox claim — claiming belongs to run). */
  async function runAction<T>(body: (ctx: { db: FactoryDb; orch: Orchestrator }) => Promise<T> | T): Promise<T> {
    const release = acquireFactoryLock(deps.root);
    let db: FactoryDb | null = null;
    let orch: Orchestrator | null = null;
    try {
      db = new FactoryDb(deps.root);
      const { runner, curator, publisher, baseCheck } = deps.makeRunner();
      orch = new Orchestrator({
        db,
        paths: deps.paths,
        config: deps.config,
        runner,
        curator,
        publisher,
        sleep,
        baseCheck: baseCheck !== undefined ? baseCheck : new GitBaseFreshnessChecker(),
      });
      return await body({ db, orch });
    } finally {
      try {
        await orch?.dispose();
      } catch (err) {
        // dispose must never block lock release or mask a successful action
        console.error(`factory: runner dispose failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      db?.close();
      release();
    }
  }

  /** Backgrounded run/resume (spec §6.2): lock acquired synchronously; the
   *  claim pass + tick happen in a detached task (awaited in tests); progress
   *  reaches clients only via the SSE stream. */
  async function startRun(kind: "run" | "resume"): Promise<{ started: boolean; busy: boolean; capped?: boolean }> {
    let release: () => void;
    try {
      release = acquireFactoryLock(deps.root);
    } catch (err) {
      if (err instanceof FactoryBusyError) return { started: false, busy: true };
      throw err;
    }
    const task = async (): Promise<{ capped?: boolean }> => {
      let db: FactoryDb | null = null;
      let orch: Orchestrator | null = null;
      try {
        db = new FactoryDb(deps.root);
        const { runner, curator, publisher, baseCheck } = deps.makeRunner();
        orch = new Orchestrator({
          db,
          paths: deps.paths,
          config: deps.config,
          runner,
          curator,
          publisher,
          sleep,
          baseCheck: baseCheck !== undefined ? baseCheck : new GitBaseFreshnessChecker(),
        });
        // The claim pass belongs to run/resume (the openFactory-equivalent),
        // never to serve startup or per-item actions.
        scanInbox(deps.paths, db);
        if (kind === "run") {
          await orch.tickAll();
          return {};
        }
        const report = await orch.resume();
        if (report.capped) {
          // Parity with the CLI's message: the client may need to press resume again.
          console.error("resume hit its safety cap — run `wb resume` again to continue.");
        }
        return { capped: report.capped ?? false };
      } finally {
        try {
          await orch?.dispose();
        } catch {
          /* release must proceed */
        }
        db?.close();
        release();
      }
    };
    if ((deps.runMode ?? "background") === "await") {
      const r = await task();
      return { started: true, busy: false, ...(r.capped !== undefined ? { capped: r.capped } : {}) };
    }
    void task().catch((err) =>
      console.error(`factory: background ${kind} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    return { started: true, busy: false };
  }

  function requireItem(db: FactoryDb, id: number): ItemRecord {
    const item = db.getItem(id);
    if (!item) throw new HttpError(404, { error: `unknown item id ${id}` });
    return item;
  }

  async function handleItemAction(
    req: IncomingMessage,
    res: ServerResponse,
    id: number,
    verb: "approve" | "reject" | "answer" | "retry",
  ): Promise<void> {
    const body = await readJsonBody(req);
    const item = await runAction(async ({ db, orch }) => {
      const found = requireItem(db, id);
      try {
        switch (verb) {
          case "approve": {
            const note = typeof body.note === "string" && body.note.length > 0 ? body.note : undefined;
            return orch.approve(id, note);
          }
          case "reject": {
            if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
              throw new HttpError(400, { error: "reason is required" });
            }
            return orch.rejectItem(id, body.reason.trim());
          }
          case "answer":
            return answerVerb(db, orch, found, body);
          case "retry":
            return orch.retry(id);
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // Malformed retry with an unfixed file is a validation-shaped outcome
        // (the parse reason must reach the operator), not a conflict.
        if (verb === "retry" && message.startsWith("still malformed:")) {
          throw new HttpError(422, { error: message });
        }
        throw new HttpError(409, { error: message });
      }
    });
    sendJson(res, 200, { item });
  }

  /** Answer: per-question pairs (subset allowed — story 11) validated against
   *  the parked questions, or free-form feedback for questionless parks. The
   *  orchestrator merges the pairs; unanswered questions re-park as a fresh
   *  needs-human if triage still needs them. */
  function answerVerb(
    _db: FactoryDb,
    orch: Orchestrator,
    found: ItemRecord,
    body: Record<string, unknown>,
  ): ItemRecord {
    const questions = (found.parkedDetail?.questions as string[] | undefined) ?? [];
    if (questions.length > 0) {
      const submitted = body.answers;
      if (!Array.isArray(submitted) || submitted.length === 0) {
        throw new HttpError(400, {
          error: `expected at least one {question, answer} pair; the item has ${questions.length} parked question(s)`,
        });
      }
      const pairs: { question: string; answer: string }[] = [];
      for (const entry of submitted) {
        const a = entry as { question?: unknown; answer?: unknown } | null;
        if (!a || typeof a.question !== "string" || typeof a.answer !== "string" || a.answer.trim().length === 0) {
          throw new HttpError(400, { error: "each answer must be a {question, answer} pair with a non-empty answer" });
        }
        if (!questions.includes(a.question)) {
          throw new HttpError(400, { error: `unknown question: ${a.question}` });
        }
        pairs.push({ question: a.question, answer: a.answer });
      }
      return orch.answer(found.id, pairs);
    }
    const feedback = typeof body.feedback === "string" ? body.feedback : "";
    if (feedback.trim().length === 0) {
      throw new HttpError(400, { error: "the item has no parked questions; provide free-form feedback" });
    }
    return orch.answer(found.id, [], feedback);
  }

  /** The composer's non-interactive IO: with every field supplied the
   *  interactive paths are unreachable; they throw if that ever changes. */
  const serverAuthoringIO: AuthoringIO = {
    isInteractive: false,
    out: () => {},
    err: (msg) => console.error(msg),
    prompt: () => {
      throw new Error("interactive prompt is not reachable in explicit-field mode");
    },
    openEditor: () => {
      throw new Error("editor is not reachable in explicit-field mode");
    },
    readPipedStdin: () => {
      throw new Error("piped stdin is not reachable in explicit-field mode");
    },
  };

  async function handleComposer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    // Field validation in a fixed order, reusing the CLI's validators verbatim.
    const errors: { field: string; reason: string }[] = [];
    const title = typeof body.title === "string" ? body.title : "";
    if (title.trim().length === 0) errors.push({ field: "title", reason: "title is required" });
    const repoRaw = typeof body.repo === "string" ? body.repo : "";
    let repo = "";
    if (repoRaw.trim().length === 0) {
      errors.push({ field: "repo", reason: "repo is required" });
    } else {
      repo = path.resolve(repoRaw);
      const v = validateRepoPath(repo);
      if (!v.ok) errors.push({ field: "repo", reason: v.reason });
    }
    const base = typeof body.base === "string" && body.base.trim().length > 0 ? body.base.trim() : "main";
    if (typeof body.base === "string" && body.base.trim().length === 0) {
      errors.push({ field: "base", reason: "base branch must be non-empty" });
    }
    let approvalsJoined = "";
    if (body.approvals !== undefined) {
      if (!Array.isArray(body.approvals) || body.approvals.some((a) => typeof a !== "string")) {
        errors.push({ field: "approvals", reason: "approvals must be a list of stage names" });
      } else {
        const r = parseApprovalsInput((body.approvals as string[]).join(","));
        if (!r.ok) errors.push({ field: "approvals", reason: r.reason });
        else approvalsJoined = (body.approvals as string[]).join(",");
      }
    }
    const description = typeof body.description === "string" ? body.description : "";
    if (description.trim().length === 0) errors.push({ field: "description", reason: "description is required" });
    if (errors.length > 0) throw new HttpError(422, { errors });

    // authorItem is the single authoring path (same validation, serialization,
    // slug rules, and exclusive-create as `wb new`).
    const result = await runAction(async ({ db }) =>
      authorItem({ title, repo, base, approvals: approvalsJoined, description }, db, deps.paths, serverAuthoringIO),
    );
    if (!result.ok) {
      // Composite backstop (duplicate slug, exclusive-create EEXIST, ...).
      throw new HttpError(422, { errors: [{ field: "item", reason: result.reason }] });
    }
    let runStarted = false;
    let runBusy = false;
    if (body.runNow === true) {
      const r = await startRun("run");
      runStarted = r.started;
      runBusy = r.busy;
    }
    sendJson(res, 201, {
      ok: true,
      file: result.file,
      slug: result.slug,
      runStarted,
      ...(runBusy ? { runBusy: true } : {}),
    });
  }

  async function handleDrop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (typeof body.filename !== "string" || typeof body.content !== "string") {
      throw new HttpError(400, { error: "filename and content are required" });
    }
    // A path-shaped name is rejected outright (KB 2026-11-02 22:31
    // path-injection class): only a plain, charset-safe .md basename may
    // name an inbox file. basename afterwards is a no-op belt-and-suspenders.
    if (path.basename(body.filename) !== body.filename) {
      throw new HttpError(400, {
        error: `invalid file name: ${body.filename} — use a plain .md file name like my-item.md`,
      });
    }
    const filename = path.basename(body.filename);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i.test(filename)) {
      throw new HttpError(400, {
        error: `invalid file name: ${filename} — expected a .md name like my-item.md`,
      });
    }
    await runAction(async () => {
      mkdirSync(deps.paths.inbox, { recursive: true });
      try {
        // Byte-exact, unparsed ("as-is"): claim/malformed semantics belong to
        // the inbox scanner. Exclusive create — no silent clobbering.
        writeFileSync(path.join(deps.paths.inbox, filename), body.content as string, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new HttpError(409, { error: `inbox already has ${filename} — claim it first (Run) and drop again` });
        }
        throw err;
      }
    });
    sendJson(res, 201, { ok: true, file: path.join("inbox", filename) });
  }

  /** Artifact serving with containment (spec §6.4): reject absolute inputs
   *  and `..` segments before resolving, resolve+prefix-check against the
   *  root, allowlist the served prefix to items/, then serve as markdown. */
  function handleArtifact(url: URL, res: ServerResponse): void {
    const requested = url.searchParams.get("path");
    if (requested === null || requested.length === 0) {
      sendJson(res, 400, { error: "path query parameter is required" });
      return;
    }
    if (path.isAbsolute(requested) || requested.split(/[\\/]/).includes("..")) {
      sendJson(res, 403, { error: "path is not allowed" });
      return;
    }
    const abs = path.resolve(deps.root, requested);
    const rel = path.relative(deps.root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      sendJson(res, 403, { error: "path escapes the factory root" });
      return;
    }
    if (!(rel.startsWith("items/"))) {
      sendJson(res, 403, { error: "only artifact files under items/ are served" });
      return;
    }
    let isFile: boolean;
    try {
      isFile = statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      sendJson(res, 404, { error: "no such artifact file" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(abs));
  }

  async function handleRun(req: IncomingMessage, res: ServerResponse, kind: "run" | "resume"): Promise<void> {
    await readJsonBody(req);
    const r = await startRun(kind);
    if (r.busy) {
      throw new HttpError(409, {
        busy: true,
        error: "factory is busy — another wb command or run holds the lock",
        lock: lockPayload(),
      });
    }
    sendJson(res, 202, { started: true, ...(r.capped !== undefined ? { capped: r.capped } : {}) });
  }

  // ------------------------------------------------------------ routing

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    if (method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, statusPayload());
      return;
    }
    if (method === "GET" && url.pathname === "/api/events") {
      handleEvents(req, res, url);
      return;
    }
    if (method === "GET" && url.pathname === "/api/template") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(ITEM_TEMPLATE);
      return;
    }
    if (method === "GET" && url.pathname === "/api/artifact") {
      handleArtifact(url, res);
      return;
    }
    if (method === "POST" && url.pathname === "/api/items") {
      await handleComposer(req, res);
      return;
    }
    if (method === "POST" && url.pathname === "/api/items/drop") {
      await handleDrop(req, res);
      return;
    }
    const m = /^\/api\/items\/([1-9]\d*)\/(approve|reject|answer|retry)$/.exec(url.pathname);
    if (method === "POST" && m) {
      await handleItemAction(req, res, Number(m[1]), m[2] as "approve" | "reject" | "answer" | "retry");
      return;
    }
    if (method === "POST" && url.pathname === "/api/run") {
      await handleRun(req, res, "run");
      return;
    }
    if (method === "POST" && url.pathname === "/api/resume") {
      await handleRun(req, res, "resume");
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body);
        return;
      }
      if (err instanceof FactoryBusyError) {
        sendJson(res, 409, { error: err.message, lock: lockPayload() });
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  }

  return { handler, flush, stop };
}

// ---------------------------------------------------------------- helpers

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(400, { error: `request body too large (limit ${MAX_BODY_BYTES} bytes)` }));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, { error: "request body must be a JSON object" }));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, { error: "request body is not valid JSON" }));
      }
    });
    req.on("error", () => reject(new HttpError(400, { error: "request body could not be read" })));
  });
}

// ---------------------------------------------------------------- CLI entry

/** Default production runner wiring — identical per-command lifecycle to the
 *  CLI's `openFactory` (constructed per mutating action, never at startup). */
function defaultMakeRunner(config: FactoryConfig): NonNullable<ServeAppDeps["makeRunner"]> {
  return () => ({
    runner: new SandcastleStageRunner({ config, env: agentEnvFor(config) }),
    curator: new SandcastleCurator({ config, env: agentEnvFor(config) }),
    publisher: new GhPrPublisher(),
  });
}

/**
 * `wb serve` entry point — mirrors the `watch` command's skeleton: resolve
 * config/root, refuse a fresh root exactly like status/watch, open the DB
 * read-only, serve, keep alive until SIGINT (clean exit 0).
 */
export async function runServe(opts: {
  root?: string;
  port?: string;
  host?: string;
  interval?: string;
}): Promise<void> {
  const intervalSec = parseIntervalSeconds(opts.interval);
  const { config, root } = loadConfig(opts.root);
  if (!existsSync(path.join(root, "factory.db"))) {
    console.log(`no factory.db in ${root} yet — it is created by any write command (e.g. \`wb new\` or \`wb run\`)`);
    return;
  }
  const db = FactoryDb.openReadonly(root);
  try {
    const app = createServeApp({
      root,
      paths: makePaths(root),
      config,
      db,
      makeRunner: defaultMakeRunner(config),
      intervalMs: intervalSec * 1000,
    });
    const port = Number(opts.port ?? String(DEFAULT_SERVE_PORT));
    const host = opts.host ?? DEFAULT_SERVE_HOST;
    const server = http.createServer((req, res) => app.handler(req, res));
    server.listen(port, host);
    console.log(`wb serve — http://${host}:${port} · Ctrl+C to stop`);
    nodeProcess.on("SIGINT", () => {
      app.stop();
      server.close();
      db.close();
      nodeProcess.exit(0);
    });
    // Keep the command alive until Ctrl+C (mirror `wb watch`).
    await new Promise<never>(() => {});
  } finally {
    db.close();
  }
}
