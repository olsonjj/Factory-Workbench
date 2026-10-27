import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { createWorktree, pi } from "@ai-hero/sandcastle";
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

export const TriageVerdict = z.object({
  outcome: z.enum(["proceed", "reject", "needs-human"]),
  report: z.string(),
  // Agents may null this when there are no questions — accept null (same dogfood finding as lesson/fix).
  questions: z.array(z.string()).nullish(),
});

export const TestVerdict = z.object({
  testsPassed: z.boolean(),
  report: z.string(),
  // Agents null these on a clean run ("lesson: only if tests failed") —
  // accept explicit null, not just field-absence (2026-10-27 dogfood finding).
  lesson: z.string().nullish(),
  fix: z.string().nullish(),
});

export const ReviewVerdict = z.object({
  verdict: z.enum(["pass", "fail"]),
  findings: z.string(),
  lesson: z.string().nullish(),
  fix: z.string().nullish(),
  prSummary: z.string().nullish(),
});

const COMPLETE = "When you are done, emit `<promise>COMPLETE</promise>` as the final line of your output.";

/**
 * pi runs in `--mode json`, so the agent's raw stdout is JSONL — escaped — and
 * Sandcastle's built-in structured-output extraction (which scans raw stdout
 * for <tag>...</tag>) cannot find clean content in it. We instead extract from
 * the parsed stream text and validate with zod ourselves. Missing/unparseable
 * structured output is an infra-class failure (retried under the infra budget).
 */
