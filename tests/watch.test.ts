import { describe, it, expect } from "vitest";
import {
  parseIntervalSeconds,
  ellipsize,
  parkedFixHint,
  formatEventText,
  formatEventLine,
  renderCard,
  runWatchOnce,
  notifyParked,
  type SpawnFn,
  type WatchEventRow,
  type WatchItem,
  type WatchState,
} from "../src/watch.js";

const MAX = 3;
/** Local-time 03:04:05, built locally so expectations are timezone-independent. */
const TS = new Date(2026, 0, 2, 3, 4, 5).toISOString();
const CLOCK = "[03:04:05]";
const BEL = "\x07";
const RULE = "─".repeat(50);

function row(partial: Partial<WatchEventRow> & { id: number; event: string }): WatchEventRow {
  return { itemId: 1, ts: TS, stage: null, detail: {}, ...partial };
}

function item(partial: Partial<WatchItem> = {}): WatchItem {
  return { id: 1, slug: "fix-bugs", stage: "triage", status: "queued", parkedReason: null, ...partial };
}

function initialState(): WatchState {
  return { lastEventId: 0, lastCard: null, first: true };
}

describe("interval parsing", () => {
  it("defaults to 5s and clamps to a minimum of 1s", () => {
    expect(parseIntervalSeconds(undefined)).toBe(5);
    expect(parseIntervalSeconds("5")).toBe(5);
    expect(parseIntervalSeconds("10")).toBe(10);
    expect(parseIntervalSeconds("0")).toBe(1);
    expect(parseIntervalSeconds("-3")).toBe(1);
    expect(parseIntervalSeconds("2.7")).toBe(2);
    expect(parseIntervalSeconds("abc")).toBe(1);
  });
});

describe("ellipsize", () => {
  it("truncates to max chars including the ellipsis", () => {
    expect(ellipsize("short", 10)).toBe("short");
    expect(ellipsize("x".repeat(60), 60)).toBe("x".repeat(60));
    expect(ellipsize("x".repeat(61), 60)).toBe("x".repeat(59) + "…");
    expect(ellipsize("x".repeat(61), 60).length).toBe(60);
  });
});

