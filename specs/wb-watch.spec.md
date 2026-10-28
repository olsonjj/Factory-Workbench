# Spec: `wb watch` — live change feed with compact status card

## 0. Scope and hard constraints

- Add one new CLI command, `wb watch`, to Factory Workbench.
- New implementation module: `src/watch.ts` (pure rendering/diffing functions exported for tests).
- Thin CLI wiring only in `src/cli/index.ts` (commander registration + poll loop).
- Read-only: **never** acquire the factory lock, never write to the DB, inbox, KB, or anywhere on disk. This is mandatory — see "Repo reality" below for why the naive code paths would not be read-only.
- No new npm dependencies (commander, better-sqlite3, zod, vitest are already present in `package.json`).
- No CLI flags beyond `--root <dir>` and `--interval <seconds>`. No spinner/animation, no cursor games, no extra commands.
- Out of scope: README/docs changes, web UI, filtering, following `wb run`'s stdout.

## 1. Repo reality (verified facts the implementer must not re-derive)

All claims below verified against current HEAD (`5a71d6f`, branch `factory/add-wb-watch-live-change-feed-with-compact-status-card`).

### 1.1 DB schema and access (`src/db.ts`)

- The DB lives at `<root>/factory.db` (`src/db.ts` `FactoryDb` constructor: `path.join(root, "factory.db")`). Default root is `./factory` (`src/config.ts` `loadConfig`: `path.join(cwd, "factory")`), so the task's "factory/factory.db" is the default path.
- `history` table: `id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id), ts TEXT NOT NULL, event TEXT NOT NULL, stage TEXT, detail TEXT NOT NULL DEFAULT '{}'` (`src/db.ts` `migrate()`).
- Read-only handle: `FactoryDb.openReadonly(root)` (`{ readonly: true, fileMustExist: true }`, no mkdir, no migration). This is exactly how `wb status` opens the DB — mirror it.
- **No existing method reads history globally.** `getHistory(itemId)` (`src/db.ts` ~line 266) filters by item and, importantly, does **not** return the row `id`. Add a new method (or use `db.db.prepare(...)` from `watch.ts`; adding a method to `FactoryDb` is preferred — matches `getHistory` style and is read-only; note the readonly connection never runs `migrate()`, so the method must not write):

  ```ts
  /** New rows for `wb watch`, in id order. Purely read-only. */
  getHistorySince(afterId: number): HistoryRow[]
  // SELECT id, item_id, ts, event, stage, detail FROM history WHERE id > ? ORDER BY id
  // (detail parsed with JSON.parse, guarded: invalid JSON → {})
  ```
  Also `getMaxHistoryId(): number | null` (`SELECT MAX(id) AS m FROM history`) or reuse `getHistorySince` + rowcount. A `MAX(id)` for the first-poll prime is cheapest.
- Items snapshot: `db.listItems()` already returns `ItemRecord[]` ordered by `id` — sufficient for the status card. No new items query needed.

### 1.2 Event vocabulary — discrepancies vs the task text (IMPORTANT)

The task text names some events differently from what the pipeline actually writes. There is a single source of truth: the strings persisted in `history.event`. Verified writers (`src/pipeline.ts`, `src/inbox.ts`):

| Task text   | Actual `history.event` value(s)  | Written at |
|-------------|----------------------------------|------------|
| `claim` / `claim-resurrect` | `claimed` / `resurrected` (two separate events) | `src/inbox.ts` lines 70, 85 |
| `stage-fail` | `stage-gate-fail` (only gate-fail event written; `stage-infra-fail` exists in `HistoryEvent` type but is never written — infra retries write `stage-retry`) | `src/pipeline.ts` ~526, ~425 |
| —           | also written: `stage-start`, `stage-pass`, `parked`, `unparked`, `answered`, `approved`, `rejected-by-human`, `archived`, `pr-created` | `src/pipeline.ts` |

Resolution (spec rule): the renderer keys off the **DB event strings**. Map: `claimed`→claim line, `resurrected`→claim-resurrect line, `stage-gate-fail`→the task's "stage-fail" rule. Everything not explicitly mapped (`stage-retry`, `approved`, `archived`, anything unknown) goes through the "other/unknown event" rule.

Actual event payload shapes (this is what the renderer must tolerate):

