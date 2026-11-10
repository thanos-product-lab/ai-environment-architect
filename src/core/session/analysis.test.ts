import { describe, expect, it } from "vitest";
import {
  analyseContext,
  analyseExpansionContext,
  type FixtureContext,
} from "../../../test/support/call-context.js";
import { hashOf, newLog } from "../../../test/support/session.js";
import type { KnownFact } from "../facts/known-facts.js";
import { createAliasTable } from "../validation/aliases.js";
import { validateAnalyse } from "../validation/analyse.js";
import {
  type AnalyseExpansionContext,
  validateAnalyseExpansion,
} from "../validation/analyse-expansion.js";
import {
  type CallRecording,
  recordAnalyse,
  recordAnalyseExpansion,
  recordKnownFacts,
  resolveConflict,
} from "./analysis.js";
import { recordFailedRecommendationRevision } from "./failed.js";
import type { SessionLog } from "./log.js";
import {
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionRecord,
  sessionFile,
} from "./records.js";
import { serialiseSession } from "./serialise.js";

// Model output into records (IMPL §4.4.3, §4.5): accepted findings with code-made evidence,
// one failed record per rejected item, and the `analyse_expansion` outcomes.

const SNAP = "snap_0001";
const CALL = "call_0001";
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
    { path: "package.json", status: "read" },
    { path: "node_modules", status: "excluded", kind: "directory", rule: "node_modules/" },
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
  ],
  knownFacts: [
    {
      alias: "F-1",
      statement: "`package.json` defines the script `test`.",
      scope: { kind: "repository" },
      evidencePaths: ["package.json"],
    },
  ],
};

const docFinding = (key: string, lines = "3-3") => ({
  key,
  statement: "The guide asks for the shared client.",
  mode: "descriptive",
  scope: { kind: "repository" },
  citations: [{ item: "T2-001", lines, quote: "fetch data through the shared client" }],
});
const codeFinding = (key: string) => ({
  key,
  statement: "The user lookup calls fetch directly.",
  mode: "descriptive",
  scope: { kind: "paths", paths: ["src/client.ts"] },
  citations: [{ item: "T5-001", lines: "2-2", quote: "return fetch('/api/users/" }],
});

const analyseResponse = (parts: Record<string, unknown[]>) =>
  JSON.stringify({
    findings: [],
    gaps: [],
    absenceClaims: [],
    conflicts: [],
    expansionRequests: [],
    contentNotices: [],
    ...parts,
  });

const FACT: KnownFact = {
  kind: "claim",
  mode: "descriptive",
  producedBy: "deterministic",
  statement: "`package.json` defines the script `test`.",
  scope: { kind: "repository" },
  evidence: [
    { kind: "entry", path: "package.json", fileHash: hashOf("5a"), basis: "code_observation" },
  ],
  basis: ["code_observation"],
  fact: {
    type: "command",
    file: "package.json",
    kind: "script",
    name: "test",
    status: "found_not_run",
  },
};

function snapshot(log: SessionLog) {
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [],
      destination: { state: "absent" },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    },
    { id: SNAP },
  );
}

/** A log with the snapshot and the known fact, and an analyse call whose F-1 is that fact. */
function analyseCall() {
  const log = newLog();
  snapshot(log);
  const [factRecord] = recordKnownFacts(log, SNAP, [FACT], []);
  const context = analyseContext(fixture);
  const aliases = createAliasTable("analyse", {
    items: ["T2-001", "T5-001"],
    findings: [factRecord as string],
  });
  const call: CallRecording = {
    log,
    snapshotId: SNAP,
    modelCallId: CALL,
    context: { ...context, aliases },
  };
  const validate = (parts: Record<string, unknown[]>) =>
    validateAnalyse(analyseResponse(parts), { ...context, aliases });
  return { log, call, validate };
}

const appended = (log: SessionLog, from: number) => log.records.slice(from);
const ofType = <T extends SessionRecord["type"]>(records: readonly SessionRecord[], type: T) =>
  records.filter((r): r is Extract<SessionRecord, { type: T }> => r.type === type);

