import { describe, expect, it } from "vitest";
import { hashOf, newLog } from "../../../test/support/session.js";
import type { ExpansionRound } from "../context/expansion.js";
import { sha256 } from "../hash.js";
import { currentState } from "./current.js";
import { blockedEvidenceIds, recordExpansionRound, withholdBlockedFiles } from "./expansion.js";
import type { SessionLog } from "./log.js";
import { sessionRecord } from "./records.js";

// The expansion record (IMPL §1.8, §1.13, §4.4.1): appended once the round has run, whether or
// not call 2 is sent.

const content = new TextEncoder().encode("a\nb\n");

const round: ExpansionRound = {
  budgetBytes: 60_000,
  usedBytes: 120,
  items: [],
  blocked: [],
  requests: [
    { index: 0, kind: "search", outcome: "rejected", rule: "EXP-005" },
    {
      index: 1,
      kind: "read",
      outcome: "executed",
      items: [
        {
          id: "E-1",
          path: "src/a.ts",
          hash: sha256(content),
          reason: "expansion:expansionRequests/1",
          content,
          rendered: {
            text: "x",
            bytes: 120,
            excerpt: true,
            included: [{ first: 2, last: 2 }],
            totalLines: 2,
            outline: [],
          },
        },
      ],
    },
  ],
};

describe("recordExpansionRound (IMPL §1.8, §4.4.1)", () => {
  it("appends one expansion_round with every request's outcome, rule and items", () => {
    const log = newLog();
    const record = recordExpansionRound(log, round, {
      snapshotId: "snap_0001",
      modelCallId: "call_0001",
    });
    expect(sessionRecord.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      type: "expansion_round",
      snapshotId: "snap_0001",
      modelCallId: "call_0001",
      budgetBytes: 60_000,
      usedBytes: 120,
      requests: [
        { index: 0, kind: "search", outcome: "rejected", rule: "EXP-005" },
        {
          index: 1,
          kind: "read",
          outcome: "executed",
          items: [
            {
              id: "E-1",
              path: "src/a.ts",
              fileHash: sha256(content),
              excerpt: true,
              includedLines: "2",
              totalLines: 2,
              bytes: 120,
            },
          ],
        },
      ],
    });
    expect(record.id).toMatch(/^exr_/);
    expect(JSON.stringify(record)).not.toContain('"text"');
  });

  it("is appended at most once per session", () => {
    const log = newLog();
    const ids = { snapshotId: "snap_0001", modelCallId: "call_0001" };
    recordExpansionRound(log, round, ids);
    expect(() => recordExpansionRound(log, round, ids)).toThrow(/already has an expansion round/);
  });
});

