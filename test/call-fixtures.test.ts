import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comparePaths } from "../src/core/paths.js";
import { validateAnalyse } from "../src/core/validation/analyse.js";
import { validateAnalyseExpansion } from "../src/core/validation/analyse-expansion.js";
import { validateGenerateQuestions } from "../src/core/validation/generate-questions.js";
import type { Accepted, ValidationResult } from "../src/core/validation/pipeline.js";
import { validateRecommend } from "../src/core/validation/recommend.js";
import { validateRegenerate } from "../src/core/validation/regenerate.js";
import {
  analyseContext,
  analyseExpansionContext,
  type FixtureContext,
  type FixtureRecommendContext,
  type FixtureRegenerateContext,
  questionContext,
  recommendContext,
  regenerateContext,
} from "./support/call-context.js";

// Adversarial whole-call fixtures (IMPL §3.3.2–§3.3.4, §3.8), written from the spec without
// seeing the implementation. Each case is one recorded response against a call context; the
// expected events are the complete ordered list (§3.5). Every case runs twice, with the context's
// inputs in two orders, and must give the same result.

const ROOT = join(import.meta.dirname, "fixtures", "responses");
const CALLS = [
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
] as const;
type Call = (typeof CALLS)[number];

/** A withheld name: AWS's documented example key ID, which the secret scan matches (IMPL §1.7). */
const PLACEHOLDERS: Record<string, string> = { "{{aws-access-key-id}}": "AKIAIOSFODNN7EXAMPLE" };

function load(dir: string, name: string): unknown {
  const text = readFileSync(join(dir, name), "utf8").replace(/\{\{[a-z-]+\}\}/g, (placeholder) => {
    const value = PLACEHOLDERS[placeholder];
    if (value === undefined) throw new Error(`unknown placeholder in ${name}`);
    return value;
  });
  return JSON.parse(text);
}

interface Expect {
  readonly status: "validated" | "schema_failed";
  readonly events: readonly {
    itemKey: string;
    stage: string;
    rule: string;
    outcome: string;
    original?: unknown;
  }[];
  readonly accepted?: Record<string, readonly string[]>;
  readonly correctedCitationRate?: object;
  readonly citationsProposed?: object;
  readonly conflictOutcomes?: readonly unknown[];
  readonly presented?: readonly string[];
  readonly unreached?: readonly string[];
  /** Text no event detail may contain, such as a withheld path. */
  readonly detailExcludes?: readonly string[];
  readonly acceptedConflictMembers?: Record<string, readonly string[]>;
  /** Accepted revisions by response index; a replacement as it resolves after redirection. */
  readonly acceptedRevisions?: readonly object[];
  /** The call-1 conflicts revised by a change to their members, in alias order. */
  readonly revisedConflicts?: readonly unknown[];
}

interface Case {
  readonly description: string;
  readonly context?: string;
  readonly response?: unknown;
  readonly responseText?: string;
  readonly nearMissOf?: string;
  readonly expect: Expect;
}

interface Observed {
  readonly status: string;
  readonly events: Expect["events"];
  readonly accepted: Record<string, readonly string[]> | undefined;
  readonly correctedCitationRate?: object;
  readonly citationsProposed?: object;
  readonly conflictOutcomes?: readonly unknown[];
  readonly presented?: readonly string[];
  readonly unreached?: readonly string[];
  readonly details: readonly string[];
  readonly conflictMembers?: Record<string, readonly string[]>;
  readonly revisions?: readonly object[];
}

