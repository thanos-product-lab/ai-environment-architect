import { describe, expect, it } from "vitest";
import { hashOf, newLog } from "../../../test/support/session.js";
import { currentState } from "./current.js";
import { recordFailedRecommendationRevision } from "./failed.js";
import type { SessionLog } from "./log.js";
import { SESSION_SCHEMA_VERSION, type SessionFile, sessionFile } from "./records.js";
import { serialiseSession } from "./serialise.js";

// Derived current state (IMPL §4.4.1 "Current", §4.4.2, §4.5 corrected findings).

function snapshot(log: SessionLog) {
  return log.append({
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
  });
}

function claim(log: SessionLog, snapshotId: string, statement = "The guide asks for X.") {
  const ev = log.append({
    type: "evidence",
    snapshotId,
    kind: "lines",
    path: "docs/guide.md",
    fileHash: hashOf("a"),
    lineStart: 1,
    lineEnd: 1,
    excerpt: "X",
    basis: "documentation",
  });
  return log.start({
    type: "finding",
    snapshotId,
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

function gap(log: SessionLog, snapshotId: string) {
  return log.start({
    type: "finding",
    snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "gap",
    statement: "No test command is documented.",
    gapType: "no_command",
    relatedPaths: [],
    coverage: { state: "inspected" },
    evidenceIds: [],
  });
}

function conflict(log: SessionLog, snapshotId: string, findingIds: string[]) {
  return log.start({
    type: "conflict",
    snapshotId,
    producedBy: "call_0001",
    findingIds,
    description: "Docs and code disagree.",
    status: "unresolved",
  });
}

function question(
  log: SessionLog,
  targets: { findingIds?: string[]; conflictIds?: string[]; gapIds?: string[] },
) {
  return log.start({
    type: "question",
    producedBy: "call_0002",
    prompt: "Which one is policy?",
    reason: "They disagree.",
    findingIds: targets.findingIds ?? [],
    conflictIds: targets.conflictIds ?? [],
    gapIds: targets.gapIds ?? [],
    options: [],
    scope: { kind: "repository" },
    status: "open",
  });
}

const decisionFields = {
  type: "decision" as const,
  statement: "That finding is wrong.",
  scope: { kind: "repository" as const },
  exceptions: [],
  actor: "developer",
  decidedAt: "2026-11-01T10:20:00.000Z",
};

function correction(log: SessionLog, findingId: string, supersedes?: string) {
  return log.append({
    ...decisionFields,
    origin: "developer_correction",
    findingId,
    ...(supersedes === undefined ? {} : { supersedes: [supersedes] as [string] }),
  });
}

const withdraw = { status: "withdrawn", withdrawnReason: "withdrawn_by_model" } as const;

describe("current revisions (IMPL §4.4.1)", () => {
  it("a lineage's latest current-status revision is current, keyed by lineage ID", () => {
    const log = newLog();
    const snap = snapshot(log);
    const first = claim(log, snap.id);
    const state = currentState(log.records);
    expect([...state.findings.keys()]).toEqual([first.findingId]);
    expect(state.findings.get(first.findingId)?.id).toBe(first.id);
  });

  it("a withdrawn finding has no current revision", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    log.revise("finding", f.findingId, withdraw);
    expect(currentState(log.records).findings.size).toBe(0);
  });

  it("a replaced finding is not current; its replacement is", () => {
    const log = newLog();
    const snap = snapshot(log);
    const a = claim(log, snap.id);
    const b = claim(log, snap.id, "Code does Y.");
    const ev = log.append({
      type: "evidence",
      snapshotId: snap.id,
      kind: "entry",
      path: "docs/guide.md",
      fileHash: hashOf("a"),
      basis: "code_observation",
    });
    const replacement = log.start({
      type: "finding",
      snapshotId: snap.id,
      producedBy: "call_0002",
      status: "active",
      kind: "claim",
      statement: "Merged.",
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidenceIds: [ev.id],
      supersedes: [a.id, b.id],
    });
    expect([...currentState(log.records).findings.keys()]).toEqual([replacement.findingId]);
  });

  it("a revised finding's current revision is the latest one", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    const revised = log.revise("finding", f.findingId, {
      statement: "The guide asks for X, always.",
    });
    const state = currentState(log.records);
    expect(state.findings.size).toBe(1);
    expect(state.findings.get(f.findingId)?.id).toBe(revised.id);
  });

  it("a revised conflict's current revision is the latest one", () => {
    const log = newLog();
    const snap = snapshot(log);
    const c = conflict(log, snap.id, [
      claim(log, snap.id).findingId,
      claim(log, snap.id).findingId,
    ]);
    const revised = log.revise("conflict", c.conflictId, { description: "Sharper." });
    expect(currentState(log.records).conflicts.get(c.conflictId)?.id).toBe(revised.id);
  });

  it("failed records are never current", () => {
    const log = newLog();
    snapshot(log);
    log.append({
      type: "finding",
      kind: "claim",
      producedBy: "call_0001",
      status: "failed_validation",
      itemKey: "findings/f1",
      rejectedBy: ["CIT-001"],
      proposed: { statement: "x" },
    });
    log.append({
      type: "question",
      producedBy: "call_0001",
      status: "failed_validation",
      itemKey: "questions/q1",
      rejectedBy: ["Q-001"],
      proposed: {},
    });
    log.append({
      type: "failed_item",
      collection: "contentNotices",
      producedBy: "call_0001",
      status: "failed_validation",
      itemKey: "contentNotices/0",
      rejectedBy: ["ALIAS-001"],
      proposed: {},
    });
    const state = currentState(log.records);
    expect(state.findings.size + state.questions.size + state.conflicts.size).toBe(0);
  });

  it("a recommendation lineage with only failed revisions has no current revision", () => {
    const log = newLog();
    recordFailedRecommendationRevision(log, {
      producedBy: "call_0003",
      itemKey: "recommendations/r1",
      rule: "REC-001",
      proposed: {},
    });
    expect(currentState(log.records).recommendations.size).toBe(0);
  });

  it("a decision is current until another supersedes it; decisions are keyed by record ID", () => {
    const log = newLog();
    const first = log.append({ ...decisionFields, origin: "answered_question" });
    expect([...currentState(log.records).decisions.keys()]).toEqual([first.id]);
    const second = log.append({
      ...decisionFields,
      origin: "answered_question",
      supersedes: [first.id],
    });
    expect([...currentState(log.records).decisions.keys()]).toEqual([second.id]);
  });
});

describe("active snapshot (IMPL §4.4.2)", () => {
  it("is the latest snapshot, or none", () => {
    const log = newLog();
    expect(currentState(log.records).activeSnapshotId).toBeUndefined();
    snapshot(log);
    const latest = snapshot(log);
    expect(currentState(log.records).activeSnapshotId).toBe(latest.id);
  });

  it("findings and conflicts of an earlier snapshot are not current", () => {
    const log = newLog();
    const old = snapshot(log);
    conflict(log, old.id, [claim(log, old.id).findingId, claim(log, old.id).findingId]);
    const fresh = snapshot(log);
    const kept = claim(log, fresh.id);
    const state = currentState(log.records);
    expect([...state.findings.keys()]).toEqual([kept.findingId]);
    expect(state.conflicts.size).toBe(0);
  });

  it("content notices are those of the active snapshot", () => {
    const log = newLog();
    const notice = (snapshotId: string) =>
      log.append({
        type: "content_notice",
        snapshotId,
        modelCallId: "call_0001",
        item: "T1",
        path: "docs/guide.md",
        fileHash: hashOf("a"),
        lineStart: 1,
        lineEnd: 1,
        description: "Asks the reader to ignore instructions.",
      });
    const old = snapshot(log);
    notice(old.id);
    const fresh = snapshot(log);
    const kept = notice(fresh.id);
    expect(currentState(log.records).contentNotices.map((n) => n.id)).toEqual([kept.id]);
  });
});

describe("corrected findings (IMPL §4.5)", () => {
  it("a finding a current decision names is corrected, not current, and reported with its decision", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    const before = currentState(log.records);
    const dec = correction(log, f.findingId);
    const after = currentState(log.records);
    expect(before.findings.has(f.findingId)).toBe(true);
    expect(after.findings.has(f.findingId)).toBe(false);
    expect(after.correctedFindings.get(f.findingId)).toEqual({ finding: f, decision: dec });
    // Derived, not stored: the finding itself gained no revision.
    expect(log.revisions("finding", f.findingId)).toHaveLength(1);
  });

  it("superseding the correction with a decision that no longer names the finding restores it", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    const dec = correction(log, f.findingId);
    log.append({ ...decisionFields, origin: "answered_question", supersedes: [dec.id] });
    const state = currentState(log.records);
    expect(state.findings.get(f.findingId)?.id).toBe(f.id);
    expect(state.correctedFindings.size).toBe(0);
  });

  it("superseding the correction with one that still names the finding keeps it corrected", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    const dec = correction(log, f.findingId);
    const again = correction(log, f.findingId, dec.id);
    const state = currentState(log.records);
    expect(state.findings.has(f.findingId)).toBe(false);
    expect(state.correctedFindings.get(f.findingId)?.decision.id).toBe(again.id);
  });

  it("with two current corrections of one finding, the latest is the one shown", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    correction(log, f.findingId);
    const later = correction(log, f.findingId);
    expect(currentState(log.records).correctedFindings.get(f.findingId)?.decision.id).toBe(
      later.id,
    );
  });

  it("a withdrawn or earlier-snapshot finding is not reported as corrected", () => {
    const log = newLog();
    const old = snapshot(log);
    const stale = claim(log, old.id);
    const fresh = snapshot(log);
    const gone = claim(log, fresh.id);
    log.revise("finding", gone.findingId, withdraw);
    correction(log, stale.findingId);
    correction(log, gone.findingId);
    expect(currentState(log.records).correctedFindings.size).toBe(0);
  });
});

