# Spec: `wb serve` — web UI for the factory workbench

Add a `wb serve` command that hosts a local web UI over the factory, sharing the
exact data and action contract of the CLI. Design language: the "Decision desk"
variant of the throwaway prototype (see Further Notes).

## Problem Statement

The factory is already a mostly autonomous line — but today the operator's only
window into it is a terminal. To know what the factory needs from you, you run
`wb status`; to watch it work, you keep `wb watch` tailing in a pane; to unblock
a parked item you type `wb approve #7`, `wb answer #11 -a "..."` from memory;
to read the spec artifact awaiting your approval you `cat` a path by hand; and
to submit new work you author a markdown file in a folder you must keep open.
The interaction is fine when you're already in the terminal, but it's friction
every time you switch context, and it hides the one thing that matters most —
*what is the factory waiting on me for?* — behind a wall of command recall.

## Solution

`wb serve` starts a small local web server and the operator opens a browser.
One page answers, in this order: how many decisions does the factory need from
me right now (stat tiles + stacked flow bar); where can I submit new work
(composer form for authoring a work item, or dropping existing `.md` files
straight into the inbox); then the parking lot itself — one color-coded,
decision-first card per parked item, with its stage-progress track, its gate
feedback, its triage question inputs, and its artifact links inline, and the
approve / reject / answer / retry actions attached directly to the card. A
live event feed streamed over server-sent events shows claimed / stage
transitions / gate failures / PR creation as they happen, and mutating actions
become plain HTTP POSTs whose effects arrive back through the same stream.

The page is a client of the same core the CLI drives — same DB, same
Orchestrator, same factory lock, same inbox — so the terminal stays fully
functional and the two never disagree about state.

## User Stories

