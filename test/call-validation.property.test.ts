import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { comparePaths } from "../src/core/paths.js";
import { validateAnalyse } from "../src/core/validation/analyse.js";
import { validateAnalyseExpansion } from "../src/core/validation/analyse-expansion.js";
import { validateGenerateQuestions } from "../src/core/validation/generate-questions.js";
import {
  analyseContext,
  analyseExpansionContext,
  type FixtureContext,
  questionContext,
} from "./support/call-context.js";

// Whole-call determinism (IMPL §3.8): the same response, input and validator version always
// produce identical accepted records and validation events, whatever order the input was built
// in. Responses are assembled from the items of the recorded fixtures for each call's shared
// context, picked, repeated and reordered at random, so duplicates, key clashes and conflicts
// over rejected members all occur.

const ROOT = join(import.meta.dirname, "fixtures", "responses");
const RUNS = { numRuns: 150 };
const PLACEHOLDER = /\{\{aws-access-key-id\}\}/g;

const load = (call: string, name: string): unknown =>
  JSON.parse(
    readFileSync(join(ROOT, call, name), "utf8").replace(PLACEHOLDER, "AKIAIOSFODNN7EXAMPLE"),
  );

/** Every item, per collection, of the cases that use the call's shared context. */
function pool(call: string): Record<string, unknown[]> {
  const items: Record<string, unknown[]> = {};
  for (const name of readdirSync(join(ROOT, call)).sort(comparePaths)) {
    if (!name.endsWith(".json") || name === "valid.json" || name.startsWith("context")) continue;
    const fixtureCase = load(call, name) as { context?: string; response?: object };
    if (fixtureCase.context !== undefined || fixtureCase.response === undefined) continue;
    for (const [collection, list] of Object.entries(fixtureCase.response))
      items[collection] = [...(items[collection] ?? []), ...(list as unknown[])];
  }
  return items;
}

/** A response with up to `max` items per collection, drawn from the pool with repeats. */
function responses(items: Record<string, unknown[]>, max: number) {
  const collections = Object.keys(items).sort(comparePaths);
  return fc
    .record(
      Object.fromEntries(
        collections.map((name) => [
          name,
          fc.array(
            fc.constantFrom(...(items[name]?.length ? (items[name] as unknown[]) : [null])),
            {
              maxLength: max,
            },
          ),
        ]),
      ),
    )
    .map((response) =>
      Object.fromEntries(
        Object.entries(response).map(([name, list]) => [name, list.filter((x) => x !== null)]),
      ),
    );
}

const calls = [
  {
    call: "analyse",
    max: 5,
    run: (text: string, fixture: FixtureContext, reversed: boolean) =>
      validateAnalyse(text, analyseContext(fixture, reversed)),
  },
  {
    call: "analyse_expansion",
    max: 5,
    run: (text: string, fixture: FixtureContext, reversed: boolean) =>
      validateAnalyseExpansion(text, analyseExpansionContext(fixture, reversed)),
  },
  {
    call: "generate_questions",
    max: 8,
    run: (text: string, fixture: FixtureContext, reversed: boolean) =>
      validateGenerateQuestions(text, questionContext(fixture, reversed)),
  },
] as const;

describe("whole-call determinism (IMPL §3.8)", () => {
  for (const { call, max, run } of calls) {
    const fixture = load(call, "context.json") as FixtureContext;
    const items = pool(call);

    it(`${call}: the same response and input give identical records and events`, () => {
      fc.assert(
        fc.property(responses(items, max), (response) => {
          const text = JSON.stringify(response);
          const once = run(text, fixture, false);
          expect(run(text, fixture, false)).toEqual(once);
          expect(run(text, fixture, true)).toEqual(once);
        }),
        RUNS,
      );
    });
  }
});
