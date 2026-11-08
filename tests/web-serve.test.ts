/**
 * `wb serve` HTTP-seam tests: real requests against `createServeApp` wired
 * to a temp factory root (real filesystem, real SQLite), matching the prior
 * art — status-readonly (read-only observation, lock semantics), ticket07
 * (fake runners driving real state transitions), watch-integration
 * (read-only snapshot feeds). No internal reach-ins; no Docker, no model
 * calls; SSE ticks driven by `app.flush()` (intervalMs: 0, no real timers).
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  createHarness,
  claim,
  makeOrchestrator,
  ScriptedRunner,
  FakePublisher,
  pass,
  type TestHarness,
  type Script,
} from "./helpers.js";
import { createServeApp, SERVE_CSP, MAX_SSE_REPLAY_ROWS, type ServeApp, type ServeAppDeps } from "../src/web/server.js";
import { FactoryDb } from "../src/db.js";
import { PAGE_HTML } from "../src/web/page.js";
import { ITEM_TEMPLATE, parseItemMarkdown } from "../src/frontmatter.js";
import { classifyInbox } from "../src/status.js";
import { STAGES, type ItemRecord, type StageRequest, type StageResult, type StageRunner } from "../src/types.js";
import { acquireFactoryLock } from "../src/lock.js";
import type { BaseFreshnessChecker, BaseFreshnessResult } from "../src/baseFreshness.js";

const CT = { "Content-Type": "application/json" } as const;
const silentProceed: BaseFreshnessChecker = {
  check: (): BaseFreshnessResult => ({ action: "proceed", message: null, localTip: null, upstreamTip: null }),
};

interface PostBody {
  error?: string;
  errors?: { field: string; reason: string }[];
  item?: ItemRecord;
  lock?: { pid: number; ageMs: number; alive: boolean };
  busy?: boolean;
  started?: boolean;
  capped?: boolean;
  ok?: boolean;
  file?: string;
  slug?: string;
  runStarted?: boolean;
  [key: string]: unknown;
}

interface ServerHarness {
  h: TestHarness;
  app: ServeApp;
  server: http.Server;
  url: string;
  runner: StageRunner;
  /** The readonly observation handle the app polls (deps.db). */
  rodb: FactoryDb;
  stop: () => Promise<void>;
}

const servers: ServerHarness[] = [];
const extraDirs: string[] = [];

