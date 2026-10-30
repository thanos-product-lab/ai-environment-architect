import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { unescapeDelimiters } from "../context/escape.js";
import { type ItemInput, type RenderedItem, renderItem } from "../context/item.js";
import { DEFAULT_CONTEXT_SETTINGS, type TierMembership } from "../context/tiers.js";
import { sha256 } from "../hash.js";
import { createAliasTable } from "./aliases.js";
import {
  type Citation,
  type CitationContext,
  type Cited,
  citableItem,
  citationCheck,
  validateCitation,
} from "./citations.js";
import { type CallValidator, validateResponse } from "./pipeline.js";

/** No packages or imports: basis comes from the path's own tier (§3.2.4). */
const MEMBERSHIP: TierMembership = {
  packages: [""],
  imports: [],
  sourceExtensions: DEFAULT_CONTEXT_SETTINGS.sourceExtensions,
};

// Citations against real renderings (IMPL §3.2.2, §1.6): the lines validation checks are exactly
// the CONTENT lines the model was sent, and nothing else in an item can be cited.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function itemInput(path: string, text: string, overrides: Partial<ItemInput> = {}): ItemInput {
  const content = encode(text);
  return {
    id: "T5-001",
    path,
    hash: sha256(content),
    tier: 5,
    reason: "tier5:rank1:entry-name",
    content,
    ...overrides,
  };
}

function rendered(input: ItemInput, limit = 1_000_000): RenderedItem {
  const result = renderItem(input, input.tier === 1 ? "none" : "code", limit);
  if (result === undefined) throw new Error("expected a rendering");
  return result;
}

function contextOf(input: ItemInput, rendering: RenderedItem): CitationContext {
  return {
    aliases: createAliasTable("analyse", { items: [input.id] }),
    items: new Map([[input.id, citableItem(input, rendering, MEMBERSHIP, input.hash)]]),
  };
}

/** The CONTENT lines of a rendered item, by number, with the delimiter escape reversed. */
function contentLines(text: string): Map<number, string> {
  const lines = new Map<number, string>();
  const body = text.slice(text.indexOf("\nCONTENT\n") + "\nCONTENT\n".length);
  for (const line of body.split("\n")) {
    const match = /^ *([0-9]+) \|(?: (.*))?$/.exec(line);
    if (match !== null) lines.set(Number(match[1]), unescapeDelimiters(match[2] ?? ""));
  }
  return lines;
}

describe("citations of rendered items", () => {
  it("CIT-004 keeps a BOM inside a line as text, as the item renders it", () => {
    const input = itemInput("src/joined.ts", "﻿export const a = 1;\n﻿export const x = 1;\n");
    const context = contextOf(input, rendered(input));
    const second = validateCitation(
      { item: "T5-001", lines: "2-2", quote: "﻿export const x" },
      context,
      new Set(),
    );
    expect(second).toMatchObject({ ok: true, evidence: { excerpt: "﻿export const x = 1;" } });
    // The file's leading BOM is not part of line 1 (§1.6).
    const first = validateCitation(
      { item: "T5-001", lines: "1-1", quote: "﻿export const a" },
      context,
      new Set(),
    );
    expect(first.ok ? "accepted" : first.rule).toBe("CIT-004");
  });

  it("CIT-004 rejects a quote taken from an outline label or the header", () => {
    const body = `  return '${"x".repeat(300)}';`;
    const input = itemInput(
      "src/two.ts",
      ["export function one() {", "  return 1;", "}", "export function two() {", body, "}"].join(
        "\n",
      ),
    );
    const excerpt = rendered(input, rendered(input).bytes - 200);
    expect(excerpt.text).toContain("export function two [omitted]");
    const context = contextOf(input, excerpt);
    for (const quote of ["export function two [omitted]", 'path="src/two.ts"', "OUTLINE\n   1"]) {
      const result = validateCitation({ item: "T5-001", lines: "1-3", quote }, context, new Set());
      expect(result.ok ? "accepted" : result.rule, quote).toBe("CIT-004");
    }
  });

  it("CIT-004 rejects a quote taken from the destination's BLOCKS lines", () => {
    const input = itemInput("CLAUDE.md", "# Rules\n\nUse pnpm.\n", {
      id: "T1-001",
      tier: 1,
      reason: "tier1:destination",
      blocks: [
        { first: 1, last: 1, alias: "B-1" },
        { first: 3, last: 3, alias: "B-2" },
      ],
    });
    const full = rendered(input);
    expect(full.text).toContain("   1 B-1\n   3 B-2\n");
    const context = contextOf(input, full);
    const result = validateCitation(
      { item: "T1-001", lines: "1-3", quote: "   1 B-1\n   3 B-2" },
      context,
      new Set(),
    );
    expect(result.ok ? "accepted" : result.rule).toBe("CIT-004");
  });
});

