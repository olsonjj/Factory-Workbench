# Spec: `wb gc` — worktree/branch/repo-artifact reconciliation and cleanup

## 0. Scope and hard constraints

- One new CLI verb `wb gc` in `src/cli/index.ts`; all logic lives in `src/gc.ts`
  (ports + planner + real git/fs implementation + renderers). The only other
  production change is the one-line `"gc"` addition to the `HistoryEvent` union
  in `src/types.ts` (the `wb watch` unknown-event fallback renders it
  generically; no watch/status code or spec changes).
- **Report mode (no `--apply`) is read-only**: no factory lock, no DB write, no
  `factory.db` creation, no git/filesystem mutation. It mirrors `wb status`'s
  open pattern exactly (`loadConfig` → `existsSync(<root>/factory.db)`
  early-exit with the status wording → `FactoryDb.openReadonly` → informational
  lock-holder line → `finally { db.close() }`) and is safe while any other wb
  command holds the lock (WAL readers never block the writer or vice versa).
  Reconciliation races are cosmetic in report mode — that is why report mode
  deliberately does **not** need the lock.
- **`--apply` is a mutating verb**: `acquireFactoryLock(root)` (busy → the
  standard `factory: factory is busy (…)` failure), `new FactoryDb(root)`,
  never `withFactory`/`openFactory` (those claim inbox files and construct a
  `SandcastleStageRunner`; gc has no runner and claims nothing), never
  `scanInbox`.
- Flags: `--apply`, `--delete-branches`, `--force-branches`, `--force-dirty`,
  `--force-orphans`, `--json`, `--root <dir>`. The mutating flags without
  `--apply` are an error (exit 1) — their presence must not silently widen a
  report. In `--json` mode the informational lock line is suppressed so the
  document stays parseable.
- No model calls, no Docker, no network required. The `gh` probe is used
  sparingly (only terminal-item branches with unmerged commits) and degrades
  to `"unknown"`; it is never a deletion input except through a probe-confirmed
  *absence* of an open PR under `--force-branches`.
- Exit codes: report mode 0 (findings are not failures); `--apply` 0 when all
  plans executed, 1 when any execution error occurred (errors listed on
  stderr after the summary).

## 1. Repo reality (verified; deltas vs. the ticket text noted)

- Worktrees live in the **target repos**, anchored by sandcastle at
  `<repo>/.sandcastle/worktrees/<branch-with-slashes-dashed>`
  (`factory/a` → `factory-a`). Branches are `factory/<slug>` on the item row.
- Leak path: `dispose()` closes worktrees only on normal exit; a crash leaks
  the worktree plus its registration in `<repo>/.git/worktrees/`, holding the
  branch. The factory root never holds worktrees.