describe("event formatting", () => {
  it("renders claim / claim-resurrect", () => {
    // claimed/resurrected rows always carry stage = NULL in practice.
    expect(formatEventLine(row({ id: 1, event: "claimed" }), item(), MAX)).toBe(`${CLOCK} #1 fix-bugs claim`);
    expect(formatEventLine(row({ id: 1, event: "resurrected" }), item(), MAX)).toBe(
      `${CLOCK} #1 fix-bugs claim-resurrect`,
    );
    // Defensive: a stage, if one ever appears, gets an arrow segment.
    expect(formatEventText(row({ id: 1, event: "claimed", stage: "triage" }), item(), MAX)).toBe("claim → triage");
  });

  it("renders stage-start with and without the gate attempt suffix", () => {
    expect(formatEventLine(row({ id: 2, event: "stage-start", stage: "test", detail: { attempt: 1 } }), item(), MAX)).toBe(
      `${CLOCK} #1 fix-bugs test → start`,
    );
    expect(formatEventLine(row({ id: 2, event: "stage-start", stage: "test", detail: { attempt: 2 } }), item(), MAX)).toBe(
      `${CLOCK} #1 fix-bugs test → start (gate 2/3)`,
    );
    // Unknown budget → suffix omitted.
    expect(formatEventText(row({ id: 2, event: "stage-start", stage: "test", detail: { attempt: 2 } }), item(), null)).toBe(
      "test → start",
    );
    // lockConflict rows carry no attempt.
    expect(formatEventText(row({ id: 2, event: "stage-start", stage: "test", detail: { lockConflict: true } }), item(), MAX)).toBe(
      "test → start",
    );
  });

  it("renders stage-pass with nextStage and (defensively) rounds", () => {
    expect(
      formatEventText(row({ id: 3, event: "stage-pass", stage: "test", detail: { nextStage: "review" } }), item(), MAX),
    ).toBe("test → pass → review");
    expect(
      formatEventText(
        row({ id: 3, event: "stage-pass", stage: "test", detail: { nextStage: "review", rounds: 2 } }),
        item(),
        MAX,
      ),
    ).toBe("test → pass → review (r2)");
    expect(formatEventText(row({ id: 3, event: "stage-pass", stage: "triage" }), item(), MAX)).toBe("triage → pass");
  });

  it("renders stage-gate-fail with the gate attempt suffix", () => {
    expect(formatEventText(row({ id: 4, event: "stage-gate-fail", stage: "test", detail: { attempt: 1 } }), item(), MAX)).toBe(
      "test → fail (gate 1/3)",
    );
    expect(formatEventText(row({ id: 4, event: "stage-gate-fail", stage: "test", detail: { attempt: 2 } }), item(), null)).toBe(
      "test → fail",
    );
  });

  it("renders parked lines with warning marker, (!), bell and fix hints", () => {
    const it3 = item({ stage: "review" });
    expect(formatEventLine(row({ id: 5, event: "parked", stage: "review", detail: { reason: "awaiting-approval" } }), it3, MAX)).toBe(
      `⚠ ${CLOCK} (!) #1 fix-bugs parked at review — awaiting-approval → \`wb approve fix-bugs\`${BEL}`,
    );
    expect(formatEventLine(row({ id: 5, event: "parked", stage: "triage", detail: { reason: "needs-human" } }), item(), MAX)).toBe(
      `⚠ ${CLOCK} (!) #1 fix-bugs parked at triage — needs-human → \`wb answer fix-bugs\`${BEL}`,
    );
    expect(
      formatEventLine(row({ id: 5, event: "parked", stage: "test", detail: { reason: "exhausted-rework" } }), item(), MAX),
    ).toBe(`⚠ ${CLOCK} (!) #1 fix-bugs parked at test — exhausted-rework → \`wb retry fix-bugs\`${BEL}`);
    expect(
      formatEventLine(row({ id: 5, event: "parked", stage: "test", detail: { reason: "infrastructure-failure" } }), item(), MAX),
    ).toBe(`⚠ ${CLOCK} (!) #1 fix-bugs parked at test — infrastructure-failure → \`wb retry fix-bugs\`${BEL}`);
    // Free-form infra message (not the literal) → wb resume, no substring match.
    expect(
      formatEventText(
        row({ id: 5, event: "parked", stage: "pr", detail: { reason: "infrastructure failure after 3 retries: boom" } }),
        item(),
        MAX,
      ),
    ).toBe("parked at pr — infrastructure failure after 3 retries: boom → `wb resume fix-bugs`");
    // unhandled-error → wb resume.
    expect(
      formatEventText(row({ id: 5, event: "parked", stage: "spec", detail: { reason: "unhandled-error" } }), item(), MAX),
    ).toBe("parked at spec — unhandled-error → `wb resume fix-bugs`");
  });

  it("resolves parked hints from parked_reason for malformed re-parse rows", () => {
    // Re-parse parking: detail.reason is the plain parse reason, the item's
    // parked_reason is "malformed front-matter: …" — the hint must trigger.
    const malformed = item({ status: "malformed", parkedReason: "malformed front-matter: repo: missing" });
    const line = formatEventLine(
      row({ id: 6, event: "parked", stage: null, detail: { reason: "repo: missing" } }),
      malformed,
      MAX,
    );
    expect(line).toBe(`⚠ ${CLOCK} (!) #1 fix-bugs parked — repo: missing → \`wb retry fix-bugs  # fix front-matter first\`${BEL}`);
  });

  it("renders parked with null stage, missing item fallbacks and no hint for human-rejected", () => {
    expect(formatEventLine(row({ id: 7, event: "parked", stage: null, detail: { reason: "needs-human" } }), item(), MAX)).toBe(
      `⚠ ${CLOCK} (!) #1 fix-bugs parked — needs-human → \`wb answer fix-bugs\`${BEL}`,
    );
    expect(formatEventLine(row({ id: 7, event: "parked", stage: "review", detail: {} }), undefined, MAX)).toBe(
      `⚠ ${CLOCK} (!) #1 (unknown) parked at review — unknown → \`wb resume (unknown)\`${BEL}`,
    );
    expect(parkedFixHint("human-rejected", "human-rejected", "fix-bugs")).toBeNull();
    expect(formatEventText(row({ id: 7, event: "parked", stage: "review", detail: { reason: "human-rejected" } }), item(), MAX)).toBe(
      "parked at review — human-rejected",
    );
  });

  it("truncates parked reasons to 60 chars including the ellipsis", () => {
    const longReason = "r".repeat(70);
    expect(formatEventText(row({ id: 8, event: "parked", stage: "test", detail: { reason: longReason } }), item(), MAX)).toBe(
      `parked at test — ${ellipsize(longReason, 60)} → \`wb resume fix-bugs\``,
    );
  });

  it("renders unparked with via/feedback/note handling and 60-char truncation", () => {
    expect(
      formatEventText(row({ id: 9, event: "unparked", stage: "review", detail: { via: "resume", feedback: "looks good" } }), item(), MAX),
    ).toBe("unparked → review (resume: looks good)");
    expect(
      formatEventText(
        row({ id: 9, event: "unparked", stage: "triage", detail: { via: "retry", note: "front-matter fixed" } }),
        item(),
        MAX,
      ),
    ).toBe("unparked → triage (retry: front-matter fixed)");
    const longNote = "n".repeat(70);
    expect(
      formatEventText(row({ id: 9, event: "unparked", stage: "triage", detail: { via: "retry", note: longNote } }), item(), MAX),
    ).toBe(`unparked → triage (retry: ${ellipsize(longNote, 60)})`);
    // feedback may be null; via with neither feedback nor note → bare.
    expect(formatEventText(row({ id: 9, event: "unparked", stage: "spec", detail: { via: "resume", feedback: null } }), item(), MAX)).toBe(
      "unparked → spec (resume)",
    );
    expect(formatEventText(row({ id: 9, event: "unparked", stage: "test", detail: { via: "retry", resetGate: "test" } }), item(), MAX)).toBe(
      "unparked → test (retry)",
    );
    // No via at all → no parenthetical.
    expect(
      formatEventText(row({ id: 9, event: "unparked", stage: null, detail: { note: "front-matter edited by operator" } }), item(), MAX),
    ).toBe("unparked");
  });

  it("renders pr-created, answered and rejected-by-human", () => {
    expect(
      formatEventLine(row({ id: 10, event: "pr-created", stage: "pr", detail: { url: "https://github.com/x/r/pull/7", number: 7, draft: true } }), item(), MAX),
    ).toBe(`${CLOCK} #1 fix-bugs PR created → https://github.com/x/r/pull/7`);
    expect(formatEventLine(row({ id: 11, event: "answered", stage: "triage", detail: { answers: ["a"] } }), item(), MAX)).toBe(
      `${CLOCK} #1 fix-bugs questions answered → triage`,
    );
    const longFeedback = "f".repeat(70);
    expect(
      formatEventText(row({ id: 12, event: "rejected-by-human", stage: "review", detail: { reason: longFeedback } }), item(), MAX),
    ).toBe(`rejected at review — ${ellipsize(longFeedback, 60)}`);
    // Reason of exactly 60 chars is not truncated.
    expect(
      formatEventText(row({ id: 12, event: "rejected-by-human", stage: "review", detail: { reason: "f".repeat(60) } }), item(), MAX),
    ).toBe(`rejected at review — ${"f".repeat(60)}`);
  });

  it("renders unknown events with stage and detail keys", () => {
    expect(
      formatEventText(row({ id: 13, event: "stage-retry", stage: "test", detail: { attempt: 2, backoffMs: 100, error: "boom" } }), item(), MAX),
    ).toBe("stage-retry test (attempt, backoffMs, error)");
    expect(formatEventText(row({ id: 13, event: "custom_event", stage: "test", detail: { via: "x", round: 1 } }), item(), MAX)).toBe(
      "custom_event test (via, round)",
    );
    expect(formatEventLine(row({ id: 13, event: "approved", stage: "review", detail: {} }), item(), MAX)).toBe(
      `${CLOCK} #1 fix-bugs approved review`,
    );
    expect(formatEventLine(row({ id: 13, event: "custom", stage: null, detail: {} }), item(), MAX)).toBe(
      `${CLOCK} #1 fix-bugs custom`,
    );
    // pr-created without a url falls through to the unknown rule.
    expect(formatEventText(row({ id: 13, event: "pr-created", stage: "pr", detail: { number: 1 } }), item(), MAX)).toBe(
      "pr-created pr (number)",
    );
  });

  it("renders 00:00:00 for an unparseable timestamp", () => {
    expect(formatEventLine(row({ id: 14, event: "claimed", ts: "not-a-date" }), item(), MAX)).toBe("[00:00:00] #1 fix-bugs claim");
  });
});

