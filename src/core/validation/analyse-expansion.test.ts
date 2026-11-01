import { describe, expect, it } from "vitest";
import {
  analyseExpansionContext,
  type FixtureContext,
} from "../../../test/support/call-context.js";
import { validateAnalyseExpansion } from "./analyse-expansion.js";

// `analyse_expansion` item validation (IMPL §3.3.3): revisions, conflicts naming call-1
// findings, and what accepted revisions do to the call-1 conflicts.

const guide = [
  "# Guide",
  "Components fetch data through the shared client.",
  "Lint runs through Biome in CI.",
];
const client = [
  "export async function getUser(id: string) {",
  "  return fetch('/api/users/' + id);",
];
const api = ["export const api = createClient({ baseUrl: '/api' });"];

const fixture: FixtureContext = {
  files: [
    { path: "docs/guide.md", status: "read" },
    { path: "src/client.ts", status: "read" },
    { path: "src/api.ts", status: "read" },
    { path: "package.json", status: "read" },
  ],
  ignoreRules: { state: "applied" },
  items: [
    {
      alias: "T2-001",
      path: "docs/guide.md",
      basis: "documentation",
      totalLines: 3,
      sent: [{ first: 1, lines: guide }],
    },
    {
      alias: "T5-001",
      path: "src/client.ts",
      basis: "code_observation",
      totalLines: 2,
      sent: [{ first: 1, lines: client }],
    },
    {
      alias: "E-1",
      path: "src/api.ts",
      basis: "code_observation",
      totalLines: 1,
      sent: [{ first: 1, lines: api }],
    },
  ],
  knownFacts: [
    {
      alias: "F-1",
      statement: "`package.json` defines the script `test`.",
      scope: { kind: "repository" },
      evidencePaths: ["package.json"],
    },
  ],
  findings: [
    {
      alias: "F-2",
      statement: "The guide asks for the shared client.",
      scope: { kind: "repository" },
      evidencePaths: ["docs/guide.md"],
    },
    {
      alias: "F-3",
      statement: "The user lookup calls fetch directly.",
      scope: { kind: "paths", paths: ["src/client.ts"] },
      evidencePaths: ["src/client.ts"],
    },
    {
      alias: "F-4",
      statement: "Lint runs through Biome.",
      scope: { kind: "repository" },
      evidencePaths: ["docs/guide.md"],
    },
  ],
  conflicts: [
    { alias: "C-1", members: ["F-2", "F-3"] },
    { alias: "C-2", members: ["F-3", "F-4"] },
  ],
};

const apiFinding = (key: string) => ({
  key,
  statement: "The API module creates a client with a base URL.",
  mode: "descriptive",
  scope: { kind: "paths", paths: ["src/api.ts"] },
  citations: [{ item: "E-1", lines: "1-1", quote: "createClient({ baseUrl" }],
});
const guideFinding = (key: string, statement = "The guide asks for the shared client.") => ({
  key,
  statement,
  mode: "descriptive",
  scope: { kind: "repository" },
  citations: [{ item: "T2-001", lines: "2-2", quote: "fetch data through the shared client" }],
});
const withdraw = (target: string) => ({ target, action: "withdraw", reason: "not supported" });
const replace = (target: string, replacement: string) => ({
  target,
  action: "replace",
  replacement,
  reason: "more precise",
});

const run = (parts: Record<string, unknown[]>, reversed = false) =>
  validateAnalyseExpansion(
    JSON.stringify({
      findings: [],
      gaps: [],
      absenceClaims: [],
      conflicts: [],
      revisions: [],
      contentNotices: [],
      ...parts,
    }),
    analyseExpansionContext(fixture, reversed),
  );

const events = (outcome: ReturnType<typeof run>) =>
  outcome.result.events.map((e) => [e.itemKey, e.stage, e.rule]);

describe("revisions (IMPL §3.3.3)", () => {
  it("REV-002 rejects a withdrawal or replacement of a known fact", () => {
    const outcome = run({ findings: [apiFinding("f1")], revisions: [withdraw("F-1")] });
    expect(events(outcome)).toEqual([["F-1", "item", "REV-002"]]);
  });

  it("ALIAS-003 rejects a finding replaced by a conflict key, or a target of another kind", () => {
    const outcome = run({
      findings: [apiFinding("f1"), guideFinding("f2", "The guide wants one client.")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["f1", "f2"] }],
      revisions: [replace("F-3", "c1"), withdraw("E-1"), replace("C-1", "f1")],
    });
    expect(events(outcome)).toEqual([
      ["F-3", "item", "ALIAS-003"],
      ["E-1", "item", "ALIAS-003"],
      ["C-1", "item", "ALIAS-003"],
    ]);
  });

  it("REV-003 keeps the first revision of a target", () => {
    const outcome = run({
      findings: [apiFinding("f1")],
      revisions: [withdraw("F-4"), replace("F-4", "f1")],
    });
    expect(events(outcome)).toEqual([["F-4", "cross_item", "REV-003"]]);
    expect(
      outcome.result.status === "validated" && outcome.result.accepted.revisions[0]?.value,
    ).toEqual(withdraw("F-4"));
  });

  it("REV-001 rejects a replacement that failed validation, keeping the original", () => {
    const bad = { ...apiFinding("f1"), statement: "Most modules create a client." };
    const outcome = run({ findings: [bad], revisions: [replace("F-3", "f1")] });
    expect(events(outcome)).toEqual([
      ["f1", "item", "SUP-002"],
      ["F-3", "cross_item", "REV-001"],
    ]);
    expect(outcome.conflictOutcomes).toEqual([]);
  });

  it("REV-001 rejects a conflict replacement that failed CONF-001", () => {
    const outcome = run({
      findings: [apiFinding("f1")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["f1", "F-4"] }],
      revisions: [withdraw("F-4"), replace("C-2", "c1")],
    });
    expect(events(outcome)).toEqual([
      ["c1", "cross_item", "CONF-001"],
      ["C-2", "cross_item", "REV-001"],
    ]);
  });

  it("REV-001 rejects a replacement that is a duplicate of a call-1 finding", () => {
    const outcome = run({ findings: [guideFinding("f1")], revisions: [replace("F-4", "f1")] });
    expect(events(outcome)).toEqual([
      ["f1", "cross_item", "DUP-001"],
      ["F-4", "cross_item", "REV-001"],
    ]);
  });
});

