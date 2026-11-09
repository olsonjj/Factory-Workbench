#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodeProcess from "node:process";

import { loadConfig, ensureConfigFile } from "../config.js";
import { makePaths, ensureLayout } from "../paths.js";
import { FactoryDb } from "../db.js";
import { acquireFactoryLock, lockHolderAlive, readLockInfo, STALE_LOCK_MS } from "../lock.js";
import { scanInbox } from "../inbox.js";
import { ITEM_TEMPLATE } from "../frontmatter.js";
import { authorItem, type NewOptions } from "../author.js";
import { makeRealIO } from "../prompt.js";
import { Orchestrator, matchAnswers } from "../pipeline.js";
import { driveExitLine } from "../drive.js";
import { GitBaseFreshnessChecker } from "../base-freshness.js";
import { SandcastleStageRunner, GhPrPublisher, SandcastleCurator, agentEnvFor } from "../adapters/sandcastle.js";
import { parseIntervalSeconds, startWatch, type WatchState } from "../watch.js";
import { classifyInbox, formatAge, printStatusItems } from "../status.js";
import { runServe } from "../web/server.js";
import { runGc, GitGcScanner, GitGcReaper, renderGcHuman, renderGcJson, type GcFlags } from "../gc.js";
import { sleep } from "../util.js";

const program = new Command("wb");

// Version source of truth is the root package.json "version" field. Guarded:
// an unreadable/malformed file must not crash every wb invocation (even
// --help), only --version's output degrades.
function readPackageVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const packageVersion = readPackageVersion();

interface StatusFlags { all?: boolean }

function errMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function openFactory(rootOverride?: string): {
  root: string;
  paths: ReturnType<typeof makePaths>;
  db: FactoryDb;
  orch: Orchestrator;
  claimReport: ReturnType<typeof scanInbox>;
  /** The pre-acquire lock: a dead previous drive's pid when it left a lock
   *  file behind (the SIGKILL / default-signal case), null when none existed.
   *  Threaded into the Orchestrator so `resume()` labels interrupted items
   *  with the LAST known holder, and available to the run action's explicit
   *  reconcile (specs/wb-interrupted-drives.spec.md). */
  preLockPid: number | null;
  release: () => void;
} {
  const { config, root } = loadConfig(rootOverride);
  ensureConfigFile(root);
  const paths = makePaths(root);
  ensureLayout(paths);
  const preLock = readLockInfo(root);
  const release = acquireFactoryLock(root);
  try {
    const db = new FactoryDb(root);
    const runner = new SandcastleStageRunner({ config, env: agentEnvFor(config) });
    const claimReport = scanInbox(paths, db);
    const orch = new Orchestrator({
      db,
      paths,
      config,
      runner,
      curator: new SandcastleCurator({ config, env: agentEnvFor(config) }),
      publisher: new GhPrPublisher(),
      sleep,
      baseCheck: new GitBaseFreshnessChecker(),
      interruptedDrive: { lastHolderPid: preLock?.pid ?? null },
    });
    return { root, paths, db, orch, claimReport, preLockPid: preLock?.pid ?? null, release };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Light factory open for `wb new`: only paths + item store are needed (the repo
 * default comes from the store). No runner/curator/publisher.
 */
function openAuthoringRoot(rootOverride?: string): {
  root: string;
  paths: ReturnType<typeof makePaths>;
  db: FactoryDb;
  release: () => void;
} {
  const { config, root } = loadConfig(rootOverride);
  ensureConfigFile(root);
  const paths = makePaths(root);
  ensureLayout(paths);
  const release = acquireFactoryLock(root);
  try {
    return { root, paths, db: new FactoryDb(root), release };
  } catch (err) {
    release();
    throw err;
  }
}

/** Shared command scaffold: open factory, run the body, always release resources. */
async function withFactory<T>(
  root: string | undefined,
  body: (ctx: { db: FactoryDb; orch: Orchestrator; claimReport: ReturnType<typeof scanInbox>; preLockPid: number | null }) => Promise<T> | T,
): Promise<void> {
  const ctx = openFactory(root);
  try {
    await body(ctx);
  } finally {
    await ctx.orch.dispose();
    ctx.db.close();
    ctx.release();
  }
}

function printTick(entries: { slug: string; id: number; fromStage: string; status: string; detail: string; changed?: boolean }[], empty: string): void {
  if (entries.length === 0) console.log(empty);
  for (const e of entries) {
    if (e.changed === false) {
      console.log(`${e.slug} (#${e.id}): skipped — ${e.detail}`);
    } else {
      console.log(`${e.slug} (#${e.id}): ${e.fromStage} → ${e.status}` + (e.detail ? ` — ${e.detail}` : ""));
    }
  }
}

function requireItem(db: FactoryDb, idOrSlug: string): { id: number; slug: string } {
  const numeric = Number(idOrSlug);
  const item = Number.isInteger(numeric) && numeric > 0 ? db.getItem(numeric) : undefined;
  const found = item ?? db.findItemBySlugPrefix(idOrSlug);
  if (!found) {
    console.error(`No item matching ${JSON.stringify(idOrSlug)}.`);
    nodeProcess.exit(1);
  }
  return { id: found.id, slug: found.slug };
}

function logClaimReport(report: ReturnType<typeof scanInbox>): void {
  if (report.claimed.length) console.log(`claimed ${report.claimed.length} item(s) from the inbox`);
  if (report.resurrected.length) console.log(`resurrected ${report.resurrected.length} archived item(s)`);
  if (report.malformed.length) {
    for (const m of report.malformed) console.log(`parked as malformed: ${m.slug} — ${m.reason}`);
  }
  if (report.skipped.length) {
    for (const s of report.skipped) console.log(`skipped (already claimed): ${s.slug}`);
  }
}

program
  .name("wb")
  .description("A small, sequentially-processing software factory: markdown inbox in, reviewed pull request out.")
  .version(packageVersion);

program
  .command("init")
  .description("Create the factory root layout and default config")
  .option("--root <dir>", "factory root directory")
  .action((opts: { root?: string }) => {
    const root = opts.root ?? path.join(nodeProcess.cwd(), "factory");
    ensureConfigFile(root);
    ensureLayout(makePaths(root));
    console.log(`Factory root ready at ${root}`);
    console.log(`Drop markdown work items into ${path.join(root, "inbox")}`);
  });

program
  .command("template")
  .description("Print a work-item markdown template to stdout")
  .action(() => {
    console.log(ITEM_TEMPLATE);
  });

program
  .command("new [description]")
  .description("Interactively author a work item and write it into the factory inbox")
  .option("--root <dir>", "factory root directory")
  .option("--title <title>", "item title (skip the prompt)")
  .option("--repo <path>", "target repository (skip the prompt)")
  .option("--base <branch>", "base branch (default: main)")
  .option("--approvals <stages>", "comma-separated approval stages, e.g. spec,review")
  .option("--description-file <path>", "read the description from a file")
  .action(async (description: string | undefined, opts: NewOptions & { root?: string }) => {
    const { paths, db, release } = openAuthoringRoot(opts.root);
    try {
      const result = await authorItem(
        { ...opts, ...(description !== undefined ? { description } : {}) },
        db,
        paths,
        makeRealIO(),
      );
      if (!result.ok) {
        console.error(result.aborted ? `aborted: ${result.reason}` : `factory: ${result.reason}`);
        nodeProcess.exit(1);
      }
      console.log(`Wrote ${result.file} — next: \`wb run\``);
    } finally {
      db.close();
      release();
    }
  });

program
  .command("run")
  .description("Claim inbox items and advance every actionable item one stage")
  .option("--root <dir>", "factory root directory")
  .action(async (opts: { root?: string }) => {
    await withFactory(opts.root, async ({ orch, claimReport, preLockPid }) => {
      // Drive-exit marker + graceful-death labeling (specs/wb-interrupted-drives.spec.md):
      // every exit path of the episode emits exactly one terminal line. SIGTERM
      // gets an explicit interrupted marker (best-effort synchronous write; a
      // lost write degrades to the truncation signature, same as SIGKILL).
      // SIGINT is deliberately NOT hooked: Ctrl+C keeps its default immediate
      // behavior, and the lock file it leaves behind carries this pid for the
      // next drive's reconcile.
      const onSigterm = () => {
        console.error(driveExitLine("run", "interrupted"));
        nodeProcess.exit(1);
      };
      nodeProcess.on("SIGTERM", onSigterm);
      try {
        try {
          logClaimReport(claimReport);
          // We exclusively hold the lock: any `running` item is orphaned by a
          // dead previous drive — requeue + label before driving, so the audit
          // trail shows the gap and the recovery.
          const reconcile = orch.reconcileInterrupted(preLockPid);
          const tick = await orch.tickAll();
          printTick([...reconcile, ...tick.entries], "Nothing to do.");
          console.log(driveExitLine("run", "completed"));
        } catch (err) {
          // A graceful crash (throw) releases the lock via withFactory's
          // finally: label the episode with OUR pid while the DB still lets us,
          // then mark the log. The reconcile/marker must never mask the
          // original error.
          try {
            orch.reconcileInterrupted(process.pid);
          } catch {
            /* the DB may itself be what failed */
          }
          console.error(driveExitLine("run", "interrupted", errMessage(err)));
          throw err;
        }
      } finally {
        nodeProcess.removeListener("SIGTERM", onSigterm);
      }
    });
  });

program
  .command("resume")
  .description("Recover interrupted or human-rejected items and keep them moving until parked or done")
  .option("--root <dir>", "factory root directory")
  .action(async (opts: { root?: string }) => {
    await withFactory(opts.root, async ({ orch }) => {
      const onSigterm = () => {
        console.error(driveExitLine("resume", "interrupted"));
        nodeProcess.exit(1);
      };
      nodeProcess.on("SIGTERM", onSigterm);
      try {
        try {
          // resume() reconciles interrupted items first (the orchestrator's
          // deps carry the pre-acquire last holder pid), then unparks
          // human-rejected items and drives until parked/done/capped.
          const report = await orch.resume();
          printTick(report.entries, "Nothing to resume.");
          if (report.capped) {
            console.error("resume hit its safety cap — run `wb resume` again to continue.");
            console.log(driveExitLine("resume", "capped"));
          } else {
            console.log(driveExitLine("resume", "completed"));
          }
        } catch (err) {
          try {
            orch.reconcileInterrupted(process.pid);
          } catch {
            /* the DB may itself be what failed */
          }
          console.error(driveExitLine("resume", "interrupted", errMessage(err)));
          throw err;
        }
      } finally {
        nodeProcess.removeListener("SIGTERM", onSigterm);
      }
    });
  });

program
  .command("status")
  .description("List all items and their current state, including why anything is parked")
  .option("--root <dir>", "factory root directory")
  .option("--all", "also show finished/archived items")
  .action(async (opts: { root?: string } & StatusFlags) => {
    // Read-only status: takes no factory lock, claims nothing from the inbox,
    // and writes nothing (incl. schema). Safe to run while `wb run` is active;
    // WAL-mode readers never block the writer or vice versa.
    const { root } = loadConfig(opts.root);
    if (!existsSync(path.join(root, "factory.db"))) {
      console.log(`no factory.db in ${root} yet — it is created by any write command (e.g. \`wb new\` or \`wb run\`)`);
      return;
    }
    const db = FactoryDb.openReadonly(root);
    try {
      // Report the lock holder informationally — never an error, and never
      // assumed to be `wb run` (any wb command may hold the lock).
      const lock = readLockInfo(root);
      if (lock) {
        const age = Date.now() - lock.ts;
        if (lockHolderAlive(lock)) {
          const stale = age > STALE_LOCK_MS ? " (possibly stale)" : "";
          console.log(`factory command in progress (pid ${lock.pid}, ${formatAge(age)})${stale}`);
        } else {
          console.log(
            `stale factory lock (pid ${lock.pid}, ${formatAge(age)}) — holder is not running; ` +
            `if no run is in progress you can remove ${path.join(root, "factory.lock")}`,
          );
        }
      }
      // Interrupted-drive signal (specs/wb-interrupted-drives.spec.md): items
      // claiming `running` while no live lock exists were orphaned mid-stage
      // by a drive that died — never a deliberate pause. Read-only like the
      // lock block above; recovery stays the usual `wb run`/`wb resume`.
      const orphaned = db.itemsWithStatus(["running"]);
      if (orphaned.length > 0 && !(lock && lockHolderAlive(lock))) {
        const itemsText = orphaned.map((i) => `#${i.id} ${i.slug} (${i.stage})`).join(", ");
        const holder = lock ? `pid ${lock.pid}` : "none";
        console.log(
          `interrupted drive: ${itemsText} claims running but no live factory lock holds ` +
          `(last known holder: ${holder}) — the previous drive did not end cleanly; ` +
          "recover with `wb run` or `wb resume`",
        );
      }
      const inbox = classifyInbox(db, makePaths(root).inbox);
      if (inbox.error) {
        console.log(`inbox: unreadable (${inbox.error.message ?? inbox.error}) — cannot check for pending files`);
      } else {
        if (inbox.claimable.length > 0) {
          console.log(`inbox: ${inbox.claimable.length} file(s) awaiting claim (claiming happens in \`wb run\`)`);
        }
        for (const { file, item } of inbox.alreadyClaimed) {
          console.log(`inbox: ${file} will be skipped — slug already claimed (item #${item.id}, ${item.status})`);
        }
      }
      printStatusItems(db, opts);
    } finally {
      db.close();
    }
  });

program
  .command("watch")
  .description("Watch the factory live: print changes and OS-notify when items park")
  .option("--root <dir>", "factory root directory")
  .option("--interval <seconds>", "seconds between DB polls", "5")
  .action(async (opts: { root?: string; interval?: string }) => {
    const intervalSec = parseIntervalSeconds(opts.interval);
    const { config, root } = loadConfig(opts.root);
    if (!existsSync(path.join(root, "factory.db"))) {
      console.log(`no factory.db in ${root} yet — it is created by any write command (e.g. \`wb new\` or \`wb run\`)`);
      return;
    }
    // Read-only like `wb status`: open the DB read-only, never take the
    // factory lock, never claim from the inbox, never write anywhere. The DB
    // handle is closed in `finally`; the poll loop keeps the command alive
    // until Ctrl+C, which stops the loop and exits cleanly with 0.
    const db = FactoryDb.openReadonly(root);
    try {
      console.log(`wb watch — polling every ${intervalSec}s · quit with Ctrl+C`);
      const state: WatchState = { lastEventId: 0, lastCard: null, first: true };
      // observeLock: one tiny readFileSync of factory.lock per poll — the
      // same read-only class as the snapshot poll, never an acquire. It lets
      // the card surface interrupted drives (running items with no live
      // lock) instead of a normal-looking RUN line (specs/wb-interrupted-drives.spec.md).
      const stop = startWatch(db, state, config.budgets.maxGateAttempts, intervalSec, () => readLockInfo(root));
      nodeProcess.on("SIGINT", () => {
        stop();
        nodeProcess.exit(0);
      });
      // Keep the command alive until Ctrl+C (the chained poll timers hold
      // the event loop open). Awaiting — not returning — this never-resolving
      // promise keeps the `finally` below from running while the loop lives;
      // SIGINT exits above, and `finally` covers any earlier throw.
      await new Promise<never>(() => {});
    } finally {
      db.close();
    }
  });

program
  .command("serve")
  .description("Host a local browser UI over the factory (read-only observation; actions take the factory lock per request)")
  .option("--root <dir>", "factory root directory")
  .option("--port <n>", "port to listen on", "7466")
  .option("--host <addr>", "address to bind (default 127.0.0.1; bind only if you know why)", "127.0.0.1")
  .option("--interval <seconds>", "SSE poll interval in seconds", "2")
  .action(async (opts: { root?: string; port?: string; host?: string; interval?: string }) => {
    await runServe(opts);
  });

program
  .command("gc")
  .description("Reconcile the factory DB against every target repo's git state; report leaked worktrees/branches and (with --apply) reap the safe subset")
  .option("--root <dir>", "factory root directory")
  .option("--apply", "execute the planned reaps (takes the factory lock)")
  .option("--delete-branches", "with --apply: also delete provably-safe branches of terminal items (merged into base, or — with --force-branches — probe-confirmed no open PR)")
  .option("--force-branches", "with --apply --delete-branches: delete unmerged branches whose PR probe confirms no open PR")
  .option("--force-dirty", "with --apply: reap worktrees with uncommitted changes (the changed-file list is recorded into the item's artifacts first)")
  .option("--force-orphans", "with --apply: reap worktrees/dirs no item row references")
  .option("--json", "emit one machine-readable JSON document instead of the human report")
  .action(async (opts: { root?: string; apply?: boolean; deleteBranches?: boolean; forceBranches?: boolean; forceDirty?: boolean; forceOrphans?: boolean; json?: boolean }) => {
    const flags: GcFlags = {
      apply: !!opts.apply,
      deleteBranches: !!opts.deleteBranches,
      forceBranches: !!opts.forceBranches,
      forceDirty: !!opts.forceDirty,
      forceOrphans: !!opts.forceOrphans,
      json: !!opts.json,
    };
    // The mutating flags are meaningless in report mode; their presence must
    // not silently widen the report.
    const stray = (
      [
        ["deleteBranches", "--delete-branches"],
        ["forceBranches", "--force-branches"],
        ["forceDirty", "--force-dirty"],
        ["forceOrphans", "--force-orphans"],
      ] as const
    ).filter(([key]) => flags[key]);
    if (!flags.apply && stray.length > 0) {
      console.error(`${stray.map(([, flag]) => flag).join(" ")} only makes sense with --apply — report mode never mutates anything`);
      nodeProcess.exit(1);
    }
    if (!flags.apply) {
      // Read-only report, mirroring `wb status`'s open pattern exactly: no
      // factory lock, no DB write, no factory.db creation, no git/fs
      // mutation. Reconciliation races are cosmetic in report mode, so it is
      // safe while any other wb command holds the lock (WAL readers never
      // block the writer or vice versa).
      const { root } = loadConfig(opts.root);
      if (!existsSync(path.join(root, "factory.db"))) {
        console.log(`no factory.db in ${root} yet — it is created by any write command (e.g. \`wb new\` or \`wb run\`)`);
        return;
      }
      const db = FactoryDb.openReadonly(root);
      try {
        // Lock holder is informational only, exactly like `wb status` — but
        // suppressed in --json mode so the document stays parseable.
        if (!flags.json) {
          const lock = readLockInfo(root);
          if (lock) {
            const age = Date.now() - lock.ts;
            if (lockHolderAlive(lock)) {
              const stale = age > STALE_LOCK_MS ? " (possibly stale)" : "";
              console.log(`factory command in progress (pid ${lock.pid}, ${formatAge(age)})${stale}`);
            } else {
              console.log(
                `stale factory lock (pid ${lock.pid}, ${formatAge(age)}) — holder is not running; ` +
                  `if no run is in progress you can remove ${path.join(root, "factory.lock")}`,
              );
            }
          }
        }
        const result = await runGc(
          { db, paths: makePaths(root), scanner: new GitGcScanner(), reaper: new GitGcReaper() },
          flags,
        );
        console.log(flags.json ? renderGcJson(result) : renderGcHuman(result));
      } finally {
        db.close();
      }
      return;
    }
    // Mutating verb: take the factory lock like every other write command
    // (a held lock fails with the standard busy error). Deliberately NOT
    // withFactory/openFactory — those claim inbox files and construct a
    // SandcastleStageRunner; gc has no runner and claims nothing.
    const { root } = loadConfig(opts.root);
    const release = acquireFactoryLock(root);
    let db: FactoryDb | null = null;
    try {
      db = new FactoryDb(root);
      const result = await runGc(
        { db, paths: makePaths(root), scanner: new GitGcScanner(), reaper: new GitGcReaper() },
        flags,
      );
      console.log(flags.json ? renderGcJson(result) : renderGcHuman(result));
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`gc: ${err instanceof Error ? err.message : String(err)}`);
        }
        nodeProcess.exitCode = 1;
      }
    } finally {
      db?.close();
      release();
    }
  });

