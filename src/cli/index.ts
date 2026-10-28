#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { existsSync } from "node:fs";
import nodeProcess from "node:process";

import { loadConfig, ensureConfigFile } from "../config.js";
import { makePaths, ensureLayout } from "../paths.js";
import { FactoryDb } from "../db.js";
import { acquireFactoryLock, lockHolderAlive, readLockInfo, STALE_LOCK_MS } from "../lock.js";
import { scanInbox, claimBlocked, listInboxFiles } from "../inbox.js";
import { ITEM_TEMPLATE, slugify } from "../frontmatter.js";
import type { ItemRecord } from "../types.js";
import { authorItem, type NewOptions } from "../new.js";
import { makeRealIO } from "../prompt.js";
import { Orchestrator, matchAnswers } from "../pipeline.js";
import { SandcastleStageRunner, GhPrPublisher, SandcastleCurator, ollamaEnv } from "../adapters/sandcastle.js";
import { parseIntervalSeconds, startWatch, type WatchState } from "../watch.js";
import { sleep } from "../util.js";

const program = new Command("wb");

function openFactory(rootOverride?: string): {
  root: string;
  paths: ReturnType<typeof makePaths>;
  db: FactoryDb;
  orch: Orchestrator;
  claimReport: ReturnType<typeof scanInbox>;
  release: () => void;
} {
  const { config, root } = loadConfig(rootOverride);
  ensureConfigFile(root);
  const paths = makePaths(root);
  ensureLayout(paths);
  const release = acquireFactoryLock(root);
  try {
    const db = new FactoryDb(root);
    const runner = new SandcastleStageRunner({ config, env: ollamaEnv() });
    const claimReport = scanInbox(paths, db);
    const orch = new Orchestrator({
      db,
      paths,
      config,
      runner,
      curator: new SandcastleCurator({ config, env: ollamaEnv() }),
      publisher: new GhPrPublisher(),
      sleep,
    });
    return { root, paths, db, orch, claimReport, release };
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
  body: (ctx: { db: FactoryDb; orch: Orchestrator; claimReport: ReturnType<typeof scanInbox> }) => Promise<T> | T,
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

function printTick(entries: { slug: string; id: number; fromStage: string; status: string; detail: string }[], empty: string): void {
  if (entries.length === 0) console.log(empty);
  for (const e of entries) {
    console.log(`${e.slug} (#${e.id}): ${e.fromStage} → ${e.status}` + (e.detail ? ` — ${e.detail}` : ""));
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

interface StatusFlags { all?: boolean }

/** Classify unclaimed inbox files without mutating anything (read-only peer of `scanInbox`).
 *  Matches scanInbox's skip rule via the shared `claimBlocked` predicate and
 *  shares `listInboxFiles`, so "awaiting claim" means `wb run` will actually claim it. */
function classifyInbox(db: FactoryDb, inboxDir: string): {
  claimable: string[];
  alreadyClaimed: { file: string; item: ItemRecord }[];
  error: NodeJS.ErrnoException | null;
} {
  let files: string[];
  try {
    // listInboxFiles throws ENOENT when the inbox doesn't exist yet — a normal
    // settled state. Any other read error must surface, otherwise status makes
    // an unreadable inbox look empty.
    files = listInboxFiles(inboxDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { claimable: [], alreadyClaimed: [], error: null };
    }
    return { claimable: [], alreadyClaimed: [], error: err as NodeJS.ErrnoException };
  }
  const claimable: string[] = [];
  const alreadyClaimed: { file: string; item: ItemRecord }[] = [];
  for (const fileName of files) {
    const existing = db.findBySlug(slugify(path.basename(fileName)));
    if (claimBlocked(existing)) {
      alreadyClaimed.push({ file: fileName, item: existing });
    } else {
      claimable.push(fileName);
    }
  }
  return { claimable, alreadyClaimed, error: null };
}

/** Human age for a lock timestamp. */
function formatAge(ms: number): string {
  if (ms < 60_000) return "just started";
  return `${Math.round(ms / 60_000)} min ago`;
}

/** Shared item listing used by `wb status` (read-only, no lock needed). */
function printStatusItems(db: FactoryDb, opts: StatusFlags): void {
  const items = db.listItems().filter((i) => opts.all || i.status !== "done");
  if (items.length === 0) {
    console.log("No items. Drop a markdown file in the inbox: `wb template`");
  }
  for (const item of items) {
    console.log(`#${item.id} ${item.slug} [${item.status}] stage=${item.stage} repo=${item.repo}`);
    console.log(`    title: ${item.title}`);
    if (item.sourceFile) console.log(`    source: ${item.sourceFile}`);
    if (item.parkedReason) console.log(`    parked: ${item.parkedReason}`);
    if (item.parkedDetail) {
      const d = item.parkedDetail;
      if (Array.isArray(d.questions) && d.questions.length > 0) {
        console.log("    questions:");
        for (const q of d.questions as string[]) console.log(`      - ${q}`);
      }
      if (typeof d.stage === "string" && d.stage !== item.stage) {
        console.log(`    completed stage: ${d.stage}`);
      }
      if (item.parkedReason === "awaiting-approval") {
        const artifacts = db.getArtifacts(item.id).filter((a) => a.stage === d.stage);
        if (artifacts.length > 0) {
          console.log(`    artifact from ${d.stage}: ` + artifacts.map((a) => a.path).join(", "));
        }
      }
    }
    const attempts = Object.entries(item.gateAttempts);
    if (attempts.length > 0) {
      console.log(`    gate attempts: ${attempts.map(([s, n]) => `${s}=${n}`).join(", ")}`);
    }
    if (item.infraAttempts > 0) console.log(`    infra retries so far: ${item.infraAttempts}`);
  }
}

program
  .name("wb")
  .description("A small, sequentially-processing software factory: markdown inbox in, reviewed pull request out.");

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
      const result = await authorItem({ ...opts, description }, db, paths, makeRealIO());
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
    await withFactory(opts.root, async ({ orch, claimReport }) => {
      logClaimReport(claimReport);
      printTick((await orch.tickAll()).entries, "Nothing to do.");
    });
  });

program
  .command("resume")
  .description("Recover interrupted or human-rejected items and keep them moving until parked or done")
  .option("--root <dir>", "factory root directory")
  .action(async (opts: { root?: string }) => {
    await withFactory(opts.root, async ({ orch }) => {
      const report = await orch.resume();
      printTick(report.entries, "Nothing to resume.");
      if (report.capped) console.error("resume hit its safety cap — run `wb resume` again to continue.");
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
      const stop = startWatch(db, state, config.budgets.maxGateAttempts, intervalSec);
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