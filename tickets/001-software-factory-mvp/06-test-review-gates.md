# 06: Test stage + review gate + real rework loop

**What to build:** The pipeline gains its first gates. The test stage runs the target project's test suite inside the sandbox and attempts to fix failures (failures become rework feedback to implement). The review gate judges the merged diff for code quality, security, and best practices in a single agent — deliberately configured with a different model family from implement (per the config file's per-stage mapping) to avoid shared blind spots. Gate failures route through the rework loop built in ticket 03; an exhausted budget parks the item with its full failure history.

**Blocked by:** 05: Spec → implement → PR via Sandcastle.

**Status:** ready-for-agent

- [x] An item whose implementation breaks tests is caught in the test stage, fixed via rework feedback to implement, and only then proceeds
- [x] An implementation that passes tests but fails review (e.g. missing input validation, security smell) is reworked with the review's reasons as feedback, up to the budget, then proceeds or parks with the full history
- [x] The review gate's verdict (pass/fail with findings) is saved as an artifact and included in the PR body's audit trail
- [x] Review runs with the model family configured for it — different from implement by default per config
- [x] Exhausted rework parks the item with every round's report, visible in `wb status` with a clear parked-reason
- [x] Scenario tests above the seam: test-fail-then-fix → proceed; test-fail loop → park; review-reject-then-pass → proceed; review-reject loop → park; both gates failing in different orders behave deterministically