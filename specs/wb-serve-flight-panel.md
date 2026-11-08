# Spec: web UI — flow-order pulse tiles + in-flight panel

Status: WIP iteration (learning-as-we-go). Do **not** edit `specs/wb-serve.spec.md`;
this file is the working spec for this change.

## Problem

Two operator findings from using the dashboard (`wb serve`):

1. **Tile order fights the pipeline.** The top row reads
   `waiting on you | in flight | inbox | landed` — attention-first, but the eye
   walks left-to-right while the lifecycle runs right-to-left. Mixing the two
   metaphors feels wrong. The lifecycle fact is: items are written into the
   inbox, get claimed/queued, run (occasionally exiting to "waiting on you" at
   gates, then returning), and land.
2. **"In flight" is a black box.** The tile shows only a count
   (`running + queued`); the only window into *what* is happening is the live
   feed's narrative. There is no at-a-glance state view of the stages
   (triage · spec · implement · test · review · pr) with the ticket names
   rolling through them.
3. **The landed tile is a monotonic counter wearing an attention tile's
   clothes.** 25 today, only grows. A tile whose job is "there is work for you
   here" loses meaning as a lifetime total.

## Decisions

### D1 — Top row: three tiles, flow order

New order and set:

    inbox → in flight → waiting on you

- Drop the landed tile from the pulse row entirely.
- Landed continues to be surfaced where it belongs: the proportional flow bar's
  `done` segment (unchanged) and the "Factory at a glance" section (unchanged).
- Accent colors stay attached to their tiles (inbox stone, in-flight blue,
  waiting-on-you amber), i.e. keep each tile's existing accent, just reordered
  and reduced.

### D2 — In-flight detail panel

A collapsible panel **directly below the flow bar, above the composer** —
immediately under the pulse band it details, before the page's action areas.

- **Header:** `In flight · 2 running · 1 queued` style summary (counts live).
- **Rows** — one per non-actionable-blocked item, i.e. every item with status
  `queued` or `running`, from the existing snapshot `items` (no backend/snapshot
  changes; everything needed is already in `StatusPayload`):
  - ticket/spec **title** and **repo**,
  - a **stage-progress track** (six dots for triage · spec · implement · test ·
    review · pr) — reuse the existing per-item stage-dot pattern the parking
    lot cards already render,
  - a **stage label**: the running item's current stage, or `queued` for queued
    items (their dots all hollow).
- Rows update live over SSE (they are just part of the status-driven render;
  no separate event channel).
- **Click-to-filter the feed by stage/tile is deferred** — not in this change.

### D3 — Collapse defaults and sticky user choice

Follow the existing glance-section collapse pattern (module-level render state,
shared click path with keyboard access, class-synced to rendered markup in
tests):

- **Default (no explicit user choice):** open when `running + queued > 0`,
  closed when 0. An empty open panel is a wasted void; a busy factory with the
  panel closed hides the most important thing on the page.
- **Explicit user choice wins.** Toggling persists a preference in
  `localStorage` (UI-only; no server state, no new seam). Once the user has
  chosen, the default no longer applies.
- **No auto-open against the user's choice:** a new item entering flight does
  not force the panel open; it bumps the collapsed header counts (which the
  existing re-render already covers). New arrivals highlight nothing.
- If the panel is open while empty (user opened it), render an explicit idle
  line (e.g. `factory idle — <n> landed`), never blank space.

## Guardrails

- One file for UI behavior: `src/web/page.ts` (existing single-static-asset,
  no-build-step, no-new-npm-deps constraints). Backend untouched.
- Do not change the feed, the flow bar semantics, the composer, the glance
  section, or `StatusPayload`.
- Tests: extend `tests/web-page-runtime.test.ts` in its existing style (markup
  + simulated status payloads through the runtime harness; classList synced
  from markup so assertions can't pass vacuously). Cover: tile order/set, panel
  default open/closed by payload shape, localStorage choice persistence and
  precedence, row content incl. stage dots for queued vs running, idle line,
  and toggle accessibility (keyboard path).

## Acceptance

- DOM tile order is `inbox, in flight, waiting on you`; no landed tile in the
  pulse row.
- With running/queued items present, the open panel lists one row each with
  correct title/repo/stage dots/stage label and updates across SSE snapshots.
- Fresh page with no stored choice and an idle factory: panel closed.
  Fresh page with items in flight: panel open.
- After an explicit toggle, that state survives reload (localStorage) and
  beats the default in all payload shapes.
- All existing tests still pass; new tests follow the harness pattern above.
