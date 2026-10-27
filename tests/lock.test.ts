import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("stale-lock recovery is atomic: no sweep files remain after acquiring over a stale lock", () => {
    const root = tmpRoot();
    const lockPath = path.join(root, "factory.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }), "utf8");
    const release = acquireFactoryLock(root);
    try {
      const leftovers = readdirSync(root).filter((f) => f.includes(".stale"));
      expect(leftovers).toEqual([]);
    } finally {
      release();
    }
  });

  it("release is ownership-checked: an orphaned release does not delete a fresh owner's lock", () => {
    const root = tmpRoot();
    const lockPath = path.join(root, "factory.lock");
    const release = acquireFactoryLock(root);
    // Simulate takeover: another process swept our (orphaned) lock and wrote
    // its own fresh lock under the same path.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), id: "fresh-owner" }), "utf8");
    release(); // must NOT delete the fresh owner's lock
    expect(existsSync(lockPath)).toBe(true);
    expect(() => acquireFactoryLock(root)).toThrow(FactoryBusyError);
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