- `claimed` / `resurrected`: `stage = NULL`, `detail = { file }` (malformed-claim variant adds `malformed: <reason>` — `src/inbox.ts` line 70). So `claim → <stage>` degrades: stage is always null here → per the task's null-stage convention, render just `claim` / `claim-resurrect` with no arrow segment.
- `stage-start`: `detail = { attempt }` (first write), optionally a second row `detail = { lockConflict: true }` (`src/pipeline.ts` 387, 395). PR stage writes `stage-start "pr", {}`.
- `stage-pass`: `detail = { nextStage, ...usage }` where usage fields are `model`, `inputTokens`, `outputTokens`, `durationMs` (`src/pipeline.ts` 512). **Note:** today `stage-pass` rows never carry `rounds` (only `parked` exhausted-rework rows do, pipeline line 538). Implement the ` (r<n>)` clause anyway per task text; it simply won't fire for rows the current pipeline emits.
- `parked` reasons actually written:
  - `awaiting-approval` — `pipeline.ts` 514 (`detail = { reason: "awaiting-approval" }`)
  - `needs-human` — `pipeline.ts` 587 (`{ reason: "needs-human", questions }`)
  - `exhausted-rework` — `pipeline.ts` 538 (`{ reason: "exhausted-rework", rounds }`)
  - `unhandled-error` — `pipeline.ts` 103 (`{ reason: "unhandled-error", error }`)
  - infra parks — `pipeline.ts` 421 (agent stage) and ~653 (pr stage) write `detail = { reason: <free-form error message starting "infrastructure failure after N retries: …"> }`, **not** the literal `infrastructure-failure` string. The item's `parked_reason` column *is* the literal `infrastructure-failure` for these rows.
  - malformed (re-parse failure) — `src/pipeline.ts` `refreshFromSource` via the shared `parkMalformed` helper (`src/util.ts`): writes `{ reason: parsed.reason }` (e.g. `"repo: missing ..."` — **never** prefixed) with row `stage = item.stage` (the stage the item was working in when parked); `item.parked_reason` at that point is `"malformed front-matter: <parsed.reason>"`.
  - malformed (claim-path) — `src/inbox.ts` `scanInbox`'s malformed branch via the same shared `parkMalformed` helper, right after the `claimed` row: `{ reason: parsed.reason }` with row `stage = item.stage` (`"triage"`; the stage the item was inserted with); `item.parked_reason` is `"malformed front-matter: <parsed.reason>"`. (Historically the claim path only wrote the `claimed` row; the `parked` row was added so watch renders the parked line/hint/notification.)
- **Canonical shape (both malformed park sites, via `parkMalformed` in `src/util.ts`):** every malformed `parked` row has `stage = item.stage` and `detail = { reason: parsed.reason }` where `parsed.reason` is the bare parse error — the `"malformed front-matter: "` prefix exists **only** in the item's `parked_reason` column, never in `detail.reason`.
- `unparked`: `{ via: "resume", feedback }` (feedback may be null), `{ via: "retry", note: "front-matter fixed" }`, `{ via: "retry", resetGate }`, `{ via: "retry" }` (no feedback/note!), `{ note: "front-matter edited by operator" }` (no `via` → this is NOT an unparked-with-via case; treat `via` as absent → falls to unknown-event rule since `unparked` has no explicit rule other than the via clause. **Careful:** the task defines an unparked rule that assumes `via` exists. When `detail.via` is missing, render `unparked → <stage>` with no parenthetical, same as via-present-but-empty-text case.)
- `rejected-by-human`: `detail = { reason: <operator feedback> }` (`pipeline.ts` 205; row `stage` = the *completed* stage). Feedback text = `detail.reason`.
- `answered`: `detail = { answers: [...] }`, row `stage = "triage"`.
- `pr-created`: `detail = { url, number, draft }` (and optionally `recoveredExisting: true`).
- `approved`: `detail = { note: <string|null>, nextStage: <stage> }` → unknown-event rule.
- `archived`: row `stage = "triage"`, `detail = { report }` → unknown-event rule. (Item then has status `rejected`, `parked_reason = "triage-rejected"`.)

`detail` is always valid JSON in practice (written via `JSON.stringify` in `appendHistory`, `src/db.ts` 244), but parse defensively anyway (empty/invalid → `{}`).

