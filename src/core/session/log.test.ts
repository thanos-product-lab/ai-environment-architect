import { describe, expect, it } from "vitest";
import { countingIds, hashOf, newLog, tickingClock } from "../../../test/support/session.js";
import { settingsHash } from "../context/select.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../context/tiers.js";
import { DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { SessionLog } from "./log.js";
import { RECORD_KINDS, sessionRecord } from "./records.js";

// The record log (IMPL §4.4.1): IDs, `seq`, revisions, replacements and immutability.

const SNAP = "snap_0001";

function withSnapshot(log = newLog()) {
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [{ path: "docs/guide.md", status: "read", size: 10, hash: hashOf("a") }],
      destination: { state: "absent" },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    },
    { id: SNAP },
  );
  return log;
}

function evidence(log: SessionLog) {
  return log.append({
    type: "evidence",
    snapshotId: SNAP,
    kind: "lines",
    path: "docs/guide.md",
    fileHash: hashOf("a"),
    lineStart: 2,
    lineEnd: 2,
    excerpt: "Components fetch data through the shared client.",
    basis: "documentation",
  });
}

function claim(log: SessionLog, statement = "The guide asks for the shared client.") {
  const ev = evidence(log);
  return log.start({
    type: "finding",
    snapshotId: SNAP,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement,
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["documentation"],
    evidenceIds: [ev.id],
  });
}

describe("envelope (IMPL §4.3)", () => {
  it("assigns seq 1, 2, 3… in order, createdAt from the injected clock, and prefixed IDs", () => {
    const log = withSnapshot();
    const ev = evidence(log);
    expect(log.records.map((r) => [r.type, r.id, r.seq, r.createdAt])).toEqual([
      ["snapshot", SNAP, 1, "2026-11-01T10:15:00.000Z"],
      ["evidence", "ev_0001", 2, "2026-11-01T10:15:01.000Z"],
    ]);
    expect(log.get(ev.id)).toBe(ev);
  });

  it("continues seq after loaded records", () => {
    const first = withSnapshot();
    const log = new SessionLog({ clock: tickingClock(), ids: countingIds() }, first.records);
    expect(evidence(log).seq).toBe(2);
  });

  it("has a record prefix for every type in the §4.4.1 table, and lineage prefixes", () => {
    expect(Object.keys(RECORD_KINDS)).toHaveLength(21);
    expect(RECORD_KINDS.finding).toEqual({
      record: "fndr",
      lineage: { field: "findingId", prefix: "fnd" },
    });
    expect(RECORD_KINDS.apply_attempt.lineage.prefix).toBe("apply");
  });

  it("rejects an unknown field, as every record schema is strict", () => {
    const log = withSnapshot();
    expect(() =>
      log.append({
        type: "evidence",
        snapshotId: SNAP,
        kind: "entry",
        path: "docs/guide.md",
        fileHash: hashOf("a"),
        basis: "code_observation",
        excerpt: "no excerpt on entry evidence",
      } as never),
    ).toThrow(/invalid evidence record/);
  });

  it("freezes records once appended", () => {
    const log = withSnapshot();
    const ev = evidence(log);
    expect(Object.isFrozen(ev)).toBe(true);
    expect(() => {
      (ev as { excerpt: string }).excerpt = "changed";
    }).toThrow();
  });
});

