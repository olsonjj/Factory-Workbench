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
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodeProcess from "node:process";

import { loadConfig, type FactoryConfig } from "../config.js";
import { makePaths, type FactoryPaths } from "../paths.js";
import { FactoryDb, type HistoryFeedRow, type WatchSnapshot } from "../db.js";
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
import { authorItem, expandRepoInput, validateRepoPath, type AuthoringIO } from "../new.js";
import { scanInbox } from "../inbox.js";
import { GitBaseFreshnessChecker, type BaseFreshnessChecker } from "../baseFreshness.js";
import { parseIntervalSeconds } from "../watch.js";
import { sleep } from "../util.js";
import { buildStatusPayload, statusFingerprint, type StatusPayload } from "../status.js";
import { SandcastleStageRunner, GhPrPublisher, SandcastleCurator, agentEnvFor } from "../adapters/sandcastle.js";
import { PAGE_HTML } from "./page.js";

export const DEFAULT_SERVE_PORT = 7466;
export const DEFAULT_SERVE_HOST = "127.0.0.1";
/** Bodies larger than this are rejected before parsing (composer markdown, drops). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Reconnect replay cap: a client returning after a long disconnect gets at
 *  most this many missed history rows; anything older is dropped in favor of
 *  the fresh `status` snapshot, which is authoritative for current state. The
 *  bound is enforced in the replay query itself (SQL LIMIT via
 *  `getRecentHistorySince`), never by post-fetch slicing (rework finding 6). */
export const MAX_SSE_REPLAY_ROWS = 500;

/** Maximum bytes handed to a socket per write call. Large chunks are split so
 *  that `write() → false` reflects actual socket backpressure rather than
 *  merely "this chunk was big", and the drain-resume queue bounds our part. */
const MAX_SSE_WRITE_SLICE_BYTES = 64 * 1024;
/** From the 5th consecutive failing DB read, surface once per failing poll (watch parity). */
const READ_FAILURE_NOTICE_THRESHOLD = 5;
/** Strict CSP emitted on every response (page, API JSON, SSE, artifacts,
 *  errors alike): nothing loads or connects anywhere but self, inline
 *  style/script only. Defense-in-depth for a localhost control surface —
 *  combined with the self-contained page (no remote code) it means a
 *  compromised/remote resource can never run or exfiltrate (rework per KB
 *  2026-11-06 16:40). */
export const SERVE_CSP =
  "default-src 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";

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
  /** Per-client SSE write-backlog cap in bytes (default 2 MiB). A client whose
   *  socket stops draining is cut once its backlog exceeds this; reconnect
   *  replay (bounded) is the recovery path. */
  maxClientBufferedBytes?: number;
  clock?: { now(): number };
  /** "background" (prod): run/resume answer 202 immediately. "await" (tests): answer after completion. */
  runMode?: "background" | "await";
  /** The address the server is bound to (runServe passes `--host`). API requests
   *  with a Host header naming anything other than 127.0.0.1 / localhost / this
   *  host are rejected (CSRF + DNS-rebinding guard; see checkApiRequest). */
  bindHost?: string;
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
  /** Chunks queued but not yet handed to the socket (delivery paused after
   *  backpressure — see clientWrite), as UTF-8 Buffers so slicing never splits
   *  a multi-byte character. Always bounded by the backlog cap. A healthy
   *  draining reader never grows this: `drain` resumes delivery, so large
   *  snapshots flow to it in slices no matter how big they are. */
  queue: Buffer[];
  queuedBytes: number;
  /** Bytes handed to Node's write buffer that Node has not yet drained to
   *  the socket (slices written while write() → false). Zeroed on `drain` —
   *  every byte Node held has reached the socket — so the backlog cap counts
   *  only bytes still in flight, never bytes the client already received. */
  pendingBytes: number;
  /** Set when the client is cut (or gone); further writes are no-ops. */
  closed?: boolean;
}

// ---------------------------------------------------------------- app factory

