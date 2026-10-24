import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import { limitCheck } from "./limits.js";
import type { CheckResult } from "./pipeline.js";

// LIMIT-001 (IMPL §3.3, §3.5): a length or size inside one item rejects only that item, with a
// detail naming the field and the limit, never the value.

const analyse = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/responses/analyse/valid.json", import.meta.url),
    "utf8",
  ),
) as {
  findings: Record<string, unknown>[];
  conflicts: Record<string, unknown>[];
};
const finding = analyse.findings[0] as Record<string, unknown>;
const citation = (finding["citations"] as Record<string, unknown>[])[0];
const checkFinding = limitCheck(CALL_SCHEMAS.analyse.items.findings);
const scope = { localKeys: new Set<string>() };

function run(item: unknown): CheckResult<unknown> {
  return checkFinding(item, undefined, scope);
}

describe("LIMIT-001 (IMPL §3.5)", () => {
  it("LIMIT-001 rejects a statement over 300 characters, naming the field and the limit", () => {
    expect(run({ ...finding, statement: "x".repeat(301) })).toEqual({
      kind: "reject",
      rule: "LIMIT-001",
      detail: "statement: at most 300 characters",
      events: [],
    });
  });

  it("LIMIT-001 near miss: exactly 300 characters is accepted unchanged", () => {
    const item = { ...finding, statement: "x".repeat(300) };
    expect(run(item)).toEqual({ kind: "accept", value: item, events: [] });
  });

  it("LIMIT-001 names a nested field by its path", () => {
    expect(run({ ...finding, citations: [{ ...citation, quote: "q".repeat(201) }] })).toMatchObject(
      {
        rule: "LIMIT-001",
        detail: "citations.0.quote: at most 200 characters",
      },
    );
  });

  it("LIMIT-001 rejects an array inside an item outside its size", () => {
    expect(run({ ...finding, citations: Array(7).fill(citation) })).toMatchObject({
      rule: "LIMIT-001",
      detail: "citations: at most 6 items",
    });
    const checkConflict = limitCheck(CALL_SCHEMAS.analyse.items.conflicts);
    expect(
      checkConflict({ ...analyse.conflicts[0], findings: ["f1"] }, undefined, scope),
    ).toMatchObject({ rule: "LIMIT-001", detail: "findings: at least 2 items" });
  });

  it("LIMIT-001 near miss: six citations and a two-finding conflict are accepted", () => {
    expect(run({ ...finding, citations: Array(6).fill(citation) })).toMatchObject({
      kind: "accept",
    });
    const checkConflict = limitCheck(CALL_SCHEMAS.analyse.items.conflicts);
    expect(
      checkConflict({ ...analyse.conflicts[0], findings: ["f1", "f2"] }, undefined, scope),
    ).toMatchObject({ kind: "accept" });
  });

  it("LIMIT-001 applies to every call's items: a fifth option, a 21st reference", () => {
    const fixture = (call: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../test/fixtures/responses/${call}/valid.json`, import.meta.url),
          "utf8",
        ),
      ) as Record<string, Record<string, unknown>[]>;
    const question = fixture("generate_questions")["questions"]?.[0] as Record<string, unknown>;
    const checkQuestion = limitCheck(CALL_SCHEMAS.generate_questions.items.questions);
    const label = { label: "An option" };
    expect(
      checkQuestion({ ...question, options: Array(4).fill(label) }, undefined, scope),
    ).toMatchObject({ kind: "accept" });
    expect(
      checkQuestion({ ...question, options: Array(5).fill(label) }, undefined, scope),
    ).toMatchObject({ rule: "LIMIT-001", detail: "options: at most 4 items" });
    const recommendation = fixture("recommend")["recommendations"]?.[1] as Record<string, unknown>;
    const reference = (recommendation["references"] as unknown[])[0];
    const checkRecommendation = limitCheck(CALL_SCHEMAS.recommend.items.recommendations);
    expect(
      checkRecommendation(
        { ...recommendation, references: Array(21).fill(reference) },
        undefined,
        scope,
      ),
    ).toMatchObject({ rule: "LIMIT-001", detail: "references: at most 20 items" });
    const action = fixture("regenerate_recommendations")["actions"]?.[2] as Record<string, unknown>;
    const checkAction = limitCheck(CALL_SCHEMAS.regenerate_recommendations.items.actions);
    expect(checkAction({ ...action, reason: "r".repeat(201) }, undefined, scope)).toMatchObject({
      rule: "LIMIT-001",
      detail: "reason: at most 200 characters",
    });
  });

  it("LIMIT-001 caps strings a pattern can't bound, such as an expansion range list", () => {
    const request = {
      kind: "read",
      entries: [{ path: "a.ts", lines: Array(200).fill("1-2").join(",") }],
      reason: "More lines.",
    };
    const checkRequest = limitCheck(CALL_SCHEMAS.analyse.items.expansionRequests);
    expect(checkRequest(request, undefined, scope)).toMatchObject({ rule: "LIMIT-001" });
  });

  it("LIMIT-001 never repeats the value in its detail", () => {
    const copied = "SECRET_LINE_COPIED_FROM_SOURCE ".repeat(20);
    expect(JSON.stringify(run({ ...finding, statement: copied }))).not.toContain("SECRET");
  });
});
