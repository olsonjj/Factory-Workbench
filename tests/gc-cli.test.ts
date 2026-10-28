import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type TestHarness } from "./helpers.js";
import { acquireFactoryLock } from "../src/lock.js";

/** External-behavior tests for `wb gc`: CLI surface only, hermetic fixture
 *  repos (real git, real worktrees), no Docker, no gh, no models. */

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts");

function runGcCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", cliPath, "gc", ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

interface Fixture {
  harness: TestHarness;
  repoDir: string;
  worktree: string;
}

function makeFixture(): Fixture {
  const harness = createHarness();
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "gc-cli-repo-"));
  const git = (args: string[]): string =>
    execFileSync("git", ["-c", "user.name=wb", "-c", "user.email=wb@factory.workbench", ...args], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# x\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  const item = harness.db.insertItem({
    slug: "cli-item",
    title: "cli item",
    repo: repoDir,
    base: "main",
    approvals: [],
    stage: "implement",
    status: "done",
  });
  const worktree = path.join(repoDir, ".sandcastle", "worktrees", "factory-cli-item");
  git(["worktree", "add", "-b", item.branchName, worktree]);
  harness.db.close();
  return { harness, repoDir, worktree };
}

function cleanupFixture(f: Fixture | undefined): void {
  if (!f) return;
  rmSync(f.repoDir, { recursive: true, force: true });
  rmSync(f.harness.root, { recursive: true, force: true });
}

describe("wb gc (CLI external behavior)", () => {
  const fixtures: Fixture[] = [];
  function fixture(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }
  afterEach(() => {
    while (fixtures.length > 0) cleanupFixture(fixtures.pop());
  });

  it("report mode is read-only, works while another wb command holds the lock", () => {
    const f = fixture();
    const release = acquireFactoryLock(f.harness.root);
    try {
      const { stdout, status } = runGcCli(["--root", f.harness.root]);
      expect(status).toBe(0);
      expect(stdout).toContain("factory command in progress (pid");
      expect(stdout).toContain("#1 cli-item [done]");
      expect(stdout).toContain("worktree:");
      expect(stdout).toContain("→ remove");
      // still just a report: the worktree is intact and nothing was written
      expect(fs.existsSync(f.worktree)).toBe(true);
    } finally {
      release();
    }
  });

  it("prints the friendly early-exit on a fresh root and creates nothing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "gc-fresh-"));
    try {
      const { stdout, status } = runGcCli(["--root", root]);
      expect(status).toBe(0);
      expect(stdout).toContain(`no factory.db in ${root} yet`);
      expect(fs.existsSync(path.join(root, "factory.db"))).toBe(false);
      expect(fs.existsSync(path.join(root, "factory.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mutating flags without --apply", () => {
    const f = fixture();
    const { stderr, status } = runGcCli(["--root", f.harness.root, "--delete-branches"]);
    expect(status).toBe(1);
    expect(stderr).toContain("--apply");
    expect(fs.existsSync(f.worktree)).toBe(true);
  });

  it("--json output parses and round-trips the full finding set", () => {
    const f = fixture();
    const { stdout, status } = runGcCli(["--root", f.harness.root, "--json"]);
    expect(status).toBe(0);
    const doc = JSON.parse(stdout) as {
      reportOnly: boolean;
      repos: { repo: string; reachable: boolean; findings: unknown[]; housekeeping: unknown }[];
      reaped: unknown[];
      errors: unknown[];
      summary: { worktreesReapable: number; orphans: number };
    };
    expect(doc.reportOnly).toBe(true);
    expect(doc.repos).toHaveLength(1);
    expect(doc.repos[0]!.reachable).toBe(true);
    expect(doc.repos[0]!.findings.length).toBeGreaterThanOrEqual(2); // worktree + branch
    expect(doc.summary.worktreesReapable).toBe(1);
    expect(doc.reaped).toEqual([]);
    expect(doc.errors).toEqual([]);
    // round-trips: re-serializing the parsed document is stable
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("--apply removes the terminal item's worktree, releases the lock, exits 0", () => {
    const f = fixture();
    const { stdout, status } = runGcCli(["--apply", "--root", f.harness.root]);
    expect(status).toBe(0);
    expect(stdout).toContain("#1 cli-item [done]");
    expect(fs.existsSync(f.worktree)).toBe(false);
    expect(fs.existsSync(path.join(f.harness.root, "factory.lock"))).toBe(false);
  });

  it("--apply refuses to run while another command holds the factory lock", () => {
    const f = fixture();
    const release = acquireFactoryLock(f.harness.root);
    try {
      const { stderr, status } = runGcCli(["--apply", "--root", f.harness.root]);
      expect(status).toBe(1);
      expect(stderr).toContain("factory is busy");
      expect(fs.existsSync(f.worktree)).toBe(true);
    } finally {
      release();
    }
  });
});