export function createServeApp(deps: ServeAppDeps): ServeApp {
  const intervalMs = deps.intervalMs ?? 2000;
  const maxClientBufferedBytes = deps.maxClientBufferedBytes ?? 2 * 1024 * 1024;
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

  /** One payload per tick, built from the read snapshot the poller already
   *  holds (rework finding 2): the snapshot's items and `maxHistoryId` are
   *  reused; the payload build adds only the artifacts/known-repos reads and
   *  the inbox scan + lock read, each exactly once per tick. */
  function payloadFromSnapshot(snap: WatchSnapshot): StatusPayload {
    return buildStatusPayload({ root: deps.root, paths: deps.paths, db: deps.db, clock, snapshot: snap });
  }

  /** Serialize one history row to its SSE wire chunk. Built once and shared
   *  by every client (hoisted serialization — a fan-out tick writes each
   *  row's chunk once, not once per client). */
  function historyChunk(row: HistoryFeedRow, slug: string): string {
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
    return `id: ${row.id}\nevent: history\ndata: ${data}\n\n`;
  }

  /** Serialize one status payload to its SSE wire chunk (hoisted so a tick
   *  serializes it once for all clients, not once per client). */
  function statusChunk(payload: StatusPayload): string {
    return `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  /** Deliver `chunk` to a connected SSE client through the per-client backlog
   *  gate. The event is encoded to UTF-8 ONCE (byte-slicing Buffer slices
   *  later can never split a multi-byte character); chunks go out in slices;
   *  backpressure (write() → false — which a large slice triggers even on a
   *  healthy, actively-draining reader) stops further writes and resumes on
   *  `drain` (which zeroes pendingBytes). The in-flight slice is NOT retried
   *  — Node buffered it and will deliver it exactly once — only the remaining
   *  queue waits. A reader that never drains accumulates pending+queued bytes
   *  past the cap across ticks and is then cut; its reconnect (bounded replay)
   *  is the recovery path. Either way server memory stays bounded and no
   *  healthy, draining reader is ever cut. */
  function clientWrite(client: SseClient, chunk: string): void {
    if (client.closed) return;
    const buf = Buffer.from(chunk, "utf8");
    client.queue.push(buf);
    client.queuedBytes += buf.length;
    drainQueue(client);
  }

  /** Hand queued slices to the socket until it reports backpressure; `drain`
   *  resumes (and zeroes pendingBytes). Both outcomes consume the slice: `ok`
   *  means the socket took it; `false` means Node buffered it for assured
   *  delivery — retrying an already-buffered slice would deliver it twice,
   *  once per retry. */
  function drainQueue(client: SseClient): void {
    while (!client.closed && client.queue.length > 0) {
      const head = client.queue[0]!;
      const slice = head.length <= MAX_SSE_WRITE_SLICE_BYTES ? head : head.subarray(0, MAX_SSE_WRITE_SLICE_BYTES);
      let ok: boolean;
      try {
        ok = client.res.write(slice);
      } catch {
        return; // already-gone socket — the `close` handler removes the client
      }
      client.queuedBytes -= slice.length;
      if (ok) {
        if (slice.length === head.length) client.queue.shift();
        else client.queue[0] = head.subarray(slice.length);
      } else {
        client.pendingBytes += slice.length;
        if (slice.length === head.length) client.queue.shift();
        else client.queue[0] = head.subarray(slice.length);
        if (client.pendingBytes + client.queuedBytes > maxClientBufferedBytes) {
          cutClient(client, "write backlog exceeded cap");
        }
        return; // socket backpressured; `drain` resumes the queue
      }
    }
  }

  function cutClient(client: SseClient, why: string): void {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    try {
      client.res.destroy();
    } catch {
      /* already gone */
    }
    console.error(`factory: sse client cut (${why}) — it can reconnect for a bounded replay`);
  }

  /** SSE connect: optional bounded replay (afterId / Last-Event-ID), then one
   *  full status snapshot. Read-only; no factory lock. The payload is built
   *  once from the same snapshot read — no second items/inbox/lock pass. */
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
    const payload = payloadFromSnapshot(snap);
    const byId = new Map(snap.items.map((i) => [i.id, i] as const));
    let last = snap.maxHistoryId ?? 0;
    const client: SseClient = {
      res,
      lastEventId: Math.max(afterId ?? 0, last),
      fingerprint: statusFingerprint(payload),
      queue: [],
      queuedBytes: 0,
      pendingBytes: 0,
    };
    // Backpressure resumes queued delivery; `close` removes the client from
    // the fan-out on every other path.
    // Backpressure resume AND ledger reset: 'drain' means every byte Node
    // held reached the socket, so pendingBytes returns to zero before queued
    // work resumes — without this, the cap would count bytes the client
    // already received and healthy tabs would eventually be cut.
    res.on("drain", () => {
      client.pendingBytes = 0;
      drainQueue(client);
    });
    res.on("close", () => {
      clients.delete(client);
      client.closed = true;
    });
    if (afterId !== null) {
      // Replay exactly the missed rows before the status event (no gaps, no
      // duplicates). The read is bounded in the query itself — SQL LIMIT via
      // `getRecentHistorySince`, at most MAX_SSE_REPLAY_ROWS rows — so a
      // far-behind client costs O(cap) DB rows, never O(table); beyond the
      // cap the snapshot below is the whole truth.
      const replay = deps.db.getRecentHistorySince(afterId, MAX_SSE_REPLAY_ROWS);
      for (const row of replay) {
        clientWrite(client, historyChunk(row, byId.get(row.item_id)?.slug ?? "(unknown)"));
        last = Math.max(last, row.id);
      }
      client.lastEventId = Math.max(client.lastEventId, last);
    }
    clientWrite(client, statusChunk(payload));
    // A client cut by the backlog cap during its own connect writes (e.g. a
    // huge replay to an already-stalled socket) must not join the fan-out.
    if (!client.closed) clients.add(client);
    // Advance the poller's cursor to the least-ahead connected client so the
    // first tick after an idle (zero-client) period never re-fetches rows
    // everyone has already seen. Safe because every client's position is ≥ the
    // cursor (connect snapshots deliver everything up to `last`; per-tick
    // delivery never falls behind the fetched window).
    if (clients.size > 0) {
      cursor = Math.max(cursor, Math.min(...[...clients].map((c) => c.lastEventId)));
    }
  }
  /**
   * One poll tick — the single DB poll fanned out to every connected client.
   * Zero clients ⇒ zero work: no snapshot read, no payload build (rework
   * finding 3 — an idle open tab must not cost a whole-store rescan).
   * The ENTIRE read step — snapshot, payload build (artifacts + known repos),
   * fingerprint — sits inside one guarded block: a failed artifacts or repo
   * read throws inside this synchronous interval callback and would kill the
   * whole server (including any background run). On a failed step the cursor
   * is NOT advanced, so the next tick re-fetches the same window once reads
   * recover; failures are counted and reported like `wb watch`'s pollOnce.
   */
  function flush(): void {
    if (clients.size === 0) return;
    const rowChunks = new Map<number, string>();
    let snap: WatchSnapshot;
    let payload: StatusPayload;
    let fingerprint: string;
    let chunk: string;
    let byId: Map<number, ItemRecord>;
    try {
      snap = deps.db.getWatchSnapshot(cursor);
      payload = payloadFromSnapshot(snap);
      consecutiveReadFailures = 0;
      fingerprint = statusFingerprint(payload);
      byId = new Map(snap.items.map((i) => [i.id, i] as const));
      chunk = statusChunk(payload);
    } catch {
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures >= READ_FAILURE_NOTICE_THRESHOLD) {
        console.error("factory: db read failed (repeated) — still polling");
      }
      return;
    }
    // Advance the cursor only after the whole read step succeeded (see above).
    cursor = snap.maxHistoryId ?? cursor;
    // Hoisted wire serialization: each row's chunk and the status chunk are
    // built once per tick, before the per-client loop — a fan-out to N clients
    // serializes each event once, not N times.
    for (const row of snap.historySince) {
      rowChunks.set(row.id, historyChunk(row, byId.get(row.item_id)?.slug ?? "(unknown)"));
    }
    for (const client of clients) {
      for (const row of snap.historySince) {
        if (row.id <= client.lastEventId) continue;
        client.lastEventId = row.id;
        clientWrite(client, rowChunks.get(row.id)!);
      }
      if (client.fingerprint === fingerprint) continue;
      clientWrite(client, chunk);
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

  /** Lock + writable DB only — for endpoints that need no orchestrator
   *  (composer, drop): the runner wiring stays lazy, constructed only by the
   *  actions that actually drive stages. The CLI `withFactory` lifecycle minus
   *  the inbox claim — claiming belongs to run. */
  async function withLockedDb<T>(body: (db: FactoryDb) => Promise<T> | T): Promise<T> {
    const release = acquireFactoryLock(deps.root);
    let db: FactoryDb | null = null;
    try {
      db = new FactoryDb(deps.root);
      return await body(db);
    } finally {
      db?.close();
      release();
    }
  }

  /** Full mutating-action scaffold: withLockedDb plus the runner + Orchestrator
   *  for endpoints that drive stage transitions. */
  async function runAction<T>(body: (ctx: { db: FactoryDb; orch: Orchestrator }) => Promise<T> | T): Promise<T> {
    return withLockedDb(async (db) => {
      const { runner, curator, publisher, baseCheck } = deps.makeRunner();
      const orch = new Orchestrator({
        db,
        paths: deps.paths,
        config: deps.config,
        runner,
        curator,
        publisher,
        sleep,
        baseCheck: baseCheck !== undefined ? baseCheck : new GitBaseFreshnessChecker(),
      });
      try {
        return await body({ db, orch });
      } finally {
        try {
          await orch.dispose();
        } catch (err) {
          // dispose must never block lock release or mask a successful action
          console.error(`factory: runner dispose failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  }

  /** Backgrounded run/resume (spec §6.2): lock acquired synchronously; the
   *  claim pass + drive-until-parked (`Orchestrator.resume()`) happen in a
   *  detached task (awaited in tests); progress reaches clients only via the
   *  SSE stream. Both verbs ("run" and "resume") drive identically — the web
   *  Run button maps to the same resume loop the CLI's `wb resume` runs. */
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
        const report = await orch.resume();
        if (report.capped) {
          // Parity with the CLI's message: the client may need to press Run again.
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

  /** Same-origin guard for `/api/*` requests (spec: Request hardening): the
   *  Host header must name the loopback binding (or the configured --host)
   *  with the bound port, and an Origin header, when present, must match it.
   *  A CSRF page cannot forge Host, and a DNS-rebinding hostname never passes
   *  the allowlist — the localhost binding plus this check is the boundary
   *  (KB 2026-11-06 16:28). */
  function checkApiRequest(req: IncomingMessage): void {
    const localPort = (req.socket as { localPort?: number } | undefined)?.localPort;
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== "string" || hostHeader.length === 0) {
      throw new HttpError(403, { error: "missing Host header" });
    }
    const allowedHosts = new Set(["127.0.0.1", "localhost"]);
    if (deps.bindHost && deps.bindHost.length > 0) {
      allowedHosts.add(deps.bindHost);
      if (deps.bindHost.includes(":")) allowedHosts.add(`[${deps.bindHost}]`);
    }
    let hostname: string;
    let port: number;
    if (hostHeader.startsWith("[")) {
      // IPv6 hosts serialize bracketed: [::1]:7466
      const close = hostHeader.indexOf("]");
      if (close === -1) throw new HttpError(403, { error: "malformed Host header" });
      hostname = hostHeader.slice(0, close + 1);
      const rest = hostHeader.slice(close + 1);
      port = rest.startsWith(":") ? Number(rest.slice(1)) : 80;
    } else {
      const colon = hostHeader.lastIndexOf(":");
      if (colon === -1) {
        hostname = hostHeader;
        port = 80; // no port means the scheme default
      } else {
        hostname = hostHeader.slice(0, colon);
        port = Number(hostHeader.slice(colon + 1));
      }
    }
    if (!allowedHosts.has(hostname)) {
      throw new HttpError(403, { error: `Host not allowed: ${hostname}` });
    }
    if (localPort !== undefined && port !== localPort) {
      throw new HttpError(403, { error: "Host header does not match the served port" });
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const o = origin.replace(/\/+$/, "");
      if (o !== `http://${hostHeader}`) {
        throw new HttpError(403, { error: "Origin not allowed" });
      }
    }
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
      // Same expansion the CLI's authoring path uses: `~`/`~/sub` against the
      // operator's home, a bare known-repo name (newest-first tie-break), and
      // relative paths against the factory root — never the serve process CWD.
      repo = expandRepoInput(repoRaw, { baseDir: deps.root, knownRepos: deps.db.knownReposNewestFirst() });
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
    // slug rules, and exclusive-create as `wb new`). No orchestrator is needed —
    // the composer only writes the inbox file.
    const result = await withLockedDb((db) =>
      authorItem({ title, repo, base, approvals: approvalsJoined, description }, db, deps.paths, serverAuthoringIO),
    );
    if (!result.ok) {
      // Composite backstop (duplicate slug, exclusive-create EEXIST, ...).
      throw new HttpError(422, { errors: [{ field: "item", reason: result.reason }] });
    }
    let runStarted = false;
    let runBusy = false;
    if (body.runNow === true) {
      const r = await startRun("resume");
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
    await withLockedDb(async () => {
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
   *  root, allowlist the served prefix to items/, reject symlinks via lstat,
   *  re-verify containment on the realpath'd pair (root, file) so symlinked
   *  intermediate directories cannot escape, then serve as markdown. The
   *  containment checks stay synchronous; the file read itself is async so a
   *  large artifact never blocks the tick loop (rework finding 5). */
  async function handleArtifact(url: URL, res: ServerResponse): Promise<void> {
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
    // lstat (not stat): a symlink is not a regular file here — symlinks are
    // rejected outright rather than followed.
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(abs);
    } catch {
      st = null;
    }
    if (st === null || !st.isFile()) {
      sendJson(res, 404, { error: "no such artifact file" });
      return;
    }
    // realpath hardening: intermediate directories may still be symlinks
    // (lstat follows them). Resolve both sides and repeat the containment
    // check on the real paths before reading.
    let realAbs: string;
    let realRoot: string;
    try {
      realAbs = realpathSync(abs);
      realRoot = realpathSync(deps.root);
    } catch {
      sendJson(res, 404, { error: "no such artifact file" });
      return;
    }
    const realRel = path.relative(realRoot, realAbs);
    if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) {
      sendJson(res, 403, { error: "path escapes the factory root" });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(realAbs);
    } catch {
      // Verified regular file a moment ago; it vanished (or became unreadable)
      // between the check and the read.
      sendJson(res, 404, { error: "no such artifact file" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(bytes);
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
    if (url.pathname.startsWith("/api/")) {
      checkApiRequest(req);
    }
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
      await handleArtifact(url, res);
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
    res.setHeader("Content-Security-Policy", SERVE_CSP);
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
  // Every mutating endpoint must receive exactly `application/json`: a CSRF
  // page's form/text-plain POSTs use simple content types that would
  // otherwise slip through (KB 2026-11-06 16:28). A charset suffix is allowed.
  const contentType = req.headers["content-type"];
  const mediaType =
    typeof contentType === "string" ? contentType.split(";")[0]?.trim().toLowerCase() : undefined;
  if (mediaType !== "application/json") {
    return Promise.reject(
      new HttpError(415, { error: "Content-Type must be application/json" }),
    );
  }
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

/** Parse `--port`: an integer in 1..65535 (default 7466). Throws a friendly
 *  Error on anything else (runServe prints it and exits 1). */
export function parseServePort(value: string | undefined): number {
  const n = Number(value ?? String(DEFAULT_SERVE_PORT));
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid port "${value ?? String(DEFAULT_SERVE_PORT)}" — expected an integer between 1 and 65535`);
  }
  return n;
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
  let port: number;
  try {
    port = parseServePort(opts.port);
  } catch (err) {
    console.error(`wb serve: ${err instanceof Error ? err.message : String(err)}`);
    nodeProcess.exitCode = 1;
    return;
  }
  const host = (opts.host ?? DEFAULT_SERVE_HOST).trim();
  if (host.length === 0) {
    console.error("wb serve: invalid host — a non-empty --host is required");
    nodeProcess.exitCode = 1;
    return;
  }
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
      bindHost: host,
    });
    const server = http.createServer((req, res) => app.handler(req, res));
    server.on("error", (err: NodeJS.ErrnoException) => {
      // Friendly listen failures (EADDRINUSE, unresolvable host, ...) instead
      // of a raw stack trace from the never-resolving command.
      db.close();
      if (err.code === "EADDRINUSE") {
        console.error(`wb serve: port ${port} on ${host} is already in use — pass --port <n> to pick another`);
      } else {
        console.error(`wb serve: could not listen on ${host}:${port} — ${err.message}`);
      }
      nodeProcess.exit(1);
    });
    server.listen(port, host, () => {
      console.log(`wb serve — http://${host}:${port} · Ctrl+C to stop`);
    });
    nodeProcess.on("SIGINT", () => {
      app.stop();
      server.close();
      db.close();
      nodeProcess.exit(0);
    });
    // Keep the command alive until Ctrl+C (mirror `wb watch`); listen
    // failures terminate via the error handler above.
    await new Promise<never>(() => {});
  } finally {
    db.close();
  }
}
