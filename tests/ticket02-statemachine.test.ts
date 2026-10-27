import { describe, it, expect, afterEach } from "vitest";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, type TestHarness } from "./helpers.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropAutonomousItem(h: TestHarness): void {
  h.inboxFile("demo", { title: "Demo task", repo: "/tmp/repo", base: "main", approvals: [] }, "Do the demo task.");
  claim(h);
}

describe("ticket 02: stage state machine + run/resume (stub stages)", () => {
  it("repeated run invocations walk the pipeline one stage at a time to done", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    const stagesSeen: string[] = [];

    for (let i = 0; i < 10; i++) {
      const report = await orch.tickAll();
      for (const e of report.entries) {
        stagesSeen.push(e.fromStage);
        if (e.status === "done") break;
      }
      const item = harness.db.listItems()[0]!;
      if (item.status === "done") break;
    }

    // one actionable step per invocation: triage → spec → implement → test → review → pr
    expect(stagesSeen).toEqual(["triage", "spec", "implement", "test", "review", "pr"]);
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
  });

  it("resume continues an interrupted run from the last recorded stage", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);

    // first tick: triage runs and passes
    await orch.tickAll();
    let item = harness.db.listItems()[0]!;
    expect(item.stage).toBe("spec");

    // simulate a crash mid-spec: state persisted as running before execution
    harness.db.updateItem(item.id, { status: "running" });

    // resume picks it up from the recorded stage and finishes everything
    await orch.resume();
    item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    // spec must have been executed (at least started) after triage's pass
    expect(runner.stageCallCounts.get("spec")).toBe(1);
  });

  it("a crash between execute and record re-runs the stage (stage-level idempotency)", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);

    await orch.tickAll(); // triage passes
    let item = harness.db.listItems()[0]!;
    // crash: spec persisted as running, then process died before recording
    harness.db.updateItem(item.id, { status: "running" });

    await orch.resume();
    item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    const history = harness.db.getHistory(item.id);
    // stage-start was persisted before execution; the re-run recorded a pass
    expect(history.filter((h) => h.event === "stage-start").length).toBeGreaterThanOrEqual(2);
    expect(history.filter((h) => h.event === "stage-pass").length).toBeGreaterThanOrEqual(1);
  });

  it("items in every meaningful state are visible via the db query", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({
      triage: [{ outcome: "needs-human", artifacts: [], questions: ["Which auth provider? "], report: "ambiguous" }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("needs-human");
    expect(item.parkedReason).toBe("needs-human");
    expect((item.parkedDetail?.questions as string[]).join("")).toContain("auth provider");
    expect(harness.db.itemsWithStatus(["needs-human"])).toHaveLength(1);
    expect(harness.db.itemsWithStatus(["done"])).toHaveLength(0);
  });

  it("duplicate invocation of resume without pending work changes nothing", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const first = harness.db.getHistory(harness.db.listItems()[0]!.id);
    await orch.resume();
    const second = harness.db.getHistory(harness.db.listItems()[0]!.id);
    expect(second).toEqual(first); // terminal items are left alone
  });

  it("pass results always produce pass-shaped results through the seam", async () => {
    harness = createHarness();
    dropAutonomousItem(harness);
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const requestShape = runner.calls[0]!;
    expect(requestShape.req.stage).toBe("triage");
    expect(requestShape.req.item.slug).toBe("demo");
    expect(requestShape.req.item.title).toBe("Demo task");
    expect(requestShape.req.item.branchName).toBe("factory/demo");
    expect(requestShape.req.item.body).toContain("demo task");
  });
});