describe("revisions (IMPL §4.4.1)", () => {
  it("starts a lineage at revision 1 with a lineage ID and no supersedes", () => {
    const log = withSnapshot();
    const finding = claim(log);
    expect(finding).toMatchObject({ id: "fndr_0001", findingId: "fnd_0001", revision: 1 });
    expect(finding).not.toHaveProperty("supersedes");
  });

  it("a revision repeats every field, changes what changed and supersedes the one before", () => {
    const log = withSnapshot();
    const first = claim(log);
    const second = log.revise("finding", first.findingId as string, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
    });
    const { id, seq, createdAt, revision, supersedes, status, withdrawnReason, ...rest } =
      second as Record<string, unknown>;
    const {
      id: _i,
      seq: _s,
      createdAt: _c,
      revision: _r,
      status: _st,
      ...before
    } = first as Record<string, unknown>;
    expect(rest).toEqual(before);
    expect({ revision, supersedes, status, withdrawnReason }).toEqual({
      revision: 2,
      supersedes: [first.id],
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
    });
    expect(log.isSuperseded(first.id)).toBe(true);
  });

  it("a change set to undefined removes the field", () => {
    const log = withSnapshot();
    const a = claim(log);
    const b = claim(log, "The user lookup calls fetch directly.");
    const conflict = log.start({
      type: "conflict",
      snapshotId: SNAP,
      producedBy: "call_0001",
      findingIds: [a.findingId as string, b.findingId as string],
      description: "Docs and code disagree.",
      status: "resolved",
      resolvingDecisionId: "dec_0001",
    });
    const revised = log.revise("conflict", conflict.conflictId as string, {
      status: "unresolved",
      resolvingDecisionId: undefined,
    });
    expect(revised).not.toHaveProperty("resolvingDecisionId");
  });

  it("a replacement starts a new lineage that supersedes every lineage it replaces", () => {
    const log = withSnapshot();
    const a = claim(log);
    const b = claim(log, "The user lookup calls fetch directly.");
    const ev = evidence(log);
    const replacement = log.start({
      type: "finding",
      snapshotId: SNAP,
      producedBy: "call_0002",
      status: "active",
      kind: "claim",
      statement: "Components use the shared client.",
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["documentation"],
      evidenceIds: [ev.id],
      supersedes: [a.id, b.id],
    });
    expect(replacement).toMatchObject({ revision: 1, supersedes: [a.id, b.id] });
    expect(replacement.findingId).not.toBe(a.findingId);
  });

  it("never supersedes a record twice, an immutable record or one of another type", () => {
    const log = withSnapshot();
    const a = claim(log);
    log.revise("finding", a.findingId as string, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
    });
    expect(() => log.revise("finding", a.findingId as string, {})).not.toThrow();
    const ev = evidence(log);
    const draft = {
      type: "finding" as const,
      snapshotId: SNAP,
      producedBy: "call_0002",
      status: "active" as const,
      kind: "claim" as const,
      statement: "x",
      mode: "descriptive" as const,
      scope: { kind: "repository" as const },
      basis: ["documentation" as const],
      evidenceIds: [ev.id],
    };
    expect(() => log.start({ ...draft, supersedes: [a.id] })).toThrow(/already superseded/);
    expect(() => log.start({ ...draft, supersedes: [ev.id] })).toThrow(/can't supersede/);
    expect(() => log.start({ ...draft, supersedes: ["fndr_9999"] })).toThrow(/unknown record/);
  });

  it("a decision supersedes a decision, though decisions are immutable", () => {
    const log = withSnapshot();
    const decision = {
      type: "decision" as const,
      statement: "Use the shared client.",
      scope: { kind: "repository" as const },
      exceptions: [],
      origin: "answered_question" as const,
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    };
    const first = log.append(decision);
    const second = log.append({ ...decision, supersedes: [first.id] });
    expect(second.supersedes).toEqual([first.id]);
    expect(() => log.append({ ...decision, supersedes: [first.id] })).toThrow(/already superseded/);
  });

  it("chains session_state and generation_config within the session, with no lineage field", () => {
    const log = newLog();
    const state = {
      type: "session_state" as const,
      productVersion: "0.1.0",
      stage: "inspect" as const,
      status: "running" as const,
    };
    const first = log.start(state);
    const second = log.revise("session_state", "session_state", { status: "awaiting_user" });
    expect(first).toMatchObject({ id: "st_0001", revision: 1 });
    expect(second).toMatchObject({ revision: 2, supersedes: [first.id], stage: "inspect" });
    expect(() => log.start(state)).toThrow(/already started/);
  });

  it("budget_reached names the purpose of the call it left unsent, and only then", () => {
    const log = newLog();
    log.start({
      type: "session_state",
      productVersion: "0.1.0",
      stage: "inspect",
      status: "running",
    });
    expect(() =>
      log.revise("session_state", "session_state", { status: "blocked", reason: "budget_reached" }),
    ).toThrow(/unsentPurpose/);
    expect(
      log.revise("session_state", "session_state", {
        status: "blocked",
        reason: "budget_reached",
        unsentPurpose: "generate_questions",
      }),
    ).toMatchObject({ revision: 2 });
  });
});

