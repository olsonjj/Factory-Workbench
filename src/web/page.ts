/**
 * `PAGE_HTML` — the single self-contained page served at `GET /`.
 *
 * Why a TS string constant and not `src/web/index.html`: tsconfig compiles
 * only the `src` tree into `dist/` with no asset copy step, so a sibling HTML
 * file would be unreadable from `dist/cli/index.js` (the bin target). The
 * string travels with the bundle under both tsx and tsc with zero build
 * changes (wb-serve implementation spec §6.5 — hard constraint).
 *
 * Content: vanilla JS with a hand-written self-contained stylesheet — the
 * prototype's (branch prototype/wb-serve-design, variant C "Decision desk")
 * Tailwind vocabulary and paper/ink palette, inlined. The page loads no
 * remote code: a CDN script on a localhost control surface runs same-origin
 * and is invisible to the Host/Origin guards (rework per KB 2026-11-06
 * 16:40); server.ts additionally emits a strict CSP on every response. The
 * inner script deliberately uses string concatenation, never template
 * literals, so nothing inside needs escaping from the surrounding TS literal.
 *
 * XSS discipline (KB 2026-10-27 22:00 — the browser is an interpreter):
 * every untrusted string (titles, feedback, questions, reasons, artifact
 * names, repo paths, slugs from the stream) goes through `esc()` at the
 * interpolation site or is assigned via `textContent`; `innerHTML` receives
 * only escaped/structural markup. All actions are same-origin fetch POSTs
 * with `Content-Type: application/json`; no CORS headers are emitted. The
 * glance section's collapse state is client-side only (one module-level var,
 * always collapsed on load) — never persisted, no localStorage.
 */

export const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wb — factory workbench</title>
<style>
/* Self-contained stylesheet — no CDN script, no remote CSS (KB 2026-11-06
 * 16:40: a remote script on a localhost control surface runs same-origin and
 * is invisible to the Host/Origin CSRF guards). It carries a minimal
 * preflight, the component classes (lbl/finput/ferr/btn), and the utility
 * classes the markup and render functions use — the prototype's Tailwind
 * vocabulary hand-written in its paper/ink palette. Utilities come after the
 * component classes so combinations like btn-dark + bg-indigo-600 and
 * btn-ok + !bg-red-600 compose exactly as the prototype intended. */

