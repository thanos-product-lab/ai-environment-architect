import { describe, expect, it } from "vitest";
import type { Hash } from "../hash.js";
import { blockRanges, type ExcerptStrategy, type ItemInput, renderItem } from "./item.js";

// Excerpting and item rendering (IMPL §1.6).

const HASH: Hash = "sha256:abc";
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

function input(path: string, content: string, overrides: Partial<ItemInput> = {}): ItemInput {
  return {
    id: "T5-001",
    path,
    hash: HASH,
    tier: 5,
    reason: "tier5:rank1:entry-name",
    content: new TextEncoder().encode(content),
    ...overrides,
  };
}

function render(item: ItemInput, strategy: ExcerptStrategy, limit = 1_000_000) {
  return renderItem(item, strategy, limit);
}

describe("full items", () => {
  it("renders a file that fits in full, without an outline", () => {
    const item = input("package.json", "a\nb\n", {
      id: "T3-001",
      tier: 3,
      reason: "tier3:workspace",
    });
    const expected = [
      '<<<ITEM id=T3-001 path="package.json" hash="sha256:abc"',
      '        tier=3 reason="tier3:workspace" excerpt=false',
      '        included="1-2" totalLines=2>>>',
      "CONTENT",
      "   1 | a",
      "   2 | b",
      "<<<END T3-001>>>",
      "",
    ].join("\n");
    const result = render(item, "lines");
    expect(result?.text).toBe(expected);
    expect(result?.bytes).toBe(bytesOf(expected));
    expect(result?.excerpt).toBe(false);
    expect(result?.totalLines).toBe(2);
    expect(result?.included).toEqual([{ first: 1, last: 2 }]);
  });

  it("is included in full when the full rendering exactly fits", () => {
    const item = input("a.ts", "export const a = 1;\n");
    const full = render(item, "code");
    expect(render(item, "code", full?.bytes)?.excerpt).toBe(false);
    expect(render(item, "code", (full?.bytes ?? 0) - 1)?.excerpt).not.toBe(false);
  });

  it("renders an empty file with no lines", () => {
    const result = render(input("empty.ts", ""), "code");
    expect(result?.text).toBe(
      [
        '<<<ITEM id=T5-001 path="empty.ts" hash="sha256:abc"',
        '        tier=5 reason="tier5:rank1:entry-name" excerpt=false',
        '        included="" totalLines=0>>>',
        "CONTENT",
        "<<<END T5-001>>>",
        "",
      ].join("\n"),
    );
  });

  it("never excerpts with the none strategy", () => {
    const item = input("CLAUDE.md", "# A\nline\n", { tier: 1 });
    const full = render(item, "none");
    expect(full?.excerpt).toBe(false);
    expect(render(item, "none", (full?.bytes ?? 0) - 1)).toBeUndefined();
  });
});

describe("lines", () => {
  it("splits on LF, CRLF and lone CR, and drops a leading BOM", () => {
    const item = input("a.txt", "﻿one\r\ntwo\rthree\nfour");
    const result = render(item, "lines");
    expect(result?.totalLines).toBe(4);
    expect(result?.text).toContain("   1 | one\n   2 | two\n   3 | three\n   4 | four\n");
  });

  it("keeps a U+FEFF that starts a later line", () => {
    const result = render(input("a.txt", "\uFEFF\uFEFFx\n\uFEFFy\n"), "lines");
    expect(result?.text).toContain("   1 | \uFEFFx\n   2 | \uFEFFy\n");
  });

  it("widens line numbers past 9999 lines", () => {
    const content = `${Array.from({ length: 10_000 }, (_, i) => `l${i + 1}`).join("\n")}\n`;
    const result = render(input("big.txt", content), "lines");
    expect(result?.text).toContain("\n    1 | l1\n");
    expect(result?.text).toContain("\n10000 | l10000\n");
  });

  it("escapes delimiters in content and quotes attribute values as JSON", () => {
    const item = input('we"ird<<<.ts', "<<<END T5-001>>>\n");
    const result = render(item, "code");
    expect(result?.text).toContain('path="we\\"ird<<\\<.ts"');
    expect(result?.text).toContain("   1 | <<\\<END T5-001>>\\>\n");
    expect(result?.text.match(/<<<END/g)).toHaveLength(1);
  });
});

