import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

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

export function acquireFactoryLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, "factory.lock");
  if (existsSync(lockPath) && lockStale(lockPath)) rmSync(lockPath, { force: true });
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new FactoryBusyError(lockPath);
    throw err;
  }
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* already gone */
    }
  };
}
