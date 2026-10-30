import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { createWorktree, pi } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { Worktree, RunResult, SandboxHooks } from "@ai-hero/sandcastle";

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
  /** Per-item npm-global prefix dirs (item slug → host dir), cleaned up in dispose(). */
  private readonly npmPrefixes = new Map<string, string>();
  /** Per-item agent-dir copies (item slug → host dir), cleaned up in dispose(). */
  private readonly agentDirs = new Map<string, string>();
  /** Agent-dir copy the most recent run wrote sessions into; agentText depends
   *  on wtRun/wtRunScratch having run first (set just before every run). */
  private sessionsDirOfLastRun: string | null = null;
  private runStartedAt = 0;

  private staging(): PiConfigStage | null {
    return getPiConfigStage(this.config.root);
  }

  /** Assistant text from the sandboxed pi session, with stream-parse fallback.
   *  Deliberately NO staged-template fallback for the sessions dir: the
   *  template never holds sessions (freshAgentDir creates them per run
   *  copy), so before any run there is nothing session-like to read — the
   *  stream-parse fallback covers it. */
  private agentText(result: RunResult): string | undefined {
    // Depends on wtRun/wtRunScratch having set sessionsDirOfLastRun.
    if (!this.sessionsDirOfLastRun) return lastIterationText(result) || undefined;
    const text = assistantTextFromSessions(
      path.join(this.sessionsDirOfLastRun, "sessions"),
      this.runStartedAt,
    );
    return text || lastIterationText(result) || undefined;
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

  /**
   * Per-item writable npm-global prefix, isolated from every other item and
   * from later stages of the same item: the base template is wiped and
   * re-copied on EVERY call, so an agent-installed package can persist
   * neither into a later stage of this item nor into a later item. The copy
   * is small (the seeded pi packages) and runs on the host before the
   * sandbox starts; pipeline execution is strictly sequential per
   * specs/001-software-factory-mvp.md, so there is no concurrent-writer
   * hazard. A crashed process can leave a stale npm-items/<slug>/ dir
   * behind — accepted residue (reaping it via `wb gc` is out of scope).
   */
  private ensureItemNpmPrefix(slug: string): string | null {
    const staged = this.staging();
    const base = staged?.npmGlobalPrefixBase ?? null;
    if (!base) return null;
    const target = path.join(this.config.root, "pi-config", "npm-items", slug);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(base, target, { recursive: true });
    this.npmPrefixes.set(slug, target);
    return target;
  }

  /**
   * Per-run writable pi agent dir, isolated like the npm prefix: wiped and
   * re-copied from the staged template on EVERY call, so tampering cannot
   * persist into a later stage of the same item or into a later item.
   *
   * Writability is REQUIRED, not a regression: pi acquires a lock file
   * (settings.json.lock) beside its settings file at read time and writes
   * session files under <agent-dir>/sessions, so the agent dir cannot be
   * mounted read-only without breaking pi startup (live-verified via the
   * gated integration suite). The security property this preserves instead:
   * the copy is minimal (never auth.json — credentials ride env only) and
   * is rebuilt from the template BEFORE every run, so tampering cannot
   * persist into a later stage of the same item or into a later item. A
   * run's residue stays on the host disk only until that item's next stage
   * run (or runner dispose) wipes it — it is not removed right at run end.
   * Session files inside the copy are therefore transient, not durable:
   * inspectable while the run/item is live, never an audit trail.
   */
  private ensureItemAgentDir(slug: string): string {
    const target = path.join(this.config.root, "pi-config", "agents", slug);
    freshAgentDir(this.staging(), target);
    this.agentDirs.set(slug, target);
    this.sessionsDirOfLastRun = target;
    return target;
  }

  private async wtRun(opts: { wt: Worktree; slug: string; model: string; prompt: string }): Promise<RunResult> {
    const { wt, model, prompt } = opts;
    const staged = this.staging();
    const npmPrefix = staged ? this.ensureItemNpmPrefix(opts.slug) : null;
    const agentDir = this.ensureItemAgentDir(opts.slug);
    const mounts = piConfigMounts(agentDir, npmPrefix);
    // Dependency install before the agent starts — Node projects only; see
    // sandboxReadyHooksFor() for the rationale and the non-Node skip.
    const hooks = sandboxReadyHooksFor(wt.worktreePath);
    const piEnv = { ...this.env, ...piEnvFor({ npmGlobalPrefixMount: npmPrefix !== null }) };
    return wt.run({
      agent: pi(model, { env: piEnv }),
      sandbox: docker({
        imageName: this.config.sandbox.imageName,
        ...(mounts.length > 0 ? { mounts } : {}),
      }),
      ...(hooks ? { hooks } : {}),
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
      slug: req.item.slug,
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

    const result = await this.wtRun({ wt, slug: req.item.slug, model, prompt });
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

    const result = await this.wtRun({ wt, slug: req.item.slug, model, prompt });
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

    const result = await this.wtRun({ wt, slug: req.item.slug, model, prompt });
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

    const result = await this.wtRun({ wt, slug: req.item.slug, model, prompt });
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
    // The runner's worktree lifetime is the item lifetime, so per-item npm
    // prefixes are cleaned up with the item's worktree disposal.
    for (const dir of this.npmPrefixes.values()) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    this.npmPrefixes.clear();
    for (const dir of this.agentDirs.values()) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    this.agentDirs.clear();
    this.sessionsDirOfLastRun = null;
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
        ? `\nThe KB was too large for one pass and has been split into ${req.batch.total} entry-aligned batches; you are reviewing batch ${req.batch.index} (its full text is in the KB sections below).`
        : "";
      const indexNote = req.index && (req.index.global || req.index.project)
        ? `\nA digest index of every KB entry is included below. Use it to flag cross-batch contradictions and merge candidates: an index line is lossy, so when you spot one, name the batch whose full text must be checked, and cite the index line.`
        : "";
      const prompt = `You are the knowledge-base curator for a software factory. Read the KB layers below${Object.keys(req.repoPaths).length ? " and the mounted repositories" : ""} and write a curation PROPOSAL. You must not change anything — your only output is the proposal.${batchNote}${indexNote}

Your proposal must list, each citing the entries and repo evidence involved:
- contradictions between entries
- facts that no longer match the repository state
- stale-dated entries worth pruning, with a recommendation (prune | merge | keep)
- merge candidates

Projects in scope: ${req.projects.length ? req.projects.join(", ") : "(all)"}${repoGuidance ? `\nRepositories:\n${repoGuidance}` : ""}

${req.index?.global ? `## Global KB digest index\n\n${req.index.global}\n\n` : ""}${req.index?.project ? `## Project KB digest index\n\n${req.index.project}\n\n` : ""}## Global KB

${req.kb.global || "(empty)"}

## Project KB

${req.kb.project || "(empty)"}

Return the full proposal markdown inside a <proposal>...</proposal> tag.
${COMPLETE}`;

      const startedAt = Date.now();
      // Per-run writable agent-dir copy, same shape as the stage runner's
      // (pi must write its settings lock at read time); wiped in the finally
      // below, so nothing the curator run writes survives past the run.
      const agentDir = path.join(config.root, "pi-config", "agents", "curator");
      freshAgentDir(this.staging(), agentDir);
      try {
        const result = await this.wtRunScratch({ scratch, agentDir, model, prompt, mounts });
        const text =
          assistantTextFromSessions(path.join(agentDir, "sessions"), startedAt) ?? lastIterationText(result);
        const proposal = parseStructuredString(result, "proposal", text || undefined);
        return { outcome: "pass", artifacts: [{ name: "proposal", content: proposal }] };
      } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async wtRunScratch(opts: { scratch: string; agentDir: string; model: string; prompt: string; mounts: { hostPath: string; sandboxPath: string; readonly: true }[] }): Promise<RunResult> {
    const { run } = await import("@ai-hero/sandcastle");
    const staged = this.staging();
    const mounts = piConfigMounts(opts.agentDir, staged?.npmGlobalPrefixBase ?? null, "curator");
    const env = { ...(this.deps.env ?? {}), ...piEnvFor({ npmGlobalPrefixMount: !!staged?.npmGlobalPrefixBase }) };
    // Deliberately NO hooks.sandbox.onSandboxReady here (unlike wtRun): the
    // scratch cwd has no package.json (it only hosts read-only KB mounts), so
    // an npm install would fail and abort the run. Skipping is the designed
    // behavior — scratch runs make no code changes that need dependencies.
    return run({
      agent: pi(opts.model, { env }),
      sandbox: docker({
        imageName: this.deps.config.sandbox.imageName,
        mounts: [...mounts, ...opts.mounts],
      }),
      cwd: opts.scratch,
      prompt: opts.prompt,
      maxIterations: 1,
    });
  }
}

/**
 * Hook payload for worktree-backed runs. Node-only: fresh git worktrees have no
 * node_modules (gitignored) and the sandbox image is bare, so agent stages of a
 * Node project would otherwise fail with `tsc: not found` / `vitest: not found`.
 * Skipped for repos with no root package.json — a hook failure aborts the whole
 * run (non-zero exit → ExecError), and the pipeline explicitly supports non-Node
 * targets (the test stage checks package.json / Makefile / CI config), so an
 * unconditional npm install would make every non-Node repo unprocessible.
 * (Future polyglot support — pip/uv, go mod, etc. — can extend this selector.)
 */
export function sandboxReadyHooksFor(worktreePath: string): SandboxHooks | undefined {
  if (!fs.existsSync(path.join(worktreePath, "package.json"))) return undefined;
  // npm install (not npm ci): the worktree is bind-mounted, so node_modules
  // installed by an earlier stage of the same item persists — subsequent runs
  // are incremental. Lockfile still governs; --no-audit/--no-fund keep the
  // cold install fast. Timeout raised well above the 60s default: a cold
  // install (native module prebuilds for better-sqlite3) can be slow. A hook
  // failure aborts the run as an infra-class failure, covered by the
  // factory's maxInfraRetries budget.
  return {
    sandbox: {
      onSandboxReady: [{ command: "npm install --no-audit --no-fund", timeoutMs: 300_000 }],
    },
  };
}

/**
 * Host-side env passthrough for Ollama Cloud credentials. ONLY the API-key
 * vars are forwarded: sandbox stages talk to Ollama Cloud only, and passing
 * host OLLAMA_HOST through would let a compromised stage redirect model
 * traffic to an attacker-chosen host, so it is deliberately not forwarded.
 * If a future config needs a custom endpoint, that is an explicit follow-up.
 */
export function ollamaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

/**
 * Staged pi config TEMPLATE for sandboxed agents. The staged directory is a
 * HOST-SIDE SEED only — it is never mounted. Each run gets a fresh, writable
 * per-run copy (freshAgentDir) mounted at /home/agent/.pi/agent — the
 * sandboxed pi's default agent-dir path, resolved by the mount itself, not by
 * PI_CODING_AGENT_DIR.
 *
 * Why writable, not read-only: pi acquires a lock file (settings.json.lock)
 * BESIDE its settings file at read time and writes sessions under
 * <agent-dir>/sessions, so a read-only mount aborts pi startup (live-verified
 * via the gated integration suite). Isolation is temporal instead: copies are
 * minimal (never auth.json — credentials ride env only) and discarded after
 * the run, so an agent's writes here survive neither the stage boundary nor
 * the item. Credentials are NOT part of the stage: sandbox stages are
 * credentialed exclusively by env (ollamaEnv() → SandcastleRunnerDeps.env →
 * pi(model, { env })).
 */
export interface PiConfigStage {
  /** Staged pi config TEMPLATE (models, settings; NEVER auth.json). */
  agentDir: string;
  /** Host path of the seeded npm prefix template. NEVER mounted writable. */
  npmGlobalPrefixBase: string | null;
}

export interface PiConfigMount {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}

/**
 * Shared pi-config mount list for agent stages (wtRun) and the curator
 * (wtRunScratch), which previously duplicated it:
 * 1. the per-run agent-dir copy, WRITABLE — pi must write its settings lock
 *    beside the settings file at read time (a read-only mount breaks
 *    startup; see the PiConfigStage docstring), so isolation is temporal
 *    instead: the copy is minimal and rebuilt from the template before
 *    every run, so a run's writes survive at most until the next run of
 *    the same item (or runner dispose) wipes them;
 * 2. (when npmPrefix is non-null) the npm global prefix at NPM_GLOBAL_PREFIX.
 *
 * Residual exposure, documented deliberately (finding H1 follow-ups track
 * these): the per-run settings/models files are READABLE and WRITABLE inside
 * one run — but every run starts from a fresh template copy, so a compromised
 * stage cannot persist tampering into a later stage or item (residue lingers
 * on host disk only until that item's next stage run wipes it); the per-item npm
 * prefix is writable within a single stage run (an in-run `npm i` still works
 * and can affect only that run); and credentials reach stages via env, which
 * a compromised stage can always read — the goal is that a stage cannot
 * PERSIST a key or read unrelated credentials, not that it can never see its
 * own.
 *
 * In "curator" mode the prefix mount is read-only: the curator consumes
 * untrusted repo/KB text, never installs, and nothing legitimate writes to
 * the prefix in a scratch run — a read-only base prefix there is strictly
 * safer and needs no copy/cleanup. If pi or an injected curator attempts an
 * installation it fails inside that one run — contained.
 */
export function piConfigMounts(
  agentDir: string,
  npmPrefix: string | null,
  mode: "agent" | "curator" = "agent",
): PiConfigMount[] {
  const mounts: PiConfigMount[] = [
    { hostPath: agentDir, sandboxPath: "/home/agent/.pi/agent" },
  ];
  if (npmPrefix !== null) {
    mounts.push({
      hostPath: npmPrefix,
      sandboxPath: NPM_GLOBAL_PREFIX,
      ...(mode === "curator" ? { readonly: true } : {}),
    });
  }
  return mounts;
}

/**
 * Wipe + re-create a per-run agent dir at `target` from the staged template:
 * config files copied (whatever of models.json / models-store.json /
 * settings.json the template has — auth.json is not in the template by
 * construction), and an empty sessions/ subdir created so the sandboxed pi
 * has somewhere to write session files. Works even with a null template (an
 * empty writable dir — pi fails model resolution later, same as pre-staging).
 * Exported for tests.
 */
export function freshAgentDir(template: PiConfigStage | null, target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, "sessions"), { recursive: true });
  if (!template) return;
  for (const f of ["models.json", "models-store.json", "settings.json"]) {
    const src = path.join(template.agentDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
  }
}

/**
 * Stage the host's pi agent configuration for the sandbox — WITHOUT
 * auth.json: the host's full credential set is deliberately never copied
 * (minimal credentials, finding H1). Sandbox stages are credentialed
 * exclusively by env (OLLAMA_API_KEY / OLLAMA_CLOUD_API_KEY via ollamaEnv()
 * → SandcastleRunnerDeps.env); credentialing other provider families
 * without auth.json would need a follow-up (out of scope). Consequence: a
 * host with ONLY auth.json now stages nothing — previously it staged a
 * partial config that could not resolve models anyway.
 *
 * The containerized pi (a global install) treats user-scope packages as
 * GLOBAL npm installs and writes them under the npm global root, so we
 * pre-seed an npm prefix template (npm-global-base) — pinned to exact
 * versions at seed time — which the runner copies per item (see
 * ensureItemNpmPrefix) and mounts at NPM_GLOBAL_PREFIX with
 * npm_config_prefix pointing at it, so the packages resolve without any
 * in-container global install attempt. Nothing mounts the base template
 * writable, ever. Sessions land in the factory root, under the per-run
 * agent dirs (pi-config/agents/<run>/sessions — transient: wiped by that
 * item's next stage run or runner dispose, never an audit trail).
 */
export function preparePiConfigDir(factoryRoot: string): PiConfigStage | null {
  const agentDir = path.join(process.env.HOME ?? "~", ".pi", "agent");
  // auth.json is deliberately absent from this list — see the docstring.
  const files = ["models.json", "models-store.json", "settings.json"].filter((f) =>
    fs.existsSync(path.join(agentDir, f)),
  );
  if (files.length === 0) return null;
  const target = path.join(factoryRoot, "pi-config");
  fs.mkdirSync(target, { recursive: true });
  // No sessions/ dir on the template: nothing mounts or reads it (sessions
  // are created per run inside freshAgentDir's copies — see agentText).
  for (const f of files) {
    fs.copyFileSync(path.join(agentDir, f), path.join(target, f));
  }

  // Pre-seed the npm global prefix template with the packages pi's settings
  // declare, so the sandbox never needs a global install (root-owned, fails).
  let npmGlobalPrefixBase: string | null = null;
  const settingsPath = path.join(target, "settings.json");
  let packages: string[] = [];
  try {
    packages = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages?: string[] }).packages ?? [];
  } catch {
    packages = [];
  }
  if (packages.length > 0) {
    const hostNpmDir = path.join(agentDir, "npm");
    if (fs.existsSync(path.join(hostNpmDir, "node_modules", "pi-ollama-cloud"))) {
      // Intentionally NOT gated on the declared list containing
      // pi-ollama-cloud (the pre-PR gate): pi loads whatever
      // settings.packages declare, so the prefix must seed exactly that
      // list — anything missing would fall back to an in-container global
      // install, which fails (root-owned). The host npm-dir presence check
      // is a cheap proxy for "this host installs pi packages"; seeding runs
      // once per factory root (piConfigCache), not per item. Any resolution
      // or install failure ⇒ no prefix mounted at all — the sandboxed pi
      // falls back as before; we never silently install unpinned.
      npmGlobalPrefixBase = path.join(target, "npm-global-base");
      fs.mkdirSync(npmGlobalPrefixBase, { recursive: true });
      try {
        const specs = resolveExactSpecs(packages, npmViewResolver);
        execFileSync(
          "npm",
          ["install", "-g", "--prefix", npmGlobalPrefixBase, "--legacy-peer-deps", "--no-audit", "--no-fund", ...specs],
          { timeout: 180_000, stdio: "pipe" },
        );
      } catch {
        npmGlobalPrefixBase = null;
        // Best-effort; without it pi retries a global install in-container.
      }
    }
  }
  return { agentDir: target, npmGlobalPrefixBase };
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+([-+].*)?$/;

/**
 * Split a package spec into { name, range } — range null when the spec is a
 * bare name. Handles scoped names: the separating '@' is the last '@' at
 * index > 0. A leading "npm:" prefix (as pi's settings may declare) is
 * stripped first.
 */
export function parsePackageSpec(spec: string): { name: string; range: string | null } {
  const stripped = spec.startsWith("npm:") ? spec.slice(4) : spec;
  const at = stripped.lastIndexOf("@");
  if (at > 0) {
    const range = stripped.slice(at + 1);
    return { name: stripped.slice(0, at), range: range.length > 0 ? range : null };
  }
  return { name: stripped, range: null };
}

export type VersionResolver = (name: string, range: string | null) => string;

/**
 * Resolve each declared package ONCE to an exact version; specs already
 * pinned to a full semver pass through untouched (the resolver is not
 * called for them). Throws on unresolvable specs (caller aborts seeding).
 */
export function resolveExactSpecs(specs: string[], resolve: VersionResolver): string[] {
  return specs.map((spec) => {
    const { name, range } = parsePackageSpec(spec);
    if (range && EXACT_SEMVER.test(range)) return `${name}@${range}`;
    return `${name}@${resolve(name, range)}`;
  });
}

/**
 * Default VersionResolver: host-side `npm view <name>[@range] version
 * --json`, JSON-parsed, then the top entry of a semver-descending sort —
 * npm does not document its output ordering, and the pinned version must
 * never depend on it (see newestSemver). Throws when nothing resolvable
 * is returned (caller aborts seeding).
 */
function npmViewResolver(name: string, range: string | null): string {
  const out = execFileSync(
    "npm",
    ["view", range ? `${name}@${range}` : name, "version", "--json"],
    { timeout: 60_000, stdio: "pipe", encoding: "utf8" },
  );
  return newestSemver(JSON.parse(out), `npm view ${name}`);
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease/build suffix ("-beta.2", "+meta") or "" for a clean release. */
  suffix: string;
}

function semverParts(v: string): SemverParts | null {
  const m = /^(\d+)\.(\d+)\.(\d+)((?:[-+].*)?)$/.exec(v.trim());
  return m
    ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), suffix: m[4] ?? "" }
    : null;
}

/**
 * Pick the NEWEST version from an npm `view --json` payload (a single
 * version string or an array) — sorted by semver descending, never by the
 * payload's own order (npm does not document its sort order; the old
 * last-entry read silently depended on it). Ties on MAJOR.MINOR.PATCH use
 * semver §11 prerelease precedence, segment-wise (clean release >
 * prerelease; numeric segments compare numerically; alphanumeric above
 * numeric; more segments above a shorter prefix; the ±build-metadata
 * segment carries no precedence — the first tie wins). Throws when the
 * payload is empty or carries no semver-parsable version: the caller
 * refuses to seed rather than pin garbage. Exported for tests.
 */
export function newestSemver(parsed: unknown, source = "versions payload"): string {
  const raw = (Array.isArray(parsed) ? parsed : [parsed]).map((v) => String(v ?? "").trim());
  const candidates = raw
    .map((v) => ({ v, parts: semverParts(v) }))
    .filter((c): c is { v: string; parts: SemverParts } => c.parts !== null)
    .sort((a, b) =>
      b.parts.major - a.parts.major ||
      b.parts.minor - a.parts.minor ||
      b.parts.patch - a.parts.patch ||
      -comparePrerelease(a.parts.suffix, b.parts.suffix),
    );
  if (candidates.length === 0) {
    if (raw.length > 0 && raw.every((v) => v.length > 0)) {
      throw new Error(`no semver-parsable version in ${source}: ${raw.join(", ")}`);
    }
    throw new Error(`no version resolved from ${source}`);
  }
  return candidates[0]!.v;
}

/** Prerelease identifier string of a semver suffix, or null for a clean
 *  release / build-metadata-only suffix ("+build.7") — per semver §11,
 *  build metadata carries no precedence. */
function prereleaseOf(suffix: string): string | null {
  if (!suffix.startsWith("-")) return null;
  return suffix.slice(1).split("+")[0] ?? null;
}

/** Semver §11.4 prerelease precedence, ASCENDING; a prerelease-less suffix
 *  (null) sorts ABOVE any prerelease — the caller inverts this for the
 *  newest-first sort. */
function comparePrerelease(suffixA: string, suffixB: string): number {
  const a = prereleaseOf(suffixA);
  const b = prereleaseOf(suffixB);
  if (a === b) return 0;
  if (a === null) return 1; // release sorts above any prerelease
  if (b === null) return -1;
  const sa = a.split(".");
  const sb = b.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1; // fewer segments = lower precedence
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx) {
      return -1; // numeric identifiers sort below alphanumeric
    } else if (ny) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const piConfigCache = new Map<string, PiConfigStage | null>();
/**
 * Get (or create) the staged pi config for this factory root. The cache is
 * keyed by root, but a cached entry is only returned while its directory
 * still exists — a rebuild of the factory root (cleanup between test suites,
 * operator wipe between runs) previously left a dead stage in the cache whose
 * bind-mount failed Sandcastle's hostPath existence check at run time.
 */
export function getPiConfigStage(factoryRoot: string): PiConfigStage | null {
  const cached = piConfigCache.get(factoryRoot);
  if (cached && fs.existsSync(cached.agentDir)) return cached;
  const fresh = preparePiConfigDir(factoryRoot);
  piConfigCache.set(factoryRoot, fresh);
  return fresh;
}

function realRepoPath(repo: string): string {
  try {
    return fs.realpathSync(repo);
  } catch {
    return repo;
  }
}