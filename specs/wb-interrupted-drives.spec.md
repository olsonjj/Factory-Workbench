# Spec: interrupted drives — dead-drive detection, labeling, reconciliation, and run-log markers

Governs: a drive (`wb run`, `wb resume`, the web Start Processing drive) that
ended **without reaching a parking decision or the drive loop's natural end**
being detected, labeled, reconciled, and made observable on every surface.

Incident fixture: on 2026-11-08 a background `wb run` vanished right after a
triage → queued transition — log trailed off with no error and no exit marker;
the item was recovered ~1 h later by a human pressing Start Processing, and
nothing in the history, status, or UI recorded that the previous drive had
died. The fix makes the next death diagnosable after the fact, not
preventable.

This file is the governing spec. The shared shapes it references
(`StatusPayload`, the HTTP surface, the page/pill machine) live in
`specs/wb-serve.spec.md`; the watch card and `formatEventText` rules live in
`specs/wb-watch.spec.md` — cross-referenced here, not copied.

## 0. Semantics

- **Item-level tell-tale (detection):** an item with `status === "running"`
  while **no live factory lock exists** (`lock == null || !lock.alive`).
  Sound because `running` is only ever written by a drive holding the factory
  lock (`Orchestrator.runAgentStage` / `runPrStage` persist it before stage
  execution); if the lock is live, whoever holds it owns the running state and
  the signal must stay null.
- **Episode-level tell-tale (run log):** the drive's exit line (§5). Three
  end-states: completed, capped, interrupted. A SIGKILL leaves the marker
  missing; **the log's abrupt end immediately after a stage transition is the
  crash signature** — documented, not detectable at emit-time.
