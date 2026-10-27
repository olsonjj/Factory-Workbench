# Spec: Software Factory MVP

## Problem Statement

I want to feed my coding tasks to AI agents and get finished, reviewed, pull-request-ready work back — without sitting at a terminal shepherding each step. Today, using `pi` directly means I am the pipeline: I decide what to work on, I write the context, I review the output, I run the tests, I check the diff, I push and open the PR. Nothing is remembered between tasks, nothing survives an interruption, and the quality gates I *should* apply (tests, security review, best-practices review) are the first thing skipped when I'm busy.

I want a "software factory": a system where I drop in a markdown task file and a pull request comes out — with the intermediate stages (triage, specification, implementation, testing, review) handled by agents, the decisions recorded, the failures bounded, and the whole thing resumable after a crash, a stall, or my going to bed.

## Solution

A small, sequentially-processing software factory built on `pi` (as the agent harness inside sandboxes) and Sandcastle (for Docker-based sandboxing, git worktrees, and branch strategy). Work is ingested by dropping markdown files into an inbox folder. Each file is the durable source of truth for a work item; a SQLite-backed state machine tracks its progress through the pipeline: **triage → spec → implement → test → review → pull request**.

The factory is a local CLI with tick-based execution (`wb run` / `wb resume`), not a daemon. Agents never touch my filesystem — every stage runs in a Sandcastle Docker sandbox bound to a git worktree of the target repo, and commits land on a named branch. The final stage creates a GitHub pull request whose body is an audit trail assembled from the pipeline's artifacts; the factory never merges.

Human-in-the-loop is configurable per item and per stage: as items gain my trust I remove approval gates from the front-matter, and the factory takes more of the pipeline AFK. A dated, append-only markdown knowledge base (global + per-project) lets stages learn from failed gates and rework rounds, with an on-demand curator pass to keep it from going stale.

## User Stories

