/**
 * `PAGE_HTML` — the single self-contained page served at `GET /`.
 *
 * Why a TS string constant and not `src/web/index.html`: tsconfig compiles
 * only the `src` tree into `dist/` with no asset copy step, so a sibling HTML
 * file would be unreadable from `dist/cli/index.js` (the bin target). The
 * string travels with the bundle under both tsx and tsc with zero build
 * changes (wb-serve implementation spec §6.5 — hard constraint).
 *
 * Content: vanilla JS + Tailwind via CDN, exactly as the throwaway prototype
 * (branch prototype/wb-serve-design, variant C "Decision desk") did. The
 * inner script deliberately uses string concatenation, never template
 * literals, so nothing inside needs escaping from the surrounding TS literal.
 *
 * XSS discipline (KB 2026-10-27 22:00 — the browser is an interpreter):
 * every untrusted string (titles, feedback, questions, reasons, artifact
 * names, repo paths, slugs from the stream) goes through `esc()` at the
 * interpolation site or is assigned via `textContent`; `innerHTML` receives
 * only escaped/structural markup. All actions are same-origin fetch POSTs
 * with `Content-Type: application/json`; no CORS headers are emitted.
 */

export const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wb — factory workbench</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'] },
        colors: {
          paper: '#fafaf9',
          ink: { 950: '#1c1917', 900: '#292524', 800: '#44403c', 700: '#57534e', 500: '#78716c', 400: '#a8a29e', 300: '#d6d3d1', 200: '#e7e5e4', 100: '#f5f5f4' },
        },
      },
    },
  };
