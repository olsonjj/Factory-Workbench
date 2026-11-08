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
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  listeners: Map<string, Array<() => void>>;
  addEventListener: (t: string, fn: () => void) => void;
  querySelector: () => null;
  scrollIntoView?: () => void;
}

function makeStubElement(): StubElement {
  const listeners: Map<string, Array<() => void>> = new Map();
  const classes = new Set<string>();
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    value: "",
    checked: false,
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
    fire: (t: string, payload: unknown) => {
      if (!lastES) throw new Error("page never constructed an EventSource");
      lastES._fire(t, { data: JSON.stringify(payload) });
    },
    /** Let the script's `refreshStatus()` promise (and any .then) settle. */
    settle: async () => {
      for (const f of fetches.splice(0)) f.resolve({ ok: true, json: async () => IDLE_PAYLOAD });
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

/** Full status payload — every render*() field the script reads off a snapshot. */
function payload(items: unknown[], lock: unknown) {
  return {
    items,
    knownRepos: [],
    counts: { decisions: 0, running: items.filter((i: any) => i.status === "running").length, queued: 0, inbox: 0, done: 0 },
    flow: [],
    inbox: { claimable: [], alreadyClaimed: [], error: null },
    lock,
  };
}

const IDLE_PAYLOAD = payload([], null);
const RUNNING_PAYLOAD = payload(
  [{ id: 22, slug: "make-the-running-state-unmissable-in-the-web-ui-header", stage: "pr", status: "running" }],
  { alive: true, pid: 7, ageMs: 65_500 },
);
const DEAD_PAYLOAD = payload([], { alive: false, pid: 7, ageMs: 90_000 });

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
});
