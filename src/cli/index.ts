#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import nodeProcess from "node:process";

import { loadConfig, ensureConfigFile } from "../config.js";
import { makePaths, ensureLayout } from "../paths.js";
import { FactoryDb } from "../db.js";
import { scanInbox } from "../inbox.js";
import { ITEM_TEMPLATE } from "../frontmatter.js";
import { Orchestrator } from "../pipeline.js";
import { SandcastleStageRunner, GhPrPublisher, SandcastleCurator, ollamaEnv } from "../adapters/sandcastle.js";
import { sleep } from "../util.js";

const program = new Command("factory");

function openFactory(rootOverride?: string): {
  root: string;
  paths: ReturnType<typeof makePaths>;
  db: FactoryDb;
  orch: Orchestrator;
  claimReport: ReturnType<typeof scanInbox>;
} {
  const { config, root } = loadConfig(rootOverride);
  ensureConfigFile(root);
  const paths = makePaths(root);
  ensureLayout(paths);
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
  return { root, paths, db, orch, claimReport };
}

function requireItem(db: FactoryDb, idOrSlug: string): { id: number; slug: string } {
  const numeric = Number(idOrSlug);
  const item = Number.isInteger(numeric) && numeric > 0 ? db.getItem(numeric) : undefined;
  const found = item ?? db.getItemBySlug(idOrSlug);
  if (!found) {
    void 0;
    console.error(`No item matching ${JSON.stringify(idOrSlug)}.`);
    nodeProcess.exit(1);
  }
  if (!found) throw new Error("unreachable"); // narrowed above
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

program
  .name("factory")
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
  .command("run")
  .description("Claim inbox items and advance every actionable item one stage")
  .option("--root <dir>", "factory root directory")
  .action(async (opts: { root?: string }) => {
    const { db, orch, claimReport } = openFactory(opts.root);
    try {
      logClaimReport(claimReport);
      const report = await orch.tickAll();
      if (report.entries.length === 0) {
        console.log("Nothing to do.");
      }
      for (const e of report.entries) {
        console.log(`${e.slug} (#${e.id}): ${e.fromStage} → ${e.status}` + (e.detail ? ` — ${e.detail}` : ""));
      }
      db.close();
    } catch (err) {
      db.close();
      fail(err);
    }
  });

program
  .command("resume")
  .description("Recover interrupted or human-rejected items and keep them moving until parked or done")
  .option("--root <dir>", "factory root directory")
  .action(async (opts: { root?: string }) => {
    const { db, orch } = openFactory(opts.root);
    try {
      const report = await orch.resume();
      if (report.entries.length === 0) {
        console.log("Nothing to resume.");
      }
      for (const e of report.entries) {
        console.log(`${e.slug} (#${e.id}): ${e.fromStage} → ${e.status}` + (e.detail ? ` — ${e.detail}` : ""));
      }
      db.close();
    } catch (err) {
      db.close();
      fail(err);
    }
  });

program
  .command("status")
  .description("List all items and their current state, including why anything is parked")
  .option("--root <dir>", "factory root directory")
  .option("--all", "also show finished/archived items")
  .action((opts: { root?: string } & StatusFlags) => {
    const { db, orch: _o, claimReport } = openFactory(opts.root);
    void _o;
    logClaimReport(claimReport);
    const items = db.listItems().filter((i) => opts.all || i.status !== "done");
    if (items.length === 0) {
      console.log("No items. Drop a markdown file in the inbox: `factory template`");
    }
    for (const item of items) {
      console.log(`#${item.id} ${item.slug} [${item.status}] stage=${item.stage} repo=${item.repo}`);
      console.log(`    title: ${item.title}`);
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
    db.close();
  });

program
  .command("approve <id-or-slug>")
  .description("Approve a parked item; it resumes at the parked stage's next step")
  .option("--root <dir>", "factory root directory")
  .option("-n, --note <note>", "optional approval note")
  .action((idOrSlug: string, opts: { root?: string; note?: string }) => {
    const { db, orch } = openFactory(opts.root);
    const { id } = requireItem(db, idOrSlug);
    try {
      const item = orch.approve(id, opts.note);
      console.log(`Approved ${item.slug} — run \`factory run\` or \`factory resume\` to continue.`);
      db.close();
    } catch (err) {
      db.close();
      fail(err);
    }
  });

program
  .command("reject <id-or-slug>")
  .description("Reject a parked item with your reason; the reason becomes feedback for the next agent run")
  .option("--root <dir>", "factory root directory")
  .requiredOption("-r, --reason <reason>", "why you rejected the stage output")
  .action((idOrSlug: string, opts: { root?: string; reason: string }) => {
    const { db, orch } = openFactory(opts.root);
    const { id } = requireItem(db, idOrSlug);
    try {
      const item = orch.rejectItem(id, opts.reason);
      console.log(`Rejected ${item.slug}. Reason stored as feedback; resume with \`factory resume\`.`);
      db.close();
    } catch (err) {
      db.close();
      fail(err);
    }
  });

program
  .command("answer <id-or-slug>")
  .description("Answer a parked item's triage questions; the next run re-runs triage with the answers")
  .option("--root <dir>", "factory root directory")
  .option("-a, --answer <answers...>", "one answer per parked question, in order")
  .action((idOrSlug: string, opts: { root?: string; answer?: string[] }) => {
    const { db, orch } = openFactory(opts.root);
    const { id } = requireItem(db, idOrSlug);
    try {
      const item = orch.answer(id, [], opts.answer?.join("\n"));
      console.log(`Answers recorded for ${item.slug}. Triage will re-run with them.`);
      db.close();
    } catch (err) {
      db.close();
      fail(err);
    }
  });

program
  .command("curate [projects...]")
  .description("Run a KB curation pass and write a proposal file (read-only; you apply it by hand)")
  .option("--root <dir>", "factory root directory")
  .action(async (projects: string[], opts: { root?: string }) => {
    const { db, orch } = openFactory(opts.root);
    try {
      const { file } = await orch.curate(projects);
      console.log(`Proposal written to ${file} — review it and apply what you agree with by hand.`);
      db.close();
    } catch (err) {
      db.close();
      fail(err);
    }
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
program.parseAsync(nodeProcess.argv).catch(failAlways);

function fail(err: unknown): never {
  console.error(`factory: ${err instanceof Error ? err.message : String(err)}`);
  nodeProcess.exit(1);
}

function failAlways(err: unknown): never {
  fail(err);
}