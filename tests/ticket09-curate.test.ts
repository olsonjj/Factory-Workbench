import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHarness, claim, makeOrchestrator, type TestHarness } from "./helpers.js";
import { readKbFile, projectKbFile, globalKbFile } from "../src/kb.js";
import type { CuratorRequest, CuratorRunner, StageResult } from "../src/types.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

class FakeCurator implements CuratorRunner {
  readonly received: CuratorRequest[] = [];
  private readonly proposal: string;
  constructor(proposal = "# Curation proposal\n\n- contradiction: entry 2 vs entry 5\n- stale: dated 2020 entry, prune\n- repo-mismatch: KB says tests run via jest; repo uses vitest (evidence: vitest.config.ts)\n") {
    this.proposal = proposal;
  }
  async propose(req: CuratorRequest): Promise<StageResult> {
    this.received.push(req);
    return { outcome: "pass", artifacts: [{ name: "proposal", content: this.proposal }] };
  }
}

function seedWorld(h: TestHarness): void {
  // an item so a repo is known to the orchestrator
  h.inboxFile("task", { title: "Curate me", repo: "/tmp/repo", base: "main", approvals: [] }, "Do it.");
  claim(h);
}

describe("ticket 09: curator pass for the knowledge base", () => {
  it("wb curate produces a proposal file listing concrete findings, each citing entries and evidence", async () => {
    harness = createHarness();
    seedWorld(harness);
    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });

    const { file } = await orch.curate();
    const abs = path.join(harness.root, file);
    expect(existsSync(abs)).toBe(true);
    const proposal = readFileSync(abs, "utf8");
    expect(proposal).toContain("Curation proposal");
    expect(proposal).toContain("contradiction");
    expect(proposal).toContain("evidence");
    expect(file.startsWith("proposals/curate-")).toBe(true);
  });

  it("the proposal is validated as non-empty and the pass is scoped per project when requested", async () => {
    harness = createHarness();
    seedWorld(harness);
    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });
    const { proposal } = await orch.curate(["repo"]);
    expect(proposal.length).toBeGreaterThan(10);
    expect(curator.received[0]!.projects).toEqual(["repo"]);
  });

  it("the curator is strictly read-only with respect to the KB: no entry added/modified/removed", async () => {
    harness = createHarness();
    seedWorld(harness);
    const kbGlobal = globalKbFile(harness.paths);
    harness.writeFile(kbGlobal, "## 2026-01-01 — failed-gate (repo)\n\nsome lesson\n\n");
    const projectFile = projectKbFile(harness.paths, "/tmp/repo");
    harness.writeFile(projectFile, "## 2026-01-02 — post-rework (repo)\n\na fix\n\n");
    const beforeGlobal = readFileSync(kbGlobal, "utf8");
    const beforeProject = readFileSync(projectFile, "utf8");

    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });
    await orch.curate(["repo"]);

    expect(readFileSync(kbGlobal, "utf8")).toBe(beforeGlobal);
    expect(readFileSync(projectFile, "utf8")).toBe(beforeProject);
  });

  it("the curator run is hermetic: it flows through the StageRunner-style seam and sees the KB layers + repo paths", async () => {
    harness = createHarness();
    seedWorld(harness);
    harness.writeFile(globalKbFile(harness.paths), "GLOBAL KB");
    harness.writeFile(projectKbFile(harness.paths, "/tmp/repo"), "PROJECT KB");
    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });
    await orch.curate();
    const req = curator.received[0]!;
    expect(req.kb.global).toBe("GLOBAL KB");
    expect(req.kb.project).toBe("PROJECT KB");
    expect(req.repoPaths["repo"]).toBe(path.resolve("/tmp/repo"));
  });

  it("an oversized KB is reviewed in entry-aligned batches; per-batch proposals merge into one artifact", async () => {
    harness = createHarness();
    seedWorld(harness);
    // Shrink the curation budget so the seeded global layer must be batched.
    harness.config.kb.maxGlobalChars = 400;
    const entries = [1, 2, 3, 4]
      .map((n) => `## 2026-10-27 — failed-gate (repo ${n})\n\n${"lesson ".repeat(40)}\n\n`)
      .join("");
    harness.writeFile(globalKbFile(harness.paths), entries);
    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });

    const { file, proposal } = await orch.curate();
    // Every appended entry was offered to some batch — none silently elided.
    const offered = curator.received.map((r) => r.kb.global).join("");
    expect(offered).toContain("(repo 1)");
    expect(offered).toContain("(repo 4)");
    expect(curator.received.length).toBeGreaterThanOrEqual(2);
    // Each batch stays near the budget and carries its batch marker.
    curator.received.forEach((r, i) => {
      expect(r.kb.global.length).toBeLessThanOrEqual(400 + 500); // at most one oversized-entry overhang
      expect(r.batch).toEqual({ index: i + 1, total: curator.received.length });
    });
    // One merged proposal artifact.
    const abs = path.join(harness.root, file);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toContain("curation batch 1 of");
    expect(proposal).toContain("Curation proposal");
  });

  it("a single batch still respects the budget: a lone oversized entry is sent truncated, not full", async () => {
    harness = createHarness();
    seedWorld(harness);
    harness.config.kb.maxGlobalChars = 400;
    // One entry that individually exceeds the (shrunken) budget.
    harness.writeFile(globalKbFile(harness.paths), `## 2026-10-27 — failed-gate (repo 0)\n\n${"x".repeat(2000)}\n\n`);
    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });
    await orch.curate();
    expect(curator.received.length).toBe(1);
    expect(curator.received[0]!.kb.global.length).toBeLessThanOrEqual(400 + 200);
    expect(curator.received[0]!.batch).toBeUndefined();
  });

  it("a failed later batch does not discard completed ones — partial proposals are saved and the error names the file", async () => {
    harness = createHarness();
    seedWorld(harness);
    harness.config.kb.maxGlobalChars = 400;
    const entries = [1, 2, 3, 4]
      .map((n) => `## 2026-10-27 — failed-gate (repo ${n})\n\n${"lesson ".repeat(40)}\n\n`)
      .join("");
    harness.writeFile(globalKbFile(harness.paths), entries);
    class FlakyCurator implements CuratorRunner {
      readonly received: CuratorRequest[] = [];
      async propose(req: CuratorRequest): Promise<StageResult> {
        this.received.push(req);
        if (req.batch && req.batch.index >= 2) throw new Error("sandbox vanished");
        return { outcome: "pass", artifacts: [{ name: "proposal", content: "# Curation proposal\n\n- finding from this batch\n" }] };
      }
    }
    const curator = new FlakyCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });
    await expect(orch.curate()).rejects.toThrow(/curation batch 2 of \d+ failed.*completed batches saved in/);
    // The partial artifact survives with batch 1's proposal and an INCOMPLETE marker.
    const saved = harness.db.listItems();
    void saved;
    const files = harness.root + "/proposals";
    const { readdirSync } = await import("node:fs");
    const names = readdirSync(files).filter((f) => f.startsWith("curate-"));
    expect(names.length).toBe(1);
    const partial = readFileSync(path.join(files, names[0]!), "utf8");
    expect(partial).toContain("INCOMPLETE");
    expect(partial).toContain("curation batch 1 of");
    expect(partial).toContain("finding from this batch");
  });

  it("a human applying the proposal edits KB files directly; a subsequent run uses the curated content", async () => {
    harness = createHarness();
    seedWorld(harness);
    const curator = new FakeCurator();
    const orch = makeOrchestrator(harness, new (await import("./helpers.js")).ScriptedRunner({}), { curator });
    const { file } = await orch.curate();
    // Human reads proposal, applies by hand-editing the KB file:
    const projectFile = projectKbFile(harness.paths, "/tmp/repo");
    harness.writeFile(projectFile, "## 2026-01-03 — failed-gate (repo)\n\ncurated truth\n\n");
    void file;
    const runner = new (await import("./helpers.js")).ScriptedRunner({});
    const orch2 = makeOrchestrator(harness, runner, { curator: new FakeCurator() });
    await orch2.tickAll(); // triage (lightweight global)
    await orch2.tickAll(); // spec (global + project)
    const specReq = runner.calls!.find((c) => c.req.stage === "spec")!.req;
    expect(specReq.kb.project).toContain("curated truth");
  });
});