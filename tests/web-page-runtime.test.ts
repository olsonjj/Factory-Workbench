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
  title: string;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  listeners: Map<string, Array<() => void>>;
  addEventListener: (t: string, fn: () => void) => void;
  querySelector: () => null;
  focus?: () => void;
  scrollIntoView?: () => void;
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
    title: "",
    attributes,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
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
  const fetch = (url: string) =>
    new Promise((resolve) => {
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
    /** Pending fetch queue — a click while disabled must add nothing. */
    fetches,
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
    /** Let the script's `refreshStatus()` promise (and any .then) settle. */
    settle: async () => {
      for (const f of fetches.splice(0)) f.resolve({ ok: true, json: async () => IDLE_PAYLOAD });
      await new Promise((r) => setTimeout(r, 10));
    },
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

    // Lock cleared: back to IDLE.
    ctx.fire("status", IDLE_PAYLOAD);
    expect(runState.innerHTML).toContain("IDLE");
    expect(runState.innerHTML).not.toContain("RUNNING");
  });

  it("labels the button ▶ Start Processing when idle and disables it as Processing… while a live lock runs", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle(); // the script's initial refreshStatus paints first

    const btn = ctx.el("btn-run");
    // Initial idle paint: static label, enabled, no tooltip, not busy.
    expect(btn.innerHTML).toContain("▶ Start Processing");
    expect(btn.innerHTML).not.toContain("Processing…");
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe("");
    expect(btn.getAttribute("aria-busy")).toBe("false");

    // Live lock: disabled, Processing… with the spinner, stop tooltip.
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toContain("Processing…");
    expect(btn.innerHTML).toContain("wb-spin");
    expect(btn.innerHTML).not.toContain("▶ Start Processing");
    expect(btn.title).toContain("To stop, end wb serve in its terminal");
    expect(btn.getAttribute("aria-busy")).toBe("true");

    // Stale (dead) holder is not a drive in progress: re-enabled, tooltip
    // cleared so it can never linger.
    ctx.fire("status", DEAD_PAYLOAD);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("▶ Start Processing");
    expect(btn.title).toBe("");

    // Lock cleared: fully reverted.
    ctx.fire("status", IDLE_PAYLOAD);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("▶ Start Processing");
    expect(btn.title).toBe("");
    expect(btn.getAttribute("aria-busy")).toBe("false");
  });

  it("fires no POST /api/run while the button is disabled (no double-fire)", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Positive control: an idle click enqueues exactly one POST /api/run.
    ctx.click("btn-run");
    expect(ctx.fetches).toHaveLength(1);
    expect(ctx.fetches[0].url).toBe("/api/run");
    ctx.fetches.splice(0); // drop the control entry (left pending — harmless)

    // Live lock: the button is disabled. The stub dispatches click listeners
    // regardless of the disabled flag (browsers suppress the event), so this
    // click proves the handler's early return: zero new fetch entries.
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(ctx.el("btn-run").disabled).toBe(true);
    ctx.click("btn-run");
    expect(ctx.fetches).toHaveLength(0);
  });

  it("toasts 'processing started …' on 202 (plain and capped) and keeps the 409 busy wording verbatim", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const flush = () => new Promise((r) => setTimeout(r, 10));

    // 202, uncapped: the renamed verb only.
    ctx.click("btn-run");
    ctx.fetches[0].resolve({ status: 202, ok: true, json: async () => ({ started: true }) });
    await flush();
    expect(ctx.el("toast").textContent).toBe("processing started — progress lands in the feed");

    // 202, capped: the suffix survives but names the renamed control.
    ctx.fetches.splice(0);
    ctx.click("btn-run");
    ctx.fetches[0].resolve({ status: 202, ok: true, json: async () => ({ started: true, capped: true }) });
    await flush();
    expect(ctx.el("toast").textContent).toBe(
      "processing started — progress lands in the feed (hit its safety cap — press Start Processing again)",
    );

    // 409: busy wording unchanged, and the fresh lock the response carries
    // disables the button through the same render path (renderLock shim).
    ctx.fetches.splice(0);
    ctx.click("btn-run");
    ctx.fetches[0].resolve({
      status: 409,
      ok: false,
      json: async () => ({ busy: true, error: "factory is busy", lock: { alive: true, pid: 7, ageMs: 1000 } }),
    });
    await flush();
    expect(ctx.el("toast").textContent).toBe("factory is busy — a run is already in progress");
    expect(ctx.el("btn-run").disabled).toBe(true);
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
});
