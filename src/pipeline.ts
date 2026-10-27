import * as path from "node:path";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { ACTIONABLE_STATUSES, APPROVAL_STAGES, GATE_STAGES, STAGES, type CuratorRunner, type ItemContext, type ItemRecord, type ItemStatus, type KbSnapshot, type PrPublishResult, type StageName, type StageResult, type StageRunner } from "./types.js";
import type { FactoryDb } from "./db.js";
import type { FactoryPaths } from "./paths.js";
import { artifactDir, itemDir } from "./paths.js";
import type { FactoryConfig } from "./config.js";
import { parseItemMarkdown } from "./frontmatter.js";
import { appendEntry, loadKbSnapshot, projectKbFile, repoSlug } from "./kb.js";
import { stamp } from "./util.js";

/** PR publication happens on the host, outside the stage seam. Never merges. */
export interface PrPublishRequest {
  item: ItemContext;
  body: string;
  repoPath: string;
  branchName: string;
  base: string;
  draft: boolean;
}

export interface PrPublisher {
  publish(req: PrPublishRequest): Promise<PrPublishResult>;
}

export interface TickEntry {
  id: number;
  slug: string;
  fromStage: StageName;
  status: ItemStatus;
  detail: string;
}

export interface TickReport {
  entries: TickEntry[];
  changed: boolean;
}

export interface OrchestratorDeps {
  db: FactoryDb;
  paths: FactoryPaths;
  config: FactoryConfig;
  runner: StageRunner;
  curator: CuratorRunner | null;
  publisher: PrPublisher;
  sleep: (ms: number) => Promise<void>;
}

