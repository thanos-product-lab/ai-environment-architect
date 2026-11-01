import { describe, expect, it } from "vitest";
import { analyseContext, type FixtureContext } from "../../../test/support/call-context.js";
import { validateAnalyse } from "./analyse.js";

// `analyse` item validation (IMPL §3.3.2): steps 7–10 and the corrected-citation rate (§3.2.2).
// The rules of steps 1–6 have their own tests; here they appear only where they interact.

const guide = [
  "# Guide",
  "Run the test suite with pnpm before pushing.",
  "Components fetch data through the shared client.",
  "Lint runs through Biome in CI.",
];
const client = [
  "export async function getUser(id: string) {",
  "  return fetch('/api/users/' + id);",
  "}",
];

const fixture: FixtureContext = {
  files: [
    { path: "docs/guide.md", status: "read" },
    { path: "src/client.ts", status: "read" },
    { path: "src/other.ts", status: "read" },
    { path: "package.json", status: "read" },
  ],
  ignoreRules: { state: "applied" },
  items: [
    {
      alias: "T2-001",
      path: "docs/guide.md",
      basis: "documentation",
      totalLines: 4,
      sent: [{ first: 1, lines: guide }],
    },
    {
      alias: "T5-001",
      path: "src/client.ts",
      basis: "code_observation",
      totalLines: 3,
      sent: [{ first: 1, lines: client }],
    },
    { alias: "T5-002", path: "src/other.ts", basis: "code_observation", totalLines: 9, sent: [] },
  ],
  knownFacts: [
    {
      alias: "F-1",
      statement: "`package.json` defines the script `test`.",
      scope: { kind: "repository" },
      evidencePaths: ["package.json"],
    },
  ],
  blocks: 2,
  maxExpansionRequests: 2,
};

const docFinding = (key: string, statement = "The guide asks for the shared client.") => ({
  key,
  statement,
  mode: "descriptive",
  scope: { kind: "repository" },
  citations: [{ item: "T2-001", lines: "3-3", quote: "fetch data through the shared client" }],
});
const codeFinding = (key: string) => ({
  key,
  statement: "The user lookup calls fetch directly.",
  mode: "descriptive",
  scope: { kind: "paths", paths: ["src/client.ts"] },
  citations: [{ item: "T5-001", lines: "2-2", quote: "return fetch('/api/users/" }],
});

const response = (parts: Record<string, unknown[]>) =>
  JSON.stringify({
    findings: [],
    gaps: [],
    absenceClaims: [],
    conflicts: [],
    expansionRequests: [],
    contentNotices: [],
    ...parts,
  });

const run = (parts: Record<string, unknown[]>, reversed = false) =>
  validateAnalyse(response(parts), analyseContext(fixture, reversed));

const events = (outcome: ReturnType<typeof run>) =>
  outcome.result.events.map((e) => [e.itemKey, e.stage, e.rule]);

const keys = (outcome: ReturnType<typeof run>, collection: string) =>
  outcome.result.status === "validated"
    ? (outcome.result.accepted as unknown as Record<string, readonly { key: string }[]>)[
        collection
      ]?.map((i) => i.key)
    : undefined;

