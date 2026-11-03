import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import {
  type AssemblyDestination,
  type AssemblyResult,
  type AssemblyRevision,
  type AssemblyTarget,
  assemble,
  type BlockRef,
} from "./assemble.js";

// DM §9.3 Assembly, with the cases of IMPL §3.8 "Selection and assembly".

const fixtures = new URL("../../../test/fixtures/destinations/", import.meta.url);
const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

const present = (text: string | Uint8Array): AssemblyDestination => {
  const bytes = typeof text === "string" ? bytesOf(text) : text;
  return { state: "present", bytes, parsed: parseGuidanceBlocks(bytes) };
};
const fixture = (name: string): AssemblyDestination =>
  present(new Uint8Array(readFileSync(new URL(name, fixtures))));
const absent: AssemblyDestination = { state: "absent" };

const ref = (destination: AssemblyDestination, blockId: string): BlockRef => {
  if (destination.state !== "present") throw new Error("no blocks in an absent destination");
  const block = destination.parsed.blocks.find((b) => b.blockId === blockId);
  if (block === undefined) throw new Error(`no block ${blockId}`);
  return { blockId, blockHash: block.hash };
};

let counter = 0;
const next = () => {
  counter++;
  return { revisionId: `rrev_${counter}`, firstSeq: counter };
};
type Extra = Partial<Pick<AssemblyRevision, "revisionId" | "firstSeq">>;

const revise = (
  d: AssemblyDestination,
  blockId: string,
  content: string,
  extra: Extra = {},
): AssemblyRevision => ({
  ...next(),
  ...extra,
  operation: "revise",
  target: { kind: "block", ...ref(d, blockId) },
  content,
});
const remove = (d: AssemblyDestination, blockId: string, extra: Extra = {}): AssemblyRevision => ({
  ...next(),
  ...extra,
  operation: "remove",
  target: { kind: "block", ...ref(d, blockId) },
});
const add = (target: AssemblyTarget, content: string, extra: Extra = {}): AssemblyRevision => ({
  ...next(),
  ...extra,
  operation: "add",
  target,
  content,
});
const afterBlock = (d: AssemblyDestination, blockId: string): AssemblyTarget => ({
  kind: "after",
  ...ref(d, blockId),
});
const section = (d: AssemblyDestination, blockId: string): AssemblyTarget => ({
  kind: "section",
  ...ref(d, blockId),
});
const newSection = (heading: string, d?: AssemblyDestination, afterId?: string): AssemblyTarget =>
  d === undefined || afterId === undefined
    ? { kind: "newSection", heading }
    : { kind: "newSection", heading, after: ref(d, afterId) };

const ok = (result: AssemblyResult) => {
  if (!result.ok) throw new Error(`assembly failed: ${JSON.stringify(result.failure)}`);
  return result;
};
const out = (result: AssemblyResult): string => textOf(ok(result).content);

