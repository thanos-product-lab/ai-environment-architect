import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256 } from "../hash.js";
import {
  type BlockSplitter,
  type GuidanceBlock,
  type ParsedDestination,
  parseGuidanceBlocks,
} from "./guidance-blocks.js";

// Properties of the Guidance Block parse (DM §7) over Markdown-shaped input and random bytes.

const BOM = [0xef, 0xbb, 0xbf];

/** Lines chosen to exercise headings, fences, nested lists, HTML, quotes, tables and breaks. */
const markdownLine = fc.oneof(
  fc.constantFrom(
    "",
    "   ",
    "\t",
    "# Notes",
    "## Notes",
    "### Deep ###",
    "#",
    "# a/b",
    "# Notes[2]",
    "# 100%",
    "## heading",
    "## paragraph-1",
    "Title",
    "=====",
    "-----",
    "---",
    "...",
    "***",
    "- - -",
    "```",
    "```sh",
    "````",
    "~~~",
    "    indented code",
    "\tcode",
    "- item",
    "  - nested",
    "    1. deeper",
    "* star",
    "1. one",
    "2) two",
    "-",
    "> quote",
    "<!--",
    "-->",
    "<!-- comment -->",
    "<div>",
    "</div>",
    "<pre>",
    "</pre>",
    "<b>bold</b> text",
    "<span>",
    "| a | b |",
    "| - | - |",
    "plain text",
    "hard break  ",
    "Grüße 😀",
  ),
  fc.string({
    unit: fc.constantFrom(
      "#",
      "-",
      "*",
      " ",
      "\t",
      "`",
      "~",
      "a",
      ">",
      "<",
      "!",
      "=",
      "|",
      "1",
      ".",
      "é",
    ),
    maxLength: 12,
  }),
);

const markdownDocument = fc
  .record({
    bom: fc.boolean(),
    frontMatter: fc.boolean(),
    lines: fc.array(fc.tuple(markdownLine, fc.constantFrom("\n", "\r\n", "\r")), { maxLength: 40 }),
    trailingLineEnding: fc.boolean(),
  })
  .map(({ bom, frontMatter, lines, trailingLineEnding }) => {
    let text = frontMatter ? "---\ntitle: invented\n---\n" : "";
    lines.forEach(([line, ending], index) => {
      const last = index === lines.length - 1;
      text += line + (last && !trailingLineEnding ? "" : ending);
    });
    return new Uint8Array([...(bom ? BOM : []), ...Buffer.from(text, "utf8")]);
  });

const randomBytes = fc.uint8Array({ maxLength: 400 });

const rebuild = (bytes: Uint8Array, blocks: readonly GuidanceBlock[]): Buffer => {
  const parts: Buffer[] = [];
  let offset = 0;
  for (const { sourceSpan } of blocks) {
    parts.push(Buffer.from(bytes.subarray(offset, sourceSpan.end)));
    offset = sourceSpan.end;
  }
  parts.push(Buffer.from(bytes.subarray(offset)));
  return Buffer.concat(parts);
};

const idsAreUnique = (parsed: ParsedDestination): boolean =>
  new Set(parsed.blocks.map((b) => b.blockId)).size === parsed.blocks.length;

const isWholeFileFallback = (parsed: ParsedDestination, bytes: Uint8Array): boolean =>
  bytes.length === 0
    ? parsed.blocks.length === 0
    : parsed.blocks.length === 1 &&
      parsed.blocks[0]?.blockId === "other-1" &&
      parsed.blocks[0].type === "other" &&
      parsed.blocks[0].sourceSpan.start === 0 &&
      parsed.blocks[0].sourceSpan.end === bytes.length &&
      parsed.blocks[0].hash === sha256(bytes);

describe("Markdown-shaped input (DM §7)", () => {
  it("verifies the round trip", () => {
    fc.assert(
      fc.property(markdownDocument, (bytes) => {
        expect(parseGuidanceBlocks(bytes).roundTrip).toEqual({ state: "verified" });
      }),
      { numRuns: 1000 },
    );
  });

  it("rebuilds the input bytes exactly", () => {
    fc.assert(
      fc.property(markdownDocument, (bytes) => {
        const parsed = parseGuidanceBlocks(bytes);
        expect(rebuild(bytes, parsed.blocks).equals(Buffer.from(bytes))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("gives every block a unique ID", () => {
    fc.assert(
      fc.property(markdownDocument, (bytes) => {
        expect(idsAreUnique(parseGuidanceBlocks(bytes))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("never starts or ends a block with a blank line", () => {
    fc.assert(
      fc.property(markdownDocument, (bytes) => {
        const view = Buffer.from(bytes).toString("latin1");
        for (const { sourceSpan } of parseGuidanceBlocks(bytes).blocks) {
          const own = view.slice(sourceSpan.start, sourceSpan.end);
          const lines = own.split(/\r\n|\r|\n/);
          expect(/^[ \t]*$/.test(lines[0] ?? "")).toBe(false);
          expect(/^[ \t]*$/.test(lines.at(-1) ?? "")).toBe(false);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("parses identically from a copy", () => {
    fc.assert(
      fc.property(markdownDocument, (bytes) => {
        expect(parseGuidanceBlocks(new Uint8Array(bytes))).toEqual(parseGuidanceBlocks(bytes));
      }),
    );
  });
});

describe("random bytes (DM §7)", () => {
  it("never throws, rebuilds the input and keeps IDs unique", () => {
    fc.assert(
      fc.property(randomBytes, (bytes) => {
        const parsed = parseGuidanceBlocks(bytes);
        expect(rebuild(bytes, parsed.blocks).equals(Buffer.from(bytes))).toBe(true);
        expect(idsAreUnique(parsed)).toBe(true);
        if (parsed.roundTrip.state === "failed") {
          expect(isWholeFileFallback(parsed, bytes)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("fallback (DM §7)", () => {
  const spans = fc.array(fc.tuple(fc.nat(60), fc.nat(60)), { maxLength: 6 });

  it("covers the whole file whenever the round trip fails", () => {
    fc.assert(
      fc.property(markdownDocument, spans, (bytes, raw) => {
        const splitter: BlockSplitter = () =>
          raw.map(([start, end]) => ({ type: "paragraph", start, end }));
        const parsed = parseGuidanceBlocks(bytes, splitter);
        if (parsed.roundTrip.state === "failed") {
          expect(isWholeFileFallback(parsed, bytes)).toBe(true);
        }
        expect(rebuild(bytes, parsed.blocks).equals(Buffer.from(bytes))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("covers the whole file when the splitter throws", () => {
    fc.assert(
      fc.property(randomBytes, (bytes) => {
        const parsed = parseGuidanceBlocks(bytes, () => {
          throw new Error("boom");
        });
        expect(parsed.roundTrip).toEqual({ state: "failed", reason: "parser_error" });
        expect(isWholeFileFallback(parsed, bytes)).toBe(true);
      }),
    );
  });
});