describe("duplicates against call-1 findings (IMPL §3.3.3)", () => {
  it("DUP-001 drops a restatement of a call-1 finding and redirects it to the F alias", () => {
    const outcome = run({
      findings: [guideFinding("f1"), apiFinding("f2")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["f1", "f2"] }],
    });
    expect(events(outcome)).toEqual([["f1", "cross_item", "DUP-001"]]);
    expect(outcome.conflictMembers.get("c1")).toEqual(["F-2", "f2"]);
  });

  it("does not compare with a call-1 finding the response replaces", () => {
    const outcome = run({ findings: [guideFinding("f1")], revisions: [replace("F-2", "f1")] });
    expect(events(outcome)).toEqual([]);
  });
});

describe("conflict members through revisions (IMPL §3.3.3)", () => {
  it("CONF-001 rejects a new conflict whose F member is withdrawn", () => {
    const outcome = run({
      findings: [apiFinding("f1")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["F-3", "f1"] }],
      revisions: [withdraw("F-3")],
    });
    expect(events(outcome)).toEqual([["c1", "cross_item", "CONF-001"]]);
  });

  it("gives a replaced member's place to its replacement in a new conflict", () => {
    const outcome = run({
      findings: [apiFinding("f1")],
      conflicts: [{ key: "c1", description: "x disagrees", findings: ["F-2", "F-3"] }],
      revisions: [replace("F-3", "f1")],
    });
    expect(events(outcome)).toEqual([]);
    expect(outcome.conflictMembers.get("c1")).toEqual(["F-2", "f1"]);
  });

  it("marks a call-1 conflict that loses a member below two as withdrawn", () => {
    const outcome = run({ revisions: [withdraw("F-2")] });
    expect(outcome.conflictOutcomes).toEqual([
      { alias: "C-1", status: "withdrawn", reason: "member withdrawn" },
    ]);
  });

  it("checks SUP-005 again when a replacement inherits a call-1 conflict's member", () => {
    // F-3 is replaced by a finding citing only the guide, which C-2's other member also cites.
    const outcome = run({
      findings: [guideFinding("f1", "The guide names one shared client.")],
      revisions: [replace("F-3", "f1")],
    });
    expect(outcome.conflictOutcomes).toEqual([
      { alias: "C-1", status: "withdrawn", reason: "sources not distinct" },
      { alias: "C-2", status: "withdrawn", reason: "sources not distinct" },
    ]);
  });

  it("keeps a call-1 conflict whose replacement member still has distinct sources", () => {
    const outcome = run({ findings: [apiFinding("f1")], revisions: [replace("F-3", "f1")] });
    expect(outcome.conflictOutcomes).toEqual([
      { alias: "C-1", status: "kept", members: ["F-2", "f1"] },
      { alias: "C-2", status: "kept", members: ["f1", "F-4"] },
    ]);
  });

  it("reports a call-1 conflict that loses a member but keeps two, with its new members", () => {
    const wide = { ...fixture, conflicts: [{ alias: "C-1", members: ["F-2", "F-3", "F-4"] }] };
    const outcome = validateAnalyseExpansion(
      JSON.stringify({
        findings: [],
        gaps: [],
        absenceClaims: [],
        conflicts: [],
        revisions: [withdraw("F-4")],
        contentNotices: [],
      }),
      analyseExpansionContext(wide),
    );
    expect(outcome.conflictOutcomes).toEqual([
      { alias: "C-1", status: "kept", members: ["F-2", "F-3"] },
    ]);
  });

  it("leaves out call-1 conflicts a revision targets or doesn't affect", () => {
    const outcome = run({ revisions: [withdraw("C-1"), withdraw("F-4")] });
    expect(outcome.conflictOutcomes).toEqual([
      { alias: "C-2", status: "withdrawn", reason: "member withdrawn" },
    ]);
  });
});

describe("determinism (IMPL §3.8)", () => {
  it("gives identical results for inputs listed in reverse order", () => {
    const parts = { findings: [apiFinding("f1")], revisions: [replace("F-3", "f1")] };
    const a = run(parts);
    const b = run(parts, true);
    expect(b.result).toEqual(a.result);
    expect(b.conflictOutcomes).toEqual(a.conflictOutcomes);
  });
});
