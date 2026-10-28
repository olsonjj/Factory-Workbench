import * as path from "node:path";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ACTIONABLE_STATUSES, APPROVAL_STAGES, GATE_STAGES, STAGES, type CuratorRunner, type ItemContext, type ItemRecord, type ItemStatus, type KbSnapshot, type PrPublishResult, type StageName, type StageResult, type StageRunner } from "./types.js";
import type { FactoryDb } from "./db.js";
import type { FactoryPaths } from "./paths.js";
import { artifactDir, itemDir } from "./paths.js";
import type { FactoryConfig } from "./config.js";
import { parseItemMarkdown } from "./frontmatter.js";
import { appendEntry, chunkKbLayer, globalKbFile, kbDigestIndex, loadKbSnapshot, projectKbFile, readKbFile, repoSlug, type KbDigestIndex } from "./kb.js";
import { parkMalformed, stamp } from "./util.js";

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
  findExisting(req: { repoPath: string; branchName: string; base: string }): Promise<PrPublishResult | undefined>;
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
  /** True when `resume` stopped because it hit its safety tick cap, not because work ran out. */
  capped?: boolean;
}

export interface OrchestratorDeps {
  db: FactoryDb;
  paths: FactoryPaths;
  config: FactoryConfig;
  runner: StageRunner;
  curator: CuratorRunner | null;
  publisher: PrPublisher;
  sleep: (ms: number) => Promise<void>;
  /** Safety cap for `resume`'s inner tick loop (default 500). */
  maxResumeTicks?: number;
}

export class Orchestrator {
  private readonly db: FactoryDb;
  private readonly paths: FactoryPaths;
  private readonly config: FactoryConfig;
  private readonly runner: StageRunner;
  private readonly curator: CuratorRunner | null;
  private readonly publisher: PrPublisher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxResumeTicks: number;

  constructor(deps: OrchestratorDeps) {
    this.db = deps.db;
    this.paths = deps.paths;
    this.config = deps.config;
    this.runner = deps.runner;
    this.curator = deps.curator;
    this.publisher = deps.publisher;
    this.sleep = deps.sleep;
    this.maxResumeTicks = deps.maxResumeTicks ?? 500;
  }

  // ------------------------------------------------------------------ tick

  /** Advance every currently-actionable item one stage (sequential). */
  async tickAll(): Promise<TickReport> {
    const report: TickReport = { entries: [], changed: false };
    for (const item of this.db.itemsWithStatus(ACTIONABLE_STATUSES)) {
      let entry: TickEntry;
      try {
        entry = await this.tickItem(item);
      } catch (err) {
        entry = this.parkUnexpectedError(item, err);
      }
      report.entries.push(entry);
      report.changed = true;
    }
    return report;
  }

  /** One bad item parks cleanly; the rest of the tick continues. */
  private parkUnexpectedError(item: ItemRecord, err: unknown): TickEntry {
    const stage = item.stage;
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.db.updateItem(item.id, {
      status: "infrastructure-failure",
      parkedReason: "unhandled-error",
      parkedDetail: { stage, error: message },
    });
    this.db.appendHistory(item.id, "parked", stage, { reason: "unhandled-error", error: message });
    return { id: item.id, slug: item.slug, fromStage: stage, status: "infrastructure-failure", detail: message };
  }

  /**
   * Crash/interruption recovery: restart human-rejected items (their reason
   * rides as feedback into the next agent run), then keep ticking until no
   * item changes state or the safety tick cap is reached.
   */
  async resume(): Promise<TickReport> {
    const maxTicks = this.maxResumeTicks;
    for (const item of this.db.itemsWithStatus(["human-rejected"])) {
      this.db.updateItem(item.id, { status: "queued", parkedReason: null, parkedDetail: null });
      this.db.appendHistory(item.id, "unparked", item.stage, { via: "resume", feedback: item.feedback });
    }
    const combined: TickReport = { entries: [], changed: false };
    let capped = false;
    for (let i = 0; i < maxTicks; i++) {
      const report = await this.tickAll();
      combined.entries.push(...report.entries);
      if (!report.changed) break;
      combined.changed = true;
      if (i === maxTicks - 1) capped = true;
    }
    return { ...combined, capped };
  }