describe("card logic", () => {
  it("renders none-lines when empty and parked entries with reasons", () => {
    expect(renderCard([])).toBe([RULE, "  RUN: none", "  PARKED: none", RULE].join("\n"));
    const items: WatchItem[] = [
      item({ id: 1, slug: "fix-bugs", stage: "test", status: "running" }),
      item({ id: 2, slug: "add-dark-mode", stage: "triage", status: "needs-human", parkedReason: "needs-human" }),
    ];
    expect(renderCard(items)).toBe(
      [RULE, "  RUN: #1 fix-bugs test", "  PARKED: #2 add-dark-mode (needs-human)", RULE].join("\n"),
    );
    // Missing parked reason renders the "?" placeholder.
    const odd = item({ id: 3, slug: "odd", status: "malformed", parkedReason: null });
    expect(renderCard([odd])).toContain("PARKED: #3 odd (?)");
  });

  it("truncates long content lines at 80 chars plus the two-space indent", () => {
    const items: WatchItem[] = Array.from({ length: 10 }, (_, i) =>
      item({ id: i + 1, slug: `very-long-slug-number-${i + 1}`, stage: "implement", status: "running" }),
    );
    const card = renderCard(items);
    const lines = card.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(RULE);
    expect(lines[3]).toBe(RULE);
    const runLine = lines[1]!;
    expect(runLine.length).toBeLessThanOrEqual(82); // 2-space indent + 80
    expect(runLine.startsWith("  RUN: ")).toBe(true);
    expect(runLine.endsWith("…")).toBe(true);
    expect(lines[2]).toBe("  PARKED: none");
  });

  it("does not reprint the card when nothing changed and prints it on a parked-reason change", () => {
    const items: WatchItem[] = [item({ id: 2, slug: "b", status: "needs-human", parkedReason: "needs-human" })];
    const lastCard = renderCard(items);
    const state: WatchState = { lastEventId: 5, lastCard, first: false };
    const unchanged = runWatchOnce([], items, state, MAX);
    expect(unchanged.lines).toEqual([]);
    expect(unchanged.state.lastCard).toBe(lastCard);

    const changed = [item({ id: 2, slug: "b", status: "needs-human", parkedReason: "needs-human: which DB?" })];
    const outcome = runWatchOnce([], changed, unchanged.state, MAX);
    expect(outcome.lines).toEqual([renderCard(changed)]);
    expect(outcome.state.lastCard).toBe(renderCard(changed));
  });

  it("prints an event line followed by the card when both changed", () => {
    const items: WatchItem[] = [item({ id: 1, slug: "fix-bugs", stage: "review", status: "running" })];
    const state: WatchState = {
      lastEventId: 0,
      lastCard: renderCard([item({ id: 1, slug: "fix-bugs", stage: "triage", status: "queued" })]),
      first: false,
    };
    const rows = [row({ id: 1, event: "stage-pass", stage: "triage", detail: { nextStage: "spec" } })];
    const outcome = runWatchOnce(rows, items, state, MAX);
    expect(outcome.lines).toEqual([`${CLOCK} #1 fix-bugs triage → pass → spec`, renderCard(items)]);
  });
});

