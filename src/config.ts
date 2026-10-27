import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

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

export interface FactoryConfig {
  /** Factory root directory (self-contained, movable). */
  root: string;
  models: StageModels;
  budgets: Budgets;
  sandbox: SandboxConfig;
}

export const DEFAULT_MODEL = "deepseek-v4-pro:0813";

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
    raw = JSON.parse(readFileSync(configFile, "utf8")) as Partial<FactoryConfig>;
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
  };
  return { config, root: candidate, configFile };
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