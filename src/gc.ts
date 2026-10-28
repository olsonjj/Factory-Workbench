/**
 * `wb gc` — worktree/branch/repo-artifact reconciliation and cleanup.
 *
 * Garbage accumulates in the TARGET repos (`<repo>/.sandcastle/worktrees/`
 * holds one leaked worktree per crashed item, each possibly carrying hundreds
 * of MB of node_modules), plus factory/* branches and unregistered leftover
 * dirs. Report mode is read-only and lock-free (reconciliation races are
 * cosmetic in a report); `--apply` is a mutating verb that takes the factory
 * lock — under the lock no live run exists, so every worktree holding a
 * non-terminal item's branch is by construction a stale (crash-leaked) one
 * and may be pruned while the branch itself is kept (rule-5 repair).
 *
 * Structure mirrors `runner.ts`-style ports: `GcScanner` produces facts,
 * `planGc` (pure) turns facts + flags into reaps, `GcReaper` executes, and
 * `runGc` orchestrates without touching the StageRunner/Orchestrator seam.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { artifactDir, type FactoryPaths } from "./paths.js";
import { stamp } from "./util.js";
import { TERMINAL_STATUSES, type ItemRecord, type ItemStatus } from "./types.js";
import type { FactoryDb } from "./db.js";

// ---------------------------------------------------------------- types

export type GcAction = "remove" | "keep" | "report-only";

/** One fact row produced by the scanner; decisions live in `action`/`reason`
 *  (filled by `classifyFinding` — provisionally by the scanner with zero
 *  flags, definitively by `runGc` with the operator's flags). */
export interface GcFinding {
  kind: "worktree" | "branch" | "prunable-dir" | "unreachable-repo";
  /** Resolved, real path of the repo the finding belongs to. */
  repo: string;
  itemId: number | null;
  slug: string | null;
  itemStatus: ItemStatus | null;
  itemUpdatedAt: string | null;
  /** Worktree path / leftover dir (null for branch findings). */
  path: string | null;
  /** Git-visible branch name (factory/…; null for prunable dirs). */
  branch: string | null;
  /** HEAD sha of the branch as seen in the worktree scan (insurance record). */
  headSha: string | null;
  /** Recursive du-style sum, approximate. */
  sizeBytes: number | null;
  /** `git status --porcelain` non-empty (same probe as sandcastle); false = provably clean (or the
   *  worktree dir is gone — nothing to lose); null = probe failed on an existing dir (unknown,
   *  holds the reap like dirty). */
  dirty: boolean | null;
  /** Admin-locked (`git worktree lock`) — operator-retained; never reaped, reported as kept. */
  locked: boolean;
  openPr: { number: number; url: string; draft: boolean } | null | "unknown";
  /** `git merge-base --is-ancestor <branch> <item.base>`; null when unprobeable. */
  mergedIntoBase: boolean | null;
  /** No item row references the branch. */
  orphan: boolean;
  action: GcAction;
  requiresFlag: null | "--force-orphans" | "--force-dirty" | "--force-branches" | "--delete-branches";
  reason: string;
}

export interface RepoHousekeeping {
  repo: string;
  reachable: boolean;
  /** Dirs under .sandcastle/worktrees/ not registered in `git worktree list`. */
  prunableDirs: string[];
  /** Count of `git branch --list "factory/*"`. */
  factoryBranchCount: number;
  /** factory/* branches with no item row and no worktree (report-only in v1). */
  factoryBranchOrphans: string[];
  /** `.sandcastle/.env` presence and `.sandcastle/logs` file count — report only. */
  sandcastleAdjacents: { envDotFile: boolean; logFiles: number };
}

export interface RepoReport {
  repo: string;
  reachable: boolean;
  findings: GcFinding[];
  housekeeping: RepoHousekeeping;
}

export interface GcScanner {
  scanTarget(repoPath: string, items: ItemRecord[]): Promise<RepoReport>;
}

export interface GcReapPlan {
  finding: GcFinding;
  /** worktree removal | branch deletion */
  op: "remove-worktree" | "delete-branch";
  dirty: boolean;
}

export interface GcReaper {
  /** Execute one planned op. Returns the changed-file list (`git status
   *  --porcelain`, "" when clean — captured before anything is removed) and a
   *  short description. Throwing on git failure is allowed; the orchestrator
   *  catches per-finding. */
  reap(plan: GcReapPlan): Promise<{ statusPorcelain: string; detail: string }>;
}