1. As a factory operator, I want to run `wb serve` and see my factory's whole state in a browser, so that I don't have to keep `wb status` in a terminal pane.
2. As a factory operator, I want parked items to be the visual center of the page, so that the question "what does the factory need from me?" answers itself before I scroll.
3. As a factory operator, I want a count of decisions pending on me as a big number at the top, so that I can decide at a glance whether this is a do-something or check-later moment.
4. As a factory operator, I want a proportional flow bar showing the distribution of items (inbox → queued → running stage → parked → done), so that I can feel the factory's shape (congestion, stalls, throughput) without reading a list.
5. As a factory operator, I want each parked item to show a stage-progress track (triage · spec · implement · test · review · pr) marking completed, stalled, and future stages, so that I can see where it died and how far it got.
6. As a factory operator, I want parked items color-coded by why they're parked (approval amber, exhausted rework red, infra orange, triage questions violet, malformed fuchsia), so that I can triage my own attention by color before reading text.
7. As an approving operator, I want the parked stage's artifact as a clickable link inside the approval card, so that I can read the spec/review output in the browser before deciding.
8. As an approving operator, I want Approve and Reject buttons directly on the card, so that my decision is two clicks instead of a command recall.
9. As a rejecting operator, I want a prompt for my rejection reason inline, so that my feedback is structured for the next agent run rather than ad-hoc.
10. As a triage-deferring operator, I want each triage question rendered with its own answer input on the card, so that answering feels like filling out a form, not constructing a CLI flag list.
11. As a triage-deferring operator, I want to submit answers for a subset of questions in one action, so that I'm not blocked by answering one-at-a-time.
12. As an operator whose item failed a gate three times, I want the accumulated gate feedback shown on the card verbatim, so that my retry/abandon decision is informed.
13. As an operator whose item hit infra failure, I want a Retry button that re-queues it without consuming the item's rework budget, so that I can recover fast after fixing my sandbox/network.
14. As an operator with a malformed inbox file, I want the parse reason shown and a retry affordance once the file is fixed, so that malformed items are recoverable like every other parked item.
15. As an operator reviewing a stale-base skipped item, I want stale-base state surfaced as a hint ("git pull in <repo>"), so that I know the remedy without reading docs.
16. As a work author, I want a "New work item" composer with title, target repository, base branch, approval-gate checkboxes, and a markdown description, so that I author an item the same way `wb new` would — with no terminal.
17. As a work author, I want the composer's fields to be validated server-side by the same validation the CLI uses, so that I get clear field-level errors instead of a mystery failure later in triage.
18. As a work author, I want a "start from template" affordance in the composer, so that I know the expected item format without finding `wb template`.
19. As a work author, I want to drop existing work-item `.md` files into the UI, so that hand-written items can flow through the same inbox as composed ones.
20. As a work author, I want submitted items to appear as inbox entries immediately, so that I can confirm my file landed where the factory will claim it.
21. As an operator, I want a "submit and run now" choice at composer submit time, so that I can start the factory immediately instead of remembering to trigger a run later.
22. As an operator watching the factory, I want a live event feed (claims, stage starts/passes, gate failures, parks, PR creation) streamed to the page, so that I see progress in real time, like `wb watch` in a pane.
23. As an operator watching the factory, I want the feed to survive a page reload or reconnect without losing track of position, so that refreshes never produce gaps or duplicates.
24. As an operator with several tabs open, I want each tab to receive updates without multiplying load on the factory, so that leaving tabs open is cheap.
25. As an operator holding a terminal, I want every UI action to go through the same factory lock as CLI commands, so that the web UI and CLI can never interleave destructively on the same item.
26. As an operator, I want a "command in progress" indication (holder pid, age) surfaced from the factory lock, so that I know why an action can't start right now.
27. As an operator, I want one Run button that drives the factory on demand until every actionable item is parked or done, so that I don't need a terminal open to keep the line moving.
28. As an operator, I want run/resume to execute in the background with the page reporting progress via the live feed, so that a multi-minute run doesn't hold or block the browser request.
29. As an operator, I want finished items (PR URLs) linked from their landing card, so that post-factory review is one click.
30. As a security-conscious operator, I want the server bound to localhost only by default, so that the factory isn't accidentally exposed to my network.
31. As a security-conscious operator, I want artifact links restricted to files inside the factory root, so that a crafted path can't read arbitrary files.
32. As an operator on a small screen, I want the page to be usable on a laptop-width window, so that I don't need a dedicated monitor to work the parking lot.
33. As a CLI user, I want `wb status` and the web UI to render from one shared status layer, so that the two surfaces can never disagree.
34. As an operator who trusts their muscle memory, I want the CLI to remain unchanged and fully functional alongside the UI, so that the web server is additive, not a cutover.
35. As an operator, I want the header to show a live RUNNING state with the running item, stage, and a ticking clock, so that liveness is visible at a glance.

## Implementation Decisions

