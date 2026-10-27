# 09: Curator pass for the knowledge base

**What to build:** An on-demand KB hygiene pass. `wb curate [project]` runs a curation agent that reads the relevant KB layers and the target repo(s) and writes a proposal file — flagging contradictions between entries, facts that no longer match the repo state (e.g. "KB says tests run via X; repo currently uses Y"), stale-dated entries worth pruning, and merge candidates. The curator never applies changes; you review the proposal and apply what you agree with by hand. This keeps the KB truthful under the "stale data is worse than no data" principle with minimal operator effort.

**Blocked by:** 08: Knowledge base write-moments + loading.

**Status:** ready-for-agent

- [ ] `wb curate` (optionally scoped to one project) produces a proposal file in the factory root listing concrete, actionable findings — each citing the entries and repo evidence involved
- [ ] Contradictory entries and repo-mismatched facts are detected against the actual repositories, not just the KB text
- [ ] Stale dated entries are flagged with a recommendation (prune, merge, or keep) rather than auto-decided
- [ ] The curator is strictly read-only with respect to the KB: no entry is modified, added, or removed by the pass; output is the proposal file only
- [ ] A human applying the proposal edits the KB files directly; a subsequent consuming run uses the curated content
- [ ] Scenario tests above the seam: contradiction flagged, repo-mismatch detected with planted evidence, read-only invariant enforced, proposal file format validated; the pass runs hermetically above the stage seam