- **Collision nuance (delta vs. the ticket's framing):** sandcastle *reuses* a
  leaked worktree at the managed path (warn on dirty, best-effort ff on
  clean); the hard `WorktreeError` ("Branch 'X' is already checked out in
  worktree at '…'") happens only when the branch is held by a worktree
  **outside** `.sandcastle/worktrees/`. `wb gc`'s rule-5 repair removes stale
  worktrees at **both** paths so the next `createWorktree` starts fresh.
  Git itself refuses a second checkout of the same branch with exit 128.
- Dirty probe = `git -C <worktree> status --porcelain`, identical to
  sandcastle's `hasUncommittedChanges`, so gc's classification matches
  sandcastle's reuse behavior.
- Terminal statuses: `done`, `rejected`. Everything else (incl. `malformed`,
  `infrastructure-failure`, parked variants) is retryable — such items' work
  must survive gc.
- The factory never merges: terminal-item branches hold unmerged commits by
  design; merge status is only knowable post-hoc via
  `git merge-base --is-ancestor <branch> <base>` (exit 0 = provably merged).
- Malformed-at-claim items have `repo: "(unknown)"` — no repo path to scan;
  repo enumeration skips the placeholder. Repo enumeration is derived from
  `db.listItems()` grouped by resolved repo realpath (identical set to
  `knownReposNewestFirst()`, newest-repo-first ordering; keeps the `GcDeps`
  DB seam narrow).
- All path comparisons run on realpaths (`resolveGcRepoPath`: pipeline-style
  resolve, then `fs.realpathSync`), matching what git records.

## 2. Semantics

### 2.1 Reaping rules

1. **Terminal items** (`done`, `rejected`): worktrees reapable on `--apply`.
   Branches kept by default; with `--delete-branches` deleted only when
   provably safe — merged into base (`merge-base --is-ancestor`, exit 0), or
   probe-confirmed no open PR **and** `--force-branches`. Otherwise
   `keep (unmerged commits)` / hold with the required flag. `git branch -D`
   (safety owned by the explicit merge-base check); worktree removals are
   sequenced before branch deletions, and a branch whose worktree was not
   removed is never scheduled/attempted.
2. **Non-terminal items**: the **branch** is `live — protected` and never
   deleted; the item row is untouched. The **worktree** holding the branch is,
   under the gc lock, stale by construction (no live run exists) and is reaped
   on `--apply` as the rule-5 stale-branch repair — this is the narrow
   exception that fixes the crash-recovery critical path (a leaked worktree
   holding `factory/<slug>` blocks `createWorktree` on resume/retry). Dirty
   worktrees require `--force-dirty`. An **unknown** dirty state (`git status
   --porcelain` failing on an existing dir) holds like dirty — the scanner
   marks a *missing* worktree dir false (nothing to lose; the reaper can only
   prune the registration), so unknown means probe-failure only.

   **Admin-locked worktrees** (`git worktree lock`) are operator-retained:
   reported as `keep (admin-locked — skipped)`, never unlocked and never reaped.
   (The first implementation best-effort-unlocked before remove; review
   flagged the bypass and it was removed — a lock is the operator saying
   "don't touch this worktree".)
   *(Delta vs. the ticket's rule-2 phrasing "never reap their worktree": the
   ticket's own example output — `#9 bad-spec [exhausted-rework] … worktree:
   → remove` — and its end-to-end acceptance criterion (a `queued` item's
   leaked worktree must be gone after `gc --apply` so `createWorktree`
   succeeds) both require the rule-5 interpretation implemented here.
   "Protected" = the branch and the item record.)*
3. **Orphans** (registered factory/* worktree, prunable dir, or branch no item
   row references): report-only with `needs --force-orphans`. Default is
   deliberately report-only — after a rebuilt/empty DB (`wb init`) every
   existing worktree is an orphan and must not be mass-deleted. Orphan reaps
   produce no history row (no item row exists); they appear in stdout/`--json`
   only.
4. **Malformed items** have no branch/worktree in git (branch creation happens
   in `worktreeFor`) — nothing to reap.
5. **Dirty gating + artifact insurance** (all item-bound worktree reaps): any
   reap requires a clean `git status --porcelain` or `--force-dirty`; the
   changed-file list (captured by the reaper before removal) is recorded into
   `<root>/items/<slug>/artifacts/gc-<stamp>.md` (registered via
   `addArtifact(itemId, null, "gc-dirty-diff", <root-relative path>)`),
   together with item id/slug/status, worktree path, branch, size, dirty flag
   and HEAD sha.
6. **Per-repo housekeeping — report-only in v1**: prunable dirs, factory
   branch count, orphan factory branches (no item row, no worktree),
   `.sandcastle/.env` presence, `.sandcastle/logs` file count. Never touched
   by any flag; factory-root `logs/`/`proposals/` retention is out of scope.
   *(The `.env`/logs lines are an implementation extra beyond the ticket's
   rule 6 — report-only and harmless; kept for completeness.)*

### 2.2 History events

`--apply` appends a `"gc"` history row (stage `null`, the operator-decision
convention) per affected item-bound finding:

- worktree reap: `{ kind: "worktree", worktreePath, branch, sizeBytes, dirty,
  action: "remove-worktree", reason: "terminal-item" | "stale-branch-conflict-repair" }`
- branch deletion: `{ kind: "branch", branch, evidence: "merge-base" |
  "force-branches-no-open-pr" }`

### 2.3 Decision matrix (finding → default report / `--apply`)

| Finding | Default report | `--apply` | Requires |
|---|---|---|---|
| worktree of terminal item, clean | remove (terminal item) | remove | — |
| worktree of terminal item, dirty | remove (needs --force-dirty) | hold | `--force-dirty` |
| branch of terminal item, no `--delete-branches` | keep | keep | — |
| branch of terminal item, `--delete-branches`, merged into base | delete | delete | — |
| branch of terminal item, `--delete-branches`, unmerged, PR open | keep (unmerged commits) | keep | — |
| branch of terminal item, `--delete-branches`, unmerged, no open PR (probe-confirmed) | keep (needs --force-branches) | hold | `--force-branches` |
| branch of terminal item, unmerged, PR status unknown (gh absent) | keep | keep | — |
| worktree of non-terminal item, clean | remove (branch protected: item non-terminal) | remove (rule-5 repair) | — |
| worktree of non-terminal item, dirty | remove (needs --force-dirty) | hold | `--force-dirty` |
| branch of non-terminal item | keep — live — protected | keep | never deleted |
| orphan worktree / prunable dir | report (needs --force-orphans) | hold | `--force-orphans` (a dirty orphan additionally requires `--force-dirty` — the ticket's dirty AC applies to every reap) |
| admin-locked worktree | keep (admin-locked — skipped) | keep | — (never unlocked) |
| unreachable repo | repo-level note | nothing | — |

## 3. Module and seam

- `GcScanner` (facts: `scanTarget(repoPath, items) → RepoReport` with
  `GcFinding[]` + `RepoHousekeeping`) and `GcReaper`
  (`reap(plan) → { statusPorcelain, detail }`) are the ports; the real
  implementations (`GitGcScanner`, `GitGcReaper`) shell out via `execFileSync`
  with explicit timeouts and quiet stdio, non-throwing per repo.
- `classifyFinding(finding, flags)` is the single pure decision point
  (scanner pre-classifies with zero flags; `runGc` re-classifies with the
  operator's flags). `planGc(reports, flags)` is pure: a finding is planned iff
  its classification is `remove` with every required flag satisfied;
  worktree-class reaps (incl. prunable dirs) precede branch deletions.
- `runGc(deps, flags)` executes per-finding without aborting siblings, writes
  the gc artifact + `gc` history row after each successful item-bound worktree
  reap, and collects errors (exit 1 iff any).

## 4. Output

Human mode mirrors `wb status`'s shape (item header, indented detail lines,
orphan lines, per-repo housekeeping line, summary). `--json` emits one
2-space-indented document: `{ generatedAt, reportOnly, flags, repos:
[{ repo, reachable, findings, housekeeping }], reaped, errors, summary }` —
parseable and round-tripping the full finding set.

## 5. Testing conventions

Planner logic is pure and fully unit-tested; orchestration runs above the
`GcScanner`/`GcReaper` seams (fakes + spy reaper + real temp-dir `FactoryDb`);
scanner/reaper tests use real git in temp repos with explicit
`-c user.name/-c user.email` (no global identity dependence), including a
crash-recovery end-to-end test with real `@ai-hero/sandcastle` `createWorktree`
(worktree creation only — no sandbox, no Docker, no models, no network). CLI
external tests spawn `node --import tsx src/cli/index.ts gc …` against
hermetic fixture roots.

## 6. Explicitly out of scope (v1)

- GitHub-state merge detection (`gh pr view` merged status) — deletion uses
  local `merge-base` only; squash/rebase-merged branches look unmerged and are
  kept unless the operator passes `--delete-branches --force-branches` with a
  probe-confirmed no-open-PR (documented gap).
- Factory-root `logs/`/`proposals/` retention; sandcastle containers/images.
- Auto-gc after done-transitions (manual `wb gc` only).
- Reaping orphan factory branches with no worktree (housekeeping report only).
- Any change to `wb status`, `wb watch`, or `specs/wb-watch.spec.md`.
