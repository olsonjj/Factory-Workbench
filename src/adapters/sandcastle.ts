import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { createWorktree, pi, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { Worktree, RunResult } from "@ai-hero/sandcastle";

/** Read a structured-output payload from a run result. */
function outputOf<T>(result: RunResult): T {
  return (result as unknown as { output: T }).output;
}
import { modelFor, type FactoryConfig } from "../config.js";
import type { ItemContext, KbSnapshot, StageRequest, StageResult, StageRunner, CuratorRequest, CuratorRunner } from "../types.js";

/**
 * The real StageRunner implementation below the seam: every agent stage runs
 * as `pi` inside a Sandcastle Docker (OrbStack-compatible) sandbox bound to a
 * git worktree of the target repo. Nothing above the seam knows any of this.
 */

const TriageVerdict = z.object({
  outcome: z.enum(["proceed", "reject", "needs-human"]),
  report: z.string(),
  questions: z.array(z.string()).optional(),
});

const TestVerdict = z.object({
  testsPassed: z.boolean(),
  report: z.string(),
  lesson: z.string().optional(),
  fix: z.string().optional(),
});

const ReviewVerdict = z.object({
  verdict: z.enum(["pass", "fail"]),
  findings: z.string(),
  lesson: z.string().optional(),
  fix: z.string().optional(),
  prSummary: z.string().optional(),
});

const COMPLETE = "When you are done, emit `<promise>COMPLETE</promise>` as the final line of your output.";

const TRUST_BUT_VERIFY =
  "Knowledge-base entries are observations from past factory runs; they may be stale. " +
  "Verify any KB fact against the current repository state before relying on it, and note (do not silently trust) conflicts.";

interface WtRunOptionsOutput {
  output?: { tag: string; [k: string]: unknown };
}
interface SandcastleRunnerDeps {
  config: FactoryConfig;
  /** Extra env injected into the sandbox pi process (e.g. OLLAMA_API_KEY). */
  env?: Record<string, string>;
}

export class SandcastleStageRunner implements StageRunner {
  private readonly config: FactoryConfig;
  private readonly env: Record<string, string>;
  private readonly worktrees = new Map<string, Worktree>();

  constructor(deps: SandcastleRunnerDeps) {
    this.config = deps.config;
    this.env = deps.env ?? {};
  }

  async runStage(req: StageRequest): Promise<StageResult> {
    const started = Date.now();
    const model = modelFor(this.config.models, req.stage);
    const wt = await this.worktreeFor(req.item);
    const result = await this.dispatch(req, model, wt);
    return { ...result, durationMs: Date.now() - started, usage: { model } };
  }

  private async dispatch(req: StageRequest, model: string, wt: Worktree): Promise<StageResult> {
    switch (req.stage) {
      case "triage":
        return this.runTriage(req, model);
      case "spec":
        return this.runSpec(req, model, wt);
      case "implement":
        return this.runImplement(req, model, wt);
      case "test":
        return this.runTest(req, model, wt);
      case "review":
        return this.runReview(req, model, wt);
      case "pr":
        throw new Error("PR stage is not an agent stage");
    }
  }

  private async worktreeFor(item: ItemContext): Promise<Worktree> {
    const existing = this.worktrees.get(item.slug);
    if (existing) return existing;
    const wt = await createWorktree({
      cwd: item.repo,
      branchStrategy: { type: "branch", branch: item.branchName, baseBranch: item.base },
    });
    this.worktrees.set(item.slug, wt);
    return wt;
  }

  private async wtRun(opts: {
    wt: Worktree;
    model: string;
    prompt: string;
    output?: unknown;
  }): Promise<RunResult> {
    const { wt, model, prompt, output } = opts;
    return wt.run({
      agent: pi(model, { env: this.env }),
      sandbox: docker({ imageName: this.config.sandbox.imageName }),
      prompt: [prompt, COMPLETE].join("\n\n"),
      maxIterations: 1,
      ...(output !== undefined ? { output } : {}),
    } as Parameters<typeof wt.run>[0]);
  }

  // ------------------------------------------------------------- stages

  private async runTriage(req: StageRequest, model: string): Promise<StageResult> {
    const kbBlock = req.kb.global
      ? `## Lessons from past factory work (verify against your judgement)\n\n${req.kb.global}`
      : "(no knowledge base entries yet)";
    const prompt = `You are the triage stage of a software factory. Decide whether this work item can be picked up by an autonomous implementation agent.

Return your verdict as JSON inside a <triage>...</triage> tag with fields:
- outcome: "proceed" | "reject" | "needs-human"
- report: your reasoning, concise but complete
- questions: only when outcome is needs-human — the specific questions a human must answer

Reject only for clear-cut reasons: dangerous/destructive work, work for the wrong audience, or tasks you are certain no coding agent could meaningfully do. If the task is ambiguous in a way that would change WHAT to build, choose needs-human. Otherwise proceed.

${TRUST_BUT_VERIFY}

## Item: ${req.item.title}

${req.item.body}

## Knowledge base

${kbBlock}`;

    const result = await this.wtRun({
      wt: await this.worktreeFor(req.item),
      model,
      prompt,
      output: Output.object({ tag: "triage", schema: TriageVerdict }),
    });
    const v = outputOf<z.infer<typeof TriageVerdict>>(result);
    if (v.outcome === "reject") {
      return { outcome: "reject", artifacts: [{ name: "triage-report", content: v.report }], report: v.report };
    }
    if (v.outcome === "needs-human") {
      return {
        outcome: "needs-human",
        artifacts: [{ name: "triage-questions", content: (v.questions ?? []).map((q) => `- ${q}`).join("\n") }],
        questions: v.questions ?? [],
        report: v.report,
      };
    }
    return { outcome: "pass", artifacts: [{ name: "triage-report", content: v.report }] };
  }

  private async runSpec(req: StageRequest, model: string, wt: Worktree): Promise<StageResult> {
    const prompt = `You are the spec stage of a software factory. You are inside a git worktree of the target repository. Produce a precise, grounded implementation spec for the work item.

Rules:
- Codebase-only: do not use the network.
- Ground every claim in actual repository files; reference concrete paths.
- The spec should be complete enough that an implementer never needs to guess.
${TRUST_BUT_VERIFY}

Return the spec markdown inside a <spec>...</spec> tag.

## Item: ${req.item.title}

${req.item.body}
${req.item.feedback ? `\n## Operator feedback to incorporate\n\n${req.item.feedback}\n` : ""}
## Knowledge base

Global:
${req.kb.global || "(none)"}

Project:
${req.kb.project || "(none)"}`;

    const result = await this.wtRun({ wt, model, prompt, output: Output.string({ tag: "spec" }) });
    return { outcome: "pass", artifacts: [{ name: "spec", content: outputOf<string>(result) }] };
  }

  private async runImplement(req: StageRequest, model: string, wt: Worktree): Promise<StageResult> {
    const specPath = req.item && path.join(wt.worktreePath, ".factory", "spec.md");
    void specPath;
    const prompt = `You are the implementation stage of a software factory. Implement the work item in this repository worktree and commit your changes to the current branch.

Rules:
- Commit your work with clear commit messages.
- Follow the spec exactly where it exists; use judgement where it is silent.
${TRUST_BUT_VERIFY}

## Item: ${req.item.title}

${req.item.body}
${req.item.feedback ? `\n## Rework feedback you MUST address\n\n${req.item.feedback}\n` : ""}
## Knowledge base

Global:
${req.kb.global || "(none)"}

Project:
${req.kb.project || "(none)"}`;

    const result = await this.wtRun({ wt, model, prompt });
    const commits = (result.commits ?? []).map((c) => c.sha);
    return {
      outcome: "pass",
      artifacts: [{ name: "implement-log", content: `commits: ${commits.length ? commits.join(", ") : "(none recorded)"}` }],
    };
  }

  private async runTest(req: StageRequest, model: string, wt: Worktree): Promise<StageResult> {
    const prompt = `You are the test stage of a software factory. Run this repository's test suite inside this worktree and judge the result.

Rules:
- Find and run the project's actual test command (check package.json / Makefile / CI config).
- If tests fail and the failure is fixable with a small, safe change, fix it and re-run the suite, then commit the fix.
- Do not rewrite the feature beyond what the failing tests demand.
${TRUST_BUT_VERIFY}

Return your verdict as JSON inside a <test>...</test> tag:
- testsPassed: boolean (after any fix)
- report: what you ran and what happened
- fix: only if you fixed something — what the fix was, generalized so a future run can learn from it
- lesson: only if tests failed — what went wrong`;

    const result = await this.wtRun({ wt, model, prompt, output: Output.object({ tag: "test", schema: TestVerdict }) });
    const v = outputOf<z.infer<typeof TestVerdict>>(result);
    if (!v.testsPassed) {
      return {
        outcome: "gate-fail",
        artifacts: [{ name: "test-report", content: v.report }],
        report: v.report,
        feedback: v.report,
        lesson: v.lesson ?? v.report,
        fix: v.fix,
      };
    }
    return { outcome: "pass", artifacts: [{ name: "test-report", content: v.report }], fix: v.fix };
  }

  private async runReview(req: StageRequest, model: string, wt: Worktree): Promise<StageResult> {
    const prompt = `You are the review gate of a software factory. Review the changes on this branch against ${JSON.stringify(req.item.base)} for:
1. Code quality
2. Security (input validation, injection, secrets, auth)
3. Best practices for this codebase

Run \`git diff ${req.item.base}...HEAD\` to see the merged diff. Read surrounding code as needed.

${TRUST_BUT_VERIFY}

Return your verdict as JSON inside a <review>...</review> tag:
- verdict: "pass" | "fail"
- findings: your review notes (required, this is the audit-trail artifact)
- lesson: only when you fail — what went wrong, as a durable lesson for future runs
- fix: only when you fail — concrete fix instructions for the implementer
- prSummary: one line summarizing the outcome of the whole pipeline for this item`;

    const result = await this.wtRun({ wt, model, prompt, output: Output.object({ tag: "review", schema: ReviewVerdict }) });
    const v = outputOf<z.infer<typeof ReviewVerdict>>(result);
    if (v.verdict === "fail") {
      return {
        outcome: "gate-fail",
        artifacts: [{ name: "review-verdict", content: v.findings }],
        report: v.findings,
        feedback: v.fix ?? v.findings,
        lesson: v.lesson ?? v.findings,
        fix: v.fix,
      };
    }
    return {
      outcome: "pass",
      artifacts: [{ name: "review-verdict", content: v.findings }],
      prSummary: v.prSummary,
    };
  }

  /** Release worktrees on process end; branches and commits survive. */
  async dispose(): Promise<void> {
    for (const wt of this.worktrees.values()) {
      try {
        await wt.close();
      } catch {
        // best-effort cleanup
      }
    }
    this.worktrees.clear();
  }
}

/**
 * The PR publisher runs on the host: the branch already exists in the target
 * repo's git (a worktree child); push it and create a GitHub PR via `gh`.
 * The factory never merges — there is deliberately no merge call anywhere.
 */
export class GhPrPublisher {
  async publish(req: {
    body: string;
    repoPath: string;
    branchName: string;
    base: string;
    draft: boolean;
    item: ItemContext;
  }): Promise<{ url: string; number: number; draft: boolean }> {
    if (!fs.existsSync(path.join(req.repoPath, ".git"))) {
      throw new Error(`repo path is not a git repository: ${req.repoPath}`);
    }
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: req.repoPath, encoding: "utf8", timeout: 120_000 });
    git(["push", "-u", "origin", req.branchName]);

    const bodyFile = path.join(os.tmpdir(), `factory-pr-body-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(bodyFile, req.body, "utf8");
    try {
      const out = execFileSync(
        "gh",
        [
          "pr", "create",
          "--head", req.branchName,
          "--base", req.base,
          "--title", req.item.title,
          "--body-file", bodyFile,
          ...(req.draft ? ["--draft"] : []),
        ],
        { cwd: req.repoPath, encoding: "utf8", timeout: 180_000, env: { ...process.env } },
      );
      const url = out.trim().split("\n").pop()?.trim() ?? "";
      const m = url.match(/\/pull\/(\d+)/);
      if (!url) throw new Error(`gh pr create produced no url: ${out}`);
      return { url, number: m ? Number(m[1]) : 0, draft: req.draft };
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }
}

export class SandcastleCurator implements CuratorRunner {
  constructor(private readonly deps: { config: FactoryConfig; env?: Record<string, string> }) {}

  async propose(req: CuratorRequest): Promise<StageResult> {
    const { config } = this.deps;
    const model = modelFor(config.models, "curate");
    // A scratch git repo anchors the sandbox; everything real is read-only.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "factory-curate-"));
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    const mounts = Object.values(req.repoPaths).map(
      (rp): { hostPath: string; sandboxPath: string; readonly: true } => ({
        hostPath: rp,
        sandboxPath: path.join("repos", path.basename(rp)),
        readonly: true,
      }),
    );

    const repoGuidance = Object.entries(req.repoPaths)
      .map(([slug, rp]) => `- ${slug}: mounted read-only at repos/${path.basename(rp)}`)
      .join("\n");
    const prompt = `You are the knowledge-base curator for a software factory. Read the KB layers below${Object.keys(req.repoPaths).length ? " and the mounted repositories" : ""} and write a curation PROPOSAL. You must not change anything — your only output is the proposal.

Your proposal must list, each citing the entries and repo evidence involved:
- contradictions between entries
- facts that no longer match the repository state
- stale-dated entries worth pruning, with a recommendation (prune | merge | keep)
- merge candidates

Projects in scope: ${req.projects.length ? req.projects.join(", ") : "(all)"}${repoGuidance ? `\nRepositories:\n${repoGuidance}` : ""}

## Global KB

${req.kb.global || "(empty)"}

## Project KB

${req.kb.project || "(empty)"}

Return the full proposal markdown inside a <proposal>...</proposal> tag.
${COMPLETE}`;

    const result = await this.wtRunScratch({ scratch, model, prompt, mounts });
    fs.rmSync(scratch, { recursive: true, force: true });
    return { outcome: "pass", artifacts: [{ name: "proposal", content: outputOf<string>(result) }] };
  }

  private async wtRunScratch(opts: { scratch: string; model: string; prompt: string; mounts: { hostPath: string; sandboxPath: string; readonly: true }[] }): Promise<RunResult> {
    const { run } = await import("@ai-hero/sandcastle");
    return run({
      agent: pi(opts.model, { env: this.deps.env ?? {} }),
      sandbox: docker({ imageName: this.deps.config.sandbox.imageName, mounts: opts.mounts }),
      cwd: opts.scratch,
      prompt: opts.prompt,
      maxIterations: 1,
      output: Output.string({ tag: "proposal" }),
    });
  }
}

/** Host-side env passthrough for Ollama Cloud credentials. */
export function ollamaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["OLLAMA_API_KEY", "OLLAMA_HOST", "OLLAMA_CLOUD_API_KEY"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}