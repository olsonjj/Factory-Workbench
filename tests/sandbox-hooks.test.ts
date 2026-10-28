import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sandboxReadyHooksFor } from "../src/adapters/sandcastle.js";

describe("sandboxReadyHooksFor", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "wt-hooks-"));
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("returns an npm-install onSandboxReady hook for a Node worktree", () => {
    fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"x"}');
    const hooks = sandboxReadyHooksFor(worktree);
    expect(hooks?.sandbox?.onSandboxReady).toEqual([
      { command: "npm install --no-audit --no-fund", timeoutMs: 300_000 },
    ]);
  });

  it("returns undefined for a non-Node worktree (Makefile / CI-config projects)", () => {
    fs.writeFileSync(path.join(worktree, "Makefile"), "test:\n\techo ok\n");
    expect(sandboxReadyHooksFor(worktree)).toBeUndefined();
  });
});