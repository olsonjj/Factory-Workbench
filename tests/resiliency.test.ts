import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createHarness,
  makeOrchestrator,
  claim,
  ScriptedRunner,
  pass,
  gateFail,
  FakePublisher,
  type TestHarness,
} from "./helpers.js";
import type { PrPublishRequest, PrPublisher } from "../src/pipeline.js";
import type { PrPublishResult, StageRunner } from "../src/types.js";
import type { FactoryConfig } from "../src/config.js";
import { SandcastleStageRunner, SandcastleCurator, getPiConfigStage } from "../src/adapters/sandcastle.js";
import { readKbFile, globalKbFile, projectKbFile } from "../src/kb.js";

let harness: TestHarness | undefined;
const tempDirs: string[] = [];

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function dropItem(h: TestHarness, name: string, frontMatter: Record<string, unknown> = {}, body = "Do it."): void {
  h.inboxFile(name, { title: name, repo: "/tmp/repo", base: "main", approvals: [], ...frontMatter }, body);
  claim(h);
}

/** Run a callback with a HOME that has no ~/.pi/agent, then restore. */
function withFakeHome(fn: () => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("P0-1: per-item fault isolation", () => {
  it("one poisoned source file parks cleanly while a sibling advances", async () => {
    harness = createHarness();
    dropItem(harness, "good");
    dropItem(harness, "bad");
    // Replace the bad item's source file with a directory → readFileSync EISDIR.
    const bad = harness.db.findBySlug("bad")!;
    rmSync(bad.sourceFile!, { force: true });
    mkdirSync(bad.sourceFile!, { recursive: true });

    const orch = makeOrchestrator(harness, new ScriptedRunner({ triage: [pass("triage")] }));
    const report = await orch.tickAll();
    expect(report.entries).toHaveLength(2);

    const good = harness.db.findBySlug("good")!;
    expect(good.status).toBe("queued");
    expect(good.stage).toBe("spec");

    const badAfter = harness.db.findBySlug("bad")!;
    expect(badAfter.status).toBe("infrastructure-failure");
    expect(badAfter.parkedReason).toBe("unhandled-error");
    expect((badAfter.parkedDetail as Record<string, unknown>).error as string).toContain("EISDIR");
  });

  it("a poisoned global KB dir parks one item while a pr-stage sibling proceeds", async () => {
    harness = createHarness();
    dropItem(harness, "kb-victim");
    dropItem(harness, "pr-sibling");
    const sibling = harness.db.findBySlug("pr-sibling")!;
    harness.db.updateItem(sibling.id, { stage: "pr", status: "queued" });

    // Poison the global KB file by replacing it with a directory.
    rmSync(globalKbFile(harness.paths), { force: true });
    mkdirSync(globalKbFile(harness.paths), { recursive: true });

    const orch = makeOrchestrator(harness, new ScriptedRunner({ triage: [pass("triage")] }), {
      publisher: new FakePublisher(),
    });
    const report = await orch.tickAll();
    expect(report.entries).toHaveLength(2);

    const victim = harness.db.findBySlug("kb-victim")!;
    expect(victim.status).toBe("infrastructure-failure");
    expect(victim.parkedReason).toBe("unhandled-error");
    expect((victim.parkedDetail as Record<string, unknown>).error as string).toContain("EISDIR");

    expect(harness.db.findBySlug("pr-sibling")!.status).toBe("done");
  });
});

describe("P0-2: wb retry recovery verb", () => {
  it("re-queues an infrastructure-failure item at the same stage", async () => {
    harness = createHarness();
    dropItem(harness, "task");
    const failing = new ScriptedRunner({ triage: [() => { throw new Error("docker daemon unreachable"); }] });
    const orch = makeOrchestrator(harness, failing);
    await orch.resume();
    let item = harness.db.listItems()[0]!;
    expect(item.status).toBe("infrastructure-failure");
    expect(item.stage).toBe("triage");

    const reQueued = orch.retry(item.id);
    expect(reQueued.status).toBe("queued");
    expect(reQueued.stage).toBe("triage");
    expect(reQueued.parkedReason).toBeNull();
    expect(reQueued.parkedDetail).toBeNull();

    const passing = makeOrchestrator(harness, new ScriptedRunner({}));
    await passing.resume();
    item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
  });

  it("resets an exhausted gate budget and keeps its feedback", async () => {
    harness = createHarness();
    dropItem(harness, "task");
    const runner = new ScriptedRunner({
      review: [
        gateFail("review", "bad 1"),
        gateFail("review", "bad 2"),
        gateFail("review", "bad 3"),
        pass("review", { prSummary: "fixed" }),
      ],
    });
    const orch = makeOrchestrator(harness, runner);
    await orch.resume();
    let item = harness.db.listItems()[0]!;
    expect(item.status).toBe("exhausted-rework");
    expect(item.gateAttempts["review"]).toBe(3);
    expect(item.feedback).toBe("bad 3");

    const reQueued = orch.retry(item.id);
    expect(reQueued.status).toBe("queued");
    expect(reQueued.stage).toBe("implement");
    expect(reQueued.gateAttempts["review"]).toBeUndefined();
    expect(reQueued.feedback).toBe("bad 3");

    await orch.resume();
    item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(item.gateAttempts["review"]).toBe(1);
  });

  it("re-parses a malformed item once its file is fixed", async () => {
    harness = createHarness();
    harness.inboxFile("Broken", { repo: "/tmp/repo" }, "body");
    claim(harness);
    let item = harness.db.listItems()[0]!;
    expect(item.status).toBe("malformed");
    expect(item.parkedReason).toContain("title");

    harness.writeFile(
      item.sourceFile!,
      "---\ntitle: Fixed\nrepo: /tmp/repo\nbase: main\napprovals: []\n---\n\nFixed body.\n",
    );

    const orch = makeOrchestrator(harness, new ScriptedRunner({}));
    const reQueued = orch.retry(item.id);
    expect(reQueued.status).toBe("queued");
    expect(reQueued.stage).toBe("triage");
    expect(reQueued.title).toBe("Fixed");
    expect(reQueued.parkedReason).toBeNull();
  });

  it("throws a clear error for a status retry does not apply to", async () => {
    harness = createHarness();
    dropItem(harness, "task");
    const orch = makeOrchestrator(harness, new ScriptedRunner({}));
    const item = harness.db.listItems()[0]!;
    expect(() => orch.retry(item.id)).toThrow(/retry applies to malformed, exhausted-rework, or infrastructure-failure/);
  });
});

class CrashThenAdoptPublisher implements PrPublisher {
  publishCount = 0;
  adopt = false;
  private readonly existingPr: PrPublishResult = {
    url: "https://github.com/example/repo/pull/42",
    number: 42,
    draft: false,
  };

  async publish(_req: PrPublishRequest): Promise<PrPublishResult> {
    this.publishCount += 1;
    throw new Error("simulated crash after gh succeeded");
  }

  async findExisting(_req: { repoPath: string; branchName: string; base: string }): Promise<PrPublishResult | undefined> {
    return this.adopt ? this.existingPr : undefined;
  }
}

describe("P0-3: PR exactly-once", () => {
  it("recovers an existing PR on the next run without publishing twice", async () => {
    harness = createHarness({ maxInfraRetries: 0 });
    dropItem(harness, "task");
    const publisher = new CrashThenAdoptPublisher();
    const orch = makeOrchestrator(harness, new ScriptedRunner({}), { publisher });

    await orch.resume(); // crash after gh succeeded → park at pr
    let item = harness.db.listItems()[0]!;
    expect(item.status).toBe("infrastructure-failure");
    expect((item.parkedDetail as Record<string, unknown>).stage).toBe("pr");
    expect(publisher.publishCount).toBe(1);

    orch.retry(item.id);
    publisher.adopt = true;
    await orch.resume(); // findExisting adopts; no second publish

    item = harness.db.listItems()[0]!;
    expect(item.status).toBe("done");
    expect(publisher.publishCount).toBe(1);
    expect(item.parkedDetail).toEqual({ prUrl: "https://github.com/example/repo/pull/42", prNumber: 42, draft: false });
    const prCreated = harness.db.getHistory(item.id).find((h) => h.event === "pr-created")!;
    expect(prCreated.detail.recoveredExisting).toBe(true);
  });
});

describe("P1-7: resume cap + unpark cleanup", () => {
  it("reports capped when the safety cap stops a still-busy resume", async () => {
    harness = createHarness();
    dropItem(harness, "a");
    dropItem(harness, "b");
    const orch = makeOrchestrator(harness, new ScriptedRunner({}), { maxResumeTicks: 1 });
    const report = await orch.resume();
    expect(report.capped).toBe(true);
    const items = harness.db.listItems();
    expect(items.every((i) => i.status === "queued" && i.stage === "spec")).toBe(true);
  });

  it("unparking a human-rejected item clears parked fields", async () => {
    harness = createHarness();
    dropItem(harness, "task", { approvals: ["spec"] });
    const orch = makeOrchestrator(harness, new ScriptedRunner({}), { maxResumeTicks: 0 });
    await orch.tickAll(); // triage
    await orch.tickAll(); // spec → awaiting-approval
    const parked = harness.db.listItems()[0]!;
    orch.rejectItem(parked.id, "spec misses the migration step");
    const rejected = harness.db.listItems()[0]!;
    expect(rejected.status).toBe("human-rejected");
    expect(rejected.parkedReason).toBe("human-rejected");

    await orch.resume(); // unpark step only (maxResumeTicks 0)
    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("queued");
    expect(item.parkedReason).toBeNull();
    expect(item.parkedDetail).toBeNull();
    expect(item.feedback).toBe("spec misses the migration step");
  });
});

describe("P1-8: lazy staging + dispose", () => {
  it("constructing runner/curator does not create <root>/pi-config without host pi config", () => {
    withFakeHome(() => {
      const root = tmpDir("factory-lazy-");
      const config: FactoryConfig = {
        root,
        models: { default: "m" },
        budgets: { maxGateAttempts: 3, maxInfraRetries: 3, retryBackoffMs: 0 },
        sandbox: { imageName: "sandcastle:local" },
        kb: { maxGlobalChars: 24000, maxProjectChars: 24000 },
      };
      const runner = new SandcastleStageRunner({ config, env: {} });
      const curator = new SandcastleCurator({ config, env: {} });
      void runner;
      void curator;
      expect(existsSync(path.join(root, "pi-config"))).toBe(false);
    });
  });

  it("getPiConfigStage is memoized per factory root", () => {
    withFakeHome(() => {
      const home = process.env.HOME!;
      const agentDir = path.join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "auth.json"), "{}");
      const root = tmpDir("factory-stage-");
      const a = getPiConfigStage(root);
      const b = getPiConfigStage(root);
      expect(a).toBeTruthy();
      expect(a).toBe(b); // identical object ⇒ side effects ran once
      expect(existsSync(path.join(root, "pi-config", "auth.json"))).toBe(true);
    });
  });

  it("orch.dispose() calls the runner's dispose hook", async () => {
    harness = createHarness();
    let disposed = 0;
    const runner: StageRunner = {
      async runStage() {
        return pass("triage");
      },
      async dispose() {
        disposed += 1;
      },
    };
    const orch = makeOrchestrator(harness, runner);
    await orch.dispose();
    expect(disposed).toBe(1);
  });
});