### 1.3 Config (`src/config.ts`)

- `budgets.maxGateAttempts` (default 3) is the gate "max" for the ` (gate <n>/<max>)` suffix. Access it via `loadConfig(rootOverride)` at CLI startup; pass the number down into the pure renderer. "If unknown, omit the suffix" applies to the pure functions (maxGateAttempts === null).

### 1.4 Read-only command pattern to mirror (`src/cli/index.ts` `status` command, `tests/status-readonly.test.ts`)

- `const { root, config } = loadConfig(opts.root)`; then `existsSync(path.join(root, "factory.db"))` guard → friendly message and return when missing (copy the status wording style: `no factory.db in ${root} yet — it is created by any write command (e.g. \`wb new\` or \`wb run\`)` — reusing this exact message is fine).
- `FactoryDb.openReadonly(root)`, `try { ... } finally { db.close() }`. Never call `acquireFactoryLock`, never `scanInbox`, never `ensureLayout`/`ensureConfigFile` (those mkdir/write; `openFactory`/`openAuthoringRoot` in `cli/index.ts` are the examples of what NOT to use for watch).
- Status does not report lock info in its core loop; watch need not replicate the lock-reporting section — the task only demands "never acquire the factory lock" and "tolerate DB read errors the same way status does".

### 1.5 Test infrastructure (`tests/helpers.ts`, `tests/status-readonly.test.ts`)

- `createHarness(budgetOverrides?)` gives `root`, `paths`, `db` (writable FactoryDb), `config` (`maxGateAttempts` 3 by default), `inboxFile(...)`, `cleanup()`.
- `claim(harness)` runs `scanInbox` to ingest inbox files (this is the seeding mechanism).
- CLI subprocess pattern (if needed): `spawnSync("node", ["--import", "tsx", cliPath, ...])` with `cliPath = <repo>/src/cli/index.ts`; prefer **direct calls to pure/poll functions** for watch so no live loop or real timers are involved.
- `tests/integration/sandcastle.test.ts` wraps a describe in a gated `d` (Docker/OLLAMA check) — NOT needed here; watch tests require no network/docker.

## 2. Module design: `src/watch.ts`

```ts
import type { FactoryDb } from "./db.js";

/** History row as returned by FactoryDb.getHistorySince. */
export interface WatchEventRow {
  id: number;
  itemId: number;
  ts: string;            // ISO string as stored in history.ts
  event: string;         // DB string (NOT the HistoryEvent union — may be anything)
  stage: StageName | null;
  detail: Record<string, unknown>;
}

/** Minimal item info the renderer needs (structurally compatible with ItemRecord). */
export interface WatchItem {
  id: number;
  slug: string;
  stage: StageName | string;
  status: ItemStatus | string;
  parkedReason: string | null;
}

export interface WatchState {
  lastEventId: number;   // last-consumed history id
  lastCard: string | null; // last rendered card, null before first render
  first: boolean;        // true until the first poll has run
}

export interface WatchOutcome {
  lines: string[];            // ordered lines to print (event lines, card block lines)
  notificationTexts: string[];// texts to hand to the OS notifier (parked events only)
  state: WatchState;          // successor state (lastEventId, lastCard, first=false)
}
```

Exported pure functions:

```ts
parseIntervalSeconds(raw: string | undefined): number
ellipsize(s: string, max: number): string           // existing repo pattern, see below
formatEventText(row: WatchEventRow, item: WatchItem | undefined, maxGateAttempts: number | null): string
formatEventLine(row, item, maxGateAttempts): string  // includes ⚠/(!)/bell, see §4
parkedFixHint(reason: string, parkedReason: string | null): string | null
renderCard(items: WatchItem[]): string               // full block incl. separator rules
runWatchOnce(rows: WatchEventRow[], items: WatchItem[], state: WatchState, maxGateAttempts: number | null): WatchOutcome
pollOnce(db: FactoryDb, state: WatchState, maxGateAttempts: number | null): WatchOutcome  // queries DB then calls runWatchOnce; guarded per §6
startWatch(db: FactoryDb, state: WatchState, maxGateAttempts: number, intervalSec: number, out: (line: string) => void, notify: (text: string) => void, tick: (ms: number) => void): () => void  // loop used by CLI; tick injectable for tests
notifyParked(text: string, platform: NodeJS.Platform = process.platform, spawnFn = spawn): void
```

