/**
 * Domain types shared across the factory.
 *
 * The StageRunner port in `runner.ts` is the one seam: everything above it
 * (state machine, gates, rework loop, parking, CLI) deals only in these types.
 */

export const STAGES = [
  "triage",
  "spec",
  "implement",
  "test",
  "review",
  "pr",
] as const;

export type StageName = (typeof STAGES)[number];

/** Stages whose failure feeds rework back to a previous stage. */
export const GATE_STAGES: readonly StageName[] = ["test", "review"];

/** Stages that may be listed in an item's `approvals:` front-matter. */
export const APPROVAL_STAGES: readonly StageName[] = ["triage", "spec", "implement", "test", "review"];

export type StageOutcome =
  | "pass"
  | "gate-fail"
  | "reject"
  | "needs-human"
  | "infra-fail";

export interface StageArtifact {
  name: string;
  content: string;
}

export interface StageUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface StageResult {
  outcome: StageOutcome;
  artifacts: StageArtifact[];
  /** Rework feedback for the previous stage (gate-fail). */
  feedback?: string;
  /** Full report text for archiving/parking (gate report, triage report). */
  report?: string;
  /** Questions for the operator (needs-human). */
  questions?: string[];
  /** KB write-moment content authored by the agent. */
  lesson?: string;
  fix?: string;
  prSummary?: string;
  usage?: StageUsage;
  durationMs?: number;
}

export interface ItemContext {
  id: number;
  slug: string;
  title: string;
  repo: string;
  base: string;
  approvals: string[];
  /** Task description — the markdown body of the item file. */
  body: string;
  /** Content of the approved spec artifact, when one exists. */
  spec?: string;
  /** Feedback to incorporate into this run (rework reason, human corrections). */
  feedback?: string;
  /** Operator answers to previously parked triage questions. */
  answers?: { question: string; answer: string }[];
  branchName: string;
}

/** Knowledge base snapshot handed to a stage, trimmed to the stage's layers. */
export interface KbSnapshot {
  global: string;
  project: string;
}

export interface StageRequest {
  stage: StageName;
  item: ItemContext;
  kb: KbSnapshot;
}

/**
 * THE seam. Above this line: state machine, gates, rework loops, parking, CLI.
 * Below this line: one implementation per execution engine (Sandcastle+pi).
 */
export interface StageRunner {
  runStage(req: StageRequest): Promise<StageResult>;
  /** Release runner-held resources (worktrees, mounts) before the DB closes. */
  dispose?(): Promise<void>;
}

export interface PrPublishResult {
  url: string;
  number: number;
  draft: boolean;
}

export interface CuratorRequest {
  /** Repo slugs to consider; empty = all known repos. */
  projects: string[];
  kb: KbSnapshot;
  repoPaths: Record<string, string>;
  /** Present only when the KB exceeds its char budget and is reviewed in
   * bounded, entry-aligned slices. The curator focuses on its slice; the
   * orchestrator merges per-slice proposals into one artifact. */
  batch?: { index: number; total: number };
  /** Compact one-line-per-entry digest index of every KB entry under curation
   * (ticket 10). `global`/`project` mirror `kb`; each is bounded to the same
   * per-layer char budget as its KB layer (possibly truncated with a marker).
   * Multi-batch runs always receive it; a single-batch run receives it only
   * when it fits untruncated. */
  index?: KbSnapshot;
}

/**
 * On-demand KB hygiene pass. Strictly read-only with respect to the KB:
 * its output is a proposal artifact, never a KB edit.
 */
export interface CuratorRunner {
  propose(req: CuratorRequest): Promise<StageResult>;
}

export type ItemStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "human-rejected"
  | "needs-human"
  | "exhausted-rework"
  | "infrastructure-failure"
  | "rejected"
  | "malformed"
  | "done";

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export type HistoryEvent =
  | "claimed"
  | "stage-start"
  | "stage-pass"
  | "stage-gate-fail"
  | "stage-infra-fail"
  | "stage-retry"
  | "archived"
  | "parked"
  | "unparked"
  | "answered"
  | "approved"
  | "rejected-by-human"
  | "pr-created"
  | "resurrected";

export interface HistoryRecord {
  ts: string;
  event: HistoryEvent;
  stage: StageName | null;
  detail: Record<string, unknown>;
}

export interface ArtifactRecord {
  stage: StageName | null;
  name: string;
  path: string;
  createdAt: string;
}

export interface ItemRecord {
  id: number;
  slug: string;
  title: string;
  repo: string;
  base: string;
  approvals: string[];
  stage: StageName;
  status: ItemStatus;
  parkedReason: string | null;
  parkedDetail: Record<string, unknown> | null;
  feedback: string | null;
  answers: QuestionAnswer[];
  sourceFile: string | null;
  branchName: string;
  gateAttempts: Partial<Record<StageName, number>>;
  infraAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export const TERMINAL_STATUSES: readonly ItemStatus[] = ["done", "rejected"];

/** Statuses a tick can act on. */
export const ACTIONABLE_STATUSES: readonly ItemStatus[] = ["queued", "running"];