  /** Re-queue an item parked by infra failure, exhausted rework, or malformed front-matter. */
  retry(itemId: number): ItemRecord {
    const item = this.requireItem(itemId);
    if (item.status === "malformed") {
      if (!item.sourceFile || !existsSync(item.sourceFile)) {
        throw new Error(`item ${item.slug} has no source file to re-parse`);
      }
      const parsed = parseItemMarkdown(readFileSync(item.sourceFile, "utf8"));
      if (!parsed.ok) throw new Error(`still malformed: ${parsed.reason}`);
      this.db.updateItem(item.id, {
        title: parsed.item.title,
        repo: parsed.item.repo,
        base: parsed.item.base,
        approvals: [...parsed.item.approvals],
        stage: "triage",
        status: "queued",
        parkedReason: null,
        parkedDetail: null,
      });
      this.db.appendHistory(item.id, "unparked", "triage", { via: "retry", note: "front-matter fixed" });
    } else if (item.status === "exhausted-rework") {
      const failedStage = (item.parkedDetail?.stage as StageName | undefined) ?? item.stage;
      const attempts = { ...item.gateAttempts };
      delete attempts[failedStage]; // fresh budget for that gate
      this.db.updateItem(item.id, {
        stage: reworkTarget(failedStage), // implement is the fix venue
        status: "queued",
        gateAttempts: attempts,
        parkedReason: null,
        parkedDetail: null, // keep `feedback` so implement sees it
      });
      this.db.appendHistory(item.id, "unparked", failedStage, { via: "retry", resetGate: failedStage });
    } else if (item.status === "infrastructure-failure") {
      this.db.updateItem(item.id, { status: "queued", parkedReason: null, parkedDetail: null });
      this.db.appendHistory(item.id, "unparked", item.stage, { via: "retry" });
    } else {
      throw new Error(
        `item ${item.slug} is ${item.status}; retry applies to malformed, exhausted-rework, or infrastructure-failure`,
      );
    }
    return this.db.getItem(item.id)!;
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
    const kb = this.loadFullCurationKb(wanted);
    const repoPaths: Record<string, string> = {};
    for (const project of wanted) {
      const match = known.find((k) => repoSlug(k.repo) === project);
      if (match) {
        const rp = resolveRepoPath(match.repo);
        repoPaths[project] = rp;
      }
    }
    // Curation must see every entry ever appended, but prompts must stay
    // bounded: oversized layers are chunked at entry boundaries and reviewed
    // in sequential batches; per-batch proposals are merged into one artifact.
    const globalChunks = chunkKbLayer(kb.global, this.config.kb.maxGlobalChars);
    const projectChunks = chunkKbLayer(kb.project, this.config.kb.maxProjectChars);
    const batches = Math.max(globalChunks.length, projectChunks.length, 1);
    const globalIndex = kbDigestIndex(kb.global, this.config.kb.maxGlobalChars, batches);
    const projectIndex = kbDigestIndex(kb.project, this.config.kb.maxProjectChars, batches);
    // Single-batch runs only get the index when it fits untruncated; multi-batch
    // runs always get it (it is budget-bounded either way).
    const indexFits = !globalIndex.truncated && !projectIndex.truncated;
    const index: KbSnapshot | undefined =
      globalIndex.text || projectIndex.text
        ? { global: globalIndex.text, project: projectIndex.text }
        : undefined;
    const proposalOf = (r: StageResult): string => r.artifacts[0]?.content ?? r.feedback ?? r.report ?? "(empty proposal)";
    const ts = stamp();
    const name = `curate-${ts}${projects.length === 1 ? `-${projects[0]}` : ""}.md`;
    const dir = this.paths.proposals;
    mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    // Save via temp-file + atomic rename: writeFileSync truncates the
    // destination in place, so a crash or disk-full mid-save could erase the
    // only copy of earlier batches' proposals. rename over the target is
    // atomic — the operator's saved proposals are never half-written.
    const tmp = `${abs}.tmp-${process.pid}`;
    const save = (content: string): void => {
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, abs);
    };
    const file = path.relative(this.paths.root, abs);

    if (batches === 1) {
      // Build the request from the computed chunks even for a single batch: a
      // lone entry larger than the budget was boundary-truncated by
      // chunkKbLayer, and the full uncapped layer must not bypass that bound.
      const result = await this.curator.propose({
        projects: wanted,
        kb: { global: globalChunks[0] ?? "", project: projectChunks[0] ?? "" },
        repoPaths,
        ...(index && indexFits ? { index } : {}),
      });
      const content = proposalOf(result);
      save(content);
      return { file, proposal: content };
    }

