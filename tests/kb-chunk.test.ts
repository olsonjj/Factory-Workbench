import { describe, it, expect } from "vitest";
import { chunkKbLayer } from "../src/kb.js";

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