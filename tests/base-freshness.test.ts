import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  GitBaseFreshnessChecker,
  FRESHNESS_FETCH_TIMEOUT_MS,
  FRESHNESS_GIT_TIMEOUT_MS,
  type BaseFreshnessChecker,
  type BaseFreshnessResult,
} from "../src/base-freshness.js";
import { projectKbFile } from "../src/kb.js";
import { createHarness, makeOrchestrator, ScriptedRunner, FakePublisher, pass, type TestHarness } from "./helpers.js";
import type { ItemRecord, StageName } from "../src/types.js";

/**
 * Stale-base detection tests, following the house conventions of
 * tests/gc.test.ts: real git in temp repos (local-path remotes — `origin`
 * works offline, no network, no Docker, no models), mkdtempSync/rmSync
 * cleanup, `-c user.name=wb -c user.email=wb@factory.workbench`, piped stdio.
 * Orchestrator flow runs above the seam with a fake checker + ScriptedRunner.
 */

const GIT_IDENTITY = ["-c", "user.name=wb", "-c", "user.email=wb@factory.workbench"];

interface GitRepo {
  dir: string;
  git: (args: string[]) => string;
  cleanup: () => void;
}

function gitIn(dir: string): (args: string[]) => string {
  return (args: string[]): string =>
    execFileSync("git", [...GIT_IDENTITY, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function makeGitRepo(prefix: string, branch = "main"): GitRepo {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = gitIn(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n");
  git(["init", "-q", "-b", branch]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A local-path remote and its clone: `origin` fetches work fully offline,
 *  and committing in `remote.dir` advances the upstream the way a real
 *  origin would. */
function makeRemoteAndClone(): { remote: GitRepo; local: GitRepo } {
  const remote = makeGitRepo("bf-remote-");
  const localDir = mkdtempSync(path.join(os.tmpdir(), "bf-local-"));
  const git = gitIn(localDir);
  git(["clone", "-q", remote.dir, "."]);
  return { remote, local: { dir: localDir, git, cleanup: () => rmSync(localDir, { recursive: true, force: true }) } };
}

function insertItem(
  h: TestHarness,
  over: { slug: string; repo?: string; base?: string; stage?: StageName; status?: ItemRecord["status"] },
): ItemRecord {
  return h.db.insertItem({
    slug: over.slug,
    title: over.slug,
    repo: over.repo ?? "/tmp/repo",
    base: over.base ?? "main",
    approvals: [],
    stage: over.stage ?? ("implement" as StageName),
    status: over.status ?? "queued",
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- checker (real git)

describe("GitBaseFreshnessChecker", () => {
  it("exports the documented timeouts", () => {
    expect(FRESHNESS_FETCH_TIMEOUT_MS).toBe(30_000);
    expect(FRESHNESS_GIT_TIMEOUT_MS).toBe(10_000);
  });

  it("up-to-date base → proceed with equal short tips", () => {
    const { local } = makeRemoteAndClone();
    cleanups.push(local.cleanup);
    const r = new GitBaseFreshnessChecker().check(local.dir, "main");
    expect(r.action).toBe("proceed");
    expect(r.message).toBeNull();
    expect(r.localTip).toBe(r.upstreamTip);
    expect(r.localTip).toMatch(/^[0-9a-f]{7}$/);
  });

  it("base behind upstream after a successful fetch → skip (checker's own fetch sees the new tip)", () => {
    const { remote, local } = makeRemoteAndClone();
    cleanups.push(remote.cleanup, local.cleanup);
    fs.writeFileSync(path.join(remote.dir, "upstream.md"), "# merged upstream work\n");
    remote.git(["add", "-A"]);
    remote.git(["commit", "-q", "-m", "merge me"]);
    const r = new GitBaseFreshnessChecker().check(local.dir, "main");
    expect(r.action).toBe("skip");
    expect(r.localTip).not.toBe(r.upstreamTip);
    expect(r.localTip).toMatch(/^[0-9a-f]{7}$/);
    expect(r.upstreamTip).toMatch(/^[0-9a-f]{7}$/);
    expect(r.message).toBeNull();
  });

  it("fetch failure → warn-and-proceed with the fetch error", () => {
    const { local } = makeRemoteAndClone();
    cleanups.push(local.cleanup);
    local.git(["remote", "set-url", "origin", path.join(os.tmpdir(), `bf-nonexistent-${process.pid}`)]);
    const r = new GitBaseFreshnessChecker().check(local.dir, "main");
    expect(r.action).toBe("warn");
    expect(r.message).toContain("git fetch origin failed");
  });

  it("repo with no remote → proceed, nothing to compare", () => {
    const { local } = makeRemoteAndClone();
    cleanups.push(local.cleanup);
    local.git(["remote", "remove", "origin"]);
    const r = new GitBaseFreshnessChecker().check(local.dir, "main");
    expect(r.action).toBe("proceed");
    expect(r.upstreamTip).toBeNull();
    expect(r.message).toBeNull();
    // Same for a repo that never had a remote at all.
    const solo = makeGitRepo("bf-solo-");
    cleanups.push(solo.cleanup);
    const r2 = new GitBaseFreshnessChecker().check(solo.dir, "main");
    expect(r2.action).toBe("proceed");
    expect(r2.upstreamTip).toBeNull();
  });

  it("remote exists but origin lacks <base> → proceed with no upstream tip", () => {
    const remote = makeGitRepo("bf-remote-master-", "master");
    cleanups.push(remote.cleanup);
    const localDir = mkdtempSync(path.join(os.tmpdir(), "bf-local-"));
    const git = gitIn(localDir);
    cleanups.push(() => rmSync(localDir, { recursive: true, force: true }));
    git(["clone", "-q", remote.dir, "."]);
    git(["branch", "main"]); // local base exists, origin/main does not
    const r = new GitBaseFreshnessChecker().check(localDir, "main");
    expect(r.action).toBe("proceed");
    expect(r.upstreamTip).toBeNull();
    expect(r.localTip).toMatch(/^[0-9a-f]{7}$/);
    expect(r.message).toBeNull();
  });

  it("diverged base → warn, not skip (skip applies only to strictly-behind)", () => {
    const { remote, local } = makeRemoteAndClone();
    cleanups.push(remote.cleanup, local.cleanup);
    fs.writeFileSync(path.join(local.dir, "local-only.md"), "# local commit\n");
    local.git(["add", "-A"]);
    local.git(["commit", "-q", "-m", "local side"]);
    fs.writeFileSync(path.join(remote.dir, "remote-only.md"), "# remote commit\n");
    remote.git(["add", "-A"]);
    remote.git(["commit", "-q", "-m", "remote side"]);
    const r = new GitBaseFreshnessChecker().check(local.dir, "main");
    expect(r.action).toBe("warn");
    expect(r.message).toContain("diverged");
  });

  it("not a git directory → warn naming the path", () => {
    const r = new GitBaseFreshnessChecker().check(os.tmpdir(), "main");
    expect(r.action).toBe("warn");
    expect(r.message).toContain(os.tmpdir());
  });

  it("local base missing → warn", () => {
    const { remote, local } = makeRemoteAndClone();
    cleanups.push(remote.cleanup, local.cleanup);
    const r = new GitBaseFreshnessChecker().check(local.dir, "missing-branch");
    expect(r.action).toBe("warn");
    expect(r.message).toContain("missing-branch");
  });
});

// ---------------------------------------------------------------- orchestrator (fake checker at the port)

class FakeBaseCheck implements BaseFreshnessChecker {
  result: BaseFreshnessResult = { action: "proceed", message: null, localTip: null, upstreamTip: null };
  calls = 0;
  seen: { repo: string; base: string }[] = [];
  check(repoPath: string, base: string): BaseFreshnessResult {
    this.calls++;
    this.seen.push({ repo: repoPath, base });
    return this.result;
  }
}

class ThrowingBaseCheck implements BaseFreshnessChecker {
  check(): BaseFreshnessResult {
    throw new Error("checker exploded");
  }
}

const SKIP_RESULT: BaseFreshnessResult = {
  action: "skip",
  message: null,
  localTip: "a1b2c3d",
  upstreamTip: "e4f5g6h",
};

describe("orchestrator stale-base gate", () => {
  it("proceed → stage runs normally, no base-stale history, no warning", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    insertItem(h, { slug: "ok-item" });
    const report = await orch.tickAll();
    expect(runner.calls.length).toBe(1);
    expect(fake.calls).toBe(1);
    expect(report.changed).toBe(true);
    expect(report.entries[0]!.changed).toBeUndefined();
    const hist = h.db.getHistory(1);
    expect(hist.some((e) => e.event === "base-stale")).toBe(false);
    expect(hist.some((e) => e.event === "stage-start")).toBe(true);
    expect(h.db.getItem(1)!.parkedReason).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it("skip → reported, recorded, stage never runs, no worktree, no KB, no artifacts", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    fake.result = SKIP_RESULT;
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    insertItem(h, { slug: "stale-item" });
    const report = await orch.tickAll();
    // No runStage call ⇒ no worktree was ever created (worktrees are made
    // inside runStage → worktreeFor).
    expect(runner.calls.length).toBe(0);
    expect(runner.stageCallCounts.size).toBe(0);
    expect(fake.seen[0]).toEqual({ repo: "/tmp/repo", base: "main" });
    expect(report.changed).toBe(false);
    const entry = report.entries[0]!;
    expect(entry.changed).toBe(false);
    expect(entry.status).toBe("queued");
    expect(entry.detail).toContain("stale base: main (a1b2c3d) is behind origin/main (e4f5g6h)");
    expect(entry.detail).toContain("git pull");
    const item = h.db.getItem(1)!;
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("implement");
    expect(item.parkedReason).toBe("stale-base");
    const d = item.parkedDetail!;
    expect(d).toMatchObject({
      reason: "stale-base",
      base: "main",
      localTip: "a1b2c3d",
      upstreamTip: "e4f5g6h",
      repo: "/tmp/repo",
      remedy: "git pull",
    });
    const hist = h.db.getHistory(1);
    expect(hist.filter((e) => e.event === "base-stale").length).toBe(1);
    expect(hist.some((e) => e.event === "stage-start")).toBe(false);
    expect(h.db.getArtifacts(1).length).toBe(0);
    expect(fs.existsSync(projectKbFile(h.paths, "/tmp/repo"))).toBe(false);
  });

  it("skip against a real git repo leaves no worktree registration", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const repo = makeGitRepo("bf-nowt-");
    cleanups.push(repo.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    fake.result = SKIP_RESULT;
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    insertItem(h, { slug: "stale-real", repo: repo.dir });
    await orch.tickAll();
    expect(runner.calls.length).toBe(0);
    const wt = repo.git(["worktree", "list", "--porcelain"]);
    expect(wt).not.toContain(".sandcastle");
    expect(fs.existsSync(path.join(repo.dir, ".sandcastle"))).toBe(false);
  });

  it("PR stage is gated too: skip → publisher never called", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({});
    const publisher = new FakePublisher();
    const fake = new FakeBaseCheck();
    fake.result = SKIP_RESULT;
    const orch = makeOrchestrator(h, runner, { publisher, baseCheck: fake });
    insertItem(h, { slug: "stale-pr", stage: "pr" });
    const report = await orch.tickAll();
    expect(publisher.count()).toBe(0);
    expect(report.changed).toBe(false);
    const item = h.db.getItem(1)!;
    expect(item.status).toBe("queued");
    expect(item.parkedReason).toBe("stale-base");
    const hist = h.db.getHistory(1);
    expect(hist.some((e) => e.event === "pr-created")).toBe(false);
    expect(hist.filter((e) => e.event === "base-stale").length).toBe(1);
  });

  it("warn → warn-once on stderr, stage proceeds normally", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    fake.result = { action: "warn", message: "git fetch origin failed (offline)", localTip: null, upstreamTip: null };
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    insertItem(h, { slug: "warn-a" });
    insertItem(h, { slug: "warn-b" }); // same repo+base → memoized, no re-warn
    const report = await orch.tickAll();
    expect(runner.calls.length).toBe(2);
    expect(report.changed).toBe(true);
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("git fetch origin failed (offline)")).length).toBe(1);
    expect(lines.some((l) => l.includes("proceeding (factory stays usable offline)"))).toBe(true);
    const hist = h.db.getHistory(1);
    expect(hist.some((e) => e.event === "stage-start")).toBe(true);
    expect(h.db.getItem(1)!.parkedReason).toBeNull();
  });

  it("recovery: after a skip, a fresh invocation with a pulled base runs the stage and clears the marker", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    fake.result = SKIP_RESULT;
    const orch1 = makeOrchestrator(h, runner, { baseCheck: fake });
    insertItem(h, { slug: "recover-item" });
    const first = await orch1.tickAll();
    expect(first.changed).toBe(false);
    expect(h.db.getItem(1)!.parkedReason).toBe("stale-base");
    // Operator pulled; a NEW invocation (fresh Orchestrator, fresh memo).
    fake.result = { action: "proceed", message: null, localTip: null, upstreamTip: null };
    const orch2 = makeOrchestrator(h, runner, { baseCheck: fake });
    const second = await orch2.tickAll();
    expect(runner.calls.length).toBe(1);
    expect(second.changed).toBe(true);
    const item = h.db.getItem(1)!;
    expect(item.parkedReason).toBeNull();
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("test");
  });

  it("memoized per (repo, base) per invocation — one check per round, reused across resume ticks", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const script = {
      triage: [pass("triage")],
      spec: [pass("spec")],
      implement: [pass("implement")],
      test: [pass("test")],
      review: [pass("review")],
    };
    const runner = new ScriptedRunner(script);
    const fake = new FakeBaseCheck();
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    insertItem(h, { slug: "memo-item", stage: "triage" });
    await orch.resume();
    // The item crossed every stage in one resume invocation — still a
    // single checker call (memoized per repo+base per invocation).
    expect(fake.calls).toBe(1);
  });

  it("two items sharing (repo, base) in one round → a single check", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    insertItem(h, { slug: "memo-x" });
    insertItem(h, { slug: "memo-y" });
    const report = await orch.tickAll();
    expect(fake.calls).toBe(1);
    expect(report.entries.length).toBe(2);
  });

  it("a different base is a different memo key", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    const orch = makeOrchestrator(h, runner, { baseCheck: fake });
    insertItem(h, { slug: "memo-main", base: "main" });
    insertItem(h, { slug: "memo-dev", base: "develop" });
    await orch.tickAll();
    expect(fake.calls).toBe(2);
    expect(fake.seen.map((s) => s.base).sort()).toEqual(["develop", "main"]);
  });

  it("resume does not spin on a stale-base skip: one inner tick, not capped", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const fake = new FakeBaseCheck();
    fake.result = SKIP_RESULT;
    const orch = makeOrchestrator(h, runner, { baseCheck: fake, maxResumeTicks: 500 });
    insertItem(h, { slug: "spin-item" });
    const report = await orch.resume();
    expect(report.capped).toBe(false);
    expect(report.changed).toBe(false);
    expect(runner.calls.length).toBe(0);
    expect(report.entries.length).toBe(1); // one skip line, not 500
  });

  it("checker throw → warn-and-proceed, stage runs, nothing parked", async () => {
    const h = createHarness();
    cleanups.push(h.cleanup);
    const runner = new ScriptedRunner({ implement: [pass("implement")] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const orch = makeOrchestrator(h, runner, { baseCheck: new ThrowingBaseCheck() });
    insertItem(h, { slug: "throw-item" });
    const report = await orch.tickAll();
    expect(runner.calls.length).toBe(1);
    expect(report.changed).toBe(true);
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("checker exploded"))).toBe(true);
    expect(lines.some((l) => l.includes("proceeding (factory stays usable offline)"))).toBe(true);
    const item = h.db.getItem(1)!;
    expect(item.parkedReason).toBeNull();
    expect(h.db.getHistory(1).some((e) => e.event === "stage-start")).toBe(true);
  });
});