import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { piConfigMounts, freshAgentDir, ollamaEnv, NPM_GLOBAL_PREFIX, type PiConfigStage } from "../src/adapters/sandcastle.js";

/** A stage literal is all freshAgentDir/piConfigMounts need. */
const stage = (agentDir = "/factory/pi-config"): PiConfigStage => ({ agentDir, npmGlobalPrefixBase: null });

describe("piConfigMounts", () => {
  it("with a prefix (agent mode): exactly two mounts, both writable", () => {
    const mounts = piConfigMounts("/factory/pi-config/agents/slug", "/factory/pi-config/npm-items/slug");
    expect(mounts).toHaveLength(2);
    // The per-run agent-dir copy must be WRITABLE: pi acquires a settings
    // lock (settings.json.lock) beside its settings file at read time, so a
    // read-only mount aborts startup (live-verified via the gated
    // integration suite). Isolation is temporal instead (per-run, wiped).
    expect(mounts[0]).toEqual({
      hostPath: "/factory/pi-config/agents/slug",
      sandboxPath: "/home/agent/.pi/agent",
    });
    expect(mounts[0].readonly).toBeUndefined();
    expect(mounts[1]).toEqual({
      hostPath: "/factory/pi-config/npm-items/slug",
      sandboxPath: NPM_GLOBAL_PREFIX,
    });
    expect(mounts[1].readonly).toBeUndefined();
  });

  it("without a prefix: exactly one mount (the agent dir)", () => {
    const mounts = piConfigMounts("/factory/pi-config/agents/slug", null);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.sandboxPath).toBe("/home/agent/.pi/agent");
    expect(mounts[0]!.readonly).toBeUndefined();
  });

  it("curator mode: the agent dir stays writable, the prefix mount is read-only", () => {
    const mounts = piConfigMounts("/factory/pi-config/agents/curator", "/factory/pi-config/npm-global-base", "curator");
    expect(mounts).toHaveLength(2);
    expect(mounts[0]!.sandboxPath).toBe("/home/agent/.pi/agent");
    expect(mounts[0]!.readonly).toBeUndefined();
    expect(mounts[1]).toEqual({
      hostPath: "/factory/pi-config/npm-global-base",
      sandboxPath: NPM_GLOBAL_PREFIX,
      readonly: true,
    });
  });
});

describe("freshAgentDir", () => {
  const root = path.join(process.cwd(), ".tmp-fresh-agent-dir-test");

  it("copies the template config files (never auth.json), creates a writable sessions dir, and wipes prior content", () => {
    const target = path.join(root, "agents", "slug");
    fs.rmSync(root, { recursive: true, force: true });
    const templateAgent = path.join(root, "template");
    fs.mkdirSync(templateAgent, { recursive: true });
    fs.writeFileSync(path.join(templateAgent, "settings.json"), '{"packages":[]}');
    fs.writeFileSync(path.join(templateAgent, "models.json"), "{}");
    fs.writeFileSync(path.join(templateAgent, "auth.json"), '{"secret":"sk-..."}');
    const template: PiConfigStage = { agentDir: templateAgent, npmGlobalPrefixBase: null };

    // First run: writes a marker that must NOT survive the second call.
    freshAgentDir(template, target);
    fs.writeFileSync(path.join(target, "tamper-marker"), "x");

    // Second run: a fresh copy — prior content (incl. tampering) is gone.
    freshAgentDir(template, target);
    for (const f of ["settings.json", "models.json"]) {
      expect(fs.readFileSync(path.join(target, f), "utf8")).toBe(f === "settings.json" ? '{"packages":[]}' : "{}");
    }
    expect(fs.existsSync(path.join(target, "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(target, "tamper-marker"))).toBe(false);
    expect(fs.statSync(path.join(target, "sessions")).isDirectory()).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates an empty writable dir even with a null template", () => {
    const target = path.join(root, "agents", "no-template");
    fs.rmSync(target, { recursive: true, force: true });
    freshAgentDir(null, target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(target, "sessions")).isDirectory()).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("ollamaEnv", () => {
  const KEYS = ["OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY", "OLLAMA_HOST"] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("does NOT pass OLLAMA_HOST through (a compromised stage must not redirect model traffic)", () => {
    process.env.OLLAMA_HOST = "http://attacker.example:11434";
    expect(ollamaEnv()).not.toHaveProperty("OLLAMA_HOST");
  });

  it("passes the Ollama Cloud API key vars through when set", () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    process.env.OLLAMA_CLOUD_API_KEY = "sk-cloud";
    expect(ollamaEnv()).toEqual({
      OLLAMA_API_KEY: "sk-test",
      OLLAMA_CLOUD_API_KEY: "sk-cloud",
    });
  });

  it("returns an empty record when nothing is set", () => {
    for (const key of KEYS) delete process.env[key];
    expect(ollamaEnv()).toEqual({});
  });
});
