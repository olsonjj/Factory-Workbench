import { describe, it, expect, afterEach } from "vitest";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, pass, FakePublisher, type TestHarness } from "./helpers.js";
import { readKbFile, projectKbFile } from "../src/kb.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropItem(h: TestHarness, frontMatter: Record<string, unknown> = {}): void {
  h.inboxFile("task", { title: "Ship the feature", repo: "/tmp/repo", base: "main", ...frontMatter }, "Ship it.");
  claim(h);
}

describe("ticket 05: spec → implement → PR", () => {
  it("an autonomous item ends with a ready-for-review PR whose body follows the PR-skill template", async () => {
    harness = createHarness();
    dropItem(harness);
    const publisher = new FakePublisher();
    const runner = new ScriptedRunner({
      spec: [pass("spec")],
      implement: [pass("implement")],
      review: [pass("review", { prSummary: "adds widget with tests" })],
    });
    const orch = makeOrchestrator(harness, runner, { publisher });
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(publisher.count()).toBe(1);
    const req = publisher.published[0]!;
    // draft vs ready-for-review follows the approvals front-matter
    expect(req.draft).toBe(false);
    expect(req.branchName).toBe("factory/task");
    expect(req.base).toBe("main");

    const body = req.body;
    // Three template sections, in order, no audit-trail headings
    expect(body).toContain("## Summary");
    expect(body).toContain("## Evidence");
    expect(body).toContain("## Merge Danger");
    expect(body.indexOf("## Summary")).toBeLessThan(body.indexOf("## Evidence"));
    expect(body.indexOf("## Evidence")).toBeLessThan(body.indexOf("## Merge Danger"));
    expect(body).not.toContain("## Request");
    expect(body).not.toContain("## Spec");
    expect(body).not.toContain("## Review verdict");
    expect(body).not.toContain("## Rework history");
    expect(body).not.toContain("## Artifact index");
    // Summary carries the spec summary (what changes and why)
    expect(body).toContain("spec output");
    // Evidence references at least one artifact under the run's artifact dir
    expect(body).toMatch(/items\/task\/artifacts\//);
    // footer points at the artifact directory
    expect(body).toContain("artifacts: items/task/artifacts/");
    // no stage-by-stage chronology bullet list
    expect(body).not.toMatch(/stage-gate-fail|stage-retry/);
  });

  it("the PR body has exactly the three template sections, in order", async () => {
    harness = createHarness();
    dropItem(harness);
    const publisher = new FakePublisher();
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner, { publisher });
    await orch.resume();
    const body = publisher.published[0]!.body;
    const headings = body.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Summary", "## Evidence", "## Merge Danger"]);
    expect(body).toMatch(/items\/task\/artifacts\//);
  });

  it("a draft PR is created when the item has approvals front-matter; ready PR when autonomous", async () => {
    harness = createHarness();
    dropItem(harness, { approvals: ["spec"] });
    const publisher = new FakePublisher();
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner, { publisher });
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("awaiting-approval"); // parked at the approval gate
    orch.approve(item.id);
    await orch.resume();
    expect(harness.db.listItems()[0]!.status).toBe("done");
    expect(publisher.published[0]!.draft).toBe(true);
  });

  it("PR creation is terminal; a second resume never re-publishes (never merges either)", async () => {
    harness = createHarness();
    dropItem(harness);
    const publisher = new FakePublisher();
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner, { publisher });
    await orch.resume();
    await orch.resume();
    expect(publisher.count()).toBe(1);
    expect(harness.db.listItems()[0]!.status).toBe("done");
  });

  it("PR-stage infra failures retry then park with a clear reason", async () => {
    harness = createHarness({ maxInfraRetries: 1 });
    dropItem(harness);
    const publisher = new FakePublisher(10); // always fails
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner, { publisher });
    await orch.resume();
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("infrastructure-failure");
    expect(item.parkedReason).toBe("infrastructure-failure");
    expect((item.parkedDetail as Record<string, unknown>).stage).toBe("pr");
  });

  it("PR creation appends a one-line outcome entry to the project KB layer", async () => {
    harness = createHarness();
    dropItem(harness);
    const publisher = new FakePublisher();
    const runner = new ScriptedRunner({
      review: [pass("review", { prSummary: "adds widget with tests" })],
    });
    const orch = makeOrchestrator(harness, runner, { publisher });
    await orch.resume();

    const kb = readKbFile(projectKbFile(harness.paths, "/tmp/repo"));
    expect(kb).toContain("pr-outcome");
    expect(kb).toContain("adds widget with tests");
  });
});