describe("record schemas (IMPL §4.4.1, §4.4.3)", () => {
  const envelope = { id: "fndr_0001", seq: 3, createdAt: "2026-11-01T10:15:00.000Z" };

  it("a failed finding holds only the envelope and the failed fields", () => {
    const failed = {
      ...envelope,
      type: "finding",
      kind: "claim",
      status: "failed_validation",
      producedBy: "call_0001",
      itemKey: "f2",
      rejectedBy: ["CIT-004", "CIT-008"],
      proposed: { key: "f2", statement: "x" },
    };
    expect(sessionRecord.safeParse(failed).success).toBe(true);
    expect(sessionRecord.safeParse({ ...failed, snapshotId: SNAP }).success).toBe(false);
    expect(sessionRecord.safeParse({ ...failed, findingId: "fnd_0001" }).success).toBe(false);
    expect(sessionRecord.safeParse({ ...failed, rejectedBy: [] }).success).toBe(false);
  });

  it("revisedBy is set only on a revision after the first", () => {
    const log = withSnapshot();
    const ev = evidence(log);
    expect(() =>
      log.start({
        type: "finding",
        snapshotId: SNAP,
        producedBy: "call_0001",
        status: "active",
        kind: "claim",
        statement: "x",
        mode: "descriptive",
        scope: { kind: "repository" },
        basis: ["documentation"],
        evidenceIds: [ev.id],
        revisedBy: "call_0002",
      }),
    ).toThrow(/revisedBy/);
  });

  it("withdrawnReason is set exactly when a finding or conflict is withdrawn", () => {
    const log = withSnapshot();
    const a = claim(log);
    expect(() => log.revise("finding", a.findingId as string, { status: "withdrawn" })).toThrow(
      /withdrawnReason/,
    );
  });

  it("an absence finding has exactly one evidence record and the code_observation basis", () => {
    const absence = {
      ...envelope,
      type: "finding",
      findingId: "fnd_0001",
      revision: 1,
      snapshotId: SNAP,
      producedBy: "call_0001",
      status: "active",
      kind: "absence",
      statement: "No files matched `test/**` within the inspected scope.",
      pathGlob: "test/**",
      reason: "none seen",
      basis: ["code_observation"],
      evidenceIds: ["ev_0001"],
    };
    expect(sessionRecord.safeParse(absence).success).toBe(true);
    expect(sessionRecord.safeParse({ ...absence, evidenceIds: [] }).success).toBe(false);
    expect(sessionRecord.safeParse({ ...absence, basis: ["documentation"] }).success).toBe(false);
  });

  it("a claim needs evidence; a gap may have none", () => {
    const log = withSnapshot();
    expect(() =>
      log.start({
        type: "finding",
        snapshotId: SNAP,
        producedBy: "call_0001",
        status: "active",
        kind: "claim",
        statement: "x",
        mode: "descriptive",
        scope: { kind: "repository" },
        basis: ["documentation"],
        evidenceIds: [],
      }),
    ).toThrow(/evidenceIds/);
    expect(
      log.start({
        type: "finding",
        snapshotId: SNAP,
        producedBy: "call_0001",
        status: "active",
        kind: "gap",
        statement: "No lint command is documented.",
        gapType: "no_command",
        relatedPaths: ["docs/guide.md"],
        coverage: { state: "inspected" },
        evidenceIds: [],
      }),
    ).toMatchObject({ kind: "gap" });
  });
});

describe("generation_config (IMPL §4.4.1)", () => {
  it("holds the selection settings with their settingsHash; raising the budget appends a revision with a reason", () => {
    const settings = { snapshot: DEFAULT_SNAPSHOT_SETTINGS, context: DEFAULT_CONTEXT_SETTINGS };
    const log = newLog();
    const first = log.start({
      type: "generation_config",
      settings,
      settingsHash: settingsHash(settings),
      requestedModel: "claude-opus-5-5",
      budget: { maxCostUsd: 2 },
      questionBudget: 5,
      retainModelInputs: true,
    });
    const raised = log.revise("generation_config", "generation_config", {
      budget: { maxCostUsd: 4 },
      reason: "budget_raised",
    });
    expect(first).toMatchObject({ id: "gc_0001", revision: 1 });
    expect(raised).toMatchObject({
      revision: 2,
      supersedes: [first.id],
      budget: { maxCostUsd: 4 },
      settingsHash: settingsHash(settings),
    });
  });
});