describe("start and positions (DM §9.3 steps 1–2)", () => {
  it("assembles into an empty document when the destination is absent", () => {
    expect(out(assemble(absent, [add(newSection("Testing"), "Run the suite.")]))).toBe(
      "## Testing\n\nRun the suite.\n",
    );
  });

  it("returns the original bytes, with no attribution, when nothing is accepted", () => {
    const d = fixture("assembly-sections.md");
    const result = ok(assemble(d, []));
    expect(d.state === "present" && Buffer.from(result.content).equals(d.bytes)).toBe(true);
    expect(result.attribution).toEqual([]);
  });

  it("revises a block in place", () => {
    const d = present("A.\n\nB.\n\nC.\n");
    expect(out(assemble(d, [revise(d, "paragraph-2", "Bee.")]))).toBe("A.\n\nBee.\n\nC.\n");
  });

  it("revises a heading as one line at the same level", () => {
    const d = fixture("assembly-sections.md");
    expect(out(assemble(d, [revise(d, "Guide/Testing/heading", "## Tests")]))).toContain(
      "Detail text.\n\n## Tests\n\nRun the suite.\n",
    );
  });

  it("adds directly after the named block", () => {
    const d = present("A.\n\nB.\n");
    expect(out(assemble(d, [add(afterBlock(d, "paragraph-1"), "X.")]))).toBe("A.\n\nX.\n\nB.\n");
  });

  it("adds to a section after its own blocks, before its first subsection", () => {
    const d = fixture("assembly-sections.md");
    expect(out(assemble(d, [add(section(d, "Guide/Setup/heading"), "Another note.")]))).toContain(
      "- second step\n\nAnother note.\n\n### Details\n",
    );
  });

  it("adds to a section with no own blocks directly after its heading", () => {
    const d = present("# A\n\n## B\n\nText.\n");
    expect(out(assemble(d, [add(section(d, "A/heading"), "New.")]))).toBe(
      "# A\n\nNew.\n\n## B\n\nText.\n",
    );
  });

  it("adds a new section after a heading's whole section, at the heading's level", () => {
    const d = fixture("assembly-sections.md");
    expect(
      out(assemble(d, [add(newSection("Usage", d, "Guide/Setup/heading"), "Text.")])),
    ).toContain("Detail text.\n\n## Usage\n\nText.\n\n## Testing\n");
    expect(
      out(assemble(d, [add(newSection("More", d, "Guide/Setup/Details/heading"), "Text.")])),
    ).toContain("Detail text.\n\n### More\n\nText.\n\n## Testing\n");
  });

  it("uses the setext underline for a heading's level", () => {
    const d = present("Title\n=====\n\nIntro.\n\nPart\n----\n\nBody.\n");
    expect(out(assemble(d, [add(newSection("Next", d, "Title/Part/heading"), "X.")]))).toBe(
      "Title\n=====\n\nIntro.\n\nPart\n----\n\nBody.\n\n## Next\n\nX.\n",
    );
    expect(out(assemble(d, [add(newSection("Top", d, "Title/heading"), "X.")]))).toBe(
      "Title\n=====\n\nIntro.\n\nPart\n----\n\nBody.\n\n# Top\n\nX.\n",
    );
  });

  it("adds a new section without `after` at the end of the file, at level 2", () => {
    const d = fixture("assembly-sections.md");
    expect(out(assemble(d, [add(newSection("  Usage\t"), "Text.")]))).toMatch(
      /Run the suite\.\n\n## Usage\n\nText\.\n$/,
    );
  });
});

describe("removal (DM §9.1 headings, §9.3 step 3)", () => {
  it("removes a heading's whole section, subsections included, as one change", () => {
    const d = fixture("assembly-sections.md");
    const rev = remove(d, "Guide/Setup/heading");
    const result = ok(assemble(d, [rev]));
    expect(textOf(result.content)).toBe(
      "# Guide\n\nIntro paragraph.\n\n## Testing\n\nRun the suite.\n",
    );
    expect(result.attribution).toEqual(
      [
        "Guide/Setup/heading",
        "Guide/Setup/paragraph-1",
        "Guide/Setup/list-item-1",
        "Guide/Setup/list-item-2",
        "Guide/Setup/Details/heading",
        "Guide/Setup/Details/paragraph-1",
      ].map((originalBlockId) => ({
        revisionId: rev.revisionId,
        operation: "remove",
        originalBlockId,
      })),
    );
  });

  it("removes consecutive blocks from several revisions as one run", () => {
    const d = present("A.\n\nB.\n\n\nC.\n\nD.\n");
    expect(out(assemble(d, [remove(d, "paragraph-2"), remove(d, "paragraph-3")]))).toBe(
      "A.\n\nD.\n",
    );
  });

  it("keeps the bytes after the last block when the last blocks are removed", () => {
    const d = present("A.\n\nB.\n\nC.\n\n\n");
    expect(out(assemble(d, [remove(d, "paragraph-2"), remove(d, "paragraph-3")]))).toBe("A.\n\n\n");
  });

  it("keeps only the byte order mark and the trailing bytes when every block is removed", () => {
    const d = present("﻿\n\nA.\n\nB.\n\n");
    expect(out(assemble(d, [remove(d, "paragraph-1"), remove(d, "paragraph-2")]))).toBe("﻿\n\n");
  });

  it("keeps the bytes before the first block when the first block is removed", () => {
    const d = present("﻿\nA.\n\nB.\n");
    expect(out(assemble(d, [remove(d, "paragraph-1")]))).toBe("﻿\nB.\n");
  });
});