1. As a factory operator, I want to drop a markdown file into an inbox folder, so that submitting work to the factory requires no commands or UI.
2. As a factory operator, I want the markdown file itself to be the work item's source of truth, so that I can read, edit, and understand any item without querying a database.
3. As a factory operator, I want structured front-matter (title, target repo, base branch, approval gates) on each item, so that the factory knows where to work and how much to automate.
4. As a factory operator, I want the factory to claim inbox files by moving them into its item store, so that a file cannot be ingested twice.
5. As a factory operator, I want the factory to rescan the inbox on startup, so that recovery after downtime requires no special handling.
6. As a factory operator, I want each item tracked in SQLite by stage, status, attempt counts, and artifact paths, so that the factory's progress survives crashes and restarts.
7. As a factory operator, I want `wb run` to process every currently-actionable item one stage further, so that I can advance the factory on demand without a long-running process.
8. As a factory operator, I want `wb resume` to continue items parked by crashes or interruptions from their last recorded stage, so that nothing is ever silently lost.
9. As a factory operator, I want triage to decide whether an item can be worked on, so that junk or dangerous tasks never reach implementation.
10. As a factory operator, I want triage to have three outcomes (proceed, reject, needs-human), so that "no" and "I can't tell yet" are treated differently.
11. As a factory operator, I want rejected items archived with their triage report attached, so that I can later see why work was refused.
12. As a factory operator, I want to resurrect an archived item by re-dropping its file in the inbox, so that rejection is never an irreversible dead end.
13. As a factory operator, I want triage to park an ambiguous item as needs-human with questions attached, so that I can fix the ambiguity rather than guess what the task meant.
14. As a factory operator, I want to answer parked questions via a CLI command, so that my answers flow back into the item and triage re-runs with the new information.
15. As a factory operator, I want a spec stage that reads the target repo, my item markdown, and the knowledge base, so that the spec is grounded in the actual codebase rather than guesses.
16. As a factory operator, I want the spec to be saved as an artifact, so that I can read exactly what the factory planned to do before (or after) implementation.
17. As a factory operator, I want an approval gate after the spec stage when the item is configured for HITL, so that I can approve or correct the plan before implementation costs are incurred.
18. As a factory operator, I want an implementation stage that commits code to a named branch in a sandboxed worktree, so that my working copy and host filesystem are never touched.
19. As a factory operator, I want every agent stage to run in a Docker sandbox bound to a git worktree only, so that agents physically cannot write outside their worktree.
20. As a factory operator, I want a test stage that runs the project's test suite in the sandbox and fixes failures, so that broken implementations rarely escape to review.
21. As a factory operator, I want a review gate that evaluates the diff for code quality, security, and best practices, so that one gate catches the common failure classes before a PR is created.
22. As a factory operator, I want the review gate deliberately run with a different model family than implementation, so that review is less likely to share implement's blind spots.
23. As a factory operator, I want a bounded rework loop (a failed gate feeds its reasons back to the previous stage, max three total attempts), so that the factory self-heals minor defects without burning unbounded tokens.
24. As a factory operator, I want an item parked with its full failure history when the rework budget is exhausted, so that I can intervene with complete context.
25. As a factory operator, I want approval gates configurable per item (which stages pause for me), so that I can start HITL-heavy and relax automation item by item as trust grows.
26. As a factory operator, I want to see all items and their states via a status command, so that I always know what the factory is doing, waiting on, or blocked by — including why.
27. As a factory operator, I want to approve or reject a parked item with an optional reason, so that my decision — including feedback — drives the next stage.
28. As a factory operator, I want a rejected/parked feedback reason to be fed into the next agent run, so that my corrections actually change behavior rather than merely halting work.
29. As a factory operator, I want PR creation as the terminal stage, with the PR body assembled from the item's artifacts (request, spec, review verdict, rework history), so that every PR is a self-contained audit trail.
30. As a factory operator, I want draft PRs for items with approval gates configured and ready-for-review PRs for fully autonomous items, so that the PR itself signals how much human oversight the item had.
31. As a factory operator, I want the factory to never merge a PR, so that the merge decision always remains mine.
32. As a factory operator, I want a per-stage model mapping in one config file, so that I can dial cost and quality per stage as models change.
33. As a factory operator, I want all stages to default to one model with the mapping structure still present, so that day-one behavior is simple while the differentiation mechanism is ready.
34. As a factory operator, I want model configuration via Ollama Cloud, so that I use the provider I already run.
35. As a factory operator, I want a dated, append-only markdown knowledge base with global and per-project scopes, so that stages accumulate real institutional memory I can read and edit.
36. As a factory operator, I want knowledge entries written only by agents at three defined moments (failed gate, post-rework, PR outcome), so that agent learning is high-signal rather than noise.
37. As a factory operator, I want every knowledge entry to carry a date, so that staleness is visible at a glance.
38. As a factory operator, I want consuming stages to verify KB facts against the current repo before relying on them, so that a stale entry degrades gracefully instead of causing damage.
39. As a factory operator, I want an on-demand curator pass that proposes (never applies) a curation diff — flagging contradictions, stale facts, and prune candidates — so that I can keep the KB clean with minimal effort.
40. As a factory operator, I want transient infrastructure failures (model timeouts, sandbox flakes) retried automatically with backoff and a separate budget from gate judgments, so that a flaky network doesn't consume a work item's rework rounds.
41. As a factory operator, I want items parked with a clear parked-reason when all automatic retries fail, so that infrastructure problems surface rather than hide.
42. As a factory operator, I want items processed strictly sequentially for now, so that state is simple and easy to reason about while the design leaves parallelism as a scheduler change.
43. As a factory operator, I want the state machine to track a per-repo lock concept from day one, so that cross-repo parallelism later doesn't require a redesign.
44. As a factory operator, I want stage durations, attempt counts, and model usage recorded per item, so that I can audit how tokens and time were spent.
45. As a factory operator, I want the SQLite state designed to be read directly by a future web UI, so that a status dashboard later requires no data-layer changes.
46. As a factory operator, I want the whole factory contained in one movable root directory, so that I can back it up or relocate it trivially.
47. As a factory operator, I want the spec stage to be codebase-only (no network), so that no agent stage needs internet access in v1 and the sandbox security story stays simple.

