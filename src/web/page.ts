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
 * The item detail overlay (see specs/wb-serve-item-overlay.md) renders item
 * and artifact markdown through a minimal hand-written renderer that is
 * escaped-first and fail-closed: raw markdown text goes through esc() before
 * any span recognition, and link targets are scheme-restricted to http:,
 * https:, and relative paths — a hostile item file or artifact can never
 * execute anything in the page.
 *
 * XSS discipline (KB 2026-10-27 22:00 — the browser is an interpreter):
 * every untrusted string (titles, feedback, questions, reasons, artifact
 * names, repo paths, slugs from the stream) goes through `esc()` at the
 * interpolation site or is assigned via `textContent`; `innerHTML` receives
 * only escaped/structural markup. All actions are same-origin fetch POSTs
 * with `Content-Type: application/json`; no CORS headers are emitted. The
 * glance section's collapse state is client-side only (one module-level var,
 * always collapsed on load) — never persisted, no localStorage. The in-flight
 * panel's collapse follows the same module-level pattern, but an EXPLICIT user
 * toggle is persisted ('wb:flight-panel' in localStorage — a UI-only preference,
 * no server state, no new seam); the built-in default (open iff items are in
 * flight) applies only when no choice was ever stored.
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
  /* Disabled buttons (Start Processing while a live drive runs): no pointer
   * affordance, no hover darken. The wb-spin spinner class + keyframes live
   * with the other component rules below (single definition), so
   * prefers-reduced-motion retires every animation in one place. */
  .btn:disabled { cursor: default; }
  .btn-dark:disabled { background: #1c1917; }
  .btn-dark:disabled:hover { background: #1c1917; } /* suppress the hover darken */

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
  .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
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
  .space-y-2 > * + * { margin-top: 0.5rem; }
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
  .min-w-0 { min-width: 0; }
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
/* Fix 2 (reviewer): missing text-left utility — buttons default to centered
 * text in the UA stylesheet; the page preflight resets font/color/background
 * only. Both the clickable inbox tile and the data-flight-row cards relied
 * on this class without it existing, visibly centering their content in
 * Chrome/Safari. */
  .text-left { text-align: left; }
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
  .text-indigo-800 { color: #3730a3; }
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
  .bg-indigo-100 { background-color: #e0e7ff; }
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
  .border-ink-100 { border-color: #f5f5f4; } /* matches .bg-ink-100 */
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
  /* Spinner for in-flight states (the RUNNING pill and the busy Run
   * button). currentColor keeps it visible inside both the blue pill and
   * the dark button with no new palette entries; the size is pinned here
   * because the page's utility set has no h-3/w-3. */
  .wb-spin { display: inline-block; width: 12px; height: 12px; border-radius: 9999px; border: 2px solid currentColor; border-top-color: transparent; animation: wb-spin .8s linear infinite; }
  @keyframes wb-spin { to { transform: rotate(360deg); } }
  .btn:disabled { opacity: .5; cursor: default; }
  /* prefers-reduced-motion: the animation-carrying affordances (the RUNNING
   * pulse, the pill-click flash, the spinners) all degrade to their static
   * presentation — the click/scroll actions themselves still work. */
  @media (prefers-reduced-motion: reduce) {
    .animate-pulse, .wb-flash, .wb-spin { animation: none; }
  }
  .cursor-pointer { cursor: pointer; }
  .accent-indigo-600 { accent-color: #4f46e5; }
  /* Item detail overlay: fixed, z-60 (above #toast's z-50 so the overlay
   * covers the toast zone), backdrop-blurred, independently scrollable so
   * long specs stay readable. The panel reuses the shadow-lg stack and the
   * max-w-3xl width vocabulary. */
  .wb-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 60; background: rgba(28, 25, 23, .45); backdrop-filter: blur(8px); display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; padding: 2.5rem 1rem; }
  /* Same-specificity source order must NOT let the open-state flex beat the
   * closed-state .hidden (Greptile PR-32 #1): as written below, the overlay
   * rendered a full-screen backdrop from page load, and close()'s re-added
   * .hidden could never re-hide it. The combined rule makes the closed state
   * win whenever both classes are present. */
  .wb-overlay.hidden { display: none; }
  .wb-overlay-panel { background: #fff; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, .1), 0 4px 6px -4px rgba(0, 0, 0, .1); width: 100%; max-width: 48rem; }

/* ---- important / hover variants ---- */
  .\\!bg-red-600 { background-color: #dc2626 !important; }
  .hover\\:\\!bg-red-700:hover { background-color: #b91c1c !important; }
  .hover\\:bg-indigo-700:hover { background-color: #4338ca; }
  .hover\\:bg-indigo-50\\/50:hover { background-color: rgba(238, 242, 255, 0.5); }
  .hover\\:bg-indigo-100:hover { background-color: #e0e7ff; }
  .hover\\:bg-ink-100:hover { background-color: #f5f5f4; }
  .hover\\:text-ink-700:hover { color: #57534e; }
</style>
</head>
<body class="bg-paper text-ink-900">

<header class="border-b border-ink-200 bg-white/80 backdrop-blur px-5 py-3 flex items-center gap-3 flex-wrap sticky top-0 z-20">
  <div class="font-mono font-bold text-lg tracking-tight"><span class="text-ink-950">wb</span><span class="text-ink-400"> — factory workbench</span></div>
  <div id="run-state" class="hidden"></div>
  <div class="ml-auto flex items-center gap-2">
    <span id="feed-status" class="text-xs text-ink-400"></span>
    <button id="btn-run" class="btn btn-dark">▶ Start Processing</button>
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
          <span>start processing now — claim and drive the factory until it parks (approval gates still stop it)</span>
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

<div id="item-overlay" class="wb-overlay hidden" role="dialog" aria-modal="true" aria-label="work item detail"></div>
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
  approved: '#059669', 'rejected-by-human': '#dc2626', archived: '#78716c', 'drive-interrupted': '#ea580c'
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
  /* Run single-flight retirement: a 202 has been received and no POST is
   * pending — this is the first status snapshot after the server (which
   * acquires the lock synchronously before responding) reported the run.
   * The status fingerprint embeds the lock, so this snapshot necessarily
   * reflects the new lock truth (acquired, or already released by a
   * fast-finished drive) — either way the Run button must come back. */
  if (runInFlight && flightAwaited && !flightPending) clearRunFlight();
  renderPulse(p);
  renderDatalist(p.knownRepos || []);
  renderParking(p);
  renderGlance(p);
  renderRunState(p);
}

function tile(accent, big, small, title, sub, clickable) {
  /* The inbox tile is the operator's only "a number, but no way to act on
   * it" surface — when the inbox is non-empty it renders as a real
   * <button> (keyboard path, see the glance-summary note) that expands the
   * glance section where the claimable spec chips live. Same card look, plus
   * the standard hover affordance shared with the other clickable rows. */
  var open = '<div class="rounded-xl border border-ink-200 bg-white shadow-sm p-4 pl-5 relative overflow-hidden">';
  var close = '</div>';
  if (clickable) {
    open = '<button type="button" data-tile-inbox title="review the inbox specs — expands Factory at a glance" ' +
      'class="rounded-xl border border-ink-200 bg-white shadow-sm p-4 pl-5 relative overflow-hidden text-left cursor-pointer hover:bg-indigo-50/50 transition-colors">';
    close = '</button>';
  }
  return open +
    '<div class="absolute left-0 top-0 bottom-0 w-1 ' + accent + '"></div>' +
    '<div class="text-3xl font-bold tabular-nums leading-none ' + accent.replace('bg-', 'text-') + '">' + big +
    (small ? '<span class="text-sm font-medium text-ink-400"> ' + small + '</span>' : '') + '</div>' +
    '<div class="text-xs font-semibold text-ink-700 mt-1.5">' + esc(title) + '</div>' +
    '<div class="text-[10px] text-ink-400 uppercase tracking-wide">' + esc(sub) + '</div>' + close;
}

function renderPulse(p) {
  var c = p.counts;
  /* Pulse-tile row (flight-panel spec D1): three tiles in lifecycle/flow
   * order — inbox → in flight → waiting on you — the eye walks the same
   * direction the items do. The landed tile is dropped from the row: a
   * monotonic lifetime counter is not an attention tile. Landed stays where
   * it belongs — the flow bar's done segment (below) and the glance chips
   * (unchanged). Accent colors stay attached to their tiles. */
  var html = '<div class="grid grid-cols-3 gap-3">' +
    tile('bg-ink-400', c.inbox, '', 'inbox', 'awaiting claim', c.inbox > 0) +
    tile('bg-blue-500', c.running, '+ ' + c.queued, 'in flight', 'running + queued') +
    tile('bg-amber-400', c.decisions, '', 'waiting on you', 'decisions pending') +
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
  /* The panel rides under the flow bar inside #pulse — the same pulse band it
   * details, directly above the composer (flight-panel spec D2). Its markup
   * is part of the status-driven render, so SSE snapshots keep it live.
   * Keyboard focus carry across the innerHTML replacement (renderGlance/
   * renderRunState pattern): capture BEFORE the write — activeElement is
   * already <body> the moment innerHTML is replaced — then restore to the
   * new summary button so Enter/Space keep toggling without a Tab-back. */
  var focusSel = null;
  var activeEl = document.activeElement;
  if (activeEl && activeEl.closest) {
    // Reviewer finding 3: the inbox tile is a second focusable the ~2s SSE
    // re-render can destroy — carry focus for it exactly like the flight
    // summary (which keeps its restore path below).
    if (activeEl.closest('button[data-tile-inbox]')) focusSel = 'button[data-tile-inbox]';
    else if (activeEl.closest('button[data-flight-summary]')) focusSel = 'button[data-flight-summary]';
  }
  $('pulse').innerHTML = html + bar + flightPanelHtml(p);
  if (focusSel) {
    var fbtn = $('pulse').querySelector(focusSel);
    if (fbtn && fbtn.focus) fbtn.focus();
  }
}

/* In-flight detail panel (flight-panel spec D2/D3). Rows come straight from
 * the snapshot's items — every queued/running item, nothing else — so no
 * backend or StatusPayload change is involved. One row: title + repo, the
 * six-dot stage-progress track (the same stageDots the parking-lot cards
 * render; queued items are all-hollow), and a stage label pill — the
 * running item's current stage name, or 'queued'. Collapse state follows
 * the glance pattern (one module-level var, recomputed per render) with one
 * addition: FLIGHT_PREF_KEY stores an explicit user choice in localStorage
 * ('open' | 'collapsed', UI-only) which always beats the default — open
 * when running+queued > 0, closed when 0. A payload re-render never
 * auto-expands against a stored choice; it only repaints the header counts
 * (always visible) and, when open, the rows. */
var FLIGHT_PREF_KEY = 'wb:flight-panel';
var flightCollapsed = true;
/* In-memory mirror of the last EXPLICIT user toggle, kept for the case where
 * storage writes fail while reads succeed: the next snapshot (~2s SSE) would
 * otherwise re-derive the default and silently undo the user's click
 * mid-session. A persisted-but-STALE pref is the same trap: the stored value
 * predates this session's click, so when the write throws the click — the
 * newest user signal — must win. Precedence per render:
 * flightExplicit > stored pref > default (pre-toggle and fresh-session, the
 * stored pref is the newest signal and wins over the default). */
var flightExplicit = null;

function flightPref() {
  try {
    var v = localStorage.getItem(FLIGHT_PREF_KEY);
    if (v === 'open') return false;
    if (v === 'collapsed') return true;
  } catch (e) { /* storage unavailable (fresh context, private mode): the default applies */ }
  return null;
}

function flightPanelHtml(p) {
  var inFlight = (p.items || []).filter(function (it) { return it.status === 'queued' || it.status === 'running'; })
    .sort(function (a, b) {
      // Running rows first (attention order), then queued; both by id.
      var qa = (a.status === 'running' ? 0 : 1);
      var qb = (b.status === 'running' ? 0 : 1);
      return (qa - qb) || (a.id - b.id);
    });
  var runningCount = 0, queuedCount = 0;
  inFlight.forEach(function (it) { if (it.status === 'running') runningCount++; else queuedCount++; });
  var segments = [];
  if (runningCount > 0) segments.push(runningCount + ' running');
  if (queuedCount > 0) segments.push(queuedCount + ' queued');

  var pref = flightPref();
  flightCollapsed = flightExplicit !== null ? flightExplicit : (pref !== null ? pref : (inFlight.length === 0));

  var body;
  if (inFlight.length === 0) {
    /* Open while empty is the user's explicit state — never a blank void. */
    var landed = (p.counts && p.counts.done) || 0;
    body = '<div class="text-xs text-ink-400">factory idle — ' + landed + ' landed</div>';
  } else {
    body = '<div class="space-y-2">' + inFlight.map(function (it) {
      var label = it.status === 'running' ? esc(it.stage || 'starting') : 'queued';
      var pill = STATUS_PILL[it.status] || 'bg-ink-100 text-ink-700 ring-ink-300';
      return '<button type="button" data-flight-row="' + it.id + '" class="w-full text-left rounded-lg border border-ink-200 bg-white/70 p-2.5 cursor-pointer" title="view detail">' +
        '<div class="flex items-start justify-between gap-2">' +
        '<div class="min-w-0"><div class="text-sm font-medium">' + esc(it.title) + '</div>' +
        '<div class="text-[11px] font-mono text-ink-500 mt-0.5">' + esc(it.repo) + '</div></div>' +
        '<span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ' + pill + '">' + label + '</span>' +
        '</div>' + stageDots(it) + '</button>';
    }).join('') + '</div>';
  }
  return '<div class="mt-3 rounded-2xl border border-ink-200 bg-white shadow-sm">' +
    // A <button type="button">: Enter/Space synthesize the same click the
    // delegated #pulse listener handles — the shared click path IS the
    // keyboard path (glance-toggle pattern).
    '<button type="button" data-flight-summary aria-expanded="' + (flightCollapsed ? 'false' : 'true') + '" title="expand/collapse the in-flight detail" ' +
    'class="w-full flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-indigo-50/50 transition-colors">' +
    '<span class="flex items-center gap-2">' +
    '<span data-flight-glyph class="text-ink-400 font-mono">' + (flightCollapsed ? '▸' : '▾') + '</span>' +
    '<span class="font-semibold text-sm">In flight</span>' +
    (segments.length ? '<span class="text-ink-500 text-xs">· ' + segments.join(' · ') + '</span>' : '') +
    '</span>' +
    '<span class="text-ink-400 text-xs font-mono tabular-nums">' + inFlight.length + '</span>' +
    '</button>' +
    '<div id="flight-body" class="border-t border-ink-100 p-4 space-y-2' + (flightCollapsed ? ' hidden' : '') + '">' + body + '</div>' +
    '</div>';
}

/* The single writer of in-flight collapse state on toggle — surgical DOM
 * updates, never a re-render (same reasoning as applyGlanceCollapsed: a full
 * repaint would destroy the just-clicked button and drop keyboard focus).
 * Payload re-renders instead rebuild the panel from flightCollapsed, which
 * renderPulse re-derives from the preference/default on every snapshot.
 * classList add/remove only — the runtime-test stub has no toggle. */
function applyFlightCollapsed(collapsed) {
  flightCollapsed = collapsed;
  var body = $('flight-body');
  if (!body) return;
  if (collapsed) body.classList.add('hidden'); else body.classList.remove('hidden');
  var glyph = $('pulse').querySelector('[data-flight-glyph]');
  if (glyph) glyph.textContent = collapsed ? '▸' : '▾';
  var btn = $('pulse').querySelector('button[data-flight-summary]');
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
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
  /* Queued rows (the in-flight panel) render all six dots hollow — a queued
   * item has not entered any stage yet, whatever its record's last stage
   * says (flight-panel spec D2). Parking-lot cards never have this status. */
  var doneThrough = it.status === 'queued' ? -1 : STAGES.indexOf(it.stage);
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
      'Rejected — the reason rides as feedback into the next agent run. Re-queue with <span class="font-mono">Start Processing</span> (it recovers every rejected item).</div>';
  }
  html += feedbackBox(it.feedback);

  html += '</div>'; // /space-y

  // actions
  html += '<div class="mt-4 flex items-center gap-2 flex-wrap">';
  // Detail affordance on every card (Greptile PR-32 finding 5): the card
  // itself must stay a div (a button cannot legally contain the note/reject
  // inputs the actions below render), so the keyboard path to the detail
  // overlay is this real <button> — mouse users keep the whole-card click.
  // On approval cards it is also the "read before approving" nudge: the old
  // raw-file artifact link (a new tab of unrendered markdown) duplicated
  // exactly what the overlay provides, minus the rendering, so it became a
  // mid-decision context switch; the overlay's per-artifact View raw links
  // keep the raw escape hatch for anyone who wants it.
  var detailTitle = it.status === 'awaiting-approval'
    ? 'read the spec before approving or rejecting'
    : 'view the full detail: spec, artifacts, source';
  html += '<button type="button" data-action="detail" class="btn btn-out" title="' + detailTitle + '">Details</button>';
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

/* Glance chip cap (recency window): the default render keeps only the
 * newest GLANCE_CAP landed chips — with a 26-done backlog the tail is
 * landed history nobody scans, and every chip costs a line of wrap.
 * Running/queued chips are NEVER capped (see the partition note inside
 * renderGlance). "More…" below reveals the rest in one click (no
 * pagination: payloads are small and the overlay fetches per item
 * anyway); "show the newest N only" restores the window. glanceShowAll is
 * sticky for the session — payload re-renders re-derive from it, the same
 * single-writer pattern as glanceCollapsed. */
var GLANCE_CAP = 10;
var glanceShowAll = false;

function renderGlance(p) {
  /* Newest first: the operator reviews recency — the just-landed PRs are the
   * interesting end of a 26-done backlog, and db.listItems feeds payloads
   * ascending by id (oldest first), which buried them at the end. */
  var glance = p.items.filter(function (it) { return it.status === 'running' || it.status === 'queued' || it.status === 'done'; })
    .sort(function (a, b) { return b.id - a.id; });
  /* Reviewer finding 1 — live work escapes the cap: running/queued chips
   * render unconditionally, because the #26 RUNNING-pill flash affordance
   * queries chips by data-item-id, and a long-running item (#2, say) can
   * easily sit below 10 newer landed items — capping it would silently
   * no-op the flash the pill promises. The cap applies to done only (it
   * exists for landed history); the merged list keeps the newest-first
   * order (live work leads, then the landed window). Live work is always
   * few — the cap would never fit more than a couple of live chips anyway.
   */
  var live = glance.filter(function (it) { return it.status !== 'done'; });
  var landed = glance.filter(function (it) { return it.status === 'done'; });
  var capped = !glanceShowAll && landed.length > GLANCE_CAP;
  var visible = live.concat(capped ? landed.slice(0, GLANCE_CAP) : landed);
  var chips = visible.map(function (it) {
    var hint = '';
    if (it.status === 'queued' && it.parkedReason === 'stale-base' && it.parkedDetail && it.parkedDetail.repo) {
      hint = '<span class="text-ink-400" title="stale base: ' + esc(it.parkedDetail.base) + ' is behind origin/' + esc(it.parkedDetail.base) + '">⚑ git pull in ' + esc(it.parkedDetail.repo) + '</span>';
    }
    var pr = '';
    if (it.status === 'done' && it.prUrl) {
      pr = '<a href="' + esc(it.prUrl) + '" target="_blank" rel="noopener" class="text-emerald-700 underline underline-offset-2">PR' +
        (it.prDraft ? ' (draft)' : '') + '</a>';
    }
    /* Two-tier chip styling: running/queued are live work — the active white
     * chip; done is landed history — muted gray so the recency sort (newest
     * first) reads as "fading into the past" and the indigo inbox chips stay
     * the loudest thing in the section. The PR link keeps its own color. */
    var chipCls = it.status === 'done'
      ? 'inline-flex items-center gap-2 rounded-full border border-ink-100 bg-ink-100/70 px-3 py-1.5 text-xs text-ink-500 cursor-pointer hover:bg-ink-100 transition-colors'
      : 'inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs shadow-sm cursor-pointer hover:bg-indigo-50/50 transition-colors';
    return '<button type="button" data-item-id="' + it.id + '" class="' + chipCls + '" title="view detail">' +
      '<span class="h-1.5 w-1.5 rounded-full ' + (STATUS_DOT[it.status] || 'bg-ink-300') + (it.status === 'running' ? ' animate-pulse' : '') + '"></span>' +
      '<span class="font-medium">#' + it.id + ' ' + esc(it.slug) + '</span>' +
      '<span class="text-ink-400">' + esc(it.stage || '') + '</span>' + hint + '</button>' + pr;
  }).join('');
  /* Chip-window control — a plain text button under the chips. Static words
   * + numbers only (no untrusted data), the same esc-free rule as the
   * summary segments. The click handler swaps glanceShowAll and re-renders
   * from CURRENT — no fetch, no server change. */
  var moreCtl = '';
  if (capped) {
    var hiddenN = landed.length - GLANCE_CAP;
    moreCtl = '<div class="mt-2"><button type="button" data-glance-more title="show the remaining ' + hiddenN + ' older items" class="text-xs text-ink-500 underline underline-offset-2 cursor-pointer hover:text-ink-700">More… (' + hiddenN + ' older)</button></div>';
  } else if (glanceShowAll && landed.length > GLANCE_CAP) {
    moreCtl = '<div class="mt-2"><button type="button" data-glance-less title="drop back to the newest ' + GLANCE_CAP + ' items" class="text-xs text-ink-500 underline underline-offset-2 cursor-pointer hover:text-ink-700">show the newest ' + GLANCE_CAP + ' only</button></div>';
  }
  var inbox = (p.inbox.claimable || []).map(function (f) {
    /* A real <button>: the detail overlay's inbox entry point must be
     * reachable by keyboard (Greptile PR-32 finding 5) — a bare div with a
     * hover cursor had no focus target and no Enter/Space path.
     * Attention styling, not muted: indigo accent + solid border + shadow —
     * the OLD dashed/50%-white/gray look read as disabled, which is exactly
     * why the claimable specs went unnoticed. The muted look now belongs to
     * the landed chips (below), the low-interest end of the glance. */
    return '<button type="button" data-inbox-file="' + esc(f) + '" class="inline-flex items-center gap-2 rounded-full border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-800 shadow-sm cursor-pointer hover:bg-indigo-100 transition-colors" title="review this unclaimed spec">📄 ' + esc(f) + '</button>';
  }).join('');
  var skipped = (p.inbox.alreadyClaimed || []).map(function (s) {
    return '<div class="text-[11px] text-ink-400">⚠ ' + esc(s.file) + ' will be skipped — slug already claimed (#' + s.item.id + ', ' + esc(s.item.status) + ')</div>';
  }).join('');
  /* The inbox-unreadable row renders OUTSIDE the collapsible body (and in the
   * empty state) — a failure that was always visible pre-collapse must not
   * hide behind display:none when the section is collapsed. */
  var errorRow = p.inbox.error ? '<div class="text-[11px] text-red-600">inbox unreadable: ' + esc(p.inbox.error) + '</div>' : '';
  /* Keyboard focus carried across the innerHTML replacement (Greptile PR-33
   * finding): the summary button AND the chip-window controls are all
   * focusables a payload re-render can destroy — capture which one was
   * focused BEFORE the write, restore to the new twin after (Enter/Space
   * keep working without a Tab-back from <body>). */
  var focusSel = null;
  var activeEl = document.activeElement;
  if (activeEl && activeEl.closest) {
    if (activeEl.closest('button[data-glance-summary]')) focusSel = 'button[data-glance-summary]';
    else if (activeEl.closest('button[data-glance-more]')) focusSel = 'button[data-glance-more]';
    else if (activeEl.closest('button[data-glance-less]')) focusSel = 'button[data-glance-less]';
  }
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
  /* Collapsed-by-default section (spec §Page): a single clickable summary row
   * hides the chip/inbox detail behind #glance-body until toggled. The empty
   * state (no chips AND no inbox/skipped/error rows) keeps the plain line and
   * no toggle. Counts come from the same glance filter the chips use — only
   * static words + numbers enter the summary (no untrusted data, no esc gap). */
  if (glance.length === 0 && !inbox && !skipped && !errorRow) {
    $('glance').innerHTML =
      '<div class="border-t border-ink-200 pt-6">' +
      '<div class="text-[11px] font-semibold uppercase tracking-widest text-ink-400 mb-3">Factory at a glance</div>' +
      '<div class="text-xs text-ink-400">no items in flight</div>' +
      errorRow +
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
    moreCtl +
    ((inbox || skipped) ? '<div class="mt-4 flex flex-wrap gap-2">' + inbox + '</div><div class="mt-2 space-y-0.5">' + skipped + '</div>' : '') +
    '</div>' +
    errorRow +
    '</div>';
  if (focusSel) {
    var restore = $('glance').querySelector(focusSel);
    if (restore && restore.focus) restore.focus();
  }
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

/* Header run-state pill — a five-state operator machine (spec §Page),
 * derived client-side on EVERY status payload (and on the 409 renderLock
 * shim path) from data already present; no new API, no server change.
 * Priority: RUNNING (live lock) > INTERRUPTED (running items with NO live
 * lock — a drive died mid-stage; the payload's 'interrupted' signal) >
 * verbatim stale-lock text (dead holder — informational, kept ahead of
 * the operator states so a dead lock is never silently displaced by a
 * state that doesn't mention it; INTERRUPTED outranks it only because its
 * pill names the dead holder pid itself, preserving the information and
 * attaching the recovery action) > NEEDS REVIEW (no live lock,
 * counts.decisions > 0) > PAUSED (no lock, zero decisions, at least one
 * queued/running item) > IDLE. The clock machinery (#26) stays
 * as-is within RUNNING: runAnchor is re-derived from lock.ageMs on every
 * lock.alive payload; a single 1s interval (created once, at init)
 * extrapolates between events — no extra polling. payloadLike is a whole
 * status payload (render) or a {lock} fragment (409 handlers, via the
 * renderLock shim); on the shim path a lock is always present, so the
 * machine always lands in a lock branch and the missing counts never
 * matter. */
var runStateKind = 'idle'; // set on every render — read by the delegated click handler
var runAnchor = { ageMs: 0, at: 0, running: false, itemIds: [] };

/* Header Start Processing button (spec §Page): idle reads "▶ Start
 * Processing"; while a LIVE factory lock exists (a drive in flight) it is
 * disabled and reads "Processing…" with a wb-spin spinner. The button and
 * never-disabled run-state pill share the same stop hint, including the
 * actual holder pid. A stale (dead) holder is not a drive in progress —
 * enabled, hints cleared. Repeated paints in the same busy/idle state leave
 * innerHTML untouched so the spinner animation does not restart. */
var lastRunButtonBusy = null;
function renderRunButton(p) {
  var btn = $('btn-run');
  var lock = (p && p.lock) || null;
  var busy = !!(lock && lock.alive);
  var hint = busy
    ? 'Processing — a drive is in progress (lock holder pid ' + lock.pid + '). To stop, end the command holding the lock (wb serve or wb run/wb resume in its terminal).'
    : '';
  btn.title = hint;
  $('run-state').title = hint;
  if (runInFlight) return; // the flight writer owns the button until the next snapshot retires it
  if (lastRunButtonBusy === busy) return;
  lastRunButtonBusy = busy;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.innerHTML = busy
    ? '<span class="wb-spin" aria-hidden="true"></span>Processing…'
    : '▶ Start Processing';
}

function deriveRunState(lock, decisions, actionable, interrupted) {
  if (lock && lock.alive) return 'running';
  if (interrupted) return 'interrupted'; // running items, no live lock — a dead drive
  if (lock) return 'stale';              // dead holder — verbatim stale text, unchanged
  if (decisions > 0) return 'review';
  if (actionable >= 1) return 'paused';
  return 'idle';
}

function renderRunState(p) {
  var el = $('run-state');
  renderRunButton(p);
  var lock = (p && p.lock) || null;
  var counts = (p && p.counts) || null;
  var decisions = counts ? (counts.decisions || 0) : 0;
  var actionable = counts ? ((counts.queued || 0) + (counts.running || 0)) : 0;
  var interrupted = (p && p.interrupted) || null;
  runStateKind = deriveRunState(lock, decisions, actionable, interrupted);
  if (runStateKind === 'idle') {
    runAnchor.running = false;
    el.innerHTML = '<span class="rounded-full text-[10px] font-semibold tracking-widest text-ink-400 bg-white ring-1 ring-ink-200 px-3 py-1">IDLE</span>';
    el.classList.remove('hidden');
    return;
  }
  if (runStateKind === 'stale') {
    runAnchor.running = false;
    var mins = Math.floor((lock.ageMs || 0) / 60000);
    var age = mins < 1 ? 'just started' : mins + ' min ago';
    el.innerHTML = '<span class="rounded-full text-xs bg-amber-100 text-amber-800 ring-1 ring-amber-300 px-3 py-1">' +
      'stale factory lock (pid ' + esc(lock.pid) + ', ' + esc(age) + ') — holder is not running</span>';
    el.classList.remove('hidden');
    return;
  }
  /* Keyboard focus carry across the innerHTML replacement (the renderGlance
   * pattern): status events re-render #run-state on every changed
   * fingerprint, which would otherwise drop a keyboard user off the pill to
   * <body>. Only the button states need it — IDLE/stale are spans. */
  var hadFocus = !!(document.activeElement && document.activeElement.closest &&
    document.activeElement.closest('button') && (!el.contains || el.contains(document.activeElement)));
  var html = '';
  if (runStateKind === 'running') {
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
    html =
      // A <button> (not a div): keyboard users can Tab to the pill and press
      // Enter/Space for the same scroll-and-flash action. The preflight resets
      // button chrome (border 0, transparent bg, inherited font), so the pill
      // renders identically to the former div.
      '<button type="button" class="rounded-full ring-1 ' + STATUS_PILL.running + ' text-xs px-3 py-1 inline-flex items-center gap-1.5 cursor-pointer" title="factory pid ' + esc(lock.pid) + '">' +
      '<span class="wb-spin shrink-0"></span>' +
      '<span class="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"></span>' +
      '<span class="text-[10px] font-semibold tracking-widest">RUNNING</span>' +
      '<span>· ' + frag + '</span>' +
      '<span class="font-mono tabular-nums" id="run-clock">' + fmtMMSS(runAnchor.ageMs) + '</span>' +
      '</button>';
  } else if (runStateKind === 'interrupted') {
    // A drive ended without a parking decision while an item was mid-stage:
    // the PAUSED-shaped state gets its WHY. The payload's 'interrupted'
    // signal names the items and the last known lock holder (pid where
    // knowable, else the honest "no live factory lock"). Clicking the pill is
    // the SAME recovery action as Start Processing (recovery contract
    // unchanged) — pressRun() in the delegated click handler. Orange (infra
    // family), distinct from the amber NEEDS REVIEW and stone PAUSED.
    runAnchor.running = false;
    var ints = (interrupted && interrupted.items) || [];
    var intNames = ints.map(function (it) {
      return '#' + it.id + ' ' + esc(it.slug) + ' at ' + esc(it.stage || '');
    }).join(' · ');
    var holderClause = interrupted && typeof interrupted.lastHolder === 'number'
      ? '(last holder pid ' + esc(interrupted.lastHolder) + ')'
      : '(no live factory lock)';
    html =
      '<button type="button" class="rounded-full ring-1 ' + STATUS_PILL['infrastructure-failure'] + ' text-xs px-3 py-1 inline-flex items-center gap-1.5 cursor-pointer" title="the previous drive did not end cleanly — press Start Processing to recover">' +
      '<span class="h-1.5 w-1.5 rounded-full bg-orange-500"></span>' +
      '<span class="text-[10px] font-semibold tracking-widest">INTERRUPTED</span>' +
      '<span>· drive did not end cleanly — ' + intNames + ' ' + holderClause + ' — <span class="text-blue-700">press Start Processing</span></span>' +
      '</button>';
  } else if (runStateKind === 'review') {
    // The first pending thing, in the parking lot's own order (every parked
    // item carries a non-empty stage; 'parked' is a defensive fallback).
    var first = (p.items || []).filter(isParked).sort(byParkOrder)[0];
    html =
      '<button type="button" class="rounded-full ring-1 ' + STATUS_PILL['awaiting-approval'] + ' text-xs px-3 py-1 inline-flex items-center gap-1.5 cursor-pointer" title="items are parked waiting on you — click to jump to the parking lot">' +
      '<span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span>' +
      '<span class="text-[10px] font-semibold tracking-widest">NEEDS REVIEW</span>' +
      '<span>· ' + decisions + ' parked — #' + (first ? first.id : 0) + ' at ' + esc((first && first.stage) || 'parked') + '</span>' +
      '</button>';
  } else { // paused
    var next = (p.items || []).filter(function (it) { return it.status === 'queued' || it.status === 'running'; })
      .sort(function (a, b) { return a.id - b.id; })[0];
    html =
      '<button type="button" class="rounded-full ring-1 ' + STATUS_PILL.queued + ' text-xs px-3 py-1 inline-flex items-center gap-1.5 cursor-pointer" title="press Start Processing — clicking here does the same">' +
      '<span class="h-1.5 w-1.5 rounded-full ' + STATUS_DOT.queued + '"></span>' +
      '<span class="text-[10px] font-semibold tracking-widest">PAUSED</span>' +
      '<span>· <span class="text-blue-700">press Start Processing</span> — #' + (next ? next.id : 0) + ' at ' + esc((next && next.stage) || 'parked') + '</span>' +
      '</button>';
  }
  el.innerHTML = html;
  el.classList.remove('hidden');
  if (hadFocus) {
    var btn = el.querySelector('button');
    if (btn && btn.focus) btn.focus();
  }
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
  if (row.event === 'drive-interrupted') {
    return typeof d.lastHolder === 'number'
      ? ' — item requeued (last holder pid ' + d.lastHolder + ')'
      : ' — item requeued (holder unknown)';
  }
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
 * click — no separate keydown path. The same delegated listener is also the
 * item-detail overlay's glance entry point: a chip click ([data-item-id])
 * or a claimable inbox file click ([data-inbox-file]) opens the overlay. */
$('glance').addEventListener('click', function (ev) {
  if (ev.target.closest && ev.target.closest('button[data-glance-summary]')) {
    applyGlanceCollapsed(!glanceCollapsed);
    return;
  }
  // Chip-window controls: "More…" reveals the capped older chips, "show the
  // newest 10 only" restores the default. renderGlance(CURRENT) repaints
  // from the last full payload — no fetch; the just-clicked button is
  // replaced by the re-render (the control is intentionally one-shot).
  // Reviewer finding 3: the clicked window control is destroyed by the
  // re-render — re-focus its counterpart so Enter keeps working from inside
  // the section instead of ejecting a keyboard user to <body>.
  var more = ev.target.closest && ev.target.closest('button[data-glance-more]');
  if (more) {
    glanceShowAll = true; renderGlance(CURRENT);
    var m = $('glance').querySelector('button[data-glance-less]');
    if (m && m.focus) m.focus();
    return;
  }
  var less = ev.target.closest && ev.target.closest('button[data-glance-less]');
  if (less) {
    glanceShowAll = false; renderGlance(CURRENT);
    var l = $('glance').querySelector('button[data-glance-more]');
    if (l && l.focus) l.focus();
    return;
  }
  // Links keep their own behavior (Greptile PR-32 finding 7 — the rule the
  // parking-lot handler already applies): a chip's PR anchor opens the PR in
  // its tab; it must not also open the detail overlay behind it.
  if (ev.target.closest && ev.target.closest('a')) return;
  var chip = ev.target.closest && ev.target.closest('[data-item-id]');
  if (chip) {
    // The stable chip element is the opener (not ev.target): focus restore on
    // close lands on a real element, and the retry path re-uses the ORIGINAL
    // opener (finding 4).
    openItemOverlay('item', Number(chip.getAttribute('data-item-id')), chip);
    return;
  }
  var inb = ev.target.closest && ev.target.closest('[data-inbox-file]');
  if (inb) {
    openItemOverlay('inbox', inb.getAttribute('data-inbox-file'), inb);
  }
});

/* In-flight panel collapse toggle — delegated to the permanent #pulse
 * container (renderPulse replaces the panel's innerHTML on every changed
 * payload, so a listener on the generated summary button would not survive
 * the next status event; same reasoning as the glance toggle). The summary
 * is a <button type="button">, so Enter/Space synthesize the same click —
 * the shared click listener IS the keyboard path. The new state is
 * persisted immediately as an explicit user choice, which then always
 * beats both the open/close default and any persisted-but-stale pref (the
 * flightExplicit write-failure case) — newest user signal wins (flight-panel
 * spec D3). */
$('pulse').addEventListener('click', function (ev) {
  if (ev.target.closest && ev.target.closest('button[data-flight-summary]')) {
    var collapsed = !flightCollapsed;
    flightExplicit = collapsed; // session-sticky; beats even a stale stored pref when the write fails
    try { localStorage.setItem(FLIGHT_PREF_KEY, collapsed ? 'collapsed' : 'open'); } catch (e) { /* storage unavailable: flightExplicit keeps the choice for the session */ }
    applyFlightCollapsed(collapsed);
    return;
  }
  // Inbox pulse-tile entry: the tile is a real <button> while the inbox is
  // non-empty (renderPulse). Clicking it drives the EXISTING glance writer —
  // applyGlanceCollapsed(false), the same one the glance summary toggle uses,
  // so a payload re-render keeps the section open (glanceCollapsed is the
  // single source of truth) — then scrolls the glance section into view and
  // focuses the first claimable 📄 chip so Enter opens the same detail
  // overlay the in-flight rows open. Guards: the test stub's elements carry
  // no scrollIntoView/focus, and with the inbox drained mid-click the
  // re-render may have swapped the body for the empty state — expanding an
  // empty glance is still the correct outcome, so only the chip focus is
  // conditional.
  var tile = ev.target.closest && ev.target.closest('button[data-tile-inbox]');
  if (tile) {
    applyGlanceCollapsed(false);
    var g = $('glance');
    if (g) {
      if (g.scrollIntoView) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var chip = g.querySelector('[data-inbox-file]');
      if (chip && chip.focus) chip.focus({ preventScroll: true });
    }
    return;
  }
  // Item-detail overlay entry: clicking an in-flight row opens its detail the
  // row is a real <button> (keyboard entry — finding 5). Links keep their own
  // behavior (finding 7 — the parking-lot rule; today's rows hold no links,
  // the skip is asserted by test so future rows cannot regress it).
  if (ev.target.closest && ev.target.closest('a')) return;
  var row = ev.target.closest && ev.target.closest('[data-flight-row]');
  if (row) openItemOverlay('item', Number(row.getAttribute('data-flight-row')), row);
});

$('parking-lot').addEventListener('click', function (ev) {
  var btn = ev.target.closest && ev.target.closest('button[data-action]');
  if (!btn) {
    // Item-detail overlay entry: a card click that did not originate inside
    // an interactive control (button/input/textarea/label/anchor — an
    // artifact link keeps its raw-link default). Never a write action.
    var ctrl = ev.target.closest && ev.target.closest('button, input, textarea, label, a');
    if (ctrl) return;
    var card = ev.target.closest && ev.target.closest('[data-id]');
    if (card) openItemOverlay('item', Number(card.getAttribute('data-id')), card);
    return;
  }
  var card = btn.closest('[data-id]');
  var id = card.getAttribute('data-id');
  var action = btn.getAttribute('data-action');

  if (action === 'detail') {
    openItemOverlay('item', Number(id), btn);
    return;
  }
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

/* ================= item detail overlay ================= */

/* Point-in-time item inspection (spec §Item detail overlay). The overlay
 * lives in the static #item-overlay container — present once in the body
 * markup, OUTSIDE every innerHTML re-rendered region — so a live SSE
 * snapshot re-render neither closes nor corrupts an open overlay, and the
 * open state stays per-tab (module-level page state in the
 * glanceCollapsed/flightCollapsed vocabulary, never persisted). Opening
 * triggers exactly one lazy fetch (the SSE snapshot stays lean); closing
 * discards all fetched state — reopening refetches. */
var overlayState = null;
var overlaySeq = 0; // monotonic per-open token: stale in-flight responses are ignored
var TB = String.fromCharCode(96); // backtick, kept out of this source literal

/* ---- minimal markdown renderer (escaped-first, fail-closed) ----
 * Block pass: fenced code blocks, h1–h4, horizontal rules, blockquotes,
 * ul/ol, paragraphs — one level only (nested constructs render as plain
 * text). Span pass: every text run is esc()'d BEFORE any markup is
 * recognized, so no tag can materialize except the ones emitted here — raw
 * HTML in the source markdown renders inert. Link targets are additionally
 * restricted to http:, https:, and relative paths; a javascript: or data:
 * target drops the anchor outright and the bracket title renders as plain
 * text. Every emitted anchor carries target="_blank" rel="noopener". */
function renderBoldItalic(s) {
  var out = s;
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  out = out.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?=$|[^A-Za-z0-9])/g, '$1<em>$2</em>');
  return out;
}

function safeLinkTarget(t) {
  var raw = String(t == null ? '' : t).trim();
  var s = raw.toLowerCase();
  if (s.length === 0) return null;
  if (s.indexOf('https:') === 0 || s.indexOf('http:') === 0) return raw;
  if (s.indexOf(':') !== -1) return null; // javascript:, data:, any other scheme — dropped outright
  return raw; // relative path (no ':' scheme)
}

function renderLinks(s) {
  var out = '';
  var last = 0;
  var re = /\\[([^\\]]*)\\]\\(([^)]*)\\)/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    out += renderBoldItalic(s.slice(last, m.index));
    var target = safeLinkTarget(m[2]);
    out += target === null
      ? renderBoldItalic(m[0]) // dropped scheme: the bracket title renders as plain text
      : '<a href="' + target + '" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2">' + renderBoldItalic(m[1]) + '</a>';
    last = m.index + m[0].length;
  }
  return out + renderBoldItalic(s.slice(last));
}

function renderSpans(escaped) {
  var s = String(escaped == null ? '' : escaped);
  var parts = s.split(TB);
  if (parts.length % 2 === 0) {
    // unbalanced backtick: the trailing segment renders literally
    var tail = parts.pop();
    if (parts.length > 0) parts[parts.length - 1] += TB + tail;
    else parts.push(tail);
  }
  var out = '';
  for (var k = 0; k < parts.length; k++) {
    // odd segments are inline code: content already escaped, excluded from
    // every further span treatment
    out += (k % 2 === 1)
      ? '<code class="bg-ink-100 rounded px-1 font-mono text-xs">' + parts[k] + '</code>'
      : renderLinks(parts[k]);
  }
  return out;
}

function renderMarkdown(md) {
  var lines = String(md == null ? '' : md).split('\\n');
  var n = lines.length;
  var out = [];
  var para = [];
  var i = 0;
  function flushPara() {
    if (para.length > 0) {
      out.push('<p class="text-sm leading-relaxed mt-2">' + renderSpans(esc(para.join(' '))) + '</p>');
      para = [];
    }
  }
  while (i < n) {
    var line = lines[i];
    var t = line.trim();
    if (t.indexOf(TB + TB + TB) === 0) { // fenced code block (info string discarded)
      flushPara();
      i += 1;
      var code = [];
      while (i < n && lines[i].trim().indexOf(TB + TB + TB) !== 0) { code.push(lines[i]); i += 1; }
      i += 1; // closing fence — or past the end: an unterminated fence makes the rest code
      out.push('<pre class="font-mono text-xs whitespace-pre-wrap bg-ink-100 rounded-md p-2.5 mt-2 overflow-x-auto"><code>' + esc(code.join('\\n')) + '</code></pre>');
      continue;
    }
    if (/^([-*_])\\1{2,}$/.test(t)) { // horizontal rule (3+ of one marker char)
      flushPara();
      out.push('<hr class="border-t border-ink-200 mt-3">');
      i += 1;
      continue;
    }
    var h = /^(#{1,4})\\s+(.*)$/.exec(line); // h1–h4; ##### is NOT a heading
    if (h) {
      flushPara();
      var tag = 'h' + h[1].length;
      var cls = h[1].length === 1 ? 'text-lg' : 'text-sm';
      out.push('<' + tag + ' class="' + cls + ' font-semibold mt-3">' + renderSpans(esc(h[2])) + '</' + tag + '>');
      i += 1;
      continue;
    }
    if (t.charAt(0) === '>') { // blockquote run (one '>' stripped per line)
      flushPara();
      var quote = [];
      while (i < n && lines[i].trim().charAt(0) === '>') {
        quote.push(lines[i].trim().replace(/^>\\s?/, ''));
        i += 1;
      }
      out.push('<blockquote class="border-l-2 border-ink-300 pl-3 text-ink-600 mt-2 text-sm">' + renderSpans(esc(quote.join(' '))) + '</blockquote>');
      continue;
    }
    if (/^\\s*[-*]\\s+/.test(line)) { // unordered list
      flushPara();
      var items = [];
      while (i < n && /^\\s*[-*]\\s+/.test(lines[i])) {
        items.push('<li class="mt-1">' + renderSpans(esc(lines[i].replace(/^\\s*[-*]\\s+/, ''))) + '</li>');
        i += 1;
      }
      out.push('<ul class="list-disc pl-5 mt-2 text-sm">' + items.join('') + '</ul>');
      continue;
    }
    if (/^\\s*\\d+[.)]\\s+/.test(line)) { // ordered list
      flushPara();
      var nums = [];
      while (i < n && /^\\s*\\d+[.)]\\s+/.test(lines[i])) {
        nums.push('<li class="mt-1">' + renderSpans(esc(lines[i].replace(/^\\s*\\d+[.)]\\s+/, ''))) + '</li>');
        i += 1;
      }
      out.push('<ol class="list-decimal pl-5 mt-2 text-sm">' + nums.join('') + '</ol>');
      continue;
    }
    if (t === '') { flushPara(); i += 1; continue; }
    para.push(t);
    i += 1;
  }
  flushPara();
  return out.join('');
}

/* ---- overlay state machine ---- */

function overlayPanel(inner) {
  return '<div class="wb-overlay-panel" data-overlay-panel>' + inner + '</div>';
}

function overlayHeading(label) {
  return '<div class="text-[11px] font-semibold uppercase tracking-widest text-ink-400 mt-5 mb-2">' + esc(label) + '</div>';
}

function showOverlayLoading() {
  $('item-overlay').innerHTML = overlayPanel(
    '<div class="p-8 flex items-center justify-center gap-3 text-sm text-ink-500">' +
    '<span class="wb-spin" aria-hidden="true"></span>Loading…</div>');
}

function showOverlayError(msg) {
  $('item-overlay').innerHTML = overlayPanel(
    '<div class="p-5">' +
    '<div class="flex items-start justify-between gap-3">' +
    '<div class="text-sm text-red-700">' + esc(msg) + '</div>' +
    '<button type="button" data-overlay-close class="btn btn-out shrink-0" title="close (Esc)">✕</button></div>' +
    '<button type="button" data-overlay-retry class="btn btn-out mt-3">Retry</button>' +
    '</div>');
  focusOverlayClose();
}

function showOverlayInboxReady(file, text) {
  $('item-overlay').innerHTML = overlayPanel(
    '<div class="p-5">' +
    '<div class="flex items-start justify-between gap-3">' +
    '<div class="min-w-0"><h3 class="font-semibold text-lg leading-tight">📄 ' + esc(file) + '</h3>' +
    '<div class="text-xs text-ink-400 mt-0.5">unclaimed inbox item</div></div>' +
    '<button type="button" data-overlay-close class="btn btn-out shrink-0" title="close (Esc)">✕</button>' +
    '</div>' +
    '<div class="mt-4">' + renderMarkdown(text) + '</div>' +
    '</div>');
  focusOverlayClose();
}

function showOverlayReady(d) {
  var it = (d && d.item) || {};
  var det = it.parkedDetail || {};
  var header =
    '<div class="flex items-start justify-between gap-3">' +
    '<div class="min-w-0">' +
    '<h3 class="font-semibold text-lg leading-tight">#' + it.id + ' ' + esc(it.title) + '</h3>' +
    '<div class="text-xs text-ink-500 mt-0.5 font-mono">' + esc(it.slug) + ' · ' + esc(it.repo) + ' · ' + esc(it.base) + ' · ' + esc(it.branchName || 'no branch yet') + '</div>' +
    (it.prUrl ? '<div class="text-xs mt-1"><a href="' + esc(it.prUrl) + '" target="_blank" rel="noopener" class="text-emerald-700 underline underline-offset-2">PR' + (it.prDraft ? ' (draft)' : '') + '</a></div>' : '') +
    '</div>' +
    '<div class="flex items-center gap-2 shrink-0">' + statusPill(it) +
    '<button type="button" data-overlay-close class="btn btn-out" title="close (Esc)">✕</button></div>' +
    '</div>';
  var rec = '<div class="mt-3 text-xs space-y-2">' +
    '<div class="text-ink-500 font-mono">stage: ' + esc(it.stage || '—') + '</div>';
  if (it.approvals && it.approvals.length) rec += '<div class="text-ink-500 font-mono">approvals: ' + esc(it.approvals.join(', ')) + '</div>';
  var ga = '';
  var attempts = it.gateAttempts || {};
  for (var s in attempts) { if (attempts.hasOwnProperty(s)) { if (ga) ga += ', '; ga += s + '=' + attempts[s]; } }
  if (ga) rec += '<div class="text-ink-500 font-mono">gate attempts: ' + esc(ga) + '</div>';
  if (it.infraAttempts > 0) rec += '<div class="text-ink-500 font-mono">infra retries: ' + it.infraAttempts + '</div>';
  rec += '<div class="text-ink-400 font-mono">created ' + esc(it.createdAt || '') + ' · updated ' + esc(it.updatedAt || '') + '</div>';
  if (it.parkedReason) rec += '<div class="text-ink-500 font-mono">parked: ' + esc(it.parkedReason) + '</div>';
  if (typeof det.stage === 'string' && det.stage !== it.stage) rec += '<div class="text-ink-500 font-mono">completed stage: ' + esc(det.stage) + '</div>';
  if (typeof det.error === 'string') rec += '<div class="text-orange-700 bg-orange-50 border border-orange-200 rounded-md p-2.5 font-mono whitespace-pre-wrap">' + esc(det.error) + '</div>';
  if (Array.isArray(det.questions) && det.questions.length) {
    rec += '<div class="space-y-1">' + det.questions.map(function (q) {
      return '<div class="text-ink-700"><span class="text-violet-600 font-semibold">Q</span> ' + esc(q) + '</div>';
    }).join('') + '</div>';
  }
  if (it.parkedReason === 'stale-base' && typeof det.base === 'string' && typeof det.repo === 'string') {
    rec += '<div class="text-amber-800">⚑ stale base — git pull in ' + esc(det.repo) + ' (' + esc(det.base) + ' is behind origin/' + esc(det.base) + ')</div>';
  }
  if (it.answers && it.answers.length) {
    rec += '<div class="space-y-1">' + it.answers.map(function (pair) {
      return '<div class="text-ink-700"><span class="text-violet-600 font-semibold">Q</span> ' + esc(pair.question) + ' — ' + esc(pair.answer) + '</div>';
    }).join('') + '</div>';
  }
  rec += feedbackBox(it.feedback);
  rec += '</div>' + stageDots(it);
  var specHtml = '';
  if (!d.spec) {
    specHtml = '<div class="text-xs text-ink-400">no spec artifact yet</div>';
  } else {
    specHtml = '<div class="text-xs text-ink-500 font-mono mb-2">' + esc(d.spec.name) + ' · ' + esc(d.spec.createdAt) +
      ' · <a href="/api/artifact?path=' + encodeURIComponent(d.spec.path) + '" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2">view raw</a></div>';
    if (d.spec.content === null || d.spec.content === undefined) {
      specHtml += '<div class="text-xs text-ink-400">(' + esc(d.spec.error || 'file unreadable') + ')</div>';
    } else {
      specHtml += '<div class="mt-2">' + renderMarkdown(d.spec.content) + '</div>';
    }
  }
  var artsHtml = '';
  if (!d.artifacts || d.artifacts.length === 0) {
    artsHtml = '<div class="text-xs text-ink-400">no artifacts yet</div>';
  } else {
    artsHtml = '<div class="space-y-1">' + d.artifacts.map(function (a) {
      return '<div class="flex items-center gap-2 flex-wrap text-xs">' +
        '<span class="font-mono">' + esc(a.name) + ' · ' + esc(a.stage || '—') + ' · ' + esc(a.createdAt) + '</span>' +
        '<a href="/api/artifact?path=' + encodeURIComponent(a.path) + '" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2">View raw</a>' +
        '<button type="button" data-overlay-artifact="' + esc(a.path) + '" class="btn btn-out">View</button>' +
        '</div>';
    }).join('') + '</div>' +
    '<div id="overlay-artifact-body" class="mt-2"></div>';
  }
  var srcHtml = '';
  if (!d.source) {
    srcHtml = '<div class="text-xs text-ink-400">no source file recorded</div>';
  } else {
    srcHtml = '<div class="text-xs text-ink-500 font-mono mb-2">' + esc(d.source.path) +
      ' · <a href="/api/artifact?path=' + encodeURIComponent(d.source.path) + '" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2">view raw</a></div>';
    if (d.source.content === null || d.source.content === undefined) {
      srcHtml += '<div class="text-xs text-ink-400">(' + esc(d.source.error || 'file unreadable') + ')</div>';
    } else {
      srcHtml += '<pre class="font-mono text-xs whitespace-pre-wrap bg-ink-100 rounded-md p-2.5 overflow-x-auto">' + esc(d.source.content) + '</pre>';
    }
  }
  $('item-overlay').innerHTML = overlayPanel(
    '<div class="p-5">' + header + rec +
    overlayHeading('Spec') + specHtml +
    overlayHeading('Artifacts') + artsHtml +
    overlayHeading('Source') + srcHtml +
    '</div>');
  focusOverlayClose();
}

/* Move focus into the overlay so keyboard flow continues inside it (the
 * close control is the natural anchor); the stub harness's querySelector is
 * null, so the call is skipped there. */
function focusOverlayClose() {
  var btn = $('item-overlay').querySelector('button[data-overlay-close]');
  if (btn && typeof btn.focus === 'function') btn.focus();
}

function closeOverlay() {
  var st = overlayState;
  overlayState = null; // closing discards all fetched state — reopening refetches
  var el = $('item-overlay');
  el.classList.add('hidden');
  el.innerHTML = '';
  if (st && st.opener && st.opener.isConnected !== false && typeof st.opener.focus === 'function') st.opener.focus();
}

function openItemOverlay(mode, key, openerHint) {
  var opener = null;
  // The explicit hint wins over document.activeElement (Greptile PR-32
  // finding 4): the hint is the delegated handler's OPEN-time target, while
  // activeElement may already sit INSIDE the overlay — a retry re-open
  // passes the original opener as the hint, and the loading render then
  // removes the in-overlay control; without the precedence swap, close()
  // would focus a detached node and restore nothing. Falls back to
  // activeElement only when no hint exists.
  if (openerHint && typeof openerHint === 'object') opener = openerHint;
  else {
    var active = document.activeElement;
    if (active && typeof active === 'object') opener = active;
  }
  var seq = ++overlaySeq;
  overlayState = { mode: mode, key: key, seq: seq, opener: opener, phase: 'loading' };
  var el = $('item-overlay');
  el.classList.remove('hidden');
  showOverlayLoading();
  if (mode === 'item') {
    fetch('/api/items/' + encodeURIComponent(String(key))).then(function (res) {
      if (!overlayState || overlayState.seq !== seq) return;
      if (!res.ok) { overlayState.phase = 'error'; showOverlayError('HTTP ' + res.status); return; }
      res.json().then(function (data) {
        if (!overlayState || overlayState.seq !== seq) return;
        overlayState.phase = 'ready';
        overlayState.data = data;
        showOverlayReady(data);
      }, function () {
        if (!overlayState || overlayState.seq !== seq) return;
        overlayState.phase = 'error';
        showOverlayError('the detail response could not be read');
      });
    }, function () {
      if (!overlayState || overlayState.seq !== seq) return;
      overlayState.phase = 'error';
      showOverlayError('the detail request failed');
    });
  } else {
    fetch('/api/artifact?path=' + encodeURIComponent('inbox/' + key)).then(function (res) {
      if (!overlayState || overlayState.seq !== seq) return;
      if (!res.ok) { overlayState.phase = 'error'; showOverlayError('HTTP ' + res.status); return; }
      res.text().then(function (text) {
        if (!overlayState || overlayState.seq !== seq) return;
        overlayState.phase = 'ready';
        overlayState.text = text;
        showOverlayInboxReady(key, text);
      }, function () {
        if (!overlayState || overlayState.seq !== seq) return;
        overlayState.phase = 'error';
        showOverlayError('the file could not be read');
      });
    }, function () {
      if (!overlayState || overlayState.seq !== seq) return;
      overlayState.phase = 'error';
      showOverlayError('the file request failed');
    });
  }
}

/* Inline artifact view: one fetch through the hardened artifact route,
 * rendered through the same markdown renderer (logs land in fenced/plain
 * text — everything the route serves is markdown).
 * Stale-response guard (Greptile PR-32 finding 3): the LAST selection always
 * wins — a generation counter like the overlay's own seq token, checked by
 * every terminal callback (including error writes). Without it, a slow
 * response for artifact A can overwrite a faster B. */
var overlayArtifactSeq = 0;
function loadOverlayArtifact(rel) {
  var body = $('overlay-artifact-body');
  if (!body) return;
  var seq = ++overlayArtifactSeq;
  var stale = function () { return !overlayState || seq !== overlayArtifactSeq; };
  body.innerHTML = '<div class="text-xs text-ink-400"><span class="wb-spin" aria-hidden="true"></span> loading…</div>';
  fetch('/api/artifact?path=' + encodeURIComponent(rel)).then(function (res) {
    if (stale()) return;
    if (!res.ok) {
      body.innerHTML = '<div class="text-red-700 text-xs">' + esc('artifact unavailable (HTTP ' + res.status + ') — it may have been removed') + '</div>';
      return;
    }
    res.text().then(function (text) {
      if (stale()) return;
      body.innerHTML = '<div class="mt-1">' + renderMarkdown(text) + '</div>';
    }, function () {
      if (stale()) return;
      body.innerHTML = '<div class="text-red-700 text-xs">artifact unavailable — the file could not be read</div>';
    });
  }, function () {
    if (stale()) return;
    body.innerHTML = '<div class="text-red-700 text-xs">artifact unavailable — the request failed</div>';
  });
}

/* Overlay interactions — one delegated click listener on the permanent
 * #item-overlay container (never re-rendered), plus one document keydown
 * for Esc installed once here. Backdrop dismissal: a click that did not
 * originate inside the panel closes the overlay. */
$('item-overlay').addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t) return;
  if (t.closest && t.closest('button[data-overlay-close]')) { closeOverlay(); return; }
  if (t.closest && t.closest('button[data-overlay-retry]')) {
    var st = overlayState;
    if (st) openItemOverlay(st.mode, st.key, st.opener);
    return;
  }
  var art = t.closest && t.closest('[data-overlay-artifact]');
  if (art) { loadOverlayArtifact(art.getAttribute('data-overlay-artifact')); return; }
  var panel = t.closest ? t.closest('[data-overlay-panel]') : null;
  if (!panel) closeOverlay();
});

/* Esc closes; while the overlay is open, Tab is wrapped among the panel's
 * tabbables — aria-modal="true" tells assistive tech the background is
 * inert, so the trap makes that claim honest (Greptile PR-32 finding 6).
 * The runtime-test stub cannot model focusable DOM traversal, so a stub
 * without querySelectorAll skips the wrap (tests opt in by installing it). */
function trapOverlayTab(ev) {
  var scope = $('item-overlay');
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  var tabbables = scope.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex="0"]');
  if (!tabbables || tabbables.length === 0) {
    // Nothing focusable (loading/error shell): never let focus escape the modal.
    ev.preventDefault();
    return;
  }
  var first = tabbables[0];
  var last = tabbables[tabbables.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    if (typeof last.focus === 'function') last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    if (typeof first.focus === 'function') first.focus();
  }
}

document.addEventListener('keydown', function (ev) {
  if (!overlayState) return;
  if (ev && ev.key === 'Escape') { closeOverlay(); return; }
  if (ev && ev.key === 'Tab') trapOverlayTab(ev);
});

/* ================= header: Start Processing ================= */

/* Single-flight Start Processing. Both the Start Processing button and the
 * PAUSED pill funnel through pressRun() — clicking the PAUSED pill is
 * indistinguishable from pressing Start Processing (identical POST path,
 * toasts, and busy-409 handling). While a flight is open the button shows a
 * spinner and is disabled; repeated clicks (button or pill) never stack a
 * second POST. Retirement rules: the busy-409 and error paths re-enable
 * immediately; a 202 keeps the button busy until the NEXT status snapshot
 * (render() retires the flight — the server acquires the lock synchronously
 * before responding and the status fingerprint embeds the lock, so that
 * snapshot always reflects the new lock truth, acquired or already released
 * by a fast-finished drive). runInFlight guards the whole flight;
 * flightPending marks the pre-response window (inert, so an unrelated
 * lockless status event racing the POST cannot retire the flight early);
 * flightAwaited marks "202 seen, retire on the next snapshot".
 *
 * Watchdog: a 202's "next snapshot" does not always exist. A no-op drive
 * can acquire AND release the lock between two SSE poll ticks while changing
 * nothing observable — no fingerprint change, so the poller emits no status
 * event and the awaited-202 state would wedge the button forever. The
 * watchdog backs that state with a deadline (RUN_FLIGHT_WATCHDOG_MS,
 * comfortably above 2x the default 2s serve poll interval): if no snapshot
 * retires the flight within the grace period, the timer does — and only
 * when the flight is still awaited-and-not-pending. clearRunFlight() always
 * clears the timer, so it can never fire late over a retired flight. */
var runInFlight = false;
var flightAwaited = false;
var flightPending = false;
var flightWatchdog = null;
var RUN_FLIGHT_WATCHDOG_MS = 6000;

/* Arms the re-enable deadline for the awaited-202 state. Called only from
 * the 202 branch; the timer retires the flight itself if no status snapshot
 * arrives first (render()'s pre-clear normally wins the race). */
function armRunFlightWatchdog() {
  if (flightWatchdog) clearTimeout(flightWatchdog);
  flightWatchdog = setTimeout(function () {
    flightWatchdog = null;
    if (runInFlight && flightAwaited && !flightPending) clearRunFlight();
  }, RUN_FLIGHT_WATCHDOG_MS);
}

function pressRun() {
  if (runInFlight) return; // no double-fire
  runInFlight = true;
  flightPending = true;
  setRunButtonBusy(true);
  postJSON('/api/run', {}).then(function (r) {
    flightPending = false;
    if (r.status === 202) {
      flightAwaited = true;
      armRunFlightWatchdog();
      toast('processing started — progress lands in the feed' + (r.data && r.data.capped ? ' (hit its safety cap — press Start Processing again)' : ''));
    } else if (r.status === 409) {
      clearRunFlight(); // retire first so the lock-driven writer can apply the fresh lock
      renderLock(r.data && r.data.lock);
      toast('factory is busy — a run is already in progress');
      // The holder may already have exited; reconcile immediately rather than
      // waiting for an SSE event that an unchanged fingerprint can suppress.
      refreshStatus();
    } else {
      toast((r.data && r.data.error) || ('HTTP ' + r.status));
      clearRunFlight();
    }
  }, function () {
    flightPending = false;
    clearRunFlight(); // rejected fetch: never wedge the button
  });
}

$('btn-run').addEventListener('click', function () {
  // Browsers never dispatch click on a native-disabled button; the DOM-stub
  // harness does regardless — the guard keeps that path assertable there.
  if ($('btn-run').disabled) return;
  pressRun();
});

function clearRunFlight() {
  if (flightWatchdog) { clearTimeout(flightWatchdog); flightWatchdog = null; }
  runInFlight = false;
  flightAwaited = false;
  flightPending = false; // every exit path leaves the flags consistent
  setRunButtonBusy(false);
}

/* The flight-window writer of #btn-run's dynamic state: spinner + disabled
 * while a Run flight is open (before the lock shows in a snapshot), the
 * static ▶ Start Processing label otherwise. Lock-driven paints belong to
 * renderRunButton — the two never fight because renderRunButton defers
 * while runInFlight. */
function setRunButtonBusy(busy) {
  var btn = $('btn-run');
  if (busy) {
    btn.disabled = true;
    if (btn.setAttribute) btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="wb-spin shrink-0" aria-hidden="true"></span> Processing…';
  } else {
    btn.disabled = false;
    if (btn.removeAttribute) btn.removeAttribute('aria-busy');
    btn.innerHTML = '▶ Start Processing';
  }
}

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
      toast('wrote ' + r.data.file + (r.data.runStarted ? ' — processing started' : ' — the factory claims it on Start Processing'));
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
es.onerror = function () {
  $('feed-status').textContent = 'reconnecting…';
  $('feed-status').className = 'text-xs text-amber-600';
  // SSE died mid-run: never leave the operator with a permanently disabled
  // Run button — but only the awaited-202 state is cleared here. A drop
  // while a POST is still pending must not defeat the no-double-fire guard
  // (that POST's own handlers re-enable on 409/error, and the watchdog
  // covers a 202 whose snapshot never arrives). A later press while the
  // old drive still holds the lock lands in the (unchanged) busy-409 path,
  // which is correct.
  if (runInFlight && flightAwaited && !flightPending) clearRunFlight();
};

/* Header RUNNING clock: one interval, created once at init. Each status
 * event re-anchors the elapsed time from lock.ageMs (renderRunState); between
 * events this tick extrapolates from the anchor. Cheap no-op — no DOM touch
 * at all — when the factory is not running. */
setInterval(function () {
  if (!runAnchor.running) return;
  var clock = $('run-clock');
  if (clock) clock.textContent = fmtMMSS(runAnchor.ageMs + (Date.now() - runAnchor.at));
}, 1000);

/* Header pill click actions — one delegated listener on the permanent
 * #run-state container (it survives every innerHTML re-render),
 * dispatching on the state machine: RUNNING → the #26 glance
 * expand/scroll/flash affordance; NEEDS REVIEW → scroll to the parking
 * lot; INTERRUPTED and PAUSED → pressRun() (the same shared path as the
 * Start Processing button, flight guard included — recovery stays one
 * action). IDLE is an inert span and the stale text is
 * informational — both are no-ops. */
$('run-state').addEventListener('click', function () {
  if (runStateKind === 'running') {
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
  } else if (runStateKind === 'review') {
    var lot = $('parking-lot');
    if (lot.scrollIntoView) lot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (runStateKind === 'interrupted') {
    pressRun();
  } else if (runStateKind === 'paused') {
    pressRun();
  }
});

/* Instant paint ahead of the first SSE snapshot (identical shared payload). */
refreshStatus();
</script>
</body>
</html>
`;