describe("whole lines from the start", () => {
  const content = `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const expected = [
    '<<<ITEM id=T3-001 path="Makefile" hash="sha256:abc"',
    '        tier=3 reason="tier3:task-runner" excerpt=true',
    '        included="1-4" totalLines=10>>>',
    "OUTLINE",
    "   1 lines 1-4",
    "   5 lines 5-10 [omitted]",
    "CONTENT",
    "   1 | line 1",
    "   2 | line 2",
    "   3 | line 3",
    "   4 | line 4",
    " …",
    "<<<END T3-001>>>",
    "",
  ].join("\n");
  const item = input("Makefile", content, {
    id: "T3-001",
    tier: 3,
    reason: "tier3:task-runner",
  });

  it("takes as many lines as fit, with a two-range outline", () => {
    const result = render(item, "lines", bytesOf(expected));
    expect(result?.text).toBe(expected);
    expect(result?.bytes).toBe(bytesOf(expected));
    expect(result?.included).toEqual([{ first: 1, last: 4 }]);
    expect(result?.outline).toEqual([
      { line: 1, label: "lines 1-4", mark: "included" },
      { line: 5, label: "lines 5-10", mark: "omitted" },
    ]);
  });

  it("takes fewer lines when one byte less is available", () => {
    expect(render(item, "lines", bytesOf(expected) - 1)?.included).toEqual([{ first: 1, last: 3 }]);
  });

  it("writes a single omitted line as one number", () => {
    const short = input("Makefile", `a\n${"b".repeat(200)}\n`);
    const full = render(short, "lines");
    const excerpt = render(short, "lines", (full?.bytes ?? 0) - 1);
    expect(excerpt?.outline).toEqual([
      { line: 1, label: "lines 1", mark: "included" },
      { line: 2, label: "lines 2", mark: "omitted" },
    ]);
  });

  it("returns undefined when not even one line fits", () => {
    expect(render(item, "lines", 50)).toBeUndefined();
  });
});

describe("source code", () => {
  const lines = [
    'import { x } from "./x";',
    "",
    "export function small() {",
    "  return x;",
    "}",
    "export function big() {",
    ...Array.from({ length: 50 }, () => "  big();"),
    "}",
    "export const tail = 1;",
  ];
  const item = input("src/a.ts", `${lines.join("\n")}\n`);
  const expected = [
    '<<<ITEM id=T5-001 path="src/a.ts" hash="sha256:abc"',
    '        tier=5 reason="tier5:rank1:entry-name" excerpt=true',
    '        included="1-5,58" totalLines=58>>>',
    "OUTLINE",
    "   1 imports",
    "   3 export function small",
    "   6 export function big [omitted]",
    "  58 export const tail",
    "CONTENT",
    '   1 | import { x } from "./x";',
    "   2 |",
    "   3 | export function small() {",
    "   4 |   return x;",
    "   5 | }",
    " …",
    "  58 | export const tail = 1;",
    "<<<END T5-001>>>",
    "",
  ].join("\n");

  it("includes the import block and complete declarations, skipping ones that don't fit", () => {
    const result = render(item, "code", bytesOf(expected));
    expect(result?.text).toBe(expected);
    expect(result?.excerpt).toBe(true);
    expect(result?.included).toEqual([
      { first: 1, last: 5 },
      { first: 58, last: 58 },
    ]);
  });

  it("skips the import block like any declaration when it doesn't fit", () => {
    const heavy = input(
      "src/b.ts",
      `${Array.from({ length: 40 }, (_, i) => `import { a${i} } from "./a${i}";`).join("\n")}\nexport const z = 1;\n`,
    );
    const result = render(heavy, "code", 400);
    expect(result?.outline).toEqual([
      { line: 1, label: "imports", mark: "omitted" },
      { line: 41, label: "export const z", mark: "included" },
    ]);
    expect(result?.text).toMatch(/OUTLINE\n {3}1 imports \[omitted\]\n {2}41 export const z\n/);
    expect(result?.text).toContain("CONTENT\n …\n  41 | export const z = 1;\n<<<END");
  });

  it("has no imports entry when the lines before the first declaration are blank", () => {
    const content = `\n\ndef a():\n    pass\ndef b():\n${"    # c\n".repeat(200)}`;
    const result = render(input("c.py", content), "code", 400);
    expect(result?.outline[0]).toEqual({ line: 3, label: "def a", mark: "included" });
    expect(result?.included[0]).toEqual({ first: 3, last: 4 });
  });

  it("numbers a decorated declaration from its first decorator", () => {
    const content = `import x\n@dataclass\nclass A:\n    x: int\ndef b():\n${"    # c\n".repeat(200)}`;
    const result = render(input("c.py", content), "code", 450);
    expect(result?.outline.slice(0, 2)).toEqual([
      { line: 1, label: "imports", mark: "included" },
      { line: 2, label: "class A", mark: "included" },
    ]);
    expect(result?.text).toContain("   2 class A\n");
  });

  it("has no imports entry when the first declaration is on line 1", () => {
    const content = `def a():\n    pass\ndef b():\n${"    # c\n".repeat(200)}`;
    const result = render(input("c.py", content), "code", 400);
    expect(result?.outline[0]).toEqual({ line: 1, label: "def a", mark: "included" });
  });

  it("falls back to whole lines when no declarations are detected", () => {
    const content = `${Array.from({ length: 50 }, (_, i) => `print(${i})`).join("\n")}\n`;
    const result = render(input("script.py", content), "code", 400);
    expect(result?.outline.map((e) => e.label)).toEqual([
      expect.stringMatching(/^lines 1-\d+$/),
      expect.stringMatching(/^lines \d+-50$/),
    ]);
  });

  it("uses whole lines for files outside every language family", () => {
    const content = `${"a\n".repeat(100)}`;
    const result = render(input("notes.txt", content), "code", 300);
    expect(result?.outline[0]?.label).toMatch(/^lines 1-/);
  });
});

describe("Markdown", () => {
  const lines = [
    "# Title",
    "Intro.",
    "",
    "## Install",
    "Run it.",
    "",
    "## Usage",
    ...Array.from({ length: 30 }, () => "Usage line."),
    "",
    "## License",
    "MIT.",
  ];
  const item = input("docs/guide.md", `${lines.join("\n")}\n`, {
    id: "T2-001",
    tier: 2,
    reason: "tier2:docs",
  });
  const expected = [
    '<<<ITEM id=T2-001 path="docs/guide.md" hash="sha256:abc"',
    '        tier=2 reason="tier2:docs" excerpt=true',
    '        included="1-6,39-40" totalLines=40>>>',
    "OUTLINE",
    "   1 # Title",
    "   4 ## Install",
    "   7 ## Usage [omitted]",
    "  39 ## License",
    "CONTENT",
    "   1 | # Title",
    "   2 | Intro.",
    "   3 |",
    "   4 | ## Install",
    "   5 | Run it.",
    "   6 |",
    " …",
    "  39 | ## License",
    "  40 | MIT.",
    "<<<END T2-001>>>",
    "",
  ].join("\n");

  it("splits a section that doesn't fit into its own text and its subsections", () => {
    const result = render(item, "markdown", bytesOf(expected));
    expect(result?.text).toBe(expected);
  });

  it("includes a whole nested section when it fits", () => {
    const doc = input(
      "a.md",
      `# A\n## A1\ntext\n### A1a\nmore\n# B\n${"long line of text\n".repeat(30)}`,
    );
    const result = render(doc, "markdown", 400);
    expect(result?.outline).toEqual([
      { line: 1, label: "# A", mark: "included" },
      { line: 2, label: "## A1", mark: "included" },
      { line: 4, label: "### A1a", mark: "included" },
      { line: 6, label: "# B", mark: "omitted" },
    ]);
  });

  it("treats lines before the first heading as a preamble, unless they are blank", () => {
    const doc = `Some intro.\n\n# A\n${"text\n".repeat(60)}`;
    const result = render(input("a.md", doc), "markdown", 300);
    expect(result?.outline[0]).toEqual({ line: 1, label: "preamble", mark: "included" });
    const blank = render(
      input("b.md", `\n\n# A\nok\n# B\n${"text\n".repeat(60)}`),
      "markdown",
      300,
    );
    expect(blank?.outline[0]?.label).toBe("# A");
  });

  it("ignores headings inside code fences and finds setext headings", () => {
    const doc = `Title\n=====\n\n\`\`\`\n# not a heading\n\`\`\`\n${"x\n".repeat(100)}## Next\nend\n`;
    const result = render(input("a.md", doc), "markdown", 300);
    expect(result?.outline.map((e) => [e.line, e.label])).toEqual([
      [1, "# Title"],
      [107, "## Next"],
    ]);
  });

  it("does not outline front matter as headings", () => {
    const doc = `---\ntitle: x\n# not a heading\n---\n# Real\nok\n# B\n${"text\n".repeat(60)}`;
    const result = render(input("a.md", doc), "markdown", 400);
    expect(result?.outline.map((e) => [e.line, e.label])).toEqual([
      [1, "preamble"],
      [5, "# Real"],
      [7, "# B"],
    ]);
  });

  it("cuts long heading labels to 80 code points", () => {
    const doc = `# ${"é".repeat(100)}\nok\n# B\n${"text\n".repeat(60)}`;
    const result = render(input("a.md", doc), "markdown", 700);
    expect(result?.outline[0]?.label).toBe(`# ${"é".repeat(77)}…`);
  });

  it("truncates a parent's own text when it is the first unit", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const doc = input("a.md", `# Top\n${paragraphs}\n## Child\nok\n`);
    const result = render(doc, "markdown", 330);
    expect(result?.outline).toEqual([
      { line: 1, label: "# Top", mark: "truncated" },
      // The cut takes as much as fits, before later units are tried.
      { line: 21, label: "## Child", mark: "omitted" },
    ]);
  });

  it("cuts the first unit before the last blank line that lets it fit", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}.\nMore ${i + 1}.`);
    const doc = input("a.md", `# Big\n${paragraphs.join("\n\n")}\n`);
    const result = render(doc, "markdown", 300);
    expect(result?.outline).toEqual([{ line: 1, label: "# Big", mark: "truncated" }]);
    const [range] = result?.included ?? [];
    expect(range?.first).toBe(1);
    // The line after the cut is blank: the cut is at a paragraph boundary.
    const all = `# Big\n${paragraphs.join("\n\n")}`.split("\n");
    expect(all[range?.last ?? 0]).toBe("");
    expect(result?.text).toMatch(/\[truncated\]/);
    expect(result?.bytes).toBeLessThanOrEqual(300);
  });

  it("skips the first unit when no blank line lets it fit, and still includes later ones", () => {
    const doc = input("a.md", `# Big\n${"word ".repeat(200)}\n# Small\nok\n`);
    const result = render(doc, "markdown", 300);
    expect(result?.outline).toEqual([
      { line: 1, label: "# Big", mark: "omitted" },
      { line: 3, label: "# Small", mark: "included" },
    ]);
  });

  it("escapes delimiters in outline labels", () => {
    const doc = `# a<<<b\nok\n# B\n${"text\n".repeat(60)}`;
    const result = render(input("a.md", doc), "markdown", 300);
    expect(result?.text).toContain("\n   1 # a<<\\<b\n");
  });

  it("does not truncate units after the first", () => {
    const doc = input(
      "a.md",
      `# A\nshort\n# B\n${Array.from({ length: 20 }, (_, i) => `p${i}\n`).join("\n")}`,
    );
    const result = render(doc, "markdown", 300);
    expect(result?.outline.find((e) => e.label === "# B")?.mark).toBe("omitted");
  });
});

