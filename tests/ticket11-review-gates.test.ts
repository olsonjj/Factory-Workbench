import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Ticket 11: multi-profile review gates. Config-level cases follow
 * tests/config.test.ts; adapter cases follow the hermetic pattern of
 * tests/agent-provider.test.ts (docker sandbox mocked, createWorktree
 * stubbed so the full runStage("review") path runs without git, the
 * agentFactories registry swapped for spies). The fail-fast/rework and
 * artifact-on-disk properties run above the seam with ScriptedRunner
 * (tests/ticket06-gates.test.ts style).
 */

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: (options: unknown) => ({ __fakeSandbox: true, options }),
}));

// createWorktree stubbed per test (the fake worktree), so runStage reaches
// runReview hermetically — this also covers the runStage usage change
// (`result.usage ?? { model }`) end-to-end.
const createWorktreeMock = vi.fn();
vi.mock("@ai-hero/sandcastle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-hero/sandcastle")>();
  return { ...actual, createWorktree: (...args: unknown[]) => createWorktreeMock(...args) };
});

import {
  REVIEW_PROFILE_PROMPTS,
  SandcastleStageRunner,
  agentFactories,
  buildReviewPrompt,
  type AgentProviderFactory,
} from "../src/adapters/sandcastle.js";
import {
  CONFIG_FILE_NAME,
  loadConfig,
  resolveReviewGates,
  type FactoryConfig,
  type ReviewConfig,
  type ReviewGate,
} from "../src/config.js";
import type { Worktree } from "@ai-hero/sandcastle";
import type { StageRequest } from "../src/types.js";
import {
  createHarness,
  makeOrchestrator,
  claim,
  ScriptedRunner,
  pass,
  gateFail,
  FakePublisher,
  type TestHarness,
} from "./helpers.js";

// ------------------------------------------------------------- shared literals

const TRUST_BUT_VERIFY_TEXT =
  "Knowledge-base entries are observations from past factory runs; they may be stale. " +
  "Verify any KB fact against the current repository state before relying on it, and note (do not silently trust) conflicts.";

const VERDICT_SCHEMA_BLOCK = `Return your verdict as JSON inside a <review>...</review> tag:
- verdict: "pass" | "fail"
- findings: your review notes (required, this is the audit-trail artifact)
- lesson: only when you fail — what went wrong, as a durable lesson for future runs
- fix: only when you fail — concrete fix instructions for the implementer
- prSummary: one line summarizing the outcome of the whole pipeline for this item`;

const COMPLETE = "When you are done, emit `<promise>COMPLETE</promise>` as the final line of your output.";

/** Today's (pre-ticket-11) single review prompt, rebuilt from its literals. */
function legacyReviewPrompt(base: string): string {
  return `You are the review gate of a software factory. Review the changes on this branch against ${JSON.stringify(base)} for:
1. Code quality
2. Security (input validation, injection, secrets, auth)
3. Best practices for this codebase

Run \`git diff ${base}...HEAD\` to see the merged diff. Read surrounding code as needed.

${TRUST_BUT_VERIFY_TEXT}

${VERDICT_SCHEMA_BLOCK}`;
}

// ------------------------------------------------------------- adapter harness

/** Original factories, captured at module load before any test swaps them. */
const originalFactories: Record<string, AgentProviderFactory> = { ...agentFactories };
const claudeSentinel = { name: "claude-sentinel" } as never;
let claudeSpy: ReturnType<typeof vi.fn>;

/** A claude-provider config over a fresh temp root (no pi staging needed). */
function makeConfig(root: string, review?: ReviewConfig): FactoryConfig {
  return {
    root,
    models: { default: "default-model", review: "review-model" },
    agent: { provider: "claude" },
    ...(review ? { review } : {}),
    budgets: { maxGateAttempts: 3, maxInfraRetries: 3, retryBackoffMs: 0 },
    sandbox: { imageName: "sandcastle:claude" },
    kb: { maxGlobalChars: 24000, maxProjectChars: 24000 },
  };
}