Truncation helpers use the repo's established idiom (`src/kb.ts` line 124, `src/pipeline.ts` line 896):

```ts
ellipsize = (s, max) => s.length > max ? `${s.slice(0, max - 1)}…` : s
```
(i.e. total length ≤ max **including** the `…`). Parked feedback/reason/note texts: `ellipsize(x, 60)`. Card content lines: `ellipsize(line, 80)`.

## 3. CLI wiring (`src/cli/index.ts`)

Register after the `status` command, mirroring sibling commands:

```ts
program
  .command("watch")
  .description("Watch the factory live: print changes and OS-notify when items park")
  .option("--root <dir>", "factory root directory")
  .option("--interval <seconds>", "seconds between DB polls", "5")
  .action((opts: { root?: string; interval?: string }) => { ... });
```

Action body (read-only mirror of `status`):

1. `const intervalSec = parseIntervalSeconds(opts.interval)`;
2. `const { root, config } = loadConfig(opts.root)`;
3. `existsSync` guard on `path.join(root, "factory.db")` → same friendly message as `status`, return;
4. `const db = FactoryDb.openReadonly(root)` in `try/finally { db.close() }`;
5. Print the startup banner (exact string):
   `wb watch — polling every ${intervalSec}s · quit with Ctrl+C`
6. `let exitRequested` — install `process.on("SIGINT", () => { process.exit(0) })` (implicit exit code 0; no cursor restoration needed since no cursor is manipulated; wrap in try/finally so `db.close()` runs before exit).
7. Run the loop via `startWatch(...)`, where the real `tick` is `setTimeout`-based: run `pollOnce` synchronously, print each of `outcome.lines` with `console.log`/`process.stdout.write`, call `notifyParked` for each `outcome.notificationTexts`, replace `pollState` with `outcome.state`, then schedule the next tick after `intervalSec * 1000`. Use a chained `setTimeout` (not drifting `setInterval`); schedule the first poll immediately (poll once, then schedule).

No factory lock is taken anywhere in this path. `maxGateAttempts = config.budgets.maxGateAttempts`.

## 4. Behavior details

### 4.1 Interval parsing (`parseIntervalSeconds`)

- `undefined` → `5`.
- Otherwise `Number(raw)`; if not finite → `1`; else `Math.max(1, Math.floor(n))`.
- Banner prints the returned integer (so `--interval 0` prints "polling every 1s").

### 4.2 Polling/diff (`runWatchOnce`, `pollOnce`)

