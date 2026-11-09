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
  readonly innerHTMLWrites: number;
  textContent: string;
  className: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  listeners: Map<string, Array<() => void>>;
  addEventListener: (t: string, fn: () => void) => void;
  querySelector: () => null;
  /** Default empty: the stub has no focusable DOM. A Tab-trap test installs
   *  its own list. */
  querySelectorAll: (q: string) => unknown[];
  focus?: () => void;
  scrollIntoView?: (opts?: unknown) => void;
}

function makeStubElement(): StubElement {
  const listeners: Map<string, Array<() => void>> = new Map();
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  let html = "";
  let innerHTMLWrites = 0;
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; innerHTMLWrites += 1; },
    get innerHTMLWrites() { return innerHTMLWrites; },
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
    removeAttribute: (name) => {
      delete attributes[name];
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
    querySelectorAll: () => [],
  };
}

/** Script context stubs: elements auto-vivify per id (one per id, browser-like), and the fetch/EventSource pair is handed to the test. */
function makeContext() {
  const elements = new Map<string, StubElement>();
  /** Document-level listeners (e.g. the overlay's Esc keydown), captured so
   *  tests can dispatch synthetic events exactly like the browser would. */
  const documentListeners = new Map<string, Array<(ev: unknown) => void>>();
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
    addEventListener: (t: string, fn: (ev: unknown) => void) => {
      const fns = documentListeners.get(t) ?? [];
      fns.push(fn);
      documentListeners.set(t, fns);
    },
  };

  /** Persistent per-context localStorage: the page's flight-panel preference
   * store. A fresh context is a fresh origin, so "reload" is a NEW context
   * whose store is seeded from the first page's (the same entries a browser
   * would carry across a reload). */
  const localStorage = (() => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      /** Test-side readback of everything stored (for seed-snapshot asserts). */
      dump: () => Object.fromEntries(store),
    };
  })();

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
    localStorage,
  };
  vm.createContext(sandbox);
  return {
    sandbox,
    /** The same object the page's script sees as global `localStorage`. */
    localStorage,
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
    /** Same class-sync discipline for the in-flight panel's body: the stub's
     * classList is mirrored from the rendered #pulse markup (`id="flight-body"
     * … hidden"` collapsed vs `…` open) before a toggle click, so a writer
     * that stopped adding/removing `hidden` would fail the assertion. */
    syncFlightBodyFromMarkup: () => {
      const markup = document.getElementById("pulse").innerHTML;
      const body = document.getElementById("flight-body");
      if (/id="flight-body"[^>]*\bhidden\b/.test(markup)) body.classList.add("hidden");
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
    /** Dispatch a captured document-level listener (e.g. the overlay's Esc
     * keydown) — the same call the browser makes for a real key press. */
    dispatchDocument: (t: string, ev: unknown) => {
      for (const fn of documentListeners.get(t) ?? []) fn(ev);
    },
    /** Let the script's `refreshStatus()` promise (and any .then) settle.
     * The optional responder resolves per-URL — the POST `/api/run` cases
     * need a real `status` field (202/409), which the generic IDLE-shaped
     * default (no `status`) cannot express; overlay fetches need `text()`
     * for the artifact-route (markdown) responses. Unhandled URLs fall
     * back to the default. */
    settle: async (respond?: (url: string) => unknown) => {
      const def = { ok: true, status: 200, json: async () => IDLE_PAYLOAD, text: async () => "" };
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
    expect(btn.title).toContain("lock holder pid 7");
    expect(btn.title).toContain("wb serve or wb run/wb resume");
    expect(ctx.el("run-state").title).toBe(btn.title);
    expect(btn.getAttribute("aria-busy")).toBe("true");

    // Stale (dead) holder is not a drive in progress: re-enabled, tooltip
    // cleared so it can never linger.
    ctx.fire("status", DEAD_PAYLOAD);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toContain("▶ Start Processing");
    expect(btn.title).toBe("");
    expect(ctx.el("run-state").title).toBe("");

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

    // The 202 flight stays open until a status snapshot retires it; an idle
    // snapshot (lock already cleared) re-enables the button for the next press.
    ctx.fire("status", IDLE_PAYLOAD);

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
    // Retire the previous 202 flight first so the press is admitted.
    ctx.fire("status", IDLE_PAYLOAD);
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

    // A short-lived holder can disappear before this response arrives. The
    // immediate status refresh is the re-enable path even when no later SSE
    // fingerprint change occurs.
    expect(ctx.fetches).toHaveLength(2);
    expect(ctx.fetches[1].url).toBe("/api/status");
    ctx.fetches[1].resolve({ status: 200, ok: true, json: async () => IDLE_PAYLOAD });
    await flush();
    expect(ctx.el("btn-run").disabled).toBe(false);
  });

  it("does not repaint the Start Processing spinner for repeated busy snapshots", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const btn = ctx.el("btn-run");
    ctx.fire("status", RUNNING_PAYLOAD);
    const writesAfterFirstBusyPaint = btn.innerHTMLWrites;
    ctx.fire("status", payload(
      [{ id: 22, slug: "make-the-running-state-unmissable-in-the-web-ui-header", stage: "pr", status: "running" }],
      { alive: true, pid: 7, ageMs: 70_000 },
    ));
    expect(btn.innerHTMLWrites).toBe(writesAfterFirstBusyPaint);
    expect(btn.innerHTML).toContain("wb-spin");

    ctx.fire("status", DEAD_PAYLOAD);
    expect(btn.innerHTMLWrites).toBe(writesAfterFirstBusyPaint + 1);
    expect(btn.disabled).toBe(false);
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

  it("makes the inbox pulse tile clickable — expands the glance, scrolls to it, and focuses the first claimable chip", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const INBOX = payload([{ id: 31, slug: "epsilon", status: "done" }], null, {
      claimable: ["a.md", "b.md"],
    });
    ctx.fire("status", INBOX);

    // A non-empty inbox renders the tile as a real <button> (keyboard path);
    // a drained inbox reverts to the plain non-clickable div.
    expect(ctx.el("pulse").innerHTML).toContain('<button type="button" data-tile-inbox');
    const glance = ctx.el("glance");
    expect(glance.innerHTML).toContain('id="glance-body" class="mt-3 hidden"');
    ctx.fire("status", IDLE_PAYLOAD);
    expect(ctx.el("pulse").innerHTML).not.toContain("data-tile-inbox");

    ctx.fire("status", INBOX);
    // Install a focus spy + chip lookup the way the Tab-trap tests install
    // their own DOM: the stub's default querySelector returns null (the
    // scroll/focus guards must tolerate that), so a REAL chip target proves
    // the handler actually focuses the first claimable chip.
    const focusLog: string[] = [];
    const scrollLog: string[] = [];
    glance.scrollIntoView = (opts: unknown) => scrollLog.push(JSON.stringify(opts));
    glance.querySelector = ((sel: string) =>
      sel === "[data-inbox-file]"
        ? { focus: (o: unknown) => focusLog.push(JSON.stringify(o)) }
        : null) as unknown as StubElement["querySelector"];

    // Collapsed → click the tile → expanded + scrolled + first chip focused.
    ctx.syncGlanceBodyFromMarkup();
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(true);
    ctx.click("pulse", {
      closest: (sel: string) => (sel === "button[data-tile-inbox]" ? { attributes: {} } : null),
    });
    expect(ctx.el("glance-body").classList.contains("hidden")).toBe(false);
    expect(scrollLog).toEqual(['{"behavior":"smooth","block":"start"}']);
    expect(focusLog).toEqual(['{"preventScroll":true}']);

    // The expansion survives the NEXT payload re-render (glanceCollapsed is
    // the single source of truth — same sticky guarantee as the summary toggle).
    ctx.fire("status", INBOX);
    expect(ctx.el("glance").innerHTML).toContain('id="glance-body" class="mt-3"');
    expect(ctx.el("glance").innerHTML).toContain('aria-expanded="true"');

    // An unrelated pulse click (a flight row) must not re-trigger the tile path.
    ctx.click("pulse", { closest: () => null });
    expect(focusLog).toHaveLength(1);
  });

  it("caps glance chips at the newest 10 with a More… control that expands and restores", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // 14 landed items: only the newest 10 render; the summary count still
    // says the whole truth (14 landed).
    const BACKLOG = payload(
      Array.from({ length: 14 }, (_, i) => ({ id: i + 1, slug: "s" + (i + 1), stage: "pr", status: "done" })),
      null,
    );
    ctx.fire("status", BACKLOG);
    let html = ctx.el("glance").innerHTML;
    expect(html).toContain("14 landed");
    expect(html).toContain('#14 s14');   // newest leads
    expect(html).not.toContain('#4 s4'); // 11th item is below the cap
    expect(html).toContain('data-glance-more');
    expect(html).toContain("More… (4 older)");
    expect(html).not.toContain("data-glance-less");

    // More… reveals the rest: every chip renders, the control flips to the
    // restore direction (the just-clicked button is replaced by the
    // re-render — one-shot by design).
    ctx.click("glance", { closest: (sel: string) => (sel === "button[data-glance-more]" ? { attributes: {} } : null) });
    html = ctx.el("glance").innerHTML;
    expect(html).toContain('#4 s4');
    expect(html).toContain('#1 s1');
    expect(html).not.toContain("data-glance-more");
    expect(html).toContain("data-glance-less");
    expect(html).toContain("show the newest 10 only");

    // The expansion is sticky across payload re-renders (glanceShowAll is
    // the single source of truth, same guarantee as the collapse state).
    ctx.fire("status", BACKLOG);
    expect(ctx.el("glance").innerHTML).toContain('#1 s1');
    expect(ctx.el("glance").innerHTML).toContain("data-glance-less");

    // The restore control drops back to the recency window.
    ctx.click("glance", { closest: (sel: string) => (sel === "button[data-glance-less]" ? { attributes: {} } : null) });
    html = ctx.el("glance").innerHTML;
    expect(html).not.toContain('#4 s4');
    expect(html).toContain('#14 s14');
    expect(html).toContain("data-glance-more");
    // The click that hit neither the window controls nor the summary button
    // is ignored (no state flip).
    ctx.click("glance", { closest: () => null });
    expect(ctx.el("glance").innerHTML).toContain("data-glance-more");
  });

  it("caps only landed chips at exactly the boundary — 10 done renders no window control", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Strict '>': exactly GLANCE_CAP landed items means capped stays false —
    // no More…, nothing hidden.
    const TEN = payload(
      Array.from({ length: 10 }, (_, i) => ({ id: i + 1, slug: "s" + (i + 1), stage: "pr", status: "done" })),
      null,
    );
    ctx.fire("status", TEN);
    const html = ctx.el("glance").innerHTML;
    expect(html).toContain("10 landed");
    expect(html).toContain("#1 s1");
    expect(html).not.toContain("data-glance-more");
    expect(html).not.toContain("data-glance-less");
  });

  it("never caps running/queued chips — a long-running item below 10 newer landed items still flashes", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Item #2 runs through a long stage while #3–#14 land: 12 landed + 1
    // running. The cap keeps the newest 10 done chips but #2's chip must
    // still exist — the RUNNING-pill flash queries it by data-item-id, and
    // dropping it would silently no-op the affordance (reviewer finding 1).
    const LONG_RUN = payload(
      [
        { id: 2, slug: "slow-runner", stage: "build", status: "running" },
        ...Array.from({ length: 12 }, (_, i) => ({ id: i + 3, slug: "s" + (i + 3), stage: "pr", status: "done" })),
      ],
      { alive: true, pid: 7, ageMs: 1000 },
    );
    ctx.fire("status", LONG_RUN);
    const html = ctx.el("glance").innerHTML;
    expect(html).toContain('#2 slow-runner'); // live chip escapes the cap
    expect(html).toContain('data-item-id="2"'); // flash target resolvable
    expect(html).not.toContain('#4 s4');        // 11th landed item is below the cap
    expect(html).toContain("More… (2 older)");
  });

  it("tolerates a stale inbox-tile click after the inbox drained between snapshots (documented guard)", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", payload([], null, { claimable: ["a.md"] }));
    expect(ctx.el("pulse").innerHTML).toContain("data-tile-inbox");

    // The inbox drains (Run claims the file) before the user's click lands:
    // the tile is now a plain div, and the glance re-rendered to the empty
    // state. The stale delegated click must still be a safe no-op — expand
    // applies to nothing, chip focus is conditional, nothing throws.
    ctx.fire("status", IDLE_PAYLOAD);
    expect(ctx.el("pulse").innerHTML).not.toContain("data-tile-inbox");
    expect(ctx.el("glance").innerHTML).toContain("no items in flight");
    expect(() =>
      ctx.click("pulse", {
        closest: (sel: string) => (sel === "button[data-tile-inbox]" ? { attributes: {} } : null),
      }),
    ).not.toThrow();
    expect(ctx.el("glance").innerHTML).toContain("no items in flight");
  });

  it("carries keyboard focus across a snapshot for the chip-window controls, not just the summary button", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Greptile PR-33 finding: once More/Less refocusing puts keyboard focus
    // on the window control, the ~2s SSE snapshot that repainted the
    // section used to drop focus to <body>. The focus-capture path must be
    // selector-aware: whichever control was focused gets its new twin
    // focused (the stub's focus spy records WHICH selector was restored).
    const BACKLOG = payload(
      Array.from({ length: 14 }, (_, i) => ({ id: i + 1, slug: "s" + (i + 1), stage: "pr", status: "done" })),
      null,
    );
    ctx.fire("status", BACKLOG);
    const focusLog: string[] = [];
    (ctx.el("glance") as unknown as { querySelector: (sel: string) => unknown }).querySelector =
      (sel: string) => (sel.indexOf("data-glance-more") >= 0 || sel.indexOf("data-glance-less") >= 0
        ? { focus: () => focusLog.push(sel) }
        : null);

    // 1) SSE snapshot with the More… control focused → its twin restored.
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      closest: (sel: string) => (sel === "button[data-glance-more]" ? { attributes: {} } : null),
    };
    ctx.fire("status", BACKLOG);
    expect(focusLog).toEqual(["button[data-glance-more]"]);

    // 2) The More… click: the re-render's capture path first restores the
    // (about-to-be-replaced) focused More — activeElement is still on it —
    // then the handler refocuses the LESS counterpart; the FINAL focus is
    // what matters (finding-3 fix), the intermediate entry is the
    // capture-path restore of the node the click is destroying.
    ctx.click("glance", { closest: (sel: string) => (sel === "button[data-glance-more]" ? { attributes: {} } : null) });
    expect(focusLog).toHaveLength(3);
    expect(focusLog[2]).toBe("button[data-glance-less]");
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      closest: (sel: string) => (sel === "button[data-glance-less]" ? { attributes: {} } : null),
    };
    ctx.fire("status", BACKLOG);
    expect(focusLog).toHaveLength(4);
    expect(focusLog[3]).toBe("button[data-glance-less]");

    // 3) Focus elsewhere → no refocus attempt, no crash (prior discipline).
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = undefined;
    (ctx.el("glance") as unknown as { querySelector: (sel: string) => unknown }).querySelector = () => null;
    ctx.fire("status", BACKLOG);
    expect(focusLog).toHaveLength(4);
  });

  it("orders the glance chips newest-first so the recently-landed work leads", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // db.listItems feeds the payload ascending by id (oldest first); the
    // chip render must reverse it — the top of a 26-done backlog is the
    // interesting end.
    const BACKLOG = payload(
      [
        { id: 11, slug: "alpha", stage: "pr", status: "done" },
        { id: 13, slug: "gamma", stage: "review", status: "done" },
        { id: 14, slug: "delta", stage: "build", status: "running" },
        { id: 12, slug: "beta", stage: "pr", status: "done" },
      ],
      null,
    );
    ctx.fire("status", BACKLOG);
    const html = ctx.el("glance").innerHTML;
    expect(html.indexOf('#14 delta')).toBeLessThan(html.indexOf('#13 gamma'));
    expect(html.indexOf('#13 gamma')).toBeLessThan(html.indexOf('#12 beta'));
    expect(html.indexOf('#12 beta')).toBeLessThan(html.indexOf('#11 alpha'));
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
    // Stone pill, static stone dot, blue "press Start Processing" accent — non-error.
    expect(runState.innerHTML).toContain("bg-ink-100");
    expect(runState.innerHTML).toContain("text-ink-700");
    expect(runState.innerHTML).toContain("bg-stone-400");
    expect(runState.innerHTML).toContain("PAUSED");
    expect(runState.innerHTML).toContain('· <span class="text-blue-700">press Start Processing</span> — #23 at spec');
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

    // The next status snapshot retires the flight, then the LIVE lock takes
    // over the button: Processing… + disabled while the drive runs (the
    // lock-driven writer), and the pill repaints as RUNNING with its spinner.
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toContain("wb-spin");
    expect(btn.innerHTML).toContain("Processing…");
    expect(btn.getAttribute("aria-busy")).toBe("true");
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
    // The flight retires immediately; with a LIVE lock in the response the
    // lock-driven writer owns the button: Processing… + disabled while that
    // drive runs (the immediate status refresh re-enables it if the holder
    // already exited).
    const btn = ctx.el("btn-run");
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toContain("Processing…");
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

    // 202, then the next status snapshot retires the flight; the LIVE lock
    // then owns the button (Processing… + disabled) while the drive runs.
    const respond = (url: string) =>
      url === "/api/run" ? { ok: true, status: 202, json: async () => ({ started: true }) } : undefined;
    await ctx.settle(respond);
    expect(ctx.el("btn-run").disabled).toBe(true); // still awaiting the snapshot
    ctx.fire("status", RUNNING_PAYLOAD);
    expect(ctx.el("btn-run").disabled).toBe(true); // live lock: Processing…, not clickable
    expect(ctx.el("btn-run").innerHTML).toContain("Processing…");

    // Lock cleared: re-enabled, and a fresh press opens a NEW flight
    // (exactly one more POST).
    ctx.fire("status", IDLE_PAYLOAD);
    expect(ctx.el("btn-run").disabled).toBe(false);
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
    expect(btn.innerHTML).toContain("▶ Start Processing");
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
    expect(ctx.el("btn-run").disabled).toBe(true); // live lock in the 409: Processing… until the refresh reconciles
    expect(ctx.el("btn-run").innerHTML).toContain("Processing…");
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
    (ctx.el("run-state") as unknown as {
      querySelector: (sel: string) => unknown;
      contains: (node: unknown) => boolean;
    }).querySelector = (sel: string) => (sel === "button" ? fakeBtn : null);
    const focusedPill = {
      closest: (sel: string) => (sel === "button" ? { attributes: {} } : null),
    };
    (ctx.el("run-state") as unknown as { contains: (node: unknown) => boolean }).contains =
      (node: unknown) => node === focusedPill;
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = focusedPill;

    ctx.fire("status", RUNNING_PAYLOAD);
    expect(focusCalls).toBe(1);

    // Re-render with focus on another button: the replacement stays available,
    // so dropping the contains guard would incorrectly steal focus and fail.
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      closest: (sel: string) => (sel === "button" ? { attributes: {} } : null),
    };
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

  /* ---------- flow-order pulse tiles + in-flight panel (specs/
   * wb-serve-flight-panel.md): the flight-panel fixtures/section. ---------- */

  // Fake target for the delegated flight-panel toggle click: only `closest`
  // matters (parking-lot/glance pattern). Distinct from the glance summary
  // selector so the two delegated listeners cannot cross-fire.
  const FLIGHT_SUMMARY_TARGET = {
    closest: (sel: string) => (sel.indexOf("data-flight-summary") >= 0 ? { attributes: {} } : null),
  };
  const NOT_FLIGHT_SUMMARY_TARGET = { closest: () => null };

  const MIXED_FLIGHT_PAYLOAD = payload(
    [
      { id: 11, slug: "alpha", title: "Alpha spec title", repo: "Code/factory-1", stage: "implement", status: "running" },
      { id: 12, slug: "beta", title: "Beta queued title", repo: "Code/rel/other", stage: "spec", status: "queued" },
      { id: 13, slug: "gamma", title: "Gamma landed title", repo: "Code/factory-1", status: "done" },
    ],
    null,
  );

  /** One chunk per data-flight-row marker: each chunk carries that row's
   * content (title, repo, pill, six-dot track) up to the next row. */
  function flightRows(markup: string): string[] {
    return markup.split("data-flight-row=").slice(1);
  }
  /** The six stage-dot fills of one row, in stage order. */
  function dotFills(chunk: string): string[] {
    return [...chunk.matchAll(/class="h-2\.5 w-2\.5 rounded-full ([^"]*)"/g)].map((m) => m[1]);
  }

  it("renders the pulse row as three tiles in flow order — inbox → in flight → waiting on you — with no landed tile", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    const pulse = ctx.el("pulse").innerHTML;
    expect(pulse).toContain("grid grid-cols-3"); // three tiles, not the old four
    const inbox = pulse.indexOf(">inbox</div>");
    const flight = pulse.indexOf(">in flight</div>");
    const waiting = pulse.indexOf(">waiting on you</div>");
    expect(inbox).toBeGreaterThanOrEqual(0);
    expect(inbox).toBeLessThan(flight);
    expect(flight).toBeLessThan(waiting);

    // The landed tile is dropped from the pulse row entirely: neither its
    // label, its sub, nor its accent lives in the tiles region (before the
    // flow bar). It survives only in the flow bar + glance section.
    const tiles = pulse.slice(0, pulse.indexOf("mt-3 rounded-full"));
    expect(tiles).not.toContain("landed");
    expect(tiles).not.toContain("PRs ready for review");
    expect(tiles).not.toContain("bg-emerald-500");
    // Accents stay attached to their tiles (D1): inbox stone, in-flight blue,
    // waiting-on-you amber.
    expect(tiles).toContain("bg-ink-400");
    expect(tiles).toContain("bg-blue-500");
    expect(tiles).toContain("bg-amber-400");
  });

  it("renders one panel row per queued/running item — title, repo, six dots, stage label — and updates across SSE snapshots", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Fresh page with items in flight: the panel is OPEN by default (D3).
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    let pulse = ctx.el("pulse").innerHTML;
    expect(pulse).toContain("In flight");
    expect(pulse).toContain("· 1 running · 1 queued");
    expect(pulse).toContain('aria-expanded="true"');
    expect(pulse).not.toMatch(/id="flight-body"[^>]*\bhidden\b/);

    const rows = flightRows(pulse);
    expect(rows).toHaveLength(2);

    // Running row: title + repo, six-dot track filled through the current
    // stage (emerald, blue pulsing head), stage label = current stage name.
    const running = rows[0];
    expect(running.startsWith('"11"')).toBe(true); // keyed by item id
    expect(running).toContain("Alpha spec title");
    expect(running).toContain("Code/factory-1");
    expect(dotFills(running)).toEqual([
      "bg-emerald-500",
      "bg-emerald-500",
      "bg-blue-500 animate-pulse",
      "bg-ink-300",
      "bg-ink-300",
      "bg-ink-300",
    ]);
    expect(running).toContain("text-blue-700"); // running pill palette
    // Stage label: the PILL carries the current stage name. Assert the pill
    // markup specifically — stageDots also renders all six stage names as
    // dotted-labels in every row, so a bare contains('implement') is vacuous.
    expect(running).toMatch(/ring-blue-200\">implement<\/span>/);

    // Queued row sits after the running row (attention order), all dots
    // hollow, stage label 'queued', nothing animating.
    const queued = rows[1];
    expect(queued.startsWith('"12"')).toBe(true);
    expect(queued).toContain("Beta queued title");
    expect(queued).toContain("Code/rel/other");
    expect(queued).toContain('">queued</span>');
    expect(queued).not.toContain("bg-emerald-500");
    expect(queued).not.toContain("animate-pulse");
    expect(dotFills(queued)).toEqual(Array(6).fill("bg-ink-300"));
    expect(pulse.indexOf('data-flight-row="11"')).toBeLessThan(pulse.indexOf('data-flight-row="12"'));

    // Next snapshot: #11 lands, #14 starts at test — rows follow live, no reload.
    ctx.fire(
      "status",
      payload(
        [
          { id: 14, slug: "delta", title: "Delta next title", repo: "Code/factory-1", stage: "test", status: "running" },
          { id: 11, slug: "alpha", title: "Alpha spec title", repo: "Code/factory-1", status: "done" },
          { id: 12, slug: "beta", title: "Beta queued title", repo: "Code/rel/other", stage: "spec", status: "queued" },
        ],
        null,
      ),
    );
    pulse = ctx.el("pulse").innerHTML;
    expect(pulse).not.toContain("Alpha spec title"); // landed → off the panel
    const next = flightRows(pulse);
    expect(next).toHaveLength(2);
    expect(next[0].startsWith('"14"')).toBe(true);
    expect(next[0]).toContain("Delta next title");
    expect(next[0]).toContain("text-blue-700");
    expect(dotFills(next[0])).toEqual([
      "bg-emerald-500",
      "bg-emerald-500",
      "bg-emerald-500",
      "bg-blue-500 animate-pulse",
      "bg-ink-300",
      "bg-ink-300",
    ]);
  });

  it("defaults a fresh page's collapse: open when items are in flight, closed when idle", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle(); // initial paint: idle payload, no stored choice

    const pulse = () => ctx.el("pulse").innerHTML;
    expect(ctx.localStorage.dump()).toEqual({}); // nothing stored — the default owns the state
    expect(pulse()).toMatch(/id="flight-body"[^>]*\bhidden\b/);
    expect(pulse()).toContain('aria-expanded="false"');

    ctx.fire("status", MIXED_FLIGHT_PAYLOAD); // running + queued > 0 → default open
    expect(pulse()).toContain('aria-expanded="true"');
    expect(pulse()).not.toMatch(/id="flight-body"[^>]*\bhidden\b/);

    ctx.fire("status", payload([{ id: 13, slug: "gamma", status: "done" }], null)); // nothing in flight → closed
    expect(pulse()).toMatch(/id="flight-body"[^>]*\bhidden\b/);
    expect(pulse()).toContain('aria-expanded="false"');
  });

  it("persists an explicit open choice: it survives reload, shows the idle line, and beats the default", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle(); // idle → collapsed by default

    // The operator opens the panel while the factory is idle — never a void.
    ctx.syncFlightBodyFromMarkup();
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(true);
    ctx.click("pulse", FLIGHT_SUMMARY_TARGET);
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(false);
    // The choice was stored immediately (the browser persists it before any
    // status event can re-render the panel).
    expect(ctx.localStorage.getItem("wb:flight-panel")).toBe("open");

    // The choice beats the default in every payload shape: a busy factory
    // must NOT auto-close an explicitly opened panel either.
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    expect(ctx.el("pulse").innerHTML).toContain('aria-expanded="true"');
    expect(ctx.el("pulse").innerHTML).not.toMatch(/id="flight-body"[^>]*\bhidden\b/);

    // Reload: a fresh context carries the same stored choice. Idle factory,
    // stored 'open' → the panel opens (the default would have kept it shut).
    const ctx2 = makeContext();
    const stored = ctx.localStorage.dump();
    for (const key of Object.keys(stored)) ctx2.localStorage.setItem(key, stored[key]);
    ctx2.run(pageScript(PAGE_HTML));
    await ctx2.settle(); // /api/status responds with the default idle payload
    expect(ctx2.el("pulse").innerHTML).toContain('aria-expanded="true"');
    expect(ctx2.el("pulse").innerHTML).toContain("factory idle — 0 landed");
  });

  it("persists an explicit collapsed choice: no auto-open against the user, but header counts still update", async () => {
    // First page: the panel opens by default on a busy factory; the operator
    // collapses it — that choice persists.
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    ctx.syncFlightBodyFromMarkup();
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(false);
    ctx.click("pulse", FLIGHT_SUMMARY_TARGET);
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(true);
    expect(ctx.localStorage.getItem("wb:flight-panel")).toBe("collapsed");

    // Reload with the stored choice: new in-flight arrivals do NOT auto-open.
    const ctx2 = makeContext();
    const stored = ctx.localStorage.dump();
    for (const key of Object.keys(stored)) ctx2.localStorage.setItem(key, stored[key]);
    ctx2.run(pageScript(PAGE_HTML));
    await ctx2.settle();
    ctx2.fire(
      "status",
      payload(
        [
          { id: 11, slug: "alpha", title: "Alpha spec title", repo: "Code/factory-1", stage: "implement", status: "running" },
          { id: 14, slug: "delta", title: "Delta next title", repo: "Code/factory-1", stage: "test", status: "running" },
          { id: 12, slug: "beta", title: "Beta queued title", repo: "Code/rel/other", stage: "spec", status: "queued" },
        ],
        null,
      ),
    );
    const pulse2 = ctx2.el("pulse").innerHTML;
    expect(pulse2).toMatch(/id="flight-body"[^>]*\bhidden\b/);
    expect(pulse2).toContain('aria-expanded="false"');
    // …but the collapsed header still recounts, live: 2 running · 1 queued.
    expect(pulse2).toContain("· 2 running · 1 queued");
    expect(pulse2).toContain('">3</span>'); // the right-edge live total
  });

  it("renders the idle line 'factory idle — N landed' when the open panel has no rows", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    const LANDED = payload(
      [
        { id: 2, slug: "first", status: "done" },
        { id: 3, slug: "second", status: "done" },
        { id: 4, slug: "third", status: "done" },
      ],
      null,
    );
    ctx.fire("status", LANDED);
    // The body already carries the idle line for this payload.
    expect(ctx.el("pulse").innerHTML).toContain("factory idle — 3 landed");
    expect(flightRows(ctx.el("pulse").innerHTML)).toHaveLength(0);
    // Default would keep it closed (zero in flight) — the operator opens it;
    // the idle line is what becomes visible, never blank space.
    ctx.syncFlightBodyFromMarkup();
    ctx.click("pulse", FLIGHT_SUMMARY_TARGET);
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(false);
  });

  it("toggle is a real keyboard-activatable button via the shared click path; non-summary clicks are no-ops", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    let pulse = ctx.el("pulse").innerHTML;
    // <button type="button">: Enter/Space synthesize the same click the
    // delegated #pulse listener handles — the shared click path IS the
    // keyboard path (glance-toggle pattern).
    expect(pulse).toContain('<button type="button"');
    expect(pulse).toContain("data-flight-summary");
    expect(pulse).toContain('title="expand/collapse the in-flight detail"');

    ctx.syncFlightBodyFromMarkup();
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(false);
    ctx.click("pulse", FLIGHT_SUMMARY_TARGET);
    // No re-render between click and assert: the writer's own classList change
    // is the thing under test (the glanced-synced stub would otherwise erase it).
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(true);

    // A click that does not originate on the summary button is ignored.
    ctx.click("pulse", NOT_FLIGHT_SUMMARY_TARGET);
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(true); // still collapsed from the toggle above

    // A later snapshot re-renders from the persisted choice: stays collapsed.
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    pulse = ctx.el("pulse").innerHTML;
    expect(pulse).toMatch(/id="flight-body"[^>]*\bhidden\b/);
    expect(pulse).toContain('aria-expanded="false"');
  });

  it("escapes untrusted row content: a hostile title/repo renders inert in the flight rows", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // Untrusted data (item titles/repos) interpolated into rows must be
    // escaped at the interpolation site (the page's KB 2026-10-27 rule).
    ctx.fire(
      "status",
      payload(
        [{ id: 15, slug: "hostile", title: "Alpha <img src=x onerror=alert(1)>", repo: "Code/rel<b>x</b>", stage: "implement", status: "running" }],
        null,
      ),
    );
    const row = flightRows(ctx.el("pulse").innerHTML)[0];
    expect(row).toContain("Alpha &lt;img src=x"); // escaped at the site
    expect(row).not.toContain("<img src=x"); // never a live tag
    expect(row).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(row).not.toContain("<b>x</b>");
  });

  it("restores keyboard focus to the flight summary button after a payload re-render", async () => {
    const ctx = makeContext();
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    // A keyboard user has focused the flight summary button; an SSE status
    // event re-renders #pulse (innerHTML replacement). The replacement button
    // must receive focus() again — which requires the hadFocus capture to run
    // BEFORE the write (after it, activeElement is already <body>).
    let focusCalls = 0;
    const fakeBtn = { focus: () => {
      focusCalls++;
    } };
    (ctx.el("pulse") as unknown as { querySelector: (sel: string) => unknown }).querySelector =
      (sel: string) => (sel === "button[data-flight-summary]" ? fakeBtn : null);
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      closest: (sel: string) => (sel === "button[data-flight-summary]" ? { attributes: {} } : null),
    };

    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    expect(focusCalls).toBe(1);

    // Re-render with focus elsewhere: no refocus attempt, no crash.
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = undefined;
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    expect(focusCalls).toBe(1);
  });

  it("keeps an explicit toggle across snapshots even when the storage write fails (no flap)", async () => {
    // Storage reads always return null and writes throw: the in-memory
    // explicit choice must keep the panel collapsed across SSE snapshots —
    // the next ~2s snapshot would otherwise re-derive the default and undo
    // the user's click mid-session.
    const ctx = makeContext();
    ctx.sandbox.localStorage.getItem = () => null;
    ctx.sandbox.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", MIXED_FLIGHT_PAYLOAD); // busy → default open
    ctx.syncFlightBodyFromMarkup();
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(false);
    ctx.click("pulse", FLIGHT_SUMMARY_TARGET); // collapse; the write throws
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(true);

    // The next snapshot must NOT flap the panel back to the default-open.
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    const pulse = ctx.el("pulse").innerHTML;
    expect(pulse).toMatch(/id="flight-body"[^>]*\bhidden\b/);
    expect(pulse).toContain('aria-expanded="false"');
  });

  it("keeps an explicit toggle over a STALE stored pref when the storage write fails (no reopen)", async () => {
    // Reads return a stored 'open' (a previous session's choice) but writes
    // throw: the click's in-memory explicit choice — the newest user signal —
    // must beat the persisted-but-stale pref across snapshots. Reading the
    // old value instead would visibly reopen the panel after every SSE tick.
    const ctx = makeContext();
    ctx.sandbox.localStorage.getItem = (key: string) => (key === "wb:flight-panel" ? "open" : null);
    ctx.sandbox.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();

    ctx.fire("status", MIXED_FLIGHT_PAYLOAD); // busy → stored 'open' wins pre-toggle
    ctx.syncFlightBodyFromMarkup();
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(false);
    ctx.click("pulse", FLIGHT_SUMMARY_TARGET); // collapse; the write throws
    expect(ctx.el("flight-body").classList.contains("hidden")).toBe(true);

    // The next snapshot must NOT flap the panel back to the stored 'open'.
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    const pulse = ctx.el("pulse").innerHTML;
    expect(pulse).toMatch(/id="flight-body"[^>]*\bhidden\b/);
    expect(pulse).toContain('aria-expanded="false"');
  });

  /* ---------- item detail overlay (specs/wb-serve-item-overlay.md):
   * open/close/focus/SSE-coexistence/error+retry and the escaped-first
   * markdown renderer, all through the page seam. ---------- */

  /** Fake targets for the delegated entry clicks: each implements `closest`
   * itself (the established pattern) and answers only the selector(s) the
   * handler under test probes. */
  const FLIGHT_ROW_TARGET = {
    closest: (sel: string) => (sel === "[data-flight-row]" ? { getAttribute: () => "11" } : null),
  };
  const CARD_TARGET = {
    closest: (sel: string) => (sel === "[data-id]" ? { getAttribute: () => "20" } : null),
  };
  const GLANCE_CHIP_TARGET = {
    closest: (sel: string) => (sel === "[data-item-id]" ? { getAttribute: () => "13" } : null),
  };
  const INBOX_ROW_TARGET = {
    closest: (sel: string) => (sel === "[data-inbox-file]" ? { getAttribute: () => "a.md" } : null),
  };
  const OVERLAY_CLOSE_TARGET = {
    closest: (sel: string) => (sel === "button[data-overlay-close]" ? {} : null),
  };
  const OVERLAY_RETRY_TARGET = {
    closest: (sel: string) => (sel === "button[data-overlay-retry]" ? {} : null),
  };
  const OVERLAY_ARTIFACT_TARGET = {
    closest: (sel: string) => (sel === "[data-overlay-artifact]" ? { getAttribute: () => "items/alpha/artifacts/20261108-090500-001-implement.md" } : null),
  };
  const BACKDROP_TARGET = { closest: () => null };
  const PANEL_INSIDE_TARGET = {
    closest: (sel: string) => (sel === "[data-overlay-panel]" ? {} : null),
  };
  /** A card click that originates on an action button: handled by the action
   *  branch (never opens the overlay). The fake card carries just enough for
   *  the harmless reject-cancel action to complete. */
  const ACTION_TARGET = {
    closest: (sel: string) => {
      if (sel !== "button[data-action]") return null;
      return {
        getAttribute: () => "reject-cancel",
        closest: () => ({
          getAttribute: () => "20",
          querySelector: () => ({ classList: { add: () => {}, remove: () => {} } }),
        }),
      };
    },
  };
  const INTERACTIVE_CONTROL_TARGET = {
    closest: (sel: string) => (sel === "button, input, textarea, label, a" ? {} : null),
  };
  /** A card click that originates on the new Details affordance button:
   *  handled by the action branch, opens the overlay for the card's item. */
  const DETAIL_BTN_TARGET = {
    closest: (sel: string) => (sel === "button[data-action]" ? { getAttribute: () => "detail", closest: () => ({ getAttribute: () => "20" }) } : null),
  };
  /** A click that originates on the PR anchor inside the glance chip. */
  const PR_ANCHOR_TARGET = {
    closest: (sel: string) => (sel === "a" ? {} : null),
  };

  const RUNNING_ALPHA = payload(
    [{ id: 11, slug: "alpha", title: "Alpha spec title", repo: "Code/factory-1", stage: "implement", status: "running" }],
    null,
  );

  const DETAIL = {
    item: {
      id: 11, slug: "alpha", title: "Alpha spec title", repo: "Code/factory-1", base: "main",
      approvals: ["review"], stage: "implement", status: "running", parkedReason: null,
      parkedDetail: null, feedback: null, answers: [], sourceFile: "/x/items/alpha/item.md",
      branchName: "factory/alpha", gateAttempts: { test: 2 }, infraAttempts: 1,
      createdAt: "2026-11-08T09:00:00.000Z", updatedAt: "2026-11-08T09:05:00.000Z",
    },
    artifacts: [
      { name: "spec", stage: "spec", path: "items/alpha/artifacts/20261108-090000-000-spec.md", createdAt: "2026-11-08T09:00:00.000Z" },
      { name: "implement-log", stage: "implement", path: "items/alpha/artifacts/20261108-090500-001-implement.md", createdAt: "2026-11-08T09:05:00.000Z" },
    ],
    spec: {
      stage: "spec", name: "spec", path: "items/alpha/artifacts/20261108-090000-000-spec.md",
      createdAt: "2026-11-08T09:00:00.000Z", content: "# Spec title\n\n- one\n- two\n",
    },
    source: { path: "items/alpha/item.md", content: "---\ntitle: Alpha\n---\n\nBody." },
  };

  const DETAIL_RESPONSE = { ok: true, status: 200, json: async () => DETAIL, text: async () => "" };

  /** Fresh context with the overlay container's static `hidden` state seeded
   *  onto the stub (the stub never parses the served markup, so a class
   *  assertion would be vacuous without it — the syncGlanceBodyFromMarkup
   *  discipline). */
  async function makeOverlayContext() {
    const ctx = makeContext();
    ctx.el("item-overlay").classList.add("hidden");
    ctx.run(pageScript(PAGE_HTML));
    await ctx.settle();
    return ctx;
  }

  it("opens the overlay from a flight row: loading shell, exactly one fetch, then the ready pane", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    const overlay = ctx.el("item-overlay");
    expect(overlay.classList.contains("hidden")).toBe(false);
    expect(overlay.innerHTML).toContain("wb-spin");
    expect(overlay.innerHTML).toContain("Loading…");
    expect(ctx.countRequests("/api/items/11")).toBe(1);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    const html = overlay.innerHTML;
    // header: id + title, slug/repo/base/branch, status pill, close control
    expect(html).toContain("#11 Alpha spec title");
    expect(html).toContain("alpha · Code/factory-1 · main · factory/alpha");
    expect(html).toContain("bg-blue-50 text-blue-700 ring-blue-200"); // running pill palette
    expect(html).toContain("data-overlay-close");
    // record grid: stage, approvals, gate attempts, infra retries, timestamps
    expect(html).toContain("stage: implement");
    expect(html).toContain("approvals: review");
    expect(html).toContain("gate attempts: test=2");
    expect(html).toContain("infra retries: 1");
    expect(html).toContain("created 2026-11-08T09:00:00.000Z · updated 2026-11-08T09:05:00.000Z");
    // spec section: name + timestamp, raw link, rendered markdown content
    expect(html).toContain(">Spec</div>");
    expect(html).toContain("spec · 2026-11-08T09:00:00.000Z");
    expect(html).toContain("/api/artifact?path=items%2Falpha%2Fartifacts%2F20261108-090000-000-spec.md");
    expect(html).toContain('<h1 class="text-lg font-semibold mt-3">Spec title</h1>');
    expect(html).toContain('<ul class="list-disc pl-5 mt-2 text-sm"><li class="mt-1">one</li><li class="mt-1">two</li></ul>');
    // artifacts section: every row + View raw + inline View control
    expect(html).toContain(">Artifacts</div>");
    expect(html).toContain("implement-log · implement · 2026-11-08T09:05:00.000Z");
    expect(html).toContain('data-overlay-artifact="items/alpha/artifacts/20261108-090500-001-implement.md"');
    expect(html).toContain("id=\"overlay-artifact-body\"");
    // source section: raw link + verbatim escaped content (front-matter included)
    expect(html).toContain(">Source</div>");
    expect(html).toContain("items/alpha/item.md");
    expect(html).toContain("---\ntitle: Alpha\n---");
  });

  it("opens the overlay from a parked card and a glance chip; action/control clicks never open it", async () => {
    const ctx = await makeOverlayContext();
    const PARKED = payload(
      [{ id: 20, slug: "approve-me", title: "Approve me", stage: "spec", status: "awaiting-approval" }],
      null,
    );
    PARKED.counts.decisions = 1;
    ctx.fire("status", PARKED);
    ctx.click("parking-lot", CARD_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    expect(ctx.countRequests("/api/items/20")).toBe(1);
    await ctx.settle((url) => (url === "/api/items/20" ? DETAIL_RESPONSE : undefined));
    ctx.dispatchDocument("keydown", { key: "Escape" });
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(true);

    // glance chip: same overlay, keyed by the chip's item id
    ctx.fire("status", payload([{ id: 13, slug: "gamma", status: "done", prUrl: "https://github.com/x/y/pull/9" }], null));
    ctx.click("glance", GLANCE_CHIP_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    expect(ctx.countRequests("/api/items/13")).toBe(1);
    await ctx.settle((url) => (url === "/api/items/13" ? { ok: true, status: 200, json: async () => DETAIL, text: async () => "" } : undefined));
    ctx.dispatchDocument("keydown", { key: "Escape" });

    // negative controls: an action button, an interactive control, and the
    // glance summary toggle never open the overlay
    ctx.fire("status", PARKED);
    ctx.click("parking-lot", ACTION_TARGET);
    ctx.click("parking-lot", INTERACTIVE_CONTROL_TARGET);
    ctx.click("glance", SUMMARY_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(true);
    expect(ctx.fetches).toHaveLength(0);
  });

  it("opens an unclaimed inbox file in inbox mode: artifact-route fetch, rendered markdown, filename header", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", payload([], null, { claimable: ["a.md"] }));
    // the claimable row carries the click target attribute
    expect(ctx.el("glance").innerHTML).toContain('data-inbox-file="a.md"');
    ctx.click("glance", INBOX_ROW_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    expect(ctx.countRequests("/api/artifact?path=inbox%2Fa.md")).toBe(1);
    await ctx.settle((url) =>
      url === "/api/artifact?path=inbox%2Fa.md"
        ? { ok: true, status: 200, text: async () => "---\ntitle: Inbox item\n---\n\n## Goal\n\nShip it.\n" }
        : undefined,
    );
    const html = ctx.el("item-overlay").innerHTML;
    expect(html).toContain("📄 a.md");
    expect(html).toContain("unclaimed inbox item");
    expect(html).toContain('<h2 class="text-sm font-semibold mt-3">Goal</h2>');
    expect(html).toContain("Ship it.");
    // front-matter renders as plain text (--- separators as hr), never special-cased
    expect(html).toContain("title: Inbox item");
    expect(html).toContain('<hr class="border-t border-ink-200 mt-3">');
  });

  it("dismisses on Esc, backdrop click, and the close button — focus returns to the opener each time", async () => {
    const ctx = await makeOverlayContext();
    const focusLog: string[] = [];
    // The opener is the row element the delegated handler hands to
    // openItemOverlay (openerHint wins over activeElement — finding 4); the
    // fake row carries a focus spy the way a real <button> row would.
    const FOCUSABLE_ROW_TARGET = {
      closest: (sel: string) =>
        sel === "[data-flight-row]"
          ? {
              getAttribute: () => "11",
              focus: () => {
                focusLog.push("opener");
              },
            }
          : null,
    };
    ctx.fire("status", RUNNING_ALPHA);

    // Esc
    ctx.click("pulse", FOCUSABLE_ROW_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    ctx.dispatchDocument("keydown", { key: "Escape" });
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(true);
    expect(ctx.el("item-overlay").innerHTML).toBe("");
    expect(focusLog).toHaveLength(1);

    // a non-Escape key never closes it
    ctx.click("pulse", FOCUSABLE_ROW_TARGET);
    ctx.dispatchDocument("keydown", { key: "Enter" });
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);

    // backdrop click (a click that did not originate inside the panel)
    ctx.click("item-overlay", BACKDROP_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(true);
    expect(focusLog).toHaveLength(2);

    // the close button
    ctx.click("pulse", FOCUSABLE_ROW_TARGET);
    ctx.click("item-overlay", OVERLAY_CLOSE_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(true);
    expect(focusLog).toHaveLength(3);

    // a click inside the panel body (an anchor, an artifact button, …) keeps it open
    ctx.click("pulse", FOCUSABLE_ROW_TARGET);
    ctx.click("item-overlay", PANEL_INSIDE_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    expect(focusLog).toHaveLength(3);
    ctx.dispatchDocument("keydown", { key: "Escape" });
  });

  it("keeps an open overlay across a live SSE snapshot re-render (per-tab, point-in-time)", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    const before = ctx.el("item-overlay").innerHTML;
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);

    // a live status event re-renders the status-driven containers normally…
    ctx.fire("status", MIXED_FLIGHT_PAYLOAD);
    expect(ctx.el("pulse").innerHTML).toContain("In flight");
    expect(ctx.el("pulse").innerHTML).toContain("Beta queued title");
    expect(ctx.el("glance").innerHTML).toContain("Factory at a glance");
    // …without touching the open overlay: same content, still open
    expect(ctx.el("item-overlay").innerHTML).toBe(before);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);

    // and closing clears the fetched state: reopening refetches
    ctx.dispatchDocument("keydown", { key: "Escape" });
    expect(ctx.el("item-overlay").innerHTML).toBe("");
    expect(ctx.totalRequests("/api/items/11")).toBe(1);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    expect(ctx.totalRequests("/api/items/11")).toBe(2);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
  });

  it("shows an inline error with a retry affordance on a failed fetch; retry re-issues exactly one fetch", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    await ctx.settle((url) => (url === "/api/items/11" ? { ok: false, status: 500, json: async () => ({}), text: async () => "" } : undefined));
    const html = ctx.el("item-overlay").innerHTML;
    expect(html).toContain("HTTP 500");
    expect(html).toContain("text-red-700");
    expect(html).toContain("data-overlay-retry");

    // retry: exactly one new fetch for the same key
    expect(ctx.totalRequests("/api/items/11")).toBe(1);
    ctx.click("item-overlay", OVERLAY_RETRY_TARGET);
    expect(ctx.totalRequests("/api/items/11")).toBe(2);
    expect(ctx.countRequests("/api/items/11")).toBe(1); // the retried fetch is the only pending one
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    expect(ctx.el("item-overlay").innerHTML).toContain("#11 Alpha spec title");
  });

  it("renders an artifact inline through the artifact route into the overlay's body region", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    ctx.click("item-overlay", OVERLAY_ARTIFACT_TARGET);
    expect(ctx.countRequests("/api/artifact?path=items%2Falpha%2Fartifacts%2F20261108-090500-001-implement.md")).toBe(1);
    await ctx.settle((url) =>
      url === "/api/artifact?path=items%2Falpha%2Fartifacts%2F20261108-090500-001-implement.md"
        ? { ok: true, status: 200, text: async () => "# Log\n\nran 3 steps\n" }
        : undefined,
    );
    const body = ctx.el("overlay-artifact-body").innerHTML;
    expect(body).toContain('<h1 class="text-lg font-semibold mt-3">Log</h1>');
    expect(body).toContain("ran 3 steps");

    // a vanished artifact degrades to an inline error, never a broken page
    ctx.click("item-overlay", OVERLAY_ARTIFACT_TARGET);
    await ctx.settle((url) =>
      url === "/api/artifact?path=items%2Falpha%2Fartifacts%2F20261108-090500-001-implement.md"
        ? { ok: false, status: 404, text: async () => "" }
        : undefined,
    );
    expect(ctx.el("overlay-artifact-body").innerHTML).toContain("artifact unavailable (HTTP 404)");
  });

  it("renders the spec through the escaped-first markdown renderer: hostile fixtures come out inert", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    const hostile =
      "# <script>alert(1)</script> heading\n\n" +
      "- <img src=x onerror=alert(1)> item\n\n" +
      "para with <script>alert(2)</script> inline\n\n" +
      "[click](javascript:alert(1)) and [x](data:text/html,x)\n\n" +
      "[ok](https://example.com/x) and [rel](docs/x.md)\n\n" +
      "```\n<b>code block</b>\n```\n\n" +
      "**bold** and *italic* and `code`\n\n" +
      "## h2 title\n\n> quoted\n\n---\n\n1. first\n2. second\n";
    await ctx.settle((url) =>
      url === "/api/items/11"
        ? { ok: true, status: 200, json: async () => ({ ...DETAIL, spec: { ...DETAIL.spec, content: hostile } }), text: async () => "" }
        : undefined,
    );
    const html = ctx.el("item-overlay").innerHTML;
    // no raw script/img tag anywhere in the rendered overlay
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<script ");
    expect(html).not.toContain("<img ");
    // hostile text renders as escaped entities
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; heading");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    // javascript:/data: link targets drop the anchor; the titles stay text
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain("[click](javascript:alert(1))");
    expect(html).toContain("[x](data:text/html,x)");
    // allowed targets become anchors with the hardening attributes
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener"');
    expect(html).toContain('<a href="docs/x.md" target="_blank" rel="noopener"');
    // fenced code with embedded tags renders escaped inside pre/code
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;b&gt;code block&lt;/b&gt;");
    // spans: bold, italic, inline code
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<code class="bg-ink-100 rounded px-1 font-mono text-xs">code</code>');
    // blocks: h2, blockquote, hr, ordered list
    expect(html).toContain('<h2 class="text-sm font-semibold mt-3">h2 title</h2>');
    expect(html).toContain("<blockquote");
    expect(html).toContain("quoted");
    expect(html).toContain('<hr class="border-t border-ink-200 mt-3">');
    expect(html).toContain('<ol class="list-decimal pl-5 mt-2 text-sm"><li class="mt-1">first</li><li class="mt-1">second</li></ol>');
  });

  it("surfaces spec.content === null and missing source as muted notes, never errors", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    const degraded = {
      ...DETAIL,
      spec: { ...DETAIL.spec, content: null, error: "file unreadable" },
      source: null,
    };
    await ctx.settle((url) =>
      url === "/api/items/11" ? { ok: true, status: 200, json: async () => degraded, text: async () => "" } : undefined,
    );
    const html = ctx.el("item-overlay").innerHTML;
    expect(html).toContain("(file unreadable)");
    expect(html).not.toContain("<h1"); // the renderer never ran on null content
    expect(html).toContain("no source file recorded");
  });

  it("entry points are real buttons: chips, inbox rows, flight rows, and a card Details affordance are keyboard-reachable", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    // the running item's chip and flight row are buttons (bare divs had no
    // focus target and no Enter/Space path — finding 5)
    expect(ctx.el("pulse").innerHTML).toContain('<button type="button" data-flight-row="11"');
    expect(ctx.el("glance").innerHTML).toContain('<button type="button" data-item-id="11"');
    // an unclaimed inbox row is a button too — with ATTENTION styling (solid
    // indigo accent, shadow). The old dashed/50%-white/gray look read as
    // disabled, which is exactly why claimable specs went unnoticed; pin the
    // accent classes so a regression back to muted fails here.
    ctx.fire("status", payload([], null, { claimable: ["a.md"] }));
    expect(ctx.el("glance").innerHTML).toContain('<button type="button" data-inbox-file="a.md"');
    expect(ctx.el("glance").innerHTML).toContain("border-indigo-300 bg-indigo-50");
    expect(ctx.el("glance").innerHTML).toContain("text-indigo-800 shadow-sm");
    expect(ctx.el("glance").innerHTML).not.toContain("border-dashed border-ink-300");
    expect(ctx.el("glance").innerHTML).not.toContain("bg-white/50");
    // a parked card carries a Details button (the card itself must stay a
    // div — it nests the note/reject inputs)
    const PARKED = payload(
      [{ id: 20, slug: "approve-me", title: "Approve me", stage: "spec", status: "awaiting-approval",
         parkedDetail: { stage: "spec" },
         artifacts: [{ name: "spec", stage: "spec", path: "items/approve-me/artifacts/20261108-0900-000-spec-spec.md", createdAt: "2026-11-08T09:00:00.000Z" }] }],
      null,
    );
    PARKED.counts.decisions = 1;
    ctx.fire("status", PARKED);
    expect(ctx.el("parking-lot").innerHTML).toContain('data-action="detail"');
    // the raw-artifact link on the approval card is gone (option 2): the
    // Details affordance is the one path to the spec; the raw escape hatch
    // lives inside the overlay's per-artifact View raw links
    expect(ctx.el("parking-lot").innerHTML).toContain("read the spec before approving or rejecting");
    expect(ctx.el("parking-lot").innerHTML).not.toContain('href="/api/artifact');
    expect(ctx.el("parking-lot").innerHTML).not.toContain("read before approving");
    // and it opens the overlay through the shared action path
    ctx.click("parking-lot", DETAIL_BTN_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    expect(ctx.countRequests("/api/items/20")).toBe(1);
    await ctx.settle((url) => (url === "/api/items/20" ? DETAIL_RESPONSE : undefined));
    expect(ctx.el("item-overlay").innerHTML).toContain("#11 Alpha spec title");
    ctx.dispatchDocument("keydown", { key: "Escape" });
  });

  it("a PR link inside a glance chip keeps its own behavior — no overlay opens behind the new tab", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", payload([{ id: 13, slug: "gamma", status: "done", prUrl: "https://github.com/x/y/pull/9" }], null));
    // clicking the PR anchor (a control inside the chip region) never opens
    // the overlay: the glance handler skips links like the parking-lot
    // handler skips interactive controls (finding 7)
    ctx.click("glance", PR_ANCHOR_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(true);
    expect(ctx.fetches).toHaveLength(0);
    // the chip itself still opens
    ctx.click("glance", GLANCE_CHIP_TARGET);
    expect(ctx.el("item-overlay").classList.contains("hidden")).toBe(false);
    ctx.dispatchDocument("keydown", { key: "Escape" });
  });

  it("the last artifact selection always renders: a slow in-flight response never overwrites a newer one", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    const artifactUrl = "/api/artifact?path=" + encodeURIComponent("items/alpha/artifacts/20261108-090500-001-implement.md");
    const tick = () => new Promise((r) => setTimeout(r, 10));
    // two selections in flight: A first, B second
    ctx.click("item-overlay", OVERLAY_ARTIFACT_TARGET);
    ctx.click("item-overlay", OVERLAY_ARTIFACT_TARGET);
    expect(ctx.countRequests("/api/artifact?path=items%2Falpha%2Fartifacts%2F20261108-090500-001-implement.md")).toBe(2);
    const [a, b] = ctx.fetches;
    // B resolves first and renders…
    b.resolve({ ok: true, status: 200, text: async () => "## Selection B" });
    await tick();
    expect(ctx.el("overlay-artifact-body").innerHTML).toContain("Selection B");
    // …and the slow A response is ignored — both its content and its errors
    a.resolve({ ok: true, status: 200, text: async () => "## Selection A" });
    await tick();
    expect(ctx.el("overlay-artifact-body").innerHTML).toContain("Selection B");
    expect(ctx.el("overlay-artifact-body").innerHTML).not.toContain("Selection A");
  });

  it("retry preserves the ORIGINAL opener: an in-overlay focused control never becomes the focus-restore target", async () => {
    const ctx = await makeOverlayContext();
    const focusLog: string[] = [];
    const FOCUSABLE_ROW = {
      closest: (sel: string) =>
        sel === "[data-flight-row]"
          ? {
              getAttribute: () => "11",
              focus: () => {
                focusLog.push("original-row");
              },
            }
          : null,
    };
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = {
      focus: () => {
        focusLog.push("in-overlay");
      },
    };
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FOCUSABLE_ROW);
    await ctx.settle((url) => (url === "/api/items/11" ? { ok: false, status: 500, json: async () => ({}), text: async () => "" } : undefined));
    // retry re-opens with the ORIGINAL opener as the hint (the loading render
    // then removes the in-overlay control — an activeElement-first capture
    // would target detached state; finding 4)
    ctx.click("item-overlay", OVERLAY_RETRY_TARGET);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    ctx.dispatchDocument("keydown", { key: "Escape" });
    expect(focusLog).toEqual(["original-row"]);
  });

  it("wraps Tab among the panel's tabbables while the overlay is open (aria-modal honesty)", async () => {
    const ctx = await makeOverlayContext();
    ctx.fire("status", RUNNING_ALPHA);
    ctx.click("pulse", FLIGHT_ROW_TARGET);
    await ctx.settle((url) => (url === "/api/items/11" ? DETAIL_RESPONSE : undefined));
    const wrapped: string[] = [];
    let prevented = 0;
    const first = { focus: () => {
      wrapped.push("first");
    } };
    const last = { focus: () => {
      wrapped.push("last");
    } };
    ctx.el("item-overlay").querySelectorAll = () => [first, last];
    // Tab from the LAST tabbable wraps to the first…
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = last;
    ctx.dispatchDocument("keydown", { key: "Tab", shiftKey: false, preventDefault: () => { prevented++; } });
    expect(wrapped).toEqual(["first"]);
    expect(prevented).toBe(1);
    // …and Shift+Tab from the first wraps back to the last
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = first;
    ctx.dispatchDocument("keydown", { key: "Tab", shiftKey: true, preventDefault: () => { prevented++; } });
    expect(wrapped).toEqual(["first", "last"]);
    expect(prevented).toBe(2);
    // Tab in the middle of the tabbables is left to the browser's traversal
    const middle = { focus: () => {} };
    (ctx.sandbox.document as unknown as { activeElement: unknown }).activeElement = middle;
    ctx.dispatchDocument("keydown", { key: "Tab", shiftKey: false, preventDefault: () => { prevented++; } });
    expect(wrapped).toEqual(["first", "last"]);
    expect(prevented).toBe(2);
  });
});
