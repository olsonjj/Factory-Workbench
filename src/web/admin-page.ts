/**
 * `PAGE_ADMIN_HTML` — the single self-contained page served at `GET /admin`.
 *
 * Why a TS string constant and not `src/web/admin.html`: tsconfig compiles
 * only the `src` tree into `dist/` with no asset copy step, so a sibling HTML
 * file would be unreadable from `dist/cli/index.js` (the bin target). The
 * string travels with the bundle under both tsx and tsc with zero build
 * changes — the same hard constraint `PAGE_HTML` documents (wb-serve
 * implementation spec §6.5; specs/wb-serve-admin.spec.md §4).
 *
 * Content: a tabbed admin shell whose first tab is a read-only SQLite
 * browser over the four store tables. Like the dashboard, the page loads no
 * remote code (server.ts additionally emits a strict CSP on every response)
 * and its inner script deliberately uses string concatenation, never template
 * literals, so nothing inside needs escaping from the surrounding TS literal.
 *
 * OBSERVATION ONLY — the invariant stated in the visible banner: this page
 * never acquires the factory lock, never writes, and holds no SSE/polling
 * connection. Its only network verbs are same-origin `fetch` GETs against the
 * read-only `/api/admin/*` endpoints; there is no mutation endpoint to call
 * (no `EventSource`, no `postJSON`, no form POST anywhere in this page).
 *
 * XSS discipline (KB 2026-10-27 22:00 — the browser is an interpreter): every
 * value rendered from the DB goes through this page's local `esc()` helper
 * at the interpolation site or is assigned via `textContent`. There are no
 * trusted DB values — every cell, count label, and filter echo is escaped
 * (the store's contents are exactly the hostile-input surface here).
 *
 * Deep links: the whole inspection session lives in `location.search`
 * (`?tab=<id>&table=<name>&after=<cursor>&filter=<expr>`) and every state
 * change writes the full parameter set back via `history.replaceState` — no
 * pushState, no localStorage — so a refresh restores the exact session
 * (specs/wb-serve-admin.spec.md §4.1).
 */

export const PAGE_ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wb — admin</title>
<style>
/* Self-contained stylesheet — no CDN script, no remote CSS (same rule as
 * the dashboard page: a remote resource on a localhost control surface runs
 * same-origin and is invisible to the Host/Origin CSRF guards). Minimal
 * preflight + the pieces this page needs, in the dashboard's paper/ink
 * palette. */
