import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorktree } from "@ai-hero/sandcastle";

import {
  classifyFinding,
  planGc,
  runGc,
  makeGcFinding,
  GitGcScanner,
  GitGcReaper,
  ZERO_GC_FLAGS,
  renderGcHuman,
  type GcFlags,
  type GcFinding,
  type GcReapPlan,
  type GcReaper,
  type GcScanner,
  type RepoReport,
} from "../src/gc.js";
import { createHarness, type TestHarness } from "./helpers.js";
import type { ItemRecord, StageName } from "../src/types.js";

/**
 * `wb gc` tests, following the house conventions: planner logic is pure and
 * fully unit-tested; orchestration runs above the GcScanner/GcReaper seams
 * with fakes against a real temp-dir FactoryDb; scanner/reaper/E2E tests use
 * real git in temp repos (no Docker, no models, no network — gh is never
 * required, its absence degrades the PR probe to "unknown").
 */

const APPLY: GcFlags = { ...ZERO_GC_FLAGS, apply: true };

function flags(over: Partial<GcFlags>): GcFlags {
  return { ...ZERO_GC_FLAGS, ...over };
}

// ---------------------------------------------------------------- fakes

class FakeScanner implements GcScanner {
  readonly calls: { repo: string; items: ItemRecord[] }[] = [];
  constructor(private readonly build: (repo: string, items: ItemRecord[]) => RepoReport) {}
  async scanTarget(repo: string, items: ItemRecord[]): Promise<RepoReport> {
    this.calls.push({ repo, items });
    return this.build(repo, items);
  }
}

class SpyReaper implements GcReaper {
  readonly plans: GcReapPlan[] = [];
  constructor(private readonly behavior?: (plan: GcReapPlan) => void) {}
  async reap(plan: GcReapPlan): Promise<{ statusPorcelain: string; detail: string }> {
    this.plans.push(plan);
    if (this.behavior) this.behavior(plan);
    return {
      statusPorcelain: plan.dirty ? " M src/thing.ts\n" : "",
      detail: `reaped ${plan.finding.path ?? plan.finding.branch}`,
    };
  }
}

// ---------------------------------------------------------------- git fixtures

interface GitRepo {
  dir: string;
  git: (args: string[]) => string;
  cleanup: () => void;
}

function makeGitRepo(): GitRepo {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gc-repo-"));
  const git = (args: string[]): string =>
    execFileSync("git", ["-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  fs.writeFileSync(path.join(dir, "README.md"), "# gc test repo\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertItem(
  h: TestHarness,
  over: { slug: string; repo: string; status: ItemRecord["status"]; base?: string },
): ItemRecord {
  return h.db.insertItem({
    slug: over.slug,
    title: over.slug,
    repo: over.repo,
    base: over.base ?? "main",
    approvals: [],
    stage: "implement" as StageName,
    status: over.status,
  });
}

/** A worktree at the sandcastle-managed path holding `branch`. */
function addManagedWorktree(repo: GitRepo, branch: string): string {
  const name = branch.replace(/\//g, "-");
  const wt = path.join(repo.dir, ".sandcastle", "worktrees", name);
  repo.git(["worktree", "add", "-b", branch, wt]);
  return wt;
}

function commitFile(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "add", file],
    { encoding: "utf8" },
  );
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "commit", "-q", "-m", `add ${file}`],
    { encoding: "utf8" },
  );
}

function worktreePaths(repo: GitRepo): string[] {
  return repo
    .git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .map((p) => {
      // git realpaths worktree paths; macOS hosts sit under symlinked /var|/tmp.
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    });
}

