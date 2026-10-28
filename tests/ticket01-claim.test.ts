import { describe, it, expect, afterEach } from "vitest";
import { createHarness, type TestHarness } from "./helpers.js";
import { FactoryDb } from "../src/db.js";
import { scanInbox } from "../src/inbox.js";
import { loadConfig, ensureConfigFile, modelFor, DEFAULT_MODEL } from "../src/config.js";

let harness: TestHarness;
afterEach(() => {
  harness?.cleanup();
});

describe("ticket 01: factory skeleton + inbox ingest", () => {
  it("claims a well-formed inbox file: status shows it, file moves to item store, inbox empties", () => {
    harness = createHarness();
    const file = harness.inboxFile(
      "add-dark-mode",
      { title: "Add dark mode", repo: "/tmp/some-repo", base: "main", approvals: [] },
      "Add a dark theme toggle to settings.",
    );

    const report = scanInbox(harness.paths, harness.db);

    expect(report.claimed).toHaveLength(1);
    expect(report.claimed[0]!.slug).toBe("add-dark-mode");
    expect(report.malformed).toHaveLength(0);

    const items = harness.db.listItems();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.slug).toBe("add-dark-mode");
    expect(item.title).toBe("Add dark mode");
    expect(item.status).toBe("queued");
    expect(item.stage).toBe("triage");
    expect(item.branchName).toBe("factory/add-dark-mode");
    // source of truth has physically moved into the item store
    expect(() => harness.readFile(file)).toThrow();
    const moved = harness.readItemFile("add-dark-mode");
    expect(moved).toContain("Add a dark theme toggle");

    // SQLite state is queryable for a future web UI
    expect(item.gateAttempts).toEqual({});
    expect(item.createdAt).toBeTruthy();
  });

  it("malformed front-matter parks the item with a clear reason instead of crashing the scan", () => {
    harness = createHarness();
    const file = harness.inboxFile(
      "Broken",
      { repo: "/tmp/some-repo" }, // no title
      "This will never parse.",
    );

    const report = scanInbox(harness.paths, harness.db);
    expect(report.malformed).toHaveLength(1);
    expect(report.malformed[0]!.reason).toContain("title");

    const item = harness.db.listItems()[0]!;
    expect(item.status).toBe("malformed");
    expect(item.parkedReason).toContain("malformed front-matter");
    expect(item.parkedReason).toContain("title");
    expect(() => harness.readFile(file)).toThrow(); // still claimed, out of the inbox
  });

  it("rescanning (fresh db instance) never duplicates items", () => {
    harness = createHarness();
    harness.inboxFile(
      "task",
      { title: "Task", repo: "/tmp/r", base: "main", approvals: [] },
      "Do the thing.",
    );

    scanInbox(harness.paths, harness.db);
    // A "restart" = new FactoryDb instance over the same root.
    const db2 = new FactoryDb(harness.root);
    const report2 = scanInbox(harness.paths, db2);
    db2.close();

    expect(report2.claimed).toHaveLength(0);
    expect(harness.db.listItems()).toHaveLength(1);
  });

  it("an active slug re-dropped in the inbox is skipped, not double-claimed", () => {
    harness = createHarness();
    harness.inboxFile("task", { title: "Task", repo: "/tmp/r", base: "main", approvals: [] }, "Do it.");
    scanInbox(harness.paths, harness.db);

    const dup = harness.dropAgain("task", { title: "Task", repo: "/tmp/r", base: "main", approvals: [] }, "Do it again.");
    const report = scanInbox(harness.paths, harness.db);
    expect(report.skipped).toHaveLength(1);
    expect(harness.db.listItems()).toHaveLength(1);
    // the skipped file stays in the inbox for the operator to handle
    expect(harness.readFile(dup)).toContain("Do it again.");
  });

  it("config file exists with sane defaults and per-stage mapping structure", () => {
    harness = createHarness();
    expect(ensureConfigFile(harness.root)).toBe(true);
    expect(ensureConfigFile(harness.root)).toBe(false);
    // loadConfig must resolve against the harness root: an argument-less
    // call falls back to <cwd>/factory and would read the LIVE factory
    // config, silently coupling this test to whatever models are deployed.
    const { config } = loadConfig(harness.root);
    expect(config.models.default).toBe(DEFAULT_MODEL);
    expect(config.budgets.maxGateAttempts).toBe(3);
    expect(config.budgets.maxInfraRetries).toBe(3);
    // per-stage override mechanism works with the mapping structure
    const diversified = modelFor({ default: "deepseek-v4-pro", review: "glm-5.3-flash" }, "review");
    expect(diversified).toBe("glm-5.3-flash");
    const fallback = modelFor({ default: "deepseek-v4-pro" }, "review");
    expect(fallback).toBe("deepseek-v4-pro");
  });
});