import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, } from "node:fs";
import { FactoryDb } from "../src/db.js";
import { makePaths, type FactoryPaths } from "../src/paths.js";
import { loadConfig, type FactoryConfig } from "../src/config.js";
import { scanInbox } from "../src/inbox.js";
import { Orchestrator, type PrPublishRequest, type PrPublisher } from "../src/pipeline.js";
import type { CuratorRunner, PrPublishResult, StageRequest, StageResult, StageRunner } from "../src/types.js";

export interface TestHarness {
  root: string;
  paths: FactoryPaths;
  db: FactoryDb;
  config: FactoryConfig;
  inboxFile: (name: string, frontMatter: Record<string, unknown>, body: string) => string;
  dropAgain: (name: string, frontMatter: Record<string, unknown>, body: string) => string;
  readItemFile: (slug: string) => string;
  writeFile: (abs: string, content: string) => void;
  readFile: (abs: string) => string;
  cleanup: () => void;
}

export function createHarness(budgetOverrides: Partial<FactoryConfig["budgets"]> = {}): TestHarness {
  const root = mkdtempSync(path.join(os.tmpdir(), "factory-test-"));
  mkdirSync(path.join(root, "inbox"), { recursive: true });
  const paths = makePaths(root);
  const config: FactoryConfig = {
    root,
    models: { default: "test-model" },
    budgets: {
      maxGateAttempts: 3,
      maxInfraRetries: 3,
      retryBackoffMs: 0,
      ...budgetOverrides,
    },
    sandbox: { imageName: "test:sandbox" },
  };
  let fileNo = 0;
  function uniqueName(rootDir: string, base: string): string {
    const inbox = path.join(rootDir, "inbox");
    let name = base;
    let n = 0;
    while (existsSync(path.join(inbox, `${name}.md`))) {
      n += 1;
      name = `${base}-${n}`;
    }
    return name;
  }
  const harness: TestHarness = {
    root,
    paths,
    db: new FactoryDb(root),
    config,
    inboxFile: (baseName, fm, body) => writeItemFile(root, baseName ?? "item", fm, body),
    dropAgain: (baseName, fm, body) => writeItemFile(root, baseName ?? "item", fm, body),
    readItemFile: (slug) => harness.readFile(path.join(paths.items, slug, "item.md")),
    writeFile: (abs, content) => {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    },
    readFile: (abs) => readFileSync(abs, "utf8"),
    // readFileSync re-exported above
    cleanup: () => {
      harness.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}

function uniqueName(rootDir: string, base: string): string {
  const inbox = path.join(rootDir, "inbox");
  let name = base;
  let n = 0;
  while (existsSync(path.join(inbox, `${name}.md`))) {
    n += 1;
    name = `${base}-${n}`;
  }
  return name;
}

function writeItemFile(
  root: string,
  baseName: string,
  fm: Record<string, unknown>,
  body: string,
): string {
  const name = uniqueName(root, baseName);
  const fmText = [
    "---",
    ...Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : String(v)}`),
    "---",
  ].join("\n");
  return writeInbox(root, name, `${fmText}\n\n${body}\n`);
}

function writeInbox(root: string, name: string, content: string): string {
  const file = path.join(root, "inbox", `${name}.md`);
  writeFileSync(file, content, "utf8");
  return file;
}

/**
 * Scripted fake StageRunner: each stage maps to a list of results consumed in
 * order; the last entry repeats. Results may also be produced by a function
 * so tests can inspect the request.
 */
export type Script = Partial<Record<string, (StageResult | ((req: StageRequest, nth: number) => StageResult))[]>>;

export class ScriptedRunner implements StageRunner {
  readonly calls: { req: StageRequest; result: StageResult }[] = [];
  readonly stageCallCounts = new Map<string, number>();

  constructor(private readonly script: Script) {}

  async runStage(req: StageRequest): Promise<StageResult> {
    const nth = (this.stageCallCounts.get(req.stage) ?? 0) + 1;
    this.stageCallCounts.set(req.stage, nth);
    let entries = this.script[req.stage];
    const idx = Math.min(nth - 1, entries ? entries.length - 1 : 0);
    const entry = entries?.[idx];
    const result = typeof entry === "function" ? entry(req, nth) : (entry ?? pass(req.stage));
    this.calls.push({ req, result });
    return result;
  }
}

export function pass(stage: string, extra: Partial<StageResult> = {}): StageResult {
  return { outcome: "pass", artifacts: [{ name: `${stage}`, content: `# ${stage} output` }], ...extra };
}

export function gateFail(stage: string, feedback: string, extra: Partial<StageResult> = {}): StageResult {
  return {
    outcome: "gate-fail",
    artifacts: [],
    feedback,
    report: `# ${stage} report`,
    lesson: `lesson: ${feedback}`,
    ...extra,
  };
}

export class FakePublisher {
  readonly published: PrPublishRequest[] = [];
  constructor(private readonly failTimes = 0) {}

  count(): number {
    return this.published.length;
  }

  async publish(req: PrPublishRequest): Promise<PrPublishResult> {
    if (this.published.length < this.failTimes) {
      this.published.push(req);
      throw new Error("simulated gh failure");
    }
    this.published.push(req);
    return { url: `https://github.com/example/repo/pull/${this.published.length + 100}`, number: this.published.length + 100, draft: req.draft };
  }
}

export function makeOrchestrator(
  harness: TestHarness,
  runner: StageRunner,
  opts: {
    publisher?: PrPublisher;
    curator?: CuratorRunner | null;
  } = {},
): Orchestrator {
  const { config, configFile } = { config: harness.config, configFile: "" };
  void configFile;
  void loadConfig;
  return new Orchestrator({
    db: harness.db,
    paths: harness.paths,
    config: harness.config,
    runner,
    curator: opts.curator ?? null,
    publisher: opts.publisher ?? new FakePublisher(),
    sleep: async () => {},
  });
}

export function claim(harness: TestHarness): ReturnType<typeof scanInbox> {
  return scanInbox(harness.paths, harness.db);
}