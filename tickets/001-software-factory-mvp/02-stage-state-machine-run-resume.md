# 02: Stage state machine + run/resume (stub stages)

**What to build:** The StageRunner seam and the tick-based state machine behind it. A known sequence of deterministic stub stages stands in for the real pipeline; `factory run` advances every actionable item one stage per invocation, and `factory resume` recovers items interrupted mid-run from their last recorded stage. This ticket proves the harness is durable and observable before any agent exists. Everything here is above the seam and tested with fakes; the Sandcastle adapter does not exist yet.

**Blocked by:** 01: Factory skeleton + inbox ingest.

**Status:** ready-for-agent

- [ ] The orchestrator depends on a single StageRunner-style port (stage + item in → stage result out with pass/fail, artifacts, feedback); no stage logic above the seam knows about sandboxes, git, or models
- [ ] `factory run` advances an item one actionable step at a time; repeated invocations walk the stub pipeline to its terminal step
- [ ] `factory resume` completes or continues what an interrupted run left pending, from the last recorded state
- [ ] A killed/restarted process loses nothing: stage states are persisted before execution, and a crash between execute and record results in the stage being re-run (idempotent-at-stage-level)
- [ ] Items in every meaningful state (queued, running, parked, done) are visible in `factory status` with their recorded stage/attempt/reason
- [ ] Scenario tests above the seam cover: full happy path, interruption recovery, duplicate invocation safety — all hermetic, no Docker required