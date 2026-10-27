import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { acquireFactoryLock, FactoryBusyError } from "../src/lock.js";
import { FactoryDb } from "../src/db.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpRoot(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), "factory-lock-"));
  roots.push(r);
  return r;
}

describe("P1-4: process lock + sqlite busy timeout", () => {
  it("acquire returns a release; a second acquire throws; release allows re-acquire", () => {
    const root = tmpRoot();
    const release = acquireFactoryLock(root);
    expect(() => acquireFactoryLock(root)).toThrow(FactoryBusyError);
    release();
    const again = acquireFactoryLock(root);
    again();
  });

  it("a stale lock with a dead PID is removed and re-acquired", () => {
    const root = tmpRoot();
    const lockPath = path.join(root, "factory.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }), "utf8");
    const release = acquireFactoryLock(root); // must clear the stale lock, not throw
    expect(() => release()).not.toThrow();
  });

  it("a lock with a live PID is not treated as stale", () => {
    const root = tmpRoot();
    const lockPath = path.join(root, "factory.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
    expect(() => acquireFactoryLock(root)).toThrow(FactoryBusyError);
  });

  it("FactoryDb sets a sqlite busy_timeout", () => {
    const root = tmpRoot();
    const db = new FactoryDb(root);
    try {
      expect(db.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});