export interface GcFlags {
  apply: boolean;
  deleteBranches: boolean;
  forceBranches: boolean;
  forceDirty: boolean;
  forceOrphans: boolean;
  json: boolean;
}

export const ZERO_GC_FLAGS: GcFlags = {
  apply: false,
  deleteBranches: false,
  forceBranches: false,
  forceDirty: false,
  forceOrphans: false,
  json: false,
};

export interface GcDeps {
  db: Pick<FactoryDb, "listItems" | "appendHistory" | "addArtifact" | "getItem">;
  paths: FactoryPaths;
  scanner: GcScanner;
  reaper: GcReaper;
  /** Injectable clock (default: real time). */
  now?: () => string;
}

export interface ReapOutcome {
  finding: GcFinding;
  op: "remove-worktree" | "delete-branch";
  ok: boolean;
  detail: string;
}

export interface GcSummary {
  worktreesReapable: number;
  worktreeBytes: number;
  branchesDeletable: number;
  branchesKeepUnmerged: number;
  orphans: number;
}

export interface GcResult {
  generatedAt: string;
  reportOnly: boolean;
  flags: Omit<GcFlags, "json">;
  reports: RepoReport[];
  reaped: ReapOutcome[];
  errors: unknown[];
  summary: GcSummary;
}

/** Finding factory with fact-field defaults (decisions filled by classify). */
export function makeGcFinding(
  p: Partial<GcFinding> & Pick<GcFinding, "kind" | "repo">,
): GcFinding {
  return {
    itemId: null,
    slug: null,
    itemStatus: null,
    itemUpdatedAt: null,
    path: null,
    branch: null,
    headSha: null,
    sizeBytes: null,
    dirty: null,
    locked: false,
    openPr: null,
    mergedIntoBase: null,
    orphan: false,
    action: "report-only",
    requiresFlag: null,
    reason: "",
    ...p,
  };
}

// ---------------------------------------------------------------- helpers

/** Resolve an item's `repo` the way the pipeline does, then realpath it —
 *  git records worktree links as realpaths, so every path comparison in the
 *  scanner must run on realpaths. */
export function resolveGcRepoPath(repo: string): string {
  const resolved = path.isAbsolute(repo) ? repo : path.resolve(repo);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isTerminal(status: ItemStatus | null): boolean {
  return status !== null && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function exitCodeOf(err: unknown): number | null {
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}

/** Same probe as sandcastle's `hasUncommittedChanges` (§ spec 1.2) so gc's
 *  dirty classification matches sandcastle's worktree-reuse behavior.
 *  Fact semantics are conservative: a *missing* worktree dir is false
 *  (nothing to lose — the reaper can only prune the registration); a failed
 *  probe on an *existing* dir is null — unknown holds the reap like dirty
 *  (AC: never reap without `--force-dirty` unless provably clean). */
function dirtyProbe(worktreePath: string): boolean | null {
  if (!fs.existsSync(worktreePath)) return false;
  const status = statusPorcelain(worktreePath);
  return status === null ? null : status.trim() !== "";
}

/** Same probe as sandcastle's `hasUncommittedChanges` (§ spec 1.2) so gc's
 *  dirty classification matches sandcastle's worktree-reuse behavior. */
export function statusPorcelain(worktreePath: string): string | null {
  try {
    return execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/** Recursive file-size sum (pure Node, no `du`); approximate. */
export function dirSize(p: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* racing deletion */
        }
      }
    }
  };
  try {
    fs.statSync(p);
  } catch {
    return 0;
  }
  walk(p);
  return total;
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** `gh` open-PR probe. Unlike `GhPrPublisher.findExisting` (which swallows
 *  every error into `undefined`), this preserves the distinction between
 *  "probe confirmed no open PR" (null) and "gh unavailable" ("unknown") —
 *  only the former may ever feed a deletion decision. */
function probeOpenPr(
  repoPath: string,
  branch: string,
  base: string,
): { number: number; url: string; draft: boolean } | null | "unknown" {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--base", base, "--state", "open", "--json", "number,url,isDraft", "--jq", ".[0]"],
      { cwd: repoPath, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const t = out.trim();
    if (!t || t === "null" || t === "[]") return null;
    const j = JSON.parse(t) as { number: number; url: string; isDraft?: boolean };
    if (typeof j.number !== "number") return null;
    return { number: j.number, url: j.url, draft: j.isDraft ?? false };
  } catch {
    return "unknown"; // gh absent / unauthenticated / no remote — never a deletion input
  }
}

function mergeBaseProbe(repoPath: string, branch: string, base: string): boolean | null {
  try {
    execFileSync("git", ["-C", repoPath, "merge-base", "--is-ancestor", branch, base], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true; // exit 0: every branch commit reachable from base
  } catch (err) {
    if (exitCodeOf(err) === 1) return false; // exit 1: provably unmerged
    return null; // unknown base / broken repo
  }
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false; // unknown ref or broken repo
  }
}

function listFactoryBranches(repoPath: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoPath, "branch", "--list", "factory/*", "--format=%(refname:short)"],
      { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function countFiles(dir: string): number {
  let count = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else count++;
    }
  };
  walk(dir);
  return count;
}

