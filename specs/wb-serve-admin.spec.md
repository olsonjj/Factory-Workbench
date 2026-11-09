# Spec: web UI — `/admin` tabbed read-only SQLite browser

Status: WIP iteration (learning-as-we-go). `specs/wb-serve.spec.md` is the
governing contract and is updated in lockstep in the same commit (route
table, Page section gear link, Tests section); this file is the working
spec for this change.

Working title: **wb serve admin shell + SQLite observation tab**

## Problem

The web workbench answers "what is the factory waiting on me for?" but it is
opaque about the raw state under it. When something looks wrong — an item
stuck between stages, a repo lock that should have been released, a history
row that contradicts the parking lot — the operator's only option is a
second tool (Terminal + `sqlite3`, DB Browser, TablePlus) pointed at
`factory/factory.db` while `wb run` may be writing to it. That is context
switching for one-off debugging, and it risks lock contention with the live
line. The schema itself was built for this: `src/db.ts` documents it as
"intentionally dashable/readable by a future web UI: flat item columns,
append-only history and artifact tables". The web UI just hadn't caught up.

## Solution

A gear icon (⚙) in the dashboard header links to a new `/admin` page on the
same serve surface. `/admin` is a tabbed admin shell (more admin tools will
be added over time); tab 1 is a read-only SQLite browser over the four
tables: `items`, `history`, `artifacts`, `repo_locks`.

The admin page is observation only: it never acquires the factory lock,
never writes, and renders a visible "observation only" banner so the
invariant is documented in the UI, not just the code.

## 0. Grounded context (verified against the checkout at spec time)