- **Items left `queued` between stages** (the incident's lucky case) are **not
  per-item labeled**: no persisted state distinguishes them from a healthy
  pause, and we add no episode/heartbeat infrastructure. They are covered by
  the run-log marker (and its truncation) only. This is an explicit
  limitation.
- **Observation stays read-only and lock-free.** `wb status`, `wb watch`,
  `wb serve` derive the signal from reads they already make (items snapshot +
  `readLockInfo`) and write nothing, acquire nothing.
- **Reconciliation (mutation) happens only where the lock is exclusively
  held** — the drive entries (`wb run`, `wb resume`, the web drive task). Any
  `running` item a lock-holder sees is provably orphaned (no concurrent drive
  can exist).
- **Recovery contract unchanged.** Nothing auto re-drives interrupted items;
  the operator still presses Start Processing / runs `wb run`/`wb resume`.
  The label and signal change nothing about *who* recovers.
- **The event detail is minimal and honest; it never asserts a cause** — only
  that no live factory lock holds (plus the last known holder pid, where
  knowable).

## 1. History event: `drive-interrupted`

The `HistoryEvent` union gains `"drive-interrupted"`. Written exactly by the
reconciler (§3), once per orphaned item per interrupted episode:

| field | value |
|---|---|
| `event` | `drive-interrupted` |
| `stage` | the item's `stage` at interruption (the mid-flight stage) |
| `detail` | `{ lastHolder: number \| null, repoLock: { repo: string; acquiredAt: string } \| null, requeued: true }` |

- `lastHolder`: the last known factory-lock holder pid where knowable
  (§3.2/§3.3); `null` = unknown — never fabricated.
- `repoLock`: the orphaned `repo_locks` row for this item, read **before** it
  is deleted (`FactoryDb.clearRepoLockForItem`: one `SELECT` + one `DELETE`,
  both statement-cached) — honest evidence that the stage had actually begun.
- Deliberately **not** an OS notification in `wb watch`: only `parked` rows
  notify (the same invariant as `base-stale`).

## 2. Status payload: the `interrupted` signal

`StatusPayload` (shape governed by `specs/wb-serve.spec.md`) gains:

```ts
interrupted: {
  items: { id: number; slug: string; stage: StageName }[];
  lastHolder: number | null;
} | null;
```

Derived inside `buildStatusPayload` from data it already holds (no extra DB
read, no write, no lock):

- `orphans` = the running items (already computed for `counts.running`);
- if `lock` is alive → `interrupted: null` (a live holder owns the state);
- `lastHolder` = `lock.pid` when a (dead) lock file exists, `null` when none;
- `interrupted = orphans.length > 0 && !liveLock ? { items, lastHolder } : null`.

**`statusFingerprint` is unchanged.** Both inputs (item status, lock liveness)
are already fingerprinted, so every interrupted↔healthy transition changes the
fingerprint and emits an SSE `status` event for free; adding the derived field
to the fingerprint would be redundant. Tests assert the invariant (flip the
item status → new fingerprint; flip the lock → new fingerprint) instead.

Rendered by the surfaces: the CLI `wb status` line (§4), the watch card
(§specs/wb-watch.spec.md), the web run-state pill and live feed
(§specs/wb-serve.spec.md).

## 3. Reconciliation

### 3.1 Where it runs

`Orchestrator.reconcileInterrupted(lastHolder: number | null): TickEntry[]` —
public, called exactly at drive start, never from inside `tickAll()` (a live
drive's own legitimate running states must never be "reconciled" by itself).
For every item with `status === "running"`:

1. read + clear the orphaned `repo_locks` row (the evidence rides §1);
2. `updateItem(id, { status: "queued", parkedReason: null, parkedDetail: null })`
   — stage unchanged (the stage re-runs; stage-level idempotency);
3. `appendHistory(id, "drive-interrupted", item.stage, { lastHolder, repoLock, requeued: true })`;
4. return one `TickEntry` (`fromStage: item.stage`, `status: "queued"`, detail
   `drive interrupted (last holder: pid <pid>|none); requeued for the next
   stage`, `changed` unset — a normal transition in `printTick`, not a skip).

Idempotent: a second call finds no `running` items and returns `[]`.

### 3.2 Holder semantics (the pre-acquire lock)

The owning commands capture `readLockInfo(root)` **immediately before**
`acquireFactoryLock`. A hard-killed drive leaves a parseable lock file
carrying its pid (the acquire's stale sweep is what removes it, after we have
read it); a drive that released cleanly leaves no file. So:

- dead lock file present → `lastHolder = its pid` (the SIGKILL/default-signal
  case);
- no lock file → `lastHolder = null` (holder unknown, never fabricated);
- a lock left by a *live* holder cannot reach a drive: acquire would have
  thrown `FactoryBusyError`.

### 3.3 Wiring

- **`Orchestrator.resume()`**: reconcile is its first step —
  `reconcileInterrupted(this.interruptedDrive?.lastHolderPid ?? null)` before
  the `human-rejected` unpark; the entries are prepended to the report, and
  `combined.changed` is NOT set by them (requeue is not progress; the
  subsequent tick is). `OrchestratorDeps` gains the optional
  `interruptedDrive?: { lastHolderPid: number | null }`.
- **CLI `wb run`**: calls `orch.reconcileInterrupted(preLockPid)` explicitly
  before `tickAll()` and merges the entries ahead of the tick entries in
  `printTick`.
- **CLI `wb resume`**: rides `resume()`'s first step via the deps (the CLI's
  `openFactory` threads the pre-acquire lock into every Orchestrator it
  constructs).
- **Web drive (`startRun`)**: reads the pre-acquire lock immediately before
  acquiring, passes it into the task's Orchestrator; the task's
  `orch.resume()` ride reconciles — no second call site.

### 3.4 Abnormal-end labeling (graceful death)

When the drive body throws, before rethrowing: `reconcileInterrupted(pid of
the dying process)` inside a try/catch-swallow (the DB may itself be what
failed — the marker must never mask the original error), then the
interrupted exit marker (§5). The web drive's task wraps `orch.resume()` the
same way. Effect: a graceful crash releases the lock (the `finally` paths) but
still requeues + labels any mid-stage item *with its own holder pid*, so the
next drive's pre-acquire reconcile finds nothing running (no double event) and
the audit trail names the dying process.

## 4. Observation surfaces (all read-only, lock-free)

### 4.1 CLI `wb status`

After the existing live/stale lock lines, when the §2 condition holds:

```
interrupted drive: #27 item-27 (spec) claims running but no live factory lock holds (last known holder: pid 4231) — the previous drive did not end cleanly; recover with `wb run` or `wb resume`
```

- Items as `#<id> <slug> (<stage>)`, joined by `", "`; holder clause `pid <pid>`
  (dead lock file) or `none` (no lock file).
- Never printed while the lock is alive. Output is byte-identical to the
  pre-feature format whenever the signal is null (the status-readonly suite's
  assertions pass unchanged).
- Report-mode `wb gc`'s mirrored lock block is deliberately untouched (out of
  scope).

### 4.2 `wb watch` card (governed by `specs/wb-watch.spec.md`)

`renderCard(items, interrupted?)` appends one counted content line after
`PARKED`, before the closing rule, when the set is non-empty —
`INTERRUPTED (n): #<id> <slug> <stage> · …` — same conventions (count in
header, content ellipsized to 78). Empty/absent set: the card is
byte-identical to the old format. Threading: `pollOnce(db, state,
maxGateAttempts, observeLock?)` — an **absent** probe keeps the signal off
(behavior unchanged for existing callers); a **provided** probe that reports
no live holder surfaces the snapshot's running items as the INTERRUPTED set
(one `readFileSync` of `factory.lock` per poll — the same read-only class as
the snapshot poll, never an acquire). `startWatch` passes the probe through
(position 5, after `intervalSec`); the CLI passes
`() => readLockInfo(root)`.

`formatEventText` gains the explicit rule (§1 detail shape):
`drive interrupted at <stage> — item requeued (last holder pid <pid>)`, or
`(holder unknown)` when `detail.lastHolder == null`. No ⚠/bell/notification.

### 4.3 Web run-state pill (governed by `specs/wb-serve.spec.md`)

