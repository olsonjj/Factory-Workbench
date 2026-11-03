import { describe, it, expect, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Ticket 11: multi-profile review gates (quality + performance).
 *
 * Config-resolution tests run pure code. Adapter scenario tests follow the
 * hermetic pattern of tests/agent-provider.test.ts: the sandcastle run is
 * mocked (scripted per-invocation stdout), the provider factory is a spy,
 * and a fake Worktree is injected straight into the adapter's worktree map
 * so runStage needs no real git repo.
 */

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: (options: unknown) => ({ __fakeSandbox: true, options }),
}));

const runMock = vi.fn();
vi.mock("@ai-hero/sandcastle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-hero/sandcastle")>();
  return { ...actual, run: (...args: unknown[]) => runMock(...args) };
});

import { SandcastleStageRunner, agentFactories } from "../src/adapters/sandcastle.js";
import { loadConfig, reviewGateProfiles, reviewUsage } from "../src/config.js";
import type { FactoryConfig } from "../src/config.js";
import type { StageRequest, StageResult } from "../src/types.js";
import type { Worktree } from "@ai-hero/sandcastle";

const originalFactories: Record<string, unknown> = { ...agentFactories };
const claudeSpy = vi.fn(() => ({ name: "claude-sentinel" }) as never);

afterEach(() => {
  Object.assign(agentFactories, originalFactories);
  runMock.mockReset();
  claudeSpy.mockClear();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------- config

function configWith(raw: Partial<FactoryConfig>): FactoryConfig {
  // Minimal valid FactoryConfig literal (as in agent-provider tests).
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "factory-cfg-")),
    models: { default: "claude-sonnet-5-5", review: "claude-opus-5-5" },
    agent: { provider: "pi" },
    budgets: { maxGateAttempts: 3, maxInfraRetries: 3, retryBackoffMs: 0 },
    sandbox: { imageName: "sandcastle:local" },
    kb: { maxGlobalChars: 24000, maxProjectChars: 24000 },
    ...raw,
  } as FactoryConfig;
}

describe("ticket 11: reviewGateProfiles", () => {
  it("a config without a review key resolves one implicit quality gate on models.review", () => {
    const profiles = reviewGateProfiles(configWith({}));
    expect(profiles).toEqual([{ name: "quality", model: "claude-opus-5-5" }]);
  });

  it("gates without explicit models fall back to models.review", () => {
    const profiles = reviewGateProfiles(
      configWith({ review: { gates: [{ name: "quality" }, { name: "performance" }] } }),
    );
    expect(profiles.map((p) => p.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(profiles.map((p) => p.name)).toEqual(["quality", "performance"]);
  });

  it("a gate's explicit model wins over models.review", () => {
    const profiles = reviewGateProfiles(
      configWith({ review: { gates: [{ name: "quality" }, { name: "performance", model: "m-perf" }] } }),
    );
    expect(profiles.map((p) => p.model)).toEqual(["claude-opus-5-5", "m-perf"]);
  });

  it("reviewUsage marks profile attribution only for multi-gate review runs", () => {
    const multi = configWith({ review: { gates: [{ name: "quality" }, { name: "performance", model: "m-perf" }] } });
    expect(reviewUsage(multi)).toEqual({
      model: "claude-opus-5-5",
      profiles: [
        { name: "quality", model: "claude-opus-5-5" },
        { name: "performance", model: "m-perf" },
      ],
    });
    const single = configWith({});
    expect(reviewUsage(single)).toEqual({ model: "claude-opus-5-5" });
  });
});

describe("ticket 11: loadConfig validation of review.gates", () => {
  function writeConfig(root: string, raw: Record<string, unknown>): void {
    fs.writeFileSync(path.join(root, "factory.config.json"), JSON.stringify(raw, null, 2));
  }

  it("rejects duplicate gate names at startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-load-"));
    writeConfig(root, {
      root,
      models: { default: "t", review: "t" },
      review: { gates: [{ name: "quality" }, { name: "quality" }] },
    });
    expect(() => loadConfig(root)).toThrow(/duplicate review gate name.*quality/);
  });

  it("rejects an empty gate list and empty gate names at startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-load-"));
    writeConfig(root, { root, models: { default: "t" }, review: { gates: [] } });
    expect(() => loadConfig(root)).toThrow(/gates/);
    writeConfig(root, { root, models: { default: "t" }, review: { gates: [{ name: "" }] } });
    expect(() => loadConfig(root)).toThrow(/name/);
  });
});

// ------------------------------------------------------------- adapter

const LEGACY_QUALITY_PROMPT_PREFIX =
  "You are the review gate of a software factory. Review the changes on this branch against";

interface Fixture {
  runner: SandcastleStageRunner;
  out: string[];
}

function reviewRequest(repo: string): StageRequest {
  return {
    stage: "review",
    item: {
      id: 1,
      slug: "s",
      title: "t",
      repo,
      base: "main",
      approvals: [],
      body: "make the widget",
      branchName: "wb/s",
    },
    kb: { global: "", project: "" },
  };
}

function fixtureWithConfig(config: FactoryConfig): Fixture {
  const out: string[] = [];
  agentFactories.claude = claudeSpy as never;
  fs.writeFileSync(path.join(config.root, "package.json"), "{}");
  const wt = { worktreePath: config.root, run: runMock } as unknown as Worktree;
  const runner = new SandcastleStageRunner({ config });
  // Inject the fake worktree so runStage skips real git worktree creation.
  (runner as unknown as { worktrees: Map<string, Worktree> }).worktrees.set("s", wt);
  return { runner, out };
}