- First poll (`state.first === true`): set `lastEventId` to `SELECT MAX(id) FROM history` (0 when no rows), do **not** emit event lines, do **not** print a card; however compute and store the current card in `state.lastCard` (so the second poll compares against real state). Simplest correct implementation: on first poll fetch history rows too but discard them after advancing `lastEventId`; or query max-id directly. Either is acceptable; `pollOnce` may special-case the first poll to query `getMaxHistoryId()` only.
- Later polls: `rows = db.getHistorySince(state.lastEventId)`; consume **all** returned rows in id order (each row printed); `lastEventId` = last consumed row id (unchanged if none).
- After event lines, if the current items snapshot produces a card ≠ `state.lastCard`, append the card lines and update `lastCard`; otherwise append nothing. The card block is:
  ```
  ──────────────────────────────────────────────────
    RUN: <#id slug stage> · <#id slug stage> · …
    PARKED: <#id slug (reason)> · <#id slug (reason)> · …
  ──────────────────────────────────────────────────
  ```
  - Separators: exactly 50 `─` characters (U+2500), matching the task's rule line.
  - Content lines are indented with exactly two leading spaces (as in the task's block).
  - `RUN:` lists items with status `queued` or `running` (matches the literal statuses; equals `ACTIONABLE_STATUSES` in `src/types.ts` — may reference the constant, but note `pollOnce` receives plain rows so either import the constants or hardcode the two strings; importing `ACTIONABLE_STATUSES` from `src/types.js` is preferred), ordered by item id.
  - `PARKED:` lists items whose status is any of: `awaiting-approval`, `needs-human`, `exhausted-rework`, `infrastructure-failure`, `human-rejected`, `malformed` — i.e. all `ItemStatus` values except `queued`, `running`, `done`, `rejected` (terminal, `TERMINAL_STATUSES` in `src/types.ts`). Empty → `  PARKED: none` (two leading spaces).
  - Entry format: `#<id> <slug>` for RUN; `#<id> <slug> (<reason>)` for PARKED, where `<reason>` = `ellipsize(item.parkedReason ?? "?", 60)` (short reason string, as the task says; malformed items will show `malformed front-matter: …` truncated).
  - Each content line (the `RUN: …` / `PARKED: …` text **without** the two-space indent, so the full printed line is ≤ 82 chars) is truncated with `ellipsize(line, 80)` before indenting. Entries are joined with ` · `.
- Card comparison is on the full rendered block string (all lines joined with `\n`), never identical twice in a row.

### 4.3 Event line rendering

Line shape: `[<HH:MM:SS>] #<itemId> <slug> <event-text>`.

- `HH:MM:SS`: `row.ts` is an ISO UTC string; parse with `new Date(ts)` and format `getHours()/getMinutes()/getSeconds()` zero-padded to 2 digits with `:` separators (local time of the machine). Invalid date → fall back to the raw `ts` string truncated to the same shape is unnecessary — just print the raw ts with its time portion is overkill; fall back to `00:00:00`. Tests (§7) must construct timestamps locally (e.g. `new Date(2026, 0, 2, 3, 4, 5).toISOString()`) so the expectation is timezone-independent.
- `#<itemId>`: the history row's `item_id` (this is also what the status card uses; the task's prose mentions "eventId" but the line template says `#<itemId>` — item id wins; do **not** print the history row id).
- `<slug>`: looked up from the items snapshot by `item_id`. If the item is missing from the snapshot (e.g. raced between the two queries), fall back to `(unknown)`.
- Bell: parked lines additionally emit the BEL character `\x07` at the end of the printed line.

`formatEventText` rules, keyed by `row.event` (see §1.2 for actual DB strings):

1. `claimed` → `claim` + (stage non-null ? ` → <stage>` : ``) — in practice stage is always null here, so plain `claim`.
2. `resurrected` → same as claimed but text `claim-resurrect`.
3. `stage-start` → `<stage> → start`, then ` (gate <n>/<max>)` when `detail.attempt` is a number > 1 **and** maxGateAttempts is not null (n = attempt, max = maxGateAttempts). Rows with `{}` or `{ lockConflict }` → no suffix.
4. `stage-pass` → `<stage> → pass` + ` → <nextStage>` when `detail.nextStage` is present + ` (r<n>)` when `detail.rounds` is present (n = rounds). (Current pipeline never writes `rounds` on stage-pass — implemented per task anyway.)
5. `stage-gate-fail` (the task's "stage-fail") → `<stage> → fail` + ` (gate <n>/<max>)` when `detail.attempt` is a number and maxGateAttempts is not null (present at any attempt ≥ 1, per task "per gate-attempt detail when present").
6. `parked` → `parked at <stage> — <reason>` with:
   - stage: `row.stage`; when null, omit `at <stage>` → `parked — <reason>`.
   - reason: `detail.reason` if it is a non-empty string, else `item.parkedReason ?? "unknown"`.
   - fix hint (`parkedFixHint`), driven by the derived reason **plus** the item's `parked_reason` (check both — see the malformed note below). Exact hints, in first-match order:
     | Condition | `fix` hint |
     |---|---|
     | reason (or parkedReason) starts with `malformed` | `wb retry <slug>  # fix front-matter first` (two spaces before `#`) |
     | reason === `awaiting-approval` | `wb approve <slug>` |
     | reason === `needs-human` | `wb answer <slug>` |
     | reason === `human-rejected` | *no hint* |
     | reason === `exhausted-rework` or `infrastructure-failure` | `wb retry <slug>` |
     | anything else | `wb resume <slug>` |
     Hint rendered as: `` → `<fix>`` (backticks around the command). No hint → no `→ …` tail.
   - Full line gets the `⚠ ` prefix, the `(!) ` marker after the timestamp, a trailing `\x07`, and its event text is queued as an OS notification text of the form `#<itemId> <slug> parked at <stage> — <reason>` (fix hint excluded; stage omitted when null). `notificationTexts` receives one entry per parked row, in row order.
   - **Malformed rationale (verified):** re-parse parking writes `detail.reason = parsed.reason` (which does *not* start with "malformed") while `parked_reason` = `malformed front-matter: …`; the malformed hint must trigger in this case, hence the both-fields check.
   - **Infra-park rationale (verified):** infra parks write `detail.reason` as a free-form message beginning `infrastructure failure after …`, so the derived reason *is* that message and the fallback hint resolves to `wb resume` (it is not `infrastructure-failure`-equal). This is per the task's derivation rule ("derive reason from detail reason JSON (fall back to the item's parked_reason)"); do not special-case substrings.