New INTERRUPTED state, derived from the payload's `interrupted` field.
Priority machine: **RUNNING (live lock) > INTERRUPTED > STALE > NEEDS REVIEW
> PAUSED > IDLE.** INTERRUPTED outranks the stale text only because its pill
names the dead holder pid itself — the "a dead lock is never silently
displaced" invariant is preserved — and a dead lock **without** running items
renders the verbatim stale text, unchanged. Pill: a `<button type="button">`
(orange/infra accent, distinct from amber NEEDS REVIEW and stone PAUSED)
reading `INTERRUPTED · drive did not end cleanly — #<id> <slug> at <stage>
(last holder pid <pid> | (no live factory lock)) — press Start Processing`;
clicking it calls the same shared `pressRun()` path as the Start Processing
button and the PAUSED pill (single-flight guard, busy-409 handling, watchdog).
All interpolated strings go through `esc()`.

### 4.4 Web live feed

`FEED_COLOR["drive-interrupted"] = "#ea580c"`; `feedDetail` renders
` — item requeued (last holder pid <pid>)` / ` — item requeued (holder
unknown)` after the standard `#<id> <slug> · <stage>` prefix.

## 5. Run-log exit markers

Every drive loop emits exactly one terminal line at end of episode. Pure
renderer, `src/drive.ts`:

```ts
export type DriveExit = "completed" | "capped" | "interrupted";
export function driveExitLine(mode: "run" | "resume", exit: DriveExit, detail?: string): string
```

| case | line (stream) |
|---|---|
| CLI `wb run` natural end | `drive exited: completed (one stage per item)` (stdout) |
| CLI/web resume natural end | `drive exited: completed (nothing actionable left)` (stdout) |
| resume safety cap | `drive exited: capped — run `wb resume` again to continue` (stdout; the pre-existing stderr safety-cap line stays) |
| throw out of the drive body | `drive exited: interrupted — <error message>` (stderr, before the rethrow; the global `fail()` still prints `factory: <message>` unchanged) |
| SIGTERM during the drive | `drive exited: interrupted (SIGTERM)` (stderr) |

- The web drive (`startRun`'s task) prints the same lines server-side.
- The CLI `run`/`resume` actions install a `process.on("SIGTERM")` handler
  (removed in a `finally` after the body returns) that prints the interrupted
  line and exits non-zero. Node's synchronous console writes cover the marker
  before exit (best-effort; a lost write degrades to the truncation
  signature). **SIGINT is deliberately NOT hooked**: Ctrl+C keeps its
  default immediate behavior, and the lock file it leaves behind carries the
  pid for the next drive's reconcile.
- **SIGKILL (and any death no handler survives): no marker.** The log's
  abrupt end right after a stage transition IS the crash signature — this
  paragraph and the README's "When a drive dies" note are the documentation
  of that signature.

## 6. Tests (external seams; hermetic)

Prior art: the orchestrator resume tests (ticket02's crash fixture), the
status-readonly spawned-CLI suite, the watch pure/poll seams, the web-serve
HTTP harness, the page-runtime V8 context. Scenarios (in
`tests/drive-interruption.test.ts` plus web-serve/page-runtime additions):

1. resume/run entry: orphaned running item (± orphan `repo_locks` row) is
   requeued, labeled with the dep-provided pid (or null), the repo-lock
   evidence recorded, the row cleaned (next `stage-start` carries no
   `lockConflict`); idempotency (no duplicate event on the second drive);
   healthy drives emit no events.
2. status snapshot builder: the §2 derivation in all three lock cases; the
   fingerprint invariant (both inputs flip it; the signal is not embedded).
3. spawned `wb status`: the §4.1 line exactly (dead-lock pid / none), absent
   under a live lock, silent on a healthy factory.
4. watch: the counted INTERRUPTED card line (placement, ≤78 content,
   byte-identical without the signal), `pollOnce`'s probe semantics (absent →
   off; provided+null → signal; live → off), the `formatEventText` rule, and
   the no-notification invariant.
5. web: `/api/status` + the SSE connect snapshot carry the field (read-only);
   `/api/run` reconciles before driving (label → next `stage-start` via
   `getHistory`, then a clean status snapshot); the drive-exit markers
   (exactly one completed line; the capped line beside the safety-cap line);
   the graceful-throw case (500 + interrupted marker + requeue labeled with
   the serve task's pid); the pill (render, priority table, one-POST click)
   and the feed row (orange color + detail clause).
6. `driveExitLine`: every canonical string asserted exactly.

SIGTERM/truncation is documented text (here + README), not an automated case:
it is untestable hermetically without real signals.

## 7. Out of scope (deliberate)

- Automatic re-driving of interrupted items (recovery stays a deliberate
  operator action; nothing presses Start Processing for you).
- Per-item labeling of items left `queued` between stages (no persisted
  mid-episode marker exists; adding one would be new infrastructure).
- Supervisors, keepalives, lockfile watchers, or any out-of-process
  observation of the drive process.
- Discovering the *cause* of any particular death; the detail never asserts one.
- Lock format changes, schema migrations (the `repo_locks` cleanup is a
  statement against the existing table), new npm dependencies, `wb gc`'s
  report output, and any change to the recovery contract
  (Start Processing / `wb resume` / `wb run` semantics).
