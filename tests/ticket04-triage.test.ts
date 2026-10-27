import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, pass, type TestHarness } from "./helpers.js";
import { scanInbox } from "../src/inbox.js";
import { artifactDir } from "../src/paths.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropItem(h: TestHarness, frontMatter: Record<string, unknown> = {}): void {
  h.inboxFile("task", { title: "Build a widget", repo: "/tmp/repo", base: "main", ...frontMatter }, "Build the widget please.");
  claim(h);
}

describe("ticket 04: triage stage", () => {
  it("proceed moves the item onward in the pipeline", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [{ outcome: "pass", artifacts: [{ name: "triage-report", content: "# looks actionable" }] }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("spec");
  });

  it("reject archives the item with the triage report attached", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [{ outcome: "reject", artifacts: [{ name: "triage-report", content: "# reason: dangerous" }], report: "# reason: dangerous" }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("rejected");
    expect(item.parkedReason).toBe("triage-rejected");
    // archive: item dir + report moved out of the item store
    expect(existsSync(path.join(harness.paths.archive, "task", "item.md"))).toBe(true);
    expect(existsSync(path.join(harness.paths.items, "task"))).toBe(false);
    const artifacts = harness.db.getArtifacts(item.id);
    const report = artifacts.find((a) => a.name === "triage-report")!;
    expect(report).toBeTruthy();
    expect(harness.readFile(path.join(harness.root, report.path))).toContain("dangerous");
  });

  it("re-dropping an archived item's file creates a fresh claim (resurrection)", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [{ outcome: "reject", artifacts: [], report: "nope" }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    expect(harness.db.listItems()[0]!.status).toBe("rejected");

    // operator resurrects by re-dropping the file
    harness.dropAgain("task", { title: "Build a widget", repo: "/tmp/repo", base: "main", approvals: [] }, "Build the widget please.");
    scanInbox(harness.paths, harness.db);

    const items = harness.db.listItems();
    expect(items).toHaveLength(2);
    const fresh = items[1]!;
    expect(fresh.status).toBe("queued");
    expect(fresh.stage).toBe("triage");
    expect(fresh.slug).toBe("task-2");
    expect(fresh.id).not.toBe(items[0]!.id);
  });

  it("needs-human parks with questions visible in status and stored as an artifact", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [{ outcome: "needs-human", artifacts: [{ name: "triage-questions", content: "- Which UI framework?\n" }], questions: ["Which UI framework?"] }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("needs-human");
    expect(item.parkedReason).toBe("needs-human");
    expect(item.parkedDetail?.questions).toEqual(["Which UI framework?"]);
    const artifacts = harness.db.getArtifacts(item.id);
    expect(artifacts.some((a) => a.name === "triage-questions")).toBe(true);
  });

  it("wb answer records answers; the next run re-runs triage with them in context", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [
        { outcome: "needs-human", artifacts: [], questions: ["Which UI framework?"] },
        (req, nth) => {
          void nth;
          return { outcome: "pass", artifacts: [{ name: "triage-report", content: "ok with answers" }] };
        },
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const parked = harness.db.listItems()[0]!;

    orch.answer(parked.id, [{ question: "Which UI framework?", answer: "React, like the rest of the repo" }]);
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("triage");
    expect(item.answers[0]!.answer).toContain("React");

    harness.db.appendHistory(item.id, "answered", "triage", {});
    // next run: triage re-executes with answers in context
    const runner2calls = runner.calls;
    await orch.tickAll();
    const triageReqs = runner2calls.filter((c) => c.req.stage === "triage");
    expect(triageReqs).toHaveLength(2);
    expect(triageReqs[1]!.req.item.answers).toEqual([{ question: "Which UI framework?", answer: "React, like the rest of the repo" }]);
    const itemAfter = harness.db.listItems()[0]!;
    expect(itemAfter.stage).toBe("spec");
  });

  it("an unparseable triage verdict retries under the infra budget rather than advancing", async () => {
    harness = createHarness({ maxInfraRetries: 2 });
    dropItem(harness);
    let calls = 0;
    const runner = new ScriptedRunner({
      triage: [
        () => {
          calls += 1;
          if (calls <= 2) return { outcome: "infra-fail", artifacts: [], report: "StructuredOutputError: unparseable verdict" };
          return pass("triage");
        },
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const item = harness.db.listItems()[0]!;
    // retries fired, then the verdict landed and we advanced
    expect(item.stage).toBe("spec");
    expect(item.infraAttempts).toBe(2);
    expect(calls).toBe(3);
  });

  it("triage report, questions, and answers are saved as artifacts and usage is recorded", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      triage: [
        { outcome: "pass", artifacts: [{ name: "triage-report", content: "# ok: actionable\n" }], usage: { model: "deepseek-v4-pro", inputTokens: 100, outputTokens: 20 } },
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll();
    const item = harness.db.listItems()[0]!;
    const artifacts = harness.db.getArtifacts(item.id);
    expect(artifacts).toHaveLength(1);
    expect(existsSync(path.join(harness.root, artifacts[0]!.path))).toBe(true);
    const history = harness.db.getHistory(item.id);
    const passEvent = history.find((h) => h.event === "stage-pass")!;
    expect((passEvent.detail.usage as { model: string }).model).toBe("deepseek-v4-pro");
  });
});