describe("additions anchored to removed content (DM §9.3 step 2)", () => {
  it("removing B from A s1 B s2 C and adding X after B gives A s1 X s2 C", () => {
    const d = present("A.\n\nB.\n\n\nC.\n");
    expect(
      out(assemble(d, [remove(d, "paragraph-2"), add(afterBlock(d, "paragraph-2"), "X.")])),
    ).toBe("A.\n\nX.\n\n\nC.\n");
  });

  it("places an addition anchored inside a removed section where the section was", () => {
    const d = fixture("assembly-sections.md");
    const result = assemble(d, [
      remove(d, "Guide/Setup/heading"),
      add(afterBlock(d, "Guide/Setup/list-item-1"), "Kept note."),
    ]);
    expect(out(result)).toBe(
      "# Guide\n\nIntro paragraph.\n\nKept note.\n\n## Testing\n\nRun the suite.\n",
    );
  });

  it("places a section addition and a new section after a removed section where it was", () => {
    const d = fixture("assembly-sections.md");
    const result = assemble(d, [
      remove(d, "Guide/Setup/heading"),
      add(section(d, "Guide/Setup/heading"), "First."),
      add(newSection("Usage", d, "Guide/Setup/heading"), "Second."),
    ]);
    expect(out(result)).toBe(
      "# Guide\n\nIntro paragraph.\n\nFirst.\n\n## Usage\n\nSecond.\n\n## Testing\n\nRun the suite.\n",
    );
  });

  it("places an addition after a removed last block before the trailing bytes", () => {
    const d = present("A.\n\nB.\n");
    expect(
      out(assemble(d, [remove(d, "paragraph-2"), add(afterBlock(d, "paragraph-2"), "X.")])),
    ).toBe("A.\n\nX.\n");
  });
});

describe("order (DM §9.3 step 3)", () => {
  it("orders additions at one position by the seq of their first revision, not their IDs", () => {
    const d = present("A.\n\nB.\n");
    const result = assemble(d, [
      add(afterBlock(d, "paragraph-1"), "Second.", { revisionId: "rrev_a", firstSeq: 20 }),
      add(afterBlock(d, "paragraph-1"), "First.", { revisionId: "rrev_z", firstSeq: 10 }),
    ]);
    expect(out(result)).toBe("A.\n\nFirst.\n\nSecond.\n\nB.\n");
  });

  it("applies a revise of the anchor before the additions after it", () => {
    const d = present("A.\n\nB.\n");
    const result = ok(
      assemble(d, [
        add(afterBlock(d, "paragraph-1"), "X.", { firstSeq: 1 }),
        revise(d, "paragraph-1", "Ay.", { firstSeq: 2 }),
      ]),
    );
    expect(textOf(result.content)).toBe("Ay.\n\nX.\n\nB.\n");
    expect(result.attribution.map((a) => a.operation)).toEqual(["revise", "add"]);
  });

  it("gives the same result whatever order the revisions are passed in", () => {
    const d = fixture("assembly-sections.md");
    const revisions = [
      add(afterBlock(d, "Guide/paragraph-1"), "One."),
      remove(d, "Guide/Setup/list-item-2"),
      add(afterBlock(d, "Guide/paragraph-1"), "Two."),
      revise(d, "Guide/Testing/paragraph-1", "Run every suite."),
    ];
    const forward = ok(assemble(d, revisions));
    const backward = ok(assemble(d, [...revisions].reverse()));
    expect(Buffer.from(backward.content).equals(Buffer.from(forward.content))).toBe(true);
    expect(backward.attribution).toEqual(forward.attribution);
  });
});