function reviewReq(base = "main"): StageRequest {
  return {
    stage: "review",
    item: {
      id: 1,
      slug: "t11",
      title: "Ticket 11 item",
      repo: "/tmp/repo",
      base,
      approvals: [],
      body: "Make the gates.",
      branchName: "factory/t11",
    },
    kb: { global: "", project: "" },
  };
}

interface FakeRunOptions {
  prompt: string;
  agent: unknown;
  maxIterations: number;
}

function fakeWorktree(): { wt: Worktree; run: ReturnType<typeof vi.fn>; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-t11-wt-"));
  // Root package.json → sandboxReadyHooksFor fires; the fake run ignores it.
  fs.writeFileSync(path.join(dir, "package.json"), '{ "name": "wt" }');
  const run = vi.fn(async (_opts: unknown): Promise<{ iterations: unknown[]; stdout: string }> => ({
    iterations: [{}],
    stdout: "",
  }));
  const wt = { worktreePath: dir, run } as unknown as Worktree;
  return { wt, run, dir };
}

const passVerdict = (findings: string, prSummary?: string): string =>
  `<review>${JSON.stringify({ verdict: "pass", findings, ...(prSummary ? { prSummary } : {}) })}</review>`;
const failVerdict = (findings: string, fix?: string, lesson?: string): string =>
  `<review>${JSON.stringify({ verdict: "fail", findings, ...(fix ? { fix } : {}), ...(lesson ? { lesson } : {}) })}</review>`;

const tempDirs: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-t11-"));
  tempDirs.push(root);
  return root;
}

let wtFixture: ReturnType<typeof fakeWorktree>;

beforeEach(() => {
  claudeSpy = vi.fn(() => claudeSentinel);
  agentFactories.claude = claudeSpy as unknown as AgentProviderFactory;
  wtFixture = fakeWorktree();
  createWorktreeMock.mockReset();
  createWorktreeMock.mockImplementation(async () => wtFixture.wt);
});