describe("known facts (IMPL §3.2.5, §4.5)", () => {
  it("are findings produced by code, with entry or line evidence and their fact detail", () => {
    const log = newLog();
    snapshot(log);
    const ids = recordKnownFacts(
      log,
      SNAP,
      [FACT],
      [
        {
          gapType: "other",
          statement: "`Makefile` could not be read or parsed, so its commands are not known facts.",
          relatedPaths: ["Makefile"],
        },
      ],
    );
    const [evidence, fact, gap] = appended(log, 1);
    expect(evidence).toMatchObject({
      type: "evidence",
      kind: "entry",
      snapshotId: SNAP,
      path: "package.json",
      basis: "code_observation",
    });
    expect(fact).toMatchObject({
      type: "finding",
      kind: "claim",
      producedBy: "deterministic",
      status: "active",
      evidenceIds: [evidence?.id],
      basis: ["code_observation"],
      fact: { type: "command", name: "test" },
    });
    expect(gap).toMatchObject({
      type: "finding",
      kind: "gap",
      producedBy: "deterministic",
      evidenceIds: [],
      coverage: { state: "not_inspected" },
    });
    expect(ids).toEqual([fact?.id, gap?.id]);
  });
});

describe("analyse records (IMPL §4.4.3, §4.5)", () => {
  it("an accepted finding gets one evidence record per accepted citation, with its basis", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    const keys = recordAnalyse(call, validate({ findings: [docFinding("f1")] }));
    const records = appended(log, from);
    const [evidence, finding] = records;
    expect(evidence).toMatchObject({
      type: "evidence",
      kind: "lines",
      snapshotId: SNAP,
      path: "docs/guide.md",
      lineStart: 3,
      lineEnd: 3,
      excerpt: "Components fetch data through the shared client.",
      basis: "documentation",
    });
    expect(finding).toMatchObject({
      type: "finding",
      kind: "claim",
      status: "active",
      revision: 1,
      snapshotId: SNAP,
      producedBy: CALL,
      statement: "The guide asks for the shared client.",
      basis: ["documentation"],
      evidenceIds: [evidence?.id],
      droppedCitations: 0,
    });
    expect(finding).not.toHaveProperty("failedCitations");
    expect(keys.findings.get("f1")).toBe((finding as { findingId: string }).findingId);
  });

  it("a CIT-R01 correction is recorded on the evidence with both ranges", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    recordAnalyse(call, validate({ findings: [docFinding("f1", "2-2")] }));
    expect(ofType(appended(log, from), "evidence")[0]).toMatchObject({
      lineStart: 3,
      lineEnd: 3,
      correction: { originalLines: "2-2", correctedLines: "3-3" },
    });
  });

  it("keeps failed and merged citations of an accepted finding, as proposed, with their rules", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    const good = docFinding("f1").citations[0];
    const missing = { item: "T2-001", lines: "1-1", quote: "this text is in no line at all" };
    recordAnalyse(
      call,
      validate({ findings: [{ ...docFinding("f1"), citations: [good, missing, good] }] }),
    );
    const records = appended(log, from);
    expect(ofType(records, "evidence")).toHaveLength(1);
    expect(ofType(records, "finding")[0]).toMatchObject({
      droppedCitations: 2,
      failedCitations: [
        { ...missing, rejectedBy: ["CIT-004"] },
        { ...good, rejectedBy: ["CIT-009"] },
      ],
    });
  });

  it("a gap keeps its coverage and has no evidence", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    recordAnalyse(
      call,
      validate({
        gaps: [
          {
            key: "g1",
            statement: "No lint command is documented.",
            gapType: "no_command",
            relatedPaths: ["src/client.ts"],
          },
        ],
      }),
    );
    const records = appended(log, from);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "finding",
      kind: "gap",
      gapType: "no_command",
      relatedPaths: ["src/client.ts"],
      coverage: { state: "inspected" },
      evidenceIds: [],
    });
  });

  it("an accepted absence claim gets one absence_check evidence record, made by code", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    recordAnalyse(
      call,
      validate({
        absenceClaims: [{ key: "a1", pathGlob: "./test/**/*.test.ts", reason: "none seen" }],
      }),
    );
    const [evidence, finding] = appended(log, from);
    expect(evidence).toEqual({
      type: "evidence",
      id: evidence?.id,
      seq: evidence?.seq,
      createdAt: evidence?.createdAt,
      snapshotId: SNAP,
      kind: "absence_check",
      pathGlob: "test/**/*.test.ts",
      unenteredDirectories: [],
      basis: "code_observation",
    });
    expect(finding).toMatchObject({
      type: "finding",
      kind: "absence",
      statement: "No files matched `./test/**/*.test.ts` within the inspected scope.",
      pathGlob: "./test/**/*.test.ts",
      reason: "none seen",
      basis: ["code_observation"],
      evidenceIds: [evidence?.id],
    });
  });

  it("absence_check evidence names the unentered directories the glob could reach", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    recordAnalyse(
      call,
      validate({ absenceClaims: [{ key: "a1", pathGlob: "**/*.test.ts", reason: "none seen" }] }),
    );
    expect(ofType(appended(log, from), "evidence")[0]).toMatchObject({
      unenteredDirectories: [{ path: "node_modules" }],
    });
  });

  it("a conflict names its members by finding lineage ID", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    const keys = recordAnalyse(
      call,
      validate({
        findings: [docFinding("f1"), codeFinding("f2")],
        conflicts: [{ key: "c1", description: "Docs and code disagree.", findings: ["f1", "f2"] }],
      }),
    );
    const [conflict] = ofType(appended(log, from), "conflict");
    expect(conflict).toMatchObject({
      revision: 1,
      snapshotId: SNAP,
      producedBy: CALL,
      status: "unresolved",
      description: "Docs and code disagree.",
      findingIds: [keys.findings.get("f1"), keys.findings.get("f2")],
    });
    expect(keys.conflicts.get("c1")).toBe((conflict as { conflictId: string }).conflictId);
  });

  it("a valid content notice becomes a content_notice record, resolved by code to its file", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    recordAnalyse(
      call,
      validate({
        contentNotices: [{ item: "T2-001", lines: "1-2", description: "reads as an instruction" }],
      }),
    );
    expect(appended(log, from)).toEqual([
      expect.objectContaining({
        type: "content_notice",
        snapshotId: SNAP,
        modelCallId: CALL,
        item: "T2-001",
        path: "docs/guide.md",
        fileHash: hashOf("5a"),
        lineStart: 1,
        lineEnd: 2,
        description: "reads as an instruction",
      }),
    ]);
  });

  it("every rejected item becomes exactly one failed record, as written, with no evidence", () => {
    const { log, call, validate } = analyseCall();
    const from = log.records.length;
    const noCitation = {
      ...docFinding("f2"),
      citations: [{ item: "T2-001", lines: "1-1", quote: "this text is in no line at all" }],
    };
    const validation = validate({
      findings: [docFinding("f1"), noCitation, docFinding("f3")],
      gaps: [
        {
          key: "g1",
          statement: "Nothing about tools.",
          gapType: "other",
          relatedPaths: ["tools/x.sh"],
        },
      ],
      conflicts: [{ key: "c1", description: "Disagree.", findings: ["f1", "f2"] }],
      expansionRequests: [
        { kind: "search", literal: "createClient", glob: "../x", reason: "find it" },
      ],
      contentNotices: [{ item: "T9-001", lines: "1-1", description: "x" }],
    });
    if (validation.result.status !== "validated") throw new Error("schema");
    const rejected = validation.result.rejected;
    recordAnalyse(call, validation);
    const records = appended(log, from);
    const failed = records.filter((r) => "status" in r && r.status === "failed_validation");
    expect(failed.map((r) => [r.type, (r as { itemKey: string }).itemKey])).toEqual(
      rejected.map((item) => [
        { findings: "finding", gaps: "finding", conflicts: "conflict" }[item.collection] ??
          "failed_item",
        item.key,
      ]),
    );
    expect(failed).toHaveLength(6);
    expect(failed.find((r) => (r as { itemKey: string }).itemKey === "f2")).toEqual({
      type: "finding",
      id: expect.stringMatching(/^fndr_/),
      seq: expect.any(Number),
      createdAt: expect.any(String),
      kind: "claim",
      status: "failed_validation",
      producedBy: CALL,
      itemKey: "f2",
      rejectedBy: ["CIT-008"],
      proposed: noCitation,
    });
    expect(failed.find((r) => (r as { itemKey: string }).itemKey === "f3")).toMatchObject({
      rejectedBy: ["DUP-001"],
      proposed: docFinding("f3"),
    });
    expect(
      failed.find((r) => r.type === "failed_item" && r.collection === "expansionRequests"),
    ).toMatchObject({
      itemKey: "expansionRequests/0",
    });
    expect(failed.find((r) => r.type === "finding" && r.kind === "gap")).toMatchObject({
      itemKey: "g1",
    });
    // Evidence only for the accepted finding f1.
    expect(ofType(records, "evidence")).toHaveLength(1);
  });

  it("a response that fails the schema creates no records", () => {
    const { log, call } = analyseCall();
    const from = log.records.length;
    recordAnalyse(call, validateAnalyse("{ not json", call.context as never));
    expect(appended(log, from)).toEqual([]);
  });
});