describe("separators (DM §9.3 step 4)", () => {
  it("copies the separator after the anchor, so a loose list stays loose", () => {
    const d = fixture("assembly-loose-list.md");
    expect(out(assemble(d, [add(afterBlock(d, "Notes/list-item-1"), "- loose new")]))).toBe(
      "# Notes\n\n- loose one\n\n- loose new\n\n- loose two\n\nClosing paragraph.\n",
    );
  });

  it("copies a tight list's separator, so a tight list stays tight", () => {
    const d = present("- one\n- two\n");
    expect(out(assemble(d, [add(afterBlock(d, "list-item-1"), "- new")]))).toBe(
      "- one\n- new\n- two\n",
    );
  });

  it("uses one blank line at the end of the file", () => {
    const d = present("A.\n");
    expect(out(assemble(d, [add(afterBlock(d, "paragraph-1"), "X.")]))).toBe("A.\n\nX.\n");
  });

  it("uses one line ending between a list item and the list item it follows at the end", () => {
    const d = present("- one\n");
    expect(out(assemble(d, [add(afterBlock(d, "list-item-1"), "- two")]))).toBe("- one\n- two\n");
  });

  it("separates two additions in an absent file by one blank line and ends with one line ending", () => {
    const result = assemble(absent, [add(newSection("One"), "A."), add(newSection("Two"), "B.")]);
    expect(out(result)).toBe("## One\n\nA.\n\n## Two\n\nB.\n");
  });

  it("keeps a present file's bytes after the byte order mark when it has no blocks", () => {
    expect(out(assemble(present(""), [add(newSection("T"), "X.")]))).toBe("## T\n\nX.\n");
    expect(out(assemble(present("\n\n"), [add(newSection("T"), "X.")]))).toBe("## T\n\nX.\n\n");
    expect(out(assemble(present("﻿  \n"), [add(newSection("T"), "X.")]))).toBe("﻿## T\n\nX.\n  \n");
  });

  it("keeps content's own separators between its blocks", () => {
    const d = present("A.\n");
    expect(out(assemble(d, [add(afterBlock(d, "paragraph-1"), "- x\n- y\n\n\nZ.")]))).toBe(
      "A.\n\n- x\n- y\n\n\nZ.\n",
    );
  });

  it("ignores blank lines before the first block and after the last in content", () => {
    const d = present("A.\n");
    expect(out(assemble(d, [add(afterBlock(d, "paragraph-1"), "\n  \nX.\n\n\n")]))).toBe(
      "A.\n\nX.\n",
    );
  });
});

describe("line endings (DM §7, §9.3 step 4)", () => {
  const addEnd = (text: string) => {
    const d = present(text);
    const last = d.state === "present" ? d.parsed.blocks.at(-1)?.blockId : undefined;
    return out(assemble(d, [add(afterBlock(d, last ?? ""), "X.\nY.")]));
  };

  it.each([
    ["lf", "A.\n", "A.\n\nX.\nY.\n"],
    ["crlf", "A.\r\n", "A.\r\n\r\nX.\r\nY.\r\n"],
    ["cr", "A.\r", "A.\r\rX.\rY.\r"],
    ["mixed, most frequent", "A.\r\n\r\nB.\n", "A.\r\n\r\nB.\r\n\r\nX.\r\nY.\n"],
    ["mixed tie, LF first", "A.\r\n\r\nB.\n\n", "A.\r\n\r\nB.\n\nX.\nY.\n\n"],
    ["mixed tie, CRLF before CR", "A.\r\rB.\r\n\r\n", "A.\r\rB.\r\n\r\nX.\r\nY.\r\n\r\n"],
    ["none", "A.", "A.\n\nX.\nY."],
  ])("converts new content to %s", (_style, text, expected) => {
    expect(addEnd(text)).toBe(expected);
  });

  it("converts content and the rendered heading from any line ending", () => {
    const d = present("A.\r\n");
    expect(out(assemble(d, [add(newSection("H"), "X.\nY.\rZ.")]))).toBe(
      "A.\r\n\r\n## H\r\n\r\nX.\r\nY.\r\nZ.\r\n",
    );
  });

  it("keeps the byte order mark and the missing final line ending", () => {
    const d = present("﻿A.\r\nB.");
    expect(out(assemble(d, [revise(d, "paragraph-1", "Ay.\nBee.")]))).toBe("﻿Ay.\r\nBee.");
  });

  it("keeps list markers", () => {
    const d = present("1. one\n2. two\n");
    expect(out(assemble(d, [revise(d, "list-item-2", "2. deux")]))).toBe("1. one\n2. deux\n");
  });
});

