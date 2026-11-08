import { describe, it, expect } from "vitest";
import * as vm from "node:vm";
import { PAGE_HTML } from "../src/web/page.js";

/**
 * Runtime tests for the wb serve page script. The page is a single static
 * HTML asset whose inline script is not module-exported, so these tests
 * extract that script, run it in a fresh V8 context with a minimal DOM
 * stub, and drive it exactly the way the browser does: `status` events on
 * the EventSource. That exercises REAL page behavior (transitions and the
 * ticking clock), not source-text greps.
 */

function pageScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  if (start < 0 || end < 0) throw new Error("PAGE_HTML has no inline script");
  return html.slice(start + "<script>".length, end);
}

interface StubElement {
  innerHTML: string;
  textContent: string;
  className: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  attributes: Record<string, string>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  listeners: Map<string, Array<() => void>>;
  addEventListener: (t: string, fn: () => void) => void;
  querySelector: () => null;
  focus?: () => void;
  scrollIntoView?: (opts?: unknown) => void;
}

function makeStubElement(): StubElement {
  const listeners: Map<string, Array<() => void>> = new Map();
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    value: "",
    checked: false,
    disabled: false,
    attributes,
    setAttribute: (k, v) => {
      attributes[k] = v;
    },
    getAttribute: (k) => (k in attributes ? attributes[k] : null),
    removeAttribute: (k) => {
      delete attributes[k];
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    listeners,
    addEventListener: (t, fn) => {
      const fns = listeners.get(t) ?? [];
      fns.push(fn);
      listeners.set(t, fns);
    },
    querySelector: () => null,
  };
}