/* ---- minimal preflight ---- */
*, *::before, *::after { box-sizing: border-box; border: 0 solid #e5e7eb; margin: 0; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; line-height: 1.5; }
h1, h2, h3, h4, h5, h6, p { font-size: inherit; font-weight: inherit; }
button, input, textarea, select { font: inherit; color: inherit; }
button { background-color: transparent; }
a { color: inherit; text-decoration: inherit; }
input::placeholder, textarea::placeholder { color: #a8a29e; opacity: 1; }

/* ---- component classes ---- */
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

/* ---- utilities: display / flex / grid / gaps ---- */
  .hidden { display: none; }
  .block { display: block; }
  .flex { display: flex; }
  .inline-flex { display: inline-flex; }
  .grid { display: grid; }
  .flex-col { flex-direction: column; }
  .flex-wrap { flex-wrap: wrap; }
  .flex-1 { flex: 1 1 0%; }
  .shrink-0 { flex-shrink: 0; }
  .items-baseline { align-items: baseline; }
  .items-center { align-items: center; }
  .items-start { align-items: flex-start; }
  .justify-between { justify-content: space-between; }
  .justify-center { justify-content: center; }
  .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .col-span-2 { grid-column: span 2 / span 2; }
  .gap-0 { gap: 0; }
  .gap-1 { gap: 0.25rem; }
  .gap-1\\.5 { gap: 0.375rem; }
  .gap-2 { gap: 0.5rem; }
  .gap-3 { gap: 0.75rem; }
  .gap-x-3 { column-gap: 0.75rem; }
  .gap-y-0\\.5 { row-gap: 0.125rem; }
  .space-y-0\\.5 > * + * { margin-top: 0.125rem; }
  .space-y-3 > * + * { margin-top: 0.75rem; }
  .space-y-4 > * + * { margin-top: 1rem; }

/* ---- position ---- */
  .relative { position: relative; }
  .absolute { position: absolute; }
  .fixed { position: fixed; }
  .sticky { position: sticky; }
  .top-0 { top: 0; }
  .top-4 { top: 1rem; }
  .left-0 { left: 0; }
  .left-1\\/2 { left: 50%; }
  .bottom-0 { bottom: 0; }
  .z-20 { z-index: 20; }
  .z-50 { z-index: 50; }
  .-translate-x-1\\/2 { transform: translateX(-50%); }

/* ---- size ---- */
  .h-1 { height: 0.25rem; }
  .h-1\\.5 { height: 0.375rem; }
  .h-2 { height: 0.5rem; }
  .h-2\\.5 { height: 0.625rem; }
  .h-6 { height: 1.5rem; }
  .h-px { height: 1px; }
  .w-1 { width: 0.25rem; }
  .w-1\\.5 { width: 0.375rem; }
  .w-2 { width: 0.5rem; }
  .w-2\\.5 { width: 0.625rem; }
  .w-6 { width: 1.5rem; }
  .w-36 { width: 9rem; }
  .w-full { width: 100%; }
  .\\!w-52 { width: 13rem !important; }
  .max-w-3xl { max-width: 48rem; }
  .max-h-72 { max-height: 18rem; }
  .min-h-\\[3rem\\] { min-height: 3rem; }

/* ---- spacing ---- */
  .mx-auto { margin-left: auto; margin-right: auto; }
  .ml-auto { margin-left: auto; }
  .mr-1 { margin-right: 0.25rem; }
  .mt-0\\.5 { margin-top: 0.125rem; }
  .mt-1 { margin-top: 0.25rem; }
  .mt-1\\.5 { margin-top: 0.375rem; }
  .mt-2 { margin-top: 0.5rem; }
  .mt-3 { margin-top: 0.75rem; }
  .mt-4 { margin-top: 1rem; }
  .mt-5 { margin-top: 1.25rem; }
  .mt-8 { margin-top: 2rem; }
  .mt-10 { margin-top: 2.5rem; }
  .mb-1 { margin-bottom: 0.25rem; }
  .mb-1\\.5 { margin-bottom: 0.375rem; }
  .mb-3 { margin-bottom: 0.75rem; }
  .mb-4 { margin-bottom: 1rem; }
  .p-2 { padding: 0.5rem; }
  .p-2\\.5 { padding: 0.625rem; }
  .p-3 { padding: 0.75rem; }
  .p-4 { padding: 1rem; }
  .p-5 { padding: 1.25rem; }
  .px-1 { padding-left: 0.25rem; padding-right: 0.25rem; }
  .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
  .px-2\\.5 { padding-left: 0.625rem; padding-right: 0.625rem; }
  .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
  .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .px-5 { padding-left: 1.25rem; padding-right: 1.25rem; }
  .py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
  .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
  .py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
  .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
  .pb-24 { padding-bottom: 6rem; }
  .pl-5 { padding-left: 1.25rem; }
  .pt-4 { padding-top: 1rem; }
  .pt-6 { padding-top: 1.5rem; }

/* ---- typography ---- */
  .font-mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  .font-bold { font-weight: 700; }
  .font-semibold { font-weight: 600; }
  .font-medium { font-weight: 500; }
  .font-normal { font-weight: 400; }
  .text-\\[9px\\] { font-size: 9px; }
  .text-\\[10px\\] { font-size: 10px; }
  .text-\\[11px\\] { font-size: 11px; }
  .text-xs { font-size: 12px; line-height: 16px; }
  .text-sm { font-size: 14px; line-height: 20px; }
  .text-lg { font-size: 18px; line-height: 28px; }
  .text-3xl { font-size: 30px; line-height: 36px; }
  .leading-none { line-height: 1; }
  .leading-tight { line-height: 1.25; }
  .leading-relaxed { line-height: 1.625; }
  .tracking-tight { letter-spacing: -0.025em; }
  .tracking-wide { letter-spacing: 0.025em; }
  .tracking-widest { letter-spacing: 0.1em; }
  .uppercase { text-transform: uppercase; }
  .normal-case { text-transform: none; }
  .whitespace-nowrap { white-space: nowrap; }
  .whitespace-pre-wrap { white-space: pre-wrap; }
  .underline { text-decoration: underline; }
  .underline-offset-2 { text-underline-offset: 2px; }
  .text-center { text-align: center; }
  .tabular-nums { font-variant-numeric: tabular-nums; }

/* ---- colors: text (the prototype's ink palette + status hues) ---- */
  .text-white { color: #fff; }
  .text-ink-400 { color: #a8a29e; }
  .text-ink-500 { color: #78716c; }
  /* ink-600 was absent from the prototype config; midpoint of 500/700 */
  .text-ink-600 { color: #68655d; }
  .text-ink-700 { color: #57534e; }
  .text-ink-800 { color: #44403c; }
  .text-ink-900 { color: #292524; }
  .text-ink-950 { color: #1c1917; }
  .text-amber-400 { color: #fbbf24; }
  .text-amber-600 { color: #d97706; }
  .text-amber-700 { color: #b45309; }
  .text-amber-800 { color: #92400e; }
  .text-amber-950 { color: #451a03; }
  .text-blue-500 { color: #3b82f6; }
  .text-blue-700 { color: #1d4ed8; }
  .text-emerald-500 { color: #10b981; }
  .text-emerald-600 { color: #059669; }
  .text-emerald-700 { color: #047857; }
  .text-fuchsia-700 { color: #a21caf; }
  .text-fuchsia-800 { color: #86198f; }
  .text-orange-700 { color: #c2410c; }
  .text-orange-800 { color: #9a3412; }
  .text-red-500 { color: #ef4444; }
  .text-red-600 { color: #dc2626; }
  .text-red-700 { color: #b91c1c; }
  .text-red-800 { color: #991b1b; }
  .text-violet-600 { color: #7c3aed; }
  .text-violet-700 { color: #6d28d9; }
  .text-violet-800 { color: #5b21b6; }

/* ---- colors: backgrounds (paper/ink theme + status hues) ---- */
  .bg-paper { background-color: #fafaf9; }
  .bg-white { background-color: #fff; }
  .bg-white\\/50 { background-color: rgba(255, 255, 255, 0.5); }
  .bg-white\\/70 { background-color: rgba(255, 255, 255, 0.7); }
  .bg-white\\/80 { background-color: rgba(255, 255, 255, 0.8); }
  .bg-ink-100 { background-color: #f5f5f4; }
  .bg-ink-100\\/70 { background-color: rgba(245, 245, 244, 0.7); }
  .bg-ink-300 { background-color: #d6d3d1; }
  .bg-ink-400 { background-color: #a8a29e; }
  .bg-ink-500 { background-color: #78716c; }
  .bg-ink-950 { background-color: #1c1917; }
  .bg-amber-100 { background-color: #fef3c7; }
  .bg-amber-400 { background-color: #fbbf24; }
  .bg-blue-50 { background-color: #eff6ff; }
  .bg-blue-500 { background-color: #3b82f6; }
  .bg-emerald-50 { background-color: #ecfdf5; }
  .bg-emerald-500 { background-color: #10b981; }
  .bg-fuchsia-50 { background-color: #fdf4ff; }
  .bg-fuchsia-100 { background-color: #fae8ff; }
  .bg-fuchsia-500 { background-color: #d946ef; }
  .bg-indigo-50 { background-color: #eef2ff; }
  .bg-indigo-600 { background-color: #4f46e5; }
  .bg-orange-50 { background-color: #fff7ed; }
  .bg-orange-100 { background-color: #ffedd5; }
  .bg-orange-500 { background-color: #f97316; }
  .bg-red-50 { background-color: #fef2f2; }
  .bg-red-100 { background-color: #fee2e2; }
  .bg-red-500 { background-color: #ef4444; }
  .bg-stone-400 { background-color: #a8a29e; }
  .bg-violet-100 { background-color: #ede9fe; }
  .bg-violet-500 { background-color: #8b5cf6; }

/* ---- borders / rings ---- */
  .border { border-width: 1px; }
  .border-2 { border-width: 2px; }
  .border-b { border-bottom-width: 1px; }
  .border-t { border-top-width: 1px; }
  .border-dashed { border-style: dashed; }
  .border-amber-200 { border-color: #fde68a; }
  .border-fuchsia-200 { border-color: #f5d0fe; }
  .border-indigo-100 { border-color: #e0e7ff; }
  .border-indigo-300 { border-color: #a5b4fc; }
  .border-ink-200 { border-color: #e7e5e4; }
  .border-ink-300 { border-color: #d6d3d1; }
  .border-orange-200 { border-color: #fed7aa; }
  .border-red-200 { border-color: #fecaca; }
  .border-violet-200 { border-color: #ddd6fe; }
  .ring-1 { box-shadow: 0 0 0 1px var(--ring, rgba(0, 0, 0, 0.05)); }
  .ring-amber-300 { --ring: #fcd34d; }
  .ring-blue-200 { --ring: #bfdbfe; }
  .ring-emerald-200 { --ring: #a7f3d0; }
  .ring-fuchsia-300 { --ring: #f0abfc; }
  .ring-ink-200 { --ring: #e7e5e4; }
  .ring-ink-300 { --ring: #d6d3d1; }
  .ring-orange-300 { --ring: #fdba74; }
  .ring-red-300 { --ring: #fca5a5; }
  .ring-violet-300 { --ring: #c4b5fd; }

/* ---- radii / shadows / effects ---- */
  .rounded-md { border-radius: 6px; }
  .rounded-lg { border-radius: 8px; }
  .rounded-xl { border-radius: 12px; }
  .rounded-2xl { border-radius: 16px; }
  .rounded-full { border-radius: 9999px; }
  /* after .ring-1: on elements combining ring + shadow the ring rides along */
  .shadow-sm { box-shadow: 0 0 0 1px var(--ring, transparent), 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
  .shadow-lg { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1); }
  .backdrop-blur { backdrop-filter: blur(8px); }
  .overflow-hidden { overflow: hidden; }
  .overflow-y-auto { overflow-y: auto; }
  .transition-colors { transition-property: color, background-color, border-color, text-decoration-color, fill, stroke; transition-duration: 150ms; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); }
  .animate-pulse { animation: wb-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
  @keyframes wb-pulse { 50% { opacity: 0.5; } }
  /* one-shot flash for the glance chips the header RUNNING pill targets
   * (same blue as bg-blue-500, #3b82f6) — a class, never an inline style,
   * so the style block stays the single source of styling. */
  .wb-flash { animation: wb-flash 1.6s ease-out 1; }
  @keyframes wb-flash {
    0% { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.45); }
    100% { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0); }
  }
  .cursor-pointer { cursor: pointer; }
  .accent-indigo-600 { accent-color: #4f46e5; }

/* ---- important / hover variants ---- */
  .\\!bg-red-600 { background-color: #dc2626 !important; }
  .hover\\:\\!bg-red-700:hover { background-color: #b91c1c !important; }
  .hover\\:bg-indigo-700:hover { background-color: #4338ca; }
  .hover\\:bg-indigo-50\\/50:hover { background-color: rgba(238, 242, 255, 0.5); }
</style>
</head>
<body class="bg-paper text-ink-900">

<header class="border-b border-ink-200 bg-white/80 backdrop-blur px-5 py-3 flex items-center gap-3 flex-wrap sticky top-0 z-20">
  <div class="font-mono font-bold text-lg tracking-tight"><span class="text-ink-950">wb</span><span class="text-ink-400"> — factory workbench</span></div>
  <div id="run-state" class="hidden"></div>
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
            <input id="f-repo" class="finput font-mono" list="repos-dl" placeholder="repo name, Code/rel/path, ~/path, or /abs/path">
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

/* Factory-at-a-glance collapse: per page load only — starts collapsed,
 * never persisted (no localStorage/session storage; the item's non-goal). */
var glanceCollapsed = true;

/* ================= helpers ================= */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
/* Elapsed clock for the header RUNNING pill: mm:ss (both padded), rolling
 * over to h:mm:ss past one hour. Pure and padStart-based — no Intl needed. */
function fmtMMSS(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var p = function (n) { return String(n).padStart(2, '0'); };
  if (s < 3600) return p(Math.floor(s / 60)) + ':' + p(s % 60);
  return Math.floor(s / 3600) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
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
  renderRunState(p);
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

/* Dropdown options carry a per-repo item-count label. Chromium/WebKit
 * surface option labels; Firefox shows values only — acceptable, since the
 * value (the absolute known-repo path) is the pick data and free-form entry
 * keeps working regardless. */
function renderDatalist(knownRepos) {
  var dl = $('repos-dl');
  dl.innerHTML = knownRepos.map(function (k) {
    var label = k.count > 0 ? (k.count + (k.count === 1 ? ' item' : ' items')) : '';
    return '<option value="' + esc(k.repo) + '">' + esc(label) + '</option>';
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

/* Unfinished user input lives inside re-rendered cards (answer inputs, the
 * approval note, the rejection textarea, an open reject box). Live status
 * events must not silently wipe it: before replacing the parking-lot DOM we
 * capture every non-empty draft plus the focused field, and after the
 * replacement we restore them. Keyed by item id (+ question text), which is
 * stable across renders. */
function captureDrafts() {
  var el = $('parking-lot');
  if (!el.firstChild) return null;
  var state = {};
  el.querySelectorAll('[data-id]').forEach(function (card) {
    var id = card.getAttribute('data-id');
    var s = {};
    var note = card.querySelector('.note-input');
    if (note && note.value) s.note = note.value;
    var reason = card.querySelector('.reason-input');
    if (reason && reason.value) s.reason = reason.value;
    var rejectBox = card.querySelector('.reject-box');
    if (rejectBox && !rejectBox.classList.contains('hidden')) s.rejectOpen = true;
    var fb = card.querySelector('.fb-input');
    if (fb && fb.value) s.fb = fb.value;
    var answers = {};
    card.querySelectorAll('.q-input').forEach(function (q) {
      if (q.value) answers[q.getAttribute('data-question')] = q.value;
    });
    if (Object.keys(answers).length) s.answers = answers;
    if (Object.keys(s).length) state[id] = s;
  });
  var focus = null;
  var active = document.activeElement;
  if (active && el.contains(active)) {
    var fcard = active.closest('[data-id]');
    if (fcard) {
      focus = {
        id: fcard.getAttribute('data-id'),
        cls: active.classList.contains('q-input') ? 'q-input' : (active.classList.contains('note-input') ? 'note-input' : (active.classList.contains('reason-input') ? 'reason-input' : (active.classList.contains('fb-input') ? 'fb-input' : ''))),
        question: active.getAttribute('data-question') || '',
      };
    }
  }
  return { state: state, focus: focus };
}

function applyDrafts(captured) {
  if (!captured) return;
  var el = $('parking-lot');
  for (var id in captured.state) {
    var card = el.querySelector('[data-id="' + id + '"]');
    if (!card) continue;
    var s = captured.state[id];
    if (s.note) { var n = card.querySelector('.note-input'); if (n) n.value = s.note; }
    if (s.reason) { var r = card.querySelector('.reason-input'); if (r) r.value = s.reason; }
    if (s.fb) { var f = card.querySelector('.fb-input'); if (f) f.value = s.fb; }
    if (s.rejectOpen) { var b = card.querySelector('.reject-box'); if (b) b.classList.remove('hidden'); }
    if (s.answers) {
      card.querySelectorAll('.q-input').forEach(function (q) {
        var v = s.answers[q.getAttribute('data-question')];
        if (v !== undefined) q.value = v;
      });
    }
    // Restore focus (and caret position) if the user was mid-typing here.
    if (captured.focus && captured.focus.id === id && captured.focus.cls) {
      var target = null;
      if (captured.focus.cls === 'q-input') {
        card.querySelectorAll('.q-input').forEach(function (q) {
          if (!target && (q.getAttribute('data-question') || '') === captured.focus.question) target = q;
        });
      } else {
        target = card.querySelector('.' + captured.focus.cls);
      }
      if (target) {
        target.focus();
        try { target.setSelectionRange(target.value.length, target.value.length); } catch (e) { /* textarea/input without ranges */ }
      }
    }
  }
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
  // Skip the DOM replacement when untouched — and when it DOES change, carry
  // in-progress drafts + focus across so live updates never erase typing.
  if (el.innerHTML === html) return;
  var captured = captureDrafts();
  el.innerHTML = html;
  applyDrafts(captured);
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
    return '<div data-item-id="' + it.id + '" class="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs shadow-sm">' +
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
  /* Collapsed-by-default section (spec §Page): a single clickable summary row
   * hides the chip/inbox detail behind #glance-body until toggled. The empty
   * state (no chips AND no inbox/skipped/error rows) keeps the plain line and
   * no toggle. Counts come from the same glance filter the chips use — only
   * static words + numbers enter the summary (no untrusted data, no esc gap). */
  var runningCount = 0, queuedCount = 0, doneCount = 0;
  glance.forEach(function (it) {
    if (it.status === 'running') runningCount++;
    else if (it.status === 'queued') queuedCount++;
    else doneCount++;
  });
  var segments = [];
  if (runningCount > 0) segments.push(runningCount + ' running');
  if (queuedCount > 0) segments.push(queuedCount + ' queued');
  if (doneCount > 0) segments.push(doneCount + ' landed');
  if ((p.inbox.claimable || []).length > 0) segments.push((p.inbox.claimable || []).length + ' in inbox');
  if (glance.length === 0 && !inbox && !skipped) {
    $('glance').innerHTML =
      '<div class="border-t border-ink-200 pt-6">' +
      '<div class="text-[11px] font-semibold uppercase tracking-widest text-ink-400 mb-3">Factory at a glance</div>' +
      '<div class="text-xs text-ink-400">no items in flight</div>' +
      '</div>';
    return;
  }
  $('glance').innerHTML =
    '<div class="border-t border-ink-200 pt-6">' +
    // A <button type="button">: keyboard users Tab to it and press Enter/Space,
    // which the browser synthesizes into the same click the toggle handles.
    '<button type="button" data-glance-summary aria-expanded="' + (glanceCollapsed ? 'false' : 'true') + '" title="expand/collapse the factory overview" class="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs shadow-sm cursor-pointer hover:bg-indigo-50/50 transition-colors">' +
    '<span data-glance-glyph class="text-ink-400 font-mono">' + (glanceCollapsed ? '▸' : '▾') + '</span>' +
    '<span class="font-semibold">Factory at a glance</span>' +
    (segments.length ? '<span class="text-ink-500">· ' + segments.join(' · ') + '</span>' : '') +
    '</button>' +
    '<div id="glance-body" class="mt-3' + (glanceCollapsed ? ' hidden' : '') + '">' +
    '<div class="flex flex-wrap gap-2">' + chips + '</div>' +
    ((inbox || skipped) ? '<div class="mt-4 flex flex-wrap gap-2">' + inbox + '</div><div class="mt-2 space-y-0.5">' + skipped + '</div>' : '') +
    '</div>' +
    '</div>';
}

/* The single writer of glance collapse state — surgical DOM updates, never a
 * re-render (a full repaint would destroy the just-clicked button and drop
 * keyboard focus to <body>). Body absent means the empty render: nothing to
 * toggle. classList add/remove only — the runtime-test stub has no toggle. */
function applyGlanceCollapsed(collapsed) {
  glanceCollapsed = collapsed;
  var body = $('glance-body');
  if (!body) return;
  if (collapsed) body.classList.add('hidden'); else body.classList.remove('hidden');
  var glyph = $('glance').querySelector('[data-glance-glyph]');
  if (glyph) glyph.textContent = collapsed ? '▸' : '▾';
  var btn = $('glance').querySelector('[data-glance-summary]');
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/* Header run-state pill. Three states (spec §Page): IDLE (calm stone chip,
 * visibly inert) when no lock is held; RUNNING while a live lock exists —
 * pulsing blue dot, "#id slug · stage" per running item (or the holder pid
 * when no item is running), and a mm:ss elapsed clock; the verbatim
 * stale-lock text for a dead holder. The clock anchor is re-derived from
 * lock.ageMs on every status event; a single 1s interval (created once, at
 * init) extrapolates between events — no extra polling, the SSE cadence is
 * untouched. payloadLike is a whole status payload (render) or a {lock}
 * fragment (409 handlers, via the renderLock shim); items defaults to []. */
var runAnchor = { ageMs: 0, at: 0, running: false, itemIds: [] };

function renderRunState(p) {
  var el = $('run-state');
  var lock = (p && p.lock) || null;
  if (!lock) {
    runAnchor.running = false;
    el.innerHTML = '<span class="rounded-full text-[10px] font-semibold tracking-widest text-ink-400 bg-white ring-1 ring-ink-200 px-3 py-1">IDLE</span>';
    el.classList.remove('hidden');
    return;
  }
  if (!lock.alive) {
    runAnchor.running = false;
    var mins = Math.floor((lock.ageMs || 0) / 60000);
    var age = mins < 1 ? 'just started' : mins + ' min ago';
    el.innerHTML = '<span class="rounded-full text-xs bg-amber-100 text-amber-800 ring-1 ring-amber-300 px-3 py-1">' +
      'stale factory lock (pid ' + esc(lock.pid) + ', ' + esc(age) + ') — holder is not running</span>';
    el.classList.remove('hidden');
    return;
  }
  var running = (p.items || []).filter(function (it) { return it.status === 'running'; })
    .sort(function (a, b) { return a.id - b.id; });
  runAnchor = {
    ageMs: lock.ageMs || 0,
    at: Date.now(),
    running: true,
    itemIds: running.map(function (it) { return it.id; })
  };
  var frag = running.length
    ? running.map(function (it) { return '#' + it.id + ' ' + esc(it.slug) + ' · ' + esc(it.stage || ''); }).join(' · ')
    : '(pid ' + esc(lock.pid) + ')'; // live lock, no running item (a bounded CLI action holds it)
  el.innerHTML =
    // A <button> (not a div): keyboard users can Tab to the pill and press
    // Enter/Space for the same scroll-and-flash action. The preflight resets
    // button chrome (border 0, transparent bg, inherited font), so the pill
    // renders identically to the former div.
    '<button type="button" class="rounded-full ring-1 ' + STATUS_PILL.running + ' text-xs px-3 py-1 inline-flex items-center gap-1.5 cursor-pointer" title="factory pid ' + esc(lock.pid) + '">' +
    '<span class="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"></span>' +
    '<span class="text-[10px] font-semibold tracking-widest">RUNNING</span>' +
    '<span>· ' + frag + '</span>' +
    '<span class="font-mono tabular-nums" id="run-clock">' + fmtMMSS(runAnchor.ageMs) + '</span>' +
    '</button>';
  el.classList.remove('hidden');
}

/* Compat shim for the busy-lock (409) handlers: they hold a fresh lock but
 * no full payload — reuse the last-seen items so the pill can still name
 * the running item (ageMs comes from the fresh lock). */
function renderLock(lock) {
  renderRunState({ lock: lock, items: (CURRENT && CURRENT.items) || [] });
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

/* Glance collapse toggle — delegated to the permanent #glance container for
 * the same reason the parking lot delegates: renderGlance replaces the
 * container's innerHTML on every changed payload, so a listener on the
 * generated summary button would not survive the next status event. The
 * summary is a <button type="button">, so Enter/Space synthesize the same
 * click — no separate keydown path. */
$('glance').addEventListener('click', function (ev) {
  if (!ev.target.closest('button[data-glance-summary]')) return;
  applyGlanceCollapsed(!glanceCollapsed);
});

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

/* Header RUNNING clock: one interval, created once at init. Each status
 * event re-anchors the elapsed time from lock.ageMs (renderRunState); between
 * events this tick extrapolates from the anchor. Cheap no-op — no DOM touch
 * at all — when the factory is not running. */
setInterval(function () {
  if (!runAnchor.running) return;
  var clock = $('run-clock');
  if (clock) clock.textContent = fmtMMSS(runAnchor.ageMs + (Date.now() - runAnchor.at));
}, 1000);

/* Bonus affordance: clicking the RUNNING pill scrolls to the glance row,
 * auto-expanding it first if it is collapsed (a display:none chip can neither
 * be scrolled to nor produce a visible wb-flash), then one-shot-flashes the
 * running item's chip (wb-flash, removed on animationend so a later click can
 * re-fire it). */
$('run-state').addEventListener('click', function () {
  if (!runAnchor.running) return;
  applyGlanceCollapsed(false); // expand before scroll/flash — order matters
  var glance = $('glance');
  if (glance.scrollIntoView) glance.scrollIntoView({ behavior: 'smooth', block: 'start' });
  (runAnchor.itemIds || []).forEach(function (id) {
    var chip = glance.querySelector('[data-item-id="' + String(id) + '"]');
    if (!chip) return;
    chip.classList.remove('wb-flash');
    chip.classList.add('wb-flash');
    chip.addEventListener('animationend', function () { chip.classList.remove('wb-flash'); }, { once: true });
  });
});

/* Instant paint ahead of the first SSE snapshot (identical shared payload). */
refreshStatus();
</script>
</body>
</html>
`;
