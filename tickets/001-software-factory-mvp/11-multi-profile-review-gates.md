# 11: Multi-profile review gates (quality + performance)

**What to build:** The review stage currently runs exactly one hardcoded reviewer prompt (`runReview`, `src/adapters/sandcastle.ts:521`) with one model (`models.review`). The gate-exists rationale in `src/config.ts` is "the review gate must not share the implementer's blind spots" — but that diversity is only on the model axis. This ticket adds a second axis: **review profiles** — multiple sequential review gates per review stage, each with its own lens, optional model override, and optional `extraInstructions`, starting with the two shipped lenses: **quality** (today's prompt, unchanged) and **performance** (new).

**Why it matters:** a single reviewer prompt concentrates attention; a correctness-focused reviewer and a performance-focused reviewer find disjoint defect classes (the same reason ticket 06 split test from review). Config-level prompt lenses also let KB lessons reach the reviewer without code edits (`extraInstructions`), mirroring what `.pr_agent.toml` now does for human PRs reviewed by PR-Agent.

**Design (decided):**

1. **Config**: new optional top-level key
   ```json
   "review": { "gates": [ { "name": "quality" }, { "name": "performance", "model": "deepseek-v4.1-flash-1017" } ] }
   ```
   - Each gate: unique `name` (non-empty), optional `model` (defaults to `models.review`, falling back to `models.default`), optional `extraInstructions` (appended to the built-in prompt — the KB→reviewer channel).
   - No `review` key in config ⇒ exactly one implicit gate ("quality", `models.review`, byte-identical prompt/artifact names as today). Zero behavior change for existing configs.
   - `loadConfig` rejects duplicate gate names, empty gate lists, and empty names at startup.
2. **Prompts**: built into the adapter (code, not config), per gate `name`: "quality" reproduces the existing prompt text verbatim; "performance" is a new Workbench-specific lens (better-sqlite3 sync access, prepared-statement reuse, queries-in-loops, watch.ts change-detection cost, unbounded growth, allocations in hot paths, sync I/O on the host loop); unknown gate names build from the shared base + a generic-lens paragraph + the gate's `extraInstructions`, so custom names are legal without adapter edits. `TRUST_BUT_VERIFY` rides along on every profile, as today.
3. **Execution**: profiles run sequentially inside one `runStage` call (no new seam signature — `StageRunner` is untouched; the loop lives below the seam in the adapter). **Fail fast**: the first failing profile stops later profiles and the whole review stage gate-fails, routing rework to implement with the failed profile's fix/findings (with the gate name prefixed), feeding the existing rework loop and shared `maxGateAttempts` budget keyed on stage `review` untouched.
4. **Artifacts & PR body**: single-gate (default) runs keep the exact artifact name `review-verdict`. Multi-gate runs save per-gate artifacts `review-verdict:<name>` plus a combined `review-verdict` (concatenated, headered) **only when all gates pass** — so `pipeline.ts:741`'s `latest("review-verdict")` PR-body surface works unchanged.
5. **Usage accounting**: `StageUsage` gains optional `profiles?: { name: string; model: string }[]` (absent ⇒ single-gate legacy shape). `runStage` fills it for review; `usage.model` stays the first profile's model. Judge-swap dashboards (`usage.model + gate outcomes`) keep working; per-profile model attribution is additive.

**Model choice note:** quality keeps the live `models.review` (`deepseek-v4-pro:0813`). Performance's default in the live config is provisional (`deepseek-v4.1-flash-1017` — different family from implement `glm-5.3`, catalog-verified); the ideal is *also* a different family from quality's model, which today's catalog makes awkward — accepted tradeoff, operator-overridable via `performance.model`.

**Tradeoffs / non-goals:** profiles run sequentially (parallel would contend for the item worktree); the shared rework budget means two profile failures in one round count 2 of `maxGateAttempts` — intentional (budgeting the item, not the lens). Out of scope: per-gate budgets, per-gate approval gates, parallel execution.

**Blocked by:** 06: Test stage + review gate + real rework loop (done).

**Status:** in progress (PR pending review)

- [x] Config schema + resolution: default single "quality" profile equals `models.review`; explicit gates resolve models and are validated (duplicates/empty rejected)
- [x] Scenario test: two-gate review runs both prompts in order (quality then performance) and saves `review-verdict` + `review-verdict:performance` artifacts on pass
- [x] Scenario test: performance gate failing short-circuits, names the profile in feedback, routes rework to implement, and does not run later profiles
- [x] Scenario test: the default (no `review` key) path is byte-identical in behavior — one agent invocation, unchanged prompt text, unchanged artifact name
- [x] Scenario test: `extraInstructions` from config reach the review prompt
- [x] Usage records `profiles` for multi-gate review runs and stays unchanged for single-gate
- [x] Live config (`factory/factory.config.json`) gains the two-gate review section
- [x] README config section documents `review.gates`
- [x] Full suite green + tsc clean