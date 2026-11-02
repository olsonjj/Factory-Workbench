import { describe, expect, it } from "vitest";
import type { RunResult } from "@ai-hero/sandcastle";
import {
  dropInvalidJsonEscapes,
  parseStructured,
  ReviewVerdict,
  StructuredOutputParseError,
  TestVerdict,
  TriageVerdict,
} from "../src/adapters/sandcastle.js";

/**
 * Regression tests for the 2026-10-27 dogfood finding: the test stage's
 * structured output used `z.string().optional()` for lesson/fix, and an agent
 * that *passed* emitted explicit `null` for both — the zod parse failed, three
 * infra retries burned, and the item parked as infrastructure-failure even
 * though all 75 tests had passed. Optional stage fields must be nullish.
 */

function runResultWith(agentText: string): RunResult {
  // parseStructured only reads `output` (or the agentText arg); a cast is fine
  // for this hermetic unit test.
  return { output: agentText } as unknown as RunResult;
}

describe("parseStructured: optional stage fields accept explicit null", () => {
  it("a passing test verdict with nulled lesson and fix parses (the parking bug)", () => {
    const v = parseStructured(
      runResultWith("host-would-supply-stream-here"),
      "test",
      TestVerdict,
      `<test>{ "testsPassed": true, "report": "12 files, 75 tests passed, 2 skipped.", "fix": null, "lesson": null }</test>`,
    );
    expect(v.testsPassed).toBe(true);
    expect(v.report).toContain("75 tests passed");
    expect(v.lesson).toBeNull();
    expect(v.fix).toBeNull();
  });

  it("a review verdict nulls prSummary/lesson/fix without breaking the gate", () => {
    const v = parseStructured(
      runResultWith("x"),
      "review",
      ReviewVerdict,
      `<review>{ "verdict": "pass", "findings": "none", "lesson": null, "fix": null, "prSummary": null }</review>`,
    );
    expect(v.verdict).toBe("pass");
  });

  it("a triage verdict nulls questions when there is nothing to ask", () => {
    const v = parseStructured(
      runResultWith("x"),
      "triage",
      TriageVerdict,
      `<triage>{ "outcome": "proceed", "report": "ok", "questions": null }</triage>`,
    );
    expect(v.outcome).toBe("proceed");
    expect(v.questions).toBeNull();
  });

  it("missing required fields are still rejected (typed strictness intact)", () => {
    expect(() =>
      parseStructured(runResultWith(`<test>{ "testsPassed": true }</test>`), "test", TestVerdict),
    ).toThrow(StructuredOutputParseError);
    expect(() =>
      parseStructured(runResultWith(`<test>{ "testsPassed": true, "report": [] }</test>`), "test", TestVerdict),
    ).toThrow(StructuredOutputParseError);
  });
});
describe("parseStructured: invalid JSON escapes from quoted template literals", () => {
  // Shapes observed from Claude Code (2026-11-02 e2e): backticks escaped as \`
  // inside JSON strings when quoting JS template literals.
  const review =
    '<review>\n{\n  "verdict": "pass",\n  "findings": "greet.js adds `export const farewell = (name) => \\`Goodbye, ${name}!\\`;`"\n}\n</review>';

  it("repairs \\` and keeps the verdict and text intact", () => {
    const v = parseStructured({} as RunResult, "review", ReviewVerdict, review);
    expect(v.verdict).toBe("pass");
    expect(v.findings).toBe("greet.js adds `export const farewell = (name) => `Goodbye, ${name}!`;`");
  });

  it("leaves valid escapes untouched, including an escaped backslash before a backtick", () => {
    const valid = String.raw`"a\"b\\c\/d\n\té \\` + "`" + `"`;
    expect(dropInvalidJsonEscapes(valid)).toBe(valid);
    expect(JSON.parse(dropInvalidJsonEscapes(valid))).toBe(JSON.parse(valid));
  });

  it("still throws when the payload is broken beyond invalid escapes", () => {
    expect(() =>
      parseStructured({} as RunResult, "review", ReviewVerdict, '<review>{ "verdict": "pass", \\` </review>'),
    ).toThrow(StructuredOutputParseError);
  });
});
