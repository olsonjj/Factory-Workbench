import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export interface StageModels {
  default: string;
  triage?: string;
  spec?: string;
  implement?: string;
  test?: string;
  review?: string;
  curate?: string;
}

export interface Budgets {
  /** Max total attempts per gate before the item parks (exhausted-rework). */
  maxGateAttempts: number;
  /** Max automatic retries for transient infra failures per stage episode. */
  maxInfraRetries: number;
  /** Base backoff in ms for infra retries (doubles per retry). */
  retryBackoffMs: number;
}

export interface SandboxConfig {
  /** Docker image used by the Sandcastle adapter. */
  imageName: string;
}

export interface KbConfig {
  /** Max chars of the global KB layer loaded into a full (non-triage) stage. */
  maxGlobalChars: number;
  /** Max chars of the project KB layer loaded into a full stage. */
  maxProjectChars: number;
}

export interface FactoryConfig {
  /** Factory root directory (self-contained, movable). */
  root: string;
  models: StageModels;
  budgets: Budgets;
  sandbox: SandboxConfig;
  kb: KbConfig;
}

export const DEFAULT_MODEL = "deepseek-v4-pro:0813";

/**
 * Model-selection rationale for the LIVE factory.config.json (2026-10):
 * the config file is plain JSON — it cannot carry comments — so the reasoning
 * lives here and in README "Model selection".
 *
 * Current live assignment:
 *   default:  deepseek-v4.1-flash-1017 — triage/spec/test/curate.
 *             Best value on the Ollama Cloud catalog at decision time:
 *             highest Intelligence Index on its tier (~45, Artificial
 *             Analysis) at ~2x the TPS and roughly half the off-peak price
 *             of deepseek-v4-pro. These stages are short/mechanical;
 *             flagship weight buys nothing here.
 *   implement: glm-5.3 — strong long-horizon agent benchmarks (DeepSWE,
 *             AutomationBench, Terminal-Bench) where this pipeline's
 *             failure cost is concentrated; slowest of the picks, which is
 *             acceptable because implement runs once per item.
 *   review:   deepseek-v4-pro:0813 — deliberately a DIFFERENT model family
 *             from implement (ticket 06): the review gate exists to catch
 *             what the implementer's blind spots let through, so it must
 *             not share them. Cheap enough to rerun freely.
 *
 * Invariants when editing live models:
 *   1. implement and review must be different families.
 *   2. Model ids must exist in the Ollama Cloud catalog reachable via
 *      OLLAMA_API_KEY; a typo only surfaces as a mid-pipeline failure.
 *   3. Judge swaps by cost per passed item (factory DB: usage.model + gate
 *      outcomes), not by benchmark tables.
 */

export const DEFAULT_CONFIG: Omit<FactoryConfig, "root"> = {
  models: {
    default: DEFAULT_MODEL,
    // Review deliberately runs a different model family from implement
    // (ticket 06) to avoid shared blind spots. Overridable per config file.
    review: "glm-5.3-flash",
  },
  budgets: {
    maxGateAttempts: 3,
    maxInfraRetries: 3,
    retryBackoffMs: 5000,
  },
  sandbox: { imageName: "sandcastle:local" },
  kb: { maxGlobalChars: 24000, maxProjectChars: 24000 },
};

/** Model id for a stage: explicit per-stage override, else the default. */
export function modelFor(models: StageModels, stage: string): string {
  const override = (models as unknown as Record<string, string | undefined>)[stage];
  return override && override.length > 0 ? override : models.default;
}

export const CONFIG_FILE_NAME = "factory.config.json";

export interface ConfigLoadResult {
  config: FactoryConfig;
  root: string;
  configFile: string;
}

const configSchema = z.object({
  root: z.string().min(1),
  models: z.object({
    default: z.string().min(1),
    triage: z.string().min(1).optional(),
    spec: z.string().min(1).optional(),
    implement: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
    curate: z.string().min(1).optional(),
  }),
  budgets: z.object({
    maxGateAttempts: z.number().int().positive(),
    // nonnegative (not positive): 0 is a legitimate way to disable automatic
    // retries, and loadConfig must not reject it at startup.
    maxInfraRetries: z.number().int().nonnegative(),
    retryBackoffMs: z.number().int().nonnegative(),
  }),
  sandbox: z.object({ imageName: z.string().min(1) }),
  kb: z.object({
    maxGlobalChars: z.number().int().positive(),
    maxProjectChars: z.number().int().positive(),
  }),
});

/**
 * Load the factory configuration. `rootOverride` (CLI --root) wins over
 * `FACTORY_ROOT`, which wins over the config file's own `root` field, which
 * wins over `./factory` relative to the working directory.
 */
export function loadConfig(rootOverride?: string, cwd: string = process.cwd()): ConfigLoadResult {
  let candidate = rootOverride ?? process.env.FACTORY_ROOT ?? path.join(cwd, "factory");
  const configFile = path.join(candidate, CONFIG_FILE_NAME);
  let raw: Partial<FactoryConfig> = {};
  if (existsSync(configFile)) {
    try {
      raw = JSON.parse(readFileSync(configFile, "utf8")) as Partial<FactoryConfig>;
    } catch (err) {
      throw new Error(`cannot parse factory config ${configFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rootOverride === undefined && process.env.FACTORY_ROOT === undefined) {
      if (typeof raw.root === "string" && raw.root.length > 0) candidate = raw.root;
    }
  }
  const config: FactoryConfig = {
    root: candidate,
    models: {
      ...DEFAULT_CONFIG.models,
      ...(raw.models ?? {}),
    },
    budgets: {
      ...DEFAULT_CONFIG.budgets,
      ...(raw.budgets ?? {}),
    },
    sandbox: {
      ...DEFAULT_CONFIG.sandbox,
      ...(raw.sandbox ?? {}),
    },
    kb: {
      ...DEFAULT_CONFIG.kb,
      ...(raw.kb ?? {}),
    },
  };
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid factory config ${configFile}: ${detail}`);
  }
  return { config: parsed.data, root: candidate, configFile };
}

/** Write a default config file if the factory root has none. Returns whether it was created. */
export function ensureConfigFile(root: string): boolean {
  const configFile = path.join(root, CONFIG_FILE_NAME);
  mkdirSync(root, { recursive: true });
  if (existsSync(configFile)) return false;
  const defaults = {
    ...DEFAULT_CONFIG,
    root,
    models: {
      default: DEFAULT_MODEL,
      // Review deliberately runs a different model family from implement to
      // avoid shared blind spots (ticket 06). All other stages ride the default.
      review: "glm-5.3-flash",
      // Other per-stage overrides slot in here as needed:
      // "triage": "deepseek-v4-flash", "test": "deepseek-v4-flash",
    },
  };
  writeFileSync(configFile, JSON.stringify(defaults, null, 2));
  return true;
}