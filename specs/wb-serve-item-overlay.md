# Spec: web UI — item detail overlay with inline spec reader

Status: WIP iteration (learning-as-we-go). `specs/wb-serve.spec.md` is the
governing contract and is updated in lockstep in the same commit; this file is
the working spec for this change.

## Problem

The workbench shows status, stage progress, and parking-lot actions, but it is
opaque about the ticket itself: to read what an in-flight item's spec says —
or an inbox file awaiting claim, a parked item's context, or a landed item's
artifacts — the operator must leave the browser and hunt for
`factory/items/<slug>/artifacts/` in a file explorer or VS Code. The one thing
the factory is actually building (the spec markdown) is invisible in the UI
that supervises the build.

## Decisions

### D1 — Read-only detail route on the existing serve seam

`GET /api/items/:id` (numeric ids only, mirroring `requireItem`'s 404
discipline) served by the same `createServeApp`, under the same lock
discipline as `/api/status`: **no factory lock, read-only DB handle only**
(observation, never mutation). It flows through the global `/api/*`
Host/Origin guard. The JSON envelope:

- `item` — the exact serialization the status snapshot uses (`toStatusItem`,
  now exported from `src/status.ts`; `buildStatusPayload`, `StatusPayload`,
  and `statusFingerprint` are untouched, so the streamed snapshot stays
  byte-identical);
- `artifacts` — the item's **complete** artifact list (name, stage,
  root-relative path, createdAt), for ANY status, not just
  parked/done trimming;
- `spec` — the most recent artifact row named `spec` (the stable name;
  `[...artifacts].reverse().find(name === "spec")`, mirroring `buildPrBody`)
  plus its markdown **content**; `null` when no such row exists;
- `source` — the item's own file (`itemFile`, converted to root-relative and
  allowed only under `items/` or `inbox/`) plus its content; `null` when
  absent/outside the allowlist.

Missing/unreadable files are never error statuses: the field carries
`content: null` + `error: "file unreadable"`, so old items, GC'd trees
(`src/gc.ts` may remove artifact trees), and mid-flight claims all render.
Unknown id → 404 `{error: "unknown item id <n>"}`.

### D2 — Artifact route extended to `inbox/`

`/api/artifact`'s allowlist gains `inbox/` beside `items/`, so unclaimed item
files are served read-only through the same hardened path (no second
file-serving route). Every containment rule is kept: absolute/`..` rejection,
root containment, `lstat` symlink rejection, markdown-only content type,
`Cache-Control: no-store`, async read. The realpath pass now repeats **both**
the containment check and the prefix allowlist on the real path pair — closing
the gap where a symlinked intermediate directory pointing inside the root
could expose e.g. `factory.db` under an allowed-looking requested path.

### D3 — The snapshot is not fattened

Artifact lists and file contents ride only the detail endpoint. The streamed
payload and its fingerprint are unchanged; SSE churn, fan-out size, and
snapshot cost stay exactly as before.

### D4 — Client-side overlay in the single self-contained page