## Implementation Decisions

**Architecture**

- The factory is an orchestrator in TypeScript (Node 22+, run with `tsx`), with pipeline state in SQLite (`better-sqlite3`).
- Durability is stage-level, not turn-level: SQLite persists "which stage each item is on"; a stalled or crashed stage run is re-run (the Sandcastle/pi session resume capability may be used for in-stage recovery, but correctness never depends on it).
- `pi-durable` was explicitly considered and rejected for MVP: its turn-level conversation durability and experimental API are not warranted when the recovery unit is the stage. This decision reverses if the factory grows to need long-lived durable conversations.
- Sandcastle (`@ai-hero/sandcastle`) is the agent-execution engine: Docker sandbox provider, git worktree per item, named output branch, session capture. Its template scaffolding is a starting reference, not the runtime.
- The orchestrator runs on the host (macOS via OrbStack/Docker). Only agent stages are containerized.

**Pipeline**

- Stage sequence (MVP): ingest → triage → spec → implement → test → review → pull-request.
- Triage outcomes: `proceed` (continue), `reject` (terminal; archive with report), `needs-human` (park with questions; `wb answer` feeds answers back and re-runs triage).
- Test stage runs the target project's test suite in the sandbox; failures become rework feedback to implement.
- Review gate covers code quality, security, and best practices in a single agent (splitting into separate security and review agents is a later addition, not a change).
- Gate failure → feedback to prior stage → at most three total attempts per gate → exhausted budget parks the item with full failure history.
- Transient infra failures (model errors, sandbox flakes) retry with backoff up to three attempts with a separate budget from gate judgments; exhaustion parks the item with a parked-reason.
- The final stage pushes the item's branch and creates a GitHub PR via `gh`; draft PR when the item has approval gates configured, ready-for-review when fully autonomous. The factory never merges. PR body is assembled from item artifacts (original request, spec, review verdict, rework history, outcome summary).

**Human-in-the-loop**

- Approval gates are configured per item via front-matter (stage list); paused items surface in status and proceed when approved via the CLI. A rejection reason is recorded as feedback for the next stage.
- CLI verbs: `run`, `resume`, `status`, `approve`, `reject`, `answer`, `curate` (plus item identification by slug/short id).

**Execution & isolation**

