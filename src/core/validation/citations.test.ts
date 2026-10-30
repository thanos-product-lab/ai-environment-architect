import { describe, expect, it } from "vitest";
import { MemoryFs } from "../../../test/support/memory-fs.js";
import { renderItem } from "../context/item.js";
import { DEFAULT_CONTEXT_SETTINGS, type TierMembership } from "../context/tiers.js";
import { type Hash, sha256 } from "../hash.js";
import { createAliasTable } from "./aliases.js";
import {
  type CitableItem,
  type Citation,
  type CitationContext,
  type Cited,
  citableItem,
  citationCheck,
  readCurrentHashes,
  unstablePaths,
  validateCitation,
} from "./citations.js";
import type { ValidationEvent } from "./pipeline.js";

/** No packages or imports: basis comes from the path's own tier (§3.2.4). */
const MEMBERSHIP: TierMembership = {
  packages: [""],
  imports: [],
  sourceExtensions: DEFAULT_CONTEXT_SETTINGS.sourceExtensions,
};

// Citations and provenance (IMPL §3.2.2): the quote exists, at the stated place, in content that
// was actually sent in this call.

const SNAPSHOT: Hash = "sha256:1111";
const CHANGED: Hash = "sha256:2222";

/** An item whose sent lines are the given runs; every other line up to `totalLines` is unsent. */
function item(sent: CitableItem["sent"], overrides: Partial<CitableItem> = {}): CitableItem {
  return {
    path: "src/client.ts",
    snapshotHash: SNAPSHOT,
    currentHash: SNAPSHOT,
    basis: "code_observation",
    totalLines: 100,
    sent,
    ...overrides,
  };
}

const CLIENT = item([
  {
    first: 1,
    lines: [
      'import { createClient } from "./generated";',
      'import { withRetry } from "./retry";',
      "",
    ],
  },
  {
    first: 40,
    lines: [
      "export async function request<T>(url: string) {",
      "  const client = createClient();",
      "  return withRetry(() => client.get<T>(url));",
      "}",
    ],
  },
]);

const ITEMS: Record<string, CitableItem> = {
  "T5-007": CLIENT,
  "T2-001": item(
    [
      {
        first: 1,
        lines: [
          "# Contributing",
          "",
          "Run the linter before every commit.",
          "Run the linter before every commit.",
          "aaaaaaaaaaaaaaa",
        ],
      },
    ],
    { path: "CONTRIBUTING.md", basis: "documentation", totalLines: 5 },
  ),
  "T5-002": item([], { path: "src/outline-only.ts", totalLines: 300 }),
  "T5-005": item(
    [{ first: 1, lines: Array.from({ length: 60 }, (_, k) => `line ${k + 1} of the long file`) }],
    { path: "src/long.ts", totalLines: 60 },
  ),
  "T5-003": item([{ first: 1, lines: ["export const answer = 42; // fine"] }], {
    path: "src/changed.ts",
    currentHash: CHANGED,
    totalLines: 1,
  }),
  "T5-004": item([{ first: 1, lines: ["export const gone = 'away for good';"] }], {
    path: "src/gone.ts",
    currentHash: undefined,
    totalLines: 1,
  }),
  "T3-001": item([{ first: 1, lines: ["shift <<< left >>> right", "x <<\\< y"] }], {
    path: "Makefile",
    totalLines: 2,
  }),
  "E-1": item([{ first: 20, lines: ["export function withRetry(fn) {", "  return fn();", "}"] }], {
    path: "src/retry.ts",
    totalLines: 30,
  }),
};

const context: CitationContext = {
  aliases: createAliasTable("analyse_expansion", {
    items: Object.keys(ITEMS),
    findings: ["find_1"],
  }),
  items: new Map(Object.entries(ITEMS)),
};

const NO_KEYS: ReadonlySet<string> = new Set();

function cite(itemAlias: string, lines: string, quote: string) {
  return validateCitation({ item: itemAlias, lines, quote }, context, NO_KEYS);
}

function ruleOf(result: ReturnType<typeof cite>): string {
  return result.ok ? (result.correction === undefined ? "accepted" : "CIT-R01") : result.rule;
}

