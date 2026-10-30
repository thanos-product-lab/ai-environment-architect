import { describe, expect, it } from "vitest";
import { pathHash } from "../context/secrets.js";
import type { SelectionGap } from "../context/tiers.js";
import { buildExclusionRules } from "../snapshot/exclusions.js";
import type { IgnoreRules } from "../snapshot/git.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import type { SentRun } from "./citations.js";
import {
  absenceClaimCheck,
  type CoverageContext,
  checkAbsenceClaim,
  checkGap,
  checkScopePaths,
  couldMatchInside,
  coverageIndex,
  deterministicGapCoverage,
  gapCheck,
  globMatches,
  resolvePath,
  scopeCheck,
} from "./coverage.js";
import { RULE_IDS } from "./pipeline.js";

// Coverage-aware validation (IMPL §1.11): path resolution, scope paths, gaps and absence claims.

const HASH = "sha256:00";
const WITHHELD_FILE = "keys/AKIAIOSFODNN7EXAMPLE.txt";
const WITHHELD_DIR = "AKIAIOSFODNN7EXAMPLE";

const read = (path: string): SnapshotFile => ({ path, status: "read", size: 1, hash: HASH });

const FILES: readonly SnapshotFile[] = [
  read("README.md"),
  { path: WITHHELD_DIR, status: "excluded", kind: "directory", rule: `${WITHHELD_DIR}/` },
  { path: "big.txt", status: "listed_only", size: 1, hash: HASH, reason: "too_large" },
  { path: "broken", status: "unreadable", kind: "directory", reason: "permission_denied" },
  read("docs/guide.md"),
  read("docs/outline.md"),
  read(WITHHELD_FILE),
  { path: "logs/x.log", status: "ignored", kind: "file", size: 1, hash: HASH },
  { path: "node_modules", status: "excluded", kind: "directory", rule: "node_modules/" },
  read("src/a.ts"),
  read("src/b.ts"),
  read("src/c.ts"),
  read("src/deep/d.ts"),
  { path: "src/generated", status: "excluded", kind: "directory", rule: "src/generated/" },
  { path: "src/node_modules", status: "excluded", kind: "directory", rule: "node_modules/" },
  { path: "tmp", status: "ignored", kind: "directory" },
  { path: "vendor", status: "symlink", target: "../shared" },
];

/** Lines 1–n of a file as one run, or split into several runs. */
const run = (first: number, last: number): SentRun => ({
  first,
  lines: Array.from({ length: last - first + 1 }, () => "x"),
});

const SENT = [
  { path: "README.md", totalLines: 10, sent: [run(1, 10)] },
  // Completed by an expansion item: two items together cover the file.
  { path: "src/a.ts", totalLines: 20, sent: [run(1, 12)] },
  { path: "src/a.ts", totalLines: 20, sent: [run(10, 20)] },
  // Excerpted.
  { path: "src/b.ts", totalLines: 20, sent: [run(1, 5), run(9, 20)] },
  // Outline-only.
  { path: "docs/outline.md", totalLines: 30, sent: [] },
  { path: "docs/guide.md", totalLines: 4, sent: [run(1, 4)] },
];

const APPLIED: IgnoreRules = { state: "applied" };
// The withheld directory and `src/generated` are user exclusions; `node_modules/` is a default.
const EXCLUSIONS = buildExclusionRules({ userExclusions: [`${WITHHELD_DIR}/`, "src/generated/"] });
const snapshot = (files: readonly SnapshotFile[], ignoreRules: IgnoreRules = APPLIED) => ({
  files,
  exclusions: EXCLUSIONS,
  ignoreRules,
});
const index = coverageIndex(snapshot(FILES), SENT);
const context: CoverageContext = { coverage: index };