function branchExists(repo: GitRepo, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repo.dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- planner tests

describe("planGc (pure decision matrix)", () => {
  const repo = "/repos/watchdog";

  function worktreeFinding(over: Partial<GcFinding> = {}): GcFinding {
    return makeGcFinding({ kind: "worktree", repo, path: "/repos/watchdog/.sandcastle/worktrees/factory-x", ...over });
  }
  function branchFinding(over: Partial<GcFinding> = {}): GcFinding {
    return makeGcFinding({ kind: "branch", repo, ...over });
  }
  function report(...findings: GcFinding[]): RepoReport[] {
    return [{ repo, reachable: true, findings, housekeeping: { repo, reachable: true, prunableDirs: [], factoryBranchCount: 0, factoryBranchOrphans: [], sandcastleAdjacents: { envDotFile: false, logFiles: 0 } } }];
  }
  const ops = (plans: GcReapPlan[]) => plans.map((p) => p.op);

  it("reaps the clean worktree of a terminal item", () => {
    const f = worktreeFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", dirty: false });
    expect(classifyFinding(f, ZERO_GC_FLAGS)).toEqual({ action: "remove", requiresFlag: null, reason: "terminal item" });
    expect(ops(planGc(report(f), APPLY))).toEqual(["remove-worktree"]);
  });

  it("holds a dirty terminal worktree until --force-dirty, then reaps it", () => {
    const f = worktreeFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", dirty: true });
    expect(classifyFinding(f, APPLY)).toMatchObject({ action: "remove", requiresFlag: "--force-dirty" });
    expect(ops(planGc(report(f), APPLY))).toEqual([]);
    const withForce = planGc(report(f), flags({ apply: true, forceDirty: true }));
    expect(ops(withForce)).toEqual(["remove-worktree"]);
  });

  it("keeps a terminal item's branch by default", () => {
    const f = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: false, openPr: "unknown" });
    expect(classifyFinding(f, APPLY)).toMatchObject({ action: "keep", reason: expect.stringContaining("kept by default") });
    expect(planGc(report(f), APPLY)).toHaveLength(0);
  });

  it("deletes a --delete-branches branch provably merged into base", () => {
    const f = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: true });
    const plans = planGc(report(f), flags({ apply: true, deleteBranches: true }));
    expect(ops(plans)).toEqual(["delete-branch"]);
  });

  it("keeps an unmerged --delete-branches branch when its PR is open", () => {
    const f = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: false, openPr: { number: 12, url: "https://x", draft: false } });
    const c = classifyFinding(f, flags({ apply: true, deleteBranches: true }));
    expect(c.action).toBe("keep");
    expect(c.reason).toContain("unmerged");
    expect(planGc(report(f), flags({ apply: true, deleteBranches: true }))).toHaveLength(0);
  });

  it("holds an unmerged no-open-PR branch until --force-branches, then deletes it", () => {
    const f = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: false, openPr: null });
    const base = flags({ apply: true, deleteBranches: true });
    expect(classifyFinding(f, base)).toMatchObject({ action: "keep", requiresFlag: "--force-branches" });
    expect(planGc(report(f), base)).toHaveLength(0);
    expect(ops(planGc(report(f), flags({ apply: true, deleteBranches: true, forceBranches: true })))).toEqual(["delete-branch"]);
  });

  it("keeps an unmerged branch whose PR status is unknown (gh absent)", () => {
    const f = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: false, openPr: "unknown" });
    const c = classifyFinding(f, flags({ apply: true, deleteBranches: true, forceBranches: true }));
    expect(c.action).toBe("keep");
    expect(c.reason).toContain("unknown");
    expect(planGc(report(f), flags({ apply: true, deleteBranches: true, forceBranches: true }))).toHaveLength(0);
  });

  it("protects non-terminal items: worktree reaped only as stale-branch repair, branch never deleted", () => {
    const wt = worktreeFinding({ itemId: 9, slug: "b", itemStatus: "exhausted-rework", branch: "factory/b", dirty: false });
    const br = branchFinding({ itemId: 9, slug: "b", itemStatus: "exhausted-rework", branch: "factory/b" });
    const cWt = classifyFinding(wt, APPLY);
    expect(cWt.action).toBe("remove");
    expect(cWt.reason).toContain("branch protected: item non-terminal");
    const cBr = classifyFinding(br, APPLY);
    expect(cBr).toEqual({ action: "keep", requiresFlag: null, reason: "live — protected: item non-terminal" });
    const plans = planGc(report(wt, br), APPLY);
    expect(ops(plans)).toEqual(["remove-worktree"]); // branch kept even with --delete-branches
    const withDelete = planGc(report(wt, br), flags({ apply: true, deleteBranches: true, forceBranches: true }));
    expect(ops(withDelete)).toEqual(["remove-worktree"]);
  });

  it("holds a dirty stale worktree of a non-terminal item until --force-dirty", () => {
    const wt = worktreeFinding({ itemId: 9, slug: "b", itemStatus: "infrastructure-failure", branch: "factory/b", dirty: true });
    expect(ops(planGc(report(wt), APPLY))).toEqual([]);
    expect(ops(planGc(report(wt), flags({ apply: true, forceDirty: true })))).toEqual(["remove-worktree"]);
  });

  it("reports orphans only, unless --force-orphans", () => {
    const wt = worktreeFinding({ branch: "factory/gone", orphan: true, dirty: false });
    const dir = makeGcFinding({ kind: "prunable-dir", repo, path: "/repos/watchdog/.sandcastle/worktrees/factory-gone-item", sizeBytes: 5, orphan: true });
    const c = classifyFinding(wt, APPLY);
    expect(c).toMatchObject({ action: "report-only", requiresFlag: "--force-orphans" });
    expect(planGc(report(wt, dir), APPLY)).toHaveLength(0);
    const forced = planGc(report(wt, dir), flags({ apply: true, forceOrphans: true }));
    expect(ops(forced)).toEqual(["remove-worktree", "remove-worktree"]);
  });

  it("empty DB report proposes deleting nothing (rebuilt-root safety)", () => {
    // After `wb init` every existing worktree is an orphan; with no force
    // flags the plan set is empty even though findings exist.
    const wt = worktreeFinding({ branch: "factory/gone", orphan: true, dirty: false });
    const br = branchFinding({ branch: "factory/other", itemStatus: null, itemId: null, orphan: true });
    expect(planGc(report(wt, br), ZERO_GC_FLAGS)).toHaveLength(0);
  });

  it("never schedules a branch deletion whose worktree is not being removed", () => {
    // Terminal item, dirty worktree (held), branch provably merged — the
    // branch is still checked out in the held worktree, so deletion must be
    // skipped until the worktree goes.
    const wt = worktreeFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", dirty: true });
    const br = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: true });
    const f = flags({ apply: true, deleteBranches: true });
    expect(ops(planGc(report(wt, br), f))).toEqual([]);
    expect(ops(planGc(report(wt, br), flags({ apply: true, deleteBranches: true, forceDirty: true })))).toEqual([
      "remove-worktree",
      "delete-branch",
    ]);
  });

  it("orders worktree removals before branch deletions", () => {
    const wt = worktreeFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", dirty: false });
    const br = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: true });
    const plans = planGc(report(wt, br), flags({ apply: true, deleteBranches: true }));
    expect(ops(plans)).toEqual(["remove-worktree", "delete-branch"]);
  });

  it("holds an UNKNOWN dirty state (probe failed) like dirty, in every reap path", () => {
    // dirty: null = probe failed on an existing dir — never reap without
    // --force-dirty (AC: no reap of uncommitted changes without the flag).
    const terminal = worktreeFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", dirty: null });
    expect(classifyFinding(terminal, APPLY)).toMatchObject({ action: "remove", requiresFlag: "--force-dirty" });
    expect(ops(planGc(report(terminal), APPLY))).toEqual([]);
    expect(ops(planGc(report(terminal), flags({ apply: true, forceDirty: true })))).toEqual(["remove-worktree"]);

    const stale = worktreeFinding({ itemId: 9, slug: "b", itemStatus: "infrastructure-failure", branch: "factory/b", dirty: null });
    expect(ops(planGc(report(stale), APPLY))).toEqual([]);
    expect(ops(planGc(report(stale), flags({ apply: true, forceDirty: true })))).toEqual(["remove-worktree"]);

    const orphan = worktreeFinding({ branch: "factory/gone", orphan: true, dirty: null });
    expect(classifyFinding(orphan, flags({ apply: true, forceOrphans: true }))).toMatchObject({
      action: "report-only",
      requiresFlag: "--force-dirty",
    });
    expect(ops(planGc(report(orphan), flags({ apply: true, forceOrphans: true })))).toEqual([]);
  });

  it("keeps an admin-locked worktree and shields its branch from deletion", () => {
    const wt = worktreeFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", dirty: false, locked: true });
    expect(classifyFinding(wt, flags({ apply: true, forceDirty: true, forceOrphans: true }))).toMatchObject({
      action: "keep",
      reason: "admin-locked — skipped",
    });
    const br = branchFinding({ itemId: 1, slug: "a", itemStatus: "done", branch: "factory/a", mergedIntoBase: true });
    // The worktree is kept, so even a merge-base-provable branch stays.
    expect(ops(planGc(report(wt, br), flags({ apply: true, deleteBranches: true })))).toEqual([]);
  });
});

