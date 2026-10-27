# 05: Spec → implement → PR via Sandcastle

**What to build:** The tracer-bullet payoff: markdown in, pull request out. An autonomous item flows through spec (reads the target repo's worktree, the item, and the knowledge base — codebase-only, no network) and implement (an agent run inside a Sandcastle Docker sandbox bound to a git worktree, committing to a named per-item branch), then the factory pushes the branch and creates a GitHub pull request via the host's authenticated gh CLI. The PR body is an audit trail assembled from item artifacts (original request, spec, artifacts index). Draft PR when the item has approval gates configured in front-matter; ready-for-review when fully autonomous. The factory never merges. This ticket also introduces the Sandcastle adapter as the real StageRunner implementation, with one integration test gated on Docker availability.

**Blocked by:** 04: Triage stage.

**Status:** ready-for-agent

- [x] A fully autonomous item (no approvals front-matter, well-formed description targeting a real local repo) produces a GitHub PR whose diff matches a reasonable reading of the item request — without any command other than `wb run`/`wb resume`
- [x] Spec is saved as an item artifact and its content is grounded in the actual repo (agent works in a worktree, never the host working copy)
- [x] Implementation commits land on a named per-item branch inside a bind-mounted Docker sandbox (OrbStack-compatible); the host filesystem is untouched beyond worktree/git plumbing
- [x] The branch is pushed and a PR created with body assembled from the request, spec, and artifact index; draft vs ready-for-review follows the item's approvals front-matter
- [x] The factory never merges; PR creation is the item's terminal step
- [x] Agent stages require no network access beyond what Sandcastle/git/gh plumbing provides
- [x] Model/stage config is honored from the config file (per-stage mapping structure, single default model for all stages)
- [x] One Sandcastle adapter integration test exists behind a Docker-availability gate; all other tests above the seam remain hermetic
- [x] Manual verification documented: a demo item from this repo's example produces a PR on a test repo