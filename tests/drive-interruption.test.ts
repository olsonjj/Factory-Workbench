/**
 * Dead-drive observability (specs/wb-interrupted-drives.spec.md): a drive
 * (`wb run` / `wb resume` / the web Start Processing drive) that ended without
 * a parking decision is detected, labeled (`drive-interrupted`), reconciled on
 * the next drive, surfaced by every observing surface, and ends its run log
 * with an explicit exit marker.
 *
 * External seams only, mirroring the prior art: the orchestrator's
 * resume/run entry (ticket02's crash fixture), the shared status snapshot
 * builder, the spawned CLI (status-readonly pattern), the pure watch
 * renderers + `pollOnce`, and the pure `driveExitLine` table. No Docker, no
 * models. The web-side surfaces are covered in additions to the web-serve and
 * page-runtime suites.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHarness, claim, makeOrchestrator, ScriptedRunner, type TestHarness } from "./helpers.js";
import { FactoryDb } from "../src/db.js";
import { buildStatusPayload, statusFingerprint } from "../src/status.js";
import { driveExitLine } from "../src/drive.js";
import { acquireFactoryLock, type LockInfo } from "../src/lock.js";
import { repoSlug } from "../src/kb.js";
import {
  formatEventText,
  pollOnce,
  renderCard,
  runWatchOnce,
  type WatchEventRow,
  type WatchItem,
  type WatchState,
} from "../src/watch.js";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts");

function runCli(args: string[], root: string): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", cliPath, ...args, "--root", root], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

/** The incident fixture (ticket02's crash simulation): a drive persisted
 *  `running` mid-stage and then vanished without parking. */
function crashMidStage(h: TestHarness, stage: "spec" = "spec"): void {
  const item = h.db.listItems()[0]!;
  h.db.updateItem(item.id, { status: "running", stage });
}