describe("duplicates (IMPL §3.3.2 step 7)", () => {
  it("DUP-001 keeps the first of two findings whose statements differ only in spacing", () => {
    const outcome = run({
      findings: [docFinding("f1"), docFinding("f2", " The guide  asks for the shared\tclient. ")],
    });
    expect(events(outcome)).toEqual([["f2", "cross_item", "DUP-001"]]);
  });

  it("DUP-001 keeps both when the case differs or the scope differs", () => {
    const outcome = run({
      findings: [
        docFinding("f1"),
        docFinding("f2", "the guide asks for the shared client."),
        { ...docFinding("f3"), scope: { kind: "paths", paths: ["docs/guide.md"] } },
      ],
    });
    expect(events(outcome)).toEqual([]);
  });

  it("DUP-001 drops a duplicate gap and a duplicate absence claim", () => {
    const gap = (key: string, relatedPaths: string[]) => ({
      key,
      statement: "No lint command is documented.",
      gapType: "no_command",
      relatedPaths,
    });
    const claim = (key: string, pathGlob: string) => ({ key, pathGlob, reason: "none seen" });
    const outcome = run({
      gaps: [gap("g1", ["docs/guide.md", "src"]), gap("g2", ["./src/", "docs/guide.md"])],
      absenceClaims: [claim("a1", "test/**/*.ts"), claim("a2", "./test/**/*.ts")],
    });
    expect(events(outcome).filter((e) => e[1] === "cross_item")).toEqual([
      ["g2", "cross_item", "DUP-001"],
      ["a2", "cross_item", "DUP-001"],
    ]);
  });

  it("DUP-002 drops a restated known fact, before DUP-001", () => {
    const fact = {
      key: "f1",
      statement: "`package.json` defines the script `test`.",
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [{ item: "T2-001", lines: "2-2", quote: "Run the test suite with pnpm" }],
    };
    const outcome = run({ findings: [fact, { ...fact, key: "f2" }] });
    // SUP-001: `package.json` and `test` must be anchored; `package.json` is listed, and `test`
    // is in the excerpt, so both reach the duplicate rules.
    expect(events(outcome)).toEqual([
      ["f1", "cross_item", "DUP-002"],
      ["f2", "cross_item", "DUP-002"],
    ]);
  });
});

describe("conflicts (IMPL §3.3.2 step 8)", () => {
  it("CONF-001 rejects a conflict between a finding and its own duplicate", () => {
    const outcome = run({
      findings: [docFinding("f1"), docFinding("f2"), codeFinding("f3")],
      conflicts: [{ key: "c1", description: "Docs and code disagree.", findings: ["f1", "f2"] }],
    });
    expect(events(outcome)).toEqual([
      ["f2", "cross_item", "DUP-001"],
      ["c1", "cross_item", "CONF-001"],
    ]);
  });

  it("CONF-001 counts a member written twice once", () => {
    const outcome = run({
      findings: [docFinding("f1"), codeFinding("f2")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["f1", "f1"] }],
    });
    expect(events(outcome)).toEqual([["c1", "cross_item", "CONF-001"]]);
  });

  it("accepts a conflict whose duplicate member is redirected to a distinct kept finding", () => {
    const outcome = run({
      findings: [docFinding("f1"), docFinding("f2"), codeFinding("f3")],
      conflicts: [{ key: "c1", description: "Docs and code disagree.", findings: ["f2", "f3"] }],
    });
    expect(events(outcome)).toEqual([["f2", "cross_item", "DUP-001"]]);
    expect(outcome.conflictMembers.get("c1")).toEqual(["f1", "f3"]);
  });

  it("redirects a restated known fact to its F alias, whose evidence SUP-005 uses", () => {
    const fact = {
      key: "f1",
      statement: "`package.json` defines the script `test`.",
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [{ item: "T2-001", lines: "2-2", quote: "Run the test suite with pnpm" }],
    };
    const outcome = run({
      findings: [fact, docFinding("f2")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["f1", "f2"] }],
    });
    expect(events(outcome)).toEqual([["f1", "cross_item", "DUP-002"]]);
    expect(outcome.conflictMembers.get("c1")).toEqual(["F-1", "f2"]);
  });

  it("CONF-001 rejects a conflict with a member that failed validation, then SUP-005 runs", () => {
    const bad = {
      ...codeFinding("f2"),
      citations: [{ item: "T9-001", lines: "1-1", quote: "x".repeat(12) }],
    };
    const sameSource = docFinding("f3", "The guide names a shared client.");
    const outcome = run({
      findings: [docFinding("f1"), bad, sameSource],
      conflicts: [
        { key: "c1", description: "x disagrees", findings: ["f1", "f2"] },
        { key: "c2", description: "y disagrees", findings: ["f1", "f3"] },
      ],
    });
    expect(events(outcome).filter((e) => e[1] === "cross_item")).toEqual([
      ["c1", "cross_item", "CONF-001"],
      ["c2", "cross_item", "SUP-005"],
    ]);
  });

  it("ALIAS-003 rejects a known fact's F alias written as a conflict member in call 1", () => {
    const outcome = run({
      findings: [docFinding("f1")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["f1", "F-1"] }],
    });
    expect(events(outcome)).toEqual([["c1", "item", "ALIAS-003"]]);
  });
});