- The serve seam is `createServeApp(deps)` in `src/web/server.ts` (returns
  `{handler, flush, stop}`). It already holds the read-only observation
  handle as `deps.db: FactoryDb` (comment "wb serve never writes through
  it"), and `runServe` constructs it via `FactoryDb.openReadonly(root)`.
- The dashboard page is one self-contained TS string constant `PAGE_HTML` in
  `src/web/page.ts` (rationale in its header comment: tsconfig emits `dist/`
  with no asset-copy step, so a sibling HTML file would be unreadable; the
  inner script uses string concatenation, never template literals, because
  it lives inside a TS literal). `esc()` is defined inside the page script.
- The dashboard header markup is static in `PAGE_HTML`: a `<header>`
  containing `<div class="ml-auto flex items-center gap-2">` with
  `<span id="feed-status">` and `<button id="btn-run">`.
- Every response carries the strict CSP `SERVE_CSP` (`src/web/server.ts`,
  set in `handler()` before routing), and every `/api/*` request passes
  `checkApiRequest()` (Host allowlist + bound-port match + Origin match)
  before routing; `GET /` is served without the API guard because it is
  static markup. `GET /admin` gets the same treatment as `GET /`.
- The schema (`src/db.ts` `migrate()`, documented as "intentionally
  dashable/readable by a future web UI"):
  - `items` — id, slug, title, repo, base, approvals (JSON TEXT), stage,
    status, parked_reason, parked_detail (JSON TEXT), feedback, answers
    (JSON TEXT), source_file, branch_name, gate_attempts (JSON TEXT),
    infra_attempts, created_at, updated_at
  - `history` — id, item_id, ts, event, stage, detail (JSON TEXT);
    append-only, unbounded; index `idx_history_item`
  - `artifacts` — id, item_id, stage, name, path, created_at; index
    `idx_artifacts_item`
  - `repo_locks` — repo (PK), item_id, acquired_at
- All SQL in `src/db.ts` routes through the cached `this.stmt()` (statement
  Map, prepared once per connection). New read queries must follow this.
- The readonly connection is WAL-backed (journal_mode = WAL is set by every
  writer; readonly handles get `busy_timeout = 5000`), so observation reads
  never block or take the factory lock — the existing discipline proven by
  `wb status` (tests/status-readonly.test.ts) and the 200-with-lock-held
  web tests (tests/web-serve.test.ts).
- Test patterns this change follows: HTTP-seam tests in
  `tests/web-serve.test.ts` (`createHarness()` + `createServeApp` + real
  `http.Server` + `fetch`, `intervalMs: 0`, `runMode: "await"`,
  `SilentProceed` baseCheck); static-marker greps on page constants;
  V8-context runtime tests in `tests/web-page-runtime.test.ts` (extracts
  the inline `<script>` from a page constant with `pageScript(html)` and
  drives it with a DOM stub).
- Spec-lockstep convention (`.pr_agent.toml`, `specs/wb-serve.spec.md`
  header): spec-governed behavior changes require a same-commit spec update.

## 1. Files

| Path | Change |
|---|---|
| `specs/wb-serve-admin.spec.md` | **New** — this working spec (the contract, frozen at merge) |
| `specs/wb-serve.spec.md` | **Edit in the same commit** — add the gear link to §Page, the admin routes to the HTTP surface table, and the admin tests to §Tests |
| `src/web/admin-page.ts` | **New** — `export const PAGE_ADMIN_HTML` (self-contained page: shell + tab framework + SQLite tab) |
| `src/web/page.ts` | **Edit** — one-line addition in the static header: the gear anchor next to `#btn-run`. No script changes. |
| `src/db.ts` | **Edit** — new read-only observation queries (allowlist, counts, paged read), all through `stmt()` |
| `src/web/server.ts` | **Edit** — import `PAGE_ADMIN_HTML`; add `GET /admin` and the two `GET /api/admin/*` routes in `handle()`; add the handler functions (read-only, no factory lock) |
| `tests/web-serve.test.ts` | **Edit** — routing + endpoint + invariant tests |
| `tests/web-page-runtime.test.ts` | **Edit** — generalize the page-script extraction to any page constant and add admin-shell runtime tests (the stub gains a minimal `location`/`history.replaceState`) |

No new npm dependencies. No CLI changes (`src/cli/index.ts` untouched —
`wb serve` already wires everything).

## 2. DB layer additions (`src/db.ts`)

### 2.1 Allowlist + column model

`ADMIN_TABLES = ["items", "history", "artifacts", "repo_locks"]` (a closed
`as const` union, `AdminTableName`), plus
`ADMIN_TABLE_COLUMNS: Record<AdminTableName, string[]>` — fixed columns per
table, kept beside the schema in `migrate()`. Tests assert these match
`PRAGMA table_info` so schema drift cannot silently desync.

The four names are the only strings that ever reach SQL. The server rejects
anything else with 404; the DB layer treats `AdminTableName` as a closed
type and switches over it (each branch uses its own cached SQL string), so
the table name is never interpolated from user input.

### 2.2 Counts

`countAdminTable(name: AdminTableName): number` —
`SELECT COUNT(*) AS n FROM <name>` through `stmt()`. The counts endpoint
calls it four times (four cached statements); this is admin-frequency,
human-paced, not a hot path.

### 2.3 Paged read (bound in SQL, keyset-paginated)

`adminTablePage(name, opts: { after: number | string | null; limit: number;
filter?: AdminTableFilter })` returns
`{ columns: string[]; rows: Record<string, unknown>[]; nextAfter: number |
string | null }`.

- Ordering is always `ORDER BY id DESC` (newest-first; `repo_locks` has no
  id — see below).
- The bound is enforced in the query itself: the statement carries
  `LIMIT ?` and the DB layer executes with `limit + 1`, returning only
  `limit` rows. `nextAfter` is the keyset cursor for the next page when the
  extra row existed, else `null` — so a page fetch is one query and
  exhaustion is detectable without a second round-trip. **Never post-fetch
  slicing** of a whole-table read (same discipline as
  `getRecentHistorySince`, `src/db.ts`).
- Keyset cursor: `after === null` → page 1; otherwise `WHERE id < ?`. No
  offset, no `OFFSET` SQL, no count-then-slice. This keeps the unbounded
  `history` table O(page size) per fetch, riding the PK index; the `item:`
  trace filter on `history`/`artifacts` rides `idx_history_item`/
  `idx_artifacts_item`.
- Filter (`filter` already normalized by the server, see §3):
  - `id` → `AND id = ?` (on `items`, the row id IS the item id)
  - `range` → `AND id BETWEEN ? AND ?`
  - `item` → for `history` and `artifacts`: `AND item_id = ?`; for `items`
    and `repo_locks`: the server coerces to an id filter (their row
    identity *is* the item linkage — `repo_locks`, having no id column,
    narrows `item_id`).
- **`repo_locks` paging:** it has no `id` column. Anchor the cursor on its
  real key: order is `ORDER BY repo ASC`, cursor `WHERE repo > ?`,
  `nextAfter` is the last repo name (string). The endpoint schema therefore
  allows `after`/`nextAfter` to be a string for `repo_locks`. (This is the
  one intentional asymmetry; the URL contract `after=<cursor>` is unchanged
  and opaque to the client.)
- Rows are returned **raw** (better-sqlite3's snake_case column objects;
  JSON TEXT columns come back exactly as stored). The server does not parse
  or transform values — the admin view's purpose is to show the raw store,
  and parsing is the client's concern.

No write path of any kind is added to `FactoryDb` for this feature.

## 3. HTTP surface (`src/web/server.ts`)

| Method/Path | Result |
|---|---|
| `GET /admin` | 200 `text/html; charset=utf-8` — `PAGE_ADMIN_HTML` (served like `GET /`: no API guard, CSP applies; set via `handler()`'s existing `setHeader`) |
| `GET /api/admin/tables` | 200 `{tables: [{name, count, columns}, ...]}` — fixed order `items, history, artifacts, repo_locks` |
| `GET /api/admin/table/<name>?after=<cursor>&limit=<n>&filter=<expr>` | 200 `{name, columns, rows, nextAfter: number \| string \| null}` / 404 unknown or non-allowlisted name / 400 bad `limit`, `after`, or `filter` |

- Both admin API routes sit under `/api/*`, so `checkApiRequest()` guards
  them automatically — no new hardening code.
- Routing is one regex case in `handle()`:
  `/^\/api\/admin\/table\/([a-z_]+)$/`; table names not exactly in
  `ADMIN_TABLES` → 404 `{ error: "unknown admin table" }`.
  `GET /admin/<anything>` falls to the existing 404. **There are no
  POST/PUT/DELETE admin routes** — any non-GET on `/api/admin/*` falls
  through to the generic 404; a test asserts this.
- Validation (all server-side, before any query):
  - `limit`: integer 1–200 (default 50); anything else → 400
    `{ error: "limit must be an integer between 1 and 200" }`.
  - `after`: integer ≥ 0 for id-keyed tables (absent/empty → page 1); for
    `repo_locks`, any non-empty string is the repo-name cursor. Non-integer
    `after` on id-keyed tables → 400.
  - `filter`: absent/empty → no filter; else parsed by grammar `^(item:)?\d+$`
    / `^\d+-\d+$` (range, lo ≤ hi enforced — `7-3` → 400); any other text →
    400 `{ error: "filter must be <id>, <lo>-<hi>, or item:<id>" }`.
- **Observation discipline (the core invariant):** the two handlers read
  only through `deps.db` (the readonly handle the app already holds). They
  never call `acquireFactoryLock`, never construct a `FactoryDb` (no
  `withLockedDb`, no `runAction`), never use the orchestrator, and perform
  zero writes. This is byte-for-byte the same discipline as
  `/api/status`, `/api/events`, and `GET /api/items/:id`. WAL means these
  reads run lock-free while `wb run` holds the factory lock and writes.
- The status snapshot, `statusFingerprint`, and the SSE payload are
  untouched by this change (admin data is fetched on demand by the admin
  page only; the admin page holds no SSE connection — see §4.3).

## 4. Page `PAGE_ADMIN_HTML` (`src/web/admin-page.ts`)

Follows `PAGE_HTML`'s established conventions exactly (they are hard
constraints, not style):

- One exported TS string constant; reason documented in the file's header
  comment (no asset-copy step on `tsc` builds — the rationale paragraph
  from `src/web/page.ts`'s header).
- Inline `<style>` + inline `<script>`; no remote code of any kind; the
  inner script uses **string concatenation, not template literals** (it
  lives inside a TS literal).
- Every value rendered from the DB goes through the page's local `esc()`
  helper (a copy — there is no shared bundle; there are no trusted DB
  values). Every cell, count label, and filter echo is escaped at the
  interpolation site or assigned via `textContent`.

### 4.1 Shell

- Minimal document: `<title>wb — admin</title>`, a small header row
  (`wb — admin` wordmark), an **"Observation only — this page never
  acquires the factory lock and never writes."** banner rendered in a
  visible, statically present element (static-marker tested), and a link
  back (`← workbench` → `/`).
- Tab framework: `var TABS = [ {id, label, render} ]` — tab 1 is
  `{id: "sqlite", label: "SQLite"}`. A tab strip of buttons (one per entry,
  `data-tab` attr, active tab visually marked) plus one content container
  per activation. Switching a tab: updates the URL (`?tab=<id>` via
  `history.replaceState`) and calls the tab's `render(container)`, which
  fetches what it needs on activation. Future tabs (config, locks, logs)
  drop one entry into `TABS` — the framework itself is generic and carries
  no SQLite-specific logic.
- State is deep-linkable and restored on load from `location.search`:
  - `tab=<id>` (default `sqlite`; unknown tab → `sqlite`)
  - SQLite tab state: `table=<name>` (default `items`; unknown → `items`),
    `after=<cursor>` (page cursor, default absent = page 1),
    `filter=<expr>` (default absent).
  - Every state change (table click, next-page click, filter submit, tab
    switch) writes the full parameter set back with
    `history.replaceState` — refresh restores the exact inspection session
    (acceptance check). No `pushState` per fetch, no localStorage.

### 4.2 SQLite tab (tab 1)

- **Table strip:** one line `items (N) · history (N) · artifacts (N) ·
  repo_locks (N)` rendered from `GET /api/admin/tables`; each name is a
  button; the active one is marked. Fetching counts is re-run when the tab
  is activated (so counts stay live) — clicking the already-active table
  name refetches the current page and counts (the refresh affordance; no
  polling timer, no SSE).
- **Rows grid:** the active table's rows in a plain monospace grid/table.
  Columns come from the endpoint's `columns`; every cell is `esc()`'d.
  Columns whose value is a JSON TEXT column — `items.approvals`,
  `items.parked_detail`, `items.gate_attempts`, `items.answers`,
  `history.detail` — render pretty-printed but truncated: `JSON.parse` the
  raw text (on parse failure, show the raw string verbatim, escaped — same
  defensive posture as `parseHistoryDetail`, `src/db.ts`), truncate the
  serialized form to the first 200 chars, and attach a click-to-expand
  toggle (`<button>` "▸/▾") that swaps to the full pretty-printed text and
  back. No `fetch all` control exists anywhere.
- **Pagination:** below the grid, `older →` (next page) shown iff
  `nextAfter !== null`, linking to the same view with `after=<nextAfter>`;
  plus a `← newest` reset to page 1 when a cursor is active. Page fetches
  are exactly one `GET /api/admin/table/...` each; the `nextAfter` returned
  by the server is authoritative.
- **Filter box:** a single text input + Go button above the grid. Its value
  is sent verbatim as `filter=`; the server validates the grammar (§3) and
  a 400 surfaces inline as an escaped error line (never `alert`). The
  applied filter is echoed in the URL (`filter=`) so an inspection session
  resumes with its filter. Typical use: type `7` (row id 7) on
  `history`/`artifacts` to jump to one row, or `item:7` to pull all of
  item 7's rows across pages — ids are the keys that tie all four tables
  together (`history.item_id`, `artifacts.item_id`, `repo_locks.item_id`).
- JSON columns on `history` are the operator's focus (the spec item names
  them), but the mechanism is generic: a per-table constant
  `JSON_COLUMNS: Record<AdminTableName, string[]>` in the page script.

### 4.3 What the admin page deliberately does NOT do

- No `EventSource`, no SSE, no `postJSON`, no polling timer
  (static-marker tested: the string `EventSource` must be absent from
  `PAGE_ADMIN_HTML`). It is quiet inspection; the dashboard remains the
  live surface.
- No form anywhere; the only network verb is a same-origin `fetch` GET.
- No mutation affordance of any kind (there is no endpoint to call).

## 5. Dashboard gear link (`src/web/page.ts`)

In the static header, inside the `<div class="ml-auto flex items-center
gap-2">` group next to `#btn-run`, before the button:

```html
<a id="btn-admin" href="/admin" title="Admin — raw store view (observation only)" ...>⚙</a>
```

Plain anchor, no popover, no JS. Reuse existing utility classes for
sizing/alignment; do not restructure the header. No script change; no new
fetch; the CSP/self-containment greps and Start Processing static markers
must remain green.

## 6. Invariants recap (what the security review will check)

1. Read-only surface by construction: the only admin SQL is
   `SELECT COUNT(*)` and one paged `SELECT`; no INSERT/UPDATE/DELETE exists
   on the admin path; no mutation endpoint; `POST /api/admin/*` → 404.
2. No factory lock: admin reads go through `deps.db` only; a 200 is returned
   while `acquireFactoryLock` is held by another process.
3. No arbitrary SQL: table name from the closed `ADMIN_TABLES` union;
   validated small `limit` in the SQL itself; filter parsed to a typed
   shape before SQL; cursor keys are ints (or the `repo_locks` PK string).
4. XSS: every rendered DB value passes `esc()`/`textContent`; no remote
   code; CSP rides every response unchanged.
5. Status/SSE untouched: `StatusPayload`, `statusFingerprint`,
   `handleEvents`, `flush()` unchanged; no admin data enters the snapshot.

## 7. Tests

### `tests/web-serve.test.ts` (HTTP seam)

- **Routing/static markers:** `PAGE_HTML` contains `id="btn-admin"` and
  `href="/admin"` (gear link present, next-to-`btn-run` marker preserved);
  `GET /admin` → 200 `text/html`, CSP header equal to `SERVE_CSP`,
  self-containment greps (no `http://`, no `https://`, contains `<style>`);
  `PAGE_ADMIN_HTML` contains the observation-only banner text and omits
  `EventSource`; `GET /admin/xyz` → 404; `POST /api/admin/tables` → 404.
- **`/api/admin/tables`:** shape/order (`items, history, artifacts,
  repo_locks`), counts correct against seeded rows (harness
  `insertItem`/`appendHistory`/`addArtifact` + a hand-written row in
  `repo_locks` via a writable `FactoryDb` in the test, not via the app),
  `columns` equal to `PRAGMA table_info` (drift guard asserting
  `ADMIN_TABLE_COLUMNS`), Host/Origin guard applies (foreign Host → 403),
  CSP on the JSON response.
- **`/api/admin/table/:name`:** unknown table → 404; descending id order;
  default/over-cap/non-integer/0 `limit` handling; cursor edges — page 1
  without `after`, continuation via `nextAfter` yields zero gaps and zero
  duplicates across all pages of a seeded history table (assert union of
  pages == seeded set, descending), `nextAfter === null` on the last page,
  `after` equal to the smallest id → empty page; filter matrix — single
  id, valid range, `lo > hi` → 400, malformed text → 400, `item:<n>`
  filters `item_id` on history/artifacts and coerces to the id on
  items/repo_locks; several-thousand-row history seeds only in one
  bounded-pagination test and every fetch is verified by statement row
  bounds, not by fetching all.
- **Invariants:** all three admin GETs answer 200 while
  `acquireFactoryLock(s.h.root)` is held by the test (no lock acquisition;
  mirror of the existing detail-endpoint test); after the full admin test
  suite's fetches, per-table counts are identical to before (no mutation of
  any table); `deps.db` in the harness is the `openReadonly` handle and no
  test needs a writable handle through the app.

### `tests/web-page-runtime.test.ts` (V8 + DOM stub)

Extends the existing harness (the page-script extraction already takes the
page constant; the stub gains a minimal `location`/`history.replaceState`).
Covers: the tab strip renders and activates the SQLite tab; table strip
renders counts and marks the active table (fetch bodies asserted through
the stub's fetch log, one fetch per activation); rows render escaped — a
hostile fixture (a `detail` value containing `<script>` and `"`/`'`
payload, a slug with markup) appears only escaped in `innerHTML` greps,
raw markup absent; JSON-column truncation + expand toggle round-trip;
filter box submit issues one GET with the expected query string and a 400
renders the escaped inline error; table/cursor/tab clicks call
`history.replaceState` with the full parameter set; refresh simulation
(re-run the script with the populated `location.search`) restores
tab/table/cursor/filter and re-issues the matching fetches.

### Spec-lockstep

Both `specs/wb-serve-admin.spec.md` (this contract, frozen at merge) and
the parent route-table/Page/Tests additions land in the same commit(s) as
the code.

## 8. Out of scope

- Mutation, config editing, lock release, log tails — future tabs; only the
  framework and the SQLite tab land.
- Auth, non-localhost binding changes, any `SERVE_CSP` change.
- Changes to `wb status`/`wb watch` CLI, the SSE payload, or the composer.

## 9. Acceptance-check → mechanism mapping

| Check | Mechanism |
|---|---|
| Gear opens `/admin`; counts strip live | Static anchor + `/api/admin/tables` fetch on tab activation |
| Works while `wb run` is in flight, no lock | readonly `deps.db` reads; WAL reader/writer concurrency; lock-held 200 test |
| `history` pages smoothly, never fetch-all | SQL `LIMIT ?` (+1 exhaustion probe) with keyset `id < cursor` on the PK |
| id filter finds one item's rows across tables | `filter=` grammar incl. `item:<n>` keyed on `item_id` / `id` |
| Refresh restores session | query-param state + `history.replaceState` |
| No mutation possible | closed allowlist, SELECT-only DB methods, GET-only routes, counts-unchanged test |
