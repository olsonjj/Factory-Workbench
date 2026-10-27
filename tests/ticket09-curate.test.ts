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
  it("factory curate produces a proposal file listing concrete findings, each citing entries and evidence", async () => {
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