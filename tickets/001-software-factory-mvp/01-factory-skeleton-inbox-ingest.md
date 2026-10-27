# 01: Factory skeleton + inbox ingest

**What to build:** A factory root on disk (config file, inbox, item store, archive, artifacts, logs, SQLite database) where dropping a markdown work item — front-matter with title, target repo, base branch, approval list, plus a free-form task description — results in a claimed item visible via `factory status`. The markdown file is the item's source of truth; SQLite tracks id, slug, stage, status, attempt counts, and artifact paths. Inbox files are claimed by moving them into the item store; rescanning on startup is idempotent, so nothing is ever claimed twice. No agents exist yet — this and the next two tickets prove the harness.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Dropping a well-formed markdown file into the inbox and running the status command shows it as a claimed item with an id/slug, its stage, and its source file location
- [ ] The claimed file has been moved out of the inbox into the item store; the inbox no longer contains it
- [ ] Front-matter is parsed and validated (title, repo, base, approvals); malformed items park with a clear reason rather than crashing the scan
- [ ] Running the scan again (including across restarts) does not duplicate items
- [ ] Config file exists and is read (factory root paths, default model, per-stage model mapping structure, rework/retry budgets) with sane defaults
- [ ] SQLite state is queryable for item id, stage, status, attempts, parked reason, and artifact paths (future web UI reads this directly)
- [ ] `factory status` output lists all items and their current state, including items parked/failed for reasons
- [ ] Scenario tests cover claim, move, idempotency, and malformed-front-matter parking against a real temporary filesystem and real SQLite