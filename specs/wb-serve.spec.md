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
27. As an operator, I want to trigger `run` and `resume` from the UI, so that I don't need a terminal open to keep the line moving.
28. As an operator, I want run/resume to execute in the background with the page reporting progress via the live feed, so that a multi-minute run doesn't hold or block the browser request.
29. As an operator, I want finished items (PR URLs) linked from their landing card, so that post-factory review is one click.
30. As a security-conscious operator, I want the server bound to localhost only by default, so that the factory isn't accidentally exposed to my network.
31. As a security-conscious operator, I want artifact links restricted to files inside the factory root, so that a crafted path can't read arbitrary files.
32. As an operator on a small screen, I want the page to be usable on a laptop-width window, so that I don't need a dedicated monitor to work the parking lot.
33. As a CLI user, I want `wb status` and the web UI to render from one shared status layer, so that the two surfaces can never disagree.
34. As an operator who trusts their muscle memory, I want the CLI to remain unchanged and fully functional alongside the UI, so that the web server is additive, not a cutover.

## Implementation Decisions

- **New command, new module, thin CLI.** Add a `serve` command to the CLI that loads config/paths, then delegates to a new web-server module. The CLI wiring stays shell-thin, mirroring how `watch` is wired.
- **One seam: the web app boundary.** The server module exports an app factory taking the same factory context the CLI's open command assembles (db, orchestrator, paths, config, inbox claim report) plus a clock/interval knob for tests. All HTTP behavior lives behind this boundary; no new seams below it.
- **Share the status layer with the CLI.** Extract the inbox-classification and item-listing logic from the CLI's status command into a shared internal module that both the CLI renderer and the `/api/status` serializer call. The two surfaces render from one source; no divergence drift.
- **Snapshot-then-delta streaming (SSE).** Updates stream over server-sent events. On connect, the server opens the DB readonly (exactly as `wb status` does — no factory lock) and sends a full snapshot: items, inbox classification, lock info, and the current max history id. Thereafter it polls via the existing watch snapshot feed (same source `wb watch` uses) at the watch interval and writes only new history rows, tagging each SSE event with the history id so the browser's `Last-Event-ID` recovery maps directly onto the `afterId` parameter.
- **One poller, fanned out.** The server polls the DB once per tick regardless of connected SSE client count. Reconnect or second tab triggers a fresh snapshot; no client-side merge logic.
- **Actions are POSTs; run/resume are backgrounded.** Mutating endpoints (approve with optional note, reject with reason, retry, answer with ordered answers or freeform feedback, item authoring) each map to the corresponding orchestrator/authoring call exactly as the CLI command does. Run and resume are accepted as POSTs started in the background (single-flight enforced by the factory lock itself), and their progress is observed by the client purely through the SSE stream. A request arriving while the lock is held answers immediately with "in progress" plus lock-holder info rather than blocking or double-running.
- **Authoring goes through `authorItem`.** The composer posts title, repo, base, approval stages, and description body; the server validates repo and draft with the same validation functions the CLI's authoring path uses, then writes the front-matter'd markdown into the inbox. Explicit-field mode only (no interactive prompts). File-drop posts write the uploaded markdown into the inbox as-is, matching claim/malformed semantics of the inbox scanner.
- **Artifact serving with containment.** Parked artifacts are served from paths under the factory root only; the endpoint resolves and rejects anything escaping the root. This single guard is what makes "read the spec before approving" safe in-browser.
- **Localhost-only default.** The server binds to loopback by default with an explicit override for the rare non-default case. No authentication layer in scope — the binding is the boundary.
- **Frontend: one static asset, no build step.** UI is a single self-contained HTML page (vanilla JS + Tailwind, rendered server-side as static content — no bundler, no framework, no npm additions) served by the same server. EventSource for the feed, plain fetch for actions. The design implements the prototype's "Decision desk" layout: pulse tiles, flow bar, composer, decision cards with stage-progress dots.
- **No new npm dependencies.** `node:http` covers serving and SSE; Tailwind enters via CDN/static asset only.

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