7. `unparked` → `unparked → <stage>`; then if `detail.via` is a non-empty string append `` (`<via>`: <text>)`` where `<text>` = the first present of `detail.feedback`, `detail.note` (string values only; `null`/missing → treat as absent). When both absent → bare ` (<via>)`. When `via` absent → no parenthetical. The human text between the colon and `)` is `ellipsize(text, 60)`.
8. `answered` → `questions answered → <stage>` (stage is `"triage"` in practice; omit the arrow segment when stage null).
9. `pr-created` → `PR created → <detail.url>` when `detail.url` is a string; if url missing, fall through to the unknown rule.
10. `rejected-by-human` → `rejected at <row.stage> — <ellipsize(detail.reason, 60)>` (stage present in practice).
11. Any other event → `<event>` + (stage ? ` <stage>` : ``); if `Object.keys(detail).length > 0` append ` (<keys>)` with keys in insertion order joined by `, `. Example from the task: `custom_event (via, round)`; a real one: `stage-retry test (attempt, backoffMs, error)`.

Parked-line shape (with markers and bell), full example:

```
⚠ [12:03:04] (!) #3 fix-bugs parked at review — needs-human → `wb answer fix-bugs`<BEL>
```

Non-parked example:

```
[12:03:04] #3 fix-bugs review → pass
```

### 4.4 OS notification (`notifyParked`)

- Best-effort, fire-and-forget, never throws out of the call site:
  - `darwin`: first escape the text for the AppleScript string literal — `safe = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")` — then `spawn("osascript", ["-e", `display notification "${safe}" with title "Workbench"`], { stdio: "ignore", detached: true })` and `.unref()`.
  - `linux`: `spawn("notify-send", ["-t", "5000", "Workbench", text], { stdio: "ignore", detached: true })` and `.unref()` (`-t 5000` is the expire timeout in ms; `Workbench` is the summary, `text` the body).
  - other platforms: no-op.
- Wrap in try/catch; a spawn failure is swallowed silently. Spawn errors that arrive *asynchronously* (e.g. ENOENT when the binary is missing) are reported on the child's `"error"` event — subscribe a no-op handler on the returned child so an unhandled `"error"` can never crash `wb`.
- Security note: `spawn` with argv arrays prevents *shell* injection (no shell ever interpolates the text), but it does **not** make the darwin payload safe on its own — the `-e` argument is AppleScript *source*, so an unescaped `"` in the text would close the string literal and let a parked reason inject script (e.g. `do shell script …`). That is why the text is escaped for AppleScript (backslash and double-quote escaped, newlines flattened) before interpolation.
- CLI wires `notify = (t) => notifyParked(t)`. Tests inject a fake `spawnFn` and assert argv (§7.5).

## 5. CLI surface summary

- `wb watch [--root <dir>] [--interval <seconds>]`
- Description: exactly `Watch the factory live: print changes and OS-notify when items park`.
- Exit codes: 0 on Ctrl+C (SIGINT handler); DB/config failures propagate through the existing `program.parseAsync(...).catch((err) => fail(err))` tail of `src/cli/index.ts` → exit 1.
- Missing `factory.db` → friendly message, exit 0 (mirrors `status`).

## 6. DB-read error tolerance (`pollOnce`)

- Wrap the `pollOnce` DB reads in try/catch. On error: swallow, print nothing that turn (WAL readers essentially never fail transiently; treat any single failure as "no data yet"), increment an internal consecutive-failure counter, and once the counter reaches 5 print a warning to stderr each subsequent failing poll: `factory: db read failed (repeated) — still polling` — never crash, never take the lock, never `process.exit` from a read error. Reset the counter on the first successful poll. (Mirrors `status`'s philosophy: errors are surfaced, not thrown; see `classifyInbox`'s `error` reporting in `src/cli/index.ts`.)

