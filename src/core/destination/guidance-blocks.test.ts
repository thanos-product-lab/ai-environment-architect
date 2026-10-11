import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256 } from "../hash.js";
import {
  type BlockSplitter,
  type GuidanceBlock,
  type ParsedDestination,
  parseGuidanceBlocks,
  verifyRoundTrip,
} from "./guidance-blocks.js";

const fixtures = new URL("../../../test/fixtures/", import.meta.url);
const destinationFixtures = readdirSync(new URL("destinations/", fixtures))
  .filter((name) => name.endsWith(".md"))
  .sort();
const readFixture = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(path, fixtures)));

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const parse = (text: string): ParsedDestination => parseGuidanceBlocks(bytesOf(text));
const textOf = (bytes: Uint8Array, block: GuidanceBlock): string =>
  Buffer.from(bytes.subarray(block.sourceSpan.start, block.sourceSpan.end)).toString("utf8");

/** `[blockId, type, text]` for each block, the shape most tests compare. */
const summary = (text: string): [string, string, string][] => {
  const bytes = bytesOf(text);
  return parseGuidanceBlocks(bytes).blocks.map((b) => [b.blockId, b.type, textOf(bytes, b)]);
};
const ids = (text: string): string[] => parse(text).blocks.map((b) => b.blockId);

/** Rebuilds the file from the bytes between blocks and each block's own bytes. */
const rebuild = (bytes: Uint8Array, blocks: readonly GuidanceBlock[]): Buffer => {
  const parts: Buffer[] = [];
  let offset = 0;
  for (const { sourceSpan } of blocks) {
    parts.push(Buffer.from(bytes.subarray(offset, sourceSpan.start)));
    parts.push(Buffer.from(bytes.subarray(sourceSpan.start, sourceSpan.end)));
    offset = sourceSpan.end;
  }
  parts.push(Buffer.from(bytes.subarray(offset)));
  return Buffer.concat(parts);
};

