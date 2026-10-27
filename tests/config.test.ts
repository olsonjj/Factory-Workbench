import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, CONFIG_FILE_NAME, DEFAULT_MODEL } from "../src/config.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpRoot(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), "factory-config-"));
  roots.push(r);
  return r;
}

describe("P1-5: config validation", () => {
  it("a corrupt config file throws a clear parse error naming the file", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(configFile, "{ not json", "utf8");
    expect(() => loadConfig(root)).toThrow(/cannot parse factory config/);
    expect(() => loadConfig(root)).toThrow(configFile);
  });

  it("a wrong budget type is rejected and names the offending field", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(
      configFile,
      JSON.stringify({ budgets: { maxGateAttempts: "three", maxInfraRetries: 3, retryBackoffMs: 5000 } }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/invalid factory config/);
    expect(() => loadConfig(root)).toThrow(/budgets\.maxGateAttempts/);
  });

  it("a config path that is a directory throws a wrapped read error, not a raw EISDIR", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    mkdirSync(configFile, { recursive: true });
    try {
      loadConfig(root);
      throw new Error("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("cannot parse factory config");
      expect((err as Error).message).toContain(configFile);
    }
  });

  it("a valid partial config still merges defaults, including the new kb section", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(configFile, JSON.stringify({ sandbox: { imageName: "custom:image" } }), "utf8");
    const { config } = loadConfig(root);
    expect(config.sandbox.imageName).toBe("custom:image");
    expect(config.models.default).toBe(DEFAULT_MODEL);
    expect(config.budgets.maxGateAttempts).toBe(3);
    expect(config.kb).toEqual({ maxGlobalChars: 24000, maxProjectChars: 24000 });
  });
});
