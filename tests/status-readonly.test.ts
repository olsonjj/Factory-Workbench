import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { mkdirSync, writeFileSync, rmSync, chmodSync, mkdtempSync } from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createHarness, claim, type TestHarness } from "./helpers.js";
import { acquireFactoryLock } from "../src/lock.js";

/** External-behavior tests for `wb status`: CLI output only, no internals. */

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts");

function runStatus(root: string): { stdout: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", cliPath, "status", "--root", root], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout: res.stdout ?? "", status: res.status ?? -1 };
}

describe("wb status (read-only)", () => {
  const harnesses: TestHarness[] = [];
  function makeHarness() {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  it("lists items and their state without taking the factory lock", () => {
    const h = makeHarness();
    h.inboxFile("add-dark-mode", { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] }, "Body.");
    claim(h);

    const { stdout, status } = runStatus(h.root);

    expect(status).toBe(0);
    expect(stdout).toContain("#1 add-dark-mode");
    expect(stdout).not.toContain("factory command in progress");
    expect(stdout).not.toContain("inbox:"); // inbox was empty after claim
  });

  it("stays readable while another wb command holds the factory lock", () => {
    const h = makeHarness();
    h.inboxFile("add-dark-mode", { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    const release = acquireFactoryLock(h.root);

    const { stdout, status } = runStatus(h.root);

    expect(status).toBe(0);
    expect(stdout).toContain("factory command in progress (pid");
    expect(stdout).toContain("#1 add-dark-mode");
    release();
  });

  it("reports a dead-holder lock as stale, not as an active run", () => {
    const h = makeHarness();
    mkdirSync(h.root, { recursive: true });
    writeFileSync(
      path.join(h.root, "factory.lock"),
      JSON.stringify({ pid: 999_999_999, ts: Date.now(), id: "test-id" }),
    );

    const { stdout, status } = runStatus(h.root);

    expect(status).toBe(0);
    expect(stdout).toContain("stale factory lock (pid 999999999");
    expect(stdout).not.toContain("factory command in progress");
  });

  it("prints a friendly message on a fresh root instead of a SQLite error", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "factory-fresh-"));
    try {
      const { stdout, status } = runStatus(root);
      expect(status).toBe(0);
      expect(stdout).toContain(`no factory.db in ${root} yet`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates already-claimed duplicates from claimable inbox files", () => {
    const h = makeHarness();
    h.inboxFile("add-dark-mode", { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] }, "Body.");
    claim(h);
    h.dropAgain("add-dark-mode", { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] }, "Body.");

    const { stdout } = runStatus(h.root);

    expect(stdout).toContain("will be skipped — slug already claimed (item #1");
    expect(stdout).not.toContain("awaiting claim");
  });

  it("reports an unreadable inbox instead of silently showing it as empty", () => {
    const h = makeHarness();
    chmodSync(h.paths.inbox, 0o000);
    try {
      const { stdout } = runStatus(h.root);
      expect(stdout).toContain("unreadable");
      expect(stdout).not.toContain("awaiting claim");
    } finally {
      chmodSync(h.paths.inbox, 0o755);
    }
  });
});