# 04: Triage stage (real agent)

**What to build:** The first real StageRunner implementation: a triage agent that reads the item markdown (+ item front-matter), the config, and the global knowledge base lightly, and returns one of three outcomes: proceed, reject (terminal — archive with its triage report attached; resurrectable by re-dropping the file into the inbox), or needs-human (park with questions attached). A new `wb answer` command feeds human answers back into the item and re-runs triage with them. This ticket establishes the pattern the remaining real stages follow: agent behind the StageRunner port, structured outcome, artifacts saved, park/archive paths exercised.

**Blocked by:** 03: Rework loop + budgets.

**Status:** ready-for-agent

- [ ] A dropped markdown item gets a real triage decision from the configured model (Ollama Cloud provider config works end-to-end)
- [ ] `proceed` moves the item onward in the pipeline state; `reject` archives it with the triage report as an artifact and a rejected status in `wb status`
- [ ] Re-dropping an archived item's file into the inbox creates a fresh claim (resurrection works)
- [ ] `needs-human` parks the item with its questions visible in `wb status`; the questions are also stored as an artifact
- [ ] `wb answer <id>` records answers to the parked questions; the next run re-executes triage with them in context
- [ ] Structured output is validated (an unparseable triage verdict retries under the infra budget rather than advancing the pipeline)
- [ ] Triage report, questions, and answers are saved as item artifacts; attempts and model usage are recorded in item state
- [ ] Scenario tests above the seam use fake triage runners for park/answer/re-run and archive/resurrect flows; one thin real-agent test exists but is gated on model availability