// ---------------------------------------------------------------- orchestrator tests

describe("runGc (fake scanner + spy reaper + real FactoryDb)", () => {
  const harnesses: TestHarness[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  function scannerFor(h: TestHarness, status: ItemRecord["status"]): FakeScanner {
    return new FakeScanner((repo, items) => ({
      repo,
      reachable: true,
      findings: items.flatMap((item) => [
        makeGcFinding({
          kind: "worktree",
          repo,
          itemId: item.id,
          slug: item.slug,
          itemStatus: item.status,
          itemUpdatedAt: item.updatedAt,
          path: path.join(repo, ".sandcastle", "worktrees", item.branchName.replace(/\//g, "-")),
          branch: item.branchName,
          dirty: false,
          sizeBytes: 123,
        }),
        makeGcFinding({
          kind: "branch",
          repo,
          itemId: item.id,
          slug: item.slug,
          itemStatus: item.status,
          itemUpdatedAt: item.updatedAt,
          branch: item.branchName,
          mergedIntoBase: false,
          openPr: "unknown",
        }),
      ]),
      housekeeping: {
        repo,
        reachable: true,
        prunableDirs: [],
        factoryBranchCount: items.length,
        factoryBranchOrphans: [],
        sandcastleAdjacents: { envDotFile: false, logFiles: 0 },
      },
    }));
  }

  it("--apply reaps terminal and stale worktrees, keeps every branch, and appends gc history + artifacts", async () => {
    const h = makeHarness();
    const repoDir = path.join(os.tmpdir(), "gc-fake-repo");
    const done = insertItem(h, { slug: "done-item", repo: repoDir, status: "done" });
    const live = insertItem(h, { slug: "live-item", repo: repoDir, status: "awaiting-approval" });
    const reaper = new SpyReaper();
    const result = await runGc({ db: h.db, paths: h.paths, scanner: scannerFor(h, "done"), reaper }, APPLY);

    // Both worktrees are reaped — the terminal item's as garbage, the
    // non-terminal item's as a rule-5 stale-branch repair — and no branch
    // (the item's only copy of unmerged work) is ever deleted.
    expect(reaper.plans.map((p) => p.op)).toEqual(["remove-worktree", "remove-worktree"]);
    expect(reaper.plans.every((p) => p.finding.itemId !== null)).toBe(true);

    const doneRow = h.db.getHistory(done.id).find((r) => r.event === "gc")!;
    expect(doneRow.detail).toMatchObject({ kind: "worktree", branch: done.branchName, action: "remove-worktree", reason: "terminal-item" });
    const artifacts = h.db.getArtifacts(done.id);
    expect(artifacts.some((a) => a.name === "gc-dirty-diff")).toBe(true);
    const artifactFile = fs.readdirSync(path.join(h.paths.items, done.slug, "artifacts")).find((n) => n.startsWith("gc-"));
    expect(artifactFile).toBeDefined();
    const content = fs.readFileSync(path.join(h.paths.items, done.slug, "artifacts", artifactFile!), "utf8");
    expect(content).toContain(`#${done.id} done-item [done]`);
    expect(content).toContain("(clean)");

    const liveRow = h.db.getHistory(live.id).find((r) => r.event === "gc")!;
    expect(liveRow.detail).toMatchObject({ reason: "stale-branch-conflict-repair" });
    expect(h.db.getArtifacts(live.id).some((a) => a.name === "gc-dirty-diff")).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.summary.worktreesReapable).toBe(2);
  });

  it("rule-5 repair of a non-terminal item reaps the stale worktree, keeps the branch, records the repair reason", async () => {
    const h = makeHarness();
    const repoDir = path.join(os.tmpdir(), "gc-fake-repo");
    const live = insertItem(h, { slug: "infra-item", repo: repoDir, status: "infrastructure-failure" });
    const reaper = new SpyReaper();
    await runGc({ db: h.db, paths: h.paths, scanner: scannerFor(h, "infrastructure-failure"), reaper }, APPLY);
    expect(reaper.plans.map((p) => p.op)).toEqual(["remove-worktree"]);
    expect(reaper.plans[0]!.finding.itemId).toBe(live.id);
    const gcRow = h.db.getHistory(live.id).find((r) => r.event === "gc")!;
    expect(gcRow.detail).toMatchObject({ reason: "stale-branch-conflict-repair" });
    // Branch untouched by the plan set even under --delete-branches.
    const reaper2 = new SpyReaper();
    await runGc({ db: h.db, paths: h.paths, scanner: scannerFor(h, "infrastructure-failure"), reaper: reaper2 }, flags({ apply: true, deleteBranches: true, forceBranches: true }));
    expect(reaper2.plans.map((p) => p.op)).toEqual(["remove-worktree"]);
  });

  it("a reaper failure does not abort sibling reaps and surfaces in errors", async () => {
    const h = makeHarness();
    const repoDir = path.join(os.tmpdir(), "gc-fake-repo");
    const a = insertItem(h, { slug: "aaa-item", repo: repoDir, status: "done" });
    const b = insertItem(h, { slug: "bbb-item", repo: repoDir, status: "done" });
    const reaper = new SpyReaper((plan) => {
      if (plan.finding.itemId === a.id) throw new Error("simulated git failure");
    });
    const result = await runGc({ db: h.db, paths: h.paths, scanner: scannerFor(h, "done"), reaper }, APPLY);
    expect(reaper.plans).toHaveLength(2); // both attempted
    expect(result.errors).toHaveLength(1);
    expect(result.reaped.find((r) => r.finding.itemId === b.id)?.ok).toBe(true);
    expect(result.reaped.find((r) => r.finding.itemId === a.id)?.ok).toBe(false);
    // no history row for the failed reap
    expect(h.db.getHistory(a.id).some((r) => r.event === "gc")).toBe(false);
    expect(h.db.getHistory(b.id).some((r) => r.event === "gc")).toBe(true);
  });

  it("report mode never calls the reaper and writes nothing", async () => {
    const h = makeHarness();
    const repoDir = path.join(os.tmpdir(), "gc-fake-repo");
    insertItem(h, { slug: "done-item", repo: repoDir, status: "done" });
    const reaper = new SpyReaper();
    const result = await runGc({ db: h.db, paths: h.paths, scanner: scannerFor(h, "done"), reaper }, ZERO_GC_FLAGS);
    expect(reaper.plans).toHaveLength(0);
    expect(result.reportOnly).toBe(true);
    expect(result.reaped).toHaveLength(0);
    expect(result.summary.worktreesReapable).toBe(1); // would-be action still reported
    for (const item of h.db.listItems()) {
      expect(h.db.getHistory(item.id)).toHaveLength(0);
      expect(h.db.getArtifacts(item.id)).toHaveLength(0);
    }
    expect(fs.existsSync(path.join(h.paths.items, "done-item", "artifacts"))).toBe(false);
  });
});

describe("renderGcHuman (ticket output shape)", () => {
  const repo = "/repos/watchdog";
  function worktreeFinding(over: Partial<GcFinding> = {}): GcFinding {
    return makeGcFinding({ kind: "worktree", repo, path: path.join(repo, ".sandcastle/worktrees/factory-x"), ...over });
  }
  function report(...findings: GcFinding[]): RepoReport[] {
    return [{ repo, reachable: true, findings, housekeeping: { repo, reachable: true, prunableDirs: [], factoryBranchCount: 0, factoryBranchOrphans: [], sandcastleAdjacents: { envDotFile: false, logFiles: 0 } } }];
  }
  function renderReport(findings: GcFinding[]): string {
    return renderGcHuman({
      generatedAt: "2026-10-28T00:00:00.000Z",
      reportOnly: true,
      flags: { apply: false, deleteBranches: false, forceBranches: false, forceDirty: false, forceOrphans: false },
      reports: report(...findings),
      reaped: [],
      errors: [],
      summary: { worktreesReapable: 0, worktreeBytes: 0, branchesDeletable: 0, branchesKeepUnmerged: 0, orphans: 0 },
    });
  }

  it("prints the item header with last activity (itemUpdatedAt)", () => {
    const f = worktreeFinding({
      itemId: 1,
      slug: "a",
      itemStatus: "done",
      itemUpdatedAt: "2026-10-28T13:00:00.000Z",
      branch: "factory/a",
      dirty: false,
      action: "remove",
      requiresFlag: null,
      reason: "terminal item",
    });
    const out = renderReport([f]);
    expect(out).toContain("#1 a [done] repo=/repos/watchdog updated=2026-10-28T13:00:00.000Z");
  });
});

// ---------------------------------------------------------------- real-git scanner tests

describe("GitGcScanner / GitGcReaper (real git, temp repos)", () => {
  const harnesses: TestHarness[] = [];
  const repos: GitRepo[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  function makeRepo() {
    const r = makeGitRepo();
    repos.push(r);
    return r;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
    while (repos.length > 0) repos.pop()?.cleanup();
  });

  it("scans a managed worktree: branch/size/dirty/action for a terminal item", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    const item = insertItem(h, { slug: "fix-flaky", repo: repo.dir, status: "done" });
    const wt = addManagedWorktree(repo, item.branchName);
    commitFile(wt, "src.ts", "export const x = 1;\n");

    const report = await new GitGcScanner().scanTarget(fs.realpathSync(repo.dir), [item]);
    expect(report.reachable).toBe(true);
    const f = report.findings.find((x) => x.kind === "worktree" && x.itemId === item.id)!;
    expect(f.branch).toBe(item.branchName);
    expect(f.path).toBe(fs.realpathSync(wt));
    expect(f.dirty).toBe(false);
    expect(f.sizeBytes).toBeGreaterThan(0);
    expect(f.mergedIntoBase).toBe(false); // branch has a commit base lacks
    expect(f.action).toBe("remove");
    expect(f.reason).toBe("terminal item");
    const br = report.findings.find((x) => x.kind === "branch" && x.itemId === item.id)!;
    expect(br.mergedIntoBase).toBe(false);
    expect(br.openPr).toBe("unknown"); // gh absent/unauthenticated in tests — never a deletion input
  });

  it("classifies a dirty worktree via the same probe sandcastle uses", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    const item = insertItem(h, { slug: "dirty-item", repo: repo.dir, status: "done" });
    const wt = addManagedWorktree(repo, item.branchName);
    fs.writeFileSync(path.join(wt, "junk.txt"), "uncommitted\n");

    const report = await new GitGcScanner().scanTarget(repo.dir, [item]);
    const f = report.findings.find((x) => x.kind === "worktree")!;
    expect(f.dirty).toBe(true);
    expect(f.requiresFlag).toBe("--force-dirty");
  });

  it("detects orphans (no item row) and prunable dirs, report-only by default", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    addManagedWorktree(repo, "factory/gone-item"); // no DB row for it
    const repoReal = fs.realpathSync(repo.dir);
    const leftover = path.join(repoReal, ".sandcastle", "worktrees", "factory-crash-leftover");
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "half-written.txt"), "x");

    const report = await new GitGcScanner().scanTarget(repo.dir, []);
    const orphanWt = report.findings.find((x) => x.kind === "worktree")!;
    expect(orphanWt.orphan).toBe(true);
    expect(orphanWt.branch).toBe("factory/gone-item");
    expect(orphanWt.action).toBe("report-only");
    expect(orphanWt.requiresFlag).toBe("--force-orphans");
    const dir = report.findings.find((x) => x.kind === "prunable-dir")!;
    expect(dir.path).toBe(leftover);
    expect(dir.action).toBe("report-only");
    expect(report.housekeeping.prunableDirs).toEqual([leftover]);
    expect(report.housekeeping.factoryBranchOrphans).toEqual([]); // factory/gone-item is held by a worktree
  });

  it("never reaps or unlocks an admin-locked worktree (scan + apply)", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    const item = insertItem(h, { slug: "locked-item", repo: repo.dir, status: "done" });
    const wt = addManagedWorktree(repo, item.branchName);
    repo.git(["worktree", "lock", wt]);

    const scan = await new GitGcScanner().scanTarget(repo.dir, [item]);
    const f = scan.findings.find((x) => x.kind === "worktree")!;
    expect(f.locked).toBe(true);
    expect(f.action).toBe("keep");
    expect(f.reason).toBe("admin-locked — skipped");

    const result = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      flags({ apply: true, forceDirty: true, forceOrphans: true }),
    );
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(wt)).toBe(true); // untouched
    expect(h.db.getHistory(item.id).some((r) => r.event === "gc")).toBe(false);
  });

  it("probes merge-base for merged vs unmerged branches", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    const item = insertItem(h, { slug: "merged-item", repo: repo.dir, status: "done" });
    const wt = addManagedWorktree(repo, item.branchName);
    commitFile(wt, "feature.txt", "done\n");
    execFileSync("git", ["-C", repo.dir, "merge", "--ff-only", item.branchName], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const report = await new GitGcScanner().scanTarget(repo.dir, [item]);
    const br = report.findings.find((x) => x.kind === "branch")!;
    expect(br.mergedIntoBase).toBe(true);
    const plans = planGc([report], flags({ apply: true, deleteBranches: true }));
    expect(plans.map((p) => p.op)).toEqual(["remove-worktree", "delete-branch"]);
  });

  it("reports an unreachable repo instead of crashing", async () => {
    const h = makeHarness();
    const report = await new GitGcScanner().scanTarget(path.join(os.tmpdir(), "gc-no-such-repo-xyz"), []);
    expect(report.reachable).toBe(false);
    expect(report.findings[0]!.kind).toBe("unreachable-repo");
    expect(report.findings[0]!.action).toBe("report-only");
  });

  it("reaps a terminal worktree and deletes a provably-merged branch end to end", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    const item = insertItem(h, { slug: "reap-me", repo: repo.dir, status: "done" });
    const wt = addManagedWorktree(repo, item.branchName);
    commitFile(wt, "feature.txt", "done\n");
    execFileSync("git", ["-C", repo.dir, "merge", "--ff-only", item.branchName], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const result = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      flags({ apply: true, deleteBranches: true }),
    );
    expect(result.errors).toEqual([]);
    expect(worktreePaths(repo)).toEqual([fs.realpathSync(repo.dir)]);
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists(repo, item.branchName)).toBe(false);
    const gcRows = h.db.getHistory(item.id).filter((r) => r.event === "gc");
    expect(gcRows.map((r) => (r.detail as { kind: string }).kind)).toEqual(["worktree", "branch"]);
    expect((gcRows[1]!.detail as { evidence: string }).evidence).toBe("merge-base");
  });

  it("refuses a dirty worktree without --force-dirty and records the changed-file list when forced", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    const item = insertItem(h, { slug: "dirty-reap", repo: repo.dir, status: "done" });
    const wt = addManagedWorktree(repo, item.branchName);
    fs.writeFileSync(path.join(wt, "uncommitted.txt"), "precious agent output\n");

    const held = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      APPLY,
    );
    expect(held.errors).toEqual([]);
    expect(fs.existsSync(wt)).toBe(true); // untouched

    const forced = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      flags({ apply: true, forceDirty: true }),
    );
    expect(forced.errors).toEqual([]);
    expect(fs.existsSync(wt)).toBe(false);
    const artifactFile = fs
      .readdirSync(path.join(h.paths.items, item.slug, "artifacts"))
      .find((n) => n.startsWith("gc-"))!;
    const content = fs.readFileSync(path.join(h.paths.items, item.slug, "artifacts", artifactFile), "utf8");
    expect(content).toContain("uncommitted.txt");
  });

  it("orphans are reaped only under --force-orphans", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    // The repo must be referenced by an item row for runGc to enumerate it;
    // this item's branch is unrelated to the orphan below.
    insertItem(h, { slug: "unrelated", repo: repo.dir, status: "done" });
    const orphanWt = addManagedWorktree(repo, "factory/gone-item");
    const repoReal = fs.realpathSync(repo.dir);
    const leftover = path.join(repoReal, ".sandcastle", "worktrees", "factory-crash-leftover");
    fs.mkdirSync(leftover, { recursive: true });

    const held = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      APPLY,
    );
    expect(held.errors).toEqual([]);
    expect(fs.existsSync(orphanWt)).toBe(true);
    expect(fs.existsSync(leftover)).toBe(true);

    const forced = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      flags({ apply: true, forceOrphans: true }),
    );
    expect(forced.errors).toEqual([]);
    expect(fs.existsSync(orphanWt)).toBe(false);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(worktreePaths(repo)).toEqual([fs.realpathSync(repo.dir)]);
  });
});