export class StructuredOutputParseError extends Error {
  constructor(tag: string, cause: unknown) {
    super(`Structured output <${tag}> missing or invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StructuredOutputParseError";
  }
}

function lastIterationText(result: RunResult): string {
  const last = [...(result.iterations ?? [])].reverse().find((i) => typeof (i as { result?: unknown }).result === "string");
  return ((last as { result?: string } | undefined)?.result ?? "");
}

/**
 * pi 1.4 changed its `--mode json` stream format (sandcastle 0.12's parser
 * predates it), so the stream-derived result text may be empty. The sandboxed
 * pi writes its session file through our staged ~/.pi/agent mount — read the
 * last assistant message from the newest session file written since the run
 * started.
 */
function assistantTextFromSessions(sessionsDir: string, sinceMs: number): string | undefined {
  let newest: { file: string; mtime: number } | undefined;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime >= sinceMs && (!newest || mtime > newest.mtime)) newest = { file: full, mtime };
      }
    }
  };
  if (!fs.existsSync(sessionsDir)) return undefined;
  try {
    walk(sessionsDir);
  } catch {
    return undefined;
  }
  if (!newest) return undefined;
  const parts: string[] = [];
  for (const line of fs.readFileSync(newest.file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: { type?: string; text?: string }[] };
      };
      if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
      for (const block of rec.message.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    } catch {
      continue;
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function extractTagContent(text: string, tag: string): string | undefined {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let last: string | undefined;
  let from = 0;
  for (;;) {
    const openIdx = text.indexOf(openTag, from);
    if (openIdx === -1) break;
    const start = openIdx + openTag.length;
    const closeIdx = text.indexOf(closeTag, start);
    if (closeIdx === -1) break;
    last = text.slice(start, closeIdx);
    from = closeIdx + closeTag.length;
  }
  return last;
}

export function parseStructured<T>(result: RunResult, tag: string, schema: z.ZodType<T>, agentText?: string): T {
  const raw = extractTagContent(agentText || lastIterationText(result), tag);
  if (raw === undefined) {
    throw new StructuredOutputParseError(tag, "tag not found in agent output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (cause) {
    throw new StructuredOutputParseError(tag, cause);
  }
  const check = schema.safeParse(parsed);
  if (!check.success) {
    throw new StructuredOutputParseError(tag, check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return check.data;
}

export function parseStructuredString(result: RunResult, tag: string, agentText?: string): string {
  const raw = extractTagContent(agentText || lastIterationText(result), tag);
  if (raw === undefined) {
    throw new StructuredOutputParseError(tag, "tag not found in agent output");
  }
  return raw.trim();
}

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

export const NPM_GLOBAL_PREFIX = "/home/agent/.npm-global";

/** Env injected into the sandboxed pi process (and its npm children). */
export function piEnvFor(piConfig: { npmGlobalPrefixMount: boolean }): Record<string, string> {
  return piConfig.npmGlobalPrefixMount ? { npm_config_prefix: NPM_GLOBAL_PREFIX } : {};
}

export class SandcastleStageRunner implements StageRunner {
  private readonly config: FactoryConfig;
  private readonly env: Record<string, string>;
  private readonly worktrees = new Map<string, Worktree>();
  private runStartedAt = 0;

  private staging(): PiConfigStage | null {
    return getPiConfigStage(this.config.root);
  }

  /** Assistant text from the sandboxed pi session, with stream-parse fallback. */
  private agentText(result: RunResult): string | undefined {
    const staged = this.staging();
    if (staged) {
      const text = assistantTextFromSessions(path.join(staged.agentDir, "sessions"), this.runStartedAt);
      if (text) return text;
    }
    return lastIterationText(result) || undefined;
  }

  constructor(deps: SandcastleRunnerDeps) {
    this.config = deps.config;
    this.env = deps.env ?? {};
  }

  async runStage(req: StageRequest): Promise<StageResult> {
    const started = Date.now();
    this.runStartedAt = Date.now();
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
    // Sandcastle mounts the parent .git at the literal path it is given, but
    // git records worktree links as realpaths. On macOS a repo under a
    // symlinked prefix (/tmp, /var/folders, …) would leave the in-container
    // gitdir chain dangling — pass the resolved real path.
    const repoRealPath = realRepoPath(item.repo);
    const wt = await createWorktree({
      cwd: repoRealPath,
      branchStrategy: { type: "branch", branch: item.branchName, baseBranch: item.base },
    });
    this.worktrees.set(item.slug, wt);
    return wt;
  }

  private async wtRun(opts: { wt: Worktree; model: string; prompt: string }): Promise<RunResult> {
    const { wt, model, prompt } = opts;
    const staged = this.staging();
    const piConfigMounts = staged
      ? [
          { hostPath: staged.agentDir, sandboxPath: "/home/agent/.pi/agent" },
          ...(staged.npmGlobalPrefix
            ? [{ hostPath: staged.npmGlobalPrefix, sandboxPath: NPM_GLOBAL_PREFIX }]
            : []),
        ]
      : [];
    const piEnv = { ...this.env, ...piEnvFor({ npmGlobalPrefixMount: !!staged?.npmGlobalPrefix }) };
    return wt.run({
      agent: pi(model, { env: piEnv }),
      sandbox: docker({
        imageName: this.config.sandbox.imageName,
        ...(piConfigMounts.length > 0 ? { mounts: piConfigMounts } : {}),
      }),
      prompt: [prompt, COMPLETE].join("\n\n"),
      maxIterations: 1,
    });
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
    });
    const v = parseStructured(result, "triage", TriageVerdict, this.agentText(result));
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

    const result = await this.wtRun({ wt, model, prompt });
    const spec = parseStructuredString(result, "spec", this.agentText(result));
    return { outcome: "pass", artifacts: [{ name: "spec", content: spec }] };
  }

  private async runImplement(req: StageRequest, model: string, wt: Worktree): Promise<StageResult> {
    const prompt = `You are the implementation stage of a software factory. Implement the work item in this repository worktree and commit your changes to the current branch.

Rules:
- Commit your work with clear commit messages.
- Follow the spec below exactly where it exists; use judgement where it is silent.
${TRUST_BUT_VERIFY}

## Item: ${req.item.title}

${req.item.body}
${req.item.spec ? `\n## Approved spec (follow this)

${req.item.spec}\n` : ""}${req.item.feedback ? `\n## Rework feedback you MUST address\n\n${req.item.feedback}\n` : ""}
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

    const result = await this.wtRun({ wt, model, prompt });
    const v = parseStructured(result, "test", TestVerdict, this.agentText(result));
    if (!v.testsPassed) {
      return {
        outcome: "gate-fail",
        artifacts: [{ name: "test-report", content: v.report }],
        report: v.report,
        feedback: v.report,
        lesson: v.lesson ?? v.report,
        fix: v.fix ?? undefined,
      };
    }
    return { outcome: "pass", artifacts: [{ name: "test-report", content: v.report }], fix: v.fix ?? undefined };
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

    const result = await this.wtRun({ wt, model, prompt });
    const v = parseStructured(result, "review", ReviewVerdict, this.agentText(result));
    if (v.verdict === "fail") {
      return {
        outcome: "gate-fail",
        artifacts: [{ name: "review-verdict", content: v.findings }],
        report: v.findings,
        feedback: v.fix ?? v.findings,
        lesson: v.lesson ?? v.findings,
        fix: v.fix ?? undefined,
      };
    }
    return {
      outcome: "pass",
      artifacts: [{ name: "review-verdict", content: v.findings }],
      prSummary: v.prSummary ?? undefined,
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
  /** Non-throwing pre-publish lookup; publish() remains the throwing path. */
  async findExisting(req: { repoPath: string; branchName: string; base: string }): Promise<{ url: string; number: number; draft: boolean } | undefined> {
    if (!fs.existsSync(path.join(req.repoPath, ".git"))) return undefined;
    try {
      const out = execFileSync(
        "gh", ["pr", "list", "--head", req.branchName, "--base", req.base, "--state", "open",
               "--json", "number,url,isDraft", "--jq", ".[0]"],
        { cwd: req.repoPath, encoding: "utf8", timeout: 60_000 },
      );
      const t = out.trim();
      if (!t || t === "null") return undefined;
      const j = JSON.parse(t) as { number: number; url: string; isDraft?: boolean };
      return { url: j.url, number: j.number, draft: j.isDraft ?? false };
    } catch {
      return undefined; // gh unavailable — publish() will surface the real error
    }
  }

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
      } catch (err) {
        // Defense-in-depth: a crash after `gh pr create` succeeded leaves the
        // PR existing; recover it instead of failing a duplicate create.
        const stderr = (err as { stderr?: string }).stderr ?? "";
        if (/already exists/i.test(stderr)) {
          const existing = await this.findExisting({ repoPath: req.repoPath, branchName: req.branchName, base: req.base });
          if (existing) return existing;
        }
        throw err;
      }
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }
}

export class SandcastleCurator implements CuratorRunner {
  private readonly deps: { config: FactoryConfig; env?: Record<string, string> };

