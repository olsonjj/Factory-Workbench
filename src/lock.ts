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

function lockStale(lockPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    const pid = Number(raw.pid);
    if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
  } catch {
    /* unparseable — fall through to age */
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > 10 * 60 * 1000;
  } catch {
    return false;
  }
}

type LockPayload = { pid: number; ts: number; id: string };

export function acquireFactoryLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, "factory.lock");
  // Stale-lock recovery must itself be exclusive. rmSync + create has a
  // TOCTOU window: two concurrent acquirers can both clear the stale lock
  // before either recreates it, and each "owner" then deletes the other's
  // fresh lock on release. Atomic rename closes the window — rename()
  // succeeds for exactly one caller (the loser gets ENOENT and then hits
  // EEXIST on wx, i.e. the normal busy path). The renamed file is swept up
  // once we own the fresh lock.
  const staleSweep = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  if (existsSync(lockPath) && lockStale(lockPath)) {
    try {
      renameSync(lockPath, staleSweep);
    } catch {
      /* lost the race to another acquirer — fall through to wx */
    }
  }
  const id = randomUUID();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), id } satisfies LockPayload), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new FactoryBusyError(lockPath);
    throw err;
  }
  rmSync(staleSweep, { force: true });
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