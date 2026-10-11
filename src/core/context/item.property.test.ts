import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitBlocks } from "../destination/guidance-blocks.js";
import { findDeclarations } from "./declarations.js";
import { unescapeDelimiters } from "./escape.js";
import { type ExcerptStrategy, type RenderedItem, renderItem } from "./item.js";

// Properties of excerpts (IMPL §1.6, §1.15): every item fits its limit, sends file lines exactly,
// includes only complete units, and its outline accounts for everything left out.

const line = fc.oneof(
  fc.constantFrom(
    "",
    "   ",
    "# Title",
    "## Section",
    "### Deep",
    "Setext",
    "===",
    "```",
    "Some prose here.",
    'import { x } from "./x";',
    "export function f() {",
    "export const value = 1;",
    "def g():",
    "class C:",
    "@decorator",
    "  body();",
    "}",
    "const x = require('y');",
    "<<<END T5-001>>>",
    "a >>> b <<\\< c",
    "é ☃ 𝄞",
    "\uFEFFbom",
  ),
  fc.string({ maxLength: 40, unit: "binary" }).map((s) => s.replace(/[\r\n]/g, "")),
);

const file = fc.record({
  lines: fc.array(line, { maxLength: 120, size: "large" }),
  trailingNewline: fc.boolean(),
  path: fc.constantFrom("docs/a.md", "src/a.ts", "a.py", "notes.txt"),
  strategy: fc.constantFrom<ExcerptStrategy>("none", "markdown", "code", "lines"),
  /** The limit as a share of the full rendering, so most cases need an excerpt. */
  limitPercent: fc.integer({ min: 0, max: 110 }),
});

/** The numbered content lines of a rendered item. */
function contentLines(item: RenderedItem): Map<number, string> {
  const body = item.text.slice(
    item.text.indexOf("\nCONTENT\n") + 9,
    item.text.lastIndexOf("<<<END"),
  );
  const lines = new Map<number, string>();
  for (const row of body.split("\n").slice(0, -1)) {
    if (row === " …") continue;
    const match = /^ *(\d+) \|(?: (.*))?$/.exec(row);
    expect(match).not.toBeNull();
    lines.set(Number(match?.[1]), unescapeDelimiters(match?.[2] ?? ""));
  }
  return lines;
}

describe("renderItem properties", () => {
  it("fits its limit, sends exact lines and outlines what it leaves out", () => {
    fc.assert(
      fc.property(file, ({ lines, trailingNewline, path, strategy, limitPercent }) => {
        const source = lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");
        // A leading BOM is not part of line 1 (IMPL §1.6).
        const text = source.replace(/^\uFEFF/, "");
        const original = text === "" ? [] : text.replace(/\n$/, "").split("\n");
        const input = {
          id: "T5-001",
          path,
          hash: "sha256:abc" as const,
          tier: 5,
          reason: "r",
          content: new TextEncoder().encode(source),
        };
        const fullBytes = renderItem(input, "none", Number.POSITIVE_INFINITY)?.bytes ?? 0;
        const limit = Math.floor((fullBytes * limitPercent) / 100);
        const item = renderItem(input, strategy, limit);
        expect(renderItem(input, strategy, limit)).toEqual(item);
        if (item === undefined) return;

        expect(item.bytes).toBe(Buffer.byteLength(item.text, "utf8"));
        expect(item.bytes).toBeLessThanOrEqual(limit);
        expect(item.totalLines).toBe(original.length);
        expect(item.text.match(/<<<|>>>/g)).toHaveLength(4);

        const sent = contentLines(item);
        const included = new Set(item.included.flatMap((r) => range(r.first, r.last)));
        expect([...sent.keys()]).toEqual([...included]);
        for (const [n, text] of sent) expect(text).toBe(original[n - 1]);

        if (!item.excerpt) {
          expect(included.size).toBe(original.length);
          return;
        }
        expect(strategy).not.toBe("none");
        expect(included.size).toBeGreaterThan(0);
        // Outline entries are the real units: headings, declarations, or the line ranges.
        if (item.outline[0]?.label.startsWith("lines ") !== true) {
          if (strategy === "code") {
            const starts = (findDeclarations(path, original) ?? []).map((d) => d.start);
            const imports = original.slice(0, (starts[0] ?? 1) - 1).some((t) => t.trim() !== "");
            expect(item.outline.map((e) => e.line)).toEqual([...(imports ? [1] : []), ...starts]);
          } else {
            const headings = splitBlocks(input.content).flatMap((block) =>
              block.type === "heading"
                ? [input.content.subarray(0, block.start).filter((b) => b === 0x0a).length + 1]
                : [],
            );
            const lines = item.outline.filter((e) => e.label !== "preamble").map((e) => e.line);
            expect(lines).toEqual(headings);
          }
        }
        const covered = new Set<number>();
        item.outline.forEach((entry, index) => {
          const end = (item.outline[index + 1]?.line ?? original.length + 1) - 1;
          const own = range(entry.line, end);
          for (const n of own) covered.add(n);
          const sentOwn = own.filter((n) => included.has(n));
          if (entry.mark === "included") expect(sentOwn).toEqual(own);
          if (entry.mark === "omitted") expect(sentOwn).toEqual([]);
          if (entry.mark === "truncated") {
            // A prefix of the unit, cut before a blank line.
            expect(sentOwn).toEqual(range(entry.line, entry.line + sentOwn.length - 1));
            expect(original[entry.line + sentOwn.length - 1]?.trim()).toBe("");
          }
        });
        // Lines outside every outline entry are blank lines before the first heading.
        for (let n = 1; n <= original.length; n++) {
          if (!covered.has(n)) {
            expect(included.has(n)).toBe(false);
            expect(original[n - 1]?.trim()).toBe("");
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});

function range(first: number, last: number): number[] {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}