program
  .command("approve <id-or-slug>")
  .description("Approve a parked item; it resumes at the parked stage's next step")
  .option("--root <dir>", "factory root directory")
  .option("-n, --note <note>", "optional approval note")
  .action((idOrSlug: string, opts: { root?: string; note?: string }) => {
    return withFactory(opts.root, ({ db, orch }) => {
      const { id } = requireItem(db, idOrSlug);
      const item = orch.approve(id, opts.note);
      console.log(`Approved ${item.slug} — run \`wb run\` or \`wb resume\` to continue.`);
    });
  });

program
  .command("reject <id-or-slug>")
  .description("Reject a parked item with your reason; the reason becomes feedback for the next agent run")
  .option("--root <dir>", "factory root directory")
  .requiredOption("-r, --reason <reason>", "why you rejected the stage output")
  .action((idOrSlug: string, opts: { root?: string; reason: string }) => {
    return withFactory(opts.root, ({ db, orch }) => {
      const { id } = requireItem(db, idOrSlug);
      const item = orch.rejectItem(id, opts.reason);
      console.log(`Rejected ${item.slug}. Reason stored as feedback; resume with \`wb resume\`.`);
    });
  });

program
  .command("retry <id-or-slug>")
  .description("Re-queue an item parked by infrastructure failure, exhausted rework, or malformed front-matter (fix the item file first for malformed)")
  .option("--root <dir>", "factory root directory")
  .action((idOrSlug: string, opts: { root?: string }) => {
    return withFactory(opts.root, ({ db, orch }) => {
      const { id } = requireItem(db, idOrSlug);
      const item = orch.retry(id);
      console.log(`Re-queued ${item.slug} at stage ${item.stage}. Run \`wb run\` or \`wb resume\`.`);
    });
  });

