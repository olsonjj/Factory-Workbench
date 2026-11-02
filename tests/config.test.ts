import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, CONFIG_FILE_NAME, DEFAULT_MODEL, modelFor, CLAUDE_DEFAULT_MODEL, CLAUDE_DEFAULT_REVIEW_MODEL, isClaudeModelId } from "../src/config.js";

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

  it("maxInfraRetries 0 is valid (retries disabled), not rejected at startup", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(
      configFile,
      JSON.stringify({ budgets: { maxGateAttempts: 1, maxInfraRetries: 0, retryBackoffMs: 0 } }),
      "utf8",
    );
    const { config } = loadConfig(root);
    expect(config.budgets.maxInfraRetries).toBe(0);
  });
});

describe("agent provider config", () => {
  it("a missing agent section defaults to provider pi with the pi model defaults (zero regression)", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(configFile, JSON.stringify({}), "utf8");
    const { config } = loadConfig(root);
    expect(config.agent.provider).toBe("pi");
    expect(config.models.default).toBe(DEFAULT_MODEL);
    expect(config.models.review).toBe("glm-5.3-flash");
    expect(modelFor(config.models, "triage")).toBe(DEFAULT_MODEL);
  });

  it("provider claude swaps the default models for Claude ids", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(configFile, JSON.stringify({ agent: { provider: "claude" } }), "utf8");
    const { config } = loadConfig(root);
    expect(config.agent.provider).toBe("claude");
    expect(config.models.default).toBe(CLAUDE_DEFAULT_MODEL);
    for (const stage of ["triage", "spec", "implement", "test", "curate"]) {
      expect(modelFor(config.models, stage)).toBe(CLAUDE_DEFAULT_MODEL);
    }
    expect(modelFor(config.models, "review")).toBe(CLAUDE_DEFAULT_REVIEW_MODEL);
  });

  it("an unknown provider is rejected at startup naming agent.provider and the config file", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(configFile, JSON.stringify({ agent: { provider: "codex" } }), "utf8");
    expect(() => loadConfig(root)).toThrow(/invalid factory config/);
    expect(() => loadConfig(root)).toThrow(/agent\.provider/);
    expect(() => loadConfig(root)).toThrow(configFile);
  });

  it("per-stage model overrides win over the claude defaults", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    writeFileSync(
      configFile,
      JSON.stringify({
        agent: { provider: "claude" },
        models: { triage: "claude-haiku-5-5", review: "claude-haiku-5-5" },
      }),
      "utf8",
    );
    const { config } = loadConfig(root);
    expect(modelFor(config.models, "triage")).toBe("claude-haiku-5-5");
    expect(modelFor(config.models, "review")).toBe("claude-haiku-5-5");
    // Unoverridden stages keep the claude defaults.
    expect(modelFor(config.models, "implement")).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it("an explicit Claude models.default wins over the provider defaults", () => {
    const root = tmpRoot();
    writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      JSON.stringify({ agent: { provider: "claude" }, models: { default: "opus" } }),
      "utf8",
    );
    const { config } = loadConfig(root);
    expect(config.models.default).toBe("opus");
    // The claude review default still applies (only default was overridden).
    expect(config.models.review).toBe(CLAUDE_DEFAULT_REVIEW_MODEL);
  });

  it("provider claude rejects leftover Ollama ids from a pi-generated config, naming each stage", () => {
    const root = tmpRoot();
    const configFile = path.join(root, CONFIG_FILE_NAME);
    // Shape wb init writes, with only the provider flipped.
    writeFileSync(
      configFile,
      JSON.stringify({
        agent: { provider: "claude" },
        models: { default: "deepseek-v4-pro:0813", review: "glm-5.3-flash" },
      }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/models\.default: "deepseek-v4-pro:0813", models\.review: "glm-5\.3-flash"/);
    expect(() => loadConfig(root)).toThrow(configFile);
  });

  it("provider pi does not apply the Claude id check", () => {
    const root = tmpRoot();
    writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      JSON.stringify({ agent: { provider: "pi" }, models: { default: "deepseek-v4-pro:0813" } }),
      "utf8",
    );
    expect(loadConfig(root).config.models.default).toBe("deepseek-v4-pro:0813");
  });

  it("isClaudeModelId accepts claude-* ids and aliases, rejects others", () => {
    for (const ok of ["claude-sonnet-5-5", "claude-opus-5-5", "sonnet", "opus", "haiku", "opusplan", "sonnet[1m]", "claude-opus-5-5[1m]"]) {
      expect(isClaudeModelId(ok), ok).toBe(true);
    }
    for (const bad of ["deepseek-v4-pro:0813", "glm-5.3-flash", "gpt-5", "", "Sonnet", "claude-"]) {
      expect(isClaudeModelId(bad), bad).toBe(false);
    }
  });
});
