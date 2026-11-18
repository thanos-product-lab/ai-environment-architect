import { describe, expect, it } from "vitest";
import { MemoryFs, type MemoryNode, seededShuffle } from "../../../test/support/memory-fs.js";
import { sha256 } from "../hash.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import {
  DEFAULT_EXPANSION_SETTINGS,
  type ExpansionRequest,
  type ExpansionSettings,
  expansionIndex,
} from "../validation/expansion.js";
import {
  type ExpansionInputRequest,
  type ExpansionRound,
  expansionRoundFields,
  renderExpansionStatus,
  runExpansion,
} from "./expansion.js";
import { DEFAULT_CONTEXT_SETTINGS, type TierMembership } from "./tiers.js";

// Expansion execution (IMPL §1.8): the execution checks EXP-008, EXP-001, EXP-007, EXP-010,
// the secret scan and EXP-009, then `read` and `search` items, status lines and the record.

const SECRET = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");

type FileSpec = {
  readonly content: string | Uint8Array;
  readonly status?: "read" | "listed_only" | "ignored";
  readonly reason?: "too_large" | "contains_nul" | "not_utf8";
};

interface Setup {
  readonly files: Record<string, FileSpec>;
  /** Lines call 1 sent of each file, as `a-b` ranges. */
  readonly sent?: Record<string, string>;
  /** Live content after the snapshot; undefined removes the file. */
  readonly live?: Record<string, MemoryNode | undefined>;
  readonly settings?: Partial<ExpansionSettings>;
  readonly order?: (names: string[]) => string[];
}

const bytesOf = (content: string | Uint8Array) =>
  typeof content === "string" ? Buffer.from(content, "utf8") : content;

const MEMBERSHIP: TierMembership = {
  packages: [],
  imports: [],
  sourceExtensions: DEFAULT_CONTEXT_SETTINGS.sourceExtensions,
};