  constructor(deps: { config: FactoryConfig; env?: Record<string, string> }) {
    this.deps = deps;
  }

  private staging(): PiConfigStage | null {
    return getPiConfigStage(this.deps.config.root);
  }

  async propose(req: CuratorRequest): Promise<StageResult> {
    const { config } = this.deps;
    const model = modelFor(config.models, "curate");
    // A scratch git repo anchors the sandbox; everything real is read-only.
    // Sandcastle's run() resolves HEAD in its cwd repo (git rev-parse), so the
    // scratch must contain a real initial commit — a bare `git init` leaves
    // HEAD unborn and the run aborts with "ambiguous argument 'HEAD'".
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "factory-curate-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: scratch });
      fs.writeFileSync(path.join(scratch, "README.md"), "# scratch dir anchoring the curator sandbox (read-only mounts carry the real repos)\n");
      execFileSync("git", ["add", "-A"], { cwd: scratch });
      execFileSync(
        "git",
        ["-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", "commit", "-q", "-m", "scratch anchor"],
        { cwd: scratch },
      );
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
      const batchNote = req.batch
        ? `\nThe KB was too large for one pass and has been split into ${req.batch.total} entry-aligned batches; you are reviewing batch ${req.batch.index}. Focus on the entries provided; cross-batch findings are handled by the operator comparing batch proposals.`
        : "";
      const prompt = `You are the knowledge-base curator for a software factory. Read the KB layers below${Object.keys(req.repoPaths).length ? " and the mounted repositories" : ""} and write a curation PROPOSAL. You must not change anything — your only output is the proposal.${batchNote}

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

      const startedAt = Date.now();
      const result = await this.wtRunScratch({ scratch, model, prompt, mounts });
      const staged = this.staging();
      const text = staged
        ? assistantTextFromSessions(path.join(staged.agentDir, "sessions"), startedAt) ?? lastIterationText(result)
        : lastIterationText(result);
      const proposal = parseStructuredString(result, "proposal", text || undefined);
      return { outcome: "pass", artifacts: [{ name: "proposal", content: proposal }] };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async wtRunScratch(opts: { scratch: string; model: string; prompt: string; mounts: { hostPath: string; sandboxPath: string; readonly: true }[] }): Promise<RunResult> {
    const { run } = await import("@ai-hero/sandcastle");
    const staged = this.staging();
    const piConfigMounts = staged
      ? [
          { hostPath: staged.agentDir, sandboxPath: "/home/agent/.pi/agent" },
          ...(staged.npmGlobalPrefix
            ? [{ hostPath: staged.npmGlobalPrefix, sandboxPath: NPM_GLOBAL_PREFIX }]
            : []),
        ]
      : [];
    const env = { ...(this.deps.env ?? {}), ...piEnvFor({ npmGlobalPrefixMount: !!staged?.npmGlobalPrefix }) };
    return run({
      agent: pi(opts.model, { env }),
      sandbox: docker({
        imageName: this.deps.config.sandbox.imageName,
        mounts: [...piConfigMounts, ...opts.mounts],
      }),
      cwd: opts.scratch,
      prompt: opts.prompt,
      maxIterations: 1,
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

/**
 * pi inside the sandbox is a fresh install: no auth, no custom providers, no
 * model catalog. Stage the host's pi config (auth.json, models.json,
 * models-store.json) read-only inside the factory root and point the sandboxed
 * agent at it via PI_CODING_AGENT_DIR, so it can resolve and call exactly the
 * model the config file names. (The agent needs the key to call the model
 * anyway — no new exposure; nothing outside the local factory root.)
 */
export interface PiConfigStage {
  /** Mounted as the sandbox's ~/.pi/agent (credentials, catalog, settings). */
  agentDir: string;
  /** Writable npm global root mounted at NPM_GLOBAL_PREFIX, pre-seeded with pi packages. */
  npmGlobalPrefix: string | null;
}

/**
 * Stage the host's pi agent configuration for the sandbox. The containerized
 * pi (a global install) treats user-scope packages as GLOBAL npm installs and
 * writes them under the npm global root. We bind a pre-seeded, writable
 * prefix at /home/agent/.npm-global and point npm_config_prefix at it, so the
 * packages resolve without any in-container global install attempt.
 * Sessions land in the factory root (durable, inspectable).
 */
export function preparePiConfigDir(factoryRoot: string): PiConfigStage | null {
  const agentDir = path.join(process.env.HOME ?? "~", ".pi", "agent");
  const files = ["auth.json", "models.json", "models-store.json", "settings.json"].filter((f) =>
    fs.existsSync(path.join(agentDir, f)),
  );
  if (files.length === 0) return null;
  const target = path.join(factoryRoot, "pi-config");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, "sessions"), { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(agentDir, f), path.join(target, f));
  }

  // Pre-seed the writable npm global prefix with the packages pi's settings
  // declare, so the sandbox never needs a global install (root-owned, fails).
  let npmGlobalPrefix: string | null = null;
  const settingsPath = path.join(target, "settings.json");
  let packages: string[] = [];
  try {
    packages = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages?: string[] }).packages ?? [];
  } catch {
    packages = [];
  }
  if (packages.length > 0) {
    const hostNpmDir = path.join(agentDir, "npm");
    if (fs.existsSync(path.join(hostNpmDir, "node_modules", "pi-ollama-cloud")) && hasNpmSpecFor(piOllamaSpecIn(packages))) {
      // Install each declared package into the staged global prefix.
      npmGlobalPrefix = path.join(target, "npm-global");
      fs.mkdirSync(npmGlobalPrefix, { recursive: true });
      const specs = packages
        .map((p) => (p.startsWith("npm:") ? p.slice(4) : p))
        .map((spec) => (spec.includes("@", 1) ? spec : `${spec}@latest`));
      try {
        execFileSync(
          "npm",
          ["install", "-g", "--prefix", npmGlobalPrefix, "--legacy-peer-deps", "--no-audit", "--no-fund", ...specs],
          { timeout: 180_000, stdio: "pipe" },
        );
      } catch {
        // Best-effort; without it pi retries a global install in-container.
      }
    }
  }
  return { agentDir: target, npmGlobalPrefix };
}

const piConfigCache = new Map<string, PiConfigStage | null>();
export function getPiConfigStage(factoryRoot: string): PiConfigStage | null {
  if (!piConfigCache.has(factoryRoot)) piConfigCache.set(factoryRoot, preparePiConfigDir(factoryRoot));
  return piConfigCache.get(factoryRoot) ?? null;
}

function piOllamaSpecIn(packages: string[]): boolean {
  return packages.some((p) => p.includes("pi-ollama-cloud"));
}

function hasNpmSpecFor(_present: boolean): boolean {
  return _present;
}

function realRepoPath(repo: string): string {
  try {
    return fs.realpathSync(repo);
  } catch {
    return repo;
  }
}