- Every agent stage executes in a Sandcastle Docker sandbox (OrbStack-compatible) bound-mounted to a git worktree of the target repo, with branch strategy landing commits on a named per-item branch.
- No agent stage requires network access in MVP; the spec stage is codebase + item + KB only.
- Concurrency is strictly sequential (one item's pipeline at a time); the state machine records a per-repo lock so cross-repo parallelism later is a scheduler change.

**Configuration & models**

- One config file defines: per-stage Ollama Cloud model mapping, default model, factory root paths, rework/retry budgets.
- Model mapping structure exists from day one (triage / spec / implement / test / review keyed to model IDs), but all stages default to one model (DeepSeek V4 Pro); differentiation is a config edit. Candidate mapping when diversified: triage/test — DeepSeek V4 Flash; spec/implement — DeepSeek V4 Pro; review — GLM 5.3 Flash (different family from implement).
- `gh` is assumed pre-authenticated on the host.

**Knowledge base**

- Markdown KB in the factory root: global layer and per-project layer keyed by repo.
- All entries are dated and append-only; agents never rewrite existing entries.
- Agent write moments are limited to three: failed-gate lessons, post-rework fixes, and one-line PR outcome summaries. Consuming stages (triage lightweight; spec, implement, review fully) load the relevant KB layers into their prompts and are instructed to verify KB facts against the repo before relying on them.
- `wb curate` runs a curator agent that writes a *proposal file* (contradictions, stale facts, prune candidates); the human reviews and applies it by hand.

**State & storage layout**

- Factory root directory (self-contained, movable): inbox for new markdown files, item store for claimed items, artifacts per item (spec, reports, logs), archive for rejected items, KB, logs, and the SQLite database file.
- SQLite is the only stateful database; a future web status UI will read it directly — schema must support item stage/status/attempt/history/reason queries without new infrastructure.
- Rescan-on-startup of the inbox + resuming parked items is the complete crash-recovery story.

**Testing seams**

- Exactly one new seam: the StageRunner boundary. The orchestrator (state machine, gates, rework loop, parking, CLI behavior) depends on an interface "run a stage for an item, get a stage result (pass/fail/artifacts/feedback)". The Sandcastle+pi Docker adapter is one implementation of that port.
- All pipeline logic is tested above the seam with fake stage runners driving scenarios (pass-first-time, gate-reject-then-rework-park, triage needs-human, infra-failure parking).
- The Sandcastle adapter gets one thin integration test, gated on Docker availability.
- The filesystem and SQLite are used for real (temp directories, real database) — they are concrete infrastructure; faking them would test the fake.

## Testing Decisions

- Tests assert external behavior only: CLI output, item state after each command, inbox file claim/movement, artifact layout, database-visible transitions. Stage-internal agent behavior is behind the seam and never asserted on implementation details.
- The StageRunner seam is the highest seam worth having: everything that can be logically wrong (state transitions, rework budgets, parking reasons, approval flow, archive/resurrect, front-matter parsing) is above it and tested against fakes; everything below it (sandbox lifecycle, git plumbing) is thin and exercised by the single integration test.
- Good tests here read like scenario scripts: "a review gate that rejects twice then passes yields three implement runs, a passing review, and a PR-stage item with rework history in its artifacts." Deterministic, hermetic, fast — no Docker, no model calls.
- Prior art: none in the repo (greenfield). Standard vitest-style unit/integration layout is expected; the integration test is marked and skipped when Docker is unavailable.

## Out of Scope

- Web status UI (schema designed to permit it; construction deferred).
- Daemon/watch mode (`wb watch` as a loop around the tick verbs; deferred).
- pi-durable as the orchestration layer (revisit trigger: needing long-lived durable conversations, or rebuilding its task graph).
- Separate security-review and general-code-review agents (single review gate in MVP; split later).
- Parallel execution across repos (repo-lock concept exists; scheduler work deferred).
- GitHub-issue ingest as an inbox adapter; any ingest other than the markdown inbox.
- Web access for any agent stage, including spec-stage research (spec is codebase-only in MVP).
- Vector search / RAG over the knowledge base (KB schema stays vector-ready but no retrieval machinery).
- Auto-merge or any merge behavior; factory never merges.
- Rejection by the operator at PR stage flowing back as rework feedback (PR is terminal for MVP).

## Further Notes

- Repository state: greenfield; this is the first spec in a new, empty project.
- The pipeline's hard parts — gate semantics, rework budgets, parking, HITL flow — were stress-tested in an interview session; the resulting decisions are reflected in the numbered user stories above, which should be treated as the authoritative record of scope.
- Milestone order for delivery: (1) factory skeleton — inbox scan, SQLite state machine, config, stub StageRunner; (2) triage → spec → implement → PR end-to-end on an autonomous item; (3) test stage + review gate + rework loop; (4) approval gates + park/answer/approve verbs; (5) KB write-moments + curator; (6) later additions — `watch` loop, per-stage model differentiation, cross-repo parallelism, web UI.
- Staleness is treated as a defect: every KB entry is dated, append-only, verified against the repo by consuming stages, and subject to on-demand human-approved curation.
- The front-matter contract on inbox markdown (title, repo, base, approvals, plus free-form description) is the interface between the human and the factory; it should remain minimal and documented in the item template.