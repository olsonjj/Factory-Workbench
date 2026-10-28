import { describe, it, expect } from "vitest";
import { chunkKbLayer, kbDigestIndex } from "../src/kb.js";

function entry(n: number, bodySize: number): string {
  return `## 2026-10-27 — failed-gate (repo ${n})\n\n${"x".repeat(bodySize)}\n\n`;
}

describe("chunkKbLayer (curator entry-aligned batching)", () => {
  it("a layer under the budget is a single, unmodified chunk", () => {
    const text = entry(1, 100) + entry(2, 100);
    expect(chunkKbLayer(text, 10_000)).toEqual([text]);
  });

  it("an empty layer yields no chunks", () => {
    expect(chunkKbLayer("", 1000)).toEqual([]);
  });

  it("an oversized layer splits at entry boundaries; no batch exceeds the budget and no content is silently dropped", () => {
    const text = entry(1, 100) + entry(2, 100) + entry(3, 100) + entry(4, 100);
    const chunks = chunkKbLayer(text, 250);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(250 + 200); // budget + truncation marker
    }
    // every entry's header is offered to some batch
    const all = chunks.join("");
    for (const n of [1, 2, 3, 4]) expect(all).toContain(`(repo ${n})`);
  });

  it("a single entry larger than the whole budget is truncated to the budget with an explicit marker", () => {
    const chunks = chunkKbLayer(entry(1, 5000), 1000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(1000 + 200);
    expect(chunks[0]!).toContain("(repo 1)");
    expect(chunks[0]!).toContain("oversized content truncated");
  });

  it("a layer with no entry headers is hard-bounded with a marker", () => {
    const chunks = chunkKbLayer("no headers here, just a blob".repeat(100), 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(500 + 200);
  });
});

describe("kbDigestIndex (curator cross-batch digest)", () => {
  it("emits one line per entry with date, scope, first prose line, and batch", () => {
    const text = [
      "## 2026-10-27 — failed-gate (repo 1)\n\ntests run via jest\n\n",
      "## 2026-10-28 14:40 — pr-outcome (repo 2)\n\n# Summary\nPR merged, tests green\n\n",
    ].join("");
    const idx = kbDigestIndex(text, 10_000);
    expect(idx.truncated).toBe(false);
    const lines = idx.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("2026-10-27");
    expect(lines[0]).toContain("failed-gate (repo 1)");
    expect(lines[0]).toContain("tests run via jest");
    expect(lines[0]).toMatch(/batch 1\/1$/);
    expect(lines[1]).toContain("pr-outcome (repo 2)");
    expect(lines[1]).toContain("PR merged, tests green"); // first PROSE line, not the "# Summary" heading
    expect(lines[1]).toMatch(/batch 1\/1$/);
  });

  it("fits the prompt budget even when the full layer does not", () => {
    // Full layer >> budget; index is one short line, so it still fits.
    const text = "## 2026-10-27 — failed-gate (repo 1)\n\n" + "x".repeat(2000) + "\n\n";
    const chunks = chunkKbLayer(text, 250);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(250 + 200);
    const idx = kbDigestIndex(text, 250);
    expect(idx.truncated).toBe(false);
    expect(idx.text.length).toBeLessThanOrEqual(250);
    expect(idx.text).toContain("(repo 1)");
    expect(idx.text).toMatch(/batch 1\/1$/);
  });

  it("batch numbers match the chunk each entry's full text landed in", () => {
    const text = [1, 2, 3, 4]
      .map((n) => `## 2026-10-27 — failed-gate (repo ${n})\n\n${"x".repeat(1000)}\n\n`)
      .join("");
    const chunks = chunkKbLayer(text, 1000);
    const idx = kbDigestIndex(text, 1000);
    const lines = idx.text.split("\n");
    expect(chunks.length).toBeGreaterThan(1);
    for (let n = 1; n <= 4; n++) {
      const batchOfEntry = chunks.findIndex((c) => c.includes(`(repo ${n})`)) + 1;
      const line = lines[n - 1]!;
      expect(line).toContain(`(repo ${n})`);
      expect(line).toMatch(new RegExp(`batch ${batchOfEntry}/${chunks.length}$`));
    }
  });

  it("truncates to the budget with a marker when the index itself would exceed it", () => {
    const entries = Array.from({ length: 200 }, (_, n) => `## 2026-10-27 — failed-gate (repo ${n})\n\nx\n\n`).join("");
    const idx = kbDigestIndex(entries, 1000);
    expect(idx.truncated).toBe(true);
    expect(idx.text).toContain("digest index truncated");
    expect(idx.text.length).toBeLessThanOrEqual(1000 + 200);
  });

  it("empty and headerless layers produce an empty, non-truncated index", () => {
    expect(kbDigestIndex("", 1000)).toEqual({ text: "", truncated: false });
    expect(kbDigestIndex("no headers, just a blob".repeat(100), 500)).toEqual({ text: "", truncated: false });
  });
});
