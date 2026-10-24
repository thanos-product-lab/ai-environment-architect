import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { escapeDelimiters, unescapeDelimiters } from "../context/escape.js";
import type { Hash } from "../hash.js";
import { createAliasTable } from "./aliases.js";
import {
  type CitableItem,
  type Citation,
  type CitationContext,
  citationCheck,
  type SentRun,
  validateCitation,
} from "./citations.js";

// Properties of citation provenance (IMPL §3.8).

const HASH: Hash = "sha256:1111";

// A small alphabet makes repeated and near-miss quotes likely; `<` exercises the escape.
const line = fc.string({
  unit: fc.constantFrom("a", "b", "c", " ", "<", "x"),
  minLength: 4,
  maxLength: 20,
});

/** A file of 1–30 lines, and the runs of it that were sent. */
const file = fc.array(line, { minLength: 1, maxLength: 30 }).chain((lines) =>
  fc
    // Mostly sent, so ranges often fall within one run, with omitted gaps between runs.
    .array(
      fc.integer({ min: 0, max: 3 }).map((n) => n > 0),
      { minLength: lines.length, maxLength: lines.length },
    )
    .map((sentFlags) => ({ lines, sentFlags })),
);

function runsOf(lines: readonly string[], sentFlags: readonly boolean[]): SentRun[] {
  const runs: SentRun[] = [];
  let current: { first: number; lines: string[] } | undefined;
  lines.forEach((text, index) => {
    if (sentFlags[index] === true) {
      if (current === undefined) {
        current = { first: index + 1, lines: [] };
        runs.push(current);
      }
      current.lines.push(text);
    } else current = undefined;
  });
  return runs;
}

const RUNS = { numRuns: 500 };

const scenario = file.chain(({ lines, sentFlags }) =>
  fc
    .record({
      shift: fc.integer({ min: -3, max: 3 }),
      span: fc.integer({ min: -1, max: 4 }),
      from: fc.integer({ min: 1, max: lines.length }),
      take: fc.integer({ min: 0, max: 3 }),
      cut: fc.nat({ max: 4 }),
      length: fc.integer({ min: 10, max: 30 }),
      escaped: fc.boolean(),
    })
    .map((choice) => {
      // Quotes are mostly taken from the file, sent or not, so the search is exercised.
      const whole = lines.slice(choice.from - 1, choice.from + choice.take).join("\n");
      const raw = whole.slice(choice.cut, choice.cut + choice.length);
      const quote = choice.escaped ? escapeDelimiters(raw) : raw;
      // The range is near the quote's source, so it is often right, sometimes shifted.
      const start = Math.max(1, choice.from + choice.shift);
      const end = Math.max(1, start + choice.span);
      return {
        lines,
        item: {
          path: "src/a.ts",
          snapshotHash: HASH,
          currentHash: HASH,
          basis: "code_observation",
          totalLines: lines.length,
          sent: runsOf(lines, sentFlags),
        } satisfies CitableItem,
        citation: { item: "T5-001", lines: `${start}-${end}`, quote } satisfies Citation,
      };
    }),
);

function contextFor(item: CitableItem): CitationContext {
  return {
    aliases: createAliasTable("analyse", { items: ["T5-001"] }),
    items: new Map([["T5-001", item]]),
  };
}

describe("citation properties (IMPL §3.8)", () => {
  it("never accepts a quote absent from the lines sent in that call", () => {
    fc.assert(
      fc.property(scenario, ({ item, citation }) => {
        const result = validateCitation(citation, contextFor(item), new Set());
        if (!result.ok) return;
        const quote = unescapeDelimiters(citation.quote);
        expect(item.sent.some((run) => run.lines.join("\n").includes(quote))).toBe(true);
        expect(result.evidence.excerpt).toContain(quote);
      }),
      RUNS,
    );
  });

  it("changes only the line range when it corrects", () => {
    fc.assert(
      fc.property(scenario, ({ item, citation }) => {
        const result = validateCitation(citation, contextFor(item), new Set());
        if (!result.ok) return;
        expect(result.citation.item).toBe(citation.item);
        expect(result.citation.quote).toBe(citation.quote);
        if (result.correction === undefined) expect(result.citation).toEqual(citation);
        else {
          expect(result.correction.originalLines).toBe(citation.lines);
          expect(result.citation.lines).toBe(result.correction.correctedLines);
        }
        expect(`${result.evidence.lineStart}-${result.evidence.lineEnd}`).toBe(
          result.citation.lines,
        );
      }),
      RUNS,
    );
  });

  it("never puts text that wasn't sent in an accepted excerpt", () => {
    fc.assert(
      fc.property(scenario, ({ lines, item, citation }) => {
        const result = validateCitation(citation, contextFor(item), new Set());
        if (!result.ok) return;
        const { lineStart, lineEnd, excerpt } = result.evidence;
        expect(excerpt).toBe(lines.slice(lineStart - 1, lineEnd).join("\n"));
        const sentNumbers = new Set(
          item.sent.flatMap((run) => run.lines.map((_, k) => run.first + k)),
        );
        for (let n = lineStart; n <= lineEnd; n++) expect(sentNumbers.has(n)).toBe(true);
      }),
      RUNS,
    );
  });

  it("gives identical results and events for the same input", () => {
    fc.assert(
      fc.property(fc.array(scenario, { minLength: 1, maxLength: 6 }), (cases) => {
        const [first] = cases;
        if (first === undefined) return;
        const finding = { key: "f1", citations: cases.map((c) => c.citation) };
        const context = contextFor(first.item);
        const once = citationCheck()(finding, context, { localKeys: new Set(["f1"]) });
        const again = citationCheck()(finding, context, { localKeys: new Set(["f1"]) });
        expect(again).toEqual(once);
      }),
      RUNS,
    );
  });
});