A fixed, z-topped (above `#toast`'s z-50), backdrop-blurred modal
(`#item-overlay`, static in the body, outside every innerHTML re-rendered
container) with a `wb-overlay`/`wb-overlay-panel` CSS pair. Open state is one
module-level var (the `glanceCollapsed`/`flightCollapsed` vocabulary), never
persisted — per-tab, and a live SSE snapshot re-render can neither close nor
corrupt an open overlay because `render()` never writes into `#item-overlay`.

- **Lazy fetch**: opening triggers exactly one GET (`/api/items/<id>` for
  claimed items; `/api/artifact?path=inbox/<file>` for inbox mode, `res.text()`
  — the route answers markdown). Loading shows the `wb-spin` shell; a failed
  fetch shows an inline error plus a retry control that re-issues exactly one
  fetch for the same key. Stale in-flight responses are ignored (a monotonic
  per-open token). Closing discards all fetched state — reopening refetches.
- **Entry points**: flight-panel rows (`div[data-flight-row]`), parking-lot
  cards (`[data-id]`, only when the click did not originate inside a button,
  input, textarea, label, or anchor — artifact links keep their raw-link
  default), glance chips (`[data-item-id]`), and claimable inbox rows (new
  `data-inbox-file` attribute; skipped rows stay non-clickable). Entry clicks
  only ever read.
- **Ready pane (item mode)**: header (`#<id> <title>`, status pill, close
  button; slug · repo · base · branch; `prUrl` link on done items), record grid
  (stage + `stageDots`, approvals, gate attempts, infra retries, timestamps,
  parked reason, the known parkedDetail shapes — stage/error/questions plus
  the stale-base hint — feedback via `feedbackBox`, stored answers), a
  first-class **Spec** section (artifact name + timestamp + raw link +
  content rendered as markdown), an **Artifacts** section (one row per
  artifact: name · stage · createdAt + View raw + inline View, which fetches
  through the artifact route and renders into the section body; failure
  degrades to an inline error note), and a **Source** section (raw link +
  verbatim escaped monospace content, front-matter included). Inbox mode
  renders the file's markdown through the same renderer with a `📄 <file>`
  header and an "unclaimed inbox item" line.
- **Dismissal**: the close button, Esc (one document keydown installed at
  init), a backdrop click (any click that did not originate inside the
  panel), or reopening the workbench (per-load module state). Focus moves to
  the overlay's controls on open and returns to the opener element on close.

### D5 — Minimal markdown renderer, escaped-first

A small hand-written block renderer inside the page script: fenced code
blocks, h1–h4, horizontal rules, blockquotes, ul/ol, paragraphs (one level;
nested constructs render as plain text); spans get bold/italic/inline-code/
link treatment. **Fail-closed**: the raw text is `esc()`'d before any span
recognition, so only the renderer's own tags can materialize; link targets
are additionally restricted to `http:`, `https:`, and relative paths (no `:`
scheme) — `javascript:` and `data:` targets drop the anchor outright and the
bracket title renders as text; every emitted anchor carries
`target="_blank" rel="noopener"`. The renderer is not exported or unit-tested
on its own: it is exercised through the page seam.

### Out of scope

Editing items from the overlay; live SSE refresh of an open overlay
(point-in-time — reopen to refresh); full CommonMark (tables, reference
links, footnotes, nested emphasis, images); inline image rendering; PR diff
viewing (`prUrl` in the header is in, diffs are not); any pipeline, DB
schema, or status-payload change.

## Acceptance

Serve tests (`tests/web-serve.test.ts`, HTTP seam): the detail envelope
(item deep-equals the status snapshot's item; complete artifact list;
`spec.content` equals the on-disk file; `source.path` is
`items/<slug>/item.md` with byte-exact content); 404 for unknown/zero/
non-numeric ids; graceful degradation (200 with `content: null` +
`"file unreadable"` when the spec artifact or item file is deleted; queued
items answer `spec: null`, `artifacts: []`); done items carry `prUrl`; **no
lock acquisition** (200 while a fake lock is held, both detail and inbox
artifact reads); the artifact route serves `inbox/` byte-exact while the full
containment matrix (traversal, absolute, outside-root, non-allowed prefixes,
symlink file, symlinked dir escaping the root, symlinked dir pointing inside
the root → the new realpath-allowlist rejection) still holds; the API Host
guard covers the new route; the status snapshot gains no detail fields and
the fingerprint is unchanged.

Page tests (`tests/web-page-runtime.test.ts`, DOM-stub seam): clicking a
flight row / parked card / glance chip / inbox row opens the overlay with
the right item (exactly one fetch); action-button, control, and summary
clicks never do; inbox mode fetches via the artifact route and renders the
file; Esc, backdrop, and close-button dismissals each return focus to the
opener; a click inside the panel keeps it open; a live SSE re-render while
open leaves the overlay untouched; the error path shows a retry that re-issues
exactly one fetch; hostile markdown fixtures (script tags in
headings/lists/paragraphs, `javascript:`/`data:` links, tags inside fences)
render inert while good links, bold/italic/code, and every block shape render
correctly — all asserted via `#item-overlay`'s innerHTML, never by importing
the renderer.