afterEach(() => {
  agentFactories.claude = originalFactories.claude!;
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const promptOf = (call: number): string =>
  (wtFixture.run.mock.calls[call]![0] as FakeRunOptions).prompt;

// ------------------------------------------------------------- config level

describe("ticket 11: review-gate config", () => {
  it("resolveReviewGates: implicit single quality gate without a review key; explicit gates verbatim", () => {
    expect(resolveReviewGates({})).toEqual([{ name: "quality" }]);
    expect(resolveReviewGates({ review: undefined })).toEqual([{ name: "quality" }]);
    const gates: ReviewGate[] = [{ name: "performance", model: "perf-model", extraInstructions: "e" }];
    expect(resolveReviewGates({ review: { gates } })).toEqual(gates);
  });

  it("loadConfig accepts a valid multi-gate review block", () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      JSON.stringify({
        review: {
          gates: [
            { name: "quality" },
            { name: "performance", model: "deepseek-v4.1-flash:1017", extraInstructions: "Watch the hot paths." },
          ],
        },
      }),
      "utf8",
    );
    const { config } = loadConfig(root);
    expect(config.review?.gates).toHaveLength(2);
    expect(config.review?.gates[1]).toEqual({
      name: "performance",
      model: "deepseek-v4.1-flash:1017",
      extraInstructions: "Watch the hot paths.",
    });
  });

  it("loadConfig throws on duplicate gate names, naming the config file", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    fs.writeFileSync(
      configFile,
      JSON.stringify({ review: { gates: [{ name: "performance" }, { name: "quality" }, { name: "performance" }] } }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/invalid factory config/);
    expect(() => loadConfig(root)).toThrow(/review\.gates: duplicate gate name "performance"/);
    expect(() => loadConfig(root)).toThrow(configFile);
  });

  it("loadConfig throws on an empty gate list", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, CONFIG_FILE_NAME), JSON.stringify({ review: { gates: [] } }), "utf8");
    expect(() => loadConfig(root)).toThrow(/invalid factory config/);
    expect(() => loadConfig(root)).toThrow(/review\.gates/);
  });

  it("loadConfig throws on an empty gate name", () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      JSON.stringify({ review: { gates: [{ name: "quality" }, { name: "" }] } }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/invalid factory config/);
    expect(() => loadConfig(root)).toThrow(/review\.gates/);
  });

  it("loadConfig throws on gate names that are not path-safe: '/', '..', a newline", () => {
    // Gate names are interpolated into artifact filenames
    // (`review-verdict:<name>`), so the schema must reject path separators,
    // traversal segments, and control characters — non-empty is not enough
    // (KB lesson 2026-11-02 22:31). Rejected even under valid-looking lists.
    for (const bad of ["qua/lity", "..", "quality\nshadow", "Quality", "-lead", "trail-"] as const) {
      const root = tmpRoot();
      fs.writeFileSync(
        path.join(root, CONFIG_FILE_NAME),
        JSON.stringify({ review: { gates: [{ name: bad }] } }),
        "utf8",
      );
      expect(() => loadConfig(root)).toThrow(/invalid factory config/);
      expect(() => loadConfig(root)).toThrow(/gate name must be lowercase alphanumeric with single hyphens/);
    }
    // Hyphenated lowercase names are the legal custom form.
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      JSON.stringify({ review: { gates: [{ name: "data-migrations" }] } }),
      "utf8",
    );
    expect(loadConfig(root).config.review?.gates[0]?.name).toBe("data-migrations");
  });

  it("provider claude: rejects a non-Claude per-gate model, accepts a gate without a model", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        agent: { provider: "claude" },
        review: { gates: [{ name: "quality" }, { name: "performance", model: "glm-5.3-flash" }] },
      }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/review\.gates\[1\] \("performance"\): "glm-5\.3-flash"/);
    expect(() => loadConfig(root)).toThrow(configFile);

    // Omitting per-gate model is legal under claude: the gate resolves at
    // runtime from models.review (claude defaults, already validated).
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        agent: { provider: "claude" },
        review: { gates: [{ name: "quality" }, { name: "performance", model: "claude-haiku-5-5" }] },
      }),
      "utf8",
    );
    const { config } = loadConfig(root);
    expect(config.review?.gates[1]?.model).toBe("claude-haiku-5-5");
  });
});

// ------------------------------------------------------------- built-in lenses

describe("ticket 11: REVIEW_PROFILE_PROMPTS built-in lens bodies", () => {
  it("quality reproduces the three legacy axes; performance is the Workbench perf lens", () => {
    expect(Object.keys(REVIEW_PROFILE_PROMPTS)).toContain("quality");
    expect(Object.keys(REVIEW_PROFILE_PROMPTS)).toContain("performance");
    expect(REVIEW_PROFILE_PROMPTS.quality).toContain(
      "You are the review gate of a software factory. Review the changes on this branch against",
    );
    expect(REVIEW_PROFILE_PROMPTS.quality).toContain("1. Code quality");
    expect(REVIEW_PROFILE_PROMPTS.quality).toContain("2. Security (input validation, injection, secrets, auth)");
    expect(REVIEW_PROFILE_PROMPTS.quality).toContain("3. Best practices for this codebase");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("for PERFORMANCE problems:");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("better-sqlite3 prepared statements recreated per call");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("queries inside loops");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("Transaction scope");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("Synchronous I/O and blocking work on the host event loop");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("inbox");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("KB loading");
    expect(REVIEW_PROFILE_PROMPTS.performance).toContain("watch change detection");
    // Both lens bodies carry the base interpolation tokens the composer fills
    // (JSON-quoted in the intro, raw in the git-diff command).
    for (const body of [REVIEW_PROFILE_PROMPTS.quality!, REVIEW_PROFILE_PROMPTS.performance!]) {
      expect(body).toContain("__REVIEW_BASE_JSON__");
      expect(body).toContain("__REVIEW_BASE__");
      expect(body).toContain("Run `git diff __REVIEW_BASE__...HEAD` to see the merged diff. Read surrounding code as needed.");
    }
  });

  it("buildReviewPrompt substitutes the base in ONE pass: a base containing the raw token is not re-substituted", () => {
    // Regression (rework fix): with chained replaceAll calls, the first pass
    // inserted JSON.stringify(base) and the second pass re-matched the raw
    // token INSIDE that inserted JSON form, corrupting the quoted base.
    const base = 'evil"__REVIEW_BASE__';
    const prompt = buildReviewPrompt({ name: "quality" }, base);
    // Byte-exact against the legacy template built from its literals: the
    // intro carries the JSON-quoted base exactly once, the diff line the raw base.
    expect(prompt).toBe(legacyReviewPrompt(base));
    expect(prompt).toContain(`against ${JSON.stringify(base)} for:`);
    expect(prompt).toContain(`Run \`git diff ${base}...HEAD\` to see the merged diff. Read surrounding code as needed.`);
    // The inserted JSON form survived intact (no second-pass corruption).
    expect(prompt).toContain(JSON.stringify(base));
    // Same property for the generic-lens fallback.
    const generic = buildReviewPrompt({ name: "migrations", extraInstructions: "Check FKs." }, base);
    expect(generic).toContain(`against ${JSON.stringify(base)} for a general quality pass`);
    expect(generic).toContain(`Run \`git diff ${base}...HEAD\``);
  });
});