// --- analyse_expansion --------------------------------------------------------------------

const api = ["export const api = createClient({ baseUrl: '/api' });"];
const expansionFixture: FixtureContext = {
  ...fixture,
  items: [
    ...(fixture.items ?? []),
    {
      alias: "E-1",
      path: "src/api.ts",
      basis: "code_observation",
      totalLines: 1,
      sent: [{ first: 1, lines: api }],
    },
  ],
  files: [...fixture.files, { path: "src/api.ts", status: "read" }],
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
const withdraw = (target: string) => ({ target, action: "withdraw", reason: "not supported" });
const replace = (target: string, replacement: string) => ({
  target,
  action: "replace",
  replacement,
  reason: "more precise",
});

/** Call 1's records in the log, and a call-2 context whose F and C aliases name them. */
function expansionCall() {
  const { log, call, validate } = analyseCall();
  const call1 = recordAnalyse(
    call,
    validate({
      findings: [
        docFinding("f1"),
        codeFinding("f2"),
        {
          key: "f3",
          statement: "Lint runs through Biome.",
          mode: "descriptive",
          scope: { kind: "repository" },
          citations: [{ item: "T2-001", lines: "4-4", quote: "Lint runs through Biome in CI." }],
        },
      ],
      conflicts: [
        { key: "c1", description: "Docs and code disagree.", findings: ["f1", "f2"] },
        { key: "c2", description: "Lint and lookup disagree.", findings: ["f2", "f3"] },
      ],
    }),
  );
  const current = (type: "finding" | "conflict", lineage: string | undefined) =>
    log.revisions(type, lineage as string).at(-1)?.id as string;
  const fact = ofType(log.records, "finding")[0]?.id as string;
  const findings = [
    fact,
    ...["f1", "f2", "f3"].map((k) => current("finding", call1.findings.get(k))),
  ];
  const conflicts = ["c1", "c2"].map((k) => current("conflict", call1.conflicts.get(k)));
  const base = analyseExpansionContext(expansionFixture);
  const context: AnalyseExpansionContext = {
    ...base,
    aliases: createAliasTable("analyse_expansion", {
      items: ["T2-001", "T5-001", "E-1"],
      findings,
      conflicts,
    }),
  };
  const recording: CallRecording = { log, snapshotId: SNAP, modelCallId: "call_0002", context };
  const run = (parts: Record<string, unknown[]>) =>
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
      context,
    );
  return { log, recording, run, findings, conflicts, call1 };
}