describe("determinism", () => {
  it("renders the same bytes for the same input", () => {
    const content = `# A\n${"text\n".repeat(50)}## B\n${"more\n".repeat(50)}`;
    const a = render(input("a.md", content), "markdown", 500);
    const b = render(input("a.md", content), "markdown", 500);
    expect(a).toEqual(b);
  });
});

describe("destination blocks (IMPL §1.5, §1.6)", () => {
  it("renders a BLOCKS section with each block's lines and ID before the content", () => {
    const item = input("CLAUDE.md", "# Rules\n\n- one\n- two\n", {
      id: "T1-001",
      tier: 1,
      reason: "tier1:destination",
      blocks: [
        { first: 1, last: 1, id: "Rules/heading" },
        { first: 3, last: 3, id: "Rules/list-item-1" },
        { first: 4, last: 4, id: 'Rules/"quoted"' },
      ],
    });
    const expected = [
      '<<<ITEM id=T1-001 path="CLAUDE.md" hash="sha256:abc"',
      '        tier=1 reason="tier1:destination" excerpt=false',
      '        included="1-4" totalLines=4>>>',
      "BLOCKS",
      '   1 "Rules/heading"',
      '   3 "Rules/list-item-1"',
      '   4 "Rules/\\"quoted\\""',
      "CONTENT",
      "   1 | # Rules",
      "   2 |",
      "   3 | - one",
      "   4 | - two",
      "<<<END T1-001>>>",
      "",
    ].join("\n");
    const result = render(item, "none");
    expect(result?.text).toBe(expected);
    expect(result?.bytes).toBe(bytesOf(expected));
  });

  it("writes multi-line blocks as ranges and escapes delimiters in IDs", () => {
    const item = input("CLAUDE.md", "a\nb\n", {
      blocks: [{ first: 1, last: 2, id: "x<<<y" }],
    });
    expect(render(item, "none")?.text).toContain('BLOCKS\n 1-2 "x<<\\<y"\n');
  });

  it("counts the BLOCKS section against the limit", () => {
    const item = input("CLAUDE.md", "a\n", { blocks: [{ first: 1, last: 1, id: "paragraph-1" }] });
    const full = render(item, "none");
    expect(full).toBeDefined();
    expect(renderItem(item, "none", (full?.bytes ?? 0) - 1)).toBeUndefined();
  });

  it("maps block byte spans to lines, with a BOM and CRLF", () => {
    const content = new TextEncoder().encode("\uFEFF# A\r\n\r\npara\r\nmore\r\n");
    // Line starts: 3 ("# A"), 8 (""), 10 ("para"), 16 ("more").
    expect(
      blockRanges(content, [
        { blockId: "A/heading", sourceSpan: { start: 3, end: 6 } },
        { blockId: "A/paragraph-1", sourceSpan: { start: 10, end: 20 } },
      ]),
    ).toEqual([
      { first: 1, last: 1, id: "A/heading" },
      { first: 3, last: 4, id: "A/paragraph-1" },
    ]);
    // The fallback block covers the BOM too.
    expect(
      blockRanges(content, [{ blockId: "other-1", sourceSpan: { start: 0, end: 20 } }]),
    ).toEqual([{ first: 1, last: 4, id: "other-1" }]);
  });
});