describe("attribution (DM §9.4)", () => {
  it("has one entry per change, in file order, with the span of new content", () => {
    const d = present("A.\n\nB.\n\nC.\n");
    const r = revise(d, "paragraph-1", "Ay.");
    const x = add(afterBlock(d, "paragraph-2"), "X.");
    const c = remove(d, "paragraph-3");
    const result = ok(assemble(d, [c, x, r]));
    expect(textOf(result.content)).toBe("Ay.\n\nB.\n\nX.\n");
    expect(result.attribution).toEqual([
      {
        revisionId: r.revisionId,
        operation: "revise",
        originalBlockId: "paragraph-1",
        proposedSpan: { start: 0, end: 3 },
      },
      { revisionId: x.revisionId, operation: "add", proposedSpan: { start: 9, end: 11 } },
      { revisionId: c.revisionId, operation: "remove", originalBlockId: "paragraph-3" },
    ]);
    expect(result.hash).toBe(sha256(result.content));
  });

  it("spans a new section from its heading to the end of its content", () => {
    const result = ok(assemble(absent, [add(newSection("H"), "X.")]));
    expect(result.attribution[0]?.proposedSpan).toEqual({ start: 0, end: 8 });
  });
});

describe("checks (DM §9.3 steps 5–6)", () => {
  it("fails, as an internal error, when a revision alone would merge into its neighbour", () => {
    const d = present("- item\n");
    const rev = add(afterBlock(d, "list-item-1"), "    code");
    const result = assemble(d, [rev]);
    expect(result).toEqual({
      ok: false,
      failure: { kind: "internal_error", check: "reparse", revisionIds: [rev.revisionId] },
    });
  });

  it("fails when a target block's hash doesn't match", () => {
    const d = present("A.\n");
    const rev = revise(d, "paragraph-1", "B.");
    const stale = { ...rev, target: { ...rev.target, blockHash: sha256(bytesOf("other")) } };
    expect(assemble(d, [stale as AssemblyRevision])).toMatchObject({
      ok: false,
      failure: { kind: "internal_error", check: "target", revisionIds: [rev.revisionId] },
    });
  });

  it("fails when a revise changes the block's type", () => {
    const d = present("A.\n");
    expect(assemble(d, [revise(d, "paragraph-1", "- item")])).toMatchObject({
      ok: false,
      failure: { kind: "internal_error", check: "types" },
    });
  });

  it("fails when two accepted revisions change the same block", () => {
    const d = fixture("assembly-sections.md");
    const one = remove(d, "Guide/Setup/heading");
    const two = revise(d, "Guide/Setup/list-item-2", "- other step");
    expect(assemble(d, [one, two])).toEqual({
      ok: false,
      failure: {
        kind: "internal_error",
        check: "one_change_per_block",
        revisionIds: [one.revisionId, two.revisionId],
      },
    });
  });

  it("fails when an operation doesn't fit its target", () => {
    const d = present("A.\n");
    const bad: AssemblyRevision = { ...remove(d, "paragraph-1"), content: "X." };
    expect(assemble(d, [bad])).toMatchObject({
      ok: false,
      failure: { kind: "internal_error", check: "operation" },
    });
  });
});

describe("revisions that can't be combined (DM §9.4)", () => {
  it("reports two additions that pass alone but not together as a conflict naming both", () => {
    const d = present("Paragraph.\n");
    const item = add(afterBlock(d, "paragraph-1"), "- item");
    const code = add(afterBlock(d, "paragraph-1"), "    code");
    expect(assemble(d, [code, item])).toEqual({
      ok: false,
      failure: { kind: "conflict", revisionId: code.revisionId, conflictsWith: item.revisionId },
    });
  });

  it("names the first failing addition of three, with the one it merges into", () => {
    const d = present("Paragraph.\n");
    const para = add(afterBlock(d, "paragraph-1"), "Another.");
    const item = add(afterBlock(d, "paragraph-1"), "- item");
    const code = add(afterBlock(d, "paragraph-1"), "    code");
    const late = add(afterBlock(d, "paragraph-1"), "    more code");
    expect(assemble(d, [late, code, item, para])).toEqual({
      ok: false,
      failure: { kind: "conflict", revisionId: code.revisionId, conflictsWith: item.revisionId },
    });
  });
});

