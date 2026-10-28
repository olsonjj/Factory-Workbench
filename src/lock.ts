import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export class FactoryBusyError extends Error {
  constructor(lockPath: string) {
    super(`factory is busy (${lockPath}) — another wb process may be running`);
    this.name = "FactoryBusyError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export type LockPayload = { pid: number; ts: number; id: string };

/** Age past which an unreleased lock is presumed dead (staleness heuristic). */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/** Parse a lock file at an exact path; null if missing or shape-invalid. */
function parseLock(lockPath: string): LockPayload | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as LockPayload;
    if (Number.isInteger(raw?.pid) && raw.pid > 0 && typeof raw.ts === "number") return raw;
    return null;
  } catch {
    return null;
  }
}

/** Read the current lock holder, or null if no (parseable) lock exists. */
export function readLockInfo(root: string): LockInfo | null {
  return parseLock(path.join(root, "factory.lock"));
}

/** Whether the process recorded in the lock is still alive. */
export function lockHolderAlive(info: LockInfo): boolean {
  return pidAlive(info.pid);
}

function lockStale(lockPath: string): boolean {
  const holder = parseLock(lockPath);
  if (holder) return !pidAlive(holder.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export type LockInfo = LockPayload;

export function acquireFactoryLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, "factory.lock");
  const id = randomUUID();
  const token: LockPayload = { pid: process.pid, ts: Date.now(), id };
  for (;;) {
    // 1. Try to create the lock exclusively — the common path, no window.
    try {
      writeFileSync(lockPath, JSON.stringify(token), { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // 2. Something sits at the path. Take atomic ownership of whatever bytes
    //    are there NOW — rename() moves the whole file for exactly one
    //    racing acquirer, so recovery is itself exclusive. Staleness is then
    //    decided on the swept snapshot (which only we hold), never on the
    //    live path — there is no check→remove gap for a rival to slip into.
    const sweep = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    let swept = false;
    try {
      renameSync(lockPath, sweep);
      swept = true;
    } catch {
      /* gone — another acquirer moved it; loop and wx-create */
    }
    if (!swept) continue;
    if (lockStale(sweep)) {
      // Provably stale under our exclusive control: discard and re-create.
      rmSync(sweep, { force: true });
      continue;
    }
    // Fresh lock: not ours to take. Restore the snapshot untouched and yield.
    // (If a third acquirer created a lock in this few-µs window, leave its
    // bytes alone rather than clobbering them — yield busy either way.)
    if (!existsSync(lockPath)) {
      try {
        renameSync(sweep, lockPath);
        throw new FactoryBusyError(lockPath);
      } catch (err) {
        if (err instanceof FactoryBusyError) throw err;
        /* original owner removed it mid-flight — treat as gone, retry */
      }
      continue;
    }
    rmSync(sweep, { force: true });
    throw new FactoryBusyError(lockPath);
  }
  return ownershipCheckedRelease(lockPath, id);
}

function ownershipCheckedRelease(lockPath: string, id: string): () => void {
  // Ownership-checked release: never delete a lock we don't own (a fresh
  // owner may have taken over after we were orphaned by stale recovery).
  return () => {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockPayload;
      if (current?.id !== id) return;
      rmSync(lockPath, { force: true });
    } catch {
      /* already gone */
    }
  };
}