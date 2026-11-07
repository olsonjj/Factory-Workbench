import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** External-behavior test for `wb --version`: spawns the real CLI. */

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts");
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const expectedVersion = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;

function runWb(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

describe("wb --version (CLI external behavior)", () => {
  it("prints the package.json version to stdout and exits 0", () => {
    const { stdout, stderr, status } = runWb(["--version"]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/); // semver-looking
    expect(stdout.trim()).toBe(expectedVersion); // matches package.json at test run time
  });

  it("-V is the short form of the same flag", () => {
    const { stdout, status } = runWb(["-V"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(expectedVersion);
  });

  it("--version wins over any subcommand path (no subcommand action runs)", () => {
    const { stdout, stderr, status } = runWb(["--version", "status"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(expectedVersion);
    expect(stderr).not.toContain("unknown option");
  });
});