describe("a destination whose round trip failed (DM §7, §9.3 step 6)", () => {
  const failed = (text: string): AssemblyDestination => {
    const bytes = bytesOf(text);
    const parsed = parseGuidanceBlocks(bytes, () => {
      throw new Error("splitter failed");
    });
    return { state: "present", bytes, parsed };
  };

  it("appends a new section after one blank line, keeping the original as a prefix", () => {
    expect(out(assemble(failed("A.\n"), [add(newSection("H"), "X.")]))).toBe("A.\n\n## H\n\nX.\n");
    expect(out(assemble(failed("A."), [add(newSection("H"), "X.")]))).toBe("A.\n\n## H\n\nX.\n");
    expect(out(assemble(failed("A.\r\n"), [add(newSection("H"), "X.")]))).toBe(
      "A.\r\n\r\n## H\r\n\r\nX.\r\n",
    );
  });

  it("attributes the appended section by its span", () => {
    const result = ok(assemble(failed("A.\n"), [add(newSection("H"), "X.")]));
    expect(result.attribution).toEqual([
      { revisionId: expect.any(String), operation: "add", proposedSpan: { start: 4, end: 12 } },
    ]);
  });

  it("allows no other operation", () => {
    const d = failed("A.\n");
    expect(assemble(d, [remove(d, "other-1")])).toMatchObject({
      ok: false,
      failure: { kind: "internal_error", check: "operation" },
    });
  });

  it("fails when the appended bytes don't parse into the new section alone", () => {
    expect(assemble(failed("A.\n"), [add(newSection("H"), "## Inner")])).toMatchObject({
      ok: false,
      failure: { kind: "internal_error", check: "types" },
    });
  });
});

describe("new sections at a shared position (DM §9.3 step 3)", () => {
  it("places an addition to a section before a new section after it, whatever their seq", () => {
    const d = present("# A\n\nx.\n\n# B\n\ny.\n");
    const result = assemble(d, [
      add(newSection("N", d, "A/heading"), "n.", { firstSeq: 1 }),
      add(section(d, "A/heading"), "s.", { firstSeq: 2 }),
    ]);
    expect(out(result)).toBe("# A\n\nx.\n\ns.\n\n# N\n\nn.\n\n# B\n\ny.\n");
  });

  it("places an addition after the last block before a new section at the end", () => {
    const d = present("A.\n\nB.\n");
    const result = assemble(d, [
      add(newSection("N"), "n.", { firstSeq: 1 }),
      add(afterBlock(d, "paragraph-2"), "x.", { firstSeq: 2 }),
    ]);
    expect(out(result)).toBe("A.\n\nB.\n\nx.\n\n## N\n\nn.\n");
  });
});

describe("attribution of a removed run (DM §9.4)", () => {
  it("keeps a removed section's entries together, followed by additions placed where it was", () => {
    const d = present("# A\n\nx.\n\n## S\n\ny.\n\n# B\n");
    const section = remove(d, "A/heading");
    const note = add(afterBlock(d, "A/paragraph-1"), "Note.");
    const result = ok(assemble(d, [note, section]));
    expect(textOf(result.content)).toBe("Note.\n\n# B\n");
    expect(
      result.attribution.map((a) => [a.operation, a.originalBlockId ?? a.proposedSpan]),
    ).toEqual([
      ["remove", "A/heading"],
      ["remove", "A/paragraph-1"],
      ["remove", "A/S/heading"],
      ["remove", "A/S/paragraph-1"],
      ["add", { start: 0, end: 5 }],
    ]);
  });
});