describe("quote rules (CIT-007)", () => {
  it("CIT-007 rejects a quote shorter than 12 code points", () => {
    expect(ruleOf(cite("T5-007", "41-41", "createClient"))).toBe("accepted");
    expect(ruleOf(cite("T5-007", "41-41", "reateClient"))).toBe("CIT-007");
  });

  it("CIT-007 counts code points, not UTF-16 units or bytes", () => {
    const emoji = item([{ first: 1, lines: ["say 🎉🎉🎉🎉🎉🎉 now"] }], { totalLines: 1 });
    const local: CitationContext = {
      aliases: createAliasTable("analyse", { items: ["T5-001"] }),
      items: new Map([["T5-001", emoji]]),
    };
    // 11 code points but 17 UTF-16 units.
    const short = validateCitation(
      { item: "T5-001", lines: "1-1", quote: "say 🎉🎉🎉🎉🎉🎉 " },
      local,
      NO_KEYS,
    );
    expect(short.ok ? "accepted" : short.rule).toBe("CIT-007");
    const twelve = validateCitation(
      { item: "T5-001", lines: "1-1", quote: "say 🎉🎉🎉🎉🎉🎉 n" },
      local,
      NO_KEYS,
    );
    expect(twelve.ok).toBe(true);
  });

  it("CIT-007 rejects a quote of only whitespace, punctuation and symbols", () => {
    const symbols = item([{ first: 1, lines: ["  => {} (); || -- ;;"] }], { totalLines: 1 });
    const local: CitationContext = {
      aliases: createAliasTable("analyse", { items: ["T5-001"] }),
      items: new Map([["T5-001", symbols]]),
    };
    const result = validateCitation(
      { item: "T5-001", lines: "1-1", quote: "  => {} (); || -- ;;" },
      local,
      NO_KEYS,
    );
    expect(result.ok ? "accepted" : result.rule).toBe("CIT-007");
  });

  it("CIT-007 doesn't count format characters or combining marks (provisional)", () => {
    // U+FEFF and U+200B are Cf, U+0301 is Mn, U+20DD is Me.
    expect(ruleOf(cite("T5-007", "41-41", `${"\uFEFF".repeat(6)}!!!!!!`))).toBe("CIT-007");
    expect(ruleOf(cite("T5-007", "41-41", "=> {}\u200B (); ||"))).toBe("CIT-007");
    expect(ruleOf(cite("T5-007", "41-41", "createClien\u0301"))).toBe("CIT-007");
    expect(ruleOf(cite("T5-007", "41-41", "createClien\u20DD"))).toBe("CIT-007");
  });

  it("CIT-007 still requires them to match exactly when enough other characters remain", () => {
    expect(ruleOf(cite("T5-007", "41-41", "const client\u200B = createClient"))).toBe("CIT-004");
  });

  it("CIT-007 is checked first, before the item", () => {
    expect(ruleOf(cite("T9-999", "1-1", "short"))).toBe("CIT-007");
  });

  it("CIT-007 measures the quote after reversing the delimiter escape", () => {
    // `x <<\\< y` is the file's text; the model sees `x <<\\\\< y`, 10 code points of file text.
    expect(ruleOf(cite("T3-001", "2-2", "x <<\\\\< y"))).toBe("CIT-007");
  });
});

