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

  it("keeps whole entries whole: a chunk boundary carries the next entry, never slices it", () => {
    const e1 = `## 2026-10-27 — lesson (repo 1)\n\n${"a".repeat(300)}\n\n`;
    const e2 = `## 2026-10-27 — lesson (repo 2)\n\n${"b".repeat(350)}\n\n`;
    const text = e1 + e2;
    const chunks = chunkKbLayer(text, 400);
    // The old implementation sliced chunk 1 at 400 mid-entry-2 and withheld
    // its 290 remaining chars from every batch (Greptile PR #6 finding 1).
    expect(chunks.join("")).toBe(text); // byte-for-byte, no marker
    expect(chunks.some((c) => c.includes("(repo 1)"))).toBe(true);
    expect(chunks.some((c) => c.includes("b".repeat(350)))).toBe(true);
    expect(chunks.every((c) => !c.includes("withheld"))).toBe(true);
  });

  it("digest is built from the original entries: a straddled lesson still indexes", () => {
    const e1 = "## 2026-10-27 — lesson (repo 1)\n\ntests run via jest\n\n";
    const e2 = `## 2026-10-27 — lesson (repo 2)\n\nthe lesson: verify KB facts before relying\n\n${"x".repeat(800)}\n\n`;
    const idx = kbDigestIndex(e1 + e2, 400);
    expect(idx.truncated).toBe(false);
    expect(idx.text).toContain("verify KB facts before relying"); // full text of entry 2, beyond any slice
    expect(idx.text).toContain("(repo 2)");
    expect(idx.text).toContain("tests run via jest");
  });

  it("first prose line skips code INSIDE a fence and text INSIDE a multiline comment", () => {
    const fenced = "## 2026-10-27 — lesson (repo 1)\n\n```\nnpm install --no-audit\n```\n\nthe lesson: rerun tests after install\n\n";
    const linesFenced = kbDigestIndex(fenced, 10_000).text.split("\n");
    expect(linesFenced[0]).toContain("the lesson: rerun tests after install");
    expect(linesFenced[0]).not.toContain("npm install"); // in-fence command, not the lesson

    const commented = "## 2026-10-27 — lesson (repo 2)\n\n<!-- this entry records the old approach\nwhich is now wrong\n-->\n\nthe lesson: cross-check batches before applying\n\n";
    const linesCommented = kbDigestIndex(commented, 10_000).text.split("\n");
    expect(linesCommented[0]).toContain("the lesson: cross-check batches before applying");
    expect(linesCommented[0]).not.toContain("old approach"); // inside the comment, not the lesson
    expect(linesCommented[0]).not.toContain("now wrong");
  });

  it("empty and headerless layers produce an empty, non-truncated index", () => {
    expect(kbDigestIndex("", 1000)).toEqual({ text: "", truncated: false });
    expect(kbDigestIndex("no headers, just a blob".repeat(100), 500)).toEqual({ text: "", truncated: false });
  });
});