function verdict(verdictValue: "pass" | "fail", extra: Record<string, unknown> = {}): string {
  // bare JSON — setupScripted supplies the <review>...</review> wrapper
  return JSON.stringify({ verdict: verdictValue, findings: `findings-of-${verdictValue}`, ...extra });
}

describe("ticket 11: adapter multi-gate review execution", () => {
  function setupScripted(fixture: Fixture, results: { tag: string; body: string }[]): void {
    let i = 0;
    runMock.mockImplementation(async (opts: { prompt: string }) => {
      const r = results[i++];
      fixture.out.push(opts.prompt);
      if (!r) throw new Error(`unexpected run #${i}`);
      return { iterations: [{}], stdout: `<${r.tag}>${r.body}</${r.tag}>` } as never;
    });
  }

  it("two gates run in config order; all pass ⇒ per-gate + combined review-verdict artifacts and profile usage", async () => {
    const config = configWith({
      review: { gates: [{ name: "quality" }, { name: "performance", model: "m-perf" }] },
    });
    config.agent.provider = "claude";
    const { runner } = fixtureWithConfig(config);
    setupScripted({ runner, out: [] }, [
      { tag: "review", body: verdict("pass", { prSummary: "clean pass" }) },
      { tag: "review", body: verdict("pass") },
    ]);
    const result: StageResult = await (runner as unknown as { runStage(r: StageRequest): Promise<StageResult> }).runStage(
      reviewRequest(config.root),
    );
    expect(result.outcome).toBe("pass");
    // both prompts ran, quality first, and the performance prompt is the
    // profile-specific lens, not a second copy of the quality prompt
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(fixtureRunPrompts(runner)[0]).toContain("'quality'");
    expect(fixtureRunPrompts(runner)[1]).toContain("performance");
    expect(fixtureRunPrompts(runner)[1]).not.toBe(fixtureRunPrompts(runner)[0]);
    const names = result.artifacts.map((a) => a.name);
    expect(names).toContain("review-verdict:quality");
    expect(names).toContain("review-verdict:performance");
    expect(names).toContain("review-verdict");
    expect(result.prSummary).toBe("clean pass");
    expect(result.usage?.profiles).toEqual([
      { name: "quality", model: "claude-opus-5-5" },
      { name: "performance", model: "m-perf" },
    ]);
  });

  it("a failing performance gate short-circuits, names the profile in feedback, and skips later profiles", async () => {
    const config = configWith({
      review: {
        gates: [{ name: "quality" }, { name: "performance" }, { name: "custom-lens" }],
      },
    });
    config.agent.provider = "claude";
    const { runner } = fixtureWithConfig(config);
    setupScripted({ runner, out: [] }, [
      { tag: "review", body: verdict("pass") },
      { tag: "review", body: verdict("fail", { fix: "batch the sqlite writes into one transaction" }) },
    ]);
    const result = await (runner as unknown as { runStage(r: StageRequest): Promise<StageResult> }).runStage(
      reviewRequest(config.root),
    );
    expect(result.outcome).toBe("gate-fail");
    expect(runMock).toHaveBeenCalledTimes(2); // fail fast: custom-lens never ran
    expect(result.feedback).toContain("'performance'");
    expect(result.feedback).toContain("batch the sqlite writes");
    expect(result.artifacts.map((a) => a.name)).toContain("review-verdict:performance");
    expect(result.artifacts.map((a) => a.name)).not.toContain("review-verdict");
  });

  it("the default (no review key) path is byte-identical: one invocation, legacy prompt text, legacy artifact name, no profiles in usage", async () => {
    const config = configWith({});
    config.agent.provider = "claude";
    const { runner } = fixtureWithConfig(config);
    setupScripted({ runner, out: [] }, [{ tag: "review", body: verdict("pass") }]);
    const result = await (runner as unknown as { runStage(r: StageRequest): Promise<StageResult> }).runStage(
      reviewRequest(config.root),
    );
    expect(result.outcome).toBe("pass");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(fixtureRunPrompts(runner)[0]).toContain(LEGACY_QUALITY_PROMPT_PREFIX);
    expect(result.artifacts.map((a) => a.name)).toEqual(["review-verdict"]);
    expect(result.usage).toMatchObject({ model: "claude-opus-5-5" });
    expect(result.usage?.profiles).toBeUndefined();
  });

  it("gate extraInstructions from config reach the review prompt", async () => {
    const config = configWith({
      review: {
        gates: [{ name: "quality", extraInstructions: "Spec drift in specs/*.md without a same-commit update is a blocker." }],
      },
    });
    config.agent.provider = "claude";
    const { runner } = fixtureWithConfig(config);
    setupScripted({ runner, out: [] }, [{ tag: "review", body: verdict("pass") }]);
    await (runner as unknown as { runStage(r: StageRequest): Promise<StageResult> }).runStage(reviewRequest(config.root));
    expect(fixtureRunPrompts(runner)[0]).toContain("Spec drift in specs/*.md");
  });
});

/** The exact prompts the adapter handed to wt.run, via the run mock's calls. */
function fixtureRunPrompts(_runner: SandcastleStageRunner): string[] {
  return runMock.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
}