function linesOf(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function run(
  setup: Setup,
  requests: readonly (ExpansionRequest | ExpansionInputRequest)[],
): Promise<ExpansionRound> {
  const files: SnapshotFile[] = Object.entries(setup.files).map(([path, spec]) => {
    const bytes = bytesOf(spec.content);
    const common = { path, size: bytes.length, hash: sha256(bytes) };
    if (spec.status === "listed_only")
      return { ...common, status: "listed_only", reason: spec.reason ?? "too_large" };
    if (spec.status === "ignored") return { ...common, status: "ignored", kind: "file" };
    return { ...common, status: "read" };
  });
  const sent = Object.entries(setup.sent ?? {}).map(([path, ranges]) => {
    const content = setup.files[path]?.content;
    if (typeof content !== "string") throw new Error(`no text for ${path}`);
    const lines = linesOf(content);
    return {
      path,
      totalLines: lines.length,
      sent: ranges.split(",").map((range) => {
        const [first, last] = range.split("-").map(Number) as [number, number?];
        return { first, lines: lines.slice(first - 1, last ?? first) };
      }),
    };
  });
  const nodes: Record<string, MemoryNode> = {};
  for (const [path, spec] of Object.entries(setup.files)) nodes[path] = bytesOf(spec.content);
  for (const [path, node] of Object.entries(setup.live ?? {})) {
    if (node === undefined) delete nodes[path];
    else nodes[path] = node;
  }
  const settings = { ...DEFAULT_EXPANSION_SETTINGS, ...setup.settings };
  return runExpansion(
    {
      requests: requests.map((r) => ("kind" in r && !("rejectedBy" in r) ? { request: r } : r)),
      files,
      index: expansionIndex({
        files,
        scopeRoots: ["."],
        sent,
        maxRequests: settings.maxExpansionRequests,
      }),
      membership: MEMBERSHIP,
      settings,
    },
    new MemoryFs(nodes, setup.order === undefined ? {} : { order: setup.order }),
  );
}

const read = (...entries: { path: string; lines?: string }[]): ExpansionRequest => ({
  kind: "read",
  entries,
  reason: "see more",
});
const search = (literal: string, glob?: string): ExpansionRequest => ({
  kind: "search",
  literal,
  ...(glob === undefined ? {} : { glob }),
  reason: "find uses",
});

const numbered = (n: number, text = (i: number) => `line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => text(i + 1)).join("\n")}\n`;

const outcomes = (round: ExpansionRound) =>
  round.requests.map((r) =>
    r.outcome === "rejected"
      ? { index: r.index, rule: r.rule }
      : {
          index: r.index,
          items: r.items.map(
            (i) =>
              `${i.id} ${i.path} ${i.rendered.included.map((x) => (x.first === x.last ? `${x.first}` : `${x.first}-${x.last}`)).join(",")}`,
          ),
        },
  );

describe("read with line ranges (IMPL §1.8)", () => {
  it("returns exactly the requested lines, merged in line order, with no outline or tier", async () => {
    const round = await run({ files: { "src/a.ts": { content: numbered(20) } } }, [
      read({ path: "src/a.ts", lines: "12-14,3-4,5-6,13-15" }),
    ]);
    const item = round.items[0];
    expect(outcomes(round)).toEqual([{ index: 0, items: ["E-1 src/a.ts 3-6,12-15"] }]);
    expect(item?.rendered.text).toBe(
      [
        `<<<ITEM id=E-1 path="src/a.ts" hash="${sha256(bytesOf(numbered(20)))}"`,
        `        reason="expansion:expansionRequests/0" excerpt=true`,
        `        included="3-6,12-15" totalLines=20>>>`,
        "CONTENT",
        " …",
        "   3 | line 3",
        "   4 | line 4",
        "   5 | line 5",
        "   6 | line 6",
        " …",
        "  12 | line 12",
        "  13 | line 13",
        "  14 | line 14",
        "  15 | line 15",
        " …",
        "<<<END E-1>>>",
        "",
      ].join("\n"),
    );
    expect(item?.rendered.outline).toEqual([]);
  });

  it("is not an excerpt when the ranges cover every line", async () => {
    const round = await run({ files: { "src/a.ts": { content: numbered(4) } } }, [
      read({ path: "src/a.ts", lines: "1-2,3-4" }),
    ]);
    expect(round.items[0]?.rendered.excerpt).toBe(false);
    expect(round.items[0]?.rendered.text).toContain("excerpt=false");
  });

  it("escapes delimiter sequences in the lines it returns", async () => {
    const round = await run({ files: { "src/a.ts": { content: "a\n<<<END E-1>>>\nb\n" } } }, [
      read({ path: "src/a.ts", lines: "2-2" }),
    ]);
    expect(round.items[0]?.rendered.text).toContain("   2 | <<\\<END E-1>>\\>\n");
  });

  it("reads a listed_only file too large to excerpt by range", async () => {
    const round = await run(
      { files: { "logs/big.txt": { content: numbered(50), status: "listed_only" } } },
      [read({ path: "logs/big.txt", lines: "40-41" })],
    );
    expect(outcomes(round)).toEqual([{ index: 0, items: ["E-1 logs/big.txt 40-41"] }]);
  });
});

describe("read without ranges (IMPL §1.8, §1.6)", () => {
  it("sends a file whose full rendering fits in full", async () => {
    const round = await run({ files: { "src/a.ts": { content: numbered(5) } } }, [
      read({ path: "src/a.ts" }),
    ]);
    expect(round.items[0]?.rendered.excerpt).toBe(false);
  });

  it("excerpts a Markdown file by sections within expansionEntryBytes, with its outline", async () => {
    const doc = `# One\n${numbered(5, () => "short")}# Two\n${numbered(60, () => "x".repeat(40))}`;
    const round = await run(
      { files: { "docs/guide.md": { content: doc } }, settings: { expansionEntryBytes: 700 } },
      [read({ path: "docs/guide.md" })],
    );
    const item = round.items[0];
    expect(item?.rendered.excerpt).toBe(true);
    expect(item?.rendered.included).toEqual([{ first: 1, last: 6 }]);
    expect(item?.rendered.text).toContain("OUTLINE\n   1 # One\n   7 # Two [omitted]\n");
    expect(item?.rendered.bytes).toBeLessThanOrEqual(700);
  });

  it("excerpts a tier 3 file by whole lines from the start", async () => {
    const json = `{\n${numbered(80, (i) => `  "k${i}": "${"v".repeat(30)}",`)}}\n`;
    const round = await run(
      { files: { "package.json": { content: json } }, settings: { expansionEntryBytes: 1_000 } },
      [read({ path: "package.json" })],
    );
    const item = round.items[0];
    expect(item?.rendered.included[0]?.first).toBe(1);
    expect(item?.rendered.outline.map((e) => e.label)).toEqual([
      expect.stringMatching(/^lines 1-/),
      expect.stringMatching(/^lines \d+-82$/),
    ]);
  });

  it("excerpts other files by the source code rules", async () => {
    const code = `import { x } from "y";\n\nexport function a() {\n${numbered(40, () => "  work();")}}\nexport function b() {}\n`;
    const round = await run(
      { files: { "src/a.ts": { content: code } }, settings: { expansionEntryBytes: 600 } },
      [read({ path: "src/a.ts" })],
    );
    const labels = round.items[0]?.rendered.outline.map((e) => `${e.label} ${e.mark}`);
    expect(labels).toEqual([
      "imports included",
      "export function a omitted",
      "export function b included",
    ]);
  });
});

describe("execution checks (IMPL §1.8)", () => {
  const files = { "src/a.ts": { content: numbered(20) }, "src/b.ts": { content: numbered(10) } };

  it("EXP-007 rejects a range past the end of the file, and the whole request", async () => {
    const round = await run({ files }, [
      read({ path: "src/b.ts", lines: "1-3" }, { path: "src/a.ts", lines: "18-21" }),
      read({ path: "src/b.ts", lines: "1-3" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "EXP-007" },
      { index: 1, items: ["E-1 src/b.ts 1-3"] },
    ]);
  });

  it("EXP-007 near miss: a range ending on the last line is read", async () => {
    const round = await run({ files }, [read({ path: "src/a.ts", lines: "18-20" })]);
    expect(outcomes(round)).toEqual([{ index: 0, items: ["E-1 src/a.ts 18-20"] }]);
  });

  it("EXP-008 rejects a file changed since the snapshot", async () => {
    const round = await run({ files, live: { "src/a.ts": numbered(21) } }, [
      read({ path: "src/a.ts", lines: "1-2" }),
    ]);
    expect(outcomes(round)).toEqual([{ index: 0, rule: "EXP-008" }]);
  });

  it("EXP-008 rejects a file that is gone or can't be read", async () => {
    const round = await run(
      {
        files,
        live: {
          "src/a.ts": undefined,
          "src/b.ts": { kind: "unreadable_file", reason: "permission_denied" },
        },
      },
      [read({ path: "src/a.ts", lines: "1-2" }), read({ path: "src/b.ts", lines: "1-2" })],
    );
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "EXP-008" },
      { index: 1, rule: "EXP-008" },
    ]);
  });

  it("EXP-008 is checked before EXP-007", async () => {
    const round = await run({ files, live: { "src/a.ts": numbered(21) } }, [
      read({ path: "src/a.ts", lines: "30-31" }),
    ]);
    expect(outcomes(round)).toEqual([{ index: 0, rule: "EXP-008" }]);
  });

  it("EXP-008 rejects a search when any file it searches changed, even one it doesn't match", async () => {
    const round = await run({ files, live: { "src/b.ts": numbered(9) } }, [search("line 15")]);
    expect(outcomes(round)).toEqual([{ index: 0, rule: "EXP-008" }]);
  });

  it("EXP-001 rejects a range read of a too-large file that holds a NUL byte or isn't UTF-8", async () => {
    const round = await run(
      {
        files: {
          "a.bin": { content: Buffer.from("one\ntwo\u0000\n"), status: "listed_only" },
          "b.bin": { content: Buffer.from([0x6f, 0x6b, 0x0a, 0xff, 0x0a]), status: "listed_only" },
        },
      },
      [read({ path: "a.bin", lines: "1-1" }), read({ path: "b.bin", lines: "1-1" })],
    );
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "EXP-001" },
      { index: 1, rule: "EXP-001" },
    ]);
  });

  it("EXP-010 rejects a range read over expansionEntryBytes instead of cutting it", async () => {
    // A two-line item is about 250 bytes with its header; all 20 lines are over 400.
    const round = await run({ files, settings: { expansionEntryBytes: 300 } }, [
      read({ path: "src/a.ts", lines: "1-20" }),
      read({ path: "src/a.ts", lines: "1-2" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "EXP-010" },
      { index: 1, items: ["E-1 src/a.ts 1-2"] },
    ]);
  });

  it("EXP-010 rejects a read without ranges when not even one line fits", async () => {
    const round = await run(
      {
        files: { "src/a.ts": { content: numbered(3, () => "y".repeat(400)) } },
        settings: { expansionEntryBytes: 300 },
      },
      [read({ path: "src/a.ts" })],
    );
    expect(outcomes(round)).toEqual([{ index: 0, rule: "EXP-010" }]);
  });

  it("checks each entry in full before the next: an earlier entry's EXP-007 wins over a later EXP-008", async () => {
    const round = await run({ files, live: { "src/b.ts": numbered(11) } }, [
      read({ path: "src/a.ts", lines: "19-25" }, { path: "src/b.ts", lines: "1-2" }),
    ]);
    expect(outcomes(round)).toEqual([{ index: 0, rule: "EXP-007" }]);
  });

  it("EXP-010 near miss: a read without ranges whose outline alone fits is sent as the outline", async () => {
    const code = `export function a() {\n${numbered(40, () => "  work();")}}\nexport function b() {\n${numbered(40, () => "  more();")}}\n`;
    const round = await run(
      { files: { "src/a.ts": { content: code } }, settings: { expansionEntryBytes: 400 } },
      [read({ path: "src/a.ts" })],
    );
    expect(round.requests[0]?.outcome).toBe("executed");
    expect(round.items[0]?.rendered.included).toEqual([]);
    expect(round.items[0]?.rendered.outline.map((e) => e.mark)).toEqual(["omitted", "omitted"]);
  });

  it("rejects an item that matches the secret scan, recording only the rule", async () => {
    const content = `a\nconst id = "${SECRET}";\nb\n`;
    const round = await run({ files: { "src/k.ts": { content }, ...files } }, [
      read({ path: "src/a.ts", lines: "1-1" }, { path: "src/k.ts", lines: "2-2" }),
      read({ path: "src/a.ts", lines: "2-2" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "secret-scan:aws-access-key-id" },
      { index: 1, items: ["E-1 src/a.ts 2"] },
    ]);
    expect(round.blocked).toEqual([{ path: "src/k.ts", ruleId: "aws-access-key-id" }]);
    expect(JSON.stringify(expansionRoundFields(round))).not.toContain(SECRET);
    expect(renderExpansionStatus(round)).not.toContain(SECRET);
  });

  it("a secret match blocks its file for the whole round: earlier and later reads of it are rejected", async () => {
    const content = `a\nconst id = "${SECRET}";\nb\n`;
    const round = await run({ files: { "src/k.ts": { content }, ...files } }, [
      read({ path: "src/k.ts", lines: "1-1" }),
      read({ path: "src/a.ts", lines: "1-1" }),
      read({ path: "src/k.ts", lines: "2-2" }),
      read({ path: "src/k.ts", lines: "3-3" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "secret-scan:aws-access-key-id" },
      { index: 1, items: ["E-1 src/a.ts 1"] },
      { index: 2, rule: "secret-scan:aws-access-key-id" },
      { index: 3, rule: "secret-scan:aws-access-key-id" },
    ]);
    expect(round.usedBytes).toBe(round.items[0]?.rendered.bytes);
  });

  it("no search searches a blocked file, and the search that matched stays rejected", async () => {
    const content = `a\nconst id = "${SECRET}"; // client\nb\n`;
    const repo = { "src/k.ts": { content }, "src/a.ts": { content: "use client\n" } };
    const round = await run({ files: repo }, [
      search("client", "src/k.ts"),
      search("client"),
      read({ path: "src/k.ts", lines: "3-3" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "secret-scan:aws-access-key-id" },
      { index: 1, items: ["E-1 src/a.ts 1"] },
      { index: 2, rule: "secret-scan:aws-access-key-id" },
    ]);
    expect(round.requests[1]).toMatchObject({ matches: 1 });
  });

  it("reruns the round when a block reveals more: a search that reaches a new file after a block", async () => {
    // Pass 1: the search keeps a.ts's 30 matches and never reaches b.ts; the read then blocks a.ts.
    // Pass 2: without a.ts, the search reaches b.ts, whose context line holds a key: b.ts is blocked.
    const a = numbered(50, (i) => (i <= 30 ? "hit" : i === 45 ? `k = "${SECRET}"` : "x"));
    const b = `hit\nk = "${SECRET}"\n`;
    const round = await run({ files: { "a.ts": { content: a }, "b.ts": { content: b } } }, [
      search("hit"),
      read({ path: "a.ts", lines: "45-45" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "secret-scan:aws-access-key-id" },
      { index: 1, rule: "secret-scan:aws-access-key-id" },
    ]);
    expect(round.blocked.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(round.items).toEqual([]);
  });

  it("records the blocked files in path order with their rule, a withheld name by hash", async () => {
    const round = await run(
      {
        files: {
          "src/z.ts": { content: `k = "${SECRET}"\n` },
          "src/b.ts": { content: `token = "${["ghp_", "a".repeat(36)].join("")}"\n` },
        },
      },
      [read({ path: "src/z.ts", lines: "1-1" }), read({ path: "src/b.ts", lines: "1-1" })],
    );
    expect(expansionRoundFields(round).blocked).toEqual([
      { path: "src/b.ts", secretRuleId: "github-token" },
      { path: "src/z.ts", secretRuleId: "aws-access-key-id" },
    ]);
  });

  it("scans the uncut text of a cut outline label", async () => {
    const name = `${"n".repeat(80)}_${SECRET}`;
    const code = `export function ${name}() {\n${numbered(40, () => "  work();")}}\nexport const b = 1;\n`;
    const round = await run(
      { files: { "src/a.ts": { content: code } }, settings: { expansionEntryBytes: 400 } },
      [read({ path: "src/a.ts" })],
    );
    expect(outcomes(round)).toEqual([{ index: 0, rule: "secret-scan:aws-access-key-id" }]);
  });

  it("EXP-009 rejects a request over expansionBytes, and a later smaller one still runs", async () => {
    const big = { "src/big.ts": { content: numbered(100) }, ...files };
    const round = await run({ files: big, settings: { expansionBytes: 1_500 } }, [
      read({ path: "src/a.ts", lines: "1-10" }),
      read({ path: "src/big.ts", lines: "1-100" }),
      read({ path: "src/b.ts", lines: "1-2" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, items: ["E-1 src/a.ts 1-10"] },
      { index: 1, rule: "EXP-009" },
      { index: 2, items: ["E-2 src/b.ts 1-2"] },
    ]);
    expect(round.usedBytes).toBe(round.items.reduce((sum, i) => sum + i.rendered.bytes, 0));
    expect(round.usedBytes).toBeLessThanOrEqual(1_500);
  });

  it("EXP-009 counts every entry of a request together", async () => {
    const round = await run({ files, settings: { expansionBytes: 400 } }, [
      read({ path: "src/a.ts", lines: "1-3" }, { path: "src/b.ts", lines: "1-3" }),
    ]);
    expect(outcomes(round)).toEqual([{ index: 0, rule: "EXP-009" }]);
  });

  it("a statically rejected request is listed with its rule and uses no item ID", async () => {
    const round = await run({ files }, [
      { kind: "read", rejectedBy: "EXP-003" },
      read({ path: "src/b.ts", lines: "4-5" }),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, rule: "EXP-003" },
      { index: 1, items: ["E-1 src/b.ts 4-5"] },
    ]);
  });

  it("checks the live content only once per file it reads", async () => {
    const fs = new MemoryFs({ "src/a.ts": numbered(20) });
    const bytes = bytesOf(numbered(20));
    const snapshot: SnapshotFile[] = [
      { path: "src/a.ts", status: "read", size: bytes.length, hash: sha256(bytes) },
    ];
    await runExpansion(
      {
        requests: [
          { request: read({ path: "src/a.ts", lines: "1-2" }, { path: "src/a.ts", lines: "5-6" }) },
        ],
        files: snapshot,
        index: expansionIndex({ files: snapshot, scopeRoots: ["."], sent: [], maxRequests: 5 }),
        membership: MEMBERSHIP,
        settings: DEFAULT_EXPANSION_SETTINGS,
      },
      fs,
    );
    expect(fs.reads).toEqual(["src/a.ts"]);
  });
});

describe("search (IMPL §1.8)", () => {
  const repo = {
    "src/a.ts": { content: numbered(20, (i) => (i === 10 ? "call fetchJson(x)" : `line ${i}`)) },
    "src/b.ts": { content: "fetchJson fetchJson\nFETCHJSON\nother\n" },
    "lib/c.ts": { content: "fetchJson()\n" },
    "logs/d.ts": { content: "fetchJson()\n", status: "ignored" as const },
    "big.ts": { content: "fetchJson()\n", status: "listed_only" as const },
  };

  it("matches case-sensitively, one match per line, in path then line order", async () => {
    const round = await run({ files: repo }, [search("fetchJson")]);
    expect(round.requests[0]).toMatchObject({ outcome: "executed", matches: 3, capped: false });
    expect(outcomes(round)).toEqual([
      { index: 0, items: ["E-1 lib/c.ts 1", "E-2 src/a.ts 7-13", "E-3 src/b.ts 1-3"] },
    ]);
  });

  it("never searches ignored or listed_only files", async () => {
    const round = await run({ files: repo }, [search("fetchJson")]);
    expect(round.items.map((i) => i.path)).not.toContain("logs/d.ts");
    expect(round.items.map((i) => i.path)).not.toContain("big.ts");
  });

  it("limits the search to files a glob matches, directly or through a directory", async () => {
    const round = await run({ files: repo }, [
      search("fetchJson", "src"),
      search("fetchJson", "lib/*.ts"),
    ]);
    expect(outcomes(round)).toEqual([
      { index: 0, items: ["E-1 src/a.ts 7-13", "E-2 src/b.ts 1-3"] },
      { index: 1, items: ["E-3 lib/c.ts 1"] },
    ]);
  });

  it("keeps 3 lines of context around each match, within the file, merged", async () => {
    const content = numbered(30, (i) => (i === 2 || i === 8 || i === 25 ? "hit here" : `l${i}`));
    const round = await run({ files: { "a.ts": { content } } }, [search("hit here")]);
    expect(outcomes(round)).toEqual([{ index: 0, items: ["E-1 a.ts 1-11,22-28"] }]);
    expect(round.items[0]?.rendered.outline).toEqual([]);
    expect(round.items[0]?.rendered.text).not.toContain("OUTLINE");
  });

  it("never resends lines the initial context sent, and a match on a sent line adds no lines", async () => {
    const content = numbered(30, (i) => (i === 5 || i === 20 ? "hit here" : `l${i}`));
    const round = await run({ files: { "a.ts": { content } }, sent: { "a.ts": "1-10,22-23" } }, [
      search("hit here"),
    ]);
    expect(round.requests[0]).toMatchObject({ outcome: "executed", matches: 2 });
    expect(outcomes(round)).toEqual([{ index: 0, items: ["E-1 a.ts 17-21"] }]);
  });

  it("gives no item for a file whose matches are all on sent lines, but counts them", async () => {
    const round = await run({ files: repo, sent: { "lib/c.ts": "1" } }, [
      search("fetchJson", "lib"),
    ]);
    expect(round.requests[0]).toMatchObject({ outcome: "executed", matches: 1, items: [] });
    expect(renderExpansionStatus(round)).toContain("expansionRequests/0 executed: 0 items\n");
  });

  it("keeps the first 30 matches in path and line order, and says when there were more", async () => {
    const many = {
      "a.ts": { content: numbered(20, () => "hit") },
      "b.ts": { content: numbered(20, () => "hit") },
    };
    const round = await run({ files: many }, [search("hit")]);
    expect(round.requests[0]).toMatchObject({ outcome: "executed", matches: 30, capped: true });
    expect(outcomes(round)).toEqual([{ index: 0, items: ["E-1 a.ts 1-20", "E-2 b.ts 1-13"] }]);
    const exact = await run({ files: { "a.ts": { content: numbered(30, () => "hit") } } }, [
      search("hit"),
    ]);
    expect(exact.requests[0]).toMatchObject({ matches: 30, capped: false });
  });

  it("a search with no match is executed with no items", async () => {
    const round = await run({ files: repo }, [search("nothing here")]);
    expect(round.requests[0]).toMatchObject({ outcome: "executed", matches: 0, items: [] });
    expect(renderExpansionStatus(round)).toContain("expansionRequests/0 no matches\n");
  });

  it("doesn't depend on the order the filesystem lists files in", async () => {
    const a = await run({ files: repo }, [search("fetchJson")]);
    const b = await run({ files: repo, order: seededShuffle(7) }, [search("fetchJson")]);
    expect(expansionRoundFields(b)).toEqual(expansionRoundFields(a));
  });
});

describe("status lines and the record (IMPL §1.8, §1.13)", () => {
  const files = { "src/a.ts": { content: numbered(20) }, "src/b.ts": { content: "x\n" } };

  it("renders one status line per request, with no path, literal or content", async () => {
    const round = await run({ files, live: { "src/b.ts": "y\n" } }, [
      read({ path: "src/a.ts", lines: "1-2" }, { path: "src/a.ts", lines: "5-6" }),
      { kind: "search", rejectedBy: "EXP-005" },
      read({ path: "src/b.ts", lines: "1-1" }),
      read({ path: "src/a.ts", lines: "30-31" }),
      read({ path: "src/a.ts", lines: "7-7" }),
      search("zzz-none", "src/a.ts"),
    ]);
    expect(renderExpansionStatus(round)).toBe(
      [
        "<<<EXPANSION>>>",
        "expansionRequests/0 executed: 2 items",
        "expansionRequests/1 rejected: invalid request",
        "expansionRequests/2 rejected: changed since snapshot",
        "expansionRequests/3 rejected: range past end of file",
        "expansionRequests/4 executed: 1 item",
        "expansionRequests/5 no matches",
        "<<<END EXPANSION>>>",
        "",
      ].join("\n"),
    );
  });

  it("says over budget for EXP-009 and EXP-010, and withheld for a secret match", async () => {
    const round = await run(
      {
        files: { ...files, "k.ts": { content: `k = "${SECRET}"\n` } },
        settings: { expansionEntryBytes: 300, expansionBytes: 350 },
      },
      [
        read({ path: "src/a.ts", lines: "1-20" }),
        read({ path: "src/a.ts", lines: "1-4" }, { path: "src/a.ts", lines: "5-8" }),
        read({ path: "k.ts", lines: "1-1" }),
      ],
    );
    expect(renderExpansionStatus(round).split("\n").slice(1, 4)).toEqual([
      "expansionRequests/0 rejected: over budget",
      "expansionRequests/1 rejected: over budget",
      "expansionRequests/2 rejected: withheld",
    ]);
  });

  it("records each request's outcome, rule, items and bytes", async () => {
    const round = await run({ files }, [
      { kind: "read", rejectedBy: "EXP-001" },
      read({ path: "src/a.ts", lines: "3-4" }),
      search("zzz-none"),
    ]);
    const fields = expansionRoundFields(round);
    const item = round.items[0];
    expect(fields).toEqual({
      budgetBytes: 60_000,
      usedBytes: item?.rendered.bytes,
      requests: [
        { index: 0, kind: "read", outcome: "rejected", rule: "EXP-001" },
        {
          index: 1,
          kind: "read",
          outcome: "executed",
          items: [
            {
              id: "E-1",
              path: "src/a.ts",
              fileHash: sha256(bytesOf(numbered(20))),
              excerpt: true,
              includedLines: "3-4",
              totalLines: 20,
              bytes: item?.rendered.bytes,
            },
          ],
        },
        { index: 2, kind: "search", outcome: "executed", matches: 0, capped: false, items: [] },
      ],
      blocked: [],
    });
  });

  it("records a withheld path by its hash", async () => {
    const withheld = `src/${SECRET}.ts`;
    // A withheld path is never readable (EXP-001), so the only way it reaches a record is a bug;
    // the recorded form still never holds the path.
    const round: ExpansionRound = {
      budgetBytes: 1,
      usedBytes: 0,
      items: [],
      blocked: [{ path: withheld, ruleId: "aws-access-key-id" }],
      requests: [
        {
          index: 0,
          kind: "read",
          outcome: "executed",
          items: [
            {
              id: "E-1",
              path: withheld,
              hash: sha256(bytesOf("x")),
              reason: "expansion:expansionRequests/0",
              content: bytesOf("x"),
              rendered: {
                text: "",
                bytes: 0,
                excerpt: false,
                included: [],
                totalLines: 0,
                outline: [],
              },
            },
          ],
        },
      ],
    };
    expect(JSON.stringify(expansionRoundFields(round))).not.toContain(SECRET);
  });
});