interface WtBlock {
  path: string;
  head: string | null;
  branch: string | null;
  /** `git worktree lock` — operator-retained; gc never unlocks or reaps. */
  locked: boolean;
}

function parseWorktreePorcelain(out: string): WtBlock[] {
  const blocks: WtBlock[] = [];
  let cur: WtBlock | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) blocks.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), head: null, branch: null, locked: false };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (cur && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    } else if (cur && line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// ---------------------------------------------------------------- scanner

/** Real scanner: shells out to git/gh exactly like `GhPrPublisher.publish`
 *  (execFileSync, utf8, explicit timeouts) and never throws for a dead repo. */
export class GitGcScanner implements GcScanner {
  async scanTarget(repoPath: string, items: ItemRecord[]): Promise<RepoReport> {
    const repo = realpathOrNull(repoPath) ?? repoPath;
    const sorted = [...items].sort((a, b) => a.id - b.id);
    let blocks: WtBlock[];
    try {
      const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      blocks = parseWorktreePorcelain(out);
    } catch (err) {
      const reason = `git scan failed: ${errText(err)}`;
      return {
        repo,
        reachable: false,
        findings: [makeGcFinding({ kind: "unreachable-repo", repo, reason })],
        housekeeping: {
          repo,
          reachable: false,
          prunableDirs: [],
          factoryBranchCount: 0,
          factoryBranchOrphans: [],
          sandcastleAdjacents: { envDotFile: false, logFiles: 0 },
        },
      };
    }

    const repoReal = realpathOrNull(repo) ?? repo;
    const linked = blocks.filter((b) => (realpathOrNull(b.path) ?? b.path) !== repoReal);
    const registered = new Set(blocks.map((b) => realpathOrNull(b.path) ?? b.path));
    const byBranch = new Map<string, ItemRecord>();
    for (const item of sorted) byBranch.set(item.branchName, item);
    const worktreeBranches = new Set<string>();
    for (const b of linked) if (b.branch) worktreeBranches.add(b.branch);

    const findings: GcFinding[] = [];

    // 1. Item-bound worktrees (the branch holder is the item's worktree,
    //    leaked by a crash — at a managed or unmanaged path).
    for (const item of sorted) {
      const holder = linked.find((b) => b.branch === item.branchName);
      if (!holder) continue;
      findings.push(
        makeGcFinding({
          kind: "worktree",
          repo,
          itemId: item.id,
          slug: item.slug,
          itemStatus: item.status,
          itemUpdatedAt: item.updatedAt,
          path: holder.path,
          branch: holder.branch,
          headSha: holder.head,
          sizeBytes: dirSize(holder.path),
          dirty: dirtyProbe(holder.path),
          locked: holder.locked,
          mergedIntoBase: mergeBaseProbe(repo, item.branchName, item.base),
          openPr: null,
          orphan: false,
        }),
      );
    }

    // 2. Branch findings for every item branch that exists in git.
    for (const item of sorted) {
      if (!branchExists(repo, item.branchName)) continue;
      const merged = mergeBaseProbe(repo, item.branchName, item.base);
      // Probe gh only where a decision or annotation needs it: terminal-item
      // branches with unmerged commits. Absent gh → "unknown", never a
      // deletion input.
      const openPr =
        isTerminal(item.status) && merged === false
          ? probeOpenPr(repo, item.branchName, item.base)
          : "unknown";
      findings.push(
        makeGcFinding({
          kind: "branch",
          repo,
          itemId: item.id,
          slug: item.slug,
          itemStatus: item.status,
          itemUpdatedAt: item.updatedAt,
          path: null,
          branch: item.branchName,
          sizeBytes: null,
          dirty: null,
          mergedIntoBase: merged,
          openPr,
          orphan: false,
        }),
      );
    }

    // 3. Orphan worktrees: factory/* branch held by a worktree no item row
    //    references (rebuilt DB, deleted item, …). Report-only by default.
    for (const b of linked) {
      if (!b.branch || !b.branch.startsWith("factory/")) continue;
      if (byBranch.has(b.branch)) continue;
      findings.push(
        makeGcFinding({
          kind: "worktree",
          repo,
          path: b.path,
          branch: b.branch,
          headSha: b.head,
          sizeBytes: dirSize(b.path),
          dirty: dirtyProbe(b.path),
          locked: b.locked,
          orphan: true,
        }),
      );
    }

    // 4. Leftover dirs under .sandcastle/worktrees/ that git does not know
    //    about (crash between mkdir and worktree add; sandcastle prunes them
    //    lazily at the next createWorktree — gc reports them).
    const worktreesDir = path.join(repo, ".sandcastle", "worktrees");
    const prunableDirs: string[] = [];
    try {
      for (const e of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const full = path.join(worktreesDir, e.name);
        if (registered.has(realpathOrNull(full) ?? full)) continue;
        prunableDirs.push(full);
        findings.push(
          makeGcFinding({
            kind: "prunable-dir",
            repo,
            path: full,
            sizeBytes: dirSize(full),
            orphan: true,
          }),
        );
      }
    } catch {
      /* no .sandcastle/worktrees — nothing to do */
    }

    const factoryBranches = listFactoryBranches(repo);
    const housekeeping: RepoHousekeeping = {
      repo,
      reachable: true,
      prunableDirs,
      factoryBranchCount: factoryBranches.length,
      factoryBranchOrphans: factoryBranches.filter(
        (b) => !byBranch.has(b) && !worktreeBranches.has(b),
      ),
      sandcastleAdjacents: {
        envDotFile: fs.existsSync(path.join(repo, ".sandcastle", ".env")),
        logFiles: countFiles(path.join(repo, ".sandcastle", "logs")),
      },
    };

    // Provisional classification with zero flags so every finding always
    // carries a meaningful action/reason; runGc re-classifies with the
    // operator's actual flags.
    for (const f of findings) Object.assign(f, classifyFinding(f, ZERO_GC_FLAGS));
    return { repo, reachable: true, findings, housekeeping };
  }
}

// ---------------------------------------------------------------- reaper

/** Real reaper: `git worktree remove --force` (locked worktrees never reach
 *  the reaper — classifyFinding keeps them out of the plan set), `git branch -D`,
 *  `fs.rmSync` for bare leftover dirs. Safety is owned by the planner's
 *  merge-base check, hence `-D`. */
export class GitGcReaper implements GcReaper {
  async reap(plan: GcReapPlan): Promise<{ statusPorcelain: string; detail: string }> {
    const f = plan.finding;
    if (plan.op === "delete-branch") {
      const branch = f.branch!;
      execFileSync("git", ["-C", f.repo, "branch", "-D", branch], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { statusPorcelain: "", detail: `deleted branch ${branch}` };
    }
    const p = f.path!;
    if (f.kind === "prunable-dir") {
      fs.rmSync(p, { recursive: true, force: true });
      return { statusPorcelain: "", detail: `removed leftover directory ${p}` };
    }
    // Registered worktree: capture the changed-file list BEFORE removal
    // (cheap insurance — a crashed implement stage leaves uncommitted agent
    // output only in the worktree).
    const status = statusPorcelain(p) ?? "";
    if (!fs.existsSync(p)) {
      try {
        execFileSync("git", ["-C", f.repo, "worktree", "prune"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        /* best effort */
      }
      return { statusPorcelain: status, detail: `worktree ${p} already gone (pruned registration)` };
    }
    execFileSync("git", ["-C", f.repo, "worktree", "remove", "--force", p], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { statusPorcelain: status, detail: `removed worktree ${p}` };
  }
}

// ---------------------------------------------------------------- planner

/** The single decision point: facts + flags → action/requiresFlag/reason.
 *  Pure; used by the scanner (zero flags), runGc (operator flags) and tests. */
export function classifyFinding(
  f: GcFinding,
  flags: GcFlags,
): Pick<GcFinding, "action" | "requiresFlag" | "reason"> {
  if (f.kind === "unreachable-repo") {
    return { action: "report-only", requiresFlag: null, reason: f.reason };
  }
  const terminal = isTerminal(f.itemStatus);
  if (f.kind === "branch") {
    if (f.itemId === null) {
      return { action: "report-only", requiresFlag: null, reason: "orphan branch (housekeeping only)" };
    }
    // Rule 2: a non-terminal item's branch is live — the item is resumable.
    if (!terminal) {
      return { action: "keep", requiresFlag: null, reason: "live — protected: item non-terminal" };
    }
    if (!flags.deleteBranches) {
      return { action: "keep", requiresFlag: null, reason: "terminal item — branch kept by default" };
    }
    if (f.mergedIntoBase === true) {
      return { action: "remove", requiresFlag: null, reason: "merged into base" };
    }
    if (f.mergedIntoBase === false) {
      if (typeof f.openPr === "object" && f.openPr !== null) {
        return { action: "keep", requiresFlag: null, reason: "unmerged commits — PR open" };
      }
      if (f.openPr === null) {
        // Probe confirmed no open PR — deletable only with --force-branches,
        // because squash/rebase merges look unmerged to merge-base (documented gap).
        return flags.forceBranches
          ? { action: "remove", requiresFlag: null, reason: "no open PR — --delete-branches --force-branches given" }
          : { action: "keep", requiresFlag: "--force-branches", reason: "unmerged commits — no open PR; needs --force-branches" };
      }
      return { action: "keep", requiresFlag: null, reason: "unmerged commits — PR status unknown" };
    }
    return { action: "keep", requiresFlag: null, reason: "unmerged commits — merge status unknown" };
  }
  if (f.kind === "prunable-dir") {
    return flags.forceOrphans
      ? { action: "remove", requiresFlag: null, reason: "orphan leftover dir — --force-orphans given" }
      : { action: "report-only", requiresFlag: "--force-orphans", reason: "orphan leftover dir — needs --force-orphans" };
  }
  // kind === "worktree"
  // Locked worktrees are operator-retained — never reaped, never unlocked.
  if (f.locked) {
    return { action: "keep", requiresFlag: null, reason: "admin-locked — skipped" };
  }
  // Conservative dirty handling (AC: never reap unless provably clean or
  // --force-dirty): unknown (null) holds like dirty — the scanner marks a
  // *missing* worktree dir false (nothing to lose; prune-only path).
  const heldDirty = f.dirty !== false;
  const dirty = f.dirty === true;
  if (f.orphan || f.itemId === null) {
    // Rule 3: report-only by default — after `wb init` a rebuilt DB makes
    // every existing worktree look orphaned; never mass-delete on that.
    if (!flags.forceOrphans) {
      return { action: "report-only", requiresFlag: "--force-orphans", reason: "orphan — no item row; needs --force-orphans" };
    }
    if (heldDirty && !flags.forceDirty) {
      return { action: "report-only", requiresFlag: "--force-dirty", reason: dirty ? "orphan — dirty" : "orphan — dirty state unknown" };
    }
    return {
      action: "remove",
      requiresFlag: null,
      reason: dirty ? "orphan — dirty (--force-dirty given)" : "orphan — --force-orphans given",
    };
  }
  if (terminal) {
    if (heldDirty && !flags.forceDirty) {
      return { action: "remove", requiresFlag: "--force-dirty", reason: dirty ? "terminal item — dirty" : "terminal item — dirty state unknown" };
    }
    return {
      action: "remove",
      requiresFlag: null,
      reason: dirty ? "terminal item — dirty (--force-dirty given)" : "terminal item",
    };
  }
  // Rule 5 (the crash-recovery repair): a worktree holding a non-terminal
  // item's branch is stale by construction under the gc lock; reap it (dirty
  // gated) while keeping the branch — the item is resumable on its branch.
  if (heldDirty && !flags.forceDirty) {
    return {
      action: "remove",
      requiresFlag: "--force-dirty",
      reason: dirty ? "stale — dirty" : "stale — dirty state unknown",
    };
  }
  return {
    action: "remove",
    requiresFlag: null,
    reason: dirty
      ? "stale — dirty (--force-dirty given); branch protected: item non-terminal"
      : "branch protected: item non-terminal",
  };
}

/** Pure: findings + flags → the reaps `--apply` would execute (worktrees
 *  first — git refuses to delete a branch still checked out in a worktree —
 *  then branches, skipping any branch whose worktree is not being removed).
 *  A finding is planned iff its classification says `remove` with every
 *  required flag satisfied (`requiresFlag` is null); a held requirement
 *  (dirty worktree without --force-dirty, orphan without --force-orphans, …)
 *  keeps it out of the plan set. */
export function planGc(reports: RepoReport[], flags: GcFlags): GcReapPlan[] {
  const worktreePlans: GcReapPlan[] = [];
  const heldBranches = new Set<string>();
  for (const r of reports) {
    for (const f of r.findings) {
      if (f.kind !== "worktree" && f.kind !== "prunable-dir") continue;
      const c = classifyFinding(f, flags);
      if (c.action === "remove" && c.requiresFlag === null) {
        worktreePlans.push({ finding: { ...f, ...c }, op: "remove-worktree", dirty: f.dirty === true });
      } else if (f.kind === "worktree" && f.branch) {
        // The worktree stays (held/protected) — its branch cannot be deleted.
        heldBranches.add(`${f.repo}\0${f.branch}`);
      }
    }
  }
  const branchPlans: GcReapPlan[] = [];
  for (const r of reports) {
    for (const f of r.findings) {
      if (f.kind !== "branch") continue;
      const c = classifyFinding(f, flags);
      if (c.action !== "remove" || c.requiresFlag !== null) continue;
      if (f.branch && heldBranches.has(`${f.repo}\0${f.branch}`)) continue;
      branchPlans.push({ finding: { ...f, ...c }, op: "delete-branch", dirty: false });
    }
  }
  return [...worktreePlans, ...branchPlans];
}

// ---------------------------------------------------------------- orchestrator

function writeGcArtifact(
  deps: GcDeps,
  item: ItemRecord,
  f: GcFinding,
  statusPorcelainOut: string,
): void {
  const dir = artifactDir(deps.paths, item.slug);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `gc-${stamp()}.md`);
  const content = [
    "# gc reap record",
    "",
    `item: #${item.id} ${item.slug} [${item.status}]`,
    `worktree: ${f.path}`,
    `branch: ${f.branch}`,
    `size: ~${f.sizeBytes ?? 0} bytes`,
    `dirty: ${f.dirty}`,
    `head: ${f.headSha}`,
    "",
    "## git status --porcelain (captured at reap)",
    "",
    statusPorcelainOut.trim() || "(clean)",
    "",
  ].join("\n");
  fs.writeFileSync(abs, content, "utf8");
  deps.db.addArtifact(item.id, null, "gc-dirty-diff", path.relative(deps.paths.root, abs));
}

/** `wb gc` orchestration. Report mode (`apply: false`) never touches the
 *  reaper, the DB or the filesystem. Apply mode executes plans per-finding —
 *  one failure never aborts sibling reaps — writing the gc artifact + `gc`
 *  history row for each reaped item-bound worktree, and the `gc` history row
 *  for each item-bound branch deletion (orphan reaps have no item row and
 *  therefore no history). */
export async function runGc(deps: GcDeps, flags: GcFlags): Promise<GcResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const items = deps.db.listItems();

  // Group items by resolved repo (dedupes repo strings resolving to the same
  // realpath; skips the "(unknown)" placeholder of malformed-at-claim items).
  const groups = new Map<string, { items: ItemRecord[]; latestId: number }>();
  for (const item of items) {
    if (item.repo === "(unknown)") continue;
    const resolved = resolveGcRepoPath(item.repo);
    const g = groups.get(resolved) ?? { items: [], latestId: 0 };
    g.items.push(item);
    g.latestId = Math.max(g.latestId, item.id);
    groups.set(resolved, g);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].latestId - a[1].latestId);

  const reports: RepoReport[] = [];
  const errors: unknown[] = [];
  for (const [repo, g] of ordered) {
    try {
      reports.push(await deps.scanner.scanTarget(repo, g.items));
    } catch (err) {
      reports.push({
        repo,
        reachable: false,
        findings: [makeGcFinding({ kind: "unreachable-repo", repo, reason: `scanner failed: ${errText(err)}` })],
        housekeeping: {
          repo,
          reachable: false,
          prunableDirs: [],
          factoryBranchCount: 0,
          factoryBranchOrphans: [],
          sandcastleAdjacents: { envDotFile: false, logFiles: 0 },
        },
      });
    }
  }

  // Definitive classification with the operator's flags (drives display,
  // JSON, summary and planning alike).
  for (const r of reports) {
    for (const f of r.findings) Object.assign(f, classifyFinding(f, flags));
  }

  const plans = planGc(reports, flags);
  const reaped: ReapOutcome[] = [];

  if (flags.apply) {
    const failedWorktrees = new Set<string>();
    for (const plan of plans) {
      if (plan.op !== "remove-worktree") continue;
      const f = plan.finding;
      try {
        const res = await deps.reaper.reap(plan);
        if (f.itemId !== null) {
          const item = deps.db.getItem(f.itemId);
          if (item) {
            writeGcArtifact(deps, item, f, res.statusPorcelain);
            deps.db.appendHistory(f.itemId, "gc", null, {
              kind: "worktree",
              worktreePath: f.path,
              branch: f.branch,
              sizeBytes: f.sizeBytes,
              dirty: f.dirty,
              action: "remove-worktree",
              reason: isTerminal(item.status) ? "terminal-item" : "stale-branch-conflict-repair",
            });
          }
        }
        reaped.push({ finding: f, op: plan.op, ok: true, detail: res.detail });
      } catch (err) {
        errors.push(err);
        reaped.push({ finding: f, op: plan.op, ok: false, detail: errText(err) });
        if (f.branch) failedWorktrees.add(`${f.repo}\0${f.branch}`);
      }
    }
    for (const plan of plans) {
      if (plan.op !== "delete-branch") continue;
      const f = plan.finding;
      if (f.branch && failedWorktrees.has(`${f.repo}\0${f.branch}`)) {
        reaped.push({
          finding: f,
          op: plan.op,
          ok: false,
          detail: "skipped — the worktree holding this branch was not removed",
        });
        continue;
      }
      try {
        await deps.reaper.reap(plan);
        if (f.itemId !== null) {
          deps.db.appendHistory(f.itemId, "gc", null, {
            kind: "branch",
            branch: f.branch,
            evidence: f.mergedIntoBase === true ? "merge-base" : "force-branches-no-open-pr",
          });
        }
        reaped.push({ finding: f, op: plan.op, ok: true, detail: `deleted branch ${f.branch}` });
      } catch (err) {
        errors.push(err);
        reaped.push({ finding: f, op: plan.op, ok: false, detail: errText(err) });
      }
    }
  }

  const summary: GcSummary = {
    worktreesReapable: plans.filter((p) => p.op === "remove-worktree").length,
    worktreeBytes: plans
      .filter((p) => p.op === "remove-worktree")
      .reduce((n, p) => n + (p.finding.sizeBytes ?? 0), 0),
    branchesDeletable: plans.filter((p) => p.op === "delete-branch").length,
    branchesKeepUnmerged: reports
      .flatMap((r) => r.findings)
      .filter((f) => f.kind === "branch" && f.reason.includes("unmerged")).length,
    orphans: reports.flatMap((r) => r.findings).filter((f) => f.orphan).length,
  };

  return {
    generatedAt: now(),
    reportOnly: !flags.apply,
    flags: {
      apply: flags.apply,
      deleteBranches: flags.deleteBranches,
      forceBranches: flags.forceBranches,
      forceDirty: flags.forceDirty,
      forceOrphans: flags.forceOrphans,
    },
    reports,
    reaped,
    errors,
    summary,
  };
}

// ---------------------------------------------------------------- renderers

function formatSize(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function dirtyText(f: GcFinding): string {
  if (f.dirty === null) return "dirty unknown";
  return f.dirty ? "dirty" : "clean";
}

function arrow(f: GcFinding): string {
  const verb =
    f.kind === "branch"
      ? f.action === "remove"
        ? "delete"
        : f.action
      : f.action === "report-only"
        ? "report"
        : f.action;
  const bits: string[] = [];
  if (f.requiresFlag) bits.push(`needs ${f.requiresFlag}`);
  if (f.reason) bits.push(f.reason);
  return `→ ${verb}${bits.length > 0 ? ` (${bits.join("; ")})` : ""}`;
}

function branchAnnotation(f: GcFinding): string {
  const parts: string[] = [];
  if (typeof f.openPr === "object" && f.openPr !== null) parts.push(`PR #${f.openPr.number} open`);
  if (f.mergedIntoBase === true) parts.push("merged into base");
  else if (f.mergedIntoBase === false) parts.push("unmerged");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Human report mirroring `wb status`'s shape (item header, indented detail
 *  lines, summary). Exported for tests; the CLI prints it verbatim. */
export function renderGcHuman(result: GcResult): string {
  const lines: string[] = [];
  for (const r of result.reports) {
    if (!r.reachable) {
      const f = r.findings.find((x) => x.kind === "unreachable-repo");
      lines.push(`repo: ${r.repo} — unreachable${f?.reason ? ` (${f.reason})` : ""}; nothing scanned`);
      continue;
    }
    const byItem = new Map<number, GcFinding[]>();
    const orphaned: GcFinding[] = [];
    for (const f of r.findings) {
      if (f.kind === "unreachable-repo") continue;
      if (f.itemId !== null) {
        const list = byItem.get(f.itemId) ?? [];
        list.push(f);
        byItem.set(f.itemId, list);
      } else {
        orphaned.push(f);
      }
    }
    for (const [itemId, list] of [...byItem.entries()].sort((a, b) => a[0] - b[0])) {
      const first = list[0]!;
      const updated = first.itemUpdatedAt ? ` updated=${first.itemUpdatedAt}` : "";
      lines.push(`#${itemId} ${first.slug} [${first.itemStatus}] repo=${r.repo}${updated}`);
      for (const f of list) {
        if (f.kind === "worktree") {
          const nonTerminal = !isTerminal(f.itemStatus);
          const where = nonTerminal
            ? `stale, holds branch ${f.branch}`
            : f.path ?? "(path unknown)";
          lines.push(`    worktree: ${where} (${formatSize(f.sizeBytes)}, ${dirtyText(f)}) ${arrow(f)}`);
        } else if (f.kind === "branch") {
          lines.push(`    branch:   ${f.branch}${branchAnnotation(f)} ${arrow(f)}`);
        }
      }
    }
    for (const f of orphaned) {
      if (f.kind === "prunable-dir") {
        lines.push(`orphan leftover dir (repo=${r.repo}): ${f.path} (${formatSize(f.sizeBytes)}) ${arrow(f)}`);
      } else {
        lines.push(`orphan (repo=${r.repo}): ${f.path} (${formatSize(f.sizeBytes)}, ${dirtyText(f)}) ${arrow(f)}`);
      }
    }
    const hk = r.housekeeping;
    const hkBits = [
      `${hk.factoryBranchCount} factory branch(es)`,
      hk.prunableDirs.length > 0 ? `${hk.prunableDirs.length} prunable dir(s)` : null,
      hk.factoryBranchOrphans.length > 0
        ? `${hk.factoryBranchOrphans.length} orphan factory branch(es): ${hk.factoryBranchOrphans.join(", ")}`
        : null,
      hk.sandcastleAdjacents.envDotFile ? ".sandcastle/.env present" : "no .sandcastle/.env",
      `${hk.sandcastleAdjacents.logFiles} sandcastle log file(s)`,
    ].filter((x): x is string => x !== null);
    lines.push(`housekeeping: ${hkBits.join(", ")}`);
  }
  const s = result.summary;
  lines.push(
    `summary: ${s.worktreesReapable} worktree(s) reapable (${formatSize(s.worktreeBytes)}), ` +
      `${s.branchesDeletable} branch(es) deletable, ${s.branchesKeepUnmerged} branch(es) keep (unmerged), ` +
      `${s.orphans} orphan(s) (needs --force-orphans)`,
  );
  if (!result.reportOnly) {
    const wt = result.reaped.filter((x) => x.op === "remove-worktree" && x.ok).length;
    const br = result.reaped.filter((x) => x.op === "delete-branch" && x.ok).length;
    lines.push(`reaped: ${wt} worktree(s) removed, ${br} branch(es) deleted`);
    if (result.errors.length > 0) lines.push(`errors: ${result.errors.length} (details on stderr)`);
  }
  return lines.join("\n");
}

/** `--json` output: one 2-space-indented document that parses and
 *  round-trips the full finding set. */
export function renderGcJson(result: GcResult): string {
  const doc = {
    generatedAt: result.generatedAt,
    reportOnly: result.reportOnly,
    flags: result.flags,
    repos: result.reports.map((r) => ({
      repo: r.repo,
      reachable: r.reachable,
      findings: r.findings,
      housekeeping: r.housekeeping,
    })),
    reaped: result.reaped,
    errors: result.errors.map((e) => (e instanceof Error ? e.message : String(e))),
    summary: result.summary,
  };
  return JSON.stringify(doc, null, 2);
}