describe("expansion requests (IMPL §3.3.2 step 9)", () => {
  it("LIMIT-002 rejects requests beyond maxExpansionRequests in response order", () => {
    const read = { kind: "read", entries: [{ path: "src/other.ts" }], reason: "see it" };
    const invalid = { kind: "read", entries: [{ path: "missing.ts" }], reason: "see it" };
    const outcome = run({ expansionRequests: [invalid, read, read] });
    expect(events(outcome)).toEqual([
      ["expansionRequests/0", "item", "EXP-001"],
      ["expansionRequests/2", "item", "LIMIT-002"],
    ]);
  });
});

describe("content notices (IMPL §3.3.2 step 10)", () => {
  const notice = (item: string, lines: string) => ({
    item,
    lines,
    description: "text instructs the reader to ignore prior rules",
  });

  it("accepts a notice on sent lines, and rejects unknown items, other kinds, unsent lines", () => {
    const outcome = run({
      contentNotices: [
        notice("T2-001", "2-3"),
        notice("T7-001", "1-1"),
        notice("B-1", "1-1"),
        notice("T5-002", "1-1"),
        notice("T2-001", "4-5"),
        notice("T2-001", "3-2"),
      ],
    });
    expect(events(outcome)).toEqual([
      ["contentNotices/1", "item", "CIT-001"],
      ["contentNotices/2", "item", "ALIAS-003"],
      ["contentNotices/3", "item", "CIT-006"],
      ["contentNotices/4", "item", "CIT-003"],
      ["contentNotices/5", "item", "CIT-003"],
    ]);
    expect(keys(outcome, "contentNotices")).toEqual(["contentNotices/0"]);
  });
});

describe("content notices naming a local key (IMPL §3.3.2 step 10)", () => {
  it("ALIAS-003 rejects a notice whose item is a local key the response defines", () => {
    const outcome = run({
      findings: [docFinding("f1")],
      contentNotices: [{ item: "f1", lines: "1-1", description: "reads as an instruction" }],
    });
    expect(events(outcome)).toEqual([["contentNotices/0", "item", "ALIAS-003"]]);
  });
});

describe("corrected-citation rate (IMPL §3.2.2)", () => {
  it("counts CIT-R01 events over every proposed citation, rejected findings included", () => {
    const shifted = {
      ...docFinding("f1"),
      citations: [
        { item: "T2-001", lines: "2-2", quote: "fetch data through the shared client" },
        { item: "T2-001", lines: "3-3", quote: "fetch data through the shared client" },
      ],
    };
    const dropped = { ...codeFinding("f2"), statement: "Most calls use fetch." };
    const outcome = run({ findings: [shifted, dropped] });
    expect(events(outcome)).toEqual([
      ["f1/citations/0", "item", "CIT-R01"],
      ["f1/citations/1", "item", "CIT-009"],
      ["f2", "item", "SUP-002"],
    ]);
    expect(outcome.correctedCitationRate).toEqual({
      state: "known",
      corrected: 1,
      proposed: 3,
      rate: 1 / 3,
    });
  });

  it("is unknown with no_citations when no finding was proposed", () => {
    expect(run({ gaps: [] }).correctedCitationRate).toEqual({
      state: "unknown",
      reason: "no_citations",
    });
  });

  it("is unknown with schema_failed when the response fails the schema", () => {
    const outcome = validateAnalyse("{", analyseContext(fixture));
    expect(outcome.correctedCitationRate).toEqual({ state: "unknown", reason: "schema_failed" });
  });
});

describe("determinism (IMPL §3.8)", () => {
  it("gives identical results for inputs listed in reverse order", () => {
    const parts = {
      findings: [docFinding("f1"), docFinding("f2"), codeFinding("f3")],
      conflicts: [{ key: "c1", description: "Docs and code disagree.", findings: ["f2", "f3"] }],
      expansionRequests: [{ kind: "search", literal: "getUser", glob: "src/**", reason: "uses" }],
    };
    const a = run(parts);
    const b = run(parts, true);
    expect(b.result).toEqual(a.result);
    expect(b.conflictMembers).toEqual(a.conflictMembers);
  });
});