- **New command, new module, thin CLI.** Add a `serve` command to the CLI that loads config/paths, then delegates to a new web-server module. The CLI wiring stays shell-thin, mirroring how `watch` is wired.
- **One seam: the web app boundary.** The server module exports an app factory taking the same factory context the CLI's open command assembles (db, orchestrator, paths, config, inbox claim report) plus a clock/interval knob for tests. All HTTP behavior lives behind this boundary; no new seams below it.
- **Share the status layer with the CLI.** Extract the inbox-classification and item-listing logic from the CLI's status command into a shared internal module that both the CLI renderer and the `/api/status` serializer call. The two surfaces render from one source; no divergence drift.
- **Snapshot-then-delta streaming (SSE).** Updates stream over server-sent events. On connect, the server opens the DB readonly (exactly as `wb status` does — no factory lock) and sends a full snapshot: items, inbox classification, lock info, and the current max history id. Thereafter it polls via the existing watch snapshot feed (same source `wb watch` uses) at the watch interval and writes only new history rows, tagging each SSE event with the history id so the browser's `Last-Event-ID` recovery maps directly onto the `afterId` parameter.
- **One poller, fanned out.** The server polls the DB once per tick regardless of connected SSE client count. Reconnect or second tab triggers a fresh snapshot; no client-side merge logic. Every write to an SSE client goes through one backpressure gate: chunks are written in slices; when the socket reports backpressure, the in-flight slice is left with Node (delivered exactly once) and the remaining queue pauses until `drain`. A client's queued-plus-undrained backlog is capped, and a client whose backlog exceeds the cap is cut — its reconnect replay (bounded) is the recovery path — so a stalled reader can never grow server memory without bound, while a healthy, actively-draining reader is never cut for receiving even a multi-megabyte snapshot.
- **Actions are POSTs; run/resume are backgrounded.** Mutating endpoints (approve with optional note, reject with reason, retry, answer with ordered answers or freeform feedback, item authoring) each map to the corresponding orchestrator/authoring call exactly as the CLI command does. Run and resume are accepted as POSTs started in the background (single-flight enforced by the factory lock itself), and their progress is observed by the client purely through the SSE stream. A request arriving while the lock is held answers immediately with "in progress" plus lock-holder info rather than blocking or double-running. Both Run and Resume map to the same drive in the server — the claim pass plus `Orchestrator.resume()` looping `tickAll()` until no item changes state or the safety tick cap (`maxResumeTicks`, 500) — and the composer's `runNow` performs that same backgrounded drive after the write.
- **Authoring goes through `authorItem`.** The composer posts title, repo, base, approval stages, and description body; the server validates repo and draft with the same validation functions the CLI's authoring path uses, then writes the front-matter'd markdown into the inbox. The composer-and-CLI-shared repo input accepts and expands `~` / `~/sub` (against the operator's home directory, read lazily per call), a bare name matching a known repo (first match in `knownReposNewestFirst` order — i.e. newest-first tie-break), and paths relative to the **factory root** (never the serve process's CWD); the expanded **absolute** path is what `authorItem` validates and persists (the stored front-matter format is unchanged — no relative paths persisted). Explicit-field mode only (no interactive prompts). File-drop posts write the uploaded markdown into the inbox as-is, matching claim/malformed semantics of the inbox scanner (their `repo:` is stored verbatim per claim rules — expansion applies only to composition).
- **Artifact serving with containment.** Parked artifacts are served from paths under the factory root only; the endpoint resolves and rejects anything escaping the root. This single guard is what makes "read the spec before approving" safe in-browser.
- **Localhost-only default.** The server binds to loopback by default with an explicit override for the rare non-default case. No authentication layer in scope — the binding is the boundary.
- **Frontend: one static asset, no build step.** UI is a single self-contained HTML page (vanilla JS with a hand-written stylesheet, rendered server-side as static content — no bundler, no framework, no npm additions, no CDN or any other remote code) served by the same server. EventSource for the feed, plain fetch for actions. The design implements the prototype's "Decision desk" layout: pulse tiles, flow bar, composer, decision cards with stage-progress dots.
- **No new npm dependencies.** `node:http` covers serving and SSE; the page's styles ship as a hand-written `<style>` block inside the page itself. No CDN script — a remote script loaded into a localhost control surface runs same-origin and is invisible to the Host/Origin guards (KB 2026-11-06 16:40); every response additionally carries a strict CSP (see Implementation Contract).

## Testing Decisions

