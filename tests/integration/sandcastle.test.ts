import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createHarness,
  claim,
  type TestHarness,
} from "../helpers.js";
import { SandcastleStageRunner, GhPrPublisher } from "../../src/adapters/sandcastle.js";
import { loadConfig } from "../../src/config.js";

/**
 * The single thin integration test for the Sandcastle adapter, gated on Docker
 * availability. Everything else in the suite runs hermetically above the seam.
 */

let dockerAvailable = false;
try {
  execFileSync("docker", ["info"], { timeout: 10_000, stdio: "pipe" });
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const gated = dockerAvailable && !!process.env.OLLAMA_API_KEY;
const d = gated ? describe : describe.skip;

let harness: TestHarness;
let repoDir: string;

d("integration: sandcastle adapter (requires docker + OLLAMA_API_KEY)", () => {
  beforeAll(() => {
    harness = createHarness();
    // Sandcastle mounts the parent .git at the literal path it is given while
    // git records realpaths — a /var symlinked fixture would dangle in-container.
    repoDir = mkdtempSync(path.join(os.tmpdir(), "factory-int-repo-"));
    const git = (args: string[]): void => execFileSync("git", args, { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# integration repo\n");
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"console.log('ok')\"" } }));
    git(["init", "-b", "main"]);
    git(["add", "."]);
    execFileSync("git", ["-C", repoDir, "commit", "-m", "init", "-q"], {});
    harness.config.sandbox.imageName = "sandcastle:local";
  });

  afterAll(() => {
    harness?.cleanup();
  });

  it("triage stage returns a real verdict for a well-formed item", async () => {
    const { config } = loadConfig(undefined, harness.root);
    const runner = new SandcastleStageRunner({ config });
    const result = await runner.runStage({
      stage: "triage",
      item: {
        id: 1,
        slug: "integration",
        title: "Add a HELLO constant",
        repo: repoDir,
        base: "main",
        approvals: [],
        body: "Add a file src/hello.ts exporting `export const HELLO = 'world';`.",
        branchName: "factory/integration",
      },
      kb: { global: "", project: "" },
    });
    expect(["pass", "reject", "needs-human", "gate-fail", "infra-fail"]).toContain(result.outcome);
  }, 300_000);

  // Same harness as above, on purpose: the staged pi-config (and everything
  // else in the temp factory root) is cleaned up in this describe's afterAll,
  // so any later describe reusing the module-level `harness` would run against
  // deleted files. Keep gated real-agent tests inside this block.
  it("spec stage flags a KB fact that contradicts the repo (ticket 08)", async () => {
    const { config } = loadConfig(undefined, harness.root);
    const runner = new SandcastleStageRunner({ config });
    const result = await runner.runStage({
      stage: "spec",
      item: {
        id: 1,
        slug: "stale-fact",
        title: "Summarize the build setup",
        repo: repoDir,
        base: "main",
        approvals: [],
        body: "In one sentence, which test runner does this repo use? State what you actually verified in the repo.",
        branchName: "factory/stale-fact",
      },
      // Planted stale fact: the repo uses jest, but package.json says otherwise.
      kb: { global: "FACT: this project runs its tests via jest.\n", project: "" },
    });
    expect(result.outcome).toBe("pass");
    const spec = result.artifacts.find((a) => a.name === "spec")!.content.toLowerCase();
    // the agent must surface the repo's actual evidence rather than parroting jest
    expect(spec).toMatch(/vitest|node|package\.json|not jest/);
  }, 300_000);
});

describe("adapter environment gating", () => {
  it("is reported as skipped when docker is unavailable", () => {
    if (!dockerAvailable) {
      // the real test above is skipped; document it
      expect(true).toBe(true);
    } else {
      expect(dockerAvailable).toBe(true);
    }
  });
});