## 7. Tests (vitest; follow `tests/watch.test.ts` + `tests/watch-integration.test.ts`; no real timers, no real OS spawns)

1. **Event formatting** (`tests/watch.test.ts`): build synthetic `WatchEventRow[]` + `WatchItem` with a locally-constructed ts (see §4.3) and a fixed `maxGateAttempts` (3). Cover: claimed; resurrected; stage-start attempt 1 (no gate suffix), attempt 2 (` (gate 2/3)`); stage-pass with nextStage; stage-pass with nextStage + rounds (`(r2)`); parked `awaiting-approval` → `wb approve <slug>` hint, `⚠`, `(!)`, bell; parked `needs-human` → `wb answer <slug>`; parked `exhausted-rework` → `wb retry <slug>`; parked malformed (`detail.reason` plain, `parkedReason` starting `malformed front-matter`) → `wb retry <slug>  # fix front-matter first`; parked with null stage (omits `at <stage>`); pr-created (url from detail); answered; rejected-by-human with >60-char feedback (verify `…` at position 60); unknown event with stage and detail keys (`stage-retry test (attempt, backoffMs, error)` unknown-form example) and unknown event with null stage + empty detail; truncation of unparked feedback to 60 chars.
2. **Card logic**: `renderCard` → `PARKED: none` variant and parked variant; truncation of a long RUN line at 80 (`…` present, length ≤ 82 incl. indent); `runWatchOnce` second-call comparison: unchanged state → `outcome.lines` empty (no card), changed parked_reason → card printed.
3. **Polling/diff**: consecutive `runWatchOnce` calls — call with rows 1–3 then rows 3–10 and assert ids 1–3 are consumed only once (`state.lastEventId` advances 3 → 10; duplicate row ids produce no lines).
4. **Interval parsing**: `parseIntervalSeconds(undefined) === 5`; `"0" → 1`; `"-3" → 1`; `"2.7" → 2`; `"abc" → 1`.
5. **Notification**: fake `spawnFn = (cmd, args, opts) => recorded.push({cmd, args, opts})`; assert darwin call is `osascript` with one `-e` arg containing `display notification "#1 s parked at triage — needs-human" with title "Workbench"`; linux call is `notify-send` with `["-t", "5000", "Workbench", "<text>"]`; `stdio: "ignore"` and `detached: true` in opts; a throwing `spawnFn` doesn't propagate. AppleScript escaping: a text containing `"`, `\\` and a newline (e.g. a `do shell script` injection attempt) must produce an `-e` source with the quote escaped as `\"`, the backslash as `\\\\`, no raw newline, and the payload unable to terminate the string literal.
6. **Integration** (`tests/watch-integration.test.ts`, following `tests/status-readonly.test.ts`'s seeding approach): `createHarness()`, `h.inboxFile(...)` + `claim(h)`, then via `h.db.appendHistory(...)` seed extra rows (claim, stage-start attempt 2, stage-pass with nextStage, parked awaiting-approval, unparked with via/note); call the poll function against `h.db` with `state.first=true`, then again (single polls, no live loop) and assert output lines (banner excluded), that the second poll with no DB changes emits nothing, and that **no `factory.lock` was created** (watch never takes the lock: `existsSync(path.join(h.root, "factory.lock")) === false`).

Run: `npm test` (vitest) and `npm run typecheck` must pass; `strict` + `noUncheckedIndexedAccess` are on in `tsconfig.json` — index-guard accordingly.

## 8. Acceptance checklist

- [ ] `wb watch` exists with the exact description/flags and read-only opening (no lock file, no writes).
- [ ] Banner string exact: `wb watch — polling every 5s · quit with Ctrl+C` (interval substituted).
- [ ] First poll primes silently; subsequent polls append-only; identical cards never reprinted; first change prints a card.
- [ ] All render rules of §4.3 implemented with the DB-event mapping of §1.2.
- [ ] Parked lines: `⚠`, `(!)`, trailing BEL, OS notification (darwin/linux argv per §4.4).
- [ ] Ctrl+C exits 0; DB read errors tolerated.
- [ ] All six test groups in §7 exist and pass; no new dependencies.