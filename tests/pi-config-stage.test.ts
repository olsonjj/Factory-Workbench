import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiConfigStage } from "../src/adapters/sandcastle.js";

/**
 * pi-config staging is gated on the host ~/.pi/agent having config files.
 * Point HOME at a fixture dir so the tests are hermetic; every test uses a
 * fresh factory root so the module-global stage cache cannot leak between them.
 */
describe("getPiConfigStage", () => {
  let homeFixture: string;
  let realHome: string | undefined;

  beforeEach(() => {
    realHome = process.env.HOME;
    homeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"));
    process.env.HOME = homeFixture;
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(homeFixture, { recursive: true, force: true });
  });

  const factoryRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "factory-pi-stage-"));
  /** Give the fixture host the minimal pi config file (only auth.json today). */
  const giveHostAuth = (): void => {
    fs.mkdirSync(path.join(homeFixture, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(homeFixture, ".pi", "agent", "auth.json"), '{"key":"k"}');
  };

  it("returns null (and stages nothing) when the host has no pi config files", () => {
    const root = factoryRoot();
    expect(getPiConfigStage(root)).toBeNull();
    expect(fs.existsSync(path.join(root, "pi-config"))).toBe(false);
  });

  it("stages the host config files into <factoryRoot>/pi-config", () => {
    giveHostAuth();
    const root = factoryRoot();
    const staged = getPiConfigStage(root);
    expect(staged).not.toBeNull();
    expect(staged!.agentDir).toBe(path.join(root, "pi-config"));
    expect(staged!.npmGlobalPrefix).toBeNull();
    expect(fs.readFileSync(path.join(staged!.agentDir, "auth.json"), "utf8")).toBe('{"key":"k"}');
  });

  it("caches the stage while its directory exists", () => {
    giveHostAuth();
    const root = factoryRoot();
    const first = getPiConfigStage(root);
    // Mutate the staged copy; the cache must keep returning the SAME stage.
    fs.writeFileSync(path.join(first!.agentDir, "extra-marker"), "x");
    const second = getPiConfigStage(root);
    expect(second).not.toBeNull();
    expect(fs.existsSync(path.join(second!.agentDir, "extra-marker"))).toBe(true);
  });

  it("self-heals: re-stages when the staged directory was deleted", () => {
    giveHostAuth();
    const root = factoryRoot();
    expect(getPiConfigStage(root)).not.toBeNull();
    // Factory root rebuilt (e.g. harness cleanup between suites, operator wipe).
    fs.rmSync(path.join(root, "pi-config"), { recursive: true, force: true });
    const healed = getPiConfigStage(root);
    expect(healed).not.toBeNull();
    expect(fs.readFileSync(path.join(healed!.agentDir, "auth.json"), "utf8")).toBe('{"key":"k"}');
  });

  it("re-derives from a null cached entry once the host config appears", () => {
    // First call with no host files: null is cached (as a nullified entry).
    const root = factoryRoot();
    expect(getPiConfigStage(root)).toBeNull();
    // Host config appears afterwards — the latest call must pick it up rather
    // than returning the stale null forever.
    giveHostAuth();
    expect(getPiConfigStage(root)).not.toBeNull();
  });
});