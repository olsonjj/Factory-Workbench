/**
 * Stale-local-base detection (`baseFreshness`).
 *
 * Before a worktree-backed stage run (agent stage or the PR stage — both
 * consume `item.base`), the orchestrator checks that the target repo's local
 * base branch is not behind its upstream `origin/<base>`. A stale local base
 * makes every downstream stage work and judge against a base missing
 * already-merged upstream work (dogfood incident 2026-11-02: the reviewer
 * correctly reported a merged feature as nonexistent and triage looped).
 *
 * Mutation boundary (review-guard): `git fetch origin` updates only the
 * remote-tracking refs and the object store of the target repo's `.git` —
 * never the working tree, index, or local branches. It is the mutation the
 * item itself prescribes and does not breach "the factory never merges or
 * pulls". The fetch is a host-side network operation, not a new agent-stage
 * network dependency (spec user story 47: "no agent stage needs internet
 * access" still holds; the `gh` PR publisher already makes host-side
 * network calls).
 *
 * Every unverifiable condition degrades: fetch failure → warn-and-proceed
 * (the factory stays usable offline), no remote → silent proceed (nothing
 * to compare), diverged base → warn-and-proceed (the skip applies only to
 * strictly-behind bases — the incident shape — because a diverged base
 * already carries operator commits and skipping it risks interrupting
 * in-flight work). `check` never throws.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

export type BaseFreshnessAction = "proceed" | "skip" | "warn";

export interface BaseFreshnessResult {
  action: BaseFreshnessAction;
  /** Short (7-char) sha of local <base>; null when unresolvable or n/a. */
  localTip: string | null;
  /** Short (7-char) sha of origin/<base>; null when unresolvable or n/a. */
  upstreamTip: string | null;
  /** Human explanation for warn/skip; null for clean proceed. */
  message: string | null;
}

export interface BaseFreshnessChecker {
  /** Synchronous (host-side git plumbing, execFileSync house style). */
  check(repoPath: string, base: string): BaseFreshnessResult;
}

/** Fetch deliberately slower than the local git reads. */
export const FRESHNESS_FETCH_TIMEOUT_MS = 30_000;
export const FRESHNESS_GIT_TIMEOUT_MS = 10_000;

/** Local tiny mirror of gc.ts's helper (gc.ts is not touched by this item):
 *  execFileSync throws on non-zero exit, carrying `status` as the exit code. */
function exitCodeOf(err: unknown): number | null {
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `git -C <repoPath> …` with piped stdio, exactly the gc.ts house style. */
function git(repoPath: string, args: string[], timeout: number): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Real checker: host-side git plumbing only (`git -C`, execFileSync, piped
 * stdio, explicit timeouts — same conventions as `src/gc.ts`). Synchronous
 * and never-throwing; every failure degrades to warn/proceed.
 */
export class GitBaseFreshnessChecker implements BaseFreshnessChecker {
  check(repoPath: string, base: string): BaseFreshnessResult {
    // 1. Repo probe (same `.git` presence convention as GhPrPublisher).
    if (!existsSync(path.join(repoPath, ".git"))) {
      return { action: "warn", localTip: null, upstreamTip: null, message: `not a git repository: ${repoPath}` };
    }
    // 2. Remote probe — BEFORE the fetch so a remote-less repo is never
    //    warned at: no remote means nothing to compare, a normal state.
    try {
      git(repoPath, ["remote", "get-url", "origin"], FRESHNESS_GIT_TIMEOUT_MS);
    } catch {
      return { action: "proceed", localTip: null, upstreamTip: null, message: null };
    }
    // 3. Fetch (best-effort; failure = offline → warn-and-proceed).
    try {
      git(repoPath, ["fetch", "origin", "--quiet"], FRESHNESS_FETCH_TIMEOUT_MS);
    } catch (err) {
      return { action: "warn", localTip: null, upstreamTip: null, message: `git fetch origin failed (${errText(err)})` };
    }
    // 4. Local tip.
    let localSha: string;
    try {
      localSha = git(repoPath, ["rev-parse", "--verify", `refs/heads/${base}`], FRESHNESS_GIT_TIMEOUT_MS).trim();
    } catch {
      return {
        action: "warn",
        localTip: null,
        upstreamTip: null,
        message: `local base ${base} does not exist (worktree creation will fail on its own)`,
      };
    }
    // 5. Upstream tip — a remote without the branch means nothing to compare.
    let upstreamSha: string;
    try {
      upstreamSha = git(repoPath, ["rev-parse", "--verify", `refs/remotes/origin/${base}`], FRESHNESS_GIT_TIMEOUT_MS).trim();
    } catch {
      return { action: "proceed", localTip: shortSha(localSha), upstreamTip: null, message: null };
    }
    // 6. Ancestry (mirror of gc.ts's mergeBaseProbe, replicated locally).
    try {
      git(repoPath, ["merge-base", "--is-ancestor", localSha, upstreamSha], FRESHNESS_GIT_TIMEOUT_MS);
      // exit 0: local is an ancestor of upstream.
      if (localSha === upstreamSha) {
        return { action: "proceed", localTip: shortSha(localSha), upstreamTip: shortSha(upstreamSha), message: null };
      }
      // Strictly behind — the only skip path.
      return { action: "skip", localTip: shortSha(localSha), upstreamTip: shortSha(upstreamSha), message: null };
    } catch (err) {
      if (exitCodeOf(err) === 1) {
        // Diverged: local base has commits origin lacks. The incident shape
        // (merged upstream, untouched local) is strictly behind; a diverged
        // base already carries operator commits and skipping it risks
        // interrupting in-flight work — warn, don't skip.
        return {
          action: "warn",
          localTip: shortSha(localSha),
          upstreamTip: shortSha(upstreamSha),
          message: `local ${base} diverged from origin/${base} — not strictly behind; proceeding (skip applies only to strictly-behind bases)`,
        };
      }
      return {
        action: "warn",
        localTip: shortSha(localSha),
        upstreamTip: shortSha(upstreamSha),
        message: `merge-base probe failed (${errText(err)})`,
      };
    }
  }
}