/** Script context stubs: elements auto-vivify per id (one per id, browser-like), and the fetch/EventSource pair is handed to the test. */
function makeContext() {
  const elements = new Map<string, StubElement>();
  const document = {
    getElementById: (id: string) => {
      let el = elements.get(id);
      if (!el) {
        el = makeStubElement();
        elements.set(id, el);
      }
      return el;
    },
    querySelector: () => null,
    addEventListener: () => {},
  };

  const sseListeners = new Map<string, Array<(e: { data: string }) => void>>();
  class EventSource {
    private listeners = sseListeners;
    constructor(_url: string) {
      lastES = this as unknown as { _fire: (t: string, e: { data: string }) => void };
      (this as unknown as { _fire: (t: string, e: { data: string }) => void })._fire = (t, e) => {
        for (const fn of sseListeners.get(t) ?? []) fn(e);
      };
    }
    addEventListener(t: string, fn: (e: { data: string }) => void) {
      const fns = sseListeners.get(t) ?? [];
      fns.push(fn);
      sseListeners.set(t, fns);
    }
  }
  let lastES: { _fire: (t: string, e: { data: string }) => void } | null = null;

  const fetches: Array<{ url: string; resolve: (r: unknown) => void }> = [];
  const requestLog: string[] = []; // every fetch call, ever — survives settle()'s drain
  const fetch = (url: string) =>
    new Promise((resolve) => {
      requestLog.push(url);
      fetches.push({ url, resolve });
    });

  const sandbox: Record<string, unknown> = {
    document,
    fetch,
    EventSource,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  return {
    sandbox,
    run: (script: string) => vm.runInContext(script, sandbox, { filename: "page-inline.js" }),
    el: (id: string) => document.getElementById(id),
    fire: (t: string, payload: unknown) => {
      if (!lastES) throw new Error("page never constructed an EventSource");
      lastES._fire(t, { data: JSON.stringify(payload) });
    },
    /** Mirror the rendered markup's `hidden` state onto the glance-body stub's
     * classList so class assertions can't pass vacuously: the writer toggles
     * the stub's classes, but the stub never parsed the rendered HTML — an
     * unseeded stub starts WITHOUT `hidden`, so `expect(remove)` checks would
     * pass even if the writer stopped removing it (greptile P2 27). The
     * marker matches the container itself: `id="glance-body" class="mt-3
     * hidden"` (collapsed) vs `id="glance-body" class="mt-3"` (open). */
    syncGlanceBodyFromMarkup: () => {
      const markup = document.getElementById("glance").innerHTML;
      const body = document.getElementById("glance-body");
      if (/id="glance-body"[^>]*\bhidden\b/.test(markup)) body.classList.add("hidden");
      else body.classList.remove("hidden");
    },
    /** Dispatch a click on an element's registered click listeners, exactly
     * like a browser click: handlers receive `{ target }` (the element
     * itself unless the test passes a fake inner target, e.g. for delegated
     * handlers that expect `ev.target.closest(...)`). Note for keyboard
     * coverage: browsers synthesize `click` from Enter/Space on
     * `<button type="button">`, so the shared click listener IS the
     * keyboard path — no separate keydown synthesis is needed. */
    click: (id: string, evTarget?: unknown) => {
      const el = document.getElementById(id);
      for (const fn of el.listeners.get("click") ?? []) {
        (fn as (ev: { target: unknown }) => void)({ target: evTarget ?? el });
      }
    },
    /** Let the script's `refreshStatus()` promise (and any .then) settle.
     * The optional responder resolves per-URL — the POST `/api/run` cases
     * need a real `status` field (202/409), which the generic IDLE-shaped
     * default (no `status`) cannot express. Unhandled URLs fall back to the
     * default. */
    settle: async (respond?: (url: string) => unknown) => {
      const def = { ok: true, json: async () => IDLE_PAYLOAD };
      for (const f of fetches.splice(0)) f.resolve(respond ? respond(f.url) ?? def : def);
      await new Promise((r) => setTimeout(r, 10));
    },
    /** Number of currently-pending fetches for a URL (settle() drains the
     * queue, so count BEFORE settling). */
    countRequests: (url: string) => fetches.filter((f) => f.url === url).length,
    /** Total fetches ever issued for a URL (the no-double-fire guard needs
     * the cumulative count — the pending queue drains on settle). */
    totalRequests: (url: string) => requestLog.filter((u: string) => u === url).length,
  };
}

/** Full status payload — every render*() field the script reads off a snapshot.
 * Items may be running/queued/done (counts derive from them); `opts.claimable`
 * feeds both `inbox.claimable` and the inbox count. */
function payload(
  items: unknown[],
  lock: unknown,
  opts?: { claimable?: string[]; error?: string | null },
) {
  const claimable = opts?.claimable ?? [];
  const count = (s: string) => items.filter((i: any) => i.status === s).length;
  return {
    items,
    knownRepos: [],
    counts: {
      decisions: 0,
      running: count("running"),
      queued: count("queued"),
      inbox: claimable.length,
      done: count("done"),
    },
    flow: [],
    inbox: { claimable, alreadyClaimed: [], error: opts?.error ?? null },
    lock,
  };
}

const IDLE_PAYLOAD = payload([], null);
const RUNNING_PAYLOAD = payload(
  [{ id: 22, slug: "make-the-running-state-unmissable-in-the-web-ui-header", stage: "pr", status: "running" }],
  { alive: true, pid: 7, ageMs: 65_500 },
);
const DEAD_PAYLOAD = payload([], { alive: false, pid: 7, ageMs: 90_000 });

/** Fake event target for the delegated glance click: the handler only needs
 * `closest` to return truthy for the summary button (parking-lot pattern). */
const SUMMARY_TARGET = {
  closest: (sel: string) => (sel.indexOf("data-glance-summary") >= 0 ? { attributes: {} } : null),
};
const NOT_SUMMARY_TARGET = { closest: () => null };

describe("wb serve page script (runtime behavior)", () => {
  it("transitions IDLE → RUNNING → stale → IDLE from status events, with a ticking clock", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle(); // the script's initial refreshStatus paints first

    const runState = ctx.el("run-state");
    expect(runState.innerHTML).toContain("IDLE");
    expect(runState.innerHTML).not.toContain("RUNNING");

    // Live lock with a running item: the pill names it and starts the clock.
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(runState.innerHTML).toContain("RUNNING");
    expect(runState.innerHTML).toContain("#22 make-the-running-state-unmissable-in-the-web-ui-header · pr");
    expect(runState.innerHTML).toContain("bg-blue-500");
    // The pill is a BUTTON (keyboard-activatable), not a clickable div.
    expect(runState.innerHTML).toContain('<button type="button"');
    // RUNNING carries a real spinner, placed before the pulsing dot.
    expect(runState.innerHTML).toContain("wb-spin");
    expect(runState.innerHTML.indexOf("wb-spin")).toBeLessThan(
      runState.innerHTML.indexOf("bg-blue-500"),
    );
    const clock = ctx.el("run-clock");
    var firstPaint = runState.innerHTML.match(/id="run-clock">([^<]+)</);
    expect(firstPaint && firstPaint[1]).toBe("01:05"); // ageMs 65500 on first paint

    // Between status events a 1s client-side interval extrapolates the clock
    // by writing into #run-clock's textContent. Poll (bounded) rather than a
    // bare sleep, so a busy CI run can't outrun the 1s interval.
    const ticked = await (async () => {
      for (let i = 0; i < 30; i++) {
        if (clock.textContent && clock.textContent !== "01:05") return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })();
    expect(ticked).toBe(true);
    expect(clock.textContent).toMatch(/^\d{2}:\d{2}$/); // 01:06, 01:07, …

    // Dead holder: the verbatim stale-lock text replaces the pill.
    ctx.fire("status", DEAD_PAYLOAD);
    expect(runState.innerHTML).toContain("stale factory lock (pid 7");
    expect(runState.innerHTML).not.toContain("RUNNING");
    expect(runState.innerHTML).not.toContain("wb-spin"); // stale is informational — no spinner

    // Lock cleared: back to IDLE.
    ctx.fire("status", IDLE_PAYLOAD);
    expect(runState.innerHTML).toContain("IDLE");
    expect(runState.innerHTML).not.toContain("RUNNING");
    expect(runState.innerHTML).not.toContain("wb-spin");
  });

  it("renders the glance collapsed by default with accurate counts, updating live over SSE without expanding", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle(); // initial paint is the idle payload

    const MIXED = payload(
      [
        { id: 11, slug: "alpha", stage: "build", status: "running" },
        { id: 12, slug: "beta", stage: "claim", status: "queued" },
        { id: 13, slug: "gamma", status: "done" },
      ],
      null,
      { claimable: ["a.md", "b.md"] },
    );
    ctx.fire("status", MIXED);
    const glance = ctx.el("glance");
    // Collapsed by default: one clickable summary row (a real button, so
    // Enter/Space synthesize the same click) + a hidden body container.
    expect(glance.innerHTML).toContain("data-glance-summary");
    expect(glance.innerHTML).toContain('<button type="button"');
    expect(glance.innerHTML).toContain("1 running · 1 queued · 1 landed");
    expect(glance.innerHTML).toContain("2 in inbox");
    expect(glance.innerHTML).toContain('id="glance-body" class="mt-3 hidden"');
    expect(glance.innerHTML).toContain('aria-expanded="false"');
    // The chip/inbox detail is inside the (hidden) body, unchanged.
    expect(glance.innerHTML).toContain("#11 alpha");
    expect(glance.innerHTML).toContain("a.md");

    // Live SSE update while collapsed: counts change, the body markup stays
    // hidden, and the collapse state is untouched (still collapsed).
    const TWO_RUNNING = payload(
      [
        { id: 11, slug: "alpha", stage: "build", status: "running" },
        { id: 14, slug: "delta", stage: "build", status: "running" },
        { id: 12, slug: "beta", stage: "claim", status: "queued" },
        { id: 13, slug: "gamma", status: "done" },
      ],
      null,
      { claimable: ["a.md", "b.md"] },
    );
    ctx.fire("status", TWO_RUNNING);
    expect(ctx.el("glance").innerHTML).toContain("2 running · 1 queued · 1 landed");
    expect(ctx.el("glance").innerHTML).toContain('id="glance-body" class="mt-3 hidden"');
  });

  it("toggles the glance between collapsed and expanded on click (and keyboard, via the shared click path)", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire(
      "status",
      payload([{ id: 11, slug: "alpha", stage: "build", status: "running" }], null, { claimable: ["a.md"] }),
    );
    // Collapsed render: the hidden class rides on the body's markup.
    expect(ctx.el("glance").innerHTML).toContain('id="glance-body" class="mt-3 hidden"');

    // Delegated click on the summary button expands the body. The stub's
    // classList is synced from the rendered markup first, so this assertion
    // is only satisfiable if the writer actually REMOVES the hidden class
    // (an unseeded stub would make the check vacuously true).
    ctx.syncGlanceBodyFromMarkup();
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(true);
    ctx.click("glance", SUMMARY_TARGET);
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(false);

    // A payload re-render while expanded keeps the body open (state survives
    // the innerHTML replacement — the class is derived from glanceCollapsed).
    ctx.fire(
      "status",
      payload([{ id: 11, slug: "alpha", stage: "build", status: "running" }], null, { claimable: ["a.md"] }),
    );
    expect(ctx.el("glance").innerHTML).toContain('aria-expanded="true"');
    expect(ctx.el("glance").innerHTML).toContain('id="glance-body" class="mt-3"');
    expect(ctx.el("glance").innerHTML).not.toContain('class="mt-3 hidden"');

    // Second click collapses again (the single writer re-adds the class).
    // Sync from the (now open) markup first so the add must come from the
    // click, not from the initial stub state.
    ctx.syncGlanceBodyFromMarkup();
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(false);
    ctx.click("glance", SUMMARY_TARGET);
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(true);

    // A click that does not originate on the summary button is ignored.
    ctx.click("glance", NOT_SUMMARY_TARGET);
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(true);
  });

  it("auto-expands the collapsed glance when the RUNNING pill is clicked, and keeps the empty state toggle-free", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Empty state: plain line, no toggle, and a container click is a no-op.
    expect(ctx.el("glance").innerHTML).toContain("no items in flight");
    expect(ctx.el("glance").innerHTML).not.toContain("data-glance-summary");
    ctx.click("glance", NOT_SUMMARY_TARGET); // no summary button exists → closest misses, handler is a no-op
    expect(ctx.el("glance").innerHTML).toContain("no items in flight");

    // RUNNING pill while the glance is collapsed: the body must expand before
    // the scroll-and-flash affordance runs (the chip querySelector returns
    // null on the stub, so the flash itself is safely skipped here).
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(ctx.el("glance").innerHTML).toContain('id="glance-body" class="mt-3 hidden"');
    ctx.syncGlanceBodyFromMarkup();
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(true);
    ctx.click("run-state");
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(false);

    // Back to empty: the toggle never appears, the plain line returns.
    ctx.fire("status", IDLE_PAYLOAD);
    expect(ctx.el("glance").innerHTML).toContain("no items in flight");
    expect(ctx.el("glance").innerHTML).not.toContain("data-glance-summary");
  });

  it("keeps the inbox-unreadable error row visible outside the collapsible body", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const BROKEN = payload(
      [{ id: 31, slug: "epsilon", status: "done" }],
      null,
      { error: "EACCES: permission denied, scandir" },
    );
    ctx.fire("status", BROKEN);
    const glance = ctx.el("glance").innerHTML;
    // The error row renders, and OUTSIDE #glance-body: the collapsed body is
    // display:none, so a row inside it would be invisible by default. Assert
    // the row sits after the body's closing markup (the render ends
    // `…</div>' + errorRow + '</div>`), not inside the hidden container.
    expect(glance).toContain("inbox unreadable: EACCES: permission denied, scandir");
    expect(glance).toMatch(/inbox unreadable:[^]*<\/div><\/div>$/);
    expect(glance).toContain("1 landed");

    // Error-only (no items at all): not the empty state — the summary row
    // still appears so the failure can't hide behind 'no items in flight'.
    const EMPTY_BROKEN = payload([], null, { error: "unreadable inbox" });
    ctx.fire("status", EMPTY_BROKEN);
    expect(ctx.el("glance").innerHTML).toContain("data-glance-summary");
    expect(ctx.el("glance").innerHTML).toContain("inbox unreadable: unreadable inbox");
  });

  it("restores keyboard focus to the summary button after a payload re-render", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // A keyboard user has focused the summary button; an SSE status event
    // re-renders the section (innerHTML replacement). The new button must
    // receive focus() again, so Enter/Space keep toggling without a manual
    // Tab-back. The stub exposes a fake focused node (activeElement.closest
    // hits the summary selector) and a glance.querySelector returning an
    // instrumented replacement button; the page must call its focus().
    let focusCalls = 0;
    const fakeBtn = { focus: () => {
      focusCalls++;
    } };
    (ctx.el("glance") as unknown as { querySelector: (sel: string) => unknown }).querySelector =
      (sel: string) => (sel === "button[data-glance-summary]" ? fakeBtn : null);
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      closest: (sel: string) => (sel === "button[data-glance-summary]" ? { attributes: {} } : null),
    };

    ctx.fire("status", payload([{ id: 12, slug: "beta", status: "queued" }], null, { claimable: ["a.md"] }));
    expect(focusCalls).toBe(1);

    // Re-render with focus elsewhere: no refocus attempt, no crash.
    (ctx.el("glance") as unknown as { querySelector: (sel: string) => unknown }).querySelector = () => null;
    ctx.fire("status", payload([{ id: 12, slug: "beta", status: "done" }], null, { claimable: [] }));
    expect(focusCalls).toBe(1);
  });

  it("renders the IDLE chip unchanged for an empty factory (span, no button, no spinner)", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const runState = ctx.el("run-state");
    // Byte-identical IDLE markup: a calm stone span, no button, no dot, no spinner.
    expect(runState.innerHTML).toBe(
      '<span class="rounded-full text-[10px] font-semibold tracking-widest text-ink-400 bg-white ring-1 ring-ink-200 px-3 py-1">IDLE</span>',
    );
    expect(runState.innerHTML).not.toContain("<button");
    expect(runState.innerHTML).not.toContain("wb-spin");
    // IDLE has no click action: a container click neither POSTs nor scrolls.
    let scrolled = 0;
    ctx.el("parking-lot").scrollIntoView = () => {
      scrolled++;
    };
    ctx.click("run-state");
    expect(scrolled).toBe(0);
    expect(ctx.countRequests("/api/run")).toBe(0);
  });

  it("renders NEEDS REVIEW for parked items; clicking scrolls to the parking lot without a POST", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const REVIEW = payload(
      [
        { id: 20, slug: "approve-me", stage: "spec", status: "awaiting-approval" },
        { id: 21, slug: "rejected-me", stage: "pr", status: "human-rejected" },
      ],
      null,
    );
    REVIEW.counts.decisions = 2;
    ctx.fire("status", REVIEW);
    const runState = ctx.el("run-state");
    // Amber pill (the existing awaiting-approval palette), naming the count
    // and the first pending thing in parking-lot order (approval first).
    expect(runState.innerHTML).toContain("bg-amber-100");
    expect(runState.innerHTML).toContain("text-amber-700");
    expect(runState.innerHTML).toContain("NEEDS REVIEW");
    expect(runState.innerHTML).toContain("· 2 parked — #20 at spec");
    expect(runState.innerHTML).toContain('<button type="button"');
    // No animation on the amber pill — a static dot, not a spinner/pulse.
    expect(runState.innerHTML).toContain("bg-amber-400");
    expect(runState.innerHTML).not.toContain("wb-spin");
    expect(runState.innerHTML).not.toContain("animate-pulse");

    // Click scrolls to the parking lot — and never POSTs /api/run.
    const scrollArgs: unknown[][] = [];
    ctx.el("parking-lot").scrollIntoView = (...args: unknown[]) => {
      scrollArgs.push(args);
    };
    ctx.click("run-state");
    expect(scrollArgs.length).toBe(1);
    expect(scrollArgs[0][0]).toEqual({ behavior: "smooth", block: "start" });
    expect(ctx.countRequests("/api/run")).toBe(0);

    // Parking resolves the state: last parked item cleared → PAUSED is wrong
    // (a queued item still exists) — the pill falls through to PAUSED.
    const STILL_QUEUED = payload(
      [
        { id: 21, slug: "rejected-me", stage: "pr", status: "human-rejected" },
        { id: 23, slug: "next-up", stage: "spec", status: "queued" },
      ],
      null,
    );
    STILL_QUEUED.counts.decisions = 1;
    ctx.fire("status", STILL_QUEUED);
    expect(runState.innerHTML).toContain("NEEDS REVIEW");
    expect(runState.innerHTML).toContain("· 1 parked — #21 at pr");
  });

  it("renders PAUSED for an idle line with a queued item; the click presses Run and the next snapshot re-enables", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", payload([{ id: 23, slug: "queued-item", stage: "spec", status: "queued" }], null));
    const runState = ctx.el("run-state");
    // Stone pill, static stone dot, blue "press Run" accent — non-error.
    expect(runState.innerHTML).toContain("bg-ink-100");
    expect(runState.innerHTML).toContain("text-ink-700");
    expect(runState.innerHTML).toContain("bg-stone-400");
    expect(runState.innerHTML).toContain("PAUSED");
    expect(runState.innerHTML).toContain('· <span class="text-blue-700">press Run</span> — #23 at spec');
    expect(runState.innerHTML).toContain('<button type="button"');
    expect(runState.innerHTML).not.toContain("wb-spin");

    // Clicking the PAUSED pill is exactly the Run button's action: one POST,
    // spinner + disabled button while the flight is open.
    ctx.click("run-state");
    expect(ctx.countRequests("/api/run")).toBe(1);
    const btn = ctx.el("btn-run");
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toContain("wb-spin");
    expect(btn.getAttribute("aria-busy")).toBe("true");
    // The pill click pressed Run — it did NOT scroll (no glance/parking jump).
    let glanced = 0;
    ctx.el("glance").scrollIntoView = () => {
      glanced++;
    };
    ctx.click("run-state"); // already in flight → guarded no-op, still no scroll
    expect(glanced).toBe(0);

    // 202 accepted: the button stays busy until the next status snapshot.
    await ctx.settle(
      (url) =>
        url === "/api/run"
          ? { ok: true, status: 202, json: async () => ({ started: true }) }
          : undefined,
    );
    expect(btn.disabled).toBe(true);

    // The next status snapshot with the live lock re-enables the button and
    // repaints the pill as RUNNING (with its spinner).
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).not.toContain("wb-spin");
    expect(btn.innerHTML).toContain("▶ Run");
    expect(btn.getAttribute("aria-busy")).toBe(null);
    expect(runState.innerHTML).toContain("RUNNING");
    expect(runState.innerHTML).toContain("wb-spin");
  });

  it("derives the four states with priority: lock alive and stale both beat NEEDS REVIEW", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const runState = ctx.el("run-state");
    // Live lock + parked items: RUNNING wins (never NEEDS REVIEW).
    const LOCKED_WITH_PARKED = payload(
      [
        { id: 22, slug: "runner", stage: "pr", status: "running" },
        { id: 20, slug: "parked", stage: "spec", status: "awaiting-approval" },
      ],
      { alive: true, pid: 7, ageMs: 5000 },
    );
    LOCKED_WITH_PARKED.counts.decisions = 1;
    ctx.fire("status", LOCKED_WITH_PARKED);
    expect(runState.innerHTML).toContain("RUNNING");
    expect(runState.innerHTML).not.toContain("NEEDS REVIEW");

    // Dead lock + parked items: the verbatim stale text wins too (a dead
    // holder must never be silently displaced by an operator state).
    const DEAD_WITH_PARKED = payload(
      [{ id: 20, slug: "parked", stage: "spec", status: "awaiting-approval" }],
      { alive: false, pid: 9, ageMs: 120000 },
    );
    DEAD_WITH_PARKED.counts.decisions = 1;
    ctx.fire("status", DEAD_WITH_PARKED);
    expect(runState.innerHTML).toContain("stale factory lock (pid 9, 2 min ago) — holder is not running");
    expect(runState.innerHTML).not.toContain("NEEDS REVIEW");

    // Decisions beat queued work: PAUSED never shows while decisions > 0
    // (covered above by the review render) — and zero decisions + a queued
    // item is exactly PAUSED (covered by the PAUSED case). Priority chain
    // ends at IDLE for a fully empty payload.
    ctx.fire("status", IDLE_PAYLOAD);
    expect(runState.innerHTML).toContain("IDLE");
    expect(runState.innerHTML).not.toContain("PAUSED");
  });

  it("handles the busy 409: lock pill re-render, busy toast, immediate re-enable, one POST", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", payload([{ id: 23, slug: "queued-item", stage: "spec", status: "queued" }], null));
    ctx.click("btn-run");
    expect(ctx.countRequests("/api/run")).toBe(1);
    expect(ctx.el("btn-run").disabled).toBe(true);

    await ctx.settle(
      (url) =>
        url === "/api/run"
          ? {
              ok: false,
              status: 409,
              json: async () => ({
                busy: true,
                error: "factory is busy — a run is already in progress",
                lock: { alive: true, pid: 7, ageMs: 100 },
              }),
            }
          : undefined,
    );
    // The 409 path renders the fresh (live) lock via the renderLock shim.
    const runState = ctx.el("run-state");
    expect(runState.innerHTML).toContain("RUNNING");
    expect(runState.innerHTML).toContain("(pid 7)");
    expect(ctx.el("toast").textContent).toContain("factory is busy");
    // And its error handling re-enables the Run button immediately.
    const btn = ctx.el("btn-run");
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).not.toContain("wb-spin");
    expect(btn.innerHTML).toContain("▶ Run");
  });

  it("never stacks a second POST while a Run flight is open (button + PAUSED pill)", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", payload([{ id: 23, slug: "queued-item", stage: "spec", status: "queued" }], null));
    ctx.click("btn-run"); // flight opens
    ctx.click("btn-run"); // guarded — no second POST
    ctx.click("run-state"); // PAUSED pill → pressRun, guarded
    ctx.click("run-state");
    expect(ctx.totalRequests("/api/run")).toBe(1);
    expect(ctx.el("btn-run").disabled).toBe(true);

    // 202, then the next status snapshot retires the flight and re-enables.
    const respond = (url: string) =>
      url === "/api/run" ? { ok: true, status: 202, json: async () => ({ started: true }) } : undefined;
    await ctx.settle(respond);
    expect(ctx.el("btn-run").disabled).toBe(true); // still awaiting the snapshot
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(ctx.el("btn-run").disabled).toBe(false);

    // Re-enabled: a fresh press opens a NEW flight (exactly one more POST).
    ctx.click("btn-run");
    expect(ctx.totalRequests("/api/run")).toBe(2);
    ctx.click("btn-run");
    expect(ctx.totalRequests("/api/run")).toBe(2);
    await ctx.settle(respond);
  });

  it("re-enables the Run button via the watchdog deadline when a no-op run produces no status snapshot", async () => {
    // Rework scenario: a 202's "re-enable on the next status snapshot" rule
    // wedges forever when the drive was a no-op — the lock came and went
    // between poll ticks, the fingerprint never changed, no SSE event
    // follows. The awaited-202 state must be backed by a deadline. The
    // page's setTimeout is replaced with a recorder so the test fires the
    // watchdog deterministically (the toast's 2.6s hide timer also lands in
    // the recorder; the watchdog is the one with the multi-second delay).
    const ctx = makeContext();
    const recorded: Array<{ fn: () => void; ms: number }> = [];
    ctx.sandbox.setTimeout = (fn: () => void, ms?: number) => {
      recorded.push({ fn, ms: ms ?? 0 });
    };
    ctx.sandbox.clearTimeout = () => {};
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", payload([{ id: 23, slug: "queued-item", stage: "spec", status: "queued" }], null));
    ctx.click("btn-run");
    expect(ctx.countRequests("/api/run")).toBe(1);

    // 202 accepted — and NO status snapshot ever follows.
    await ctx.settle(
      (url) =>
        url === "/api/run"
          ? { ok: true, status: 202, json: async () => ({ started: true }) }
          : undefined,
    );
    const btn = ctx.el("btn-run");
    expect(btn.disabled).toBe(true); // still busy: nothing has retired the flight yet
    expect(btn.innerHTML).toContain("wb-spin");

    // The watchdog the 202 armed is a real multi-second deadline (≥ 2x the
    // default 2s serve poll interval) — fire it with no snapshot in sight.
    const watchdog = recorded.reduce((a, b) => (b.ms > a.ms ? b : a));
    expect(watchdog.ms).toBeGreaterThanOrEqual(4000);
    watchdog.fn();

    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).not.toContain("wb-spin");
    expect(btn.innerHTML).toContain("▶ Run");
    expect(btn.getAttribute("aria-busy")).toBe(null);

    // The retired flight is consistent: a fresh press opens a NEW one.
    ctx.click("btn-run");
    expect(ctx.totalRequests("/api/run")).toBe(2);
    await ctx.settle(
      (url) =>
        url === "/api/run"
          ? { ok: true, status: 202, json: async () => ({ started: true }) }
          : undefined,
    );
  });

  it("an SSE drop while a POST is still pending does not defeat the no-double-fire guard", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", payload([{ id: 23, slug: "queued-item", stage: "spec", status: "queued" }], null));
    ctx.click("btn-run"); // flight opens, POST pending (unsettled)
    expect(ctx.countRequests("/api/run")).toBe(1);
    expect(ctx.el("btn-run").disabled).toBe(true);

    // SSE dies while the POST is pending. The guarded es.onerror clears only
    // the awaited-202 state, so the flight stays open — the POST's own
    // handlers remain responsible for re-enabling.
    const es = ctx.sandbox.es as unknown as { onerror: () => void };
    expect(typeof es.onerror).toBe("function");
    es.onerror();
    expect(ctx.el("btn-run").disabled).toBe(true);

    // Repeated clicks (button + PAUSED pill) still cannot stack a POST.
    ctx.click("btn-run");
    ctx.click("run-state");
    expect(ctx.totalRequests("/api/run")).toBe(1);

    // The pending POST's own 409 handling re-enables and renders the lock.
    await ctx.settle(
      (url) =>
        url === "/api/run"
          ? {
              ok: false,
              status: 409,
              json: async () => ({
                busy: true,
                error: "factory is busy — a run is already in progress",
                lock: { alive: true, pid: 7, ageMs: 100 },
              }),
            }
          : undefined,
    );
    expect(ctx.el("btn-run").disabled).toBe(false);
    expect(ctx.el("btn-run").innerHTML).toContain("▶ Run");
    expect(ctx.el("run-state").innerHTML).toContain("RUNNING");
    expect(ctx.totalRequests("/api/run")).toBe(1);
  });

  it("restores keyboard focus to the run-state pill after a payload re-render", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // A keyboard user has focused the pill; an SSE status event re-renders
    // #run-state (innerHTML replacement). The replacement button must
    // receive focus() again, so Enter/Space keep working without a Tab-back.
    let focusCalls = 0;
    const fakeBtn = { focus: () => {
      focusCalls++;
    } };
    (ctx.el("run-state") as unknown as { querySelector: (sel: string) => unknown }).querySelector =
      (sel: string) => (sel === "button" ? fakeBtn : null);
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      closest: (sel: string) => (sel === "button" ? { attributes: {} } : null),
    };

    ctx.fire("status", RUNNING_PAYLOAD);
    expect(focusCalls).toBe(1);

    // Re-render with focus elsewhere: no refocus attempt, no crash.
    (ctx.el("run-state") as unknown as { querySelector: (sel: string) => unknown }).querySelector = () => null;
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(focusCalls).toBe(1);
  });

  it("suppresses spinner/pulse/flash animation under prefers-reduced-motion (style block)", () => {
    // Animation suppression is CSS-runtime, not observable in the V8 stub —
    // pinned by the same style-block source greps used for wb-flash today.
    const m = PAGE_HTML.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}/);
    expect(m).not.toBeNull();
    const block = m![1];
    expect(block).toContain(".animate-pulse");
    expect(block).toContain(".wb-flash");
    expect(block).toContain(".wb-spin");
    expect(block).toContain("animation: none");
    // The spinner itself is a class-defined CSS animation (no inline style).
    expect(PAGE_HTML).toMatch(/\.wb-spin\s*\{[^}]*animation:\s*wb-spin/);
  });
});