export class Orchestrator {
  private readonly db: FactoryDb;
  private readonly paths: FactoryPaths;
  private readonly config: FactoryConfig;
  private readonly runner: StageRunner;
  private readonly curator: CuratorRunner | null;
  private readonly publisher: PrPublisher;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: OrchestratorDeps) {
    this.db = deps.db;
    this.paths = deps.paths;
    this.config = deps.config;
    this.runner = deps.runner;
    this.curator = deps.curator;
    this.publisher = deps.publisher;
    this.sleep = deps.sleep;
  }

  // ------------------------------------------------------------------ tick

  /** Advance every currently-actionable item one stage (sequential). */
  async tickAll(): Promise<TickReport> {
    const report: TickReport = { entries: [], changed: false };
    for (const item of this.db.itemsWithStatus(ACTIONABLE_STATUSES)) {
      const entry = await this.tickItem(item);
      report.entries.push(entry);
      report.changed = true;
    }
    return report;
  }

  /**
   * Crash/interruption recovery: restart human-rejected items (their reason
   * rides as feedback into the next agent run), then keep ticking until no
   * item changes state.
   */
  async resume(): Promise<TickReport> {
    for (const item of this.db.itemsWithStatus(["human-rejected"])) {
      this.db.updateItem(item.id, { status: "queued" });
      this.db.appendHistory(item.id, "unparked", item.stage, { via: "resume", feedback: item.feedback });
    }
    const combined: TickReport = { entries: [], changed: false };
    for (let i = 0; i < 500; i++) {
      const report = await this.tickAll();
      combined.entries.push(...report.entries);
      if (!report.changed) break;
      combined.changed = true;
    }
    return combined;
  }

  // ------------------------------------------------------------------ verbs

  approve(itemId: number, note?: string): ItemRecord {
    const item = this.requireItem(itemId);
    this.requireStatus(item, "awaiting-approval");
    const approvedStage = (item.parkedDetail?.stage as string | undefined) ?? item.stage;
    this.saveOperatorArtifact(item, `approval-${approvedStage}`,
      `# approval after ${approvedStage}\n\ndecision: approved\n${note ? `note: ${note}\n` : ""}`);
    this.db.updateItem(item.id, {
      status: "queued",
      parkedReason: null,
      parkedDetail: null,
    });
    this.db.appendHistory(item.id, "approved", item.stage, { note: note ?? null, nextStage: item.stage });
    return this.db.getItem(item.id)!;
  }

  rejectItem(itemId: number, reason: string): ItemRecord {
    const item = this.requireItem(itemId);
    this.requireStatus(item, "awaiting-approval");
    // Human feedback routes into the completed stage: it re-runs with the
    // reason as feedback on the next tick.
    const completedStage = previousStage(item.stage);
    this.saveOperatorArtifact(item, `rejection-${completedStage}`,
      `# human rejection after ${completedStage}\n\ndecision: rejected\nreason: ${reason}\n\nThe reason above is fed as feedback when the item is resumed.`);
    this.db.updateItem(item.id, {
      status: "human-rejected",
      feedback: reason,
      stage: completedStage,
      parkedReason: "human-rejected",
      parkedDetail: { stage: completedStage, reason },
    });
    this.db.appendHistory(item.id, "rejected-by-human", completedStage, { reason, stage: item.stage });
    return this.db.getItem(item.id)!;
  }

  answer(itemId: number, answers: { question: string; answer: string }[], rawAnswer?: string): ItemRecord {
    const item = this.requireItem(itemId);
    this.requireStatus(item, "needs-human");
    const questions = (item.parkedDetail?.questions as string[] | undefined) ?? [];
    const merged = [
      ...(item.answers ?? []),
      ...normalizeAnswers(questions, answers, rawAnswer),
    ];
    this.saveOperatorArtifact(item, "answers",
      `# answers to triage questions\n\n${merged.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n")}\n\nTriage re-runs with these answers in context.`);
    this.db.updateItem(item.id, {
      answers: merged,
      status: "queued",
      stage: "triage",
      parkedReason: null,
      parkedDetail: null,
    });
    this.db.appendHistory(item.id, "answered", "triage", { answers });
    return this.db.getItem(item.id)!;
  }

  /** On-demand KB curation. Strictly read-only regarding the KB itself. */
  async curate(projects: string[] = []): Promise<{ file: string; proposal: string }> {
    if (!this.curator) throw new Error("no curator runner configured");
    const known = this.db.knownRepos();
    const wanted = projects.length > 0 ? projects : known.map((k) => repoSlug(k.repo));
    const kb = this.loadCurationKb(wanted);
    const repoPaths: Record<string, string> = {};
    for (const project of wanted) {
      const match = known.find((k) => repoSlug(k.repo) === project);
      if (match) {
        const rp = resolveRepoPath(match.repo);
        if (existsSync(rp)) repoPaths[project] = rp;
      }
    }
    const result = await this.curator.propose({ projects: wanted, kb, repoPaths });
    const ts = stamp();
    const name = `curate-${ts}${projects.length === 1 ? `-${projects[0]}` : ""}.md`;
    const dir = this.paths.proposals;
    mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    const content = result.artifacts[0]?.content ?? result.feedback ?? result.report ?? "(empty proposal)";
    writeFileSync(abs, content, "utf8");
    return { file: path.relative(this.paths.root, abs), proposal: content };
  }

  // ------------------------------------------------------------------ per-item

  private async tickItem(item: ItemRecord): Promise<TickEntry> {
    const refreshed = this.refreshFromSource(item);

    if (refreshed.status === "malformed") {
      return { id: item.id, slug: item.slug, fromStage: refreshed.stage, status: "malformed", detail: refreshed.parkedReason ?? "malformed front-matter" };
    }

    const fromStage = refreshed.stage;
    if (fromStage === "pr") {
      return this.runPrStage(refreshed);
    }
    return this.runAgentStage(refreshed);
  }

  /** The item file is the source of truth — approvals etc. are re-read fresh. */
  private refreshFromSource(item: ItemRecord): ItemRecord {
    if (!item.sourceFile || !existsSync(item.sourceFile)) return item;
    const parsed = parseItemMarkdown(readFileSync(item.sourceFile, "utf8"));
    if (!parsed.ok) {
      this.db.updateItem(item.id, {
        status: "malformed",
        parkedReason: `malformed front-matter: ${parsed.reason}`,
        parkedDetail: null,
      });
      this.db.appendHistory(item.id, "parked", null, { reason: parsed.reason });
      return this.db.getItem(item.id)!;
    }
    const p = parsed.item;
    const changed = p.title !== item.title || p.repo !== item.repo || p.base !== item.base ||
      JSON.stringify(p.approvals) !== JSON.stringify(item.approvals);
    if (changed) {
      this.db.updateItem(item.id, {
        title: p.title,
        repo: p.repo,
        base: p.base,
        approvals: [...p.approvals],
      });
      this.db.appendHistory(item.id, "unparked", null, { note: "front-matter edited by operator" });
      item = this.db.getItem(item.id)!;
    }
    return item;
  }

  private async runAgentStage(item: ItemRecord): Promise<TickEntry> {
    const stage = item.stage;
    // Persist before execution: a crash between execute and record re-runs the
    // whole stage (stage-level idempotency).
    this.db.updateItem(item.id, { status: "running" });
    this.db.appendHistory(item.id, "stage-start", stage, { attempt: attemptNo(item, stage) });

    const repoLockAcquired = this.db.acquireRepoLock(repoSlug(item.repo), item.id);
    if (!repoLockAcquired) {
      // Stale lock from a crashed run: strictly-sequential MVP proceeds, but
      // the conflict is on the record.
      this.db.appendHistory(item.id, "stage-start", stage, { lockConflict: true });
    }
    try {
      let infra = 0;
      for (;;) {
        const req = await this.stageRequest(item, stage);
        let result: StageResult;
        try {
          result = await this.runner.runStage(req);
        } catch (err) {
          result = {
            outcome: "infra-fail",
            artifacts: [],
            report: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          };
        }

        if (result.outcome === "infra-fail") {
          infra += 1;
          if (infra > this.config.budgets.maxInfraRetries) {
            const msg = `infrastructure failure after ${infra - 1} retries: ${result.report ?? "(no detail)"}`;
            this.db.updateItem(item.id, {
              status: "infrastructure-failure",
              parkedReason: "infrastructure-failure",
              parkedDetail: { stage, error: result.report ?? null },
              infraAttempts: item.infraAttempts + infra,
            });
            this.db.appendHistory(item.id, "parked", stage, { reason: msg });
            return { id: item.id, slug: item.slug, fromStage: stage, status: "infrastructure-failure", detail: msg };
          }
          const backoff = this.config.budgets.retryBackoffMs * Math.pow(2, infra - 1);
          this.db.appendHistory(item.id, "stage-retry", stage, { attempt: infra, backoffMs: backoff, error: result.report ?? null });
          await this.sleep(backoff);
          continue;
        }
        return this.applyStageResultFor(item, stage, result, infra);
      }
    } finally {
      if (repoLockAcquired) this.db.releaseRepoLock(repoSlug(item.repo), item.id);
    }
  }

  private applyStageResultFor(item: ItemRecord, stage: StageName, result: StageResult, infra: number): TickEntry {
    if (infra > 0) {
      // Persist infra-retry bookkeeping without touching gate budgets.
      this.db.updateItem(item.id, { infraAttempts: item.infraAttempts + infra });
    }
    return this.applyStageResult(item, stage, result);
  }

  private applyStageResult(item: ItemRecord, stage: StageName, result: StageResult): TickEntry {
    // The triage-reject handler saves its report inside the archive dir after
    // the item has been physically moved; everything else saves in place.
    if (result.outcome !== "reject") {
      this.saveArtifacts(item, stage, result);
    }
    const usageDetail: Record<string, unknown> = {
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result.prSummary ? { prSummary: result.prSummary } : {}),
    };

    switch (result.outcome) {
      case "pass":
        return this.handlePass(item, stage, result, usageDetail);
      case "gate-fail":
        return this.handleGateFail(item, stage, result, usageDetail);
      case "reject":
        return this.handleTriageReject(item, stage, result);
      case "needs-human":
        return this.handleNeedsHuman(item, stage, result);
      case "infra-fail":
        throw new Error("infra-fail handled by retry loop");
    }
  }

  private handlePass(item: ItemRecord, stage: StageName, result: StageResult, usageDetail: Record<string, unknown>): TickEntry {
    let attempts = item.gateAttempts;
    if (isGate(stage)) {
      const prev = item.gateAttempts[stage] ?? 0;
      attempts = { ...item.gateAttempts, [stage]: prev + 1 };
      // Post-rework write-moment: only the gate that actually failed gets the
      // "what fixed it" lesson when it finally passes.
      const hadFailures = this.db
        .getHistory(item.id)
        .some((h) => h.event === "stage-gate-fail" && h.stage === stage);
      if (hadFailures) {
        const fix = result.fix ?? result.feedback ?? result.report ?? "(no fix summary)";
        appendEntry(projectKbFile(this.paths, item.repo), "post-rework", repoSlug(item.repo), fix);
      }
    }

    const nextStage = nextStageOf(stage);
    const approvals = item.approvals.filter((s) => (APPROVAL_STAGES as readonly string[]).includes(s));

    let newStatus: ItemStatus = "queued";
    let parkedDetail: Record<string, unknown> | null = null;
    let parkedReason: string | null = null;
    let detail: string;

    if (approvals.includes(stage)) {
      // HITL: park right after the approved stage completes.
      newStatus = "awaiting-approval";
      parkedReason = "awaiting-approval";
      parkedDetail = { stage, doneStage: stage };
      detail = `parked awaiting approval after ${stage}`;
    } else {
      detail = `${stage} passed (attempt ${attempts[stage] ?? 1}); next: ${nextStage}`;
    }

    this.db.updateItem(item.id, {
      stage: nextStage,
      status: newStatus,
      parkedReason,
      parkedDetail,
      gateAttempts: attempts,
      feedback: null,
    });
    this.db.appendHistory(item.id, "stage-pass", stage, { nextStage, ... usageDetail });
    if (newStatus === "awaiting-approval") {
      this.db.appendHistory(item.id, "parked", stage, { reason: "awaiting-approval" });
    }
    return { id: item.id, slug: item.slug, fromStage: stage, status: newStatus, detail };
  }

  private handleGateFail(item: ItemRecord, stage: StageName, result: StageResult, usageDetail: Record<string, unknown>): TickEntry {
    const attemptsNow = (item.gateAttempts[stage] ?? 0) + 1;
    const attempts = { ...item.gateAttempts, [stage]: attemptsNow };

    // Failed-gate write-moment.
    const lesson = result.lesson ?? result.feedback ?? result.report ?? "(gate failed, no lesson captured)";
    appendEntry(projectKbFile(this.paths, item.repo), "failed-gate", repoSlug(item.repo), lesson);
    this.db.appendHistory(item.id, "stage-gate-fail", stage, { attempt: attemptsNow, ...usageDetail });

    const budget = this.config.budgets.maxGateAttempts;
    if (attemptsNow >= budget) {
      const detail = `exhausted ${stage} rework budget (${attemptsNow} attempts)`;
      this.db.updateItem(item.id, {
        status: "exhausted-rework",
        parkedReason: "exhausted-rework",
        parkedDetail: { stage, attempts: attemptsNow },
        gateAttempts: attempts,
        feedback: result.feedback ?? null,
      });
      this.db.appendHistory(item.id, "parked", stage, { reason: "exhausted-rework", rounds: attemptsNow, ...usageDetail });
      return { id: item.id, slug: item.slug, fromStage: stage, status: "exhausted-rework", detail };
    }

    // Bounded rework: feedback feeds the stage under examination; implement is
    // the fix venue for both gates (implement -> test -> review re-runs).
    const target = reworkTarget(stage);
    this.db.updateItem(item.id, {
      stage: target,
      status: "queued",
      feedback: result.feedback ?? result.report ?? null,
      gateAttempts: attempts,
    });
    return { id: item.id, slug: item.slug, fromStage: stage, status: "queued", detail: `${stage} failed (attempt ${attemptsNow}); feedback → ${target}` };
  }

  private handleTriageReject(item: ItemRecord, stage: StageName, result: StageResult): TickEntry {
    // Terminal: archive with the triage report attached. Resurrectable by
    // re-dropping the file in the inbox.
    const dir = itemDir(this.paths, item.slug);
    const archiveName = existsSync(path.join(this.paths.archive, item.slug))
      ? `${item.slug}-2`
      : item.slug;
    const archiveDir = path.join(this.paths.archive, archiveName);
    mkdirSync(this.paths.archive, { recursive: true });
    if (existsSync(dir)) renameSync(dir, archiveDir);

    // Report artifacts land inside the archived item dir (paths stay valid).
    this.saveArtifacts(item, stage, result, archiveDir + "/artifacts");

    this.db.updateItem(item.id, {
      status: "rejected",
      stage: "triage",
      parkedReason: "triage-rejected",
      parkedDetail: { report: (result.report ?? "").slice(0, 1000) },
    });
    this.db.appendHistory(item.id, "archived", "triage", { report: (result.report ?? "").slice(0, 1000) });
    return { id: item.id, slug: item.slug, fromStage: stage, status: "rejected", detail: result.report ?? "archived by triage" };
  }

  private handleNeedsHuman(item: ItemRecord, stage: StageName, result: StageResult): TickEntry {
    const questions = result.questions ?? [];
    this.saveQuestionArtifact(item, questions);
    this.db.updateItem(item.id, {
      status: "needs-human",
      stage: "triage",
      parkedReason: "needs-human",
      parkedDetail: { stage, questions },
    });
    this.db.appendHistory(item.id, "parked", stage, { reason: "needs-human", questions });
    return {
      id: item.id,
      slug: item.slug,
      fromStage: stage,
      status: "needs-human",
      detail: questions.length > 0 ? `questions: ${questions.join(" | ")}` : "parked for a human",
    };
  }

  // ------------------------------------------------------------------ PR stage

  private async runPrStage(item: ItemRecord): Promise<TickEntry> {
    this.db.updateItem(item.id, { status: "running" });
    this.db.appendHistory(item.id, "stage-start", "pr", {});

    let infra = 0;
    for (;;) {
      try {
        const ctx = this.contextOf(item);
        const body = this.buildPrBody(item);
        const draft = item.approvals.length > 0;
        const pr = await this.publisher.publish({
          item: ctx,
          body,
          repoPath: resolveRepoPath(item.repo),
          branchName: item.branchName,
          base: item.base,
          draft,
        });
        const prSummary = this.lastPrSummary(item.id) ?? `${item.title}: PR ${pr.number} created (${draft ? "draft" : "ready-for-review"})`;
        appendEntry(projectKbFile(this.paths, item.repo), "pr-outcome", repoSlug(item.repo), prSummary);
        this.db.updateItem(item.id, { status: "done", parkedReason: null, parkedDetail: { prUrl: pr.url, prNumber: pr.number, draft } });
        this.db.appendHistory(item.id, "pr-created", "pr", { url: pr.url, number: pr.number, draft });
        return { id: item.id, slug: item.slug, fromStage: "pr", status: "done", detail: `PR ${pr.url}${draft ? " (draft)" : ""}` };
      } catch (err) {
        infra += 1;
        const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (infra > this.config.budgets.maxInfraRetries) {
          this.db.updateItem(item.id, {
            status: "infrastructure-failure",
            parkedReason: "infrastructure-failure",
            parkedDetail: { stage: "pr", error },
          });
          this.db.appendHistory(item.id, "parked", "pr", { reason: error });
          return { id: item.id, slug: item.slug, fromStage: "pr", status: "infrastructure-failure", detail: error };
        }
        await this.sleep(this.config.budgets.retryBackoffMs * Math.pow(2, infra - 1));
      }
    }
  }

  private buildPrBody(item: ItemRecord): string {
    const artifacts = this.db.getArtifacts(item.id);
    const read = (rel: string): string => {
      const abs = path.join(this.paths.root, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : "(missing)";
    };
    const find = (needle: string): string | undefined => {
      const a = artifacts.find((x) => x.name.toLowerCase().includes(needle) || x.stage === needle);
      return a ? read(a.path) : undefined;
    };
    const request = item.sourceFile && existsSync(item.sourceFile) ? readFileSync(item.sourceFile, "utf8") : "(missing)";
    const spec = find("spec");
    const review = find("review");

    const lines: string[] = [];
    lines.push(`# ${item.title}`, "");
    lines.push(`Item \`${item.slug}\` (#${item.id}) — produced by the software factory. Factory never merges: review, then merge yourself.`, "");
    lines.push("## Request", "", "```markdown", request.trim(), "```", "");
    if (spec) {
      lines.push("## Spec", "", spec, "");
    }
    if (review) {
      lines.push("## Review verdict", "", review, "");
    }
    lines.push("## Rework history", "");
    const history = this.db.getHistory(item.id);
    const rework = history.filter((h) => h.event === "stage-gate-fail" || h.event === "stage-retry" || h.event === "answered" || h.event === "rejected-by-human");
    if (rework.length === 0) lines.push("None — first pass.", "");
    for (const h of rework) lines.push(`- ${h.ts} ${h.event}${h.stage ? ` @${h.stage}` : ""}: ${JSON.stringify(h.detail).slice(0, 200)}`);
    lines.push("");
    lines.push("## Artifact index", "");
    for (const a of artifacts) lines.push(`- ${a.name} — \`${a.path}\``);
    lines.push("");
    return lines.join("\n");
  }

  private lastPrSummary(itemId: number): string | undefined {
    const history = this.db.getHistory(itemId).filter((h) => h.event === "stage-pass");
    for (let i = history.length - 1; i >= 0; i--) {
      const s = history[i]!.detail["prSummary"];
      if (typeof s === "string" && s.length > 0) return s;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ plumbing

  private async stageRequest(item: ItemRecord, stage: StageName) {
    const ctx = this.contextOf(item);
    const kb = loadKbSnapshot(this.paths, item.repo, { lightweight: stage === "triage" });
    return { stage, item: ctx, kb };
  }

  private contextOf(item: ItemRecord): ItemContext {
    // Body reads fresh from the item file on every run.
    let body = "";
    if (item.sourceFile && existsSync(item.sourceFile)) {
      const parsed = parseItemMarkdown(readFileSync(item.sourceFile, "utf8"));
      if (parsed.ok) body = parsed.item.body;
    }
    const answers = item.answers ?? [];
    const spec = this.latestArtifactContent(item.id, "spec");
    return {
      id: item.id,
      slug: item.slug,
      title: item.title,
      repo: resolveRepoPath(item.repo),
      base: item.base,
      approvals: item.approvals,
      body,
      ...(spec ? { spec } : {}),
      feedback: item.feedback ?? undefined,
      answers: answers.length > 0 ? answers : undefined,
      branchName: item.branchName,
    };
  }

  /** Content of the most recent artifact with the given name, absolute-resolved. */
  private latestArtifactContent(itemId: number, name: string): string | undefined {
    const artifact = [...this.db.getArtifacts(itemId)].reverse().find((a) => a.name === name);
    if (!artifact) return undefined;
    const abs = path.join(this.paths.root, artifact.path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  }

  private saveArtifacts(item: ItemRecord, stage: StageName, result: StageResult, dirOverride?: string): void {
    const dir = dirOverride ?? artifactDir(this.paths, item.slug);
    for (const a of result.artifacts) {
      mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, `${stamp()}-${stage}-${a.name}.md`);
      writeFileSync(abs, a.content, "utf8");
      this.db.addArtifact(item.id, stage, a.name, path.relative(this.paths.root, abs));
    }
    if (result.report && !result.artifacts.some((a) => a.content === result.report)) {
      mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, `${stamp()}-${stage}-report.md`);
      writeFileSync(abs, result.report, "utf8");
      this.db.addArtifact(item.id, stage, `${stage}-report`, path.relative(this.paths.root, abs));
    }
  }

  private saveQuestionArtifact(item: ItemRecord, questions: string[]): void {
    if (questions.length === 0) return;
    const dir = artifactDir(this.paths, item.slug);
    mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, `${stamp()}-triage-questions.md`);
    writeFileSync(abs, questions.map((q) => `- ${q}`).join("\n"), "utf8");
    this.db.addArtifact(item.id, "triage", "triage-questions", path.relative(this.paths.root, abs));
  }

  private loadCurationKb(projects: string[]): KbSnapshot {
    const global = loadKbSnapshot(this.paths, undefined, {}).global;
    const parts: string[] = [];
    for (const project of projects) {
      const repo = this.resolveProjectRepo(project);
      if (repo) parts.push(loadKbSnapshot(this.paths, repo, {}).project);
    }
    return { global, project: parts.join("\n") };
  }

  private resolveProjectRepo(slug: string): string | undefined {
    const known = this.db.knownRepos();
    return known.find((k) => repoSlug(k.repo) === slug)?.repo;
  }

  /** Operator decisions are first-class artifacts (ticket 04/07). */
  private saveOperatorArtifact(item: ItemRecord, name: string, content: string): void {
    const dir = artifactDir(this.paths, item.slug);
    mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, `${stamp()}-${name}.md`);
    writeFileSync(abs, content, "utf8");
    this.db.addArtifact(item.id, null, name, path.relative(this.paths.root, abs));
  }

  private requireItem(itemId: number): ItemRecord {
    const item = this.db.getItem(itemId);
    if (!item) throw new Error(`unknown item id ${itemId}`);
    return item;
  }

  private requireStatus(item: ItemRecord, ...allowed: ItemStatus[]): void {
    if (!allowed.includes(item.status)) {
      throw new Error(`item ${item.slug} is ${item.status}; expected ${allowed.join("/")}`);
    }
  }
}