// Mostly declarations, with `<` runs for the escape and repeated lines for CIT-005.
const sourceLine = fc.oneof(
  fc.constantFrom(
    "export function alpha() {",
    "export const beta = 1;",
    "  return value << 2 <<< 3;",
    "  const gamma = a >>> b;",
    "}",
    "",
    "import { delta } from './delta';",
  ),
  fc.string({ unit: fc.constantFrom("a", "b", " ", "<", ">", "\\"), maxLength: 20 }),
);

const renderedFile = fc
  .record({
    lines: fc.array(sourceLine, { minLength: 1, maxLength: 25 }),
    cut: fc.integer({ min: 0, max: 600 }),
  })
  .map(({ lines, cut }) => {
    const input = itemInput("src/gen.ts", `${lines.join("\n")}\n`);
    const full = rendered(input);
    const rendering = renderItem(input, "code", Math.max(1, full.bytes - cut)) ?? full;
    return { input, rendering };
  });

describe("citation properties over real renderings (IMPL §3.8)", () => {
  it("checks quotes against exactly the CONTENT lines the item rendered", () => {
    fc.assert(
      fc.property(renderedFile, ({ input, rendering }) => {
        const item = citableItem(input, rendering, MEMBERSHIP, input.hash);
        const sent = new Map(
          item.sent.flatMap((run) => run.lines.map((text, k) => [run.first + k, text] as const)),
        );
        expect(sent).toEqual(contentLines(rendering.text));
      }),
      { numRuns: 300 },
    );
  });

  it("never accepts a quote, taken from anywhere in the rendering, that wasn't in CONTENT", () => {
    const scenario = renderedFile.chain(({ input, rendering }) =>
      fc
        .record({
          from: fc.nat({ max: rendering.text.length }),
          length: fc.integer({ min: 12, max: 60 }),
          start: fc.integer({ min: 1, max: rendering.totalLines }),
          span: fc.nat({ max: 4 }),
        })
        .map((choice) => ({ input, rendering, ...choice })),
    );
    fc.assert(
      fc.property(scenario, ({ input, rendering, from, length, start, span }) => {
        const quote = rendering.text.slice(from, from + length);
        const citation: Citation = { item: "T5-001", lines: `${start}-${start + span}`, quote };
        const result = validateCitation(citation, contextOf(input, rendering), new Set());
        if (!result.ok) return;
        const content = contentLines(rendering.text);
        const { lineStart, lineEnd, excerpt } = result.evidence;
        const lines: string[] = [];
        for (let n = lineStart; n <= lineEnd; n++) {
          const text = content.get(n);
          expect(text, `line ${n} was not sent`).toBeDefined();
          lines.push(text ?? "");
        }
        expect(excerpt).toBe(lines.join("\n"));
        expect(excerpt).toContain(unescapeDelimiters(quote));
      }),
      { numRuns: 500 },
    );
  });
});

describe("citations through the validation pipeline (IMPL §3.5)", () => {
  const citation = z.strictObject({ item: z.string(), lines: z.string(), quote: z.string() });
  const finding = z.strictObject({ key: z.string(), citations: z.array(citation) });
  const schema = z.strictObject({ findings: z.array(finding) });
  type Finding = z.infer<typeof finding> & Cited;

  const call: CallValidator<z.infer<typeof schema>, CitationContext, { findings: Finding }> = {
    schema,
    order: ["findings"],
    collections: {
      findings: {
        items: (response) => response.findings,
        key: (item) => ({ kind: "local", key: item.key }),
        checks: [citationCheck<Finding, CitationContext>()],
      },
    },
    crossItem: [],
  };

  const input = itemInput("src/a.ts", "export const first = 1;\nexport const second = 2;\n");
  const context = contextOf(input, rendered(input));

  it("records citation events as sub-items, and counts a corrected finding once", () => {
    const response = {
      findings: [
        {
          key: "f1",
          citations: [
            { item: "T5-001", lines: "1-1", quote: "export const second" },
            { item: "T5-999", lines: "1-1", quote: "export const first" },
            { item: "T5-001", lines: "1-1", quote: "export const first" },
          ],
        },
        { key: "f2", citations: [{ item: "T5-001", lines: "1-1", quote: "not in this file" }] },
      ],
    };
    const result = validateResponse(call, JSON.stringify(response), context);
    if (result.status !== "validated") throw new Error("expected a validated response");
    expect(result.events.map((event) => [event.itemKey, event.rule, event.outcome])).toEqual([
      ["f1/citations/0", "CIT-R01", "corrected"],
      ["f1/citations/1", "CIT-001", "rejected"],
      ["f2/citations/0", "CIT-004", "rejected"],
      ["f2", "CIT-008", "rejected"],
    ]);
    expect(result.accepted.findings.map((item) => item.value.droppedCitations)).toEqual([1]);
    expect(result.counts).toMatchObject({
      proposed: { state: "known", count: 2 },
      accepted: 1,
      corrected: 1,
      rejectionsByRule: [
        { rule: "CIT-001", count: 1 },
        { rule: "CIT-004", count: 1 },
        { rule: "CIT-008", count: 1 },
      ],
    });
  });
});