describe("analyse_expansion outcomes (IMPL §4.5)", () => {
  it("kept creates nothing", () => {
    const { log, recording, run } = expansionCall();
    const from = log.records.length;
    const validation = run({});
    expect(validation.conflictOutcomes.map((o) => o.status)).toEqual(["kept", "kept"]);
    recordAnalyseExpansion(recording, validation);
    expect(appended(log, from)).toEqual([]);
  });

  it("a finding withdraw appends its next revision, withdrawn_by_model; a lost member withdraws the conflict", () => {
    const { log, recording, run, findings, conflicts } = expansionCall();
    const from = log.records.length;
    const validation = run({ revisions: [withdraw("F-4")] });
    expect(validation.conflictOutcomes).toEqual([
      { alias: "C-1", status: "kept" },
      { alias: "C-2", status: "withdrawn", withdrawnReason: "member_withdrawn" },
    ]);
    recordAnalyseExpansion(recording, validation);
    const [finding, conflict] = appended(log, from);
    expect(finding).toMatchObject({
      type: "finding",
      revision: 2,
      supersedes: [findings[3]],
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
      statement: "Lint runs through Biome.",
      producedBy: CALL,
      revisedBy: "call_0002",
    });
    expect(conflict).toMatchObject({
      type: "conflict",
      revision: 2,
      supersedes: [conflicts[1]],
      status: "withdrawn",
      withdrawnReason: "member_withdrawn",
      producedBy: CALL,
      revisedBy: "call_0002",
    });
  });

  it("a finding replace starts a new lineage that supersedes the target; conflicts are revised", () => {
    const { log, recording, run, findings, conflicts } = expansionCall();
    const from = log.records.length;
    const validation = run({ findings: [apiFinding("f1")], revisions: [replace("F-3", "f1")] });
    expect(validation.conflictOutcomes.map((o) => o.status)).toEqual(["revised", "revised"]);
    const keys = recordAnalyseExpansion(recording, validation);
    const records = appended(log, from);
    const replacement = ofType(records, "finding")[0];
    expect(replacement).toMatchObject({
      revision: 1,
      supersedes: [findings[2]],
      producedBy: "call_0002",
    });
    const newId = keys.findings.get("f1");
    expect((replacement as { findingId: string }).findingId).toBe(newId);
    const lineage = (id: string) => (log.get(id) as { findingId: string }).findingId;
    const revised = ofType(records, "conflict");
    expect(revised).toEqual([
      expect.objectContaining({
        revision: 2,
        supersedes: [conflicts[0]],
        status: "unresolved",
        findingIds: [lineage(findings[1] as string), newId],
        producedBy: "call_0001",
        revisedBy: "call_0002",
      }),
      expect.objectContaining({
        revision: 2,
        supersedes: [conflicts[1]],
        findingIds: [newId, lineage(findings[3] as string)],
      }),
    ]);
  });

  it("a conflict replace starts a new conflict lineage superseding the one it replaces", () => {
    const { log, recording, run, conflicts } = expansionCall();
    const from = log.records.length;
    const validation = run({
      conflicts: [
        {
          key: "c1",
          description: "The API module and the lookup disagree.",
          findings: ["F-2", "F-3"],
        },
      ],
      revisions: [replace("C-1", "c1")],
    });
    expect(validation.conflictOutcomes[0]).toEqual({
      alias: "C-1",
      status: "replaced",
      replacement: "c1",
    });
    const keys = recordAnalyseExpansion(recording, validation);
    const [conflict] = appended(log, from);
    expect(conflict).toMatchObject({
      type: "conflict",
      revision: 1,
      supersedes: [conflicts[0]],
      conflictId: keys.conflicts.get("c1"),
      producedBy: "call_0002",
      description: "The API module and the lookup disagree.",
    });
  });

  it("a conflict withdraw appends a withdrawn revision with withdrawn_by_model", () => {
    const { log, recording, run, conflicts } = expansionCall();
    const from = log.records.length;
    recordAnalyseExpansion(recording, run({ revisions: [withdraw("C-2")] }));
    expect(appended(log, from)).toEqual([
      expect.objectContaining({
        type: "conflict",
        supersedes: [conflicts[1]],
        status: "withdrawn",
        withdrawnReason: "withdrawn_by_model",
      }),
    ]);
  });

  it("a rejected revision is a failed_item, and changes nothing", () => {
    const { log, recording, run } = expansionCall();
    const from = log.records.length;
    recordAnalyseExpansion(recording, run({ revisions: [withdraw("F-1")] }));
    expect(appended(log, from)).toEqual([
      expect.objectContaining({
        type: "failed_item",
        collection: "revisions",
        itemKey: "revisions/0",
        rejectedBy: ["REV-002"],
        proposed: withdraw("F-1"),
      }),
    ]);
  });

  it("resolution by a decision appends the next revision, resolved, with resolvingDecisionId", () => {
    const { log, call1, conflicts } = expansionCall();
    const conflictId = call1.conflicts.get("c1") as string;
    const decision = log.append({
      type: "decision",
      statement: "Use the shared client.",
      scope: { kind: "repository" },
      exceptions: [],
      conflictId,
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    const resolved = resolveConflict(log, conflictId, decision.id);
    expect(resolved).toMatchObject({
      revision: 2,
      supersedes: [conflicts[0]],
      status: "resolved",
      resolvingDecisionId: decision.id,
    });
    // The decision, not a model call, made this revision.
    expect(resolved).not.toHaveProperty("revisedBy");
  });

  it("revisedBy is never repeated: a resolution after a model revision drops it", () => {
    const { log, recording, run, call1 } = expansionCall();
    recordAnalyseExpansion(
      recording,
      run({ findings: [apiFinding("f1")], revisions: [replace("F-3", "f1")] }),
    );
    const conflictId = call1.conflicts.get("c1") as string;
    expect(log.revisions("conflict", conflictId).at(-1)).toMatchObject({ revisedBy: "call_0002" });
    const decision = log.append({
      type: "decision",
      statement: "Use the shared client.",
      scope: { kind: "repository" },
      exceptions: [],
      conflictId,
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    expect(resolveConflict(log, conflictId, decision.id)).not.toHaveProperty("revisedBy");
  });
});

describe("analyse_expansion outcomes, merged and indistinct members (IMPL §4.5)", () => {
  it("one replacement for two findings supersedes both, and their conflict is withdrawn as members_merged", () => {
    const { log, recording, run, findings, conflicts } = expansionCall();
    const from = log.records.length;
    const merged = {
      key: "f1",
      statement: "Data access goes through fetch and the shared client.",
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [
        { item: "T2-001", lines: "3-3", quote: "fetch data through the shared client" },
        { item: "T5-001", lines: "2-2", quote: "return fetch('/api/users/" },
      ],
    };
    const validation = run({
      findings: [merged],
      revisions: [replace("F-2", "f1"), replace("F-3", "f1")],
    });
    expect(validation.conflictOutcomes[0]).toEqual({
      alias: "C-1",
      status: "withdrawn",
      withdrawnReason: "members_merged",
    });
    recordAnalyseExpansion(recording, validation);
    const records = appended(log, from);
    expect(ofType(records, "finding")[0]).toMatchObject({
      revision: 1,
      supersedes: [findings[1], findings[2]],
    });
    expect(ofType(records, "conflict")[0]).toMatchObject({
      supersedes: [conflicts[0]],
      status: "withdrawn",
      withdrawnReason: "members_merged",
    });
  });

  it("a replacement that leaves two members with one source withdraws the conflict as sources_not_distinct", () => {
    const { log, recording, run, conflicts } = expansionCall();
    const from = log.records.length;
    const sameSource = {
      key: "f1",
      statement: "The guide says to run the test suite with pnpm.",
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [{ item: "T2-001", lines: "2-2", quote: "Run the test suite with pnpm" }],
    };
    const validation = run({ findings: [sameSource], revisions: [replace("F-3", "f1")] });
    expect(validation.conflictOutcomes[0]).toEqual({
      alias: "C-1",
      status: "withdrawn",
      withdrawnReason: "sources_not_distinct",
    });
    recordAnalyseExpansion(recording, validation);
    expect(ofType(appended(log, from), "conflict")[0]).toMatchObject({
      supersedes: [conflicts[0]],
      status: "withdrawn",
      withdrawnReason: "sources_not_distinct",
    });
  });
});

describe("resolveConflict (IMPL §4.5)", () => {
  const decide = (log: SessionLog, conflictId: string) =>
    log.append({
      type: "decision",
      statement: "Use the shared client.",
      scope: { kind: "repository" },
      exceptions: [],
      conflictId,
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });

  it("refuses a decision that answers another conflict", () => {
    const { log, call1 } = expansionCall();
    const other = decide(log, call1.conflicts.get("c2") as string);
    expect(() => resolveConflict(log, call1.conflicts.get("c1") as string, other.id)).toThrow(
      /doesn't answer/,
    );
  });

  it("refuses a withdrawn conflict, which isn't current", () => {
    const { log, call1 } = expansionCall();
    const conflictId = call1.conflicts.get("c1") as string;
    log.revise("conflict", conflictId, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
    });
    const decision = decide(log, conflictId);
    const from = log.records.length;
    expect(() => resolveConflict(log, conflictId, decision.id)).toThrow(/not current/);
    expect(appended(log, from)).toEqual([]);
  });

  it("refuses a conflict that is already resolved", () => {
    const { log, call1 } = expansionCall();
    const conflictId = call1.conflicts.get("c1") as string;
    resolveConflict(log, conflictId, decide(log, conflictId).id);
    const again = decide(log, conflictId);
    const from = log.records.length;
    expect(() => resolveConflict(log, conflictId, again.id)).toThrow(/not unresolved/);
    expect(appended(log, from)).toEqual([]);
  });

  it("refuses a conflict from an earlier snapshot", () => {
    const { log, call1 } = expansionCall();
    const conflictId = call1.conflicts.get("c1") as string;
    log.append(
      {
        type: "snapshot",
        capturedAt: "2026-11-01T11:00:00.000Z",
        scope: { roots: ["."] },
        exclusions: [],
        files: [],
        destination: { state: "absent" },
        readFailures: [],
        stability: { state: "stable" },
        git: { state: "unknown", reason: "not_inspected" },
        ignoreRules: { state: "applied" },
      },
      { id: "snap_0002" },
    );
    const from = log.records.length;
    const decision = decide(log, conflictId);
    expect(() => resolveConflict(log, conflictId, decision.id)).toThrow(/not current/);
    expect(appended(log, from)).toEqual([decision]);
  });

  it("refuses a conflict with a corrected member", () => {
    const { log, call1 } = expansionCall();
    const conflictId = call1.conflicts.get("c1") as string;
    log.append({
      type: "decision",
      statement: "That finding is wrong.",
      scope: { kind: "repository" },
      exceptions: [],
      findingId: call1.findings.get("f1") as string,
      origin: "developer_correction",
      actor: "developer",
      decidedAt: "2026-11-01T10:19:00.000Z",
    });
    const from = log.records.length;
    const decision = decide(log, conflictId);
    expect(() => resolveConflict(log, conflictId, decision.id)).toThrow(/not current/);
    expect(appended(log, from)).toEqual([decision]);
  });
});

describe("round trip (IMPL §4.11)", () => {
  it("every record type in this step writes, parses and writes again to the same bytes", () => {
    const { log, recording, run, call1 } = expansionCall();
    log.start({
      type: "session_state",
      productVersion: "0.1.0",
      stage: "inspect",
      status: "running",
    });
    recordAnalyseExpansion(
      recording,
      run({
        findings: [apiFinding("f1")],
        gaps: [
          {
            key: "g1",
            statement: "No lint command is documented.",
            gapType: "no_command",
            relatedPaths: ["src/client.ts"],
          },
        ],
        absenceClaims: [{ key: "a1", pathGlob: "**/*.test.ts", reason: "none seen" }],
        revisions: [replace("F-3", "f1"), withdraw("F-1")],
        contentNotices: [{ item: "T2-001", lines: "1-1", description: "reads as an instruction" }],
      }),
    );
    const conflictId = call1.conflicts.get("c2") as string;
    if (log.revisions("conflict", conflictId).at(-1)?.status === "unresolved") {
      const decision = log.append({
        type: "decision",
        statement: "Lint is separate from the lookup.",
        scope: { kind: "repository" },
        exceptions: ["generated code"],
        conflictId,
        origin: "answered_question",
        actor: "developer",
        decidedAt: "2026-11-01T10:20:00.000Z",
      });
      resolveConflict(log, conflictId, decision.id);
    }
    const finding = ofType(log.records, "finding").find((r) => r.status === "active") as {
      findingId: string;
    };
    log.start({
      type: "question",
      producedBy: "call_0003",
      prompt: "Which client should components use?",
      reason: "The docs and the code disagree.",
      findingIds: [finding.findingId],
      conflictIds: [],
      gapIds: [],
      options: [{ label: "The shared client" }],
      scope: { kind: "repository" },
      status: "unreached",
      unreachedReason: "budget",
    });
    log.append({
      type: "question",
      status: "failed_validation",
      producedBy: "call_0003",
      itemKey: "q2",
      rejectedBy: ["Q-001"],
      proposed: { key: "q2" },
    });
    recordFailedRecommendationRevision(log, {
      producedBy: "call_0004",
      itemKey: "r1",
      rule: "SUP-003",
      proposed: { key: "r1" },
    });
    const types = new Set(log.records.map((r) => r.type));
    const kinds = new Set(ofType(log.records, "evidence").map((r) => r.kind));
    expect([...types].sort()).toEqual(
      [
        "conflict",
        "content_notice",
        "decision",
        "evidence",
        "failed_item",
        "finding",
        "question",
        "recommendation_revision",
        "session_state",
        "snapshot",
      ].sort(),
    );
    expect([...kinds].sort()).toEqual(["absence_check", "entry", "lines"]);
    const file: SessionFile = {
      format: SESSION_FORMAT,
      schemaVersion: SESSION_SCHEMA_VERSION,
      writtenBy: "0.1.0",
      session: {
        id: "ses_0001",
        createdAt: "2026-11-01T10:15:00.000Z",
        productVersion: "0.1.0",
        adapter: "claude-code" as const,
        outputScope: ["root CLAUDE.md"] as ["root CLAUDE.md"],
        repository: { name: "fixture", root: "/tmp/fixture" },
        targetPath: "CLAUDE.md" as const,
      },
      records: [...log.records],
    };
    const text = serialiseSession(file);
    const parsed = sessionFile.parse(JSON.parse(text));
    expect(parsed.records).toEqual(JSON.parse(JSON.stringify(log.records)));
    expect(serialiseSession(parsed)).toBe(text);
  });
});

describe("acting on the revisions a call was sent (IMPL §4.4.1, §4.5)", () => {
  it("a replacement starts a lineage with no revisedBy: producedBy already names the call", () => {
    const { log, recording, run } = expansionCall();
    const from = log.records.length;
    recordAnalyseExpansion(
      recording,
      run({ findings: [apiFinding("f1")], revisions: [replace("F-3", "f1")] }),
    );
    const replacement = ofType(appended(log, from), "finding")[0];
    expect(replacement).toMatchObject({ revision: 1, producedBy: "call_0002" });
    expect(replacement).not.toHaveProperty("revisedBy");
  });

  it("refuses a withdrawal when the finding has been revised since the call was sent", () => {
    const { log, recording, run, call1 } = expansionCall();
    const validation = run({ revisions: [withdraw("F-4")] });
    log.revise("finding", call1.findings.get("f3") as string, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
      revisedBy: "call_0009",
    });
    const from = log.records.length;
    expect(() => recordAnalyseExpansion(recording, validation)).toThrow(
      /superseded since the call/,
    );
    // Nothing that call says is applied: the refusal comes before any record is appended.
    expect(appended(log, from)).toEqual([]);
  });

  it("resolveConflict refuses a conflict that a later call replaced", () => {
    const { log, recording, run, call1 } = expansionCall();
    recordAnalyseExpansion(
      recording,
      run({
        conflicts: [
          {
            key: "c1",
            description: "The API module and the lookup disagree.",
            findings: ["F-2", "F-3"],
          },
        ],
        revisions: [replace("C-1", "c1")],
      }),
    );
    const conflictId = call1.conflicts.get("c1") as string;
    const decision = log.append({
      type: "decision",
      statement: "Use the shared client.",
      scope: { kind: "repository" },
      exceptions: [],
      conflictId,
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    expect(() => resolveConflict(log, conflictId, decision.id)).toThrow(/not current/);
  });
});

describe("acting on the revisions a call was sent, before anything is appended (IMPL §4.5)", () => {
  it("refuses a conflict outcome whose conflict moved on, leaving the log unchanged", () => {
    const { log, recording, run, call1 } = expansionCall();
    const validation = run({ findings: [apiFinding("f1")], revisions: [replace("F-3", "f1")] });
    log.revise("conflict", call1.conflicts.get("c2") as string, {
      status: "unresolved",
      revisedBy: "call_0009",
    });
    const from = log.records.length;
    expect(() => recordAnalyseExpansion(recording, validation)).toThrow(
      /superseded since the call/,
    );
    expect(appended(log, from)).toEqual([]);
  });
});
