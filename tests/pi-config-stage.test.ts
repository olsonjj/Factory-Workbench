import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiConfigStage, newestSemver, parsePackageSpec, resolveExactSpecs } from "../src/adapters/sandcastle.js";

/**
 * pi-config staging is gated on the host ~/.pi/agent having config files
 * (auth.json is deliberately NOT staged — finding H1). Point HOME at a
 * fixture dir so the tests are hermetic; every test uses a fresh factory
 * root so the module-global stage cache cannot leak between them.
 */
describe("getPiConfigStage", () => {
  let homeFixture: string;
  let realHome: string | undefined;
  /** Every factory root created by factoryRoot() in the current test. */
  let factoryRoots: string[];

  beforeEach(() => {
    realHome = process.env.HOME;
    homeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"));
    factoryRoots = [];
    process.env.HOME = homeFixture;
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(homeFixture, { recursive: true, force: true });
    for (const root of factoryRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  const factoryRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-pi-stage-"));
    factoryRoots.push(root);
    return root;
  };
  /** Give the fixture host the minimal storable pi config (settings.json). */
  const giveHostConfig = (): void => {
    fs.mkdirSync(path.join(homeFixture, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(homeFixture, ".pi", "agent", "settings.json"), '{"packages":[]}');
  };

  it("returns null (and stages nothing) when the host has no pi config files", () => {
    const root = factoryRoot();
    expect(getPiConfigStage(root)).toBeNull();
    expect(fs.existsSync(path.join(root, "pi-config"))).toBe(false);
  });

  it("stages the host config files into <factoryRoot>/pi-config", () => {
    giveHostConfig();
    const root = factoryRoot();
    const staged = getPiConfigStage(root);
    expect(staged).not.toBeNull();
    expect(staged!.agentDir).toBe(path.join(root, "pi-config"));
    expect(staged!.npmGlobalPrefixBase).toBeNull();
    expect(fs.readFileSync(path.join(staged!.agentDir, "settings.json"), "utf8")).toBe('{"packages":[]}');
    // The writable session dir (mounted as its own child mount in the sandbox)
    // must exist so the mount's host-path existence check passes.
    expect(fs.existsSync(path.join(staged!.agentDir, "sessions"))).toBe(true);
  });

  it("never stages auth.json, even when present on the host", () => {
    giveHostConfig();
    fs.writeFileSync(path.join(homeFixture, ".pi", "agent", "auth.json"), '{"secret":"sk-..."}');
    const root = factoryRoot();
    const staged = getPiConfigStage(root);
    expect(staged).not.toBeNull();
    expect(fs.existsSync(path.join(staged!.agentDir, "auth.json"))).toBe(false);
  });

  it("stages nothing for a host that has only auth.json", () => {
    fs.mkdirSync(path.join(homeFixture, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(homeFixture, ".pi", "agent", "auth.json"), '{"key":"k"}');
    const root = factoryRoot();
    expect(getPiConfigStage(root)).toBeNull();
    expect(fs.existsSync(path.join(root, "pi-config"))).toBe(false);
  });

  it("caches the stage while its directory exists", () => {
    giveHostConfig();
    const root = factoryRoot();
    const first = getPiConfigStage(root);
    // Mutate the staged copy; the cache must keep returning the SAME stage.
    fs.writeFileSync(path.join(first!.agentDir, "extra-marker"), "x");
    const second = getPiConfigStage(root);
    expect(second).not.toBeNull();
    // Object identity: the cache must return the SAME stage, not re-stage
    // (re-staging would re-copy files and could even repeat an npm install).
    expect(second).toBe(first);
    expect(fs.existsSync(path.join(second!.agentDir, "extra-marker"))).toBe(true);
  });

  it("self-heals: re-stages when the staged directory was deleted", () => {
    giveHostConfig();
    const root = factoryRoot();
    expect(getPiConfigStage(root)).not.toBeNull();
    // Factory root rebuilt (e.g. harness cleanup between suites, operator wipe).
    fs.rmSync(path.join(root, "pi-config"), { recursive: true, force: true });
    const healed = getPiConfigStage(root);
    expect(healed).not.toBeNull();
    expect(fs.readFileSync(path.join(healed!.agentDir, "settings.json"), "utf8")).toBe('{"packages":[]}');
  });

  it("re-derives from a null cached entry once the host config appears", () => {
    // First call with no host files: null is cached (as a nullified entry).
    const root = factoryRoot();
    expect(getPiConfigStage(root)).toBeNull();
    // Host config appears afterwards — the latest call must pick it up rather
    // than returning the stale null forever.
    giveHostConfig();
    expect(getPiConfigStage(root)).not.toBeNull();
  });
});

describe("parsePackageSpec", () => {
  it("splits a bare name with a null range", () => {
    expect(parsePackageSpec("pi-ollama-cloud")).toEqual({ name: "pi-ollama-cloud", range: null });
  });

  it("splits name@exact", () => {
    expect(parsePackageSpec("pi-ollama-cloud@1.2.3")).toEqual({ name: "pi-ollama-cloud", range: "1.2.3" });
  });

  it("splits a scoped name without a range", () => {
    expect(parsePackageSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", range: null });
  });

  it("splits a scoped name with a range (the separating @ is the last one)", () => {
    expect(parsePackageSpec("@scope/pkg@^1")).toEqual({ name: "@scope/pkg", range: "^1" });
  });

  it("splits a dist-tag range", () => {
    expect(parsePackageSpec("pkg@next")).toEqual({ name: "pkg", range: "next" });
  });

  it("strips a leading npm: prefix (as pi's settings declare specs)", () => {
    expect(parsePackageSpec("npm:@scope/pkg@^1")).toEqual({ name: "@scope/pkg", range: "^1" });
    expect(parsePackageSpec("npm:pkg")).toEqual({ name: "pkg", range: null });
  });
});

describe("resolveExactSpecs", () => {
  /** Counting fake resolver — lets us assert which specs needed resolution. */
  const fakeResolver = (): { calls: { name: string; range: string | null }[]; resolve: (n: string, r: string | null) => string } => {
    const calls: { name: string; range: string | null }[] = [];
    return {
      calls,
      resolve: (name, range) => {
        calls.push({ name, range });
        return "9.9.9";
      },
    };
  };

  it("resolves bare names via the resolver", () => {
    const fake = fakeResolver();
    expect(resolveExactSpecs(["pi-ollama-cloud"], fake.resolve)).toEqual(["pi-ollama-cloud@9.9.9"]);
    expect(fake.calls).toEqual([{ name: "pi-ollama-cloud", range: null }]);
  });

  it("resolves range specs via the resolver, passing the range through", () => {
    const fake = fakeResolver();
    expect(resolveExactSpecs(["@scope/pkg@^1", "pkg@next"], fake.resolve)).toEqual([
      "@scope/pkg@9.9.9",
      "pkg@9.9.9",
    ]);
    expect(fake.calls).toEqual([
      { name: "@scope/pkg", range: "^1" },
      { name: "pkg", range: "next" },
    ]);
  });

  it("passes full-semver specs through untouched WITHOUT calling the resolver", () => {
    const fake = fakeResolver();
    expect(resolveExactSpecs(["pkg@1.2.3"], fake.resolve)).toEqual(["pkg@1.2.3"]);
    expect(fake.calls).toEqual([]);
  });

  it("passes full-semver specs with prerelease/build suffixes through without resolving", () => {
    const fake = fakeResolver();
    expect(resolveExactSpecs(["pkg@1.2.3-beta.1", "pkg@2.0.0+build.7"], fake.resolve)).toEqual([
      "pkg@1.2.3-beta.1",
      "pkg@2.0.0+build.7",
    ]);
    expect(fake.calls).toEqual([]);
  });

  it("throws when the resolver throws (caller aborts seeding)", () => {
    const resolve = (): string => {
      throw new Error("unresolvable");
    };
    expect(() => resolveExactSpecs(["pkg"], resolve)).toThrow("unresolvable");
  });
});

describe("newestSemver", () => {
  it("picks the semver-sorted newest entry regardless of payload order", () => {
    // npm's own ordering is undocumented — lexicographic string sort would
    // pick 1.9.0 from this payload; the pin must be 1.10.0.
    expect(newestSemver(["1.9.0", "1.2.0", "1.10.0"])).toBe("1.10.0");
    expect(newestSemver(["0.9.0", "2.0.0", "1.10.0", "2.1.0-beta.1"])).toBe("2.1.0-beta.1");
  });

  it("passes a single-version payload through", () => {
    expect(newestSemver("1.2.3")).toBe("1.2.3");
  });

  it("sorts a clean release above same-version prereleases, by semver §11 precedence", () => {
    expect(newestSemver(["2.0.0-beta.1", "2.0.0", "2.0.0-beta.2"])).toBe("2.0.0");
    expect(newestSemver(["2.0.0-beta.1", "2.0.0-beta.2"])).toBe("2.0.0-beta.2");
    // Numeric segments compare numerically, not lexicographically.
    expect(newestSemver(["2.0.0-beta.2", "2.0.0-beta.10"])).toBe("2.0.0-beta.10");
    // More segments above an equal-length prefix; alphanumeric above numeric.
    expect(newestSemver(["2.0.0-beta", "2.0.0-beta.2"])).toBe("2.0.0-beta.2");
    expect(newestSemver(["2.0.0-2", "2.0.0-beta"])).toBe("2.0.0-beta");
  });

  it("build metadata carries no precedence (first tie wins)", () => {
    expect(newestSemver(["2.0.0-beta.1+exp.1", "2.0.0-beta.1+exp.9"])).toBe("2.0.0-beta.1+exp.1");
    const picked = newestSemver(["2.0.0+build.9", "2.0.0+build.1"]);
    expect(picked).toMatch(/^2\.0\.0\+build\.(9|1)$/);
  });

  it("throws on an empty payload and on semver-unparsable entries (caller aborts seeding, unpinned never)", () => {
    expect(() => newestSemver([])).toThrow("no version resolved");
    expect(() => newestSemver(["latest", "next"])).toThrow("no semver-parsable version");
    expect(() => newestSemver("")).toThrow("no version resolved");
  });

  it("ignores non-semver members of a mixed payload rather than pinning them", () => {
    expect(newestSemver(["latest", "1.2.3"])).toBe("1.2.3");
  });
});