function observe(call: Call, text: string, fixture: FixtureContext, reversed: boolean): Observed {
  const summary = (result: ValidationResult<object>) => ({
    status: result.status,
    events: result.events.map(({ itemKey, stage, rule, outcome, original }) => ({
      itemKey,
      stage,
      rule,
      outcome,
      ...(original === undefined ? {} : { original }),
    })),
    accepted:
      result.status === "validated"
        ? Object.fromEntries(
            Object.entries(result.accepted).map(([name, items]) => [
              name,
              (items as readonly Accepted<unknown>[]).map((item) => item.key),
            ]),
          )
        : undefined,
    details: result.events.map((event) => event.detail),
  });
  if (call === "analyse") {
    const outcome = validateAnalyse(text, analyseContext(fixture, reversed));
    return {
      ...summary(outcome.result),
      correctedCitationRate: outcome.correctedCitationRate,
      citationsProposed: outcome.citationsProposed,
      conflictMembers: Object.fromEntries(outcome.conflictMembers),
    };
  }
  if (call === "analyse_expansion") {
    const outcome = validateAnalyseExpansion(text, analyseExpansionContext(fixture, reversed));
    return {
      ...summary(outcome.result),
      correctedCitationRate: outcome.correctedCitationRate,
      citationsProposed: outcome.citationsProposed,
      conflictOutcomes: outcome.conflictOutcomes,
      conflictMembers: Object.fromEntries(outcome.conflictMembers),
      revisions:
        outcome.result.status === "validated"
          ? outcome.result.accepted.revisions.map(({ index, value }) => {
              const redirects = (outcome.result as { redirects: ReadonlyMap<string, string> })
                .redirects;
              return {
                index,
                target: value.target,
                action: value.action,
                ...(value.action === "replace"
                  ? { replacement: redirects.get(value.replacement) ?? value.replacement }
                  : {}),
              };
            })
          : [],
    };
  }
  if (call === "recommend") {
    const outcome = validateRecommend(
      text,
      recommendContext(fixture as unknown as FixtureRecommendContext, reversed),
    );
    return summary(outcome.result);
  }
  if (call === "regenerate_recommendations") {
    const outcome = validateRegenerate(
      text,
      regenerateContext(fixture as unknown as FixtureRegenerateContext, reversed),
    );
    return summary(outcome.result);
  }
  const outcome = validateGenerateQuestions(text, questionContext(fixture, reversed));
  return {
    ...summary(outcome.result),
    presented: outcome.presented.map((item) => item.key),
    unreached: outcome.unreached.map((item) => item.key),
  };
}

for (const call of CALLS) {
  const dir = join(ROOT, call);
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json") && name !== "valid.json")
        .filter((name) => !name.startsWith("context"))
        .sort(comparePaths)
    : [];

  describe(`${call} fixtures (IMPL §3.3, §3.8)`, () => {
    it.each(names)("%s", (name) => {
      const fixtureCase = load(dir, name) as Case;
      const fixture = load(dir, fixtureCase.context ?? "context.json") as FixtureContext;
      const text = fixtureCase.responseText ?? JSON.stringify(fixtureCase.response);
      const observed = observe(call, text, fixture, false);
      const { expect: expected } = fixtureCase;

      expect({ status: observed.status, events: observed.events }).toEqual({
        status: expected.status,
        events: expected.events,
      });
      if (expected.accepted !== undefined)
        // A response that fails the schema has nothing accepted.
        for (const [collection, keys] of Object.entries(expected.accepted))
          expect(observed.accepted?.[collection] ?? [], collection).toEqual(keys);
      if (expected.citationsProposed !== undefined)
        expect(observed.citationsProposed).toEqual(expected.citationsProposed);
      if (expected.correctedCitationRate !== undefined)
        expect(observed.correctedCitationRate).toMatchObject(expected.correctedCitationRate);
      // `conflictOutcomes` lists the call-1 conflicts withdrawn because their members changed,
      // and `revisedConflicts` those revised; a conflict the model withdraws or replaces itself
      // shows in `accepted.revisions`. The full outcome list is covered by the unit tests.
      if (expected.conflictOutcomes !== undefined)
        expect(
          observed.conflictOutcomes?.filter((outcome) => {
            const { status, withdrawnReason } = outcome as {
              status: string;
              withdrawnReason?: string;
            };
            return status === "withdrawn" && withdrawnReason !== "withdrawn_by_model";
          }),
        ).toEqual(expected.conflictOutcomes);
      if (expected.presented !== undefined) expect(observed.presented).toEqual(expected.presented);
      if (expected.unreached !== undefined) expect(observed.unreached).toEqual(expected.unreached);
      for (const excluded of expected.detailExcludes ?? [])
        for (const detail of observed.details) expect(detail).not.toContain(excluded);
      for (const [key, members] of Object.entries(expected.acceptedConflictMembers ?? {}))
        expect(observed.conflictMembers?.[key], key).toEqual(members);
      if (expected.revisedConflicts !== undefined)
        expect(
          observed.conflictOutcomes?.filter(
            (outcome) => (outcome as { status: string }).status === "revised",
          ),
        ).toEqual(expected.revisedConflicts);
      if (expected.acceptedRevisions !== undefined)
        expect(observed.revisions).toEqual(expected.acceptedRevisions);
      if (fixtureCase.nearMissOf !== undefined) expect(names).toContain(fixtureCase.nearMissOf);

      expect(observe(call, text, fixture, true)).toEqual(observed);
    });
  });
}