describe("round trip (IMPL §4.11)", () => {
  it("a serialised and reloaded session derives the same current state", () => {
    const log = newLog();
    const snap = snapshot(log);
    const a = claim(log, snap.id);
    const b = claim(log, snap.id, "Code does Y.");
    const c = conflict(log, snap.id, [a.findingId, b.findingId]);
    question(log, { conflictIds: [c.conflictId] });
    correction(log, gap(log, snap.id).findingId);
    const file: SessionFile = {
      format: "ai-environment-architect/session",
      schemaVersion: SESSION_SCHEMA_VERSION,
      writtenBy: "0.1.0",
      session: {
        id: "ses_0001",
        createdAt: "2026-11-01T10:15:00.000Z",
        productVersion: "0.1.0",
        adapter: "claude-code" as const,
        outputScope: ["root CLAUDE.md"] as ["root CLAUDE.md"],
        repository: { name: "demo", root: "/repo" },
        targetPath: "CLAUDE.md" as const,
      },
      records: [...log.records],
    };
    const reloaded = sessionFile.parse(JSON.parse(serialiseSession(file)));
    expect(currentState(reloaded.records)).toEqual(currentState(log.records));
  });
});

describe("conflicts and questions follow their members (IMPL §4.4.2)", () => {
  it("a resolved conflict is current with status resolved", () => {
    const log = newLog();
    const snap = snapshot(log);
    const c = conflict(log, snap.id, [
      claim(log, snap.id).findingId,
      claim(log, snap.id).findingId,
    ]);
    const dec = log.append({
      ...decisionFields,
      origin: "answered_question",
      conflictId: c.conflictId,
    });
    log.revise("conflict", c.conflictId, { status: "resolved", resolvingDecisionId: dec.id });
    expect(currentState(log.records).conflicts.get(c.conflictId)?.status).toBe("resolved");
  });

  it("a withdrawn conflict is not current", () => {
    const log = newLog();
    const snap = snapshot(log);
    const c = conflict(log, snap.id, [
      claim(log, snap.id).findingId,
      claim(log, snap.id).findingId,
    ]);
    log.revise("conflict", c.conflictId, withdraw);
    expect(currentState(log.records).conflicts.size).toBe(0);
  });

  it("a conflict with a corrected or withdrawn member is not current", () => {
    const log = newLog();
    const snap = snapshot(log);
    const a = claim(log, snap.id, "Claim 1.");
    const b = claim(log, snap.id, "Claim 2.");
    const c = claim(log, snap.id, "Claim 3.");
    const d = claim(log, snap.id, "Claim 4.");
    const corrected = conflict(log, snap.id, [a.findingId, b.findingId]);
    const withdrawn = conflict(log, snap.id, [c.findingId, d.findingId]);
    correction(log, a.findingId);
    log.revise("finding", c.findingId, withdraw);
    const state = currentState(log.records);
    expect(state.conflicts.has(corrected.conflictId)).toBe(false);
    expect(state.conflicts.has(withdrawn.conflictId)).toBe(false);
  });

  it("a question is current while at least one finding, gap or conflict it resolves is", () => {
    const log = newLog();
    const snap = snapshot(log);
    const a = claim(log, snap.id);
    const b = claim(log, snap.id, "Code does Y.");
    const g = gap(log, snap.id);
    const c = conflict(log, snap.id, [a.findingId, b.findingId]);
    const byFinding = question(log, { findingIds: [a.findingId] });
    const byGap = question(log, { gapIds: [g.findingId] });
    const byConflict = question(log, { conflictIds: [c.conflictId] });
    const mixed = question(log, { findingIds: [a.findingId], gapIds: [g.findingId] });
    expect([...currentState(log.records).questions.keys()]).toEqual([
      byFinding.questionId,
      byGap.questionId,
      byConflict.questionId,
      mixed.questionId,
    ]);

    // Correcting `a` takes the conflict with it; `mixed` keeps its gap.
    correction(log, a.findingId);
    expect([...currentState(log.records).questions.keys()]).toEqual([
      byGap.questionId,
      mixed.questionId,
    ]);
  });

  it("every question status counts, including unreached; after a refresh none does", () => {
    const log = newLog();
    const snap = snapshot(log);
    const f = claim(log, snap.id);
    const q = question(log, { findingIds: [f.findingId] });
    log.revise("question", q.questionId, { status: "unreached", unreachedReason: "budget" });
    expect(currentState(log.records).questions.get(q.questionId)?.status).toBe("unreached");
    snapshot(log);
    expect(currentState(log.records).questions.size).toBe(0);
  });

  it("a question with no targets is never current", () => {
    const log = newLog();
    question(log, {});
    expect(currentState(log.records).questions.size).toBe(0);
  });
});
