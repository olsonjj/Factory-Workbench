import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createHarness, claim, type TestHarness } from "./helpers.js";
import { FactoryDb } from "../src/db.js";
import { pollOnce, type WatchState } from "../src/watch.js";

/**
 * Integration tests for `wb watch` against a real factory DB: single polls
 * through `pollOnce` (no live loop, no real timers), mirroring the seeding
 * style of `tests/status-readonly.test.ts`.
 */

const RULE = "─".repeat(50);
const FM = { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] };

function initialState(): WatchState {
  return { lastEventId: 0, lastCard: null, first: true };
}

describe("wb watch (integration)", () => {
  const harnesses: TestHarness[] = [];
  const watchDbs: FactoryDb[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (watchDbs.length > 0) watchDbs.pop()?.close();
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  it("streams new history rows and the card across polls, read-only (no factory lock)", () => {
    const h = makeHarness();
    h.inboxFile("add-dark-mode", FM, "Body.");
    claim(h);
    const watchDb = FactoryDb.openReadonly(h.root);
    watchDbs.push(watchDb);

    // First poll: silent priming — nothing existing is printed.
    const first = pollOnce(watchDb, initialState(), 3);
    expect(first.lines).toEqual([]);
    expect(first.notificationTexts).toEqual([]);
    expect(first.state.first).toBe(false);
    expect(first.state.lastEventId).toBeGreaterThan(0);
    expect(first.state.lastCard).toBe(
      [RULE, "  RUN: #1 add-dark-mode triage", "  PARKED: none", RULE].join("\n"),
    );

    // Seed activity: a gate-retry start, a pass, and a parking (mirroring what
    // the pipeline writes), plus the matching item-state transition.
    const id = 1;
    h.db.appendHistory(id, "stage-start", "test", { attempt: 2 });
    h.db.appendHistory(id, "stage-pass", "test", { nextStage: "review" });
    h.db.updateItem(id, { status: "awaiting-approval", stage: "review", parkedReason: "awaiting-approval" });
    h.db.appendHistory(id, "parked", "review", { reason: "awaiting-approval" });

    // Second poll: event lines + a changed card + one notification.
    const second = pollOnce(watchDb, first.state, 3);
    expect(second.lines).toHaveLength(4);
    // Timestamps come from appendHistory's now(): match the clock shape only.
    expect(second.lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] #1 add-dark-mode test → start \(gate 2\/3\)$/);
    expect(second.lines[1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] #1 add-dark-mode test → pass → review$/);
    expect(second.lines[2]).toMatch(
      /^⚠ \[\d{2}:\d{2}:\d{2}\] \(!\) #1 add-dark-mode parked at review — awaiting-approval → `wb approve add-dark-mode`\x07$/,
    );
    expect(second.lines[3]).toBe(
      [RULE, "  RUN: none", "  PARKED: #1 add-dark-mode (awaiting-approval)", RULE].join("\n"),
    );
    expect(second.notificationTexts).toEqual(["#1 add-dark-mode parked at review — awaiting-approval"]);
    expect(second.state.lastEventId).toBe(first.state.lastEventId + 3);

    // No-change poll: emits nothing.
    const third = pollOnce(watchDb, second.state, 3);
    expect(third.lines).toEqual([]);
    expect(third.notificationTexts).toEqual([]);

    // More activity: an unpark via retry with a note → event line + card.
    h.db.updateItem(id, { status: "queued", stage: "review", parkedReason: null });
    h.db.appendHistory(id, "unparked", "review", { via: "retry", note: "approved offline" });

    const fourth = pollOnce(watchDb, third.state, 3);
    expect(fourth.lines).toHaveLength(2);
    expect(fourth.lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] #1 add-dark-mode unparked → review \(retry: approved offline\)$/);
    expect(fourth.lines[1]).toBe([RULE, "  RUN: #1 add-dark-mode review", "  PARKED: none", RULE].join("\n"));

    // Watch is read-only: no factory lock was ever created.
    expect(existsSync(path.join(h.root, "factory.lock"))).toBe(false);
  });

  it("renders events from the same snapshot as the card (single read transaction)", () => {
    // Regression: pollOnce must consume one consistent snapshot, not separate
    // item/history reads. Here the history row is generic (no detail reason)
    // and the *snapshot's* item carries the malformed parked_reason — the fix
    // hint must come from that item, proving event/item pairing.
    const ts = "2026-10-28T10:00:00.000Z";
    const snapshot = (afterId: number | null) => ({
      items: [
        {
          id: 1,
          slug: "fix-bugs",
          title: "Fix bugs",
          repo: "/tmp/repo",
          base: "main",
          stage: null,
          status: "malformed",
          parkedReason: "malformed front-matter: repo: missing",
          parkedDetail: null,
          feedback: null,
          answers: null,
          sourceFile: null,
          branchName: null,
          createdAt: ts,
          updatedAt: ts,
          gateAttempts: {},
          infraAttempts: 0,
        },
      ],
      // The prime poll establishes lastEventId=0, then the second poll sees
      // the parked history row with the snapshot's (stale-proof) item data.
      maxHistoryId: afterId === null ? 0 : 1,
      historySince: afterId === null
        ? []
        : [{ id: 1, item_id: 1, ts, event: "parked", stage: null, detail: {} }],
    });
    const fake = {
      getWatchSnapshot: snapshot,
    } as unknown as FactoryDb;

    const primed = pollOnce(fake, initialState(), 3);
    expect(primed.lines).toEqual([]); // first poll only primes
    const outcome = pollOnce(fake, primed.state, 3);
    expect(outcome.lines[0]).toContain("#1 fix-bugs parked");
    expect(outcome.lines[0]).toContain("`wb retry fix-bugs  # fix front-matter first`");
  });

  it("tolerates repeated DB read failures without crashing or printing early", () => {
    const h = makeHarness();
    h.inboxFile("add-dark-mode", FM, "Body.");
    claim(h);

    const bad = {
      getWatchSnapshot: () => {
        throw new Error("boom");
      },
    } as unknown as FactoryDb;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let state = initialState();
      for (let i = 0; i < 7; i++) {
        const outcome = pollOnce(bad, state, 3);
        expect(outcome.lines).toEqual([]);
        state = outcome.state;
      }
      // Silent for the first 4 failures, then once per failing poll.
      expect(errSpy.mock.calls).toHaveLength(3);
      for (const call of errSpy.mock.calls) {
        expect(call[0]).toBe("factory: db read failed (repeated) — still polling");
      }
      expect(state.consecutiveReadFailures ?? 0).toBe(7);
    } finally {
      errSpy.mockRestore();
    }
  });
});