- **Good tests measure the HTTP seam only.** A test makes real requests against the app factory wired to a temp factory root and asserts on responses (status codes, JSON shape, SSE event sequence). No internal reach-ins into handler internals or the orchestrator's call graph.
- **Seam wiring:** the app factory receives a context identical to what production assembles — readonly status readers point at the temp root's real DB; action routes run the Orchestrator with a fake stage runner, matching the existing test harness. This keeps tests honest (real filesystem, real SQLite) without Docker or model calls.
- **Modules under test, one seam:** snapshot endpoint matches the CLI status contract; mutation endpoints drive real state transitions visible from a subsequent snapshot; authoring endpoints produce inbox files with correct front-matter (invalid composer input yields field-shaped errors); run/resume endpoints respect lock single-flight (concurrent second POST gets in-progress semantics, first run's events later appear on the stream); SSE stream delivers snapshot-then-deltas and resumes from a last-event-id after a simulated disconnect; artifact endpoint serves files inside the root and rejects traversal attempts.
- **Prior art:** external-behavior CLI tests spawn real commands against temp roots (status-readonly tests); pipeline/orchestrator tests drive real state transitions with fake runners (ticket tests, watch-integration). The web tests follow both patterns at the HTTP layer.

## Out of Scope

- Garbage collection (`gc`) — remains CLI-only in its entirety for the v1 UI.
- Config editing, KB curation application flows, and any UI-driven writes outside the inbox/actions listed above.
- Authentication, TLS, remote/LAN exposure, multi-user support — the story is single-operator on localhost.
- Persistent frontend tooling (framework, bundler, component library, npm dependencies).
- OS-notification parity with `wb watch` — the browser tab is the notification surface.
- CLI output changes beyond reusing the extracted status layer (CLI remains byte-compatible).

## Further Notes

- **Prototype provenance.** Design originates from a throwaway prototype at `prototype/web-dashboard.html` (three switchable variants: A "Pipeline board", B "Control room", C "Decision queue"). Verdict from the operator: C wins; A's spatial stage distribution folded into C as the proportional flow bar because a kanban requires an uncomfortably wide screen. The prototype must be committed to a throwaway branch as the primary source for the design when implementation lands, and removed from the working tree.
- **Why this stays small.** Everything a UI needs already exists below the seam: readonly snapshot/history feeds for observation, orchestrator actions for control, authoring for intake, and a lock discipline that makes backgrounded run/resume safe. The feature is one new module (server + routing + SSE ticker), one extraction (shared status layer), one static asset (the page), and thin CLI wiring.
- **Update-transport decision record.** WebSockets were rejected (return channel unused, new dependency); browser polling was rejected (latency and client-side merge complexity); SSE+ snapshot-then-delta chosen because the existing watch snapshot feed makes it a thin wrapper: same poller, same event ids, same resumability model as the pipeline itself.

---

# Implementation Contract (v1, kept in lockstep with the code)

This section is the implementation contract for the shipped `wb serve`; any
observable behavior change must update it in the same commit (repo
spec-lockstep convention). Modules: `src/status.ts` (shared status layer),
`src/web/server.ts` (app factory, routes, SSE ticker, `runServe`),
`src/web/page.ts` (`PAGE_HTML`), thin `serve` command in `src/cli/index.ts`.
No npm dependency changes; the page is vanilla JS with a self-contained
hand-written stylesheet, served as one static string. The page loads no
remote code, and every response carries a strict CSP (`SERVE_CSP`).

## Hard constraints

- The server process never holds the factory lock: observation goes through
  `FactoryDb.openReadonly(root)` (the `wb status` discipline), and every
  mutating request acquires `acquireFactoryLock` for the duration of that
  action only (construct → use → dispose → close → release — the CLI
  `withFactory` lifecycle without the inbox claim).
- `wb serve` never claims inbox files (no `scanInbox` at startup or in
  per-item actions); claiming belongs to the `run` action (`POST /api/run`
  and `runNow`).
- `wb status` output stays byte-identical: `classifyInbox`, `formatAge`, and
  `printStatusItems` were moved verbatim into `src/status.ts` and re-imported
  by the CLI.
- Localhost-only by default: binds `127.0.0.1`; `--host` is the only escape.
  No auth — the binding is the boundary.
- `wb serve` on a root without `factory.db` prints the friendly status/watch
  message and exits 0.
- The page loads no remote code (no CDN script, no remote CSS): styles are a
  hand-written `<style>` block inside `PAGE_HTML` (a minimal preflight, the
  component classes, and the utility classes the markup uses). A remote
  script on a localhost control surface would run same-origin, invisible to
  the Host/Origin guards (KB 2026-11-06 16:40).

## CLI wiring

`wb serve [--root <dir>] [--port <n>] [--host <addr>] [--interval <seconds>]`
(defaults 7466 / 127.0.0.1 / 2). Mirrors `wb watch`: resolve config/root,
refuse a fresh root, open the DB read-only, listen, print
`wb serve — http://<host>:<port> · Ctrl+C to stop`, keep alive until SIGINT
(clean exit 0; readonly DB closed). Production runners (`SandcastleStageRunner`,
`SandcastleCurator`, `GhPrPublisher`) are constructed per mutating action,
never at startup. `--port` must be an integer 1–65535 (anything else: a
friendly `wb serve: invalid port …` message and exit 1, before any listen);
listen failures are friendly too — EADDRINUSE prints
`wb serve: port <n> on <host> is already in use — pass --port <n> to pick another`
and exits 1; other listen errors print `could not listen on <host>:<port> — <reason>`.

## Shared status layer (`src/status.ts`)

- `classifyInbox(db, inboxDir)`, `formatAge(ms)`, `printStatusItems(db, {all})`
  — verbatim CLI presentation helpers (see above).
- `buildStatusPayload({root, paths, db, clock?})` → `StatusPayload`:
  `{ root, generatedAt, maxHistoryId, lock, counts, flow, stages, knownRepos,
  inbox, items }`. Read-only calls only (no lock, no writes).
  - `lock`: `readLockInfo` + `lockHolderAlive` + age (`stale` when older than
    the 10-minute threshold), or `null`.
  - `counts`: `decisions` = every status that is neither actionable
    (queued/running) nor terminal (done/rejected) — the same parked set
    `wb watch`'s card uses; `running`, `queued`, `inbox` (claimable), `done`.
  - `flow`: segments in factory order, zero-count omitted — inbox, queue, one
    per stage for running items at that stage, parked, done (the proportional
    bar; prototype variant A folded into C).
  - `items`: ALL items (incl. done), newest-last, each an `ItemRecord` plus at
    most three derived fields: `artifacts` (the parked stage's artifacts for
    `awaiting-approval`; all artifacts for `done`), `prUrl`/`prDraft` (from
    `parkedDetail` when done), `questions` (from `parkedDetail` when
    `needs-human`). `artifact.path` is root-relative as stored.

## HTTP surface (`createServeApp(deps)` → `{handler, flush, stop}`)

`deps`: `{ root, paths, config, db (readonly), makeRunner, intervalMs? (0 = no
timer, tests drive `flush()`), clock?, runMode? ("background" | "await"),
bindHost? (the `--host` the server is bound to; the Host/Origin guard below
also accepts it) }`.
`makeRunner()` returns `{ runner, curator, publisher, baseCheck? }`; production
omits `baseCheck` (the real `GitBaseFreshnessChecker` is used), tests pass a
silently-proceeding checker (`tests/helpers.ts` rationale). Errors are JSON
`{ error }` (+ field arrays / lock objects). Bodies over 2 MiB → 400; non-JSON
bodies → 400; non-`application/json` request Content-Type → 415.

### Request hardening (CSRF / DNS rebinding)

The localhost binding alone is not a browser boundary (KB 2026-11-06 16:28):
HTML form POSTs from any page the operator merely visits reach the server with
simple content types and no CORS preflight. Every `/api/*` request (any
method) is therefore guarded before routing:

- The Host header must be present and name `127.0.0.1`, `localhost`, or the
  configured `--host` (`bindHost`; bracketed form accepted for IPv6), with a
  port equal to the bound port — anything else → 403. This defeats DNS
  rebinding (foreign hostnames never pass the allowlist) and CSRF pages
  (which cannot forge Host).
- An Origin header, when present, must equal `http://<Host header value>`
  (trailing slash tolerated) — anything else → 403.
- Mutating endpoints additionally require `Content-Type: application/json`
  (a `; charset=` suffix is allowed); form-encoded / text/plain / missing →
  415 before the body is parsed.
- Every response — the page, API JSON, SSE stream, artifacts, and error bodies
  alike — carries a strict `Content-Security-Policy` (`SERVE_CSP`):
  `default-src 'none'; frame-ancestors 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:`.
  Combined with the self-contained page (above) it guarantees no remote
  resource can ever run on or exfiltrate from this control surface.
- `GET /` serves the page itself without the API guard (static markup, no
  data in it).

| Method/Path | Result |
|---|---|
| `GET /` | 200 `text/html` — `PAGE_HTML` |
| `GET /api/status` | 200 `StatusPayload` |
| `GET /api/events?afterId=<n>` | 200 `text/event-stream` (below) |
| `GET /api/template` | 200 `text/markdown` — `ITEM_TEMPLATE` |
| `GET /api/artifact?path=<rel>` | 200 file / 400 missing path / 403 escape or non-`items/` / 404 missing |
| `POST /api/items` `{title, repo, base?, approvals?, description, runNow?}` | 201 `{ok, file, slug, runStarted, runBusy?}` / 422 `{errors: [{field, reason}]}` / 409 busy. `repo` is expanded before validation (`~`/`~/sub` → operator home, bare known-repo name → that repo, otherwise resolved against the factory root); an unresolvable repo yields a 422 field error on `repo` naming the expanded path. |
| `POST /api/items/drop` `{filename, content}` | 201 `{ok, file}` / 400 bad name / 409 collision / 409 busy |
| `POST /api/items/:id/approve` `{note?}` | 200 `{item}` / 404 / 409 |
| `POST /api/items/:id/reject` `{reason}` | 200 `{item}` / 400 missing reason / 404 / 409 |
| `POST /api/items/:id/answer` `{answers: [{question, answer}]} | {feedback}` | 200 `{item}` / 400 / 404 / 409 |
| `POST /api/items/:id/retry` | 200 `{item}` / 404 / 409 / 422 `still malformed: …` |
| `POST /api/run`, `POST /api/resume` | 202 `{started: true, capped?}` / 409 `{busy: true, error, lock}` — both verbs now perform the identical backgrounded resume drive; the web server's `/api/run` deliberately diverges from CLI `wb run`'s one-stage semantics |

Fixed error mapping: unknown item id → 404 (numeric ids only; id-or-slug
prefix matching stays CLI-only). `requireStatus`/`retry`-guard and other
orchestrator errors → 409 with the message. `FactoryBusyError` → 409 with
`{pid, ts, ageMs, alive, stale}` lock info. Composer validation failures →
422 field-shaped errors (order: title → repo → base → approvals →
description; `authorItem`'s composite reason — duplicate slug, EEXIST — is
the `item`-field backstop).

## Actions

- Each action runs the CLI `withFactory` lifecycle minus the claim, with the
  per-request lock. The runner + Orchestrator are constructed lazily, only by
  the actions that drive stage transitions (approve/reject/answer/retry,
  run/resume); the composer and the file drop take the lock + writable DB
  only. `approve`'s note maps to `-n`; `reject` requires a reason (400 on
  empty, mirroring commander's `requiredOption`).
- `answer` deliberately diverges from the CLI's `matchAnswers`: the server
  validates each submitted `{question, answer}` pair against
  `parkedDetail.questions` by exact string equality (at least one pair,
  non-empty answers; unknown questions → 400) and calls `orch.answer(id,
  pairs)` directly — subsets are legal (story 11); unanswered questions come
  back as a fresh `needs-human` park if triage still needs them. Questionless
  parks take `{feedback}` and store the CLI's `"(free-form)"` pair. The CLI's
  full-count `matchAnswers` path is untouched.
- `retry` maps to `orch.retry`; an unfixed malformed file surfaces the parse
  reason as 422 `still malformed: …`.
- `run`/`resume`: the lock is acquired synchronously (busy → 409 + lock info);
  on success the response is 202 immediately (awaited in test mode) and the
  task does the claim pass (`scanInbox`) then `resume()` (the
  drive-until-parked loop) for both endpoints — the web Run button and CLI
  `wb run` intentionally diverge: CLI `wb run` stays one-stage
  (`orch.tickAll()`), `wb resume` is unchanged (`capped` reported; a capped
  drive logs the CLI's safety-cap line server-side). Resume also unparks
  `human-rejected` items, feeding the rejection reason as feedback into the
  next run — the UI Run button inherits that behavior. Progress reaches
  clients only via SSE. Single-flight is enforced by the lock itself (a
  second POST during a run → 409).
- Composer writes go through `authorItem` (explicit-field mode,
  non-interactive `AuthoringIO`); `runNow: true` performs the identical
  background-resume procedure after the write and reports `runStarted` /
  `runBusy`.
- File drop: `filename` must be a plain `path.basename` (path-shaped input →
  400 — KB 2026-11-02 22:31 path-injection guard) matching
  `^[A-Za-z0-9][A-Za-z0-9._-]*\.md$`; content is written byte-exact,
  unparsed, with exclusive create (collision → 409).

## SSE protocol (`GET /api/events`)

Headers: `text/event-stream`, `no-cache`, `keep-alive`, `X-Accel-Buffering:
no`. On connect: one read snapshot; when `afterId` (query param, or the
`Last-Event-ID` header EventSource sends) is present, the missed rows are
replayed first — the replay *read* is bounded in the query itself
(`getRecentHistorySince(afterId, MAX_SSE_REPLAY_ROWS)`: SQL
`ORDER BY id DESC LIMIT ?`, reversed to ascending id order), so a
far-behind client costs at most `MAX_SSE_REPLAY_ROWS` (500) rows of DB
read, never a full-table scan; anything older is dropped in favor of the
snapshot, which is authoritative for current state — then one
`status` event carrying the full `StatusPayload` (no `id:` field; ids
belong only to history rows). Per tick (one shared poll for all clients,
`flush()`): zero connected clients means zero work (no snapshot read, no
payload build); otherwise one `getWatchSnapshot(cursor)` read, one payload
built from that same snapshot (inbox slugs resolve against the snapshot's
items in memory; one artifacts query via `listArtifactsByItem`), and the
fingerprint derived from the built payload; each client receives exactly
the rows with `id > client.lastEventId` (in order, tagged `id:`), then a
`status` event iff a fingerprint over (items' id/status/stage/parkedReason/
parkedDetail/feedback/updatedAt + claimable inbox filenames + lock pid/ts)
changed. Wire serialization is hoisted: each tick builds every history-row
chunk (a map keyed by row id) and the single status chunk once, before the
per-client loop, so fanning out to N clients serializes each event once.
Reconnect or a second tab gets a fresh snapshot; there is no
client-side merge. DB read failures are swallowed with a consecutive-failure
counter; from the 5th failure one stderr line per failing poll (watch parity).

## Artifact containment

`GET /api/artifact?path=<root-relative>`: missing path → 400; absolute or
`..` segments → 403 (before resolving); `path.resolve(root, requested)` +
`path.relative` prefix check → 403 on escape; the served prefix is
allowlisted to `items/` → 403 otherwise; an `lstat` file check → 404
(lstat, not stat: a symlink is not a regular file here, so symlinks are
rejected outright rather than followed); both sides are then `realpathSync`'d
and the containment check is repeated on the real paths → 403 on escape (a
symlinked intermediate directory cannot smuggle a file out of the root),
404 if the real resolution fails; served as `text/markdown; charset=utf-8`
with `Cache-Control: no-store`.

## Page (`PAGE_HTML`)

Decision-desk layout (prototype variant C): pulse tiles (decisions amber /
in flight / inbox / landed) + proportional flow bar (sub-9% segments demoted
to a legend); the collapsible composer (title, repo combobox — free-form
input plus a known-repos datalist whose option labels carry per-repo item
counts, newest-first — base default "main", five approval-gate checkboxes, markdown
description, "Start from template" prefill from `/api/template`, "run now",
and a file drop zone); the parking lot — one card per parked item (decision
order: awaiting-approval, needs-human, exhausted-rework,
infrastructure-failure, malformed, human-rejected, then id) with the color
map (amber/red/orange/violet/fuchsia), stage-progress dots (stages before
`item.stage` emerald, current dot in the status color, future stone),
artifact links, note/reason inputs, per-question answer inputs, verbatim gate
feedback, retry with inline 409/422 reasons, stale-base hint on the glance
chips, PR links on done chips, human-rejected hint (Run; no per-item
button); the single Run button (backgrounded resume drive) and the run-state
pill in the header — IDLE (a
calm stone chip, visibly inert: no pulse, no accent) when no lock is held,
RUNNING while a live lock exists (pulsing blue dot, `#id slug · stage` per
running item — or the holder pid when no item is running — and a `mm:ss`
elapsed clock that ticks client-side every second and re-anchors from
`lock.ageMs` on each status event; clicking the pill scrolls to the glance
row and one-shot-flashes the running item's chip), the verbatim stale-lock
text for a dead holder, and back to IDLE once the lock clears; an
append-only live feed colored by event. EventSource auto-reconnect with
`Last-Event-ID` provides gapless resume. Every untrusted string is rendered
through `esc()`/`textContent` (no raw `innerHTML` interpolation of data); all
actions are same-origin `POST` with `Content-Type: application/json`; no CORS
headers are emitted. Styles are a hand-written `<style>` block inside the
page (minimal preflight + the utility classes the markup uses + the
lbl/finput/ferr/btn component classes) — no CDN script, no remote CSS, and a
strict CSP rides on every response (Request hardening above). Width:
`max-w-3xl`, laptop-first.

## Tests

`tests/web-serve.test.ts` — HTTP-seam only: `createServeApp` wired to a temp
factory root via `createHarness()` (readonly DB handle, `ScriptedRunner`/
`FakePublisher` + silent-proceed `baseCheck`, `runMode: "await"`,
`intervalMs: 0`), served on `127.0.0.1` with a real `http.Server`, exercised
with `fetch`. Covers: page/template endpoints and the no-lock invariant;
`/api/status` item/inbox equality with the shared status layer (decisions
counts, questions, artifacts, prUrl, lock holder); approve (±note) /
reject (400 vs 200) / retry (infra budget untouched, malformed 422→fixed 200,
wrong status 409) / answer (subset, full set with merge, unknown question,
free-form) driving real transitions; composer front-matter round-trip,
field-shaped 422s, duplicate slug, `runNow` (drives until parked — e.g.
approval-gated composer items end `awaiting-approval`); drop byte-exactness,
bad names, oversize, collision, malformed JSON; lock single-flight across
every mutating endpoint plus a concurrent run during a slow-stage execution;
resume to completion with `capped: false`; Run → resume mapping (`/api/run`
on a human-rejected item revives and lands it, and an approval-parked item
is not unparked); SSE snapshot-then-delta with ids,
no-change quiet, `afterId`/`Last-Event-ID` resumption without gaps or
duplicates, fan-out of one poll to two clients; artifact containment
(200/400/403/404 matrix) plus symlink rejection (a symlink artifact → 404, a
symlinked intermediate directory escaping the root → 403); request
hardening: non-JSON content types → 415 (charset suffix allowed), foreign /
wrong-port / absent Host and mismatched Origin on `/api/*` → 403 while the
static page is served regardless; the strict CSP on every response (page,
JSON, artifact, error, SSE) and the page's self-containment (no CDN script,
no remote URLs); CLI entry (spawned): fresh-root refusal
(exit 0), invalid `--port` (friendly message, exit 1), EADDRINUSE (friendly
message, exit 1).