// ---------------------------------------------------------------- crash-recovery E2E

describe("crash-recovery E2E (real git + real sandcastle createWorktree)", () => {
  const harnesses: TestHarness[] = [];
  const repos: GitRepo[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
    while (repos.length > 0) repos.pop()?.cleanup();
  });

  it("a leaked worktree holding factory/<slug> blocks createWorktree; gc --apply repairs it", async () => {
    const repo = makeGitRepo();
    repos.push(repo);
    const h = createHarness();
    harnesses.push(h);
    const item = insertItem(h, { slug: "e2e-item", repo: repo.dir, status: "queued" });

    // Simulate the crash leak OUTSIDE the runner (unmanaged path): git
    // refuses the same branch in two worktrees, and sandcastle's
    // findCollidingWorktree turns that into a hard WorktreeError.
    const leaked = path.join(os.tmpdir(), `gc-leaked-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    execFileSync("git", ["worktree", "add", "-b", item.branchName, leaked], { cwd: repo.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const attempt = () =>
      createWorktree({
        cwd: repo.dir,
        branchStrategy: { type: "branch", branch: item.branchName, baseBranch: item.base },
      });
    await expect(attempt()).rejects.toThrow(/already checked out/i);

    const result = await runGc(
      { db: h.db, paths: h.paths, scanner: new GitGcScanner(), reaper: new GitGcReaper() },
      APPLY,
    );
    expect(result.errors).toEqual([]);

    // The leaked worktree is gone; the branch (the item's only work) survives.
    expect(fs.existsSync(leaked)).toBe(false);
    expect(worktreePaths(repo)).toEqual([fs.realpathSync(repo.dir)]);
    expect(branchExists(repo, item.branchName)).toBe(true);
    const gcRow = h.db.getHistory(item.id).find((r) => r.event === "gc")!;
    expect(gcRow.detail).toMatchObject({ reason: "stale-branch-conflict-repair" });

    // The previously-failing createWorktree now succeeds on the same branch.
    const wt = await attempt();
    try {
      expect(fs.existsSync(wt.worktreePath)).toBe(true);
    } finally {
      await wt.close();
    }
  }, 120_000);
});

