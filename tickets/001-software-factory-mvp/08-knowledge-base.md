# 08: Knowledge base write-moments + loading

**What to build:** The factory starts remembering. A dated, append-only markdown knowledge base lives in the factory root, layered as global and per-target-repo, human-readable and human-editable at all times. Consuming stage prompts load the relevant layers (triage: lightweight global; spec/implement: global + project; review: global + project) with an explicit trust-but-verify instruction (verify KB facts against the repo before relying on them). Agents append entries only at three defined moments: a failed gate (what went wrong + lesson), post-rework (what fixed it, generalized), and PR creation (one-line project outcome). No agent ever rewrites or deletes existing entries.

**Blocked by:** 05: Spec → implement → PR via Sandcastle; 06: Test stage + review gate + real rework loop.

**Status:** done — all acceptance criteria checked

**Shipped:** merged to main (see `git log` and item archives in `factory/items/archive/`)

- [x] KB exists in the factory root with global and per-project layers; every entry carries a date and a scope
- [x] Stage prompts contain their designated KB layers (verified: spec sees project entries from the target repo, triage sees only the lightweight global layer)
- [x] A failed gate produces an appended, dated lesson entry in the correct layer — written by the gate/stage flow, not manually
- [x] A resolved rework produces an appended post-mortem entry (what the fix was)
- [x] PR creation appends a one-line project outcome entry
- [x] Entries are append-only: no stage flow ever modifies or removes existing KB content; concurrent ticks never interleave partial writes
- [x] A human can edit any KB file between runs and the next agent run picks up the edited content
- [x] Scenario tests above the seam: write-moments fire in the right scopes/layer with dated entries; append-only invariant enforced; loader reads edited files fresh each run; one gated real-agent check that a planted stale fact is verified-and-reported by a consuming stage