describe("uncut labels (IMPL §1.7)", () => {
  it("keeps the uncut text of a cut heading label", () => {
    const heading = `## ${"h".repeat(100)}`;
    const content = `# A\n\n${"word ".repeat(200)}\n\n${heading}\n\n${"word ".repeat(200)}\n`;
    const result = render(input("docs/a.md", content), "markdown", 600);
    const entry = result?.outline.find((e) => e.line === 5);
    expect(entry?.label).toBe(`${heading.slice(0, 79)}…`);
    expect(entry?.uncutLabel).toBe(heading);
    expect(result?.text).not.toContain(heading);
  });

  it("keeps the uncut text of a cut declaration label", () => {
    const name = `f${"x".repeat(100)}`;
    const content = `export function ${name}() {\n${"  const value = 1;\n".repeat(80)}}\nexport const b = 1;\n`;
    const result = render(input("src/a.ts", content), "code", 400);
    const entry = result?.outline.find((e) => e.line === 1);
    expect(entry?.uncutLabel).toBe(`export function ${name}`);
  });

  it("has no uncut label when the label was not cut", () => {
    const content = `# A\n\n${"word ".repeat(200)}\n\n## B\n`;
    const result = render(input("docs/a.md", content), "markdown", 400);
    expect(result?.outline.every((e) => e.uncutLabel === undefined)).toBe(true);
  });
});
