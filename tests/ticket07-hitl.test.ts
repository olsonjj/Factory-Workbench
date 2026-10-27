import { describe, it, expect, afterEach } from "vitest";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, pass, gateFail, type TestHarness } from "./helpers.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropItem(h: TestHarness, frontMatter: Record<string, unknown> = {}): void {
  h.inboxFile("task", { title: "Feature X", repo: "/tmp/repo", base: "main", ...frontMatter }, "Do feature X.");
  claim(h);
}

describe("ticket 07: HITL approval gates", () => {
  it("an item with approvals [spec] parks after spec and shows the spec artifact", async () => {
    harness = createHarness();
    dropItem(harness, { approvals: ["spec"] });
    const runner = new ScriptedRunner({
      spec: [pass("spec")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll(); // triage (not gated)
    await orch.tickAll(); // spec completes → park
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("awaiting-approval");
    expect(item.parkedReason).toBe("awaiting-approval");
    const artifacts = harness.db.getArtifacts(item.id);
    expect(artifacts.some((a) => a.name === "spec")).toBe(true); // available to read
    // pipeline did not run implement yet
    expect(runner.stageCallCounts.get("implement")).toBeUndefined();
  });

  it("approve resumes from the parked stage's next step; no approve needed for autonomous items", async () => {
    harness = createHarness();
    dropItem(harness, { approvals: ["spec"] });
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    await orch.tickAll();
    const item = harness.db.listItems()[0]!;
    orch.approve(item.id);
    const approved = harness.db.listItems()[0]!;
    expect(approved.status).toBe("queued");
    expect(approved.stage).toBe("implement"); // parked stage's next step
    const history = harness.db.getHistory(item.id);
    expect(history.some((h) => h.event === "approved")).toBe(true);
    await orch.resume();
    expect(harness.db.listItems()[0]!.status).toBe("done");
  });

  it("reject with reason parks as human-rejected; on resume the completed stage re-runs receiving the reason", async () => {
    harness = createHarness();
    dropItem(harness, { approvals: ["spec"] });
    const runner = new ScriptedRunner({
      spec: [pass("spec"), pass("spec")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    await orch.tickAll(); // parked after spec
    const item = harness.db.listItems()[0]!;
    orch.rejectItem(item.id, "spec misses the migration step");
    const rejected = harness.db.listItems()[0]!;
    expect(rejected.status).toBe("human-rejected");
    expect(rejected.parkedReason).toBe("human-rejected");

    // resume: the reason feeds the completed stage (spec re-runs with it)
    await orch.resume();
    const specReqs = runner.calls!.filter((c) => c.req.stage === "spec");
    expect(specReqs).toHaveLength(2);
    expect(specReqs[1]!.req.item.feedback).toBe("spec misses the migration step");
    // after spec re-runs, the approval gate applies again before any further cost
    expect(harness.db.listItems()[0]!.status).toBe("awaiting-approval");
    const history = harness.db.getHistory(item.id);
    expect(history.some((h) => h.event === "rejected-by-human" && h.detail.reason === "spec misses the migration step")).toBe(true);
  });

  it("a fully autonomous item behaves identically with no verbs", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    // never parked for approval: single continuous run
    const history = harness.db.getHistory(item.id);
    expect(history.some((h) => h.event === "parked")).toBe(false);
  });

  it("verbs reject items in the wrong state with a clear error", async () => {
    harness = createHarness();
    dropItem(harness, { approvals: ["spec"] });
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll(); // triage only — not parked yet
    const item = harness.db.listItems()[0]!;
    expect(() => orch.approve(item.id)).toThrow(/queued; expected awaiting-approval/);
    expect(() => orch.rejectItem(item.id, "nope")).toThrow(/queued; expected awaiting-approval/);
  });
});