import { describe, it, expect, afterEach } from "vitest";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, pass, type TestHarness } from "./helpers.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropItem(h: TestHarness, fm: Record<string, unknown> = {}): void {
  h.inboxFile("task", { title: "Wired item", repo: "/tmp/repo", base: "main", ...fm }, "Do the wired task.");
  claim(h);
}

describe("review fixes: spec handoff and operator artifacts", () => {
  it("the saved spec artifact reaches the implement agent as item.spec", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      spec: [pass("spec")], // artifact content: "# spec output"
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll(); // triage
    await orch.tickAll(); // spec
    await orch.tickAll(); // implement
    const implementReq = runner.calls!.find((c) => c.req.stage === "implement")!.req;
    expect(implementReq.item.spec).toContain("# spec output");
  });

  it("answers are saved as an item artifact", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [{ outcome: "needs-human", artifacts: [], questions: ["Which UI?"] }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const parked = harness.db.listItems()[0]!;
    orch.answer(parked.id, [], "React");
    const artifacts = harness.db.getArtifacts(parked.id);
    const answersArtifact = artifacts.find((a) => a.name === "answers")!;
    expect(answersArtifact).toBeTruthy();
    expect(harness.readFile(harness.root + "/" + answersArtifact.path)).toContain("React");
  });

  it("approve and reject decisions are saved as artifacts with reasons", async () => {
    harness = createHarness();
    dropItem(harness, { approvals: ["spec"] });
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    await orch.tickAll(); // parked after spec
    const parked = harness.db.listItems()[0]!;

    orch.rejectItem(parked.id, "spec misses the migration step");
    const rejected = harness.db.listItems()[0]!;
    const artifacts = harness.db.getArtifacts(rejected.id);
    const rejection = artifacts.find((a) => a.name === "rejection-spec")!;
    expect(rejection).toBeTruthy();
    expect(harness.readFile(harness.root + "/" + rejection.path)).toContain("spec misses the migration step");

    // approve path: park once more after spec re-runs
    const runner2 = new ScriptedRunner({});
    const orch2 = makeOrchestrator(harness, runner2);
    await orch2.resume(); // spec re-runs with the reason as feedback, then parks again
    const reparked = harness.db.listItems()[0]!;
    expect(reparked.status).toBe("awaiting-approval");
    orch2.approve(reparked.id, "looks good now");
    const approval = harness.db.getArtifacts(reparked.id).find((a) => a.name === "approval-spec")!;
    expect(approval).toBeTruthy();
    const content = harness.readFile(harness.root + "/" + approval.path);
    expect(content).toContain("decision: approved");
    expect(content).toContain("looks good now");
  });
});