describe("globs (IMPL §1.11)", () => {
  it("* matches within one segment, ** zero or more whole segments, case-sensitively", () => {
    expect(globMatches("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/deep/d.ts")).toBe(false);
    expect(globMatches("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/**/*.ts", "src/deep/d.ts")).toBe(true);
    expect(globMatches("**", "src/deep/d.ts")).toBe(true);
    expect(globMatches("SRC/*.ts", "src/a.ts")).toBe(false);
    expect(globMatches("!src/a.ts", "src/a.ts")).toBe(false);
  });

  it("is anchored at the repository root", () => {
    expect(globMatches("*.ts", "src/a.ts")).toBe(false);
    expect(globMatches("a.ts", "src/a.ts")).toBe(false);
  });

  it("could match inside a directory only with a segment left over or a trailing **", () => {
    expect(couldMatchInside("**/*.test.ts", "src/a/node_modules")).toBe(true);
    expect(couldMatchInside("src/**/foo.ts", "src/a/node_modules")).toBe(true);
    expect(couldMatchInside("docs/*.md", "src/a/node_modules")).toBe(false);
    expect(couldMatchInside("node_modules/x.js", "node_modules")).toBe(true);
    expect(couldMatchInside("node_modules", "node_modules")).toBe(false);
    expect(couldMatchInside("node_modules/**", "node_modules")).toBe(true);
    expect(couldMatchInside("*/x.js", "node_modules")).toBe(true);
  });
});

describe("path resolution (IMPL §1.11)", () => {
  it("lists entries of any status and directories that contain entries", () => {
    for (const path of ["src/a.ts", "big.txt", "logs/x.log", "node_modules", "tmp", "vendor"])
      expect(resolvePath(path, index)).toBe("listed");
    expect(resolvePath("broken", index)).toBe("listed");
    expect(resolvePath("src", index)).toBe("listed");
    expect(resolvePath("src/deep", index)).toBe("listed");
    expect(resolvePath("src/*.ts", index)).toBe("listed");
  });

  it("normalises as path tokens do: one leading ./ and one trailing / removed", () => {
    expect(resolvePath("src/", index)).toBe("listed");
    expect(resolvePath("./src/a.ts", index)).toBe("listed");
    expect(resolvePath("./src/", index)).toBe("listed");
    expect(resolvePath("src//", index)).toBe("unlisted");
    expect(resolvePath("././src/a.ts", index)).toBe("unlisted");
  });

  it("is uncovered under, or could match inside, a directory capture didn't enter", () => {
    expect(resolvePath("node_modules/react/index.js", index)).toBe("uncovered");
    expect(resolvePath("tmp/cache.json", index)).toBe("uncovered");
    expect(resolvePath("broken/x.ts", index)).toBe("uncovered");
    expect(resolvePath("vendor/lib.ts", index)).toBe("uncovered");
    expect(resolvePath("**/*.zig", index)).toBe("uncovered");
  });

  it("is unlisted otherwise, and never resolves ..", () => {
    expect(resolvePath("lib/x.ts", index)).toBe("unlisted");
    expect(resolvePath("src/../README.md", index)).toBe("unlisted");
    expect(resolvePath("../README.md", index)).toBe("unlisted");
    expect(resolvePath("node_modules/../x", index)).toBe("unlisted");
    expect(resolvePath("Src/a.ts", index)).toBe("unlisted");
  });

  it("lists a withheld path for gaps and absence claims", () => {
    expect(resolvePath(WITHHELD_FILE, index)).toBe("listed");
    expect(resolvePath(WITHHELD_DIR, index)).toBe("listed");
  });
});

describe("SCOPE-001 (IMPL §1.11, §3.3.2 step 4)", () => {
  it("SCOPE-001 accepts listed paths, directories and globs", () => {
    expect(checkScopePaths(["src/a.ts", "docs", "src/**/*.ts", "node_modules"], index)).toEqual({
      ok: true,
    });
  });

  it("SCOPE-001 rejects an unlisted path, naming its position only", () => {
    expect(checkScopePaths(["src/a.ts", "lib/x.ts"], index)).toEqual({
      ok: false,
      rule: "SCOPE-001",
      detail: "scope path 1 is not a listed path",
    });
  });

  it("SCOPE-001 rejects an uncovered path", () => {
    expect(checkScopePaths(["node_modules/react"], index)).toMatchObject({ rule: "SCOPE-001" });
  });

  it("SCOPE-001 rejects a withheld path, and a glob that matches only withheld paths", () => {
    expect(checkScopePaths([WITHHELD_FILE], index)).toMatchObject({ rule: "SCOPE-001" });
    expect(checkScopePaths([WITHHELD_DIR], index)).toMatchObject({ rule: "SCOPE-001" });
    expect(checkScopePaths(["keys/*.txt"], index)).toMatchObject({ rule: "SCOPE-001" });
  });

  it("SCOPE-001 accepts a glob that matches a withheld path and a visible one", () => {
    expect(checkScopePaths(["*"], index)).toEqual({ ok: true });
  });

  it("SCOPE-001 runs only on path scopes, as an item check", () => {
    const check = scopeCheck();
    expect(check({ scope: { kind: "repository" } }, context, { localKeys: new Set() })).toEqual({
      kind: "accept",
      value: { scope: { kind: "repository" } },
      events: [],
    });
    expect(
      check({ scope: { kind: "paths", paths: ["nope.ts"] } }, context, { localKeys: new Set() }),
    ).toMatchObject({ kind: "reject", rule: "SCOPE-001" });
  });
});

