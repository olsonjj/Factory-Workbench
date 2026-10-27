# wb — Factory Workbench

A small, sequentially-processing software factory: drop a markdown task file
into an inbox folder, get a reviewed, pull-request-ready branch out — with
triage, specification, implementation, testing and review handled by agents,
decisions recorded in SQLite, failures bounded, and the whole pipeline
resumable after a crash or an interruption.

Built on [pi](https://github.com/badlogic/pi-mono) (the agent harness, running
inside sandboxes) and [@ai-hero/sandcastle](https://www.npmjs.com/package/@ai-hero/sandcastle)
(Docker sandboxing, git worktrees, named branch strategy). Models run via
Ollama Cloud.

## Prerequisites

- Node 22+ and `npm`
- Docker (OrbStack or Docker Desktop) running, with the sandbox image built:
  `npx sandcastle docker build-image`
- `OLLAMA_API_KEY` exported on the host (Ollama Cloud) — passed to sandbox
  agent sessions
- `gh` CLI pre-authenticated on the host (`gh auth status`) — PR publishing

## Install

```bash
npm install
npm run build          # tsc -> dist
# Optional: the true global verb (spec register: `wb`)
npm link               # exposes `wb` on your PATH
# During development on wb itself, use `npm run wb -- run` (tsx, no rebuild).
```

Note: `npm link` is inside your node version install (mise) — re-run it after
upgrading Node. Without a link, invoke via `npm run wb -- <verb>`.

Initialize a factory root (self-contained and movable):

```bash
wb init
```

This creates `./factory/` with: `factory.config.json` (per-stage model
mapping, budgets), `inbox/` (drop work items here), `items/` (claimed items
and artifacts), `archive/` (triage-rejected items), `kb/` (global +
per-project knowledge base), `proposals/`, `logs/`, and `factory.db` (SQLite).

## Usage

Write a work item (see `wb template`):

```markdown
---
title: Implement the thing
repo: /path/to/target/repo
base: main
approvals: []          # stages that stop for human approval, e.g. [spec, review]
---

Describe the task. This file is the item's source of truth.
```

Drop it into `factory/inbox/`, then:

```bash
wb run      # claim inbox + advance every actionable item one stage
wb resume   # drive interrupted/human-rejected items until parked or done
wb status   # everything the factory is doing, waiting on, or blocked by
wb approve <id>          # release a parked approval gate
wb reject <id> --reason "fix the X"   # feedback feeds the next agent run
wb answer <id> -a "..."  # answer parked triage questions; triage re-runs
wb curate [project]      # on-demand KB curation proposal (read-only)
```

Pipeline: **triage → spec → implement → test → review → pull-request**.

- Every agent stage runs in a Docker sandbox bound to a git worktree; commits
  land on a named per-item branch (`factory/<slug>`). The host filesystem is
  never touched beyond git plumbing.
- The test and review stages are gates: a failed gate sends its reasons back
  to the implementer, at most `budgets.maxGateAttempts` total attempts per
  gate, then the item parks with the full failure history.
- Transient infrastructure failures (model timeouts, sandbox flakes) retry
  with backoff under a separate budget; on exhaustion the item parks with a
  distinct reason. A flaky network never consumes rework rounds.
- Approval-gated items produce **draft** PRs; fully autonomous items produce
  ready-for-review PRs. The factory never merges.
- PR bodies are assembled from the item's artifacts (request, spec, review
  verdict, rework history, artifact index) — every PR is a self-contained
  audit trail.

## Configuration

`factory/factory.config.json`:

```json
{
  "root": "/path/to/factory",
  "models": {
    "default": "deepseek-v4-pro:0813",
    "triage": "deepseek-v4.1-flash",
    "spec": "deepseek-v4-pro:0813",
    "implement": "deepseek-v4-pro:0813",
    "test": "deepseek-v4.1-flash",
    "review": "glm-5.3-flash"
  },
  "budgets": { "maxGateAttempts": 3, "maxInfraRetries": 3, "retryBackoffMs": 5000 },
  "sandbox": { "imageName": "sandcastle:local" }
}
```

- All stages default to one model; the per-stage override mechanism is the
  mapping structure above. The shipped default config gives review a different
  model family from implement.
- `OLLAMA_API_KEY` must be set on the host; it is passed through to the
  sandbox `pi` sessions. `gh` must be pre-authenticated.

## Knowledge base

`factory/kb/global.md` and `factory/kb/projects/<repo>.md` are dated,
append-only markdown layers. Agents write entries at exactly three moments —
a failed gate (lesson), post-rework (what fixed it), and PR creation (one-line
outcome) — and only ever append. Consuming stages load their designated
layers (triage: lightweight global only; spec/implement/review: global +
project) and are instructed to verify KB facts against the repo before
trusting them. `wb curate` runs a read-only pass that writes a proposal
file (contradictions, repo mismatches, prune candidates) which you apply by
hand.

## Development

- Tests: `npm test` — all pipeline logic runs above a single seam
  (`StageRunner`) against hermetic fake runners; the filesystem and SQLite
  are used for real.
- The one Sandcastle adapter integration test is gated on Docker
  availability + `OLLAMA_API_KEY`; without them it is skipped.
- Typecheck: `npm run typecheck`.

## Architecture notes

- Stage-level durability: SQLite records which stage each item is on; a
  crashed stage run is re-run from the persisted state. Correctness never
  depends on session resume.
- Strictly sequential processing for now; the per-repo lock is already a
  first-class table, so cross-repo parallelism later is a scheduler change.
- See `specs/001-software-factory-mvp.md` for the full spec and
  `tickets/001-software-factory-mvp/` for the ticket-by-ticket contracts.
- For a fully manual, from-scratch walkthrough (markdown in → PR out, with
  expected artifacts at each step), see `docs/demo.md`.