    const note = (status: string): string =>
      `> ${status} The knowledge base exceeded its prompt budget and was reviewed in ${batches} entry-aligned batches. Each batch also received a digest index of every KB entry (date, scope, first line, batch) and was asked to flag cross-batch contradictions and merge candidates against it, naming the batch whose full text to check. The index is lossy, so findings spanning batch boundaries are still possible — cross-check batches 1..${batches} manually before applying.\n\n`;
    const sections: string[] = [];
    for (let i = 0; i < batches; i++) {
      const slice: KbSnapshot = {
        global: globalChunks[i] ?? "",
        project: projectChunks[i] ?? "",
      };
      let proposal: string;
      try {
        const result = await this.curator.propose({
          projects: wanted,
          kb: slice,
          repoPaths,
          batch: { index: i + 1, total: batches },
          ...(index ? { index } : {}),
        });
        proposal = proposalOf(result);
      } catch (err) {
        const done = sections.length;
        if (done > 0) {
          // Completed batches are persisted even when a later batch fails —
          // each is a paid agent run the operator should not have to repeat.
          save(note(`INCOMPLETE: ${done} of ${batches} batches completed; re-run after fixing the failure.`) + sections.join("\n\n---\n\n"));
        }
        throw new Error(
          `curation batch ${i + 1} of ${batches} failed: ${err instanceof Error ? err.message : String(err)}` +
            (done > 0 ? ` — proposals from completed batches saved in ${file}` : " — no batches had completed; nothing to save"),
        );
      }
      sections.push(`# curation batch ${i + 1} of ${batches}\n\n${proposal}`);
      if (i < batches - 1) {
        // Incremental persistence after every batch for the same reason.
        save(note(`PARTIAL: ${sections.length} of ${batches} batches completed so far.`) + sections.join("\n\n---\n\n"));
      }
    }
    const content = note("NOTE") + sections.join("\n\n---\n\n");
    save(content);
    return { file, proposal: content };
  }

  /** Release runner-held resources (worktrees, mounts) before the DB closes. */
  async dispose(): Promise<void> {
    await this.runner.dispose?.();
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
      parkMalformed(this.db, item, parsed.reason);
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

    let repoLockAcquired = false;
    try {
      repoLockAcquired = this.db.acquireRepoLock(repoSlug(item.repo), item.id);
      if (!repoLockAcquired) {
        // Stale lock from a crashed run: strictly-sequential MVP proceeds, but
        // the conflict is on the record.
        this.db.appendHistory(item.id, "stage-start", stage, { lockConflict: true });
      }
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
        const existing = await this.publisher.findExisting({
          repoPath: resolveRepoPath(item.repo),
          branchName: item.branchName,
          base: item.base,
        });
        if (existing) {
          const prSummary = this.lastPrSummary(item.id)
            ?? `${item.title}: PR ${existing.number} already existed (${existing.draft ? "draft" : "ready-for-review"})`;
          appendEntry(projectKbFile(this.paths, item.repo), "pr-outcome", repoSlug(item.repo), prSummary);
          this.db.updateItem(item.id, {
            status: "done",
            parkedReason: null,
            parkedDetail: { prUrl: existing.url, prNumber: existing.number, draft: existing.draft },
          });
          this.db.appendHistory(item.id, "pr-created", "pr", {
            url: existing.url,
            number: existing.number,
            draft: existing.draft,
            recoveredExisting: true,
          });
          return { id: item.id, slug: item.slug, fromStage: "pr", status: "done", detail: `PR ${existing.url} (recovered existing)` };
        }
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
      return existsSync(abs) ? readFileSync(abs, "utf8") : "";
    };
    // Exact-name structured lookups — never fuzzy substring over logs.
    const latest = (name: string): string => {
      const a = [...artifacts].reverse().find((x) => x.name === name);
      return a ? read(a.path) : "";
    };

    const spec = latest("spec");
    const testReport = latest("test-report");
    const reviewVerdict = latest("review-verdict");
    const implementLog = latest("implement-log");

    let fallbackBody = "";
    if (item.sourceFile && existsSync(item.sourceFile)) {
      const parsed = parseItemMarkdown(readFileSync(item.sourceFile, "utf8"));
      if (parsed.ok) fallbackBody = parsed.item.body;
    }

    const summary = leadParagraph(spec, fallbackBody);
    const diffStat = computeDiffStat(resolveRepoPath(item.repo), item.base, item.branchName);
    const artDir = `${path.relative(this.paths.root, artifactDir(this.paths, item.slug))}/`;

    const lines: string[] = [];
    lines.push("## Summary", "");
    lines.push(`**${item.title}** — ${summary}`, "");
    if (diffStat) {
      lines.push("```text", diffStat, "```", "");
    } else {
      lines.push("_diff stat unavailable at PR-body time (repo not reachable)._", "");
    }

    lines.push("## Evidence", "");
    lines.push(`- Test: ${testReport ? digest(testReport) : "(no test artifact)"}`, "");
    lines.push(`- Review: ${reviewVerdict ? digest(reviewVerdict) : "(no review artifact)"}`, "");
    lines.push(`- Commits: ${implementLog ? digest(implementLog) : "(no implement artifact)"}`, "");
    lines.push("Artifacts produced by this run:", "");
    for (const a of artifacts) {
      lines.push(`- ${a.name} — \`${a.path}\` — ${digest(read(a.path))}`);
    }
    lines.push("");

    lines.push("## Merge Danger", "");
    lines.push(
      `- Door: two-way at the branch level — discard or \`git revert\` the PR (\`${item.branchName}\`) undoes the code; the factory never merges. Lasting effects beyond the branch (migrations, published packages, external calls) are not automatically assessed — check the artifact list above before merging.`,
      "",
    );
    lines.push(`- Blast Radius: ${blastRadius(diffStat)}`, "");
    lines.push(`artifacts: ${artDir}`, "");

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
    const kb = loadKbSnapshot(this.paths, item.repo, {
      lightweight: stage === "triage",
      maxGlobalChars: this.config.kb.maxGlobalChars,
      maxProjectChars: this.config.kb.maxProjectChars,
    });
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

  /** Curation reads the FULL layers, uncapped — unlike stage prompts, the
   * curator must see older entries to judge contradictions, staleness, and
   * merge candidates. Bounded prompts are preserved by batch slicing in
   * curate(). */
  private loadFullCurationKb(projects: string[]): KbSnapshot {
    const global = readKbFile(globalKbFile(this.paths));
    const parts: string[] = [];
    for (const project of projects) {
      const repo = this.resolveProjectRepo(project);
      if (repo) {
        parts.push(readKbFile(projectKbFile(this.paths, repo)));
      }
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

/** Structured diff stat for the PR body's "shape of the change" visual. */
function computeDiffStat(repoPath: string, base: string, branchName: string): string {
  try {
    return execFileSync("git", ["diff", "--stat", `${base}...${branchName}`], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch {
    // Repo not reachable at PR-body time (e.g. hermetic tests use a fake path):
    // the caller emits an explicit fallback line, never throws.
    return "";
  }
}

const fenceless = (text: string): string[] =>
  (text ?? "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"));

/** First line that a reader should see: prose, else a stripped first heading. */
function firstReadableLine(text: string): string | undefined {
  const lines = fenceless(text);
  if (lines.length === 0) return undefined;
  const prose = lines.find((l) => !l.startsWith("#"));
  return prose ?? lines[0]!.replace(/^#+\s*/, "");
}

/** Lead paragraph for the Summary section: text, else fallback — both run
 * through the same line selection and 300-char limit, so a long multiline
 * fallback (e.g. the item request) can never reshape the PR body. */
export function leadParagraph(text: string, fallback: string): string {
  const chosen =
    firstReadableLine(text) ?? firstReadableLine(fallback) ?? (fallback.trim() ? fallback.trim() : "");
  return chosen.slice(0, 300);
}

/** Short content digest for an artifact: the first line a reader should see.
 * A leading bare section label ("# Test results") would hide the result, so
 * the first prose line wins — but a heading that carries the datum
 * ("# verdict: pass") is kept (':' marks data-bearing headings). */
export function digest(text: string): string {
  const lines = fenceless(text);
  if (lines.length === 0) return "(empty)";
  const first = lines[0]!;
  let line: string;
  if (first.startsWith("#")) {
    const bare = first.replace(/^#+\s*/, "");
    const prose = lines.find((l) => !l.startsWith("#"));
    line = bare.includes(":") || !prose ? first : prose;
  } else {
    line = first;
  }
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** Human-readable blast-radius summary derived from git's `--stat` output. */
function blastRadius(diffStat: string): string {
  if (!diffStat) return "unknown — diff stat unavailable";
  const paths = diffStat
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(" | "))
    .map((l) => l.slice(0, l.indexOf(" | ")).trim());
  const dirs = [...new Set(paths.map((p) => p.split("/")[0]).filter((d): d is string => (d?.length ?? 0) > 0))];
  return `${paths.length} file(s) changed in ${dirs.length > 0 ? dirs.join(", ") : "the repo root"}`;
}

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

/** Match one raw answer to each parked question, in order. */
export function matchAnswers(questions: string[], raw: string[]): { question: string; answer: string }[] {
  if (raw.length !== questions.length) {
    throw new Error(`expected ${questions.length} answer(s) for ${questions.length} question(s), got ${raw.length}`);
  }
  return questions.map((q, i) => ({ question: q, answer: raw[i]! }));
}

function normalizeAnswers(
  questions: string[],
  answers: { question: string; answer: string }[],
  rawAnswer?: string,
): { question: string; answer: string }[] {
  if (answers.length > 0) return answers;
  if (rawAnswer) {
    if (questions.length === 0) return [{ question: "(free-form)", answer: rawAnswer }];
    if (questions.length === 1) return [{ question: questions[0]!, answer: rawAnswer }];
    throw new Error(`expected ${questions.length} answers (one per question); pass -a per question`);
  }
  return [];
}

function resolveRepoPath(repo: string): string {
  return path.isAbsolute(repo) ? repo : path.resolve(repo);
}