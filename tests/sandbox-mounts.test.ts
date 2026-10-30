import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { piConfigMounts, ollamaEnv, NPM_GLOBAL_PREFIX, type PiConfigStage } from "../src/adapters/sandcastle.js";

/** A stage literal is all piConfigMounts needs — no filesystem involved. */
const stage = (agentDir = "/factory/pi-config"): PiConfigStage => ({ agentDir, npmGlobalPrefixBase: null });

describe("piConfigMounts", () => {
  it("with a prefix (agent mode): exactly three mounts, config read-only, sessions writable child, prefix writable", () => {
    const mounts = piConfigMounts(stage("/factory/pi-config"), "/factory/pi-config/npm-items/slug");
    expect(mounts).toHaveLength(3);
    expect(mounts[0]).toEqual({
      hostPath: "/factory/pi-config",
      sandboxPath: "/home/agent/.pi/agent",
      readonly: true,
    });
    // Writable sessions child shadowing the read-only parent, at exactly the
    // path the sandboxed pi writes session files to.
    expect(mounts[1]).toEqual({
      hostPath: path.join("/factory/pi-config", "sessions"),
      sandboxPath: "/home/agent/.pi/agent/sessions",
    });
    expect(mounts[1].readonly).toBeUndefined();
    expect(mounts[2]).toEqual({
      hostPath: "/factory/pi-config/npm-items/slug",
      sandboxPath: NPM_GLOBAL_PREFIX,
    });
    expect(mounts[2].readonly).toBeUndefined();
  });

  it("without a prefix: exactly two mounts (config + sessions)", () => {
    const mounts = piConfigMounts(stage(), null);
    expect(mounts).toHaveLength(2);
    expect(mounts[0].readonly).toBe(true);
    expect(mounts[1].sandboxPath).toBe("/home/agent/.pi/agent/sessions");
  });

  it("curator mode: the prefix mount is read-only too", () => {
    const mounts = piConfigMounts(stage(), "/factory/pi-config/npm-global-base", "curator");
    expect(mounts).toHaveLength(3);
    expect(mounts[0].readonly).toBe(true);
    expect(mounts[1].readonly).toBeUndefined();
    expect(mounts[2]).toEqual({
      hostPath: "/factory/pi-config/npm-global-base",
      sandboxPath: NPM_GLOBAL_PREFIX,
      readonly: true,
    });
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