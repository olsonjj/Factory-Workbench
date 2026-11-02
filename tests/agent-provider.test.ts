import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Hermetic provider-selection tests for the Sandcastle adapter. No Docker, no
 * Claude Code, no pi run: the sandcastle docker-sandbox factory is mocked
 * (its options — imageName/mounts — are what the adapter-seam observations
 * need) and the main module's `run` is overridden so the curator path can be
 * driven without a sandbox. The provider factories themselves are swapped
 * for spies through the exported mutable `agentFactories` registry — the
 * single provider-selection point — instead of mocking the whole module
 * (which also exports createWorktree the adapter needs for real).
 */

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: (options: unknown) => ({ __fakeSandbox: true, options }),
}));

const runMock = vi.fn();
vi.mock("@ai-hero/sandcastle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-hero/sandcastle")>();
  return { ...actual, run: (...args: unknown[]) => runMock(...args) };
});

import {
  agentFactories,
  agentFor,
  claudeEnv,
  agentEnvFor,
  needsPiConfigStaging,
  piConfigStagingFor,
  ollamaEnv,
  SandcastleStageRunner,
  SandcastleCurator,
  type AgentProviderFactory,
} from "../src/adapters/sandcastle.js";
import type { Worktree } from "@ai-hero/sandcastle";
import type { FactoryConfig } from "../src/config.js";
import type { CuratorRequest } from "../src/types.js";

/** Original factories, captured at module load before any test swaps them. */
const originalFactories: Record<string, AgentProviderFactory> = { ...agentFactories };

const claudeSentinel = { name: "claude-sentinel" } as never;
const piSentinel = { name: "pi-sentinel" } as never;
let claudeSpy: ReturnType<typeof vi.fn>;
let piSpy: ReturnType<typeof vi.fn>;

/** A FactoryConfig literal over a fresh temp root. */
function makeConfig(provider: "pi" | "claude", root: string): FactoryConfig {
  return {
    root,
    models: { default: "test-model" },
    agent: { provider },
    budgets: { maxGateAttempts: 3, maxInfraRetries: 3, retryBackoffMs: 0 },
    sandbox: { imageName: provider === "claude" ? "sandcastle:claude" : "sandcastle:local" },
    kb: { maxGlobalChars: 24000, maxProjectChars: 24000 },
  };
}

/** A fake Worktree whose run() records the adapter's full run options. */
function fakeWorktree(): { wt: Worktree; run: ReturnType<typeof vi.fn>; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-wt-"));
  // A root package.json makes sandboxReadyHooksFor fire (npm-install hook),
  // which both providers must keep receiving in worktree stages.
  fs.writeFileSync(path.join(dir, "package.json"), '{ "name": "wt" }');
  const run = vi.fn(async () => ({
    iterations: [{ result: '<triage>{"outcome":"proceed","report":"r"}</triage>' }],
  }));
  const wt = { worktreePath: dir, run } as unknown as Worktree;
  return { wt, run, dir };
}

/** Run an async callback with a stubbed HOME seeded with ~/.pi/agent config. */
async function withSeededPiHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "factory-home-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), '{"packages":[]}');
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const tempRoots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-provider-"));
  tempRoots.push(root);
  return root;
}

beforeEach(() => {
  claudeSpy = vi.fn(() => claudeSentinel);
  piSpy = vi.fn(() => piSentinel);
  agentFactories.claude = claudeSpy as unknown as AgentProviderFactory;
  agentFactories.pi = piSpy as unknown as AgentProviderFactory;
  runMock.mockReset();
});

