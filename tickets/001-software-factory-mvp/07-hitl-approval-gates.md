# 07: HITL approval gates

**What to build:** Human-in-the-loop becomes a per-item, per-stage configuration. Items with `approvals:` front-matter (a stage list) park after each listed stage instead of proceeding automatically; the parked item shows in `wb status` awaiting decision. New `wb approve <id>` and `wb reject <id> --reason ...` commands resume the pipeline (approve) or park it with the reason recorded as feedback for the reworked next run (reject). Fully autonomous items' behavior is unchanged. This makes HITL the default experience initially, relaxable item-by-item by editing front-matter.

**Blocked by:** 05: Spec → implement → PR via Sandcastle.

**Status:** done — all acceptance criteria checked

**Shipped:** merged to main (see `git log` and item archives in `factory/items/archive/`)

- [x] An item with `approvals:` listing a stage parks after completing that stage; `wb status` shows it awaiting approval with the stage's artifact available to read
- [x] `wb approve <id>` resumes the item from the parked stage's next step; no approval-gated stage behavior changes for items without the flag
- [x] `wb reject <id> --reason "..."` parks the item as human-rejected and records the reason; when the item is resumed/re-run, the reason is fed as feedback into the next agent run's context
- [x] Approval-gated items produce draft PRs; autonomous items produce ready-for-review PRs (interaction with the terminal stage is correct in both modes)
- [x] Approve/reject events, reasons, and outcomes appear in the item's history and artifacts
- [x] Scenario tests above the seam: park-after-spec → approve → proceeds; park → reject with reason → resume → stage receives the reason; autonomous item runs unaffected