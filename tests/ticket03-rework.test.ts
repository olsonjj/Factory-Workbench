import { describe, it, expect, afterEach } from "vitest";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, gateFail, pass, type TestHarness } from "./helpers.js";
import { readKbFile, projectKbFile } from "../src/kb.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropAutonomousItem(h: TestHarness): void {
  h.inboxFile("demo", { title: "Demo task", repo: "/tmp/repo", base: "main", approvals: [] }, "Do the demo task.");
  claim(h);
}

describe("ticket 03: rework loop + budgets", () => {
  it("a gate failure routes feedback to the previous stage and the loop is visible in history", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      review: [gateFail("review", "fix the SQL injection")],
    });
    const orch = makeOrchestrator(harness, runner);

    await orch.tickAll(); // triage
    await orch.tickAll(); // spec
    await orch.tickAll(); // implement
    await orch.tickAll(); // test
    const report = await orch.tickAll(); // review fails

    expect(report.entries[0]!.detail).toContain("feedback → implement");
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("implement");
    expect(item.feedback).toBe("fix the SQL injection");
    expect(item.gateAttempts["review"]).toBe(1);

    const history = harness.db.getHistory(item.id);
    expect(history.filter((h) => h.event === "stage-gate-fail")).toHaveLength(1);

    // feedback reached implement on the rework run
    await orch.tickAll(); // implement re-runs with feedback
    const implementCalls = runner.calls!.filter((c) => c.req.stage === "implement");
    expect(implementCalls).toHaveLength(2);
    expect(implementCalls[1]!.req.item.feedback).toBe("fix the SQL injection");
  });

  it("a pass after rework continues normally with the full rework history retained", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      review: [gateFail("review", "add input validation"), pass("review", { prSummary: "fixes applied" })],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(item.gateAttempts["review"]).toBe(2); // failure + passing attempt
    const history = harness.db.getHistory(item.id);
    expect(history.filter((h) => h.event === "stage-gate-fail")).toHaveLength(1);
    expect(history.filter((h) => h.event === "stage-pass")).toHaveLength(7); // triage, spec, test, review + 3 rework passes
    // review runs interleaved with implement reworks
    const reviewCalls = runner.calls!.filter((c) => c.req.stage === "review");
    expect(reviewCalls).toHaveLength(2);
  });

  it("reject-reject-reject parks the item after 3 total gate attempts with failures attached", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      review: [gateFail("review", "bad 1"), gateFail("review", "bad 2"), gateFail("review", "bad 3")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("exhausted-rework");
    expect(item.parkedReason).toBe("exhausted-rework");
    expect(item.gateAttempts["review"]).toBe(3);
    expect((item.parkedDetail as Record<string, unknown>).attempts).toBe(3);
    const fails = harness.db.getHistory(item.id).filter((h) => h.event === "stage-gate-fail");
    expect(fails).toHaveLength(3);
    const reviewImplementCalls = runner.calls!.filter((c) => c.req.stage === "implement");
    expect(reviewImplementCalls).toHaveLength(3); // three implement runs total
  });

  it("flaky infra recovers via automatic retry without consuming gate budget", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    let triageCalls = 0;
    const runner = new ScriptedRunner({
      triage: [
        () => {
          triageCalls += 1;
          if (triageCalls === 1) throw new Error("model timeout");
          return { outcome: "pass", artifacts: [] };
        },
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(item.infraAttempts).toBe(1);
    expect(item.gateAttempts["review"]).toBe(1); // infra retries never consumed gate budget: exactly one review run
    const history = harness.db.getHistory(item.id);
    expect(history.filter((h) => h.event === "stage-retry")).toHaveLength(1);
  });

  it("always-failing infra parks the item with a distinct parked reason", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      triage: [
        () => {
          throw new Error("docker daemon unreachable");
        },
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("infrastructure-failure");
    expect(item.parkedReason).toBe("infrastructure-failure");
    expect((item.parkedDetail as Record<string, unknown>).error).toContain("docker daemon");
    expect(item.infraAttempts).toBe(4); // 1 initial + 3 retries (default budget)
  });

  it("mixed gate + infra failures keep both budgets independent", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    let testCalls = 0;
    const runner = new ScriptedRunner({
      test: [
        () => {
          testCalls += 1;
          if (testCalls === 2) throw new Error("sandbox flake"); // 2nd attempt flakes
          // 1st and 3rd attempts: gate failure then pass
          return testCalls === 1
            ? gateFail("test", "suite failed")
            : { outcome: "pass", artifacts: [] };
        },
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(item.gateAttempts["test"]).toBe(2); // fail(1) + flake(retry, not a gate attempt) + pass(2)
    expect(item.infraAttempts).toBe(1);
  });

  it("both budgets are configurable from the config file", async () => {
    harness = createHarness({ maxGateAttempts: 2, maxInfraRetries: 1 });
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      review: [gateFail("review", "bad 1"), gateFail("review", "bad 2")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("exhausted-rework");
    expect(item.gateAttempts["review"]).toBe(2); // tighter budget bites at 2
  });

  it("rework rounds append dated failed-gate lessons to the project KB layer", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      review: [gateFail("review", "lesson one"), gateFail("review", "lesson two")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const kbFile = projectKbFile(harness.paths, "/tmp/repo");
    const kb = readKbFile(kbFile);
    expect(kb).toContain("failed-gate (repo)");
    expect(kb).toContain("lesson one");
    expect(kb).toContain("lesson two");
    expect(kb.match(/## \d{4}-\d{2}-\d{2}/g)!.length).toBeGreaterThanOrEqual(2);
  });
});