// ------------------------------------------------------------- adapter level

describe("ticket 11: SandcastleStageRunner review gates (hermetic)", () => {
  it("no review key: one implicit quality gate on models.review, byte-identical legacy prompt, legacy artifacts/usage", async () => {
    const root = tmpRoot();
    const runner = new SandcastleStageRunner({ config: makeConfig(root), env: {} });
    expect(resolveReviewGates(makeConfig(root))).toEqual([{ name: "quality" }]);
    wtFixture.run
      .mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("all good", "pipeline done") });
    const result = await runner.runStage(reviewReq());

    // Exactly one invocation, on models.review.
    expect(wtFixture.run).toHaveBeenCalledTimes(1);
    expect(claudeSpy).toHaveBeenCalledTimes(1);
    expect(claudeSpy.mock.calls[0]![0]).toBe("review-model");

    // Byte-identical prompt: the legacy template + the COMPLETE trailer.
    expect(promptOf(0)).toBe(`${legacyReviewPrompt("main")}\n\n${COMPLETE}`);

    // Legacy result shape: single review-verdict artifact, no report,
    // usage deep-equal { model } with no profiles key.
    expect(result.outcome).toBe("pass");
    expect(result.artifacts).toEqual([{ name: "review-verdict", content: "all good" }]);
    expect(result.report).toBeUndefined();
    expect(result.prSummary).toBe("pipeline done");
    expect(result.usage).toEqual({ model: "review-model" });
    expect(result.usage).not.toHaveProperty("profiles");
    expect(typeof result.durationMs).toBe("number");
  });

  it("gates without a model fall back to models.review; a gate's explicit model wins (config order)", async () => {
    const root = tmpRoot();
    const config = makeConfig(root, {
      gates: [{ name: "quality" }, { name: "performance", model: "perf-model" }],
    });
    const runner = new SandcastleStageRunner({ config, env: {} });
    wtFixture.run
      .mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("q ok") })
      .mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("p ok") });
    const result = await runner.runStage(reviewReq());

    expect(wtFixture.run).toHaveBeenCalledTimes(2);
    expect(claudeSpy.mock.calls.map((c) => c[0])).toEqual(["review-model", "perf-model"]);
    // Lens prompts in config order.
    expect(promptOf(0)).toContain("1. Code quality");
    expect(promptOf(0)).not.toContain("PERFORMANCE problems");
    expect(promptOf(1)).toContain("for PERFORMANCE problems:");
    expect(result.outcome).toBe("pass");
  });

  it("a single explicitly-configured gate (any name) keeps the legacy single-gate shape", async () => {
    const root = tmpRoot();
    const config = makeConfig(root, { gates: [{ name: "performance" }] });
    const runner = new SandcastleStageRunner({ config, env: {} });
    wtFixture.run.mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("p ok") });
    const result = await runner.runStage(reviewReq());

    expect(wtFixture.run).toHaveBeenCalledTimes(1);
    expect(result.artifacts).toEqual([{ name: "review-verdict", content: "p ok" }]);
    expect(result.usage).toEqual({ model: "review-model" });
    expect(result.usage).not.toHaveProperty("profiles");
  });

  it("two-gate full pass: both prompts in order, per-gate + combined artifacts, usage.profiles, dedup-able report", async () => {
    const root = tmpRoot();
    const config = makeConfig(root, {
      gates: [
        { name: "quality" },
        { name: "performance", model: "perf-model", extraInstructions: "Focus on the watch loop." },
      ],
    });
    const runner = new SandcastleStageRunner({ config, env: {} });
    wtFixture.run
      .mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("quality findings", "q summary") })
      .mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("perf findings", "p summary") });
    const result = await runner.runStage(reviewReq());

    expect(wtFixture.run).toHaveBeenCalledTimes(2);
    expect(promptOf(0)).toContain("1. Code quality");
    expect(promptOf(1)).toContain("for PERFORMANCE problems:");
    expect(promptOf(1)).toContain("Focus on the watch loop.");

    // Artifacts: per-gate verdicts in order, combined review-verdict last.
    const combined =
      '# review profile "quality"\n\nquality findings\n\n# review profile "performance"\n\nperf findings';
    expect(result.artifacts).toEqual([
      { name: "review-verdict:quality", content: "quality findings" },
      { name: "review-verdict:performance", content: "perf findings" },
      { name: "review-verdict", content: combined },
    ]);
    // report equals the combined artifact content → saveArtifacts' dedup
    // check suppresses the duplicate <stage>-report.md (asserted on disk
    // below the seam in the pipeline-level case).
    expect(result.report).toBe(combined);
    // prSummary comes from the LAST gate.
    expect(result.prSummary).toBe("p summary");
    // usage: first gate's model + per-gate profiles.
    expect(result.usage).toEqual({
      model: "review-model",
      profiles: [
        { name: "quality", model: "review-model" },
        { name: "performance", model: "perf-model" },
      ],
    });
  });

  it("a failing later gate short-circuits: earlier artifacts kept, later gates never invoked, profile named in feedback", async () => {
    const root = tmpRoot();
    const config = makeConfig(root, {
      gates: [
        { name: "quality" },
        { name: "performance", model: "perf-model" },
        { name: "migrations" }, // must NEVER run
      ],
    });
    const runner = new SandcastleStageRunner({ config, env: {} });
    wtFixture.run
      .mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("quality findings") })
      .mockResolvedValueOnce({
        iterations: [{}],
        stdout: failVerdict("hot path churns", "hoist the prepared statement", "perf lesson"),
      });
    const result = await runner.runStage(reviewReq());

    // Fail fast: quality + performance ran, migrations never invoked.
    expect(wtFixture.run).toHaveBeenCalledTimes(2);
    expect(promptOf(0)).toContain("1. Code quality");
    expect(promptOf(1)).toContain("for PERFORMANCE problems:");

    // Earlier passing gates' verdicts are preserved; no combined artifact.
    expect(result.outcome).toBe("gate-fail");
    expect(result.artifacts).toEqual([
      { name: "review-verdict:quality", content: "quality findings" },
      { name: "review-verdict:performance", content: "hot path churns" },
    ]);
    expect(result.artifacts.some((a) => a.name === "review-verdict")).toBe(false);
    // report content-equals the failed gate's artifact → no extra report file.
    expect(result.report).toBe("hot path churns");
    // The profile name travels to implement as fix instructions.
    expect(result.feedback).toBe('review profile "performance" failed the review gate:\nhoist the prepared statement');
    expect(result.lesson).toBe("perf lesson");
    expect(result.fix).toBe("hoist the prepared statement");
    expect(result.usage).toEqual({
      model: "review-model",
      profiles: [
        { name: "quality", model: "review-model" },
        { name: "performance", model: "perf-model" },
      ],
    });
  });

  it("a failing single implicit gate keeps the legacy fail shape with the legacy artifact name", async () => {
    const root = tmpRoot();
    const runner = new SandcastleStageRunner({ config: makeConfig(root), env: {} });
    wtFixture.run.mockResolvedValueOnce({
      iterations: [{}],
      stdout: failVerdict("bad findings", "the fix", "the lesson"),
    });
    const result = await runner.runStage(reviewReq());

    expect(result.outcome).toBe("gate-fail");
    expect(result.artifacts).toEqual([{ name: "review-verdict", content: "bad findings" }]);
    expect(result.report).toBe("bad findings");
    expect(result.feedback).toBe("the fix");
    expect(result.lesson).toBe("the lesson");
    expect(result.fix).toBe("the fix");
    expect(result.usage).toEqual({ model: "review-model" });
    expect(result.usage).not.toHaveProperty("profiles");
  });

  it("gate extraInstructions ride the prompt verbatim under their section header; absent means no section", async () => {
    const root = tmpRoot();
    const config = makeConfig(root, {
      gates: [{ name: "quality", extraInstructions: "Check the widget API for injection." }],
    });
    const runner = new SandcastleStageRunner({ config, env: {} });
    wtFixture.run.mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("ok") });
    await runner.runStage(reviewReq());

    const prompt = promptOf(0);
    expect(prompt).toContain('## Extra instructions from config (profile "quality")\n\nCheck the widget API for injection.');
    // The section sits between the lens body and TRUST_BUT_VERIFY.
    const lensEnd = prompt.indexOf("Read surrounding code as needed.");
    const extraIdx = prompt.indexOf("## Extra instructions");
    const trustIdx = prompt.indexOf(TRUST_BUT_VERIFY_TEXT);
    expect(lensEnd).toBeGreaterThan(-1);
    expect(extraIdx).toBeGreaterThan(lensEnd);
    expect(trustIdx).toBeGreaterThan(extraIdx);

    // Without extraInstructions the implicit prompt has no such section.
    const runner2 = new SandcastleStageRunner({ config: makeConfig(tmpRoot()), env: {} });
    const { run: run2 } = fakeWorktree();
    createWorktreeMock.mockImplementation(async () => ({ worktreePath: ".", run: run2 } as unknown as Worktree));
    run2.mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("ok") });
    await runner2.runStage(reviewReq());
    const prompt2 = (run2.mock.calls[0]![0] as FakeRunOptions).prompt;
    expect(prompt2).not.toContain("Extra instructions from config");
    expect(prompt2).toBe(`${legacyReviewPrompt("main")}\n\n${COMPLETE}`);
  });

  it("an unknown gate name builds the generic-lens fallback, guided by its extraInstructions", async () => {
    const root = tmpRoot();
    const config = makeConfig(root, {
      gates: [{ name: "migrations", extraInstructions: "Check FK constraints and index drops." }],
    });
    const runner = new SandcastleStageRunner({ config, env: {} });
    wtFixture.run.mockResolvedValueOnce({ iterations: [{}], stdout: passVerdict("ok") });
    await runner.runStage(reviewReq());

    const prompt = promptOf(0);
    expect(prompt).toContain('for a general quality pass — focus on what profile "migrations" exists to catch');
    expect(prompt).toContain('## Extra instructions from config (profile "migrations")\n\nCheck FK constraints and index drops.');
    // The shared TRUST_BUT_VERIFY + verdict-schema blocks ride along.
    expect(prompt).toContain(TRUST_BUT_VERIFY_TEXT);
    expect(prompt).toContain(VERDICT_SCHEMA_BLOCK);
    expect(prompt).toContain('git diff main...HEAD');
  });
});