describe("GAP-001 and GAP-002 (IMPL §1.11, §3.3.2 step 5)", () => {
  it("GAP-001 rejects a gap with an unlisted related path", () => {
    expect(checkGap(["src/a.ts", "lib/x.ts"], index)).toEqual({
      ok: false,
      rule: "GAP-001",
      detail: "related path 1 is neither listed nor under a directory capture didn't enter",
    });
  });

  it("GAP-001 rejects a path with a .. segment, which names nothing", () => {
    expect(checkGap(["src/../README.md"], index)).toMatchObject({ rule: "GAP-001" });
    expect(checkGap(["node_modules/../src"], index)).toMatchObject({ rule: "GAP-001" });
  });

  it("strips one leading ./ from a related path", () => {
    expect(checkGap(["./src/a.ts"], index)).toEqual({ ok: true, coverage: { state: "inspected" } });
  });

  it("stays inspected when every matched file was sent in full, across items", () => {
    expect(checkGap(["README.md", "src/a.ts"], index)).toEqual({
      ok: true,
      coverage: { state: "inspected" },
    });
    expect(checkGap(["docs/guide.md"], index)).toEqual({
      ok: true,
      coverage: { state: "inspected" },
    });
  });

  it("GAP-002 relabels an excerpted, outline-only or unselected file", () => {
    expect(checkGap(["src/b.ts", "docs/outline.md", "src/c.ts"], index)).toEqual({
      ok: true,
      coverage: {
        state: "not_inspected",
        entries: [{ path: "docs/outline.md" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
        directories: [],
      },
    });
  });

  it("GAP-002 relabels listed_only, ignored and withheld files, withheld ones by hash", () => {
    expect(checkGap(["big.txt", "logs/x.log", WITHHELD_FILE], index)).toEqual({
      ok: true,
      coverage: {
        state: "not_inspected",
        entries: [
          { path: "big.txt" },
          { pathHash: pathHash(WITHHELD_FILE) },
          { path: "logs/x.log" },
        ],
        directories: [],
      },
    });
  });

  it("GAP-002 relabels a gap under an excluded directory, recording the directory", () => {
    expect(checkGap(["node_modules/react/index.js"], index)).toEqual({
      ok: true,
      coverage: { state: "not_inspected", entries: [], directories: [{ path: "node_modules" }] },
    });
  });

  it("GAP-002 relabels a gap through a symbolic link and under an unreadable directory", () => {
    expect(checkGap(["vendor/lib.ts", "broken/x.ts"], index)).toEqual({
      ok: true,
      coverage: {
        state: "not_inspected",
        entries: [],
        directories: [{ path: "broken" }, { path: "vendor" }],
      },
    });
  });

  it("GAP-002 relabels a related path that matches an excluded directory entry", () => {
    expect(checkGap(["node_modules"], index)).toEqual({
      ok: true,
      coverage: { state: "not_inspected", entries: [], directories: [{ path: "node_modules" }] },
    });
  });

  it("GAP-002 covers everything under a directory, matched literally or by a glob", () => {
    const literal = checkGap(["src"], index);
    const glob = checkGap(["src/*"], index);
    const expected = {
      ok: true,
      coverage: {
        state: "not_inspected",
        entries: [{ path: "src/b.ts" }, { path: "src/c.ts" }, { path: "src/deep/d.ts" }],
        // A user exclusion it covers counts; the default `node_modules/` exclusion doesn't.
        directories: [{ path: "src/generated" }],
      },
    };
    expect(literal).toEqual(expected);
    expect(glob).toEqual(expected);
  });

  it("GAP-002 records an unentered directory a related path names explicitly, once", () => {
    const expected = {
      ok: true,
      coverage: {
        state: "not_inspected",
        entries: [],
        directories: [{ path: "src/node_modules" }],
      },
    };
    expect(checkGap(["src/node_modules"], index)).toEqual(expected);
    expect(checkGap(["src/node_modules/**"], index)).toEqual(expected);
    expect(checkGap(["src/node_modules/react/*.js"], index)).toEqual(expected);
  });

  it("GAP-002 ignores default exclusions and ignored directories a glob could only reach", () => {
    const small = coverageIndex(
      snapshot([
        read("README.md"),
        read("logs/README.md"),
        { path: "node_modules", status: "excluded", kind: "directory", rule: "node_modules/" },
        { path: "tmp", status: "ignored", kind: "directory" },
      ]),
      [
        { path: "README.md", totalLines: 3, sent: [run(1, 3)] },
        { path: "logs/README.md", totalLines: 2, sent: [run(1, 2)] },
      ],
    );
    expect(checkGap(["**/README.md"], small)).toEqual({
      ok: true,
      coverage: { state: "inspected" },
    });
    // Covering a default-excluded directory below it is reaching it too.
    expect(checkGap(["**"], small)).toEqual({ ok: true, coverage: { state: "inspected" } });
  });

  it("GAP-002 counts an unreadable directory, a symbolic link or a user exclusion it could reach", () => {
    expect(checkGap(["**/*.zig"], index)).toEqual({
      ok: true,
      coverage: {
        state: "not_inspected",
        entries: [],
        directories: [
          { pathHash: pathHash(WITHHELD_DIR) },
          { path: "broken" },
          { path: "src/generated" },
          { path: "vendor" },
        ],
      },
    });
  });

  it("GAP-002 counts an excluded symbolic link it could reach only when a user rule excluded it", () => {
    const links = (rule: string) =>
      coverageIndex(
        snapshot([read("a.md"), { path: "lib", status: "excluded", kind: "symlink", rule }]),
        [{ path: "a.md", totalLines: 1, sent: [run(1, 1)] }],
      );
    expect(checkGap(["**/*.md"], links("vendor/"))).toEqual({
      ok: true,
      coverage: { state: "inspected" },
    });
    expect(checkGap(["**/*.md"], links("src/generated/"))).toMatchObject({
      coverage: { state: "not_inspected", directories: [{ path: "lib" }] },
    });
  });

  it("GAP-002 treats session storage as a default exclusion, unless a user rule excluded it first", () => {
    const storage = (userExclusions: string[]) =>
      coverageIndex(
        {
          files: [
            read("a.md"),
            { path: ".sessions", status: "excluded", kind: "directory", rule: ".sessions/" },
          ],
          exclusions: buildExclusionRules({ userExclusions, sessionStoragePath: ".sessions" }),
          ignoreRules: APPLIED,
        },
        [{ path: "a.md", totalLines: 1, sent: [run(1, 1)] }],
      );
    expect(checkGap(["**/*.md"], storage([]))).toEqual({
      ok: true,
      coverage: { state: "inspected" },
    });
    expect(checkGap(["**/*.md"], storage([".sessions/"]))).toMatchObject({
      coverage: { state: "not_inspected", directories: [{ path: ".sessions" }] },
    });
  });

  it("every item of a file must agree on its line count", () => {
    expect(() =>
      coverageIndex(snapshot(FILES), [
        { path: "src/a.ts", totalLines: 20, sent: [run(1, 20)] },
        { path: "src/a.ts", totalLines: 21, sent: [run(21, 21)] },
      ]),
    ).toThrow("items of one file disagree on its line count");
  });

  it("an empty file sent as an item is sent in full", () => {
    const empty = coverageIndex(snapshot([read("empty.ts"), read("unsent.ts")]), [
      { path: "empty.ts", totalLines: 0, sent: [] },
    ]);
    expect(checkGap(["empty.ts"], empty)).toEqual({ ok: true, coverage: { state: "inspected" } });
    expect(checkGap(["unsent.ts"], empty)).toMatchObject({ coverage: { state: "not_inspected" } });
  });

  it("GAP-002 is a relabelling event on the gap, which keeps everything else", () => {
    const gap = { relatedPaths: ["src/b.ts"], statement: "No test command." };
    const result = gapCheck()(gap, context, { localKeys: new Set() });
    expect(result).toEqual({
      kind: "accept",
      value: {
        ...gap,
        coverage: { state: "not_inspected", entries: [{ path: "src/b.ts" }], directories: [] },
      },
      events: [
        {
          rule: "GAP-002",
          outcome: "relabelled",
          detail: "not inspected: 1 entry not sent in full, 0 directories not entered",
        },
      ],
    });
  });

  it("an inspected gap has no event", () => {
    const result = gapCheck()({ relatedPaths: ["README.md"] }, context, { localKeys: new Set() });
    expect(result).toEqual({
      kind: "accept",
      value: { relatedPaths: ["README.md"], coverage: { state: "inspected" } },
      events: [],
    });
  });

  it("does not depend on the order of files or sent items", () => {
    const reversed = coverageIndex(snapshot([...FILES].reverse()), [...SENT].reverse());
    for (const paths of [["src"], ["**/*.zig"], ["big.txt", "logs/x.log", WITHHELD_FILE]])
      expect(checkGap(paths, reversed)).toEqual(checkGap(paths, index));
  });
});

describe("deterministic gaps (IMPL §1.5, §1.11)", () => {
  it("are not_inspected from the start, with their related paths", () => {
    const gap: SelectionGap = {
      gapType: "other",
      statement: "Agent configuration skipped.",
      relatedPaths: [".claude/b.md", ".claude/a.md"],
      relatedPathHashes: [pathHash(WITHHELD_FILE)],
    };
    expect(deterministicGapCoverage(gap)).toEqual({
      state: "not_inspected",
      entries: [
        { path: ".claude/a.md" },
        { path: ".claude/b.md" },
        { pathHash: pathHash(WITHHELD_FILE) },
      ],
      directories: [],
    });
  });
});

describe("ABS-001 and ABS-002 (IMPL §1.11, §3.3.2 step 6)", () => {
  it("ABS-001 rejects a glob that matches an ignored file", () => {
    expect(checkAbsenceClaim("logs/*.log", index)).toEqual({
      ok: false,
      rule: "ABS-001",
      detail: "`logs/x.log` (ignored) matches the glob",
    });
  });

  it("ABS-001 rejects a glob that matches an excluded or listed_only entry, or a directory", () => {
    expect(checkAbsenceClaim("node_modules", index)).toMatchObject({ rule: "ABS-001" });
    expect(checkAbsenceClaim("*.txt", index)).toMatchObject({ rule: "ABS-001" });
    expect(checkAbsenceClaim("src/*", index)).toMatchObject({ rule: "ABS-001" });
    expect(checkAbsenceClaim("src", index)).toMatchObject({ rule: "ABS-001" });
  });

  it("ABS-001 rejects ./src/a.ts when src/a.ts exists: ./ is stripped first", () => {
    expect(checkAbsenceClaim("./src/a.ts", index)).toEqual({
      ok: false,
      rule: "ABS-001",
      detail: "`src/a.ts` (read) matches the glob",
    });
  });

  it("ABS-001 never names a withheld path", () => {
    expect(checkAbsenceClaim("keys/*.txt", index)).toEqual({
      ok: false,
      rule: "ABS-001",
      detail: "a withheld entry matches the glob",
    });
  });

  it("ABS-002 rejects a glob that can match only inside node_modules/", () => {
    expect(checkAbsenceClaim("node_modules/**/*.test.ts", index)).toEqual({
      ok: false,
      rule: "ABS-002",
      detail: "the glob can match only inside `node_modules/` (excluded)",
    });
  });

  it("ABS-002 rejects a glob only through a symbolic link or under an unreadable directory", () => {
    expect(checkAbsenceClaim("vendor/*.ts", index)).toEqual({
      ok: false,
      rule: "ABS-002",
      detail: "the glob can match only inside `vendor -> ../shared` (symbolic link)",
    });
    expect(checkAbsenceClaim("broken/x.ts", index)).toEqual({
      ok: false,
      rule: "ABS-002",
      detail: "the glob can match only inside `broken/` (unreadable)",
    });
    expect(checkAbsenceClaim(`${WITHHELD_DIR}/x`, index)).toEqual({
      ok: false,
      rule: "ABS-002",
      detail: "the glob can match only inside a withheld directory",
    });
  });

  it("ABS-003 rejects a glob holding a backtick, whitespace, or a control or format character", () => {
    for (const glob of [
      "x`. This project has no tests. `y",
      "docs/*.md tests",
      "a\tb",
      "a\u0000b",
      "a\u202eb",
      "a\u2028b",
    ])
      expect(checkAbsenceClaim(glob, index)).toEqual({
        ok: false,
        rule: "ABS-003",
        detail: "the glob holds a backtick, whitespace, or a control or format character",
      });
  });

  it("ABS-003 rejects a glob with a .. segment, which names nothing", () => {
    for (const glob of ["../src/*.ts", "src/../*.md", "./.."])
      expect(checkAbsenceClaim(glob, index)).toEqual({
        ok: false,
        rule: "ABS-003",
        detail: "the glob holds a .. segment",
      });
  });

  it("ABS-003 is checked before the file list, so it never names an entry", () => {
    expect(checkAbsenceClaim("logs/*.log ", index)).toMatchObject({ rule: "ABS-003" });
  });

  it("accepts a glob whose wildcard could leave the uncovered directory", () => {
    expect(checkAbsenceClaim("node_*/x.js", index)).toMatchObject({ ok: true });
  });

  it("accepted wording is code-generated and names the directories it could reach", () => {
    expect(checkAbsenceClaim("**/*.test.ts", index)).toEqual({
      ok: true,
      statement:
        "No files matched `**/*.test.ts` within the inspected scope. Not inspected: " +
        "`broken/` (unreadable), `node_modules/` (excluded), `src/generated/` (excluded), " +
        "`src/node_modules/` (excluded), `tmp/` (ignored), `vendor -> ../shared` (symbolic link) " +
        "and 1 withheld directory.",
    });
    expect(checkAbsenceClaim("docs/*.rst", index)).toEqual({
      ok: true,
      statement: "No files matched `docs/*.rst` within the inspected scope.",
    });
  });

  it("counts withheld directories when no other is named", () => {
    const only = coverageIndex(
      snapshot([read("a.md"), { path: WITHHELD_DIR, status: "ignored", kind: "directory" }]),
      [],
    );
    expect(checkAbsenceClaim("**/*.ts", only)).toEqual({
      ok: true,
      statement:
        "No files matched `**/*.ts` within the inspected scope. Not inspected: 1 withheld directory.",
    });
  });

  it("withholds a symbolic link target that matches the secret scan", () => {
    const linked = coverageIndex(
      snapshot([{ path: "current", status: "symlink", target: `../${WITHHELD_DIR}` }]),
      [],
    );
    expect(checkAbsenceClaim("**/*.ts", linked)).toMatchObject({
      statement:
        "No files matched `**/*.ts` within the inspected scope. Not inspected: " +
        "`current -> <withheld>` (symbolic link).",
    });
  });

  it("says when ignore rules were not applied", () => {
    const unapplied = coverageIndex(
      snapshot(FILES, { state: "not_applied", reason: "git_missing" }),
      SENT,
    );
    expect(checkAbsenceClaim("docs/*.rst", unapplied)).toEqual({
      ok: true,
      statement:
        "No files matched `docs/*.rst` within the inspected scope. " +
        "Ignore rules were not applied, so ignored files could not be identified.",
    });
  });

  it("sets the statement on the claim as an item check, leaving the model's reason alone", () => {
    const claim = { pathGlob: "docs/*.rst", reason: "Looked for reStructuredText." };
    expect(absenceClaimCheck()(claim, context, { localKeys: new Set() })).toEqual({
      kind: "accept",
      value: { ...claim, statement: "No files matched `docs/*.rst` within the inspected scope." },
      events: [],
    });
  });
});

describe("rule IDs", () => {
  it("registers the §1.11 rules", () => {
    for (const rule of ["SCOPE-001", "GAP-001", "GAP-002", "ABS-001", "ABS-002", "ABS-003"])
      expect(RULE_IDS).toContain(rule);
  });
});