afterEach(() => {
  agentFactories.pi = originalFactories.pi!;
  agentFactories.claude = originalFactories.claude!;
  for (const r of tempRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("agentFor: provider dispatch", () => {
  it("dispatches to the claude factory with model and env, not to pi", () => {
    const agent = agentFor("claude", "claude-sonnet-4-6", { ANTHROPIC_API_KEY: "k" });
    expect(agent).toBe(claudeSentinel);
    expect(claudeSpy).toHaveBeenCalledTimes(1);
    expect(claudeSpy).toHaveBeenCalledWith("claude-sonnet-4-6", { env: { ANTHROPIC_API_KEY: "k" } });
    expect(piSpy).not.toHaveBeenCalled();
  });

  it("dispatches to the pi factory symmetrically", () => {
    const agent = agentFor("pi", "test-model", { OLLAMA_API_KEY: "o" });
    expect(agent).toBe(piSentinel);
    expect(piSpy).toHaveBeenCalledTimes(1);
    expect(piSpy).toHaveBeenCalledWith("test-model", { env: { OLLAMA_API_KEY: "o" } });
    expect(claudeSpy).not.toHaveBeenCalled();
  });
});

describe("SandcastleStageRunner.wtRun wiring", () => {
  it("claude: claude factory with the run model/env, no pi-config staging, no mounts, hook kept", async () => {
    const root = tmpRoot();
    const runner = new SandcastleStageRunner({
      config: makeConfig("claude", root),
      env: { ANTHROPIC_API_KEY: "k" },
    });
    const { wt, run, dir } = fakeWorktree();
    try {
      // Seed a host ~/.pi/agent: if provider gating is broken, staging would
      // copy it into <root>/pi-config. Under claude nothing may appear.
      await withSeededPiHome(async () => {
        await (runner as unknown as { wtRun: (o: unknown) => Promise<unknown> }).wtRun({
          wt,
          slug: "claude-item",
          model: "claude-sonnet-4-6",
          prompt: "p",
        });
      });
      expect(run).toHaveBeenCalledTimes(1);
      const arg = run.mock.calls[0]![0] as {
        agent: unknown;
        sandbox: { options: Record<string, unknown> };
        prompt: string;
        maxIterations: number;
        hooks?: { sandbox: { onSandboxReady: unknown[] } };
      };
      expect(arg.agent).toBe(claudeSentinel);
      expect(claudeSpy).toHaveBeenCalledWith("claude-sonnet-4-6", { env: { ANTHROPIC_API_KEY: "k" } });
      expect(piSpy).not.toHaveBeenCalled();
      // NO pi-config mounts for claude (the docker factory got no mounts key).
      expect(arg.sandbox.options).not.toHaveProperty("mounts");
      expect(arg.sandbox.options.imageName).toBe("sandcastle:claude");
      // Protocol invariants are provider-independent.
      expect(arg.maxIterations).toBe(1);
      expect(arg.prompt).toBe(`p\n\nWhen you are done, emit \`<promise>COMPLETE</promise>\` as the final line of your output.`);
      // Dependency-install hook applies to claude too (the worktree has a
      // root package.json, so the hook must be present).
      expect(arg.hooks?.sandbox.onSandboxReady).toBeTruthy();
      // Provider-gated staging: no pi-config directory was created at all.
      expect(fs.existsSync(path.join(root, "pi-config"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pi: pi factory, agent-dir mount staged, npm-prefix env semantics unchanged", async () => {
    const root = tmpRoot();
    const runner = new SandcastleStageRunner({
      config: makeConfig("pi", root),
      env: { OLLAMA_API_KEY: "o" },
    });
    const { wt, run, dir } = fakeWorktree();
    try {
      await withSeededPiHome(async () => {
        await (runner as unknown as { wtRun: (o: unknown) => Promise<unknown> }).wtRun({
          wt,
          slug: "pi-item",
          model: "test-model",
          prompt: "p",
        });
      });
      expect(run).toHaveBeenCalledTimes(1);
      const arg = run.mock.calls[0]![0] as {
        agent: unknown;
        sandbox: { options: { imageName: string; mounts: { hostPath: string; sandboxPath: string }[] } };
        hooks?: { sandbox: { onSandboxReady: unknown[] } };
      };
      expect(arg.agent).toBe(piSentinel);
      expect(piSpy).toHaveBeenCalledWith("test-model", { env: { OLLAMA_API_KEY: "o" } });
      expect(claudeSpy).not.toHaveBeenCalled();
      // The staged pi config template was copied (real getPiConfigStage ran).
      expect(fs.existsSync(path.join(root, "pi-config", "settings.json"))).toBe(true);
      // The per-run agent-dir copy is mounted at the sandboxed pi's agent path.
      // (The npm-prefix mount only exists when a prefix template was seeded —
      // that host-side npm path is covered by tests/pi-config-stage.test.ts.)
      expect(arg.sandbox.options.imageName).toBe("sandcastle:local");
      expect(arg.sandbox.options.mounts).toEqual([
        { hostPath: path.join(root, "pi-config", "agents", "pi-item"), sandboxPath: "/home/agent/.pi/agent" },
      ]);
      expect(arg.hooks?.sandbox.onSandboxReady).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SandcastleCurator provider wiring", () => {
  const curatorRequest = (): CuratorRequest => ({
    projects: [],
    kb: { global: "", project: "" },
    repoPaths: { demo: tmpRoot() },
  });

  it("claude: no agent-dir staging, no pi mount, stream text is authoritative", async () => {
    runMock.mockResolvedValue({
      iterations: [{ result: "<proposal>claude proposal</proposal>" }],
    });
    const root = tmpRoot();
    const curator = new SandcastleCurator({
      config: makeConfig("claude", root),
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
    });
    const result = await withSeededPiHome(async () => curator.propose(curatorRequest()));
    expect(result.outcome).toBe("pass");
    expect(result.artifacts[0]!.content).toBe("claude proposal");
    expect(runMock).toHaveBeenCalledTimes(1);
    const arg = runMock.mock.calls[0]![0] as {
      agent: unknown;
      sandbox: { options: { imageName: string; mounts: { sandboxPath: string; readonly?: boolean }[] } };
      maxIterations: number;
    };
    expect(arg.agent).toBe(claudeSentinel);
    expect(claudeSpy).toHaveBeenCalledWith("test-model", { env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } });
    expect(piSpy).not.toHaveBeenCalled();
    // Only the read-only repo mounts — no /home/agent/.pi/agent mount, no
    // npm-prefix mount, and no agent-dir staging on the host.
    expect(arg.sandbox.options.mounts.every((m) => m.sandboxPath.startsWith("repos/"))).toBe(true);
    expect(fs.existsSync(path.join(root, "pi-config"))).toBe(false);
    expect(arg.maxIterations).toBe(1);
  });

  it("pi: agent-dir staged and mounted, sessions fallback path intact", async () => {
    runMock.mockResolvedValue({
      iterations: [{ result: "" }], // stream text empty → sessions fallback
    });
    const root = tmpRoot();
    const curator = new SandcastleCurator({
      config: makeConfig("pi", root),
      env: { OLLAMA_API_KEY: "o" },
    });
    const req = curatorRequest();
    // Plant a session file in the per-run agent dir DURING the run: the
    // curator reads it via assistantTextFromSessions after run() resolves.
    runMock.mockImplementationOnce(async () => {
      const sessions = path.join(root, "pi-config", "agents", "curator", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      const line = JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "<proposal>pi proposal</proposal>" }] },
      });
      fs.writeFileSync(path.join(sessions, "s.jsonl"), `${line}\n`);
      return { iterations: [{ result: "" }] };
    });
    const result = await withSeededPiHome(async () => curator.propose(req));
    expect(result.outcome).toBe("pass");
    expect(result.artifacts[0]!.content).toBe("pi proposal");
    const arg = runMock.mock.calls[0]![0] as {
      agent: unknown;
      sandbox: { options: { mounts: { sandboxPath: string }[] } };
    };
    expect(arg.agent).toBe(piSentinel);
    expect(arg.sandbox.options.mounts.some((m) => m.sandboxPath === "/home/agent/.pi/agent")).toBe(true);
    // The per-run agent dir is wiped after the run (finally block).
    expect(fs.existsSync(path.join(root, "pi-config", "agents", "curator"))).toBe(false);
  });
});

describe("credential env passthrough", () => {
  const KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OLLAMA_API_KEY",
    "OLLAMA_CLOUD_API_KEY",
    "ANTHROPIC_BASE_URL",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  it("claudeEnv passes whichever credential is set — either alone suffices", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(claudeEnv()).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });

    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    expect(claudeEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });

    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    expect(claudeEnv()).toEqual({
      ANTHROPIC_API_KEY: "sk-anthropic",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
  });

  it("claudeEnv returns an empty record when neither credential is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(claudeEnv()).toEqual({});
  });

  it("claudeEnv never forwards Ollama keys or ANTHROPIC_BASE_URL (provider-exclusive, no redirect)", () => {
    process.env.OLLAMA_API_KEY = "sk-ollama";
    process.env.OLLAMA_CLOUD_API_KEY = "sk-ollama-cloud";
    process.env.ANTHROPIC_BASE_URL = "http://attacker.example";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    const env = claudeEnv();
    expect(env).not.toHaveProperty("OLLAMA_API_KEY");
    expect(env).not.toHaveProperty("OLLAMA_CLOUD_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
  });

  it("agentEnvFor is provider-exclusive both ways", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.OLLAMA_CLOUD_API_KEY;
    process.env.OLLAMA_API_KEY = "sk-ollama";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";

    const claude = agentEnvFor({ agent: { provider: "claude" } });
    expect(claude).toEqual(claudeEnv());
    expect(claude).not.toHaveProperty("OLLAMA_API_KEY");

    const pi = agentEnvFor({ agent: { provider: "pi" } });
    expect(pi).toEqual(ollamaEnv());
    expect(pi).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(pi).toEqual({ OLLAMA_API_KEY: "sk-ollama" });
  });
});

describe("pi-config staging gate", () => {
  it("needsPiConfigStaging is provider-scoped", () => {
    expect(needsPiConfigStaging("pi")).toBe(true);
    expect(needsPiConfigStaging("claude")).toBe(false);
  });

  it("piConfigStagingFor stages for pi and no-ops for claude (cache unpoisoned)", async () => {
    const root = tmpRoot();
    await withSeededPiHome(async () => {
      // claude: null WITHOUT any host-side staging side effect.
      expect(piConfigStagingFor("claude", root)).toBeNull();
      expect(fs.existsSync(path.join(root, "pi-config"))).toBe(false);
      // A subsequent pi call on the SAME root still stages correctly — the
      // claude no-op must not have poisoned the per-root stage cache.
      const staged = piConfigStagingFor("pi", root);
      expect(staged).not.toBeNull();
      expect(fs.existsSync(path.join(root, "pi-config", "settings.json"))).toBe(true);
      // And claude still no-ops after the pi stage exists.
      expect(piConfigStagingFor("claude", root)).toBeNull();
    });
  });
});