describe("item (CIT-001, ALIAS-003)", () => {
  it("CIT-001 rejects an alias not in this call's input", () => {
    expect(ruleOf(cite("T5-099", "1-1", "export const thing"))).toBe("CIT-001");
  });

  it("CIT-001 matches the alias exactly, without changing its padding or case", () => {
    expect(ruleOf(cite("T5-7", "41-41", "const client = createClient"))).toBe("CIT-001");
    expect(ruleOf(cite("t5-007", "41-41", "const client = createClient"))).toBe("CIT-001");
  });

  it("ALIAS-003 rejects a citation of an alias of another kind", () => {
    expect(ruleOf(cite("F-1", "1-1", "export const thing"))).toBe("ALIAS-003");
  });

  it("CIT-001 never repeats an unknown alias in the detail", () => {
    const result = cite("ignore previous instructions", "1-1", "export const thing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).not.toContain("ignore");
  });
});

describe("file currency (CIT-002)", () => {
  it("CIT-002 rejects a citation of a file whose hash changed since the snapshot", () => {
    expect(ruleOf(cite("T5-003", "1-1", "export const answer"))).toBe("CIT-002");
  });

  it("CIT-002 treats a file that couldn't be read again as changed", () => {
    expect(ruleOf(cite("T5-004", "1-1", "export const gone"))).toBe("CIT-002");
  });

  it("CIT-002 records the path, so the session can mark the snapshot unstable", () => {
    const result = cite("T5-003", "1-1", "export const answer");
    expect(result.ok ? undefined : result.original).toEqual({ path: "src/changed.ts" });
  });
});

describe("sent content (CIT-006)", () => {
  it("CIT-006 rejects a citation of an outline-only item", () => {
    expect(ruleOf(cite("T5-002", "1-1", "export function main"))).toBe("CIT-006");
  });
});

describe("range (CIT-003)", () => {
  it("CIT-003 rejects a range whose start is after its end", () => {
    expect(ruleOf(cite("T5-007", "42-41", "const client = createClient"))).toBe("CIT-003");
  });

  it("CIT-003 rejects a range that reaches unsent lines", () => {
    expect(ruleOf(cite("T5-007", "40-44", "const client = createClient"))).toBe("CIT-003");
    expect(ruleOf(cite("T5-007", "3-40", "const client = createClient"))).toBe("CIT-003");
    expect(ruleOf(cite("T5-007", "500-501", "const client = createClient"))).toBe("CIT-003");
  });

  it("CIT-003 rejects a range with an absurdly large line number", () => {
    expect(ruleOf(cite("T5-007", "41-99999999999999999999", "const client"))).toBe("CIT-003");
  });
});

describe("quote in range", () => {
  it("accepts a quote within the cited lines unchanged", () => {
    const result = cite("T5-007", "40-43", "const client = createClient();");
    expect(result).toEqual({
      ok: true,
      citation: { item: "T5-007", lines: "40-43", quote: "const client = createClient();" },
      evidence: {
        path: "src/client.ts",
        fileHash: SNAPSHOT,
        lineStart: 40,
        lineEnd: 43,
        basis: "code_observation",
        excerpt: [
          "export async function request<T>(url: string) {",
          "  const client = createClient();",
          "  return withRetry(() => client.get<T>(url));",
          "}",
        ].join("\n"),
      },
    });
  });

  it("accepts a quote spanning lines with \\n", () => {
    expect(ruleOf(cite("T5-007", "41-42", "createClient();\n  return withRetry"))).toBe("accepted");
  });

  it("matches the file's text once the quote's delimiter escape is reversed", () => {
    expect(ruleOf(cite("T3-001", "1-1", "shift <<\\< left >>\\> right"))).toBe("accepted");
    expect(ruleOf(cite("T3-001", "2-2", "x <<\\\\< y and"))).toBe("CIT-004");
  });

  it("accepts an E item like a T item", () => {
    expect(ruleOf(cite("E-1", "20-21", "withRetry(fn) {\n  return fn();"))).toBe("accepted");
  });
});

describe("range length (CIT-010, provisional)", () => {
  it("CIT-010 accepts a final range of 40 lines", () => {
    const result = cite("T5-005", "1-40", "line 40 of the long file");
    expect(result).toMatchObject({ ok: true, evidence: { lineStart: 1, lineEnd: 40 } });
    expect(result.ok && result.evidence.excerpt.split("\n")).toHaveLength(40);
  });

  it("CIT-010 rejects a final range of 41 lines, and never truncates it", () => {
    expect(ruleOf(cite("T5-005", "1-41", "line 41 of the long file"))).toBe("CIT-010");
  });

  it("CIT-010 checks the range after correction", () => {
    // The cited range is long and misses the quote; the corrected range is one line.
    expect(cite("T5-005", "1-50", "line 55 of the long file")).toMatchObject({
      ok: true,
      correction: { originalLines: "1-50", correctedLines: "55-55" },
    });
  });

  // A quote from the end of line 10 to the end of line `last`, cited at the wrong line.
  const spanning = (last: number) =>
    Array.from({ length: last - 9 }, (_, k) => `line ${k + 10} of the long file`)
      .join("\n")
      .slice("line 10 ".length);

  it("CIT-010 accepts a correction onto 40 lines", () => {
    expect(cite("T5-005", "1-1", spanning(49))).toMatchObject({
      ok: true,
      correction: { originalLines: "1-1", correctedLines: "10-49" },
    });
  });

  it("CIT-010 rejects a correction onto 41 lines", () => {
    expect(ruleOf(cite("T5-005", "1-1", spanning(50)))).toBe("CIT-010");
  });
});

describe("line-range correction (CIT-R01, CIT-004, CIT-005)", () => {
  it("CIT-R01 corrects a shifted range to the lines of the quote's only occurrence", () => {
    const result = cite("T5-007", "1-2", "return withRetry(() => client");
    expect(result).toMatchObject({
      ok: true,
      citation: { item: "T5-007", lines: "42-42", quote: "return withRetry(() => client" },
      correction: { originalLines: "1-2", correctedLines: "42-42" },
      evidence: {
        lineStart: 42,
        lineEnd: 42,
        excerpt: "  return withRetry(() => client.get<T>(url));",
      },
    });
  });

  it("CIT-R01 corrects to every line a multi-line occurrence spans", () => {
    const result = cite("T5-007", "1-1", "createClient();\n  return");
    expect(result.ok && result.correction).toEqual({
      originalLines: "1-1",
      correctedLines: "41-42",
    });
  });

  it("CIT-R01 includes the line a quote's final or first line break leads into", () => {
    expect(cite("T5-007", "1-1", "  return withRetry(() => client.get<T>(url));\n")).toMatchObject({
      ok: true,
      correction: { correctedLines: "42-43" },
      evidence: { excerpt: "  return withRetry(() => client.get<T>(url));\n}" },
    });
    expect(cite("T5-007", "1-1", "\n  const client = createClient();")).toMatchObject({
      ok: true,
      correction: { correctedLines: "40-41" },
    });
  });

  it("CIT-004 rejects a quote that occurs nowhere in the item's sent lines", () => {
    expect(ruleOf(cite("T5-007", "41-41", "const client = createclient"))).toBe("CIT-004");
    expect(ruleOf(cite("T5-007", "41-41", "const  client = createClient"))).toBe("CIT-004");
  });

  it("CIT-004 never searches across the omitted lines between two included ranges", () => {
    // Lines 3 and 40 are both sent, but they aren't next to each other in the file.
    expect(ruleOf(cite("T5-007", "40-40", '"./retry";\n\nexport async'))).toBe("CIT-004");
  });

  it("CIT-004 rejects a quote holding half of a character", () => {
    const emoji = item([{ first: 1, lines: ["const party = '😀 time for tests';"] }], {
      totalLines: 1,
    });
    const local: CitationContext = {
      aliases: createAliasTable("analyse", { items: ["T5-001"] }),
      items: new Map([["T5-001", emoji]]),
    };
    const half = validateCitation(
      { item: "T5-001", lines: "1-1", quote: "\uDE00 time for tests" },
      local,
      NO_KEYS,
    );
    expect(half.ok ? "accepted" : half.rule).toBe("CIT-004");
  });

  it("CIT-004 never searches another item", () => {
    expect(ruleOf(cite("T5-007", "1-1", "Run the linter before"))).toBe("CIT-004");
  });

  it("CIT-005 rejects a quote that occurs twice", () => {
    expect(ruleOf(cite("T2-001", "1-1", "Run the linter before"))).toBe("CIT-005");
  });

  it("CIT-005 counts overlapping occurrences separately", () => {
    expect(ruleOf(cite("T2-001", "1-1", "aaaaaaaaaaaaa"))).toBe("CIT-005");
  });

  it("accepts a repeated quote when the cited range holds one of its occurrences", () => {
    expect(ruleOf(cite("T2-001", "4-4", "Run the linter before"))).toBe("accepted");
  });
});

describe("citableItem", () => {
  const text = [
    "import { a } from './a';",
    "",
    "export function one() {",
    "  return 1;",
    "}",
    "export function two() {",
    `  return 'a long body that will not fit in the cap ${"x".repeat(300)}';`,
    "}",
  ].join("\r\n");
  const content = new TextEncoder().encode(text);
  const input = {
    id: "T5-001",
    path: "src/one.ts",
    hash: sha256(content),
    tier: 5,
    reason: "tier5:rank1:entry-name",
    content,
  };

  it("derives its basis from the file's tier, never from the caller (§3.2.4)", () => {
    const full = renderItem(input, "code", 1_000_000);
    if (full === undefined) throw new Error("no rendering");
    const basisAt = (path: string, membership = MEMBERSHIP) =>
      citableItem({ ...input, path }, full, membership, input.hash).basis;
    expect(basisAt("src/one.ts")).toBe("code_observation");
    expect(basisAt("docs/one.md")).toBe("documentation");
    expect(basisAt(".claude/one.md")).toBe("existing_guidance");
    expect(basisAt("notes/one.txt")).toBe("code_observation");
    expect(basisAt("notes/one.txt", { ...MEMBERSHIP, imports: ["notes/one.txt"] })).toBe(
      "existing_guidance",
    );
  });

  it("keeps only the sent lines, as runs, whatever the line endings", () => {
    const full = renderItem(input, "code", 1_000_000);
    if (full === undefined) throw new Error("expected a rendering");
    const all = citableItem(input, full, MEMBERSHIP, input.hash);
    expect(all.sent).toEqual([{ first: 1, lines: text.split("\r\n") }]);
    expect(all.totalLines).toBe(8);
  });

  it("leaves unsent lines out of the item entirely", () => {
    const excerpt = renderItem(input, "code", (renderItem(input, "code", 1e6)?.bytes ?? 0) - 200);
    if (excerpt === undefined) throw new Error("expected an excerpt");
    const cited = citableItem(input, excerpt, MEMBERSHIP, input.hash);
    const sentLines = cited.sent.flatMap((run) => run.lines);
    expect(excerpt.included.length).toBeGreaterThan(0);
    expect(sentLines.join("\n")).not.toContain("a long body");
    expect(cited.sent.map((run) => [run.first, run.first + run.lines.length - 1])).toEqual(
      excerpt.included.map((range) => [range.first, range.last]),
    );
  });
});

describe("readCurrentHashes", () => {
  it("hashes each path again, and gives undefined for one that can't be read", async () => {
    const fs = new MemoryFs({
      "a.ts": "one",
      "b.ts": { kind: "unreadable_file", reason: "permission_denied" },
    });
    const hashes = await readCurrentHashes(fs, ["b.ts", "a.ts", "missing.ts", "a.ts"]);
    expect([...hashes.entries()]).toEqual([
      ["a.ts", sha256(new TextEncoder().encode("one"))],
      ["b.ts", undefined],
      ["missing.ts", undefined],
    ]);
  });
});

type Finding = Cited & { readonly key: string };

function check(citations: Citation[]) {
  const run = citationCheck<Finding, CitationContext>();
  return run({ key: "f1", citations }, context, { localKeys: new Set(["f1"]) });
}

describe("duplicate citations (CIT-009)", () => {
  const first = { item: "T5-007", lines: "41-41", quote: "const client = createClient" };

  it("CIT-009 keeps the first of two citations of the same path and final range", () => {
    const sameRangeOtherQuote = {
      item: "T5-007",
      lines: "41-41",
      quote: "client = createClient();",
    };
    const correctedOntoIt = { item: "T5-007", lines: "1-1", quote: "  const client = create" };
    const result = check([first, sameRangeOtherQuote, correctedOntoIt]);
    expect(result).toMatchObject({
      kind: "accept",
      value: { citations: [first], droppedCitations: 2 },
      events: [
        { subKey: "citations/1", rule: "CIT-009", outcome: "rejected" },
        { subKey: "citations/2", rule: "CIT-R01", outcome: "corrected" },
        { subKey: "citations/2", rule: "CIT-009", outcome: "rejected" },
      ],
    });
  });

  it("CIT-009 keeps overlapping but different ranges", () => {
    const overlapping = { item: "T5-007", lines: "40-41", quote: "const client = createClient" };
    const result = check([first, overlapping]);
    expect(result).toMatchObject({ kind: "accept", value: { droppedCitations: 0 } });
    expect(result.kind === "accept" && result.value.citations).toHaveLength(2);
  });

  it("CIT-009 compares paths, so an expansion item re-reading the same lines is a duplicate", () => {
    const sameFile = item([{ first: 41, lines: ["  const client = createClient();"] }]);
    const local: CitationContext = {
      aliases: createAliasTable("analyse_expansion", { items: ["T5-007", "E-1"] }),
      items: new Map([
        ["T5-007", CLIENT],
        ["E-1", sameFile],
      ]),
    };
    const result = citationCheck<Finding, CitationContext>()(
      { key: "f1", citations: [first, { ...first, item: "E-1" }] },
      local,
      { localKeys: new Set(["f1"]) },
    );
    expect(result).toMatchObject({
      kind: "accept",
      events: [{ subKey: "citations/1", rule: "CIT-009" }],
    });
  });
});

describe("citationCheck on a finding", () => {
  const good = { item: "T5-007", lines: "41-41", quote: "const client = createClient" };
  const shifted = { item: "T5-007", lines: "1-1", quote: "return withRetry(() => client" };
  const bad = { item: "T5-007", lines: "41-41", quote: "not in the file at all" };

  it("drops only the failed citations, and records how many were dropped", () => {
    const result = check([bad, good, shifted, { ...bad, item: "T5-099" }]);
    expect(result.kind).toBe("accept");
    if (result.kind !== "accept") return;
    expect(result.value.citations).toEqual([good, { ...shifted, lines: "42-42" }]);
    expect(result.value.evidence?.map((e) => [e.lineStart, e.lineEnd])).toEqual([
      [41, 41],
      [42, 42],
    ]);
    expect(result.value.droppedCitations).toBe(2);
    expect(result.events).toEqual([
      expect.objectContaining({ subKey: "citations/0", rule: "CIT-004", outcome: "rejected" }),
      {
        subKey: "citations/2",
        rule: "CIT-R01",
        outcome: "corrected",
        detail: expect.any(String),
        original: { originalLines: "1-1", correctedLines: "42-42" },
      },
      expect.objectContaining({ subKey: "citations/3", rule: "CIT-001", outcome: "rejected" }),
    ]);
  });

  it("records zero dropped citations when all pass", () => {
    const result = check([good]);
    expect(result.kind === "accept" && result.value.droppedCitations).toBe(0);
  });

  it("CIT-008 rejects the finding when no citation is left, after the citations' events", () => {
    const result = check([bad, { ...bad, item: "F-1" }]);
    expect(result).toMatchObject({
      kind: "reject",
      rule: "CIT-008",
      events: [
        { subKey: "citations/0", rule: "CIT-004" },
        { subKey: "citations/1", rule: "ALIAS-003" },
      ],
    });
  });

  it("ALIAS-003 names a well-formed local key, not an item", () => {
    const run = citationCheck<Finding, CitationContext>();
    const result = run({ key: "f1", citations: [{ ...good, item: "f2" }] }, context, {
      localKeys: new Set(["f1", "f2"]),
    });
    expect(result).toMatchObject({ kind: "reject", events: [{ rule: "ALIAS-003" }] });
  });
});

describe("unstablePaths", () => {
  it("lists the paths of CIT-002 events once each, in bytewise order", () => {
    const event = (rule: string, original?: unknown): ValidationEvent => ({
      itemKey: "f1/citations/0",
      stage: "item",
      rule,
      outcome: "rejected",
      detail: "",
      ...(original === undefined ? {} : { original }),
    });
    expect(
      unstablePaths([
        event("CIT-002", { path: "src/b.ts" }),
        event("CIT-004"),
        event("CIT-002", { path: "Z.ts" }),
        event("CIT-002", { path: "src/b.ts" }),
      ]),
    ).toEqual(["Z.ts", "src/b.ts"]);
  });
});