program
  .command("answer <id-or-slug>")
  .description("Answer a parked item's triage questions; the next run re-runs triage with the answers")
  .option("--root <dir>", "factory root directory")
  .option("-a, --answer <answers...>", "one answer per parked question, in order")
  .action((idOrSlug: string, opts: { root?: string; answer?: string[] }) => {
    return withFactory(opts.root, ({ db, orch }) => {
      const { id } = requireItem(db, idOrSlug);
      const item = db.getItem(id)!;
      const questions = (item.parkedDetail?.questions as string[] | undefined) ?? [];
      const raw = opts.answer ?? [];
      if (raw.length === 0 && questions.length > 0) {
        console.error(`expected ${questions.length} answer(s); pass -a "..." for each question`);
        nodeProcess.exit(1);
      }
      // Free-form feedback for items parked without questions must not go
      // through matchAnswers (an answer/question count mismatch throws).
      const answers = questions.length > 0 ? matchAnswers(questions, raw) : [];
      const out = orch.answer(id, answers, questions.length === 0 ? raw.join("\n") : undefined);
      console.log(`Answers recorded for ${out.slug}. Triage will re-run with them.`);
    });
  });

program
  .command("curate [projects...]")
  .description("Run a KB curation pass and write a proposal file (read-only; you apply it by hand)")
  .option("--root <dir>", "factory root directory")
  .action(async (projects: string[], opts: { root?: string }) => {
    await withFactory(opts.root, async ({ orch }) => {
      const { file } = await orch.curate(projects);
      console.log(`Proposal written to ${file} — review it and apply what you agree with by hand.`);
    });
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
program.parseAsync(nodeProcess.argv).catch((err: unknown) => fail(err));

function fail(err: unknown): never {
  console.error(`factory: ${err instanceof Error ? err.message : String(err)}`);
  nodeProcess.exit(1);
}