describe("edge cases of removal and placement (DM §9.3 steps 3–4)", () => {
  it("removes the first block and adds after it, keeping the bytes before it", () => {
    const d = present("\n\nA.\n\nB.\n");
    expect(
      out(assemble(d, [remove(d, "paragraph-1"), add(afterBlock(d, "paragraph-1"), "X.")])),
    ).toBe("\n\nX.\n\nB.\n");
  });

  it("adds after a kept block whose following blocks are removed", () => {
    const d = present("A.\n\nB.\n\n\nC.\n");
    expect(
      out(assemble(d, [remove(d, "paragraph-2"), add(afterBlock(d, "paragraph-1"), "X.")])),
    ).toBe("A.\n\nX.\n\nC.\n");
    const end = present("A.\n\nB.\n");
    expect(
      out(assemble(end, [remove(end, "paragraph-2"), add(afterBlock(end, "paragraph-1"), "X.")])),
    ).toBe("A.\n\nX.\n");
  });

  it("keeps a tight list tight when an item is removed and another added", () => {
    const d = present("- a\n- b\n- c\n");
    expect(
      out(assemble(d, [remove(d, "list-item-2"), add(afterBlock(d, "list-item-1"), "- x")])),
    ).toBe("- a\n- x\n- c\n");
  });

  it("removes a section at the end of the file and keeps the trailing bytes", () => {
    const d = present("# A\n\nx.\n\n# B\n\ny.\n\n");
    expect(out(assemble(d, [remove(d, "B/heading")]))).toBe("# A\n\nx.\n\n");
    expect(
      out(assemble(d, [remove(d, "B/heading"), add(newSection("C", d, "B/heading"), "z.")])),
    ).toBe("# A\n\nx.\n\n# C\n\nz.\n\n");
  });
});

describe("checks on the revisions themselves (DM §9.1, §9.3 step 6)", () => {
  it("rejects a heading revised at another level or over two lines", () => {
    const d = present("Title\n=====\n\n## Part\n");
    const types = { ok: false, failure: { kind: "internal_error", check: "types" } };
    expect(assemble(d, [revise(d, "Title/Part/heading", "### Part")])).toMatchObject(types);
    expect(assemble(d, [revise(d, "Title/heading", "New\n===")])).toMatchObject(types);
    expect(out(assemble(d, [revise(d, "Title/heading", "# New")]))).toBe("# New\n\n## Part\n");
  });

  it("fails when a heading is both removed and revised", () => {
    const d = fixture("assembly-sections.md");
    const gone = remove(d, "Guide/Setup/heading");
    const renamed = revise(d, "Guide/Setup/heading", "## Install");
    expect(assemble(d, [renamed, gone])).toMatchObject({
      ok: false,
      failure: { kind: "internal_error", check: "one_change_per_block" },
    });
  });

  it("fails when two revisions share a revision ID", () => {
    const d = present("A.\n");
    const one = add(afterBlock(d, "paragraph-1"), "X.");
    const two = add(afterBlock(d, "paragraph-1"), "Y.", { revisionId: one.revisionId });
    expect(assemble(d, [one, two])).toEqual({
      ok: false,
      failure: {
        kind: "internal_error",
        check: "duplicate_revision",
        revisionIds: [one.revisionId],
      },
    });
  });
});

describe("a failed round trip, further cases (DM §9.3 step 6)", () => {
  const failed = (text: string): AssemblyDestination => {
    const bytes = bytesOf(text);
    const parsed = parseGuidanceBlocks(bytes, () => {
      throw new Error("splitter failed");
    });
    return { state: "present", bytes, parsed };
  };

  it("keeps the blank line when the file ends in a lone CR and new content uses LF", () => {
    expect(out(assemble(failed("A.\nB.\nC.\r"), [add(newSection("N"), "n.")]))).toBe(
      "A.\nB.\nC.\r\n\n## N\n\nn.\n",
    );
  });

  it("reports sections that pass alone but swallow each other when appended as a conflict", () => {
    const fence = add(newSection("One"), "```\ncode");
    const next = add(newSection("Two"), "Text.");
    expect(assemble(failed("A.\n"), [fence, next])).toEqual({
      ok: false,
      failure: { kind: "conflict", revisionId: next.revisionId, conflictsWith: fence.revisionId },
    });
  });
});