describe("polling/diff", () => {
  const items = (): WatchItem[] => [item()];
  const rowsFor = (ids: number[]): WatchEventRow[] =>
    ids.map((id) => row({ id, event: "stage-start", stage: "test", detail: { attempt: 1 } }));

  it("primes silently on the first poll and consumes rows by id exactly once", () => {
    const first = runWatchOnce(rowsFor([1, 2, 3]), items(), initialState(), MAX);
    expect(first.lines).toEqual([]);
    expect(first.notificationTexts).toEqual([]);
    expect(first.state.first).toBe(false);
    expect(first.state.lastEventId).toBe(3);
    expect(first.state.lastCard).toBe(renderCard(items()));

    const second = runWatchOnce(rowsFor([3, 4, 5, 6, 7, 8, 9, 10]), items(), first.state, MAX);
    // Row 3 is a duplicate: only 4..10 are new.
    expect(second.lines).toHaveLength(7);
    expect(second.state.lastEventId).toBe(10);

    // Replaying the same rows again produces nothing.
    const third = runWatchOnce(rowsFor([3, 4, 5, 6, 7, 8, 9, 10]), items(), second.state, MAX);
    expect(third.lines).toEqual([]);
    expect(third.state.lastEventId).toBe(10);
  });

  it("collects notification texts for parked rows in row order", () => {
    const state: WatchState = { lastEventId: 0, lastCard: renderCard(items()), first: false };
    const rows = [
      row({ id: 1, itemId: 1, event: "stage-start", stage: "test", detail: { attempt: 1 } }),
      row({ id: 2, itemId: 1, event: "parked", stage: "test", detail: { reason: "needs-human" } }),
    ];
    const outcome = runWatchOnce(rows, items(), state, MAX);
    expect(outcome.notificationTexts).toEqual(["#1 fix-bugs parked at test — needs-human"]);
    expect(outcome.lines[0]).toContain("test → start");
    expect(outcome.lines[1]).toContain("parked at test");
  });
});

