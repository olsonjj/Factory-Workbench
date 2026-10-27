import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHarness, makeOrchestrator, claim, ScriptedRunner, pass, gateFail, type TestHarness } from "./helpers.js";
import { readKbFile, projectKbFile, globalKbFile } from "../src/kb.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

function dropItem(h: TestHarness): void {
  h.inboxFile("task", { title: "KB task", repo: "/tmp/repo", base: "main", approvals: [] }, "Do it.");
  claim(h);
}

describe("ticket 08: knowledge base write-moments + loading", () => {
  it("a failed gate appends a dated lesson to the project layer", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({ review: [gateFail("review", "lesson: never skip validation")] });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const kbFile = projectKbFile(harness.paths, "/tmp/repo");
    expect(existsSync(kbFile)).toBe(true);
    const kb = readKbFile(kbFile);
    expect(kb).toContain("failed-gate (repo)");
    expect(kb).toContain("lesson: never skip validation");
    expect(kb).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — failed-gate \(repo\)/);
  });

  it("a resolved rework appends a post-rework entry; PR creation appends a one-line outcome", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({
      test: [gateFail("test", "tests were red"), { outcome: "pass", artifacts: [], fix: "the fix was seeding the db" }],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const kb = readKbFile(projectKbFile(harness.paths, "/tmp/repo"));
    expect(kb).toContain("post-rework (repo)");
    expect(kb).toContain("the fix was seeding the db");
    expect(kb).toContain("pr-outcome (repo)");
  });

  it("KB loading: triage sees only a lightweight (truncated) global layer; spec sees global + project in full", async () => {
    harness = createHarness();
    dropItem(harness);
    // plant global KB with >2000 chars, and project KB
    harness.writeFile(globalKbFile(harness.paths), "G".repeat(3000));
    harness.writeFile(projectKbFile(harness.paths, "/tmp/repo"), "PROJECT FACTS");
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const triageReq = runner.calls!.find((c) => c.req.stage === "triage")!.req;
    expect(triageReq.kb.global.length).toBe(2000); // truncated, "lightly"
    expect(triageReq.kb.project).toBe("");         // triage never sees project layer
    const specReq = runner.calls!.find((c) => c.req.stage === "spec")!.req;
    expect(specReq.kb.global).toBe("G".repeat(3000));
    expect(specReq.kb.project).toBe("PROJECT FACTS");
    const reviewReq = runner.calls!.find((c) => c.req.stage === "review")!.req;
    expect(reviewReq.kb.project).toBe("PROJECT FACTS");
  });

  it("append-only invariant: failures only ever grow the KB file; content bytes are never rewritten", async () => {
    harness = createHarness();
    dropItem(harness);
    const kbFile = projectKbFile(harness.paths, "/tmp/repo");
    const runner = new ScriptedRunner({
      review: [gateFail("review", "round one"), gateFail("review", "round two"), gateFail("review", "round three")],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const kb = readKbFile(kbFile);
    // the first lesson is still byte-identical in the final file
    expect(kb).toContain("round one");
    expect(kb).toContain("round two");
    expect(kb).toContain("round three");
    const entries = kb.match(/## \d{4}-\d{2}-\d{2}/g)!.length;
    expect(entries).toBe(3);
    // appending again never rewrites: run another item and the prefix is preserved
    const firstPrefix = kb.slice(0, 100);
    // a different item targeting the same repo appends to the same project layer
    harness.inboxFile("task-2", { title: "KB task 2", repo: "/tmp/repo", base: "main", approvals: [] }, "Do it again.");
    claim(harness);
    const runner2 = new ScriptedRunner({ review: [gateFail("review", "another lesson")] });
    const orch2 = makeOrchestrator(harness, runner2);
    await orch2.resume();
    const kb2 = readKbFile(kbFile);
    expect(kb2.startsWith(firstPrefix)).toBe(true);
    expect(kb2).toContain("another lesson");
  });

  it("a human can edit KB files between runs and the next agent run picks up the edit", async () => {
    harness = createHarness();
    dropItem(harness);
    harness.writeFile(projectKbFile(harness.paths, "/tmp/repo"), "# notes\n\ncustom entry by operator\n");
    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll(); // triage
    await orch.tickAll(); // spec
    const specReq = runner.calls!.find((c) => c.req.stage === "spec")!.req;
    expect(specReq.kb.project).toContain("custom entry by operator");
  });

  it("entries carry a date and a scope; the scope is the repo key", async () => {
    harness = createHarness();
    dropItem(harness);
    const runner = new ScriptedRunner({ review: [gateFail("review", "lesson x")] });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    const kb = readKbFile(projectKbFile(harness.paths, "/tmp/repo"));
    expect(kb).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — failed-gate \(repo\)/);
    // dated per entry, not just per file
    const file = projectKbFile(harness.paths, "/tmp/repo");
    const head = readFileSync(file, "utf8").split("\n")[0];
    expect(head).toContain("— failed-gate (repo)");
  });

  it("per-project scoping: entries for repo A do not leak into repo B's layer", async () => {
    harness = createHarness();
    const runner = new ScriptedRunner({ review: [gateFail("review", "repo A lesson")] });
    const orch = makeOrchestrator(harness, runner);
    harness.inboxFile("item-a", { title: "A", repo: "/tmp/repo-a", base: "main", approvals: [] }, "work A");
    claim(harness);
    await orch.resume();
    const kbA = readKbFile(projectKbFile(harness.paths, "/tmp/repo-a"));
    expect(kbA).toContain("repo A lesson");
    expect(existsSync(path.join(harness.paths.kb, "projects", "repo-b.md"))).toBe(false);
  });
});