describe("a file a secret match blocked, in later calls (IMPL §1.8, §1.7)", () => {
  const blockedRound: ExpansionRound = {
    ...round,
    blocked: [{ path: "src/k.ts", ruleId: "aws-access-key-id" }],
  };

  /** Call-1 findings citing the file the round blocks, another file, or both. */
  function session(withRound: ExpansionRound | null = blockedRound) {
    const log = newLog();
    const snapshot = log.append({
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
    });
    const lines = (path: string) =>
      log.append({
        type: "evidence",
        snapshotId: snapshot.id,
        kind: "lines",
        path,
        fileHash: hashOf("a"),
        lineStart: 1,
        lineEnd: 1,
        excerpt: "x",
        basis: "code_observation",
      });
    const entry = (path: string) =>
      log.append({
        type: "evidence",
        snapshotId: snapshot.id,
        kind: "entry",
        path,
        fileHash: hashOf("b"),
        basis: "code_observation",
      });
    const claim = (statement: string, evidenceIds: string[]) =>
      log.start({
        type: "finding",
        snapshotId: snapshot.id,
        producedBy: "call_0001",
        status: "active",
        kind: "claim",
        statement,
        mode: "descriptive",
        scope: { kind: "repository" },
        basis: ["code_observation"],
        evidenceIds,
      });
    const k1 = lines("src/k.ts");
    const k2 = lines("src/k.ts");
    const kEntry = entry("src/k.ts");
    const a = lines("src/a.ts");
    const findings = {
      onlyBlocked: claim("Only the blocked file.", [k1.id, kEntry.id]),
      both: claim("Both files.", [k2.id, a.id]),
      other: claim("Only the other file.", [a.id]),
    };
    if (withRound !== null)
      recordExpansionRound(log, withRound, { snapshotId: snapshot.id, modelCallId: "call_0001" });
    return { log, findings, evidence: { k1, k2, kEntry, a } };
  }

  const current = (log: SessionLog) => [...currentState(log.records).findings.keys()];

  it("appends a secret_withheld for each finding left with no evidence outside the blocked files", () => {
    const { log, findings } = session();
    const withheld = withholdBlockedFiles(log);
    expect(withheld.map((r) => [r.itemId, r.secretRuleId])).toEqual([
      [findings.onlyBlocked.findingId, "aws-access-key-id"],
    ]);
    expect(current(log)).not.toContain(findings.onlyBlocked.findingId);
    expect(current(log)).toEqual(
      expect.arrayContaining([findings.both.findingId, findings.other.findingId]),
    );
    expect(JSON.stringify(withheld)).not.toContain("AKIA");
  });

  it("withholds every excerpt of a blocked file from later calls, keeping the other evidence", () => {
    const { log, evidence } = session();
    expect([...blockedEvidenceIds(log.records)].sort()).toEqual(
      [evidence.k1.id, evidence.k2.id, evidence.kEntry.id].sort(),
    );
  });

  it("withholds nothing without a round, or when the round blocked nothing", () => {
    const none = session(null);
    expect(withholdBlockedFiles(none.log)).toEqual([]);
    expect(blockedEvidenceIds(none.log.records).size).toBe(0);
    const clean = session(round);
    expect(withholdBlockedFiles(clean.log)).toEqual([]);
    expect(blockedEvidenceIds(clean.log.records).size).toBe(0);
  });

  it("matches a blocked file whose name is withheld by its hash", () => {
    const withheld = `src/${["AKIA", "IOSFODNN7", "EXAMPLE"].join("")}.ts`;
    const { log, findings } = session(null);
    const evidence = log.append({
      type: "evidence",
      snapshotId: "snap_0001",
      kind: "lines",
      path: withheld,
      fileHash: hashOf("c"),
      lineStart: 1,
      lineEnd: 1,
      excerpt: "x",
      basis: "code_observation",
    });
    const finding = log.start({
      type: "finding",
      snapshotId: "snap_0001",
      producedBy: "call_0001",
      status: "active",
      kind: "claim",
      statement: "Only the withheld file.",
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidenceIds: [evidence.id],
    });
    const record = recordExpansionRound(
      log,
      { ...round, blocked: [{ path: withheld, ruleId: "generic-assignment" }] },
      { snapshotId: "snap_0001", modelCallId: "call_0001" },
    );
    expect(JSON.stringify(record)).not.toContain(withheld);
    expect(blockedEvidenceIds(log.records)).toEqual(new Set([evidence.id]));
    expect(withholdBlockedFiles(log).map((r) => r.itemId)).toEqual([finding.findingId]);
    expect(current(log)).toContain(findings.other.findingId);
  });

  it("names the rule of the first blocked file in the finding's evidence order", () => {
    const { log, findings, evidence } = session(null);
    const z = log.append({
      type: "evidence",
      snapshotId: "snap_0001",
      kind: "lines",
      path: "src/z.ts",
      fileHash: hashOf("d"),
      lineStart: 1,
      lineEnd: 1,
      excerpt: "x",
      basis: "code_observation",
    });
    const both = log.start({
      type: "finding",
      snapshotId: "snap_0001",
      producedBy: "call_0001",
      status: "active",
      kind: "claim",
      statement: "Two blocked files.",
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidenceIds: [z.id, evidence.k1.id],
    });
    recordExpansionRound(
      log,
      {
        ...round,
        blocked: [
          { path: "src/k.ts", ruleId: "aws-access-key-id" },
          { path: "src/z.ts", ruleId: "github-token" },
        ],
      },
      { snapshotId: "snap_0001", modelCallId: "call_0001" },
    );
    const withheld = withholdBlockedFiles(log);
    expect(withheld.find((r) => r.itemId === both.findingId)?.secretRuleId).toBe("github-token");
    expect(withheld.find((r) => r.itemId === findings.onlyBlocked.findingId)?.secretRuleId).toBe(
      "aws-access-key-id",
    );
  });

  it("withholds a finding once, however often it runs", () => {
    const { log } = session();
    withholdBlockedFiles(log);
    expect(withholdBlockedFiles(log)).toEqual([]);
    expect(log.records.filter((r) => r.type === "secret_withheld")).toHaveLength(1);
  });
});