describe("notification", () => {
  function recordingSpawn(): { spawnFn: SpawnFn; calls: { cmd: string; args: string[]; opts: unknown }[]; unrefCount: number } {
    const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
    let unrefs = 0;
    return {
      calls,
      get unrefCount() {
        return unrefs;
      },
      spawnFn: ((cmd: string, args: string[], opts: { stdio: "ignore"; detached: boolean }) => {
        calls.push({ cmd, args, opts });
        return {
          unref: () => {
            unrefs += 1;
          },
        };
      }) as SpawnFn,
    };
  }

  it("builds the darwin osascript notification and detaches it", () => {
    const rec = recordingSpawn();
    notifyParked("#1 s parked at triage — needs-human", "darwin", rec.spawnFn);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.cmd).toBe("osascript");
    expect(call.args).toEqual([
      "-e",
      `display notification "#1 s parked at triage — needs-human" with title "Workbench"`,
    ]);
    expect(call.opts).toEqual({ stdio: "ignore", detached: true });
    expect(rec.unrefCount).toBe(1);
  });

  it("builds the linux notify-send notification and detaches it", () => {
    const rec = recordingSpawn();
    notifyParked("#2 t parked — exhausted-rework", "linux", rec.spawnFn);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.cmd).toBe("notify-send");
    expect(call.args).toEqual(["-t", "Workbench", "#2 t parked — exhausted-rework"]);
    expect(call.opts).toEqual({ stdio: "ignore", detached: true });
    expect(rec.unrefCount).toBe(1);
  });

  it("is a no-op on other platforms", () => {
    const rec = recordingSpawn();
    notifyParked("text", "win32", rec.spawnFn);
    expect(rec.calls).toHaveLength(0);
  });

  it("swallows spawn failures and never throws", () => {
    const throwing: SpawnFn = () => {
      throw new Error("simulated spawn failure");
    };
    expect(() => notifyParked("text", "darwin", throwing)).not.toThrow();
    expect(() => notifyParked("text", "linux", throwing)).not.toThrow();
  });
});