describe("P1-9: KB tail-truncation + size caps", () => {
  it("readKbFile keeps the tail with an elision marker", () => {
    harness = createHarness();
    const file = path.join(harness.root, "kb.md");
    harness.writeFile(file, "a".repeat(100));
    const out = readKbFile(file, 20);
    expect(out).toContain("older KB content elided (80 chars)");
    expect(out.endsWith("a".repeat(20))).toBe(true);
  });

  it("stage KB loading applies configured caps and keeps triage lightweight", async () => {
    harness = createHarness();
    harness.config.kb = { maxGlobalChars: 2000, maxProjectChars: 500 };
    dropItem(harness, "task");
    harness.writeFile(globalKbFile(harness.paths), "G".repeat(10_000));
    harness.writeFile(projectKbFile(harness.paths, "/tmp/repo"), "P".repeat(3_000));

    const runner = new ScriptedRunner({});
    const orch = makeOrchestrator(harness, runner);
    await orch.tickAll(); // triage
    await orch.tickAll(); // spec

    const triageReq = runner.calls.find((c) => c.req.stage === "triage")!.req;
    expect(triageReq.kb.global.endsWith("G".repeat(2000))).toBe(true);
    expect(triageReq.kb.project).toBe("");

    const specReq = runner.calls.find((c) => c.req.stage === "spec")!.req;
    expect(specReq.kb.global.endsWith("G".repeat(2000))).toBe(true);
    expect(specReq.kb.project.endsWith("P".repeat(500))).toBe(true);
  });
});
