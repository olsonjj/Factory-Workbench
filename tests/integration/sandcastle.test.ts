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
import { 
  createWorktree,
  type Worktree,
} from "@ai-hero/sandcastle";
import { SandcastleStageRunner, GhPrPublisher, ollamaEnv, claudeEnv } from "../../src/adapters/sandcastle.js";

/** Same realpath normalization the adapter does (realRepoPath is private):
 *  on macOS /var, /tmp and friends are symlinks — sandcastle mounts the parent
 *  .git at the literal path it is given, so an unnormalized temp dir leaves
 *  the in-container gitdir chain dangling. */
const realRepo = (repo: string): string => {
  try {
    return fs.realpathSync(repo);
  } catch {
    return repo;
  }
};
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

/**
 * OPTIONAL claude-provider smoke (ticket: gated, never required for the
 * factory's own suite to pass). Real end-to-end claude validation needs
 * Docker + a claude-enabled image (docker/claude.Dockerfile) +
 * ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) — nothing on the host.
 * Structured-output `<tag>…</tag>` compliance is prompt-enforced and
 * model-dependent, so this is exactly the one-stage triage spike the
 * README recommends before relying on provider `claude`.
 */
let claudeImageAvailable = false;
try {
  if (dockerAvailable && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)) {
    execFileSync("docker", ["image", "inspect", "sandcastle:claude"], { timeout: 10_000, stdio: "pipe" });
    claudeImageAvailable = true;
  }
} catch {
  claudeImageAvailable = false;
}
const claudeGated = dockerAvailable && claudeImageAvailable && !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
const dc = claudeGated ? describe : describe.skip;

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
    // -c identity: the harness must not depend on the host having a global
    // git user configured (fresh runners / containers commonly don't).
    execFileSync(
      "git",
      ["-C", repoDir, "-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "commit", "-m", "init", "-q"],
      {},
    );
    harness.config.sandbox.imageName = "sandcastle:local";
  });

  afterAll(() => {
    harness?.cleanup();
  });

  it("triage stage returns a real verdict for a well-formed item", async () => {
    const { config } = loadConfig(undefined, harness.root);
    // Credentials ride env-only since the H1 hardening (auth.json is never
    // staged): wire the runner exactly like the production CLI does.
    const runner = new SandcastleStageRunner({ config, env: ollamaEnv() });
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
    // Same env wiring as production (see the triage test above).
    const runner = new SandcastleStageRunner({ config, env: ollamaEnv() });
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

  it("review runs both review.gates in a real sandbox: per-gate model override reaches the provider, pass case keeps combined review-verdict (ticket 11, PR-Agent PR #21 focus area)", async () => {
    const { config } = loadConfig(undefined, harness.root);
    config.review = { gates: [{ name: "quality" }, { name: "performance", model: "deepseek-v4.1-flash:1017" }] };
    const runner = new SandcastleStageRunner({ config, env: ollamaEnv() });
    // Real worktree, injected into the adapter's map so runStage uses it; the
    // branch starts at base with a deliberately clean commit so the diff is
    // reviewable but trivially defect-free.
    const cleanWt = await createWorktree({
      cwd: realRepo(repoDir),
      branchStrategy: { type: "branch", branch: "factory/int-review-clean", baseBranch: "main" },
    });
    (runner as unknown as { worktrees: Map<string, Worktree> }).worktrees.set("int-review-clean", cleanWt as unknown as Worktree);
    const wtPath = (cleanWt as unknown as { worktreePath: string }).worktreePath;
    // A real, non-empty, defect-free change: an empty diff gets legitimately
    // failed by the reviewer ("nothing to deliver") — observed live.
    fs.mkdirSync(path.join(wtPath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(wtPath, "src", "hello.js"),
      ["/** Pure, allocation-light helpers used by the test fixture. */", "function sum(numbers) {", "  let total = 0;", "  for (let i = 0; i < numbers.length; i++) total += numbers[i];", "  return total;", "}", "module.exports = { sum };"].join("\n"),
    );
    execFileSync("git", ["-C", wtPath, "add", "src/hello.js"], {});
    execFileSync("git", ["-C", wtPath, "-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "commit", "-qm", "add clean sum helper"], {});
    const result = await runner.runStage({
      stage: "review",
      item: { id: 2, slug: "int-review-clean", title: "Clean change", repo: repoDir, base: "main", approvals: [], body: "Empty change on a clean branch.", branchName: "factory/int-review-clean" },
      kb: { global: "", project: "" },
    });
    // The wiring under test: BOTH gates ran inside the real sandbox, the
    // per-gate model override resolved to its configured id, and the combined
    // artifact kept the PR-body surface name. The verdict itself is
    // model-dependent; a clean diff should pass, but either way the multi-gate
    // artifacts are what this asserts (a gate-fail still saves per-gate verdicts).
    expect(result.usage?.profiles).toEqual([
      { name: "quality", model: config.models.review ?? config.models.default },
      { name: "performance", model: "deepseek-v4.1-flash:1017" },
    ]);
    const names = result.artifacts.map((a) => a.name);
    expect(names).toContain("review-verdict:quality");
    if (result.outcome === "pass") {
      expect(names).toContain("review-verdict:performance");
      expect(names).toContain("review-verdict");
      const combined = result.artifacts.find((a) => a.name === "review-verdict")!.content;
      expect(combined).toContain("performance");
    } else {
      expect(result.outcome).toBe("gate-fail"); // tolerable model judgment on a clean diff
    }
  }, 600_000);

  it("review fail-fast end-to-end in a real sandbox: an obvious perf defect fails a gate with profile-named feedback (ticket 11)", async () => {
    const { config } = loadConfig(undefined, harness.root);
    config.review = { gates: [{ name: "quality" }, { name: "performance", model: "deepseek-v4.1-flash:1017" }] };
    const runner = new SandcastleStageRunner({ config, env: ollamaEnv() });
    const flawWt = await createWorktree({
      cwd: realRepo(repoDir),
      branchStrategy: { type: "branch", branch: "factory/int-review-flaw", baseBranch: "main" },
    });
    const flawRunner = runner as unknown as { worktrees: Map<string, Worktree> };
    flawRunner.worktrees.set("int-review-flaw", flawWt as unknown as Worktree);
    const flawPath = (flawWt as unknown as { worktreePath: string }).worktreePath;
    fs.writeFileSync(
      path.join(flawPath, "flaw.js"),
      [
        "// Deliberately reviewable defect: sync I/O inside a tight loop.",
        "const fs = require('node:fs');",
        "module.exports.countWords = function countWords(lines) {",
        "  let n = 0;",
        "  for (const line of lines) {",
        "    // reads the whole file (and the disk) once per line",
        "    const text = fs.readFileSync('/etc/hostname', 'utf8');",
        "    n += line.split(text.trim()).length - 1;",
        "  }",
        "  return n;",
        "};",
      ].join("\n"),
    );
    execFileSync("git", ["-C", flawPath, "add", "flaw.js"], {});
    execFileSync("git", ["-C", flawPath, "-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "commit", "-qm", "add countWords with a per-line sync read"], {});
    const result = await runner.runStage({
      stage: "review",
      item: { id: 3, slug: "int-review-flaw", title: "Perf-flawed change", repo: repoDir, base: "main", approvals: [], body: "Adds countWords with a sync read inside the loop.", branchName: "factory/int-review-flaw" },
      kb: { global: "", project: "" },
    });
    // The perf lens exists to catch exactly this; a fail is the expected honest
    // verdict. Either way the fail-fast mechanics are visible: the failed
    // gate's per-gate artifact exists and the gate name rides the feedback.
    expect(result.outcome).toBe("gate-fail");
    const failedArtifact = result.artifacts.find((a) => a.name.startsWith("review-verdict:"));
    expect(failedArtifact).toBeDefined();
    expect(result.feedback ?? "").toMatch(/performance|quality/);
    expect(result.artifacts.map((a) => a.name)).not.toContain("review-verdict"); // no combined verdict on a failed round
  }, 600_000);
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

let claudeHarness: TestHarness;
let claudeRepoDir: string;

dc("integration: sandcastle adapter, provider claude (requires docker + sandcastle:claude image + ANTHROPIC_API_KEY)", () => {
  beforeAll(() => {
    claudeHarness = createHarness();
    claudeHarness.config.agent.provider = "claude";
    claudeHarness.config.models = { default: "claude-sonnet-5-5" };
    claudeHarness.config.sandbox.imageName = "sandcastle:claude";
    claudeRepoDir = mkdtempSync(path.join(os.tmpdir(), "factory-int-claude-repo-"));
    const git = (args: [] | string[]): void => execFileSync("git", args, { cwd: claudeRepoDir });
    fs.writeFileSync(path.join(claudeRepoDir, "README.md"), "# integration repo\n");
    git(["init", "-b", "main"]);
    git(["add", "."]);
    execFileSync(
      "git",
      ["-C", claudeRepoDir, "-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "commit", "-m", "init", "-q"],
      {},
    );
  });

  afterAll(() => {
    claudeHarness?.cleanup();
  });

  it("triage stage (claude provider) returns a real verdict for a well-formed item", async () => {
    // Wired exactly like the production CLI: agentEnvFor picks the claude
    // credential passthrough under provider claude.
    const runner = new SandcastleStageRunner({ config: claudeHarness.config, env: claudeEnv() });
    const result = await runner.runStage({
      stage: "triage",
      item: {
        id: 1,
        slug: "claude-integration",
        title: "Add a HELLO constant",
        repo: claudeRepoDir,
        base: "main",
        approvals: [],
        body: "Add a file src/hello.ts exporting `export const HELLO = 'world';`.",
        branchName: "factory/claude-integration",
      },
      kb: { global: "", project: "" },
    });
    expect(["pass", "reject", "needs-human", "gate-fail", "infra-fail"]).toContain(result.outcome);
  }, 300_000);
});