describe("dead-drive reconciliation (orchestrator entry)", () => {
  const harnesses: TestHarness[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  function seed(h: TestHarness, approvals: string[] = []): number {
    h.inboxFile("demo", { title: "Demo task", repo: "/tmp/repo", base: "main", approvals }, "Do the demo task.");
    claim(h);
    return h.db.listItems()[0]!.id;
  }

  it("resume requeues and labels an orphaned running item before driving it to completion", async () => {
    const h = makeHarness();
    const id = seed(h);
    const runner = new ScriptedRunner({});
    await makeOrchestrator(h, runner).tickAll(); // triage passes → queued at spec
    crashMidStage(h); // the 2026-11-08 incident: process gone, no lock file
    expect(existsSync(path.join(h.root, "factory.lock"))).toBe(false);

    const orch = makeOrchestrator(h, runner, { lastHolderPid: 4242 });
    const report = await orch.resume();

    expect(h.db.getItem(id)!.status).toBe("done");
    // the reconcile entry is prepended to the report (a normal transition, not a skip)
    expect(report.entries[0]).toMatchObject({ id, fromStage: "spec", status: "queued" });
    expect(report.entries[0]!.detail).toContain("drive interrupted (last holder: pid 4242)");
    // exactly one drive-interrupted history row, carrying the honest evidence
    const events = h.db.getHistory(id);
    const rows = events.filter((e) => e.event === "drive-interrupted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("spec");
    expect(rows[0]!.detail).toMatchObject({ lastHolder: 4242, requeued: true });
    expect(rows[0]!.detail.repoLock).toBeNull(); // no orphaned repo lock was left in this scenario
    // the interrupted episode visibly continues: the next stage-start follows the label
    const after = events.slice(events.indexOf(rows[0]!) + 1);
    expect(after.some((e) => e.event === "stage-start" && e.stage === "spec")).toBe(true);
  });

  it("records the orphaned repo lock row as evidence and cleans it (re-run acquires without conflict)", async () => {
    const h = makeHarness();
    const id = seed(h);
    const runner = new ScriptedRunner({});
    await makeOrchestrator(h, runner).tickAll(); // triage passes
    crashMidStage(h);
    // the killed drive had begun the stage: an orphan repo_locks row survives it
    expect(h.db.acquireRepoLock(repoSlug("/tmp/repo"), id)).toBe(true);

    await makeOrchestrator(h, runner, { lastHolderPid: 4242 }).resume();

    const events = h.db.getHistory(id);
    const row = events.find((e) => e.event === "drive-interrupted")!;
    const repoLock = row.detail.repoLock as { repo: string; acquiredAt: string };
    expect(repoLock.repo).toBe(repoSlug("/tmp/repo"));
    expect(typeof repoLock.acquiredAt).toBe("string");
    // cleaned: the spec re-run after the label acquired fresh — no lockConflict row
    const after = events.slice(events.indexOf(row) + 1);
    expect(after.filter((e) => e.event === "stage-start").every((e) => e.detail.lockConflict !== true)).toBe(true);
    expect(h.db.listItems()[0]!.status).toBe("done");
  });

  it("labels the holder as unknown (null, never fabricated) when no lock file survived", async () => {
    const h = makeHarness();
    const id = seed(h);
    const runner = new ScriptedRunner({});
    await makeOrchestrator(h, runner).tickAll();
    crashMidStage(h);

    await makeOrchestrator(h, runner).resume(); // no lastHolderPid dep → unknown holder

    const row = h.db.getHistory(id).find((e) => e.event === "drive-interrupted")!;
    expect(row.detail.lastHolder).toBeNull();
    expect(row.detail.requeued).toBe(true);
  });

  it("the reconcile's requeue + label are atomic: a failure between them rolls back to running (next drive re-reconciles)", async () => {
    const h = makeHarness();
    const id = seed(h);
    const runner = new ScriptedRunner({});
    await makeOrchestrator(h, runner).tickAll();
    crashMidStage(h);
    // the killed drive left an orphan repo_locks row behind (its evidence)
    expect(h.db.acquireRepoLock(repoSlug("/tmp/repo"), id)).toBe(true);

    // a mid-reconcile failure (the stand-in for a hard kill between the
    // requeue and the label) must leave NOTHING partially written
    const orch = makeOrchestrator(h, runner, { lastHolderPid: 4242 });
    const spy = vi.spyOn(h.db, "updateItem").mockImplementation(() => {
      throw new Error("hard kill");
    });
    expect(() => orch.reconcileInterrupted(4242)).toThrow("hard kill");
    spy.mockRestore();

    // rolled back: the item is still `running` with its repo-lock intact —
    // the next drive's reconcile sees it (a torn write would have left the
    // item `queued`, invisible to that scan, with the label permanently lost)
    expect(h.db.listItems()[0]!.status).toBe("running");
    expect(h.db.acquireRepoLock(repoSlug("/tmp/repo"), id)).toBe(false); // still held
    expect(h.db.getHistory(id).filter((e) => e.event === "drive-interrupted")).toHaveLength(0);

    // the next drive reconciles it exactly once, evidence intact
    await makeOrchestrator(h, runner, { lastHolderPid: 4242 }).resume();
    const rows = h.db.getHistory(id).filter((e) => e.event === "drive-interrupted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.repoLock).toMatchObject({ repo: repoSlug("/tmp/repo") });
    expect(h.db.listItems()[0]!.status).toBe("done");
  });

  it("is idempotent: a second drive start finds nothing running and writes no duplicate event", async () => {
    const h = makeHarness();
    const id = seed(h);
    const runner = new ScriptedRunner({});
    await makeOrchestrator(h, runner).tickAll();
    crashMidStage(h);

    const orch = makeOrchestrator(h, runner, { lastHolderPid: 4242 });
    await orch.resume(); // labels once, drives to done
    await makeOrchestrator(h, new ScriptedRunner({}), { lastHolderPid: 99 }).resume(); // healthy: nothing running

    expect(h.db.getHistory(id).filter((e) => e.event === "drive-interrupted")).toHaveLength(1);
  });

  it("a healthy drive (nothing running at start) emits no drive-interrupted rows", async () => {
    const h = makeHarness();
    const id = seed(h);
    await makeOrchestrator(h, new ScriptedRunner({}), { lastHolderPid: 4242 }).resume();
    expect(h.db.getItem(id)!.status).toBe("done");
    expect(h.db.getHistory(id).some((e) => e.event === "drive-interrupted")).toBe(false);
  });

  it("the wb run entry reconciles before ticking (explicit call under the lock)", async () => {
    const h = makeHarness();
    const id = seed(h);
    const runner = new ScriptedRunner({});
    await makeOrchestrator(h, runner).tickAll();
    crashMidStage(h);

    // what the CLI run action does: reconcile(preLockPid) merged ahead of the tick
    const orch = makeOrchestrator(h, runner, {});
    const reconcile = orch.reconcileInterrupted(555);
    const tick = await orch.tickAll();
    expect(reconcile.map((e) => e.status)).toEqual(["queued"]);
    expect(tick.entries[0]!.fromStage).toBe("spec"); // the requeued item was driven
    const rows = h.db.getHistory(id).filter((e) => e.event === "drive-interrupted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.lastHolder).toBe(555);
    // one stage per item per invocation (wb run semantics): spec re-ran and passed
    const item = h.db.getItem(id)!;
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("implement");
  });
});

describe("status snapshot: the interrupted signal", () => {
  const harnesses: TestHarness[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  function seedOrphan(h: TestHarness): void {
    h.inboxFile("item-27", { title: "Item 27", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    const id = h.db.listItems()[0]!.id;
    h.db.updateItem(id, { status: "running", stage: "spec" }); // orphaned mid-spec, no lock anywhere
  }

  it("derives interrupted from running items + no live lock (holder null without a lock file)", () => {
    const h = makeHarness();
    seedOrphan(h);
    const payload = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
    const item = h.db.listItems()[0]!;
    expect(payload.interrupted).toEqual({
      items: [{ id: item.id, slug: item.slug, stage: "spec" }],
      lastHolder: null,
    });
  });

  it("names the dead holder from the lock file a hard kill left behind", () => {
    const h = makeHarness();
    seedOrphan(h);
    writeFileSync(
      path.join(h.root, "factory.lock"),
      JSON.stringify({ pid: 999_999_999, ts: Date.now(), id: "dead-drive" }),
    );
    const payload = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
    expect(payload.interrupted!.lastHolder).toBe(999_999_999);
    expect(payload.lock!.alive).toBe(false);
  });

  it("is null while a live lock holds (the holder owns the running state)", () => {
    const h = makeHarness();
    seedOrphan(h);
    const release = acquireFactoryLock(h.root);
    try {
      const payload = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
      expect(payload.interrupted).toBeNull();
    } finally {
      release();
    }
    const after = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
    expect(after.interrupted).not.toBeNull();
  });

  it("needs no fingerprint change: both inputs are already fingerprinted, the signal itself is not embedded", () => {
    const h = makeHarness();
    seedOrphan(h);
    const orphan = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
    // flip input 1 — item status — and the fingerprint changes
    const id = h.db.listItems()[0]!.id;
    h.db.updateItem(id, { status: "queued" });
    const healthy = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
    expect(statusFingerprint(healthy)).not.toBe(statusFingerprint(orphan));
    // flip input 2 — lock liveness — and the fingerprint changes again
    writeFileSync(
      path.join(h.root, "factory.lock"),
      JSON.stringify({ pid: 999_999_999, ts: Date.now(), id: "dead-drive" }),
    );
    const deadLock = buildStatusPayload({ root: h.root, paths: h.paths, db: h.db });
    expect(statusFingerprint(deadLock)).not.toBe(statusFingerprint(healthy));
    // the fingerprint never mentions the derived field's name
    expect(statusFingerprint(orphan)).not.toContain("interrupted");
  });
});

describe("wb status (spawned): the interrupted-drive line", () => {
  const harnesses: TestHarness[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  function seedOrphan(h: TestHarness): void {
    h.inboxFile("item-27", { title: "Item 27", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    h.db.updateItem(h.db.listItems()[0]!.id, { status: "running", stage: "spec" });
  }

  it("reports the dead lock's pid next to the stale-lock line; recovery is the usual run/resume", () => {
    const h = makeHarness();
    seedOrphan(h);
    writeFileSync(
      path.join(h.root, "factory.lock"),
      JSON.stringify({ pid: 999_999_999, ts: Date.now(), id: "dead-drive" }),
    );
    const { stdout, status } = runCli(["status"], h.root);
    expect(status).toBe(0);
    expect(stdout).toContain("stale factory lock (pid 999999999"); // the existing line stays
    expect(stdout).toContain(
      "interrupted drive: #1 item-27 (spec) claims running but no live factory lock holds " +
        "(last known holder: pid 999999999) — the previous drive did not end cleanly; " +
        "recover with `wb run` or `wb resume`",
    );
  });

  it("says 'last known holder: none' when no lock file survived the dead drive", () => {
    const h = makeHarness();
    seedOrphan(h);
    const { stdout, status } = runCli(["status"], h.root);
    expect(status).toBe(0);
    expect(stdout).toContain("interrupted drive: #1 item-27 (spec) claims running but no live factory lock holds (last known holder: none)");
  });

  it("never prints the line while a live lock holds (running is then legitimate)", () => {
    const h = makeHarness();
    seedOrphan(h);
    const release = acquireFactoryLock(h.root);
    let stdout: string;
    try {
      stdout = runCli(["status"], h.root).stdout;
    } finally {
      release();
    }
    expect(stdout).toContain("factory command in progress (pid");
    expect(stdout).not.toContain("interrupted drive:");
  });

  it("is silent on a healthy factory (no new lines)", () => {
    const h = makeHarness();
    h.inboxFile("healthy", { title: "Healthy", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    const { stdout, status } = runCli(["status"], h.root);
    expect(status).toBe(0);
    expect(stdout).toContain("#1 healthy [queued]");
    expect(stdout).not.toContain("interrupted drive");
  });
});

describe("wb run / wb resume (spawned): drive-exit markers", () => {
  const harnesses: TestHarness[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  function seedTerminal(h: TestHarness): void {
    // A factory with a DB but no actionable items: the drive opens, finds
    // nothing to do, and exits — no stage runner is ever invoked.
    h.inboxFile("done-item", { title: "Done item", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    h.db.updateItem(h.db.listItems()[0]!.id, { status: "done" });
  }

  it("wb run ends with its terminal marker", () => {
    const h = makeHarness();
    seedTerminal(h);
    const { stdout, status } = runCli(["run"], h.root);
    expect(status).toBe(0);
    expect(stdout).toContain("Nothing to do.");
    expect(stdout).toContain("drive exited: completed (one stage per item)");
  });

  it("wb resume ends with its terminal marker", () => {
    const h = makeHarness();
    seedTerminal(h);
    const { stdout, status } = runCli(["resume"], h.root);
    expect(status).toBe(0);
    expect(stdout).toContain("Nothing to resume.");
    expect(stdout).toContain("drive exited: completed (nothing actionable left)");
  });
});

describe("driveExitLine (pure table)", () => {
  it("renders every canonical exit line exactly", () => {
    expect(driveExitLine("run", "completed")).toBe("drive exited: completed (one stage per item)");
    expect(driveExitLine("resume", "completed")).toBe("drive exited: completed (nothing actionable left)");
    expect(driveExitLine("resume", "capped")).toBe("drive exited: capped — run `wb resume` again to continue");
    expect(driveExitLine("run", "interrupted", "Error: boom")).toBe("drive exited: interrupted — Error: boom");
    expect(driveExitLine("resume", "interrupted", "Error: boom")).toBe("drive exited: interrupted — Error: boom");
    expect(driveExitLine("run", "interrupted")).toBe("drive exited: interrupted (SIGTERM)");
  });
});

describe("wb watch: the INTERRUPTED card line and event text", () => {
  const RULE = "─".repeat(50);
  const TS = new Date(2026, 10, 8, 3, 4, 5).toISOString();
  const harnesses: TestHarness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  function wItem(partial: Partial<WatchItem> = {}): WatchItem {
    return { id: 27, slug: "item-27", stage: "spec", status: "running", parkedReason: null, ...partial };
  }

  it("appends the counted INTERRUPTED line after PARKED; empty set keeps the card byte-identical", () => {
    const orphan = wItem();
    const card = renderCard([orphan], [orphan]);
    const lines = card.split("\n");
    expect(lines).toEqual([
      RULE,
      "  RUN (1): #27 item-27 spec",
      "  PARKED (0): none",
      "  INTERRUPTED (1): #27 item-27 spec",
      RULE,
    ]);
    // byte-identical without the signal — the pre-existing card shape
    expect(renderCard([orphan])).toBe([RULE, "  RUN (1): #27 item-27 spec", "  PARKED (0): none", RULE].join("\n"));
    expect(renderCard([orphan])).toBe(renderCard([orphan], []));
    // multiple orphans join with " · " and the content stays ≤78 (≤80 with indent)
    const a = wItem({ id: 27, slug: "item-27" });
    const b = wItem({ id: 28, slug: "another-orphan", stage: "implement" });
    const two = renderCard([a, b], [a, b]).split("\n");
    expect(two[3]).toBe("  INTERRUPTED (2): #27 item-27 spec · #28 another-orphan implement");
    expect(two[3]!.length).toBeLessThanOrEqual(80);
  });

  it("pollOnce derives the set from running items + observeLock (read-only, never acquires)", () => {
    const h = createHarness();
    harnesses.push(h);
    h.inboxFile("item-27", { title: "Item 27", repo: "/tmp/repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    h.db.updateItem(h.db.listItems()[0]!.id, { status: "running", stage: "spec" });
    const watchDb = FactoryDb.openReadonly(h.root);

    const first = pollOnce(watchDb, { lastEventId: 0, lastCard: null, first: true }, 3, () => null);
    expect(first.state.lastCard).toContain("INTERRUPTED (1): #1 item-27 spec");
    expect(first.lines).toEqual([]); // first poll primes silently
    watchDb.close();

    // no observeLock probe → unchanged behavior for existing callers
    const watchDb2 = FactoryDb.openReadonly(h.root);
    const plain = pollOnce(watchDb2, { lastEventId: 0, lastCard: null, first: true }, 3);
    expect(plain.state.lastCard).not.toContain("INTERRUPTED");
    watchDb2.close();

    // live lock → the running item is legitimate, no signal
    const release = acquireFactoryLock(h.root);
    const watchDb3 = FactoryDb.openReadonly(h.root);
    const liveLock = (): LockInfo | null => ({ pid: process.pid, ts: Date.now(), id: "live" });
    try {
      const live = pollOnce(watchDb3, { lastEventId: 0, lastCard: null, first: true }, 3, liveLock);
      expect(live.state.lastCard).not.toContain("INTERRUPTED");
    } finally {
      watchDb3.close();
      release();
    }
    expect(existsSync(path.join(h.root, "factory.lock"))).toBe(false); // released, and watch never wrote one
  });

  it("a changed signal re-prints the card; a dead lock fixture reports the holder through the card", () => {
    const orphan = wItem();
    const lastCard = renderCard([orphan], []);
    const state: WatchState = { lastEventId: 5, lastCard, first: false };
    const outcome = runWatchOnce([], [orphan], state, 3, [orphan]);
    expect(outcome.lines).toEqual([renderCard([orphan], [orphan])]);
    expect(outcome.state.lastCard).toContain("INTERRUPTED (1)");
  });

  it("renders the drive-interrupted recovery event (with pid, unknown variant) and never notifies", () => {
    const row = (detail: Record<string, unknown>): WatchEventRow =>
      ({ id: 1, itemId: 27, ts: TS, event: "drive-interrupted", stage: "spec", detail });
    const item = wItem();
    expect(formatEventText(row({ lastHolder: 4231, requeued: true }), item, 3)).toBe(
      "drive interrupted at spec — item requeued (last holder pid 4231)",
    );
    expect(formatEventText(row({ lastHolder: null, requeued: true }), item, 3)).toBe(
      "drive interrupted at spec — item requeued (holder unknown)",
    );
    // not a parked row: no notification text, no ⚠/bell decoration
    const state: WatchState = { lastEventId: 0, lastCard: renderCard([]), first: false };
    const outcome = runWatchOnce([row({ lastHolder: 4231 })], [], state, 3);
    expect(outcome.notificationTexts).toEqual([]);
    expect(outcome.lines[0]).not.toContain("⚠");
    expect(outcome.lines[0]).not.toContain("\x07");
  });
});