/** Bytes outside every block, which must be only the BOM, spaces, tabs and line endings. */
const separatorBytes = (bytes: Uint8Array, blocks: readonly GuidanceBlock[]): number[] => {
  const inside = new Set<number>();
  for (const { sourceSpan } of blocks) {
    for (let i = sourceSpan.start; i < sourceSpan.end; i++) inside.add(i);
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return [...bytes.keys()].filter((i) => i >= bom && !inside.has(i)).map((i) => bytes[i] ?? -1);
};

describe("lossless round trip on every destination fixture (DM §17)", () => {
  const all = [
    ...destinationFixtures.map((name) => `destinations/${name}`),
    "repos/unusual-markdown/CLAUDE.md",
  ];

  it("covers all thirteen fixture files", () => {
    expect(all).toHaveLength(13);
  });

  it.each(all)("%s rebuilds byte for byte from its blocks and separators", (path) => {
    const bytes = readFixture(path);
    const parsed = parseGuidanceBlocks(bytes);
    expect(parsed.roundTrip).toEqual({ state: "verified" });
    expect(rebuild(bytes, parsed.blocks).equals(Buffer.from(bytes))).toBe(true);
  });

  it.each(all)("%s leaves only whitespace and line endings outside blocks", (path) => {
    const bytes = readFixture(path);
    const outside = separatorBytes(bytes, parseGuidanceBlocks(bytes).blocks);
    expect(outside.filter((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)).toEqual([]);
  });

  it.each(all)("%s has ordered spans, matching hashes and unique IDs", (path) => {
    const bytes = readFixture(path);
    const { blocks } = parseGuidanceBlocks(bytes);
    let previousEnd = 0;
    for (const block of blocks) {
      expect(block.sourceSpan.start).toBeGreaterThanOrEqual(previousEnd);
      expect(block.sourceSpan.end).toBeGreaterThan(block.sourceSpan.start);
      expect(block.hash).toBe(sha256(bytes.subarray(block.sourceSpan.start, block.sourceSpan.end)));
      previousEnd = block.sourceSpan.end;
    }
    expect(new Set(blocks.map((b) => b.blockId)).size).toBe(blocks.length);
  });

  it.each(all)("%s parses identically twice, from separate copies", (path) => {
    const bytes = readFixture(path);
    expect(parseGuidanceBlocks(new Uint8Array(bytes))).toEqual(parseGuidanceBlocks(bytes));
  });
});

describe("destination fixtures, block by block (DM §7)", () => {
  const blocksOf = (name: string): [string, string, string][] => {
    const bytes = readFixture(`destinations/${name}`);
    return parseGuidanceBlocks(bytes).blocks.map((b) => [b.blockId, b.type, textOf(bytes, b)]);
  };

  it("crlf.md keeps CR inside multi-line blocks out of the final line ending", () => {
    expect(blocksOf("crlf.md")).toEqual([
      ["Rules/heading", "heading", "# Rules"],
      ["Rules/paragraph-1", "paragraph", "Use CRLF here."],
      ["Rules/list-item-1", "list_item", "- one"],
      ["Rules/list-item-2", "list_item", "- two"],
    ]);
  });

  it("crlf.md records CRLF line endings", () => {
    expect(parseGuidanceBlocks(readFixture("destinations/crlf.md")).lineEndings).toEqual({
      style: "crlf",
      counts: { lf: 0, crlf: 6, cr: 0 },
    });
  });

  it("bom.md starts its first block after the byte order mark", () => {
    const { blocks } = parseGuidanceBlocks(readFixture("destinations/bom.md"));
    expect(blocks[0]?.sourceSpan.start).toBe(3);
    expect(blocksOf("bom.md")).toEqual([
      ["Rules/heading", "heading", "# Rules"],
      ["Rules/paragraph-1", "paragraph", "Starts with a byte order mark."],
    ]);
  });

  it("bom-crlf.md handles the BOM and CRLF together", () => {
    const parsed = parseGuidanceBlocks(readFixture("destinations/bom-crlf.md"));
    expect(parsed.blocks[0]?.sourceSpan).toEqual({ start: 3, end: 10 });
    expect(parsed.lineEndings.style).toBe("crlf");
    expect(blocksOf("bom-crlf.md").map(([id]) => id)).toEqual([
      "Rules/heading",
      "Rules/paragraph-1",
    ]);
  });

  it("no-trailing-newline.md ends its last block at the end of the file", () => {
    const bytes = readFixture("destinations/no-trailing-newline.md");
    const parsed = parseGuidanceBlocks(bytes);
    expect(parsed.blocks.at(-1)?.sourceSpan.end).toBe(bytes.length);
    expect(parsed.lineEndings).toEqual({ style: "lf", counts: { lf: 2, crlf: 0, cr: 0 } });
    expect(blocksOf("no-trailing-newline.md").at(-1)).toEqual([
      "Rules/paragraph-1",
      "paragraph",
      "The last line has no newline.",
    ]);
  });

  it("setext-headings.md makes each text line and underline one heading block", () => {
    expect(blocksOf("setext-headings.md")).toEqual([
      ["Rules/heading", "heading", "Rules\n====="],
      ["Rules/paragraph-1", "paragraph", "Intro paragraph."],
      ["Rules/Testing/heading", "heading", "Testing\n-------"],
      ["Rules/Testing/paragraph-1", "paragraph", "Run the checks."],
    ]);
  });

  it("fenced-hash-lines.md never reads # lines inside fences as headings", () => {
    expect(blocksOf("fenced-hash-lines.md")).toEqual([
      ["Build/heading", "heading", "# Build"],
      ["Build/code-block-1", "code_block", "```sh\n# not a heading\nmake all\n```"],
      ["Build/code-block-2", "code_block", "~~~\n## also not a heading\n~~~"],
      ["Build/paragraph-1", "paragraph", "After the fences."],
    ]);
  });

  it("front-matter.md keeps the front matter as one other block", () => {
    expect(blocksOf("front-matter.md")).toEqual([
      ["other-1", "other", "---\ntitle: Rules\nowner: invented\n---"],
      ["Rules/heading", "heading", "# Rules"],
      ["Rules/paragraph-1", "paragraph", "Body after front matter."],
    ]);
  });

  it("html-comments.md keeps comments as other blocks and ignores headings inside them", () => {
    expect(blocksOf("html-comments.md")).toEqual([
      ["Notes/heading", "heading", "# Notes"],
      ["Notes/other-1", "other", "<!-- single line comment -->"],
      ["Notes/other-2", "other", "<!--\n# commented heading\n-->"],
      ["Notes/paragraph-1", "paragraph", "Visible paragraph."],
    ]);
  });

  it("mixed-line-endings.md keeps LF, CRLF and a lone CR inside one paragraph", () => {
    const parsed = parseGuidanceBlocks(readFixture("destinations/mixed-line-endings.md"));
    expect(parsed.lineEndings).toEqual({ style: "mixed", counts: { lf: 3, crlf: 1, cr: 1 } });
    expect(blocksOf("mixed-line-endings.md")).toEqual([
      ["Rules/heading", "heading", "# Rules"],
      ["Rules/paragraph-1", "paragraph", "LF line.\r\nCRLF line.\rLone CR line."],
    ]);
  });

  it("nested-lists.md makes each top-level item one block, including nested items", () => {
    expect(blocksOf("nested-lists.md")).toEqual([
      ["Style/heading", "heading", "# Style"],
      [
        "Style/list-item-1",
        "list_item",
        "- naming\n  - files use kebab case\n    1. lower case\n    2. dashes",
      ],
      ["Style/list-item-2", "list_item", "- layout\n  * one export per file"],
    ]);
  });

  it("trailing-whitespace.md keeps trailing spaces, hard breaks and tabs inside blocks", () => {
    const blocks = blocksOf("trailing-whitespace.md");
    expect(blocks.map(([id, type]) => [id, type])).toEqual([
      ["Rules/heading", "heading"],
      ["Rules/paragraph-1", "paragraph"],
      ["Rules/paragraph-2", "paragraph"],
    ]);
    expect(blocks[0]?.[2]).toMatch(/^# Rules +$/);
    expect(blocks[1]?.[2]).toMatch(/spaces +\nLine with a hard break {2}\nnext line\n.*tab\t$/);
    expect(blocks[2]?.[2]).toBe("End.");
  });

  it("unclosed-fence.md runs the open fence to the end of the file", () => {
    expect(blocksOf("unclosed-fence.md")).toEqual([
      ["Build/heading", "heading", "# Build"],
      ["Build/code-block-1", "code_block", "```sh\n# never closed\nmake all"],
    ]);
  });

  it("unusual-markdown/CLAUDE.md mixes setext headings, a comment, a fence and nested lists", () => {
    const bytes = readFixture("repos/unusual-markdown/CLAUDE.md");
    const blocks = parseGuidanceBlocks(bytes).blocks;
    expect(blocks.map((b) => [b.blockId, b.type, textOf(bytes, b)])).toEqual([
      ["Quill/heading", "heading", "Quill\n====="],
      ["Quill/other-1", "other", "<!-- maintained by hand -->"],
      ["Quill/Commands/heading", "heading", "Commands\n--------"],
      ["Quill/Commands/code-block-1", "code_block", "```sh\n# install first\nnpm install\n```"],
      ["Quill/Commands/list-item-1", "list_item", "- Style\n  - two spaces\n    - no tabs"],
      ["Quill/Commands/list-item-2", "list_item", "- Tests"],
    ]);
  });
});

describe("empty and whitespace-only destinations (DM §7)", () => {
  it("an empty file has zero blocks and verifies", () => {
    expect(parseGuidanceBlocks(new Uint8Array())).toEqual({
      blocks: [],
      lineEndings: { style: "none", counts: { lf: 0, crlf: 0, cr: 0 } },
      roundTrip: { state: "verified" },
    });
  });

  it("a file of blank lines has zero blocks", () => {
    expect(parse("  \n\t\n\r\n").blocks).toEqual([]);
  });

  it("a file holding only a BOM has zero blocks", () => {
    expect(parseGuidanceBlocks(new Uint8Array([0xef, 0xbb, 0xbf])).blocks).toEqual([]);
  });

  it("keeps a U+FEFF that starts heading text after the file's BOM", () => {
    const parsed = parse("\uFEFF\uFEFFTitle\n===\n\n\uFEFFNext\n---\n");
    expect(parsed.blocks.map((b) => [b.blockId, b.headingPath])).toEqual([
      ["\uFEFFTitle/heading", []],
      ["\uFEFFTitle/\uFEFFNext/heading", ["\uFEFFTitle"]],
    ]);
  });
});

describe("block fields (DM §7)", () => {
  it("hashes each block's exact bytes", () => {
    const bytes = bytesOf("# A\n\ntext  \n");
    const [heading, paragraph] = parseGuidanceBlocks(bytes).blocks;
    expect(heading?.hash).toBe(sha256(bytesOf("# A")));
    expect(paragraph?.hash).toBe(sha256(bytesOf("text  ")));
  });

  it("counts spans in bytes, not UTF-16 code units", () => {
    const { blocks } = parse("# Ünïcödé 😀\n\nnext\n");
    expect(blocks[0]?.sourceSpan).toEqual({ start: 0, end: 18 });
    expect(blocks[1]?.sourceSpan).toEqual({ start: 20, end: 24 });
  });

  it("gives a heading block the path of its parents, not itself", () => {
    const { blocks } = parse("# A\n## B\ntext\n");
    expect(blocks.map((b) => b.headingPath)).toEqual([[], ["A"], ["A", "B"]]);
  });

  it("decodes heading paths as UTF-8 text", () => {
    expect(parse("# Grüße\nx\n").blocks[1]?.headingPath).toEqual(["Grüße"]);
  });

  it("records the indentation and marker of a list item", () => {
    const { blocks } = parse("- a\n\n * b\n\n1. c\n2) d\n");
    expect(blocks.map((b) => (b.type === "list_item" ? b.listMarker : undefined))).toEqual([
      { indent: "", marker: "-" },
      { indent: " ", marker: "*" },
      { indent: "", marker: "1." },
      { indent: "", marker: "2)" },
    ]);
  });

  it("puts listMarker on list items only", () => {
    for (const block of parse("# A\n\npara\n\n```\nx\n```\n").blocks) {
      expect("listMarker" in block).toBe(false);
    }
  });
});

describe("line endings (DM §7)", () => {
  it("treats a lone CR as a line ending", () => {
    const parsed = parse("# A\rtext\r");
    expect(parsed.lineEndings).toEqual({ style: "cr", counts: { lf: 0, crlf: 0, cr: 2 } });
    expect(summary("# A\rtext\r")).toEqual([
      ["A/heading", "heading", "# A"],
      ["A/paragraph-1", "paragraph", "text"],
    ]);
  });

  it("reports none when the file has no line ending", () => {
    expect(parse("one line").lineEndings.style).toBe("none");
  });
});

describe("headings (DM §7)", () => {
  it("strips the ATX closing sequence from the heading text", () => {
    expect(ids("## Build ##\nx\n")).toEqual(["Build/heading", "Build/paragraph-1"]);
  });

  it("does not read # without a following space as a heading", () => {
    expect(summary("#5 not a heading\n")).toEqual([
      ["paragraph-1", "paragraph", "#5 not a heading"],
    ]);
  });

  it("does not read seven # as a heading", () => {
    expect(parse("####### seven\n").blocks[0]?.type).toBe("paragraph");
  });

  it("joins a multi-line setext heading with one space", () => {
    expect(parse("Two\nlines\n===\nx\n").blocks[1]?.headingPath).toEqual(["Two lines"]);
  });

  it("nests a heading that skips a level, and pops every level at or below it", () => {
    expect(parse("# A\n### B\n## C\nx\n").blocks.map((b) => b.blockId)).toEqual([
      "A/heading",
      "A/B/heading",
      "A/C/heading",
      "A/C/paragraph-1",
    ]);
  });

  it("reads --- under a paragraph as a setext underline, and alone as a thematic break", () => {
    expect(summary("Title\n---\n\n---\n")).toEqual([
      ["Title/heading", "heading", "Title\n---"],
      ["Title/other-1", "other", "---"],
    ]);
  });
});

describe("block IDs stay unique when headings repeat (DM §7)", () => {
  it("suffixes repeated sibling headings with their occurrence", () => {
    expect(ids("# A\n## Notes\nx\n## Notes\ny\n## Notes\nz\n")).toEqual([
      "A/heading",
      "A/Notes/heading",
      "A/Notes/paragraph-1",
      "A/Notes[2]/heading",
      "A/Notes[2]/paragraph-1",
      "A/Notes[3]/heading",
      "A/Notes[3]/paragraph-1",
    ]);
  });

  it("does not suffix the same heading under different parents", () => {
    expect(ids("# A\n## Notes\nx\n# B\n## Notes\ny\n")).toEqual([
      "A/heading",
      "A/Notes/heading",
      "A/Notes/paragraph-1",
      "B/heading",
      "B/Notes/heading",
      "B/Notes/paragraph-1",
    ]);
  });

  it("treats headings of different levels under one parent as siblings", () => {
    expect(ids("## Notes\nx\n# Notes\ny\n")).toEqual([
      "Notes/heading",
      "Notes/paragraph-1",
      "Notes[2]/heading",
      "Notes[2]/paragraph-1",
    ]);
  });

  it("percent-encodes characters that would collide with separators or suffixes", () => {
    expect(ids("# Notes[2]\n# Notes\n# Notes\n# a/b\n# 100%\n# tab\there\n")).toEqual([
      "Notes%5B2%5D/heading",
      "Notes/heading",
      "Notes[2]/heading",
      "a%2Fb/heading",
      "100%25/heading",
      "tab%09here/heading",
    ]);
  });

  it("keeps headings named like type tokens apart from the section's own blocks", () => {
    const result = ids("# A\npara\n## paragraph-1\nx\n## heading\ny\n");
    expect(result).toEqual([
      "A/heading",
      "A/paragraph-1",
      "A/paragraph-1/heading",
      "A/paragraph-1/paragraph-1",
      "A/heading/heading",
      "A/heading/paragraph-1",
    ]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("gives an empty heading an empty segment", () => {
    expect(ids("#\nx\n#\ny\n")).toEqual([
      "/heading",
      "/paragraph-1",
      "[2]/heading",
      "[2]/paragraph-1",
    ]);
  });

  it("numbers blocks by type within their section, before the first heading too", () => {
    expect(ids("intro\n\n- i\n# A\np1\n\n- i1\n- i2\n\np2\n")).toEqual([
      "paragraph-1",
      "list-item-1",
      "A/heading",
      "A/paragraph-1",
      "A/list-item-1",
      "A/list-item-2",
      "A/paragraph-2",
    ]);
  });
});

describe("code blocks (DM §7)", () => {
  it("reads 4-space indentation after a blank line as a code block", () => {
    expect(summary("para\n\n    code\n\n    more\n\nafter\n")).toEqual([
      ["paragraph-1", "paragraph", "para"],
      ["code-block-1", "code_block", "    code\n\n    more"],
      ["paragraph-2", "paragraph", "after"],
    ]);
  });

  it("treats an indented line straight after a paragraph as continuation", () => {
    expect(summary("para\n    still para\n")).toEqual([
      ["paragraph-1", "paragraph", "para\n    still para"],
    ]);
  });

  it("counts a tab as indentation to the next multiple of four columns", () => {
    expect(parse("\tcode\n").blocks[0]?.type).toBe("code_block");
  });

  it("closes a fence only with the same character and at least the same length", () => {
    expect(summary("````\n```\n~~~~\n````\nafter\n")).toEqual([
      ["code-block-1", "code_block", "````\n```\n~~~~\n````"],
      ["paragraph-1", "paragraph", "after"],
    ]);
  });

  it("leaves trailing blank lines of an unclosed fence outside the block", () => {
    expect(summary("```\nx\n\n\n")).toEqual([["code-block-1", "code_block", "```\nx"]]);
  });
});

describe("list items (DM §7)", () => {
  it("includes continuation after a blank line when it is indented to the content", () => {
    expect(summary("- a\n\n  more a\n- b\n")).toEqual([
      ["list-item-1", "list_item", "- a\n\n  more a"],
      ["list-item-2", "list_item", "- b"],
    ]);
  });

  it("includes a lazy continuation line", () => {
    expect(summary("- a\nlazy\n- b\n")).toEqual([
      ["list-item-1", "list_item", "- a\nlazy"],
      ["list-item-2", "list_item", "- b"],
    ]);
  });

  it("ends an item at an unindented line after a blank line", () => {
    expect(summary("- a\n\nafter\n")).toEqual([
      ["list-item-1", "list_item", "- a"],
      ["paragraph-1", "paragraph", "after"],
    ]);
  });

  it("keeps a fence inside an item, and ends the item at a heading", () => {
    expect(summary("- a\n  ```\n  # x\n  ```\n# H\n")).toEqual([
      ["list-item-1", "list_item", "- a\n  ```\n  # x\n  ```"],
      ["H/heading", "heading", "# H"],
    ]);
  });

  it("does not continue a fence inside an item lazily", () => {
    expect(summary("- ```\nx\n")).toEqual([
      ["list-item-1", "list_item", "- ```"],
      ["paragraph-1", "paragraph", "x"],
    ]);
  });

  it("lets a bullet interrupt a paragraph", () => {
    expect(summary("text\n- item\n")).toEqual([
      ["paragraph-1", "paragraph", "text"],
      ["list-item-1", "list_item", "- item"],
    ]);
  });

  it("lets an ordered list interrupt a paragraph only when it starts at 1", () => {
    expect(summary("text\n2. two\n").map(([, type]) => type)).toEqual(["paragraph"]);
    expect(summary("text\n1. one\n").map(([, type]) => type)).toEqual(["paragraph", "list_item"]);
  });

  it("does not let an empty bullet interrupt a paragraph", () => {
    expect(summary("text\n-\n")[0]?.[1]).toBe("heading");
    expect(summary("text\n+\n")).toEqual([["paragraph-1", "paragraph", "text\n+"]]);
  });

  it("reads - - - as a thematic break, not a list item", () => {
    expect(summary("- - -\n")).toEqual([["other-1", "other", "- - -"]]);
  });
});

describe("review findings: lazy continuation and HTML (DM §7)", () => {
  it("does not continue a list item lazily after indented code inside it", () => {
    expect(summary("- a\n\n      code\nNever push.\n")).toEqual([
      ["list-item-1", "list_item", "- a\n\n      code"],
      ["paragraph-1", "paragraph", "Never push."],
    ]);
  });

  it("does not continue a list item lazily after an empty nested item", () => {
    expect(summary("- a\n  -\nNever push.\n")).toEqual([
      ["list-item-1", "list_item", "- a\n  -"],
      ["paragraph-1", "paragraph", "Never push."],
    ]);
  });

  it("still continues lazily after a nested item with text", () => {
    expect(summary("- a\n  - b\nlazy\n")).toEqual([
      ["list-item-1", "list_item", "- a\n  - b\nlazy"],
    ]);
  });

  it("keeps a line that starts with inline HTML as a paragraph", () => {
    expect(summary("<b>Never</b> push to main.\n")).toEqual([
      ["paragraph-1", "paragraph", "<b>Never</b> push to main."],
    ]);
  });

  it("reads a line holding one complete tag as an HTML block", () => {
    expect(summary('<details>\nx\n\n<custom-tag attr="1">\ny\n')).toEqual([
      ["other-1", "other", "<details>\nx"],
      ["other-2", "other", '<custom-tag attr="1">\ny'],
    ]);
  });

  it("runs a pre block to its closing tag, across blank lines", () => {
    expect(summary("<pre>\na\n\nb\n</pre>\nafter\n")).toEqual([
      ["other-1", "other", "<pre>\na\n\nb\n</pre>"],
      ["paragraph-1", "paragraph", "after"],
    ]);
  });

  it("lets a block-level tag interrupt a paragraph, but not an inline tag", () => {
    expect(summary("Para\n<div>\nx\n</div>\n")).toEqual([
      ["paragraph-1", "paragraph", "Para"],
      ["other-1", "other", "<div>\nx\n</div>"],
    ]);
    expect(summary("Para\n<span>\n")).toEqual([["paragraph-1", "paragraph", "Para\n<span>"]]);
  });

  it("does not read a blank line inside --- lines as front matter", () => {
    expect(ids("---\n# Rules\n\ntext\n\nSub\n---\nmore\n")).toEqual([
      "other-1",
      "Rules/heading",
      "Rules/paragraph-1",
      "Rules/Sub/heading",
      "Rules/Sub/paragraph-1",
    ]);
  });

  it("percent-encodes C1 control characters in segments", () => {
    expect(ids("# x\u0085y\n")).toEqual(["x%85y/heading"]);
  });
});

describe("other blocks (DM §7)", () => {
  it("keeps a block quote, with its lazy lines, as one other block", () => {
    expect(summary("> quote\n> more\nlazy\n\npara\n")).toEqual([
      ["other-1", "other", "> quote\n> more\nlazy"],
      ["paragraph-1", "paragraph", "para"],
    ]);
  });

  it("keeps a GFM table as one other block", () => {
    expect(summary("| a | b |\n| - | - |\n| 1 | 2 |\n")).toEqual([
      ["other-1", "other", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ]);
  });

  it("keeps an HTML block until a blank line, without reading headings inside it", () => {
    expect(summary("<div>\n# not a heading\n</div>\n\npara\n")).toEqual([
      ["other-1", "other", "<div>\n# not a heading\n</div>"],
      ["paragraph-1", "paragraph", "para"],
    ]);
  });

  it("runs an unclosed HTML comment to the end of the file", () => {
    expect(summary("<!-- open\n# x\n")).toEqual([["other-1", "other", "<!-- open\n# x"]]);
  });

  it("reads front matter after a BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("---\na: b\n---\n")]);
    const { blocks } = parseGuidanceBlocks(bytes);
    expect(blocks.map((b) => [b.blockId, b.sourceSpan])).toEqual([
      ["other-1", { start: 3, end: 15 }],
    ]);
  });

  it("does not read --- as front matter when it never closes", () => {
    expect(summary("---\ntitle: x\n")).toEqual([
      ["other-1", "other", "---"],
      ["paragraph-1", "paragraph", "title: x"],
    ]);
  });

  it("reads front matter only on the first line", () => {
    expect(summary("x\n\n---\na: b\n").map(([id]) => id)).toEqual([
      "paragraph-1",
      "other-1",
      "paragraph-2",
    ]);
  });
});

describe("fallback when the round trip fails (DM §7)", () => {
  const broken =
    (spans: [number, number][]): BlockSplitter =>
    () =>
      spans.map(([start, end]) => ({ type: "paragraph", start, end }));

  const expectFallback = (parsed: ParsedDestination, bytes: Uint8Array, reason: string) => {
    expect(parsed.roundTrip).toEqual({ state: "failed", reason });
    expect(parsed.blocks).toEqual([
      {
        blockId: "other-1",
        type: "other",
        headingPath: [],
        sourceSpan: { start: 0, end: bytes.length },
        hash: sha256(bytes),
      },
    ]);
  };

  it("replaces the blocks with one whole-file other block when spans overlap", () => {
    const bytes = bytesOf("aaa\nbbb\n");
    expectFallback(
      parseGuidanceBlocks(
        bytes,
        broken([
          [0, 5],
          [4, 7],
        ]),
      ),
      bytes,
      "span_order",
    );
  });

  it("fails when content is left outside every block", () => {
    const bytes = bytesOf("aaa\nbbb\n");
    expectFallback(parseGuidanceBlocks(bytes, broken([[0, 3]])), bytes, "content_outside_blocks");
  });

  it("fails when a span runs past the end of the file", () => {
    const bytes = bytesOf("aaa");
    expectFallback(parseGuidanceBlocks(bytes, broken([[0, 9]])), bytes, "span_order");
  });

  it("fails instead of throwing when the splitter throws", () => {
    const bytes = bytesOf("aaa");
    const throwing: BlockSplitter = () => {
      throw new Error("boom");
    };
    expectFallback(parseGuidanceBlocks(bytes, throwing), bytes, "parser_error");
  });

  it("keeps zero blocks when an empty file fails", () => {
    const parsed = parseGuidanceBlocks(new Uint8Array(), () => {
      throw new Error("boom");
    });
    expect(parsed.blocks).toEqual([]);
    expect(parsed.roundTrip).toEqual({ state: "failed", reason: "parser_error" });
  });

  it("verifyRoundTrip reports a hash that does not match the span", () => {
    const bytes = bytesOf("abc");
    const [block] = parseGuidanceBlocks(bytes).blocks;
    if (block === undefined) throw new Error("expected a block");
    expect(verifyRoundTrip(bytes, [{ ...block, hash: sha256(bytesOf("x")) }])).toEqual({
      state: "failed",
      reason: "hash_mismatch",
    });
  });

  it("verifyRoundTrip reports a repeated block ID", () => {
    const bytes = bytesOf("a\n\nb\n");
    const blocks = parseGuidanceBlocks(bytes).blocks.map((b) => ({ ...b, blockId: "same" }));
    expect(verifyRoundTrip(bytes, blocks)).toEqual({
      state: "failed",
      reason: "duplicate_block_id",
    });
  });

  it("verifyRoundTrip accepts the parser's own result", () => {
    const bytes = readFixture("destinations/mixed-line-endings.md");
    expect(verifyRoundTrip(bytes, parseGuidanceBlocks(bytes).blocks)).toEqual({
      state: "verified",
    });
  });
});