// ---------------------------------------------------------------- helpers

export function isGate(stage: StageName): boolean {
  return (GATE_STAGES as readonly string[]).includes(stage);
}

export function nextStageOf(stage: StageName): StageName {
  const idx = STAGES.indexOf(stage);
  return STAGES[Math.min(idx + 1, STAGES.length - 1)]!;
}

export function previousStage(stage: StageName): StageName {
  const idx = STAGES.indexOf(stage);
  return STAGES[Math.max(idx - 1, 0)]!;
}

/** Where gate feedback routes: both gates fix via a re-run of implement. */
export function reworkTarget(stage: StageName): StageName {
  return "implement";
}

function attemptNo(item: ItemRecord, stage: StageName): number {
  return (item.gateAttempts[stage] ?? 0) + 1;
}

function normalizeAnswers(
  questions: string[],
  answers: { question: string; answer: string }[],
  rawAnswer?: string,
): { question: string; answer: string }[] {
  if (answers.length > 0) return answers;
  if (rawAnswer && questions.length > 0) {
    return [{ question: questions[0]!, answer: rawAnswer }];
  }
  if (rawAnswer) return [{ question: "(free-form)", answer: rawAnswer }];
  return [];
}

function resolveRepoPath(repo: string): string {
  return path.isAbsolute(repo) ? repo : path.resolve(repo);
}