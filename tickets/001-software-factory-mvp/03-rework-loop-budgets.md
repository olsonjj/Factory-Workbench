# 03: Rework loop + budgets (scenario-tested)

**What to build:** Gate semantics for the state machine, fully exercised with scripted stub stages. A stage marked as a gate can fail and route feedback to the previous stage (bounded rework: at most three total attempts per gate, then the item parks with its full failure history attached). Separately, transient infrastructure failures (modeled by flaky stubs) get an automatic-retry budget with backoff and a parked-reason on exhaustion — a counter independent from gate judgments. This is the machinery the real test/review stages will ride in ticket 06.

**Blocked by:** 02: Stage state machine + run/resume.

**Status:** done — all acceptance criteria checked

**Shipped:** merged to main (see `git log` and item archives in `factory/items/archive/`)

- [x] A gate failure records the failure report, routes feedback to the previous stage, and re-runs it; the loop is visible in the item's history
- [x] After the configured number of total gate attempts (default 3), the item parks with every round's report attached and a parked-reason of exhausted-rework
- [x] A pass after rework continues the pipeline normally, with the full rework history retained in the item record
- [x] Infra-style transient failures retry automatically with backoff under a separate budget; exhaustion parks the item with a distinct parked-reason, without consuming gate attempt budget
- [x] Both budgets are configurable from the config file
- [x] Scenario tests (hermetic, deterministic fakes): pass-first-time; reject-then-pass rework; reject-reject-reject → parked with 3 rounds of history; flaky-infra → recovers via retry; always-failing-infra → parked with infra reason; mixed gate+infra failure patterns keep the budgets independent