async function makeServer(
  script: Script = {},
  extraDeps: Partial<ServeAppDeps> = {},
): Promise<ServerHarness> {
  const h = createHarness();
  const runner = new ScriptedRunner(script);
  const rodb = FactoryDb.openReadonly(h.root);
  const app = createServeApp({
    root: h.root,
    paths: h.paths,
    config: h.config,
    db: rodb,
    makeRunner: () => ({ runner, curator: null, publisher: new FakePublisher(), baseCheck: silentProceed }),
    intervalMs: 0, // no real timers: tests drive app.flush()
    runMode: "await",
    ...extraDeps,
  });
  const server = http.createServer((req, res) => app.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const s: ServerHarness = {
    h,
    app,
    server,
    url,
    runner,
    rodb,
    stop: async () => {
      app.stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rodb.close();
      h.cleanup();
    },
  };
  servers.push(s);
  return s;
}

async function post(url: string, body?: unknown): Promise<{ status: number; body: PostBody }> {
  const res = await fetch(url, { method: "POST", headers: CT, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let parsed: PostBody = {};
  try {
    parsed = JSON.parse(text) as PostBody;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function makeGitRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-serve-repo-"));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  extraDirs.push(dir);
  return dir;
}

/** Park an item test-side through the harness db (watch-integration style). */
function parkAs(h: TestHarness, id: number, patch: Partial<ItemRecord>): ItemRecord {
  h.db.updateItem(id, patch);
  return h.db.getItem(id)!;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop();
  while (extraDirs.length > 0) rmSync(extraDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------- SSE helper

interface SseEvent {
  event: string;
  id: number | null;
  data: string;
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: number | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && id === null) return null;
  return { event, id, data: dataLines.join("\n") };
}

function connectEvents(
  s: ServerHarness,
  opts: { query?: string; lastEventId?: number } = {},
): { events: SseEvent[]; abort: () => void; waitUntil: (pred: (n: number) => boolean, timeoutMs?: number) => Promise<void> } {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  void (async () => {
    const query = opts.query ? `?${opts.query}` : "";
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
    const res = await fetch(`${s.url}/api/events${query}`, { headers, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    // Stateful UTF-8 decode: a multi-byte character split across two network
    // chunks must be reassembled (stream: true), or the harness itself would
    // mangle exactly the byte-boundary property the server is being tested for.
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { buf += decoder.decode(new Uint8Array(0), { stream: false }); break; }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const ev = parseBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (ev) events.push(ev);
      }
    }
  })().catch(() => {
    /* aborted */
  });
  const waitUntil = async (pred: (n: number) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pred(events.length)) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${events.length} SSE events`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { events, abort: () => controller.abort(), waitUntil };
}

// ---------------------------------------------------------------- tests

describe("wb serve: page, template, snapshot (CLI status contract)", () => {
  it("serves the single page and the composer template", async () => {
    const s = await makeServer();
    const page = await fetch(s.url + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe(PAGE_HTML);
    const tmpl = await fetch(s.url + "/api/template");
    expect(tmpl.status).toBe(200);
    expect(tmpl.headers.get("content-type")).toContain("text/markdown");
    expect(await tmpl.text()).toBe(ITEM_TEMPLATE);
    // Observation never takes the factory lock.
    expect(existsSync(path.join(s.h.root, "factory.lock"))).toBe(false);
  });

  it("ships a self-contained page (no remote code) with a strict CSP on every response", async () => {
    // A remote script on a localhost control surface would run same-origin,
    // invisible to the Host/Origin CSRF guards (KB 2026-11-06 16:40 + rework):
    // the page must carry its own styles and reference nothing off-box.
    expect(PAGE_HTML).not.toContain("cdn.tailwindcss.com");
    expect(PAGE_HTML).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(PAGE_HTML).not.toContain("https://");
    expect(PAGE_HTML).not.toContain("http://");
    expect(PAGE_HTML).toContain("<style>");
    // Header run-state pill: the SSE render path writes into #run-state, and
    // the per-second clock tick and glance-chip flash class are the pieces a
    // refactor could silently drop (full behavior covered in
    // tests/web-page-runtime.test.ts).
    expect(PAGE_HTML).toContain('id="run-state"');
    expect(PAGE_HTML).toMatch(/setInterval\([\s\S]*?1000\)/);
    expect(PAGE_HTML).toContain("wb-flash");
    // Run-state machine: the shared single-flight Run path and the
    // reduced-motion degradation are the pieces a refactor could silently
    // drop (full behavior covered in tests/web-page-runtime.test.ts).
    expect(PAGE_HTML).toContain("pressRun");
    expect(PAGE_HTML).toContain("prefers-reduced-motion");
    // Glance collapse: the collapsed-by-default section ships the body
    // container and the summary-button hook (behavior covered in
    // tests/web-page-runtime.test.ts).
    expect(PAGE_HTML).toContain('id="glance-body"');
    expect(PAGE_HTML).toContain("data-glance-summary");
    // Combobox: the known-repos datalist options carry a per-repo item-count
    // label (escaped), and the repo input advertises the accepted forms.
    expect(PAGE_HTML).toContain("repos-dl");
    expect(PAGE_HTML).toContain("k.count === 1 ? ' item' : ' items'");
    expect(PAGE_HTML).toContain("placeholder=\"repo name, Code/rel/path, ~/path, or /abs/path\"");
    // Start Processing button: the renamed label, the renamed composer
    // checkbox wording, and the spinner/disabled CSS are the static pieces a
    // refactor could silently drop (the label/disable lifecycle is covered in
    // tests/web-page-runtime.test.ts).
    expect(PAGE_HTML).toContain("▶ Start Processing");
    expect(PAGE_HTML).toContain("start processing now");
    expect(PAGE_HTML).toContain("wb-spin");
    expect(PAGE_HTML).toContain(".btn:disabled");
    expect(PAGE_HTML).not.toContain(">Run</button>");
    expect(PAGE_HTML).not.toContain("run now — claim");
    const s = await makeServer();
    for (const p of ["/", "/api/status", "/api/template", "/api/nope"]) {
      const res = await fetch(s.url + p);
      expect(res.headers.get("content-security-policy")).toBe(SERVE_CSP);
      await res.body?.cancel();
    }
    const blocked = await fetch(s.url + "/api/artifact?path=../../etc/passwd");
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("content-security-policy")).toBe(SERVE_CSP);
    // The SSE stream response carries it too.
    const ac = new AbortController();
    const sse = await fetch(s.url + "/api/events", {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(sse.headers.get("content-security-policy")).toBe(SERVE_CSP);
    ac.abort();
  });

  it("returns a snapshot whose items/inbox match the shared status layer exactly", async () => {
    const s = await makeServer();
    s.h.inboxFile("add-dark-mode", { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const res = await fetch(s.url + "/api/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const payload = (await res.json()) as {
      root: string;
      maxHistoryId: number | null;
      counts: Record<string, number>;
      stages: string[];
      inbox: { claimable: string[]; alreadyClaimed: unknown[]; error: string | null };
      items: ItemRecord[];
    };
    expect(payload.root).toBe(s.h.root);
    expect(payload.stages).toEqual([...STAGES]);
    const items = s.h.db.listItems();
    expect(payload.items).toHaveLength(items.length);
    const expected = items[0]!;
    const actual = payload.items[0]!;
    for (const key of [
      "id", "slug", "title", "repo", "base", "approvals", "stage", "status", "parkedReason",
      "parkedDetail", "feedback", "answers", "sourceFile", "branchName", "gateAttempts",
      "infraAttempts", "createdAt", "updatedAt",
    ] as const) {
      expect(actual[key]).toEqual(expected[key]);
    }
    const classified = classifyInbox(s.h.db, s.h.paths.inbox);
    expect(payload.inbox.claimable).toEqual(classified.claimable);
    expect(payload.inbox.alreadyClaimed).toHaveLength(classified.alreadyClaimed.length);
    expect(payload.inbox.error).toBeNull();
    expect(payload.counts).toEqual({ decisions: 0, running: 0, queued: 1, inbox: 0, done: 0 });
    expect(payload.maxHistoryId).toBe(s.h.db.getMaxHistoryId());
  });

  it("counts parked items as decisions, carries questions, and reports the lock holder", async () => {
    const s = await makeServer();
    s.h.inboxFile("task", { title: "Feature X", repo: "/tmp/repo", base: "main", approvals: ["spec"] }, "Do feature X.");
    claim(s.h);
    const orch = makeOrchestrator(s.h, new ScriptedRunner({ spec: [pass("spec")] }));
    await orch.tickAll();
    await orch.tickAll(); // parks awaiting-approval after spec (with a spec artifact)
    const id = s.h.db.listItems()[0]!.id;
    parkAs(s.h, id, {
      status: "needs-human",
      stage: "triage",
      parkedReason: "needs-human",
      parkedDetail: { stage: "triage", questions: ["Q one?", "Q two?"] },
    });
    const release = acquireFactoryLock(s.h.root);
    try {
      const payload = (await (await fetch(s.url + "/api/status")).json()) as {
        counts: { decisions: number };
        lock: { pid: number; ageMs: number; alive: boolean } | null;
        items: { status: string; questions?: string[] }[];
      };
      expect(payload.counts.decisions).toBe(1);
      expect(payload.lock).not.toBeNull();
      expect(payload.lock!.pid).toBe(process.pid);
      expect(typeof payload.lock!.ageMs).toBe("number");
      expect(payload.lock!.alive).toBe(true);
      const needsHuman = payload.items.find((i) => i.status === "needs-human")!;
      expect(needsHuman.questions).toEqual(["Q one?", "Q two?"]);
    } finally {
      release();
    }
    // done items carry prUrl/prDraft from parkedDetail (the landing-card PR link)
    parkAs(s.h, id, {
      status: "done",
      parkedReason: null,
      parkedDetail: { prUrl: "https://github.com/x/y/pull/1", prNumber: 1, draft: true },
    });
    const after = (await (await fetch(s.url + "/api/status")).json()) as {
      counts: { decisions: number; done: number };
      items: { prUrl?: string; prDraft?: boolean }[];
    };
    expect(after.counts.decisions).toBe(0);
    expect(after.counts.done).toBe(1);
    expect(after.items[0]!.prUrl).toBe("https://github.com/x/y/pull/1");
    expect(after.items[0]!.prDraft).toBe(true);
  });

  it("includes the parked stage's artifacts on awaiting-approval items", async () => {
    const s = await makeServer();
    s.h.inboxFile("art-view", { title: "Art view", repo: "/tmp/repo", base: "main", approvals: ["spec"] }, "Body.");
    claim(s.h);
    const orch = makeOrchestrator(s.h, new ScriptedRunner({ spec: [pass("spec")] }));
    await orch.tickAll();
    await orch.tickAll(); // awaiting-approval after spec
    const payload = (await (await fetch(s.url + "/api/status")).json()) as {
      items: { status: string; parkedDetail: { stage: string }; artifacts?: { name: string; stage: string | null }[] }[];
    };
    const item = payload.items[0]!;
    expect(item.status).toBe("awaiting-approval");
    expect(item.parkedDetail.stage).toBe("spec");
    expect(item.artifacts!.length).toBeGreaterThan(0);
    expect(item.artifacts!.every((a) => a.stage === "spec")).toBe(true);
  });
});

describe("wb serve: mutation endpoints", () => {
  async function seedAwaitingApproval(s: ServerHarness, baseName: string): Promise<number> {
    s.h.inboxFile(baseName, { title: "Feature X", repo: "/tmp/repo", base: "main", approvals: ["spec"] }, "Do feature X.");
    claim(s.h);
    const orch = makeOrchestrator(s.h, new ScriptedRunner({ spec: [pass("spec")] }));
    await orch.tickAll();
    await orch.tickAll();
    return s.h.db.listItems().find((i) => i.slug === baseName)!.id;
  }

  it("approve (with and without note) re-queues the item, visible from a subsequent snapshot", async () => {
    const s = await makeServer();
    const id = await seedAwaitingApproval(s, "first-approval");
    const r = await post(`${s.url}/api/items/${id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.item!.status).toBe("queued");
    expect(r.body.item!.stage).toBe("implement");
    const payload = (await (await fetch(s.url + "/api/status")).json()) as { items: { status: string }[] };
    expect(payload.items[0]!.status).toBe("queued");
    // approving a non-parked item is a requireStatus rejection → 409 with the message
    const again = await post(`${s.url}/api/items/${id}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("is queued; expected awaiting-approval");
    // with a note
    const id2 = await seedAwaitingApproval(s, "second-approval");
    const withNote = await post(`${s.url}/api/items/${id2}/approve`, { note: "ship it" });
    expect(withNote.status).toBe(200);
    expect(withNote.body.item!.status).toBe("queued");
    const hist = s.h.db.getHistory(id2);
    expect(hist.some((h) => h.event === "approved" && h.detail.note === "ship it")).toBe(true);
  });

  it("reject requires a reason (400) and stores it as feedback (human-rejected)", async () => {
    const s = await makeServer();
    const id = await seedAwaitingApproval(s, "reject-me");
    const noReason = await post(`${s.url}/api/items/${id}/reject`, {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("reason is required");
    const r = await post(`${s.url}/api/items/${id}/reject`, { reason: "spec misses the migration step" });
    expect(r.status).toBe(200);
    expect(r.body.item!.status).toBe("human-rejected");
    expect(r.body.item!.feedback).toBe("spec misses the migration step");
  });

  it("unknown and malformed ids are 404", async () => {
    const s = await makeServer();
    expect((await post(`${s.url}/api/items/999/approve`, {})).status).toBe(404);
    expect((await post(`${s.url}/api/items/0/approve`, {})).status).toBe(404);
    expect((await fetch(`${s.url}/api/items/abc/approve`, { method: "POST" })).status).toBe(404);
  });

  it("retry re-queues infra failures without touching the rework budget", async () => {
    const s = await makeServer();
    s.h.inboxFile("infra-item", { title: "Infra item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    parkAs(s.h, id, {
      status: "infrastructure-failure",
      parkedReason: "infrastructure-failure",
      parkedDetail: { stage: "implement", error: "sandbox down" },
      gateAttempts: { test: 2 },
    });
    const r = await post(`${s.url}/api/items/${id}/retry`, {});
    expect(r.status).toBe(200);
    expect(r.body.item!.status).toBe("queued");
    expect(r.body.item!.gateAttempts).toEqual({ test: 2 }); // rework budget untouched
    // wrong status → 409
    expect((await post(`${s.url}/api/items/${id}/retry`, {})).status).toBe(409);
  });

  it("retry on malformed: 422 while the file is unfixed, re-parses once fixed", async () => {
    const s = await makeServer();
    s.h.inboxFile("broken", { repo: "/tmp/some-repo" }, "This will never parse."); // missing title
    claim(s.h); // parks as malformed at claim
    const id = s.h.db.listItems()[0]!.id;
    expect(s.h.db.getItem(id)!.status).toBe("malformed");
    const unfixed = await post(`${s.url}/api/items/${id}/retry`, {});
    expect(unfixed.status).toBe(422);
    expect(unfixed.body.error).toContain("still malformed: front-matter must include a non-empty `title`");
    // fix the source file, then retry re-parses it
    const item = s.h.db.getItem(id)!;
    s.h.writeFile(item.sourceFile!, "---\ntitle: Fixed now\nrepo: /tmp/repo\n---\n\nBody.\n");
    const r = await post(`${s.url}/api/items/${id}/retry`, {});
    expect(r.status).toBe(200);
    expect(r.body.item!.status).toBe("queued");
    expect(r.body.item!.title).toBe("Fixed now");
  });

  it("answer accepts full sets and subsets; rejects unknown questions; free-form for questionless parks", async () => {
    const s = await makeServer();
    s.h.inboxFile("q-item", { title: "Q item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    parkAs(s.h, id, {
      status: "needs-human",
      stage: "triage",
      parkedReason: "needs-human",
      parkedDetail: { stage: "triage", questions: ["First question?", "Second question?"] },
    });
    // subset (story 11): one pair is enough
    const subset = await post(`${s.url}/api/items/${id}/answer`, {
      answers: [{ question: "Second question?", answer: "yes, read config" }],
    });
    expect(subset.status).toBe(200);
    expect(subset.body.item!.status).toBe("queued");
    expect(subset.body.item!.answers).toEqual([{ question: "Second question?", answer: "yes, read config" }]);
    // full set (matchAnswers outcome) on a fresh park: pairs merge with earlier answers
    parkAs(s.h, id, {
      status: "needs-human",
      stage: "triage",
      parkedReason: "needs-human",
      parkedDetail: { stage: "triage", questions: ["First question?", "Second question?"] },
    });
    const full = await post(`${s.url}/api/items/${id}/answer`, {
      answers: [
        { question: "First question?", answer: "per-IP" },
        { question: "Second question?", answer: "from config" },
      ],
    });
    expect(full.status).toBe(200);
    expect(full.body.item!.answers).toEqual([
      { question: "Second question?", answer: "yes, read config" },
      { question: "First question?", answer: "per-IP" },
      { question: "Second question?", answer: "from config" },
    ]);
    // unknown question string → 400
    parkAs(s.h, id, {
      status: "needs-human",
      stage: "triage",
      parkedReason: "needs-human",
      parkedDetail: { stage: "triage", questions: ["First question?"] },
    });
    const wrong = await post(`${s.url}/api/items/${id}/answer`, {
      answers: [{ question: "Not a parked question?", answer: "x" }],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("unknown question");
    // free-form path: parked without questions → the "(free-form)" pair, as the CLI does
    s.h.inboxFile("free-item", { title: "Free item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const freeId = s.h.db.listItems().find((i) => i.slug === "free-item")!.id;
    parkAs(s.h, freeId, {
      status: "needs-human",
      stage: "triage",
      parkedReason: "needs-human",
      parkedDetail: { stage: "triage", questions: [] },
    });
    const freeform = await post(`${s.url}/api/items/${freeId}/answer`, { feedback: "please clarify the API shape" });
    expect(freeform.status).toBe(200);
    expect(freeform.body.item!.answers).toEqual([{ question: "(free-form)", answer: "please clarify the API shape" }]);
    expect(freeform.body.item!.status).toBe("queued");
  });
});

describe("wb serve: authoring (composer and file drop)", () => {
  function composerBody(repo: string) {
    return {
      title: "Add retry backoff",
      repo,
      base: "main",
      approvals: ["spec"],
      description: "## Goal\nBackoff for webhook delivery.",
    };
  }

  it("writes a valid composed item into the inbox with correct front-matter", async () => {
    const s = await makeServer();
    const repo = makeGitRepo();
    const r = await post(`${s.url}/api/items`, composerBody(repo));
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.slug).toBe("add-retry-backoff");
    expect(r.body.runStarted).toBe(false);
    const file = path.join(s.h.paths.inbox, "add-retry-backoff.md");
    expect(existsSync(file)).toBe(true);
    const parsed = parseItemMarkdown(s.h.readFile(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.item.title).toBe("Add retry backoff");
      expect(parsed.item.repo).toBe(repo);
      expect(parsed.item.base).toBe("main");
      expect(parsed.item.approvals).toEqual(["spec"]);
      expect(parsed.item.body).toContain("Backoff for webhook delivery.");
    }
  });

  it("accepts a ~/-prefixed repo, expanded against the operator's home", async () => {
    const s = await makeServer();
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "wb-serve-home-"));
    extraDirs.push(fakeHome);
    mkdirSync(path.join(fakeHome, "dev", "x", ".git"), { recursive: true });
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const r = await post(`${s.url}/api/items`, composerBody("~/dev/x"));
      expect(r.status).toBe(201);
      const file = path.join(s.h.paths.inbox, "add-retry-backoff.md");
      const parsed = parseItemMarkdown(s.h.readFile(file));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.item.repo).toBe(path.join(fakeHome, "dev", "x"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });

  it("resolves a relative repo against the factory root, not the serve process CWD", async () => {
    const s = await makeServer();
    // A git repo INSIDE the factory root; the test process CWD is a different
    // temp dir, so a 201 here proves resolution used deps.root.
    const repo = path.join(s.h.root, "Code", "x");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const r = await post(`${s.url}/api/items`, composerBody("Code/x"));
    expect(r.status).toBe(201);
    const file = path.join(s.h.paths.inbox, "add-retry-backoff.md");
    const parsed = parseItemMarkdown(s.h.readFile(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.item.repo).toBe(repo);
  });

  it("accepts a bare known-repo name from the dropdown, identical to the absolute path", async () => {
    const repo = makeGitRepo();
    // Seed the known-repos list (what the dropdown is built from) on server A.
    const sa = await makeServer();
    sa.h.db.insertItem({
      slug: "seed", title: "Seed", repo, base: "main",
      approvals: [], stage: "triage", status: "queued",
    });
    const byName = await post(`${sa.url}/api/items`, composerBody(path.basename(repo)));
    expect(byName.status).toBe(201);
    // Server B posts the absolute path with otherwise identical fields.
    const sb = await makeServer();
    const byPath = await post(`${sb.url}/api/items`, composerBody(repo));
    expect(byPath.status).toBe(201);

    const fileA = path.join(sa.h.paths.inbox, "add-retry-backoff.md");
    const fileB = path.join(sb.h.paths.inbox, "add-retry-backoff.md");
    expect(sa.h.readFile(fileA)).toBe(sb.h.readFile(fileB));
    const parsed = parseItemMarkdown(sa.h.readFile(fileA));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.item.repo).toBe(repo);
  });

  it("returns a field-shaped repo error naming the expanded path, in the fixed order", async () => {
    const s = await makeServer();
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "wb-serve-home-"));
    extraDirs.push(fakeHome);
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const r = await post(`${s.url}/api/items`, {
        title: "  ",
        repo: "~/definitely/not/there",
        base: "",
        approvals: ["bogus-stage"],
        description: "",
      });
      expect(r.status).toBe(422);
      expect(r.body.errors!.map((e) => e.field)).toEqual(["title", "repo", "base", "approvals", "description"]);
      const repoErr = r.body.errors!.find((e) => e.field === "repo")!;
      expect(repoErr.reason).toContain(path.join(fakeHome, "definitely", "not", "there"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });

  it("returns field-shaped 422 errors for each invalid field, in order", async () => {
    const s = await makeServer();
    const r = await post(`${s.url}/api/items`, {
      title: "  ",
      repo: "/definitely/not/a/repo",
      base: "",
      approvals: ["spec", "bogus-stage"],
      description: "",
    });
    expect(r.status).toBe(422);
    expect(r.body.errors!.map((e) => e.field)).toEqual(["title", "repo", "base", "approvals", "description"]);
    expect(r.body.errors!.find((e) => e.field === "approvals")!.reason).toContain("unknown approval stage");
  });

  it("reports duplicate slugs as a field-shaped item error", async () => {
    const s = await makeServer();
    const repo = makeGitRepo();
    const first = await post(`${s.url}/api/items`, composerBody(repo));
    expect(first.status).toBe(201);
    claim(s.h); // the slug is now held by a claimed item
    const dup = await post(`${s.url}/api/items`, composerBody(repo));
    expect(dup.status).toBe(422);
    expect(dup.body.errors![0]!.field).toBe("item");
    expect(dup.body.errors![0]!.reason).toContain("already held");
  });

  it("runNow claims and drives the item to its parking spot in the same request", async () => {
    const s = await makeServer();
    const repo = makeGitRepo();
    const r = await post(`${s.url}/api/items`, { ...composerBody(repo), runNow: true });
    expect(r.status).toBe(201);
    expect(r.body.runStarted).toBe(true);
    const item = s.h.db.listItems()[0]!;
    expect(item.slug).toBe("add-retry-backoff");
    expect(item.status).toBe("awaiting-approval"); // the drive parked at the spec approval gate (composerBody asks for it)
    expect(item.parkedDetail).toMatchObject({ stage: "spec" });
    expect(item.stage).toBe("implement"); // stage already advanced to the parked stage's next step
    expect(s.h.db.getHistory(item.id).some((h) => h.event === "claimed")).toBe(true);
  });

  it("drops files byte-exact and rejects bad names, oversize bodies, and collisions", async () => {
    const s = await makeServer();
    const content = "---\ntitle: Dropped\nrepo: /tmp/repo\n---\n\nDropped body.\n";
    const ok = await post(`${s.url}/api/items/drop`, { filename: "dropped.md", content });
    expect(ok.status).toBe(201);
    expect(ok.body.file).toBe(path.join("inbox", "dropped.md"));
    expect(s.h.readFile(path.join(s.h.paths.inbox, "dropped.md"))).toBe(content);
    // traversal / non-.md / dot-prefixed names → 400
    const evil = await post(`${s.url}/api/items/drop`, { filename: "../evil.md", content: "x" });
    expect(evil.status).toBe(400);
    expect((await post(`${s.url}/api/items/drop`, { filename: "no-ext", content: "x" })).status).toBe(400);
    expect((await post(`${s.url}/api/items/drop`, { filename: ".md", content: "x" })).status).toBe(400);
    // oversize body → 400
    const big = await post(`${s.url}/api/items/drop`, { filename: "big.md", content: "x".repeat(2 * 1024 * 1024 + 64) });
    expect(big.status).toBe(400);
    // collision → 409
    const collision = await post(`${s.url}/api/items/drop`, { filename: "dropped.md", content: "y" });
    expect(collision.status).toBe(409);
    expect(collision.body.error).toContain("inbox already has dropped.md");
    // malformed JSON body → 400
    const raw = await fetch(`${s.url}/api/items/drop`, { method: "POST", headers: CT, body: "not json" });
    expect(raw.status).toBe(400);
  });
});

describe("wb serve: lock single-flight and backgrounded run/resume", () => {
  it("answers 409 with lock info from every mutating endpoint while the lock is held", async () => {
    const s = await makeServer();
    s.h.inboxFile("item", { title: "An item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const repo = makeGitRepo();
    const release = acquireFactoryLock(s.h.root);
    try {
      const posts: [string, unknown][] = [
        [`/api/items/${id}/approve`, {}],
        [`/api/items/${id}/reject`, { reason: "nope" }],
        [`/api/items/${id}/retry`, {}],
        [`/api/items/${id}/answer`, { answers: [{ question: "q", answer: "a" }] }],
        ["/api/run", {}],
        ["/api/resume", {}],
        ["/api/items/drop", { filename: "held.md", content: "x" }],
        ["/api/items", { title: "Held item", repo, base: "main", approvals: [], description: "b" }],
      ];
      for (const [urlPath, body] of posts) {
        const r = await post(s.url + urlPath, body);
        expect(r.status, urlPath).toBe(409);
        expect(r.body.lock!.pid).toBe(process.pid);
        expect(typeof r.body.lock!.ageMs).toBe("number");
      }
      expect(s.h.db.listItems()).toHaveLength(1); // nothing mutated
    } finally {
      release();
    }
    // release → run proceeds: claims + drive until parked/done
    const run = await post(`${s.url}/api/run`, {});
    expect(run.status).toBe(202);
    expect(run.body.started).toBe(true);
    expect(s.h.db.listItems()[0]!.status).toBe("done"); // the drive ran the ungated item all the way to done
  });

  it("a concurrent run while one is executing gets 409 single-flight; the first run completes", async () => {
    const h = createHarness();
    const calls: StageRequest[] = [];
    const slowRunner: StageRunner = {
      async runStage(req: StageRequest): Promise<StageResult> {
        calls.push(req);
        await new Promise((r) => setTimeout(r, 250)); // widen the lock window
        return pass(req.stage);
      },
    };
    const rodb = FactoryDb.openReadonly(h.root);
    const app = createServeApp({
      root: h.root,
      paths: h.paths,
      config: h.config,
      db: rodb,
      makeRunner: () => ({ runner: slowRunner, curator: null, publisher: new FakePublisher(), baseCheck: silentProceed }),
      intervalMs: 0,
      runMode: "await",
    });
    const server = http.createServer((req, res) => app.handler(req, res));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      h.inboxFile("slow-item", { title: "Slow item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
      const lockPath = path.join(h.root, "factory.lock");
      const first = fetch(url + "/api/run", { method: "POST", headers: CT, body: "{}" });
      const deadline = Date.now() + 5000;
      while (!existsSync(lockPath)) {
        if (Date.now() > deadline) throw new Error("run never took the lock");
        await new Promise((r) => setTimeout(r, 10));
      }
      const second = await post(url + "/api/run", {});
      expect(second.status).toBe(409);
      expect(second.body.busy).toBe(true);
      expect(second.body.lock!.pid).toBe(process.pid);
      const firstRes = await first;
      expect(firstRes.status).toBe(202);
      expect(calls.map((c) => c.stage)).toEqual(STAGES.slice(0, -1)); // every runner stage ran once; the pr stage goes through the publisher — and the second run executed nothing
      const item = h.db.listItems()[0]!;
      expect(h.db.getHistory(item.id).some((ev) => ev.event === "claimed")).toBe(true);
      expect(item.status).toBe("done");
    } finally {
      app.stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rodb.close();
      h.cleanup();
    }
  });

  it("resume runs to completion and reports the safety cap when hit", async () => {
    const s = await makeServer();
    s.h.inboxFile("res-item", { title: "Res item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    parkAs(s.h, id, { status: "human-rejected", feedback: "fix it" });
    const r = await post(`${s.url}/api/resume`, {});
    expect(r.status).toBe(202);
    expect(r.body.started).toBe(true);
    expect(r.body.capped).toBe(false);
    expect(s.h.db.getItem(id)!.status).toBe("done"); // resumed through to the PR stage
  });

  it("POST /api/run has resume semantics: it revives a human-rejected item and lands it", async () => {
    const s = await makeServer();
    s.h.inboxFile("run-revive", { title: "Run revive", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    parkAs(s.h, id, { status: "human-rejected", feedback: "fix it" });
    const r = await post(`${s.url}/api/run`, {});
    expect(r.status).toBe(202);
    expect(r.body.started).toBe(true);
    expect(r.body.capped).toBe(false);
    expect(s.h.db.getItem(id)!.status).toBe("done"); // the Run button's drive revived and landed the item
    const unparked = s.h.db.getHistory(id).find((h) => h.event === "unparked")!;
    expect((unparked.detail as Record<string, unknown>).via).toBe("resume");
    expect((unparked.detail as Record<string, unknown>).feedback).toBe("fix it");
    // identical state → identical body from both verbs
    const r2 = await post(`${s.url}/api/resume`, {});
    expect(r2.status).toBe(202);
    expect(r2.body).toEqual(r.body);
  });

  it("POST /api/run does not unpark an approval-gated item; the gate still stops the line", async () => {
    const s = await makeServer();
    s.h.inboxFile("gated", { title: "Gated item", repo: "/tmp/repo", base: "main", approvals: ["spec"] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const r = await post(`${s.url}/api/run`, {});
    expect(r.status).toBe(202);
    expect(r.body.started).toBe(true);
    const item = s.h.db.getItem(id)!;
    expect(item.status).toBe("awaiting-approval"); // parked at the spec approval gate
    expect(item.parkedDetail).toMatchObject({ stage: "spec" });
    expect(item.stage).toBe("implement"); // stage already advanced to the parked stage's next step
    expect(s.h.db.getHistory(id).some((h) => h.event === "unparked")).toBe(false);
    // no stage agent ran past the gate
    expect((s.runner as ScriptedRunner).calls.every((c) => c.req.stage === "triage" || c.req.stage === "spec")).toBe(true);
    // a further drive leaves it parked — the approval waits for a human
    const again = await post(`${s.url}/api/run`, {});
    expect(again.status).toBe(202);
    expect(s.h.db.getItem(id)!.status).toBe("awaiting-approval");
    expect(s.h.db.getHistory(id).some((h) => h.event === "unparked")).toBe(false);
  });
});

describe("wb serve: SSE stream (snapshot-then-delta, one poller fanned out)", () => {
  it("delivers the status snapshot first (no id), then history deltas with ids, then a status on change", async () => {
    const s = await makeServer();
    s.h.inboxFile("watched", { title: "Watched item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1);
    const first = stream.events[0]!;
    expect(first.event).toBe("status");
    expect(first.id).toBeNull();
    const snapshot = JSON.parse(first.data) as { maxHistoryId: number; items: ItemRecord[] };
    expect(snapshot.items[0]!.slug).toBe("watched");
    const base = stream.events.length;
    // activity: two history rows + an item state change
    s.h.db.appendHistory(id, "stage-start", "test", { attempt: 2 });
    s.h.db.appendHistory(id, "stage-pass", "test", { nextStage: "review" });
    s.h.db.updateItem(id, { status: "awaiting-approval", stage: "review", parkedReason: "awaiting-approval" });
    s.app.flush();
    await stream.waitUntil((n) => n >= base + 3);
    const rows = stream.events.slice(base, base + 2);
    expect(rows.map((e) => e.event)).toEqual(["history", "history"]);
    const ids = rows.map((e) => e.id);
    expect(ids).toEqual([snapshot.maxHistoryId! + 1, snapshot.maxHistoryId! + 2]);
    expect((JSON.parse(rows[0]!.data) as { event: string; slug: string; itemId: number }).slug).toBe("watched");
    const status = stream.events[base + 2]!;
    expect(status.event).toBe("status");
    expect(status.id).toBeNull();
    expect((JSON.parse(status.data) as { items: ItemRecord[] }).items[0]!.status).toBe("awaiting-approval");
    // no change → no events on the next flushes
    const before = stream.events.length;
    s.app.flush();
    await new Promise((r) => setTimeout(r, 120));
    s.app.flush();
    await new Promise((r) => setTimeout(r, 120));
    expect(stream.events.length).toBe(before);
    stream.abort();
  });

  it("emits a status event when the same lock holder dies without items or inbox changing", async () => {
    const s = await makeServer();
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (holder.pid === undefined) throw new Error("failed to start lock holder");
    const ts = Date.now();
    writeFileSync(path.join(s.h.root, "factory.lock"), JSON.stringify({ pid: holder.pid, ts, id: "dead-holder-test" }));
    const stream = connectEvents(s);
    try {
      await stream.waitUntil((n) => n >= 1);
      const initial = JSON.parse(stream.events[0]!.data) as {
        lock: { pid: number; ts: number; alive: boolean } | null;
        items: unknown[];
        inbox: { claimable: string[] };
      };
      expect(initial.lock).toMatchObject({ pid: holder.pid, ts, alive: true });
      expect(initial.items).toEqual([]);
      expect(initial.inbox.claimable).toEqual([]);

      // Keep pid and ts identical: lock.alive is the ONLY fingerprinted field
      // that changes, and this flush travels through the real SSE poller.
      holder.kill();
      await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
      s.app.flush();
      await stream.waitUntil((n) => n >= 2);
      expect(stream.events).toHaveLength(2);
      expect(stream.events[1]!.event).toBe("status");
      const dead = JSON.parse(stream.events[1]!.data) as typeof initial;
      expect(dead.lock).toMatchObject({ pid: holder.pid, ts, alive: false });
      expect(dead.items).toEqual(initial.items);
      expect(dead.inbox.claimable).toEqual(initial.inbox.claimable);
    } finally {
      stream.abort();
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill();
        await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
      }
    }
  });

  it("resumes from a last-event-id without gaps or duplicates (query param and header)", async () => {
    const s = await makeServer();
    s.h.inboxFile("resume-me", { title: "Resume me", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const first = connectEvents(s);
    await first.waitUntil((n) => n >= 1);
    s.h.db.appendHistory(id, "stage-start", "spec", {});
    s.app.flush();
    await first.waitUntil((n) => n >= 2);
    const lastSeen = first.events[first.events.length - 1]!;
    expect(lastSeen.event).toBe("history");
    first.abort();
    // rows land while "disconnected"
    s.h.db.appendHistory(id, "stage-pass", "spec", { nextStage: "implement" });
    s.h.db.appendHistory(id, "parked", "implement", { reason: "awaiting-approval" });
    // reconnect via the query param: replayed missed rows first, then a fresh snapshot
    const second = connectEvents(s, { query: `afterId=${lastSeen.id}` });
    await second.waitUntil((n) => n >= 3);
    expect(second.events[0]!.event).toBe("history");
    expect(second.events[0]!.id).toBe(lastSeen.id! + 1);
    expect(second.events[1]!.event).toBe("history");
    expect(second.events[1]!.id).toBe(lastSeen.id! + 2);
    expect(second.events[2]!.event).toBe("status");
    expect(second.events[2]!.id).toBeNull();
    // reconnect via the Last-Event-ID header (what EventSource sends)
    const lastSeen2 = second.events[1]!;
    second.abort();
    s.h.db.appendHistory(id, "unparked", "implement", { via: "approve" });
    const third = connectEvents(s, { lastEventId: lastSeen2.id! });
    await third.waitUntil((n) => n >= 2);
    expect(third.events[0]!.event).toBe("history");
    expect(third.events[0]!.id).toBe(lastSeen2.id! + 1); // no gap, no duplicate
    third.abort();
  });

  it("fans one poll out to every connected client identically", async () => {
    const s = await makeServer();
    s.h.inboxFile("fan-out", { title: "Fan out", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const a = connectEvents(s);
    const b = connectEvents(s);
    await a.waitUntil((n) => n >= 1);
    await b.waitUntil((n) => n >= 1);
    s.h.db.appendHistory(id, "stage-start", "triage", {});
    s.app.flush(); // one poll, fanned out
    await a.waitUntil((n) => n >= 2);
    await b.waitUntil((n) => n >= 2);
    const rowA = a.events[1]!;
    const rowB = b.events[1]!;
    expect(rowA.event).toBe("history");
    expect(rowA.id).toBe(rowB.id);
    expect(rowA.data).toBe(rowB.data);
    a.abort();
    b.abort();
  });
});

describe("wb serve: artifact containment", () => {
  it("serves artifact files under items/ and rejects traversal, absolute, and non-item paths", async () => {
    const s = await makeServer();
    const slug = "art-item";
    s.h.writeFile(path.join(s.h.paths.items, slug, "artifacts", "20260101-000000-000-spec.md"), "# spec content\n");
    const good = await fetch(
      s.url + "/api/artifact?path=" + encodeURIComponent(`items/${slug}/artifacts/20260101-000000-000-spec.md`),
    );
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("text/markdown");
    expect(good.headers.get("cache-control")).toBe("no-store");
    expect(await good.text()).toBe("# spec content\n");
    const cases: [string, number][] = [
      ["/etc/passwd", 403],
      ["../../../etc/passwd", 403],
      ["items/../../../etc/passwd", 403],
      ["factory.db", 403],
      ["factory.config.json", 403],
      [`items/${slug}/artifacts/missing.md`, 404],
    ];
    for (const [p, expected] of cases) {
      const res = await fetch(s.url + "/api/artifact?path=" + encodeURIComponent(p));
      expect(res.status, p).toBe(expected);
    }
    const noPath = await fetch(s.url + "/api/artifact");
    expect(noPath.status).toBe(400);
  });
});

describe("wb serve: request hardening (CSRF and DNS rebinding)", () => {
  /** Raw request with full header control (fetch forbids nothing here, but the
   *  point is to send attacker-shaped headers verbatim). */
  function rawRequest(
    s: ServerHarness,
    opts: { method?: string; urlPath: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: PostBody }> {
    return new Promise((resolve, reject) => {
      const u = new URL(s.url);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          method: opts.method ?? "GET",
          path: opts.urlPath,
          headers: opts.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: PostBody = {};
            try {
              parsed = JSON.parse(text) as PostBody;
            } catch {
              parsed = { raw: text };
            }
            resolve({ status: res.statusCode ?? -1, body: parsed });
          });
        },
      );
      req.on("error", reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  it("rejects non-JSON content types on every mutating endpoint (415)", async () => {
    const s = await makeServer();
    const port = (s.server.address() as { port: number }).port;
    // form-encoded (the CSRF shape) and text/plain → 415, before any parsing
    for (const ct of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data"]) {
      const r = await rawRequest(s, {
        method: "POST",
        urlPath: "/api/run",
        headers: { "content-type": ct, host: `127.0.0.1:${port}` },
        body: "title=x",
      });
      expect(r.status, ct).toBe(415);
      expect(r.body.error).toContain("application/json");
    }
    // missing content type entirely → 415
    const none = await rawRequest(s, {
      method: "POST",
      urlPath: "/api/items/1/approve",
      headers: { host: `127.0.0.1:${port}` },
      body: "{}",
    });
    expect(none.status).toBe(415);
    // a charset suffix is allowed; the request then proceeds (404: unknown item 1)
    const charset = await rawRequest(s, {
      method: "POST",
      urlPath: "/api/items/999999/approve",
      headers: { "content-type": "application/json; charset=utf-8", host: `127.0.0.1:${port}` },
      body: "{}",
    });
    expect(charset.status).toBe(404);
  });

  /** Handcrafted request over a raw socket (node's http client auto-inserts
   *  a Host header, so the missing-Host case needs the wire itself). */
  function rawSocketRequest(s: ServerHarness, raw: string): Promise<{ status: number; body: PostBody }> {
    return new Promise((resolve, reject) => {
      const u = new URL(s.url);
      const sock = net.connect(Number(u.port), u.hostname, () => sock.write(raw));
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
      });
      sock.on("end", () => {
        const m = /^HTTP\/1.[01] (\d+)/.exec(buf);
        const bodyStart = buf.indexOf("\r\n\r\n");
        let parsed: PostBody = {};
        try {
          parsed = JSON.parse(bodyStart === -1 ? buf : buf.slice(bodyStart + 4)) as PostBody;
        } catch {
          parsed = { raw: buf };
        }
        resolve({ status: m ? Number(m[1]) : -1, body: parsed });
      });
      sock.on("error", reject);
    });
  }

  it("rejects non-localhost Host headers and mismatched Origins on API requests (403)", async () => {
    const s = await makeServer();
    const port = (s.server.address() as { port: number }).port;
    const good = `127.0.0.1:${port}`;
    // a DNS-rebinding hostname never passes the allowlist
    const rebinding = await rawRequest(s, {
      method: "GET",
      urlPath: "/api/status",
      headers: { host: `evil.example:${port}` },
    });
    expect(rebinding.status).toBe(403);
    // wrong port in the Host header
    const wrongPort = await rawRequest(s, {
      method: "GET",
      urlPath: "/api/status",
      headers: { host: "127.0.0.1:1" },
    });
    expect(wrongPort.status).toBe(403);
    // missing Host header entirely (handcrafted on the wire; node's client
    // always adds one). node's own HTTP/1.1 parser refuses host-less requests
    // (400) before the handler; the guard's 403 covers anything that slips past.
    const noHost = await rawSocketRequest(
      s,
      "GET /api/status HTTP/1.1\r\nConnection: close\r\n\r\n",
    );
    expect([400, 403]).toContain(noHost.status);
    // an Origin that names anywhere else is refused even with a good Host
    const evilOrigin = await rawRequest(s, {
      method: "POST",
      urlPath: "/api/items/999999/approve",
      headers: { "content-type": "application/json", host: good, origin: "http://evil.example" },
      body: "{}",
    });
    expect(evilOrigin.status).toBe(403);
    // the matching same-origin pair passes the guard (then 404: unknown item)
    const sameOrigin = await rawRequest(s, {
      method: "POST",
      urlPath: "/api/items/999999/approve",
      headers: { "content-type": "application/json", host: good, origin: `http://${good}` },
      body: "{}",
    });
    expect(sameOrigin.status).toBe(404);
    // a correct localhost Host is equally fine
    const local = await rawRequest(s, {
      method: "GET",
      urlPath: "/api/status",
      headers: { host: `localhost:${port}` },
    });
    expect(local.status).toBe(200);
  });

  it("serves the static page itself without the API Host guard", async () => {
    const s = await makeServer();
    const page = await rawRequest(s, { method: "GET", urlPath: "/", headers: { host: "evil.example" } });
    expect(page.status).toBe(200); // static markup; no data in it
  });
});

describe("wb serve: artifact symlink hardening", () => {
  it("rejects symlinks and symlinked directories escaping the root", async () => {
    const s = await makeServer();
    const slug = "link-item";
    const artDir = path.join(s.h.paths.items, slug, "artifacts");
    s.h.writeFile(path.join(artDir, "real.md"), "# real\n");
    // decoy outside the factory root
    const outside = mkdtempSync(path.join(os.tmpdir(), "wb-serve-decoy-"));
    extraDirs.push(outside);
    writeFileSync(path.join(outside, "secret.md"), "# secret\n");
    // a symlink as the artifact file itself → 404 (lstat: not a regular file)
    symlinkSync(path.join(outside, "secret.md"), path.join(artDir, "outside.md"));
    // a symlink to a file inside the root is still rejected (no symlinks at all)
    symlinkSync(path.join(artDir, "real.md"), path.join(artDir, "inside.md"));
    // a symlinked intermediate directory: passes lstat, caught by realpath containment
    symlinkSync(outside, path.join(artDir, "escape-dir"));
    const get = async (p: string) =>
      (await fetch(s.url + "/api/artifact?path=" + encodeURIComponent(p))).status;
    expect(await get(`items/${slug}/artifacts/real.md`)).toBe(200);
    expect(await get(`items/${slug}/artifacts/outside.md`)).toBe(404);
    expect(await get(`items/${slug}/artifacts/inside.md`)).toBe(404);
    expect(await get(`items/${slug}/artifacts/escape-dir/secret.md`)).toBe(403);
  });
});

describe("wb serve: CLI entry (spawn, external behavior)", () => {
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts");
  const roots: string[] = [];

  function runServeCli(args: string[]): { stdout: string; stderr: string; status: number } {
    const res = spawnSync("node", ["--import", "tsx", cliPath, "serve", ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
  }

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it("refuses a fresh root exactly like status/watch (exit 0, friendly message)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wb-serve-fresh-"));
    roots.push(root);
    const { stdout, status } = runServeCli(["--root", root]);
    expect(status).toBe(0);
    expect(stdout).toContain(`no factory.db in ${root} yet`);
  });

  it("rejects an invalid --port with a friendly message and exit 1", () => {
    const h = createHarness();
    const bad = runServeCli(["--root", h.root, "--port", "not-a-port"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("wb serve: invalid port");
    expect(bad.stderr).toContain("between 1 and 65535");
    const zero = runServeCli(["--root", h.root, "--port", "0"]);
    expect(zero.status).toBe(1);
    expect(zero.stderr).toContain("invalid port");
    h.cleanup();
  });

  it("reports EADDRINUSE friendly and exits 1 when the port is taken", async () => {
    const h = createHarness();
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const res = runServeCli(["--root", h.root, "--port", String(port)]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("already in use");
      expect(res.stderr).toContain("--port");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      h.cleanup();
    }
  });
});

// ------------------------------------------------- per-tick query budget
// Regression tests for the performance rework: the SSE poller's per-tick call
// graph must stay single-read (one payload per tick, no N+1 artifacts, no
// per-file slug queries) and must cost zero statements with no consumers
// (KB 2026-11-06 17:02: prove it with a prepare/query-count assertion).

describe("wb serve: per-tick query budget (counting proxy)", () => {
  interface StmtCounts {
    /** `prepare()` calls on the underlying connection (cache effectiveness). */
    prepares: number;
    /** Statement executions, keyed by SQL text. */
    execs: Map<string, number>;
    /** Rows returned by `all()` calls, keyed by SQL text (read volume). */
    rows: Map<string, number>;
    total: number;
  }

  /** Monkey-patch the readonly connection's `prepare` so every statement the
   *  FactoryDb compiles (its own statement cache routes through here exactly
   *  once per SQL text) and every execution is counted. Internal calls
   *  (e.g. getWatchSnapshot's transaction) resolve the patched own-property
   *  through `this`, so nothing escapes the count. */
  function instrumentDb(db: FactoryDb): StmtCounts {
    const counts: StmtCounts = { prepares: 0, execs: new Map(), rows: new Map(), total: 0 };
    const raw = db.db as unknown as { prepare: (sql: string) => unknown };
    const orig = db.db.prepare.bind(db.db);
    raw.prepare = (sql: string) => {
      counts.prepares += 1;
      const stmt = orig(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
      const wrapped: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["get", "all", "run", "iterate"] as const) {
        const fn = stmt[m];
        if (typeof fn !== "function") continue;
        wrapped[m] = (...args: unknown[]) => {
          counts.total += 1;
          counts.execs.set(sql, (counts.execs.get(sql) ?? 0) + 1);
          const result = fn.apply(stmt, args);
          if (m === "all" && Array.isArray(result)) {
            counts.rows.set(sql, (counts.rows.get(sql) ?? 0) + result.length);
          }
          return result;
        };
      }
      return wrapped as unknown as ReturnType<FactoryDb["db"]["prepare"]>;
    };
    return counts;
  }

  function execsOf(counts: StmtCounts, needle: string): number {
    let n = 0;
    for (const [sql, c] of counts.execs) {
      if (sql.includes(needle)) n += c;
    }
    return n;
  }

  /** Rows returned by `all()` executions of statements containing `needle` —
   *  the read volume, not just the execution count (KB 2026-11-06 17:15: a
   *  perf bound must be proven on the rows actually read). */
  function rowsOf(counts: StmtCounts, needle: string): number {
    let n = 0;
    for (const [sql, c] of counts.rows) {
      if (sql.includes(needle)) n += c;
    }
    return n;
  }

  function reset(counts: StmtCounts): void {
    counts.prepares = 0;
    counts.execs.clear();
    counts.rows.clear();
    counts.total = 0;
  }

  /** Server with an instrumented readonly observation DB (manual wiring —
   *  the point is to count what the serve-side read path executes). */
  async function makeInstrumentedServer(): Promise<{
    s: ServerHarness;
    counts: StmtCounts;
  }> {
    const h = createHarness();
    const runner = new ScriptedRunner({});
    const rodb = FactoryDb.openReadonly(h.root);
    const counts = instrumentDb(rodb);
    const app = createServeApp({
      root: h.root,
      paths: h.paths,
      config: h.config,
      db: rodb,
      makeRunner: () => ({ runner, curator: null, publisher: new FakePublisher(), baseCheck: silentProceed }),
      intervalMs: 0,
      runMode: "await",
    });
    const server = http.createServer((req, res) => app.handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const s: ServerHarness = {
      h,
      app,
      server,
      url,
      runner,
      stop: async () => {
        app.stop();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rodb.close();
        h.cleanup();
      },
    };
    servers.push(s);
    return { s, counts };
  }

  /** Seed several parked/done items with artifacts directly (no stage runner). */
  function seedItems(h: TestHarness, n: number): void {
    for (let i = 0; i < n; i++) {
      const parked = i % 3 === 0;
      const done = !parked && i % 3 === 1;
      const item = h.db.insertItem({
        slug: `budget-item-${i}`,
        title: `Budget item ${i}`,
        repo: "/tmp/repo",
        base: "main",
        approvals: [],
        stage: "spec",
        status: parked ? "awaiting-approval" : done ? "done" : "queued",
        ...(parked
          ? { parkedReason: "awaiting-approval", parkedDetail: { stage: "spec", doneStage: "triage" } }
          : done
            ? { parkedDetail: { prUrl: "https://github.com/x/y/pull/1", prNumber: i, draft: false } }
            : {}),
      });
      h.db.addArtifact(item.id, "spec", `spec-artifact-${i}`, `items/budget-item-${i}/artifacts/spec-${i}.md`);
      if (done) h.db.addArtifact(item.id, "pr", `pr-artifact-${i}`, `items/budget-item-${i}/artifacts/pr-${i}.md`);
    }
  }

  it("builds a payload with exactly one artifacts query and one items read (no N+1)", async () => {
    const { s, counts } = await makeInstrumentedServer();
    seedItems(s.h, 12); // 4 awaiting-approval + 4 done (both artifact-bearing) + 4 queued
    const res = await fetch(s.url + "/api/status");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      items: { status: string; artifacts?: unknown[]; prUrl?: string }[];
    };
    expect(payload.items.filter((i) => i.status === "awaiting-approval").every((i) => (i.artifacts ?? []).length === 1)).toBe(true);
    expect(payload.items.filter((i) => i.status === "done").every((i) => (i.artifacts ?? []).length === 2 && typeof i.prUrl === "string")).toBe(true);
    // One artifacts query per payload — never one per artifact-bearing item.
    expect(execsOf(counts, "FROM artifacts")).toBe(1);
    // One whole-store items read per payload — never per-item.
    expect(execsOf(counts, "SELECT * FROM items")).toBe(1);
    // Inbox classification resolves slugs in memory — no per-file slug query.
    expect(execsOf(counts, "WHERE slug")).toBe(0);
  });

  it("runs a changed tick with at most one items SELECT, one artifacts query, and a warm statement cache", async () => {
    const { s, counts } = await makeInstrumentedServer();
    seedItems(s.h, 30);
    const id = s.h.db.listItems()[0]!.id;
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1);
    s.app.flush(); // warm every read path once (cache miss → prepare)
    reset(counts);
    // activity: a history row + an item state change
    s.h.db.appendHistory(id, "stage-start", "test", { attempt: 1 });
    s.h.db.updateItem(id, { status: "awaiting-approval" });
    const before = stream.events.length;
    s.app.flush();
    await stream.waitUntil((n) => n >= before + 2); // one history row + one status event
    // The statement cache: zero new prepares on a warmed-up tick.
    expect(counts.prepares).toBe(0);
    // Exactly one whole-store items read per tick (the getWatchSnapshot one).
    expect(execsOf(counts, "SELECT * FROM items")).toBe(1);
    // One artifacts query per payload (built once per tick).
    expect(execsOf(counts, "FROM artifacts")).toBe(1);
    // One max-history-id + one history-since + one known-repos query — nothing else.
    expect(execsOf(counts, "AS maxId")).toBe(1);
    expect(execsOf(counts, "FROM history WHERE id >")).toBe(1);
    expect(execsOf(counts, "AS latest_id")).toBe(1);
    expect(counts.total).toBe(5);
    stream.abort();
  });

  it("executes zero statements on a zero-client tick (idle server)", async () => {
    const { s, counts } = await makeInstrumentedServer();
    seedItems(s.h, 5);
    const id = s.h.db.listItems()[0]!.id;
    // No SSE clients connected. History rows pile up while idle.
    s.h.db.appendHistory(id, "stage-start", "spec", {});
    s.h.db.appendHistory(id, "stage-pass", "spec", { nextStage: "implement" });
    reset(counts);
    s.app.flush();
    expect(counts.total).toBe(0);
    expect(counts.prepares).toBe(0);
    // A client connecting after the idle period gets the current snapshot and
    // the poller continues from its position — no re-fetch of the idle rows.
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1);
    expect(stream.events[0]!.event).toBe("status");
    const maxId = s.h.db.getMaxHistoryId();
    reset(counts);
    s.h.db.appendHistory(id, "stage-start", "implement", {});
    s.app.flush();
    await stream.waitUntil((n) => n >= 2);
    const row = stream.events.find((e) => e.event === "history")!;
    expect(row.id).toBe(maxId! + 1); // only the post-connect row is fetched
    expect(execsOf(counts, "FROM history WHERE id >")).toBe(1);
    stream.abort();
  });

  it("bounds reconnect replay to MAX_SSE_REPLAY_ROWS rows (snapshot beyond that)", async () => {
    const { s, counts } = await makeInstrumentedServer();
    s.h.inboxFile("replay-cap", { title: "Replay cap", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    for (let i = 0; i < MAX_SSE_REPLAY_ROWS + 100; i++) {
      s.h.db.appendHistory(id, "stage-start", "spec", { n: i });
    }
    const maxId = s.h.db.getMaxHistoryId()!;
    reset(counts);
    const stream = connectEvents(s, { query: "afterId=0" }); // far behind: everything is missed
    await stream.waitUntil((n) => n >= MAX_SSE_REPLAY_ROWS + 1);
    expect(stream.events).toHaveLength(MAX_SSE_REPLAY_ROWS + 1);
    const history = stream.events.filter((e) => e.event === "history");
    expect(history).toHaveLength(MAX_SSE_REPLAY_ROWS);
    // The most recent MAX_SSE_REPLAY_ROWS rows, in id order, then the snapshot.
    expect(history[0]!.id).toBe(maxId - MAX_SSE_REPLAY_ROWS + 1);
    expect(history[history.length - 1]!.id).toBe(maxId);
    const status = stream.events[stream.events.length - 1]!;
    expect(status.event).toBe("status");
    expect(status.id).toBeNull();
    // The bound is enforced in the query, not by slicing: with MAX+100 rows
    // after the cursor, the replay *read* returned exactly MAX rows (one
    // execution of the LIMIT-ed statement — never a full-table scan).
    expect(execsOf(counts, "ORDER BY id DESC LIMIT")).toBe(1);
    expect(rowsOf(counts, "ORDER BY id DESC LIMIT")).toBe(MAX_SSE_REPLAY_ROWS);
    // The unbounded reader is not on the replay path at all (exact SQL text —
    // it is a prefix of the bounded statement, so a substring needle would
    // match both).
    const unboundedSql =
      "SELECT id, item_id, ts, event, stage, detail FROM history WHERE id > ? ORDER BY id";
    expect(counts.execs.get(unboundedSql) ?? 0).toBe(0);
    stream.abort();
  });

  it("treats a negative afterId like a far-behind cursor (bounded, full replay)", async () => {
    const { s, counts } = await makeInstrumentedServer();
    s.h.inboxFile("negative-afterid", { title: "Negative afterId", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    s.h.db.appendHistory(id, "stage-start", "spec", {});
    s.h.db.appendHistory(id, "stage-pass", "spec", { nextStage: "implement" });
    const maxId = s.h.db.getMaxHistoryId()!;
    reset(counts);
    const stream = connectEvents(s, { query: "afterId=-5" });
    await stream.waitUntil((n) => n >= 4);
    expect(stream.events).toHaveLength(4); // 3 history rows (claimed + 2 appended) + status
    const history = stream.events.filter((e) => e.event === "history");
    expect(history).toHaveLength(3);
    expect(history.map((e) => e.id)).toEqual([maxId - 2, maxId - 1, maxId]);
    expect(stream.events[stream.events.length - 1]!.event).toBe("status");
    // The bounded reader handled the negative cursor, returning every row.
    expect(execsOf(counts, "ORDER BY id DESC LIMIT")).toBe(1);
    expect(rowsOf(counts, "ORDER BY id DESC LIMIT")).toBe(3);
    stream.abort();
  });
});

// ------------------------------------------------- Greptile review rework
// Regression tests for review findings on the shipped PR: CSS selector
// escapes must survive the template literal, the whole SSE read step must be
// failure-proof, and a stalled reader must not buffer server memory without
// bound.

describe("wb serve: page CSS selectors survive the template literal", () => {
  it("emits escaped CSS selectors (every backslash is doubled) and never a bare bracketed selector", async () => {
    const s = await makeServer();
    const page = await (await fetch(s.url + "/")).text();
    // Escaped forms — what a browser needs to drop the rule's braces safely.
    for (const needle of [
      ".text-\\[11px\\]",
      ".left-1\\/2",
      ".h-1\\.5",
      ".bg-white\\/50",
      ".min-h-\\[3rem\\]",
      ".hover\\:\\!bg-red-700:hover",
    ]) {
      expect(page).toContain(needle + " ");
    }
    // The unescaped forms as a template literal would mangle them: `\[` in a
    // template literal evaluates to `[`, leaving `.text-[11px]` — an invalid
    // selector whose rule the browser silently drops.
    for (const broken of [".text-[11px] {", ".left-1/2 {", ".h-1.5 {", ".bg-white/50 {"]) {
      expect(page).not.toContain(broken);
    }
    await s.stop();
  });
});

describe("wb serve: SSE read resilience + backpressure", () => {
  it("swallows a mid-payload read failure and advances the cursor only on success", async () => {
    const s = await makeServer();
    s.h.inboxFile("artifact-flake", { title: "Artifact flake", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1); // snapshot received

    // The tick reads artifacts + known repos while building the payload; a
    // failure anywhere in the whole read step must be swallowed — not escape
    // the interval callback and kill the server — and must not advance the
    // cursor, so the row is delivered once the flake clears.
    s.h.db.appendHistory(id, "stage-start", "test", { attempt: 1 });
    (s.rodb as unknown as { listArtifactsByItem: () => never }).listArtifactsByItem = () => {
      throw new Error("simulated artifacts read failure");
    };
    expect(() => s.app.flush()).not.toThrow();

    // Flake clears → the same window is re-fetched and delivered.
    delete (s.rodb as unknown as { listArtifactsByItem?: () => never }).listArtifactsByItem;
    const before = stream.events.length;
    s.app.flush();
    await stream.waitUntil((n) => n > before);
    expect(stream.events[before]!.id).not.toBeNull(); // the missed history row, not lost
    stream.abort();
  });

  it("cuts a client whose SSE write exceeds the backlog cap (slow-reader protection)", async () => {
    // Small cap + one item whose status payload alone dwarfs it: the snapshot
    // write returns false with a backlog over the cap, so the client is cut
    // synchronously — no server-side memory growth for a stalled reader, and
    // its reconnect replay (bounded) is the recovery path. Same clientWrite
    // path that guards every per-tick fan-out write.
    const s = await makeServer({}, { maxClientBufferedBytes: 64 * 1024 });
    s.h.inboxFile("huge-detail", { title: "Huge detail", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    s.h.db.updateItem(id, {
      status: "infrastructure-failure",
      stage: "test",
      parkedReason: "infra-budget",
      parkedDetail: { error: "z".repeat(512 * 1024) },
    });
    const closed = new Promise<string>((resolve) => {
      const socket = net.connect((s.server.address() as { port: number }).port, "127.0.0.1", () => {
        socket.setNoDelay(true);
        socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${(s.server.address() as { port: number }).port}\r\nAccept: text/event-stream\r\n\r\n`);
      });
      socket.on("data", () => { /* keep draining */ });
      socket.on("close", () => resolve("closed"));
      socket.on("error", () => resolve("error"));
    });
    const outcome = await Promise.race([closed, new Promise<string>((r) => setTimeout(() => r("not-cut"), 5000))]);
    // The server cut the connection (destroy or reset) once the backlog cap
    // was exceeded; it must NOT have buffered the whole oversized snapshot.
    expect(outcome === "closed" || outcome === "error").toBe(true);
    // The server itself stays healthy (the cap cut the client, not the server).
    const status = await fetch(s.url + "/api/status");
    expect(status.status).toBe(200);
    await s.stop();
  });
});

describe("wb serve: large snapshots reach healthy readers (no cut-on-connect livelock)", () => {
  it("delivers a large snapshot in full to an actively-draining reader, then keeps updating (default cap)", async () => {
    const s = await makeServer(); // production default cap (2 MiB)
    s.h.inboxFile("big-payload", { title: "Big payload", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    // One item whose status payload is ~0.5 MB — comfortably over the socket
    // high-water mark (write() reports backpressure mid-chunk) yet under the
    // cap. A healthy reader must receive it in full; a naive write→cut gate
    // would disconnect on connect and never recover (livelock).
    const bigError = "z".repeat(512 * 1024);
    s.h.db.updateItem(id, {
      status: "infrastructure-failure", stage: "test", parkedReason: "infra-budget",
      parkedDetail: { error: bigError },
    });
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1, 10000); // the (only) connect event: the snapshot
    const snapshotEvent = stream.events.find((e) => e.event === "status")!;
    const payload = JSON.parse(snapshotEvent.data) as { items: { id: number; parkedDetail?: { error?: string } }[] };
    const delivered = payload.items.find((i) => i.id === id);
    expect(delivered?.parkedDetail?.error).toBe(bigError); // nothing truncated, nothing dropped
    // The connection survives the big snapshot: a later tick still delivers.
    s.h.db.appendHistory(id, "stage-pass", "test", { nextStage: "review" });
    s.app.flush();
    await stream.waitUntil((n) => n >= 2, 10000);
    expect(stream.events.some((e) => e.event === "history")).toBe(true);
    stream.abort();
  });
});

// ------------------------------------------------- Greptile rework round 3
const EMOJI_FILLER = "🔧x".repeat(30_000); // 🔧 is a surrogate pair; every 5-byte UTF-8 group straddles a 64 KiB slice boundary

describe("wb serve: SSE ledger reset + unicode-safe slicing", () => {
  it("keeps a healthy tab that receives repeated large updates connected (pendingBytes resets on drain)", async () => {
    const s = await makeServer(); // production default cap
    s.h.inboxFile("big-updates", { title: "Big updates", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1);
    // 40 ticks, each changing the status payload (fingerprint → full ~100 KiB
    // resend). Every slice that returns false leaves 64 KiB in Node's buffer;
    // without the drain-resets-pendingBytes ledger, untouched `pendingBytes`
    // accumulates past the 2 MiB cap after ~30 ticks and a keeping-up tab is
    // cut despite never stalling.
    const filler = "y".repeat(100 * 1024);
    for (let t = 0; t < 40; t++) {
      s.h.db.updateItem(id, {
        status: "infrastructure-failure", stage: "test", parkedReason: "infra-budget",
        parkedDetail: { error: `${filler}|tick:${t}` },
      });
      s.app.flush();
      await stream.waitUntil((n) => n >= t + 2, 10000);
    }
    // The finale proves the connection was never cut.
    s.h.db.appendHistory(id, "gc", null, { final: "alive" });
    s.app.flush();
    await stream.waitUntil((n) => n >= 42, 10000);
    const finale = stream.events[stream.events.length - 1]!;
    expect(finale.event === "history" || finale.event === "status").toBe(true);
    stream.abort();
  });

  it("never splits a multi-byte character across write slices (byte-boundary, not char-boundary)", async () => {
    const s = await makeServer(); // slices at 64 KiB; EMOJI_FILLER straddles them
    s.h.inboxFile("emoji-detail", { title: "Emoji detail", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(s.h);
    const id = s.h.db.listItems()[0]!.id;
    s.h.db.updateItem(id, {
      status: "infrastructure-failure", stage: "test", parkedReason: "infra-budget",
      parkedDetail: { error: EMOJI_FILLER },
    });
    const stream = connectEvents(s);
    await stream.waitUntil((n) => n >= 1, 10000);
    const snapshot = JSON.parse(stream.events[0]!.data) as { items: { id: number; parkedDetail?: { error?: string } }[] };
    const delivered = snapshot.items.find((i) => i.id === id)?.parkedDetail?.error;
    // Slicing at UTF-16 code-unit boundaries would split a surrogate pair and
    // the re-encoded halves arrive as U+FFFD replacement characters; slicing
    // the UTF-8 buffer delivers the payload byte-exactly.
    expect(delivered).toBe(EMOJI_FILLER);
    stream.abort();
  });
});