*, *::before, *::after { box-sizing: border-box; border: 0 solid #e5e7eb; margin: 0; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; line-height: 1.5; }
h1, h2, h3, h4, h5, h6, p { font-size: inherit; font-weight: inherit; }
button, input { font: inherit; color: inherit; }
button { background-color: transparent; cursor: pointer; }
a { color: inherit; text-decoration: inherit; }
input::placeholder { color: #a8a29e; opacity: 1; }

body { background: #fafaf9; color: #1c1917; }
header.adm { border-bottom: 1px solid #e5e7eb; background: rgba(255,255,255,.85); padding: 12px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; position: sticky; top: 0; z-index: 20; }
.adm-wordmark { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; font-size: 18px; letter-spacing: -.02em; }
.adm-wordmark .dim { color: #a8a29e; }
.adm-back { font-size: 13px; color: #57534e; }
.adm-back:hover { color: #1c1917; text-decoration: underline; }

/* The observation-only banner: the invariant is documented in the UI, not
 * just the code. Statically present so tests can grep for it. */
.adm-banner { background: #fffbeb; border-bottom: 1px solid #fcd34d; color: #92400e; font-size: 13px; padding: 8px 20px; }

main { max-width: 1100px; margin: 0 auto; padding: 16px 16px 96px; }

/* Tab strip */
.adm-tabs { display: flex; gap: 6px; border-bottom: 1px solid #e5e7eb; margin-bottom: 16px; }
.tab-btn { font-size: 13px; font-weight: 500; padding: 8px 14px; border-bottom: 2px solid transparent; color: #57534e; }
.tab-btn:hover { color: #1c1917; }
.tab-btn.tab-active { color: #1c1917; border-bottom-color: #1c1917; }

/* SQLite tab */
.tablestrip { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 12px; font-size: 13px; color: #78716c; }
.tbl-btn { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 1px solid transparent; color: #44403c; }
.tbl-btn:hover { background: #f5f5f4; }
.tbl-btn.tbl-active { background: #1c1917; color: #fff; }
.tbl-sep { color: #d6d3d1; }

.filterrow { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.finput { border: 1px solid #d6d3d1; border-radius: 6px; padding: 6px 10px; font-size: 13px; background: #fff; width: 320px; max-width: 100%; }
.finput:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.35); }
.btn { border-radius: 6px; font-weight: 500; font-size: 13px; padding: 6px 12px; border: 1px solid transparent; }
.btn-out { background: #fff; border-color: #d6d3d1; }
.btn-out:hover { background: #f5f5f4; }
.errline { color: #dc2626; font-size: 13px; min-height: 0; margin-bottom: 8px; white-space: pre-wrap; }

.gridwrap { overflow-x: auto; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
table.grid { border-collapse: collapse; width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
table.grid th, table.grid td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f5f5f4; vertical-align: top; white-space: nowrap; max-width: 420px; }
table.grid th { position: sticky; top: 0; background: #fafaf9; color: #57534e; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
table.grid tbody tr:last-child td { border-bottom: 0; }
/* JSON cells: pre-wrap keeps the pretty-printed shape; the toggle button
 * swaps between the truncated and the full text. */
.jval { white-space: pre-wrap; display: inline-block; vertical-align: top; }
.jx { font-size: 11px; color: #6366f1; padding: 0 4px; }
.jx:hover { text-decoration: underline; }

.pager { display: flex; gap: 10px; margin-top: 10px; font-size: 13px; }
.pg-btn { color: #4f46e5; padding: 4px 8px; border-radius: 6px; }
.pg-btn:hover { background: #eef2ff; }
.loading { color: #a8a29e; font-size: 13px; padding: 12px 0; }
</style>
</head>
<body>

<header class="adm">
  <div class="adm-wordmark"><span>wb</span><span class="dim"> — admin</span></div>
  <div class="adm-back"><a href="/">&larr; workbench</a></div>
</header>

<div class="adm-banner" id="admin-banner">Observation only — this page never acquires the factory lock and never writes.</div>

<main>
  <nav class="adm-tabs" id="admin-tabs"></nav>
  <div id="tab-content"></div>
</main>

<script>
/* ================= shell ================= */

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* Minimal location.search parser (no URLSearchParams dependency): returns a
 * plain object of decoded key -> decoded value (last write wins, which is
 * fine for this page's single-valued keys). */
function readSearch() {
  var out = {};
  var s = String(location.search || '');
  if (s.charAt(0) === '?') s = s.slice(1);
  var parts = s.split('&');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var eq = parts[i].indexOf('=');
    var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
    var v = eq < 0 ? '' : parts[i].slice(eq + 1);
    k = decodeURIComponent(k.replace(/\\+/g, ' '));
    v = decodeURIComponent(v.replace(/\\+/g, ' '));
    out[k] = v;
  }
  return out;
}

/* Deep-linkable state. The tab belongs to the shell; the rest is the SQLite
 * tab's own state (table, keyset cursor, filter expression). Every state
 * change rewrites the full parameter set, so refresh restores the session. */
var state = { tab: 'sqlite' };
var sqlState = { table: 'items', after: null, filter: '', page: null, cells: null };

function adminQuery() {
  var q = '?tab=' + encodeURIComponent(state.tab);
  if (state.tab === 'sqlite') {
    q += '&table=' + encodeURIComponent(sqlState.table);
    if (sqlState.after !== null && sqlState.after !== undefined) q += '&after=' + encodeURIComponent(String(sqlState.after));
    if (sqlState.filter) q += '&filter=' + encodeURIComponent(sqlState.filter);
  }
  return q;
}

function writeParams() {
  history.replaceState(null, '', '/admin' + adminQuery());
}

/* ================= tab framework =================
 * Future admin tools (config, locks, logs, ...) drop one entry into TABS;
 * the framework itself carries no SQLite-specific logic. Each tab's render
 * function builds into the (emptied) content container and fetches what it
 * needs on activation. */

var TABS = [
  { id: 'sqlite', label: 'SQLite', render: renderSqliteTab }
];

function findTab(id) {
  for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
  return null;
}

function renderTabStrip() {
  var h = '';
  for (var i = 0; i < TABS.length; i++) {
    h += '<button type="button" class="tab-btn' + (state.tab === TABS[i].id ? ' tab-active' : '') +
      '" data-tab="' + esc(TABS[i].id) + '">' + esc(TABS[i].label) + '</button>';
  }
  $('admin-tabs').innerHTML = h;
}

function activateTab(tabId) {
  var t = findTab(tabId) || TABS[0];
  state.tab = t.id;
  renderTabStrip();
  writeParams();
  var content = $('tab-content');
  content.innerHTML = '';
  t.render(content);
}

/* ================= SQLite tab ================= */

/* The JSON TEXT columns per table — the cells the operator actually squints
 * at. Generic mechanism, per-table constant. */
var JSON_COLUMNS = {
  items: ['approvals', 'parked_detail', 'gate_attempts', 'answers'],
  history: ['detail'],
  artifacts: [],
  repo_locks: []
};

var ADMIN_TABLE_NAMES = ['items', 'history', 'artifacts', 'repo_locks'];

function renderSqliteTab(container) {
  container.innerHTML =
    '<div id="admin-tables" class="tablestrip"><span class="loading">loading tables…</span></div>' +
    '<div class="filterrow">' +
      '<input id="admin-filter" class="finput" placeholder="filter: 7 (row id) · 3-9 (id range) · item:7 (all rows of item 7)">' +
      '<button type="button" class="btn btn-out" data-act="filter">Go</button>' +
    '</div>' +
    '<div id="admin-error" class="errline"></div>' +
    '<div id="admin-grid" class="gridwrap"><div class="loading" id="admin-loading">loading rows…</div></div>' +
    '<div id="admin-pager" class="pager"></div>';
  // The applied filter is echoed into the box via the value property (never
  // re-parsed from markup) so a restored session shows its filter.
  $('admin-filter').value = sqlState.filter;
  fetchCounts();
  fetchPage();
}

function fetchCounts() {
  fetch('/api/admin/tables').then(function (r) { return r.json(); }).then(function (j) {
    lastTables = j && j.tables ? j.tables : [];
    renderCounts();
  }).catch(function () {
    $('admin-tables').innerHTML = '<span class="errline">table counts unavailable</span>';
  });
}

/* The last /api/admin/tables response — re-rendering the strip (e.g. to
 * re-mark the active table on a table click) needs no new fetch. */
var lastTables = [];

function renderCounts() {
  var counts = {};
  for (var i = 0; i < lastTables.length; i++) counts[lastTables[i].name] = lastTables[i].count;
  var h = '';
  for (var n = 0; n < ADMIN_TABLE_NAMES.length; n++) {
    var name = ADMIN_TABLE_NAMES[n];
    var count = counts[name];
    if (n > 0) h += ' <span class="tbl-sep">&middot;</span> ';
    h += '<button type="button" class="tbl-btn' + (sqlState.table === name ? ' tbl-active' : '') +
      '" data-table="' + esc(name) + '">' + esc(name) + ' (' + esc(count === undefined ? '?' : count) + ')</button>';
  }
  $('admin-tables').innerHTML = h;
}

/* One page fetch = exactly one GET. The server's nextAfter is authoritative:
 * the pager only offers "older" when it is non-null. */
function pageQuery() {
  var q = '/api/admin/table/' + encodeURIComponent(sqlState.table) + '?limit=50';
  if (sqlState.after !== null && sqlState.after !== undefined) q += '&after=' + encodeURIComponent(String(sqlState.after));
  if (sqlState.filter) q += '&filter=' + encodeURIComponent(sqlState.filter);
  return q;
}

function fetchPage() {
  var grid = $('admin-grid');
  grid.innerHTML = '<div class="loading">loading rows…</div>';
  $('admin-pager').innerHTML = '';
  fetch(pageQuery()).then(function (r) {
    return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
  }).then(function (res) {
    if (!res.ok) {
      showAdminError(res.body && res.body.error ? res.body.error : 'request failed (' + res.status + ')');
      grid.innerHTML = '';
      return;
    }
    showAdminError('');
    sqlState.page = res.body;
    sqlState.cells = null;
    renderRows();
    renderPager();
  }).catch(function () {
    showAdminError('request failed');
  });
}

function showAdminError(msg) {
  $('admin-error').textContent = msg;
}

/* Cell texts for the JSON columns, computed once per page render; the
 * toggle only flips the expanded flag and re-renders, so the (possibly
 * long) pretty text is never rebuilt per toggle. Parse failure shows the
 * raw string verbatim (escaped) — same defensive posture as the server's
 * parseHistoryDetail. */
function jsonCellTexts(raw) {
  var s = raw === null || raw === undefined ? '' : String(raw);
  var pretty = s;
  try { pretty = JSON.stringify(JSON.parse(s), null, 2); } catch (e) { pretty = s; }
  var short = pretty.length > 200 ? pretty.slice(0, 200) + '…' : pretty;
  return { short: short, full: pretty };
}

function buildCells() {
  var p = sqlState.page;
  var old = sqlState.cells || [];
  var cells = [];
  var jsonCols = JSON_COLUMNS[p.name] || [];
  for (var r = 0; r < p.rows.length; r++) {
    for (var c = 0; c < p.columns.length; c++) {
      var col = p.columns[c];
      if (jsonCols.indexOf(col) < 0) continue;
      var texts = jsonCellTexts(p.rows[r][col]);
      cells.push({ short: texts.short, full: texts.full, expanded: old[cells.length] ? old[cells.length].expanded : false });
    }
  }
  sqlState.cells = cells;
}

function rowsHtml() {
  var p = sqlState.page;
  if (!p || !p.rows || p.rows.length === 0) return '<div class="loading">no rows</div>';
  buildCells();
  var jsonCols = JSON_COLUMNS[p.name] || [];
  var cellIdx = 0;
  var h = '<table class="grid"><thead><tr>';
  for (var c = 0; c < p.columns.length; c++) h += '<th>' + esc(p.columns[c]) + '</th>';
  h += '</tr></thead><tbody>';
  for (var r = 0; r < p.rows.length; r++) {
    h += '<tr>';
    for (var i = 0; i < p.columns.length; i++) {
      var col = p.columns[i];
      h += '<td>';
      if (jsonCols.indexOf(col) >= 0) {
        var cell = sqlState.cells[cellIdx];
        cellIdx += 1;
        var shown = cell.expanded ? cell.full : cell.short;
        h += '<span class="jval">' + esc(shown) + '</span>';
        if (cell.short !== cell.full) {
          h += ' <button type="button" class="jx" data-jx="' + (cellIdx - 1) + '" title="' +
            (cell.expanded ? 'collapse' : 'expand') + '">' + (cell.expanded ? '▾' : '▸') + '</button>';
        }
      } else {
        var v = p.rows[r][col];
        h += esc(v === null || v === undefined ? '' : String(v));
      }
      h += '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return h;
}

function renderRows() {
  $('admin-grid').innerHTML = rowsHtml();
}

function renderPager() {
  var p = sqlState.page;
  if (!p) { $('admin-pager').innerHTML = ''; return; }
  var h = '';
  if (sqlState.after !== null && sqlState.after !== undefined) {
    h += '<button type="button" class="pg-btn" data-page="newest">&larr; newest</button>';
  }
  if (p.nextAfter !== null && p.nextAfter !== undefined) {
    h += '<button type="button" class="pg-btn" data-page="older">older &rarr;</button>';
  }
  $('admin-pager').innerHTML = h;
}

function selectTable(name) {
  if (findAdminTableName(name) === null) return;
  sqlState.table = name;
  sqlState.after = null; // cursors are table-specific; the filter travels
  writeParams();
  renderCounts(); // re-mark the active table immediately
  fetchCounts();
  fetchPage();
}

function findAdminTableName(name) {
  for (var i = 0; i < ADMIN_TABLE_NAMES.length; i++) if (ADMIN_TABLE_NAMES[i] === name) return name;
  return null;
}

function olderPage() {
  if (!sqlState.page || sqlState.page.nextAfter === null || sqlState.page.nextAfter === undefined) return;
  sqlState.after = sqlState.page.nextAfter;
  writeParams();
  fetchPage();
}

function newestPage() {
  sqlState.after = null;
  writeParams();
  fetchPage();
}

function applyFilter() {
  var input = $('admin-filter');
  var raw = input ? String(input.value || '') : '';
  sqlState.filter = raw.trim();
  sqlState.after = null;
  writeParams();
  fetchPage();
}

/* ================= delegated events =================
 * One click + one keydown listener on the permanent #tab-content container
 * (it survives every innerHTML rebuild), dispatching on data attributes.
 * The tab strip has its own container-level listener. */

$('admin-tabs').addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t || !t.getAttribute) return;
  var tab = t.getAttribute('data-tab');
  if (tab) activateTab(tab);
});

$('tab-content').addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t || !t.getAttribute) return;
  var tbl = t.getAttribute('data-table');
  if (tbl) { selectTable(tbl); return; }
  var pg = t.getAttribute('data-page');
  if (pg === 'older') { olderPage(); return; }
  if (pg === 'newest') { newestPage(); return; }
  var act = t.getAttribute('data-act');
  if (act === 'filter') { applyFilter(); return; }
  var jx = t.getAttribute('data-jx');
  if (jx !== null && jx !== undefined && sqlState.cells) {
    var idx = Number(jx);
    if (sqlState.cells[idx]) {
      sqlState.cells[idx].expanded = !sqlState.cells[idx].expanded;
      renderRows();
    }
  }
});

$('tab-content').addEventListener('keydown', function (ev) {
  if (!ev || ev.key !== 'Enter') return;
  var t = ev.target;
  if (!t || !t.getAttribute) return;
  if (t.getAttribute('id') === 'admin-filter') applyFilter();
});

/* ================= boot =================
 * Restore the session from the URL (unknown values fall back to defaults),
 * then activate — activation rewrites the normalized parameter set, so even
 * the first visit gets a shareable deep link. */
(function boot() {
  var p = readSearch();
  state.tab = findTab(p.tab) ? p.tab : 'sqlite';
  if (p.table && findAdminTableName(p.table)) sqlState.table = p.table;
  if (p.after) sqlState.after = p.after;
  if (p.filter) sqlState.filter = p.filter;
  activateTab(state.tab);
})();
</script>
</body>
</html>
`;