// ------------------------------------------------------------- seam level

describe("ticket 11: multi-gate results above the seam (rework, budget, artifacts on disk)", () => {
  let harness: TestHarness;
  afterEach(() => {
    harness?.cleanup();
  });

  function dropItem(h: TestHarness): void {
    h.inboxFile("task", { title: "Gated widget", repo: "/tmp/repo", base: "main" }, "Make the widget.");
    claim(h);
  }

  it("a multi-gate fail-fast gate-fail routes rework to implement under the shared review budget", async () => {
    harness = createHarness();
    dropItem(harness);
    const feedback = 'review profile "performance" failed the review gate:\nhoist the prepared statement';
    const runner = new ScriptedRunner({
      test: [{ outcome: "pass", artifacts: [] }],
      review: [
        gateFail("review", feedback, {
          artifacts: [
            { name: "review-verdict:quality", content: "quality ok" },
            { name: "review-verdict:performance", content: "hot path churns" },
          ],
          report: "hot path churns",
          lesson: "perf lesson",
          fix: "hoist the prepared statement",
        }),
        pass("review"),
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    // Shared budget keyed on stage review — the whole multi-gate stage is one
    // gate-fail round, not one per lens.
    expect(item.gateAttempts["review"]).toBe(2);
    // Rework routed to implement with the failed profile's feedback.
    const implementCalls = runner.calls.filter((c) => c.req.stage === "implement");
    expect(implementCalls).toHaveLength(2);
    expect(implementCalls[1]!.req.item.feedback).toContain('review profile "performance" failed the review gate');
    expect(implementCalls[1]!.req.item.feedback).toContain("hoist the prepared statement");
    // The failed round's per-gate artifacts are on disk and recorded.
    const names = harness.db.getArtifacts(item.id).map((a) => a.name);
    expect(names).toContain("review-verdict:quality");
    expect(names).toContain("review-verdict:performance");
  });

  it("a multi-gate pass saves per-gate + combined artifacts with no duplicate review-report on disk, and the PR surface works", async () => {
    harness = createHarness();
    dropItem(harness);
    const combined = '# review profile "quality"\n\nquality findings\n\n# review profile "performance"\n\nperf findings';
    const runner = new ScriptedRunner({
      review: [
        pass("review", {
          artifacts: [
            { name: "review-verdict:quality", content: "quality findings" },
            { name: "review-verdict:performance", content: "perf findings" },
            { name: "review-verdict", content: combined },
          ],
          report: combined,
          usage: {
            model: "review-model",
            profiles: [
              { name: "quality", model: "review-model" },
              { name: "performance", model: "perf-model" },
            ],
          },
        }),
      ],
    });
    const fakePublisher = new FakePublisher();
    const orch = makeOrchestrator(harness, runner, { publisher: fakePublisher });
    await orch.resume();

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    // report === the combined artifact's content → saveArtifacts' dedup
    // check suppressed the duplicate <stage>-report.md.
    const artifacts = harness.db.getArtifacts(item.id);
    expect(artifacts.filter((a) => a.name === "review-report")).toHaveLength(0);
    expect(artifacts.some((a) => a.name === "review-verdict:quality")).toBe(true);
    expect(artifacts.filter((a) => a.name === "review-verdict")).toHaveLength(1);
    // History carries usage.profiles verbatim.
    const reviewPass = harness.db
      .getHistory(item.id)
      .find((h) => h.event === "stage-pass" && h.stage === "review");
    expect(reviewPass?.detail.usage).toEqual({
      model: "review-model",
      profiles: [
        { name: "quality", model: "review-model" },
        { name: "performance", model: "perf-model" },
      ],
    });
    // PR body review surface: latest("review-verdict") is the combined verdict.
    const body = fakePublisher.published[0]!.body;
    expect(body).toContain("quality findings");
    expect(body).toContain("review-verdict:quality");
  });
});