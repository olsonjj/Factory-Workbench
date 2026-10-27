import { describe, it, expect, afterEach } from "vitest";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, pass, gateFail, type TestHarness } from "./helpers.js";
import { readKbFile, projectKbFile } from "../src/kb.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropItem(h: TestHarness, frontMatter: Record<string, unknown> = {}): void {
  h.inboxFile("task", { title: "Buggy widget", repo: "/tmp/repo", base: "main", ...frontMatter }, "Make the widget.");
  claim(h);
}

describe("ticket 06: test stage + review gate + real rework loop", () => {
  it("a test-stage failure routes to implement as rework feedback, then proceeds after fix", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      test: [gateFail("test", "suite: 3 failing"), { outcome: "pass", artifacts: [], fix: "initialized the widget before use" }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(item.gateAttempts["test"]).toBe(2);
    const history = harness.db.getHistory(item.id);
    expect(history.filter((h) => h.event === "stage-gate-fail").length).toBe(1);
    // implement ran twice: original + fix
    expect(runner.stageCallCounts.get("implement")).toBe(2);
    const kb = readKbFile(projectKbFile(harness.paths, "/tmp/repo"));
    expect(kb).toContain("failed-gate");
    expect(kb).toContain("suite: 3 failing");
    expect(kb).toContain("post-rework");
    expect(kb).toContain("initialized the widget before use");
  });

  it("a test-stage loop parks the item with the full failure history", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      test: [gateFail("test", "still broken 1"), gateFail("test", "still broken 2"), gateFail("test", "still broken 3")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("exhausted-rework");
    expect(item.parkedReason).toBe("exhausted-rework");
    expect(item.gateAttempts["test"]).toBe(3);
    const history = harness.db.getHistory(item.id).filter((h) => h.event === "stage-gate-fail");
    expect(history).toHaveLength(3);
    const artifacts = harness.db.getArtifacts(item.id);
    // every round's report is on disk and recorded
    const reports = artifacts.filter((a) => a.name.includes("report"));
    expect(reports.length).toBeGreaterThanOrEqual(3);
  });

  it("a review reject after passing tests reworks implement with review reasons as feedback", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      test: [{ outcome: "pass", artifacts: [] }],
      review: [gateFail("review", "add input validation on the widget API"), pass("review")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    const implementCalls = runner.calls!.filter((c) => c.req.stage === "implement");
    expect(implementCalls).toHaveLength(2);
    expect(implementCalls[1]!.req.item.feedback).toContain("input validation");
    // review re-ran after the reworked implement (implement → test → review)
    expect(runner.stageCallCounts.get("test")).toBe(2);
    expect(runner.stageCallCounts.get("review")).toBe(2);
  });

  it("the review verdict is saved as an artifact and lands in the PR body audit trail", async () => {
    harness = createHarness();
    dropItem(harness);
    const publisher = (await import("./helpers.js")).FakePublisher;
    const fakePublisher = new publisher();
    const runner = new ScriptedRunner({
      review: [pass("review", { artifacts: [{ name: "review-verdict", content: "# verdict: pass\nno findings" }] })],
    });
    const orch = makeOrchestrator(harness, runner, { publisher: fakePublisher });
    await orch.resume();
    const req = fakePublisher.published[0]!;
    expect(req.body).toContain("# verdict: pass");
    expect(req.body).toContain("## Review verdict");
  });

  it("both gates failing in different orders behaves deterministically (review fails, then test fails, then pass)", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      test: [gateFail("test", "tests broken"), { outcome: "pass", artifacts: [] }],
      review: [gateFail("review", "review says no"), { outcome: "pass", artifacts: [] }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    // ordered loop: test(fail) → rework → test(pass) → review(fail) → rework → test(pass) → review(pass) → pr
    // a failed gate routes to implement; the review never re-runs until implement+test pass again
    const stages = runner.calls!.map((c) => c.req.stage);
    expect(stages).toEqual([
      "triage", "spec",
      "implement", "test",
      "implement", "test", "review",
      "implement", "test", "review",
    ]);
  });

  it("exhausted rework via review parks with every round's report and a clear parked reason", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      test: [{ outcome: "pass", artifacts: [] }],
      review: [gateFail("review", "r1"), gateFail("review", "r2"), gateFail("review", "r3")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("exhausted-rework");
    expect(item.parkedDetail?.attempts).toBe(3);
    const history = harness.db.getHistory(item.id).filter((h) => h.event === "stage-gate-fail");
    expect(history).toHaveLength(3);
    expect(history.every((h) => h.stage === "review")).toBe(true);
  });
});