</script>
<style>
  .lbl { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #57534e; margin-bottom: 4px; }
  .finput { width: 100%; border: 1px solid #d6d3d1; border-radius: 6px; padding: 8px 10px; font-size: 13px; background: #fff; }
  .finput:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.35); }
  .ferr { color: #dc2626; font-size: 11px; margin-top: 3px; min-height: 0; }
  .btn { border-radius: 6px; font-weight: 500; font-size: 13px; padding: 6px 12px; border: 1px solid transparent; cursor: pointer; }
  .btn-dark { background: #1c1917; color: #fff; }
  .btn-dark:hover { background: #292524; }
  .btn-out { background: #fff; border-color: #d6d3d1; }
  .btn-out:hover { background: #f5f5f4; }
  .btn-ok { background: #059669; color: #fff; }
  .btn-ok:hover { background: #047857; }
</style>
</head>
<body class="bg-paper text-ink-900">

<header class="border-b border-ink-200 bg-white/80 backdrop-blur px-5 py-3 flex items-center gap-3 flex-wrap sticky top-0 z-20">
  <div class="font-mono font-bold text-lg tracking-tight"><span class="text-ink-950">wb</span><span class="text-ink-400"> — factory workbench</span></div>
  <div id="lock-banner" class="hidden text-xs rounded-full bg-amber-100 text-amber-800 ring-1 ring-amber-300 px-3 py-1"></div>
  <div class="ml-auto flex items-center gap-2">
    <span id="feed-status" class="text-xs text-ink-400"></span>
    <button id="btn-run" class="btn btn-dark">▶ Run</button>
    <button id="btn-resume" class="btn btn-out">⟳ Resume</button>
  </div>
</header>

<main class="max-w-3xl mx-auto px-4 pb-24">
  <div id="pulse" class="pt-4"></div>

  <div class="mt-5">
    <div class="rounded-2xl border-2 border-dashed border-indigo-300 bg-white shadow-sm overflow-hidden">
      <button id="composer-toggle" class="w-full flex items-center justify-between px-5 py-3 hover:bg-indigo-50/50 transition-colors">
        <span class="flex items-center gap-2">
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-sm font-bold">+</span>
          <span class="font-semibold text-sm">New work item</span>
          <span class="text-xs text-ink-400">— write a spec and drop it in the inbox</span>
        </span>
        <span class="text-ink-400 text-xs font-mono">toggle</span>
      </button>
      <div id="composer-body" class="hidden border-t border-indigo-100 p-5 space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="block col-span-2">
            <div class="lbl">Title <span class="text-red-500">*</span></div>
            <input id="f-title" class="finput" placeholder="Short imperative title, e.g. 'Add retry backoff to webhooks'">
            <div class="ferr" data-err="title"></div>
          </label>
          <label class="block">
            <div class="lbl">Repository <span class="text-red-500">*</span></div>
            <input id="f-repo" class="finput font-mono" list="repos-dl" placeholder="/path/to/target/repo">
            <datalist id="repos-dl"></datalist>
            <div class="ferr" data-err="repo"></div>
          </label>
          <label class="block">
            <div class="lbl">Base branch</div>
            <input id="f-base" class="finput font-mono" value="main">
            <div class="ferr" data-err="base"></div>
          </label>
        </div>
        <div>
          <div class="lbl">Approval gates <span class="normal-case font-normal text-ink-400">— item parks for your sign-off after these stages</span></div>
          <div id="f-approvals" class="flex flex-wrap gap-2 mt-1"></div>
          <div class="ferr" data-err="approvals"></div>
        </div>
        <label class="block">
          <div class="lbl">Description <span class="normal-case font-normal text-ink-400">— markdown, the item's source of truth</span></div>
          <textarea id="f-desc" rows="5" class="finput font-mono leading-relaxed" placeholder="## Goal&#10;What done looks like…"></textarea>
          <div class="ferr" data-err="description"></div>
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input id="f-runnow" type="checkbox" class="accent-indigo-600">
          <span>run now — claim and advance the factory immediately after writing</span>
        </label>
        <div class="flex items-center gap-2">
          <button id="btn-submit" class="btn btn-dark bg-indigo-600 hover:bg-indigo-700">Write to inbox</button>
          <button id="btn-template" class="btn btn-out">Start from template</button>
        </div>
        <div id="composer-error" class="hidden text-xs text-red-700"></div>
        <div id="drop-zone" class="rounded-lg bg-ink-100/70 border border-dashed border-ink-300 p-3 text-center text-xs text-ink-500 cursor-pointer">
          …or drop existing item file(s) here — <span class="font-mono">.md</span> with front-matter goes straight into
          <span class="font-mono">inbox/</span> (bad front-matter parks as malformed, recoverable)
          <input id="file-input" type="file" multiple accept=".md" class="hidden">
        </div>
        <div id="drop-result" class="text-xs"></div>
      </div>
    </div>
  </div>

  <div id="parking-lot" class="mt-8"></div>
  <div id="glance" class="mt-10"></div>

  <div class="mt-10 border-t border-ink-200 pt-6">
    <div class="flex items-baseline justify-between">
      <div class="text-[11px] font-semibold uppercase tracking-widest text-ink-400">Live feed</div>
      <div class="text-[10px] text-ink-400 font-mono">claims · stages · gates · parks · PRs — streamed over SSE</div>
    </div>
    <div id="feed" class="mt-2 rounded-lg border border-ink-200 bg-white p-2 font-mono min-h-[3rem] max-h-72 overflow-y-auto"></div>
  </div>
</main>

<div id="toast" class="hidden fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-ink-950 text-white text-sm px-4 py-2 shadow-lg"></div>

<script>
/* ================= constants (prototype's Decision-desk maps) ================= */

var STAGES = ['triage', 'spec', 'implement', 'test', 'review', 'pr'];
var APPROVAL_STAGES = STAGES.slice(0, STAGES.length - 1); // the five approval-gate stages

var PARK_SKIN = {
  'awaiting-approval':      { band: 'bg-amber-400',    tag: 'bg-amber-100 text-amber-800 border-amber-200',   icon: '⏸', label: 'Your approval' },
  'exhausted-rework':       { band: 'bg-red-500',      tag: 'bg-red-100 text-red-800 border-red-200',         icon: '✕', label: 'Rework exhausted' },
  'needs-human':            { band: 'bg-violet-500',   tag: 'bg-violet-100 text-violet-800 border-violet-200', icon: '?', label: 'Triage questions' },
  'infrastructure-failure': { band: 'bg-orange-500',   tag: 'bg-orange-100 text-orange-800 border-orange-200', icon: '⚡', label: 'Infrastructure failure' },
  'malformed':              { band: 'bg-fuchsia-500',  tag: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200', icon: '✎', label: 'Bad front-matter' },
  'human-rejected':         { band: 'bg-ink-400',     tag: 'bg-ink-100 text-ink-700 border-ink-300',          icon: '↩', label: 'Rejected by you' }
};
var DEFAULT_SKIN = { band: 'bg-ink-300', tag: 'bg-ink-100 text-ink-700 border-ink-300', icon: '•', label: 'Parked' };

var STATUS_DOT = {
  'awaiting-approval': 'bg-amber-400', 'exhausted-rework': 'bg-red-500',
  'infrastructure-failure': 'bg-orange-500', 'needs-human': 'bg-violet-500',
  'human-rejected': 'bg-ink-500', 'malformed': 'bg-fuchsia-500',
  'running': 'bg-blue-500', 'queued': 'bg-stone-400', 'done': 'bg-emerald-500'
};
var STATUS_PILL = {
  'awaiting-approval': 'bg-amber-100 text-amber-700 ring-amber-300', 'exhausted-rework': 'bg-red-100 text-red-700 ring-red-300',
  'infrastructure-failure': 'bg-orange-100 text-orange-700 ring-orange-300', 'needs-human': 'bg-violet-100 text-violet-700 ring-violet-300',
  'human-rejected': 'bg-ink-100 text-ink-700 ring-ink-300', 'malformed': 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-300',
  'running': 'bg-blue-50 text-blue-700 ring-blue-200', 'queued': 'bg-ink-100 text-ink-700 ring-ink-300', 'done': 'bg-emerald-50 text-emerald-700 ring-emerald-200'
};
var STATUS_LABEL = {
  'awaiting-approval': 'awaiting approval', 'exhausted-rework': 'exhausted rework',
  'infrastructure-failure': 'infra failure', 'needs-human': 'needs you',
  'human-rejected': 'rejected by you', 'malformed': 'malformed',
  'running': 'running', 'queued': 'queued', 'done': 'done'
};
var PARK_ORDER = { 'awaiting-approval': 0, 'needs-human': 1, 'exhausted-rework': 2, 'infrastructure-failure': 3, 'malformed': 4, 'human-rejected': 5 };

var FEED_COLOR = {
  claimed: '#2563eb', resurrected: '#2563eb', 'stage-pass': '#059669', 'stage-start': '#78716c',
  parked: '#d97706', 'stage-gate-fail': '#dc2626', 'stage-infra-fail': '#ea580c', 'stage-retry': '#60a5fa',
  'pr-created': '#059669', 'base-stale': '#78716c', unparked: '#059669', answered: '#7c3aed',
  approved: '#059669', 'rejected-by-human': '#dc2626', archived: '#78716c'
};

var FLOW_CLS = { inbox: 'bg-ink-300', queue: 'bg-ink-500', parked: 'bg-amber-400', done: 'bg-emerald-500' };
var FLOW_TEXT = { inbox: 'text-ink-700', queue: 'text-white', parked: 'text-amber-950', done: 'text-white' };

var CURRENT = null;

/* ================= helpers ================= */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtAge(ms) {
  if (ms < 60000) return 'just started';
  return Math.round(ms / 60000) + ' min ago';
}
function fmtClock(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '00:00:00';
  var p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function isParked(it) {
  return !(it.status === 'queued' || it.status === 'running') && !(it.status === 'done' || it.status === 'rejected');
}
function byParkOrder(a, b) {
  var pa = PARK_ORDER[a.status]; var pb = PARK_ORDER[b.status];
  if (pa === undefined) pa = 99; if (pb === undefined) pb = 99;
  return (pa - pb) || (a.id - b.id);
}
function $(id) { return document.getElementById(id); }

var toastTimer = null;
function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600);
}

async function postJSON(url, body) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  var data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, ok: res.ok, data: data };
}

async function refreshStatus() {
  try {
    var res = await fetch('/api/status');
    render(await res.json());
  } catch (e) { /* the SSE stream will repaint */ }
}

function showCardError(card, msg) {
  var err = card.querySelector('.card-error');
  if (err) { err.textContent = msg; err.classList.remove('hidden'); }
}

/* One action wrapper: toasts on success, renders the lock banner on 409,
 * shows the server's reason inline on the card (e.g. "still malformed: …"). */
async function act(url, body, card) {
  var r = await postJSON(url, body);
  if (r.ok) {
    toast('done — ' + url.replace('/api/items/', '').replace('/api/', ''));
    refreshStatus();
    return r;
  }
  var msg = (r.data && r.data.error) ? r.data.error : ('HTTP ' + r.status);
  if (r.status === 409 && r.data && r.data.lock) renderLock(r.data.lock);
  if (card) showCardError(card, msg); else toast(msg);
  return r;
}

/* ================= rendering ================= */

function render(p) {
  CURRENT = p;
  renderPulse(p);
  renderDatalist(p.knownRepos || []);
  renderParking(p);
  renderGlance(p);
  renderLock(p.lock);
}

function tile(accent, big, small, title, sub) {
  return '<div class="rounded-xl border border-ink-200 bg-white shadow-sm p-4 pl-5 relative overflow-hidden">' +
    '<div class="absolute left-0 top-0 bottom-0 w-1 ' + accent + '"></div>' +
    '<div class="text-3xl font-bold tabular-nums leading-none ' + accent.replace('bg-', 'text-') + '">' + big +
    (small ? '<span class="text-sm font-medium text-ink-400"> ' + small + '</span>' : '') + '</div>' +
    '<div class="text-xs font-semibold text-ink-700 mt-1.5">' + esc(title) + '</div>' +
    '<div class="text-[10px] text-ink-400 uppercase tracking-wide">' + esc(sub) + '</div></div>';
}

function renderPulse(p) {
  var c = p.counts;
  var html = '<div class="grid grid-cols-4 gap-3">' +
    tile('bg-amber-400', c.decisions, '', 'waiting on you', 'decisions pending') +
    tile('bg-blue-500', c.running, '+ ' + c.queued, 'in flight', 'running + queued') +
    tile('bg-ink-400', c.inbox, '', 'inbox', 'awaiting claim') +
    tile('bg-emerald-500', c.done, '', 'landed', 'PRs ready for review') +
    '</div>';
  var total = 0;
  (p.flow || []).forEach(function (s) { total += s.n; });
  var bar = '';
  var legend = '';
  if (total === 0) {
    bar = '<div class="mt-3 rounded-full h-6 ring-1 ring-ink-200 bg-white shadow-sm flex items-center justify-center text-[10px] text-ink-400">no work yet — compose or drop an item above</div>';
  } else {
    var segs = '';
    (p.flow || []).forEach(function (s) {
      var w = (s.n / total) * 100;
      var cls = FLOW_CLS[s.label] || 'bg-blue-500';
      var txt = FLOW_TEXT[s.label] || 'text-white';
      var wide = w >= 9;
      segs += '<div class="' + cls + ' flex items-center justify-center" style="width:' + w.toFixed(1) + '%"' +
        ' title="' + esc(s.label) + ': ' + s.n + '">' +
        (wide ? '<span class="' + txt + ' text-[10px] font-mono font-semibold tabular-nums whitespace-nowrap px-1">' + esc(s.label) + ' ' + s.n + '</span>' : '') +
        '</div>';
      if (!wide) {
        legend += '<span class="inline-flex items-center gap-1 text-[10px] text-ink-500">' +
          '<span class="h-2 w-2 rounded-full ' + cls + '"></span>' + esc(s.label) + ' ' + s.n + '</span>';
      }
    });
    bar = '<div class="mt-3 rounded-full overflow-hidden flex h-6 ring-1 ring-ink-200 bg-white shadow-sm">' + segs + '</div>' +
      (legend ? '<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">' + legend + '</div>' : '');
  }
  $('pulse').innerHTML = html + bar;
}

function renderDatalist(knownRepos) {
  var dl = $('repos-dl');
  dl.innerHTML = knownRepos.map(function (k) {
    return '<option value="' + esc(k.repo) + '"></option>';
  }).join('');
}

function stageDots(it) {
  var doneThrough = STAGES.indexOf(it.stage);
  var dot = STATUS_DOT[it.status] || 'bg-ink-300';
  var cls = it.status === 'running' ? 'bg-blue-500 animate-pulse' : dot;
  var out = '<div class="flex items-center gap-0 mt-3">';
  STAGES.forEach(function (st, i) {
    if (i > 0) out += '<div class="h-px flex-1 ' + (i <= doneThrough ? 'bg-ink-400' : 'bg-ink-300') + '"></div>';
    var fill = i < doneThrough ? 'bg-emerald-500' : (i === doneThrough ? cls : 'bg-ink-300');
    out += '<div class="flex flex-col items-center" title="' + esc(st) + '">' +
      '<div class="h-2.5 w-2.5 rounded-full ' + fill + '"></div>' +
      '<span class="text-[9px] uppercase tracking-wide mt-1 ' + (i === doneThrough ? 'text-ink-800 font-semibold' : 'text-ink-400') + '">' + esc(st) + '</span></div>';
  });
  return out + '</div>';
}

function statusPill(it) {
  var p = STATUS_PILL[it.status] || 'bg-ink-100 text-ink-700 ring-ink-300';
  var dot = STATUS_DOT[it.status] || 'bg-ink-300';
  return '<span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ' + p + ' shrink-0">' +
    '<span class="h-1.5 w-1.5 rounded-full ' + dot + (it.status === 'running' ? ' animate-pulse' : '') + '"></span>' +
    esc(STATUS_LABEL[it.status] || it.status) + '</span>';
}

function artifactLink(a) {
  return '<a href="/api/artifact?path=' + encodeURIComponent(a.path) + '" target="_blank" rel="noopener" ' +
    'class="text-xs text-blue-700 underline underline-offset-2">' + esc(a.name) + '</a>';
}

function feedbackBox(text) {
  if (!text) return '';
  return '<div class="flex items-start gap-2 text-xs text-ink-600 bg-white/70 border border-red-200 rounded-md p-2.5">' +
    '<span class="text-red-700 font-semibold shrink-0">↳ feedback</span><span class="whitespace-pre-wrap">' + esc(text) + '</span></div>';
}

function cardHtml(it) {
  var skin = PARK_SKIN[it.status] || DEFAULT_SKIN;
  var d = it.parkedDetail || {};
  var html = '<div class="rounded-2xl border border-ink-200 bg-white shadow-sm overflow-hidden" data-id="' + it.id + '">' +
    '<div class="h-1 ' + skin.band + '"></div>' +
    '<div class="p-5">' +
    '<div class="flex items-start justify-between gap-3">' +
      '<div>' +
        '<div class="flex items-center gap-2">' +
          '<span class="flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold ' + skin.tag + '">' + skin.icon + '</span>' +
          '<span class="text-[10px] font-semibold uppercase tracking-widest text-ink-500">' + esc(skin.label) + '</span>' +
        '</div>' +
        '<h3 class="font-semibold text-lg leading-tight mt-2">#' + it.id + ' ' + esc(it.title) + '</h3>' +
        '<div class="text-xs text-ink-500 mt-0.5 font-mono">' + esc(it.slug) + ' · ' + esc(it.repo) + ' · ' + esc(it.branchName || 'no branch yet') + '</div>' +
      '</div>' + statusPill(it) +
    '</div>' +
    stageDots(it) +
    '<div class="mt-4 space-y-3">';

  if (it.status === 'awaiting-approval' && it.artifacts && it.artifacts.length) {
    html += '<div class="rounded-lg bg-white/70 border border-amber-200 p-3 text-sm">' +
      '<div class="text-amber-800 text-xs uppercase tracking-wide font-semibold mb-1.5">' + esc('artifact from ' + (d.stage || 'the parked stage') + ' — read before approving') + '</div>' +
      '<div class="flex flex-col gap-1">' + it.artifacts.map(artifactLink).join('') + '</div></div>';
  }

  if (it.status === 'needs-human' && it.questions && it.questions.length) {
    it.questions.forEach(function (q, i) {
      html += '<label class="block"><div class="text-sm text-ink-700 mb-1">' +
        '<span class="text-violet-600 font-semibold mr-1">Q' + (i + 1) + '</span>' + esc(q) + '</div>' +
        '<input class="q-input finput" data-question="' + esc(q) + '" placeholder="your answer…"></label>';
    });
  } else if (it.status === 'needs-human') {
    html += '<label class="block"><div class="text-sm text-ink-700 mb-1">This item is parked for you with no structured questions — give free-form guidance:</div>' +
      '<textarea class="fb-input finput" rows="2" placeholder="what should the next triage run know?"></textarea></label>';
  }

  if (it.status === 'infrastructure-failure' && d.error) {
    html += '<div class="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-md p-2.5 whitespace-pre-wrap font-mono">' + esc(d.error) + '</div>';
  }
  if (it.status === 'malformed') {
    html += '<div class="text-xs text-fuchsia-700 bg-fuchsia-50 border border-fuchsia-200 rounded-md p-2.5">' +
      esc(it.parkedReason || 'malformed front-matter') + ' — fix ' + esc(it.sourceFile || 'the item file') + ', then press Retry.</div>';
  }
  if (it.status === 'human-rejected') {
    html += '<div class="text-xs text-ink-600 bg-white/70 border border-ink-200 rounded-md p-2.5">' +
      'Rejected — the reason rides as feedback into the next agent run. Re-queue with <span class="font-mono">Resume</span> (it recovers every rejected item).</div>';
  }
  html += feedbackBox(it.feedback);

  html += '</div>'; // /space-y

  // actions
  html += '<div class="mt-4 flex items-center gap-2 flex-wrap">';
  if (it.status === 'awaiting-approval') {
    html += '<input class="note-input finput !w-52" placeholder="optional note">' +
      '<button data-action="approve" class="btn btn-ok">Approve</button>' +
      '<button data-action="reject" class="btn btn-out">Reject…</button>';
  } else if (it.status === 'needs-human') {
    if (it.questions && it.questions.length) {
      html += '<button data-action="answer" class="btn btn-dark">Answer ' + it.questions.length + ' question' + (it.questions.length > 1 ? 's' : '') + '</button>';
    } else {
      html += '<button data-action="answer-freeform" class="btn btn-dark">Send feedback</button>';
    }
  } else if (it.status === 'infrastructure-failure' || it.status === 'exhausted-rework' || it.status === 'malformed') {
    html += '<button data-action="retry" class="btn btn-out">Retry</button>';
  }
  html += '<span class="ml-auto text-[11px] text-ink-400">' +
    (it.approvals && it.approvals.length ? 'approvals: ' + esc(it.approvals.join(', ')) : '') + '</span></div>';

  if (it.status === 'awaiting-approval') {
    html += '<div class="reject-box hidden mt-3 rounded-lg border border-red-200 bg-red-50 p-3">' +
      '<div class="text-xs text-red-800 font-semibold mb-1">Rejection reason (required) — it becomes rework feedback for the next agent run:</div>' +
      '<textarea class="reason-input finput" rows="2"></textarea>' +
      '<div class="mt-2 flex gap-2"><button data-action="reject-confirm" class="btn btn-ok !bg-red-600 hover:!bg-red-700">Confirm rejection</button>' +
      '<button data-action="reject-cancel" class="btn btn-out">Cancel</button></div></div>';
  }

  html += '<div class="card-error hidden mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2 whitespace-pre-wrap"></div>';
  html += '</div></div>';
  return html;
}

function renderParking(p) {
  var cards = p.items.filter(isParked).sort(byParkOrder);
  var el = $('parking-lot');
  if (cards.length === 0) {
    el.innerHTML = '';
    return;
  }
  var html = '<div class="mb-4"><div class="text-[11px] font-semibold uppercase tracking-widest text-amber-700">The parking lot</div>' +
    '<div class="text-sm text-ink-500 mt-0.5">' + cards.length + ' item' + (cards.length === 1 ? '' : 's') +
    ' waiting on you · nothing else is blocked</div></div><div class="space-y-4">';
  html += cards.map(cardHtml).join('');
  html += '</div>';
  el.innerHTML = html;
}

function renderGlance(p) {
  var glance = p.items.filter(function (it) { return it.status === 'running' || it.status === 'queued' || it.status === 'done'; });
  var chips = glance.map(function (it) {
    var hint = '';
    if (it.status === 'queued' && it.parkedReason === 'stale-base' && it.parkedDetail && it.parkedDetail.repo) {
      hint = '<span class="text-ink-400" title="stale base: ' + esc(it.parkedDetail.base) + ' is behind origin/' + esc(it.parkedDetail.base) + '">⚑ git pull in ' + esc(it.parkedDetail.repo) + '</span>';
    }
    var pr = '';
    if (it.status === 'done' && it.prUrl) {
      pr = '<a href="' + esc(it.prUrl) + '" target="_blank" rel="noopener" class="text-emerald-700 underline underline-offset-2">PR' +
        (it.prDraft ? ' (draft)' : '') + '</a>';
    }
    return '<div class="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs shadow-sm">' +
      '<span class="h-1.5 w-1.5 rounded-full ' + (STATUS_DOT[it.status] || 'bg-ink-300') + (it.status === 'running' ? ' animate-pulse' : '') + '"></span>' +
      '<span class="font-medium">#' + it.id + ' ' + esc(it.slug) + '</span>' +
      '<span class="text-ink-400">' + esc(it.stage || '') + '</span>' + hint + pr + '</div>';
  }).join('');
  var inbox = (p.inbox.claimable || []).map(function (f) {
    return '<div class="rounded-md border border-dashed border-ink-300 bg-white/50 px-2.5 py-1 text-xs font-mono text-ink-500">📄 ' + esc(f) + '</div>';
  }).join('');
  var skipped = (p.inbox.alreadyClaimed || []).map(function (s) {
    return '<div class="text-[11px] text-ink-400">⚠ ' + esc(s.file) + ' will be skipped — slug already claimed (#' + s.item.id + ', ' + esc(s.item.status) + ')</div>';
  }).join('');
  if (p.inbox.error) skipped += '<div class="text-[11px] text-red-600">inbox unreadable: ' + esc(p.inbox.error) + '</div>';
  $('glance').innerHTML =
    '<div class="border-t border-ink-200 pt-6">' +
    '<div class="text-[11px] font-semibold uppercase tracking-widest text-ink-400 mb-3">Factory at a glance</div>' +
    (chips ? '<div class="flex flex-wrap gap-2">' + chips + '</div>' : '<div class="text-xs text-ink-400">no items in flight</div>') +
    ((inbox || skipped) ? '<div class="mt-4 flex flex-wrap gap-2">' + inbox + '</div><div class="mt-2 space-y-0.5">' + skipped + '</div>' : '') +
    '</div>';
}

function renderLock(lock) {
  var el = $('lock-banner');
  if (!lock) { el.classList.add('hidden'); return; }
  if (lock.alive) {
    el.textContent = 'factory command in progress (pid ' + lock.pid + ', ' + fmtAge(lock.ageMs) + (lock.stale ? ' — possibly stale' : '') + ')';
  } else {
    el.textContent = 'stale factory lock (pid ' + lock.pid + ', ' + fmtAge(lock.ageMs) + ') — holder is not running';
  }
  el.classList.remove('hidden');
}

/* ================= live feed (append-only) ================= */

function feedDetail(row) {
  var d = row.detail || {};
  if (row.event === 'parked' && d.reason) return ' — ' + d.reason;
  if (row.event === 'pr-created' && d.url) return ' — ' + d.url;
  if (row.event === 'unparked' && d.via) return ' (via ' + d.via + ')';
  if (row.event === 'stage-gate-fail' && d.attempt) return ' (attempt ' + d.attempt + ')';
  if (row.event === 'stage-pass' && d.nextStage) return ' → ' + d.nextStage;
  return '';
}

function appendFeed(row) {
  var feed = $('feed');
  var line = document.createElement('div');
  line.className = 'flex gap-2 py-0.5 text-xs';
  var t = document.createElement('span');
  t.className = 'text-ink-400 shrink-0 tabular-nums';
  t.textContent = fmtClock(row.ts);
  var e = document.createElement('span');
  e.className = 'shrink-0 font-semibold w-36';
  e.style.color = FEED_COLOR[row.event] || '#44403c';
  e.textContent = row.event;
  var b = document.createElement('span');
  b.className = 'text-ink-700';
  b.textContent = '#' + row.itemId + ' ' + row.slug + (row.stage ? ' · ' + row.stage : '') + feedDetail(row);
  line.appendChild(t); line.appendChild(e); line.appendChild(b);
  feed.appendChild(line);
  while (feed.children.length > 200) feed.removeChild(feed.firstChild);
}

/* ================= parking-lot actions (event delegation) ================= */

$('parking-lot').addEventListener('click', function (ev) {
  var btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  var card = btn.closest('[data-id]');
  var id = card.getAttribute('data-id');
  var action = btn.getAttribute('data-action');

  if (action === 'approve') {
    var note = card.querySelector('.note-input').value.trim();
    act('/api/items/' + id + '/approve', note ? { note: note } : {}, card);
  } else if (action === 'reject') {
    card.querySelector('.reject-box').classList.remove('hidden');
  } else if (action === 'reject-cancel') {
    card.querySelector('.reject-box').classList.add('hidden');
  } else if (action === 'reject-confirm') {
    var reason = card.querySelector('.reason-input').value.trim();
    if (!reason) { showCardError(card, 'a rejection reason is required'); return; }
    act('/api/items/' + id + '/reject', { reason: reason }, card);
  } else if (action === 'retry') {
    act('/api/items/' + id + '/retry', {}, card);
  } else if (action === 'answer') {
    var pairs = [];
    card.querySelectorAll('.q-input').forEach(function (input) {
      if (input.value.trim()) pairs.push({ question: input.getAttribute('data-question'), answer: input.value });
    });
    if (pairs.length === 0) { showCardError(card, 'answer at least one question (a subset is fine)'); return; }
    act('/api/items/' + id + '/answer', { answers: pairs }, card);
  } else if (action === 'answer-freeform') {
    var fb = card.querySelector('.fb-input').value.trim();
    if (!fb) { showCardError(card, 'write some feedback first'); return; }
    act('/api/items/' + id + '/answer', { feedback: fb }, card);
  }
});

/* ================= header: Run / Resume ================= */

$('btn-run').addEventListener('click', function () {
  postJSON('/api/run', {}).then(function (r) {
    if (r.status === 202) toast('run started — progress lands in the feed');
    else if (r.status === 409) { renderLock(r.data && r.data.lock); toast('factory is busy — a run is already in progress'); }
    else toast((r.data && r.data.error) || ('HTTP ' + r.status));
  });
});
$('btn-resume').addEventListener('click', function () {
  postJSON('/api/resume', {}).then(function (r) {
    if (r.status === 202) toast('resume started — progress lands in the feed' + (r.data && r.data.capped ? ' (hit its safety cap — press Resume again)' : ''));
    else if (r.status === 409) { renderLock(r.data && r.data.lock); toast('factory is busy — a run is already in progress'); }
    else toast((r.data && r.data.error) || ('HTTP ' + r.status));
  });
});

/* ================= composer ================= */

function buildApprovalCheckboxes() {
  var wrap = $('f-approvals');
  wrap.innerHTML = APPROVAL_STAGES.map(function (st) {
    return '<label class="inline-flex items-center gap-1.5 rounded-full border border-ink-300 bg-white px-3 py-1 text-xs cursor-pointer">' +
      '<input type="checkbox" class="approval-cb accent-indigo-600" value="' + esc(st) + '"> ' + esc(st) + '</label>';
  }).join('');
}
buildApprovalCheckboxes();

$('composer-toggle').addEventListener('click', function () {
  $('composer-body').classList.toggle('hidden');
});

function clearFieldErrors() {
  document.querySelectorAll('.ferr').forEach(function (el) { el.textContent = ''; });
  $('composer-error').classList.add('hidden');
}
function renderFieldErrors(errors) {
  errors.forEach(function (e) {
    if (e.field === 'item') {
      var box = $('composer-error');
      box.textContent = e.reason;
      box.classList.remove('hidden');
    } else {
      var el = document.querySelector('[data-err="' + e.field + '"]');
      if (el) el.textContent = e.reason;
    }
  });
}

$('btn-submit').addEventListener('click', function () {
  clearFieldErrors();
  var approvals = [];
  document.querySelectorAll('.approval-cb:checked').forEach(function (cb) { approvals.push(cb.value); });
  var body = {
    title: $('f-title').value,
    repo: $('f-repo').value,
    base: $('f-base').value || 'main',
    approvals: approvals,
    description: $('f-desc').value,
    runNow: $('f-runnow').checked
  };
  postJSON('/api/items', body).then(function (r) {
    if (r.status === 201) {
      toast('wrote ' + r.data.file + (r.data.runStarted ? ' — run started' : ' — the factory claims it on Run'));
      $('f-title').value = ''; $('f-desc').value = ''; $('f-runnow').checked = false;
      document.querySelectorAll('.approval-cb:checked').forEach(function (cb) { cb.checked = false; });
      refreshStatus();
    } else if (r.status === 422 && r.data && r.data.errors) {
      renderFieldErrors(r.data.errors);
    } else if (r.status === 409) {
      renderLock(r.data && r.data.lock);
      toast('factory is busy — try again once the run finishes (your text is kept)');
    } else {
      toast((r.data && r.data.error) || ('HTTP ' + r.status));
    }
  });
});

/* "Start from template": fetch /api/template and prefill the fields from the
 * template's front-matter (title/repo/base/approvals) and its body. Falls
 * back to dumping the raw template into the description. */
$('btn-template').addEventListener('click', function () {
  fetch('/api/template').then(function (r) { return r.text(); }).then(function (text) {
    var lines = text.split('\\n');
    if (lines[0] === '---') {
      var close = lines.indexOf('---', 1);
      if (close > 0) {
        var fm = {}; 
        lines.slice(1, close).forEach(function (line) {
          var m = line.match(/^([A-Za-z_-]+):\\s*(.*)$/);
          if (m) fm[m[1]] = m[2];
        });
        if (!$('f-title').value && fm.title) $('f-title').value = fm.title;
        if (!$('f-repo').value && fm.repo && fm.repo.indexOf('/path/to') !== 0) $('f-repo').value = fm.repo;
        if (!$('f-base').value && fm.base) $('f-base').value = fm.base;
        if (fm.approvals) {
          var inner = fm.approvals.replace(/#.*$/, '').replace(/^[\\[]+/, '').replace(/[\\]]+$/, '').trim();
          if (inner) {
            inner.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (st) {
              var cb = document.querySelector('.approval-cb[value="' + st + '"]');
              if (cb) cb.checked = true;
            });
          }
        }
        $('f-desc').value = lines.slice(close + 1).join('\\n').trim();
        return;
      }
    }
    $('f-desc').value = text;
  });
});

/* ================= file drop (existing .md items, verbatim) ================= */

var dropZone = $('drop-zone');
dropZone.addEventListener('click', function () { $('file-input').click(); });
dropZone.addEventListener('dragover', function (ev) { ev.preventDefault(); dropZone.classList.add('bg-indigo-50'); });
dropZone.addEventListener('dragleave', function () { dropZone.classList.remove('bg-indigo-50'); });
dropZone.addEventListener('drop', function (ev) {
  ev.preventDefault();
  dropZone.classList.remove('bg-indigo-50');
  handleFiles(ev.dataTransfer.files);
});
$('file-input').addEventListener('change', function (ev) { handleFiles(ev.target.files); ev.target.value = ''; });

function handleFiles(files) {
  Array.from(files).forEach(function (f) {
    if (!/\\.md$/i.test(f.name)) {
      toast('skipped ' + f.name + ' — only .md files');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      postJSON('/api/items/drop', { filename: f.name, content: reader.result }).then(function (r) {
        if (r.status === 201) { toast('dropped ' + f.name + ' into the inbox'); refreshStatus(); }
        else toast((r.data && r.data.error) || ('HTTP ' + r.status));
      });
    };
    reader.readAsText(f);
  });
}

/* ================= SSE stream ================= */

var es = new EventSource('/api/events');
es.addEventListener('status', function (e) {
  try { render(JSON.parse(e.data)); } catch (err) { /* malformed snapshot: keep last render */ }
});
es.addEventListener('history', function (e) {
  try { appendFeed(JSON.parse(e.data)); } catch (err) { /* malformed row: skip */ }
});
es.onopen = function () { $('feed-status').textContent = '● live'; $('feed-status').className = 'text-xs text-emerald-600'; };
es.onerror = function () { $('feed-status').textContent = 'reconnecting…'; $('feed-status').className = 'text-xs text-amber-600'; };

/* Instant paint ahead of the first SSE snapshot (identical shared payload). */
refreshStatus();
</script>
</body>
</html>
`;
