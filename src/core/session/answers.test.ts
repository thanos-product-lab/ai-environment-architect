import { describe, expect, it } from "vitest";
import { newLog } from "../../../test/support/session.js";
import { answerQuestion, correctDecision, unmarkFinding } from "./answers.js";
import { currentState } from "./current.js";
import type { SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// Answering a question and correcting a decision (DM §8.2, IMPL §4.4.1).

function question(log: SessionLog) {
  return log.start({
    type: "question",
    producedBy: "call_0001",
    prompt: "Which?",
    reason: "Unclear.",
    findingIds: ["fnd_0001"],
    conflictIds: [],
    gapIds: [],
    options: [],
    scope: { kind: "repository" },
    status: "open",
  });
}

const answer = (log: SessionLog, questionId: string) =>
  answerQuestion(log, {
    questionId,
    statement: "Use the shared client.",
    scope: { kind: "repository" },
    exceptions: [],
    actor: "developer",
    decidedAt: "2026-11-01T10:20:00.000Z",
  }).decision;

const correction = (supersedes: string) => ({
  supersedes,
  statement: "Use the shared client, except in scripts.",
  scope: { kind: "paths" as const, paths: ["src"] },
  exceptions: ["scripts/"],
  actor: "developer",
  decidedAt: "2026-11-01T10:30:00.000Z",
});

describe("correctDecision (DM §8.2)", () => {
  it("appends a new decision that supersedes the old one and answers the same question", () => {
    const log = newLog();
    const q = question(log);
    const old = answer(log, q.questionId);
    const corrected = correctDecision(log, correction(old.id));
    expect(corrected).toMatchObject({
      type: "decision",
      questionId: q.questionId,
      origin: "answered_question",
      statement: "Use the shared client, except in scripts.",
      scope: { kind: "paths", paths: ["src"] },
      exceptions: ["scripts/"],
      supersedes: [old.id],
    });
    const state = currentState(log.records);
    expect([...state.decisions.keys()]).toEqual([corrected.id]);
    // The question stays answered: the correction appends no revision of it.
    expect(log.revisions("question", q.questionId).at(-1)?.status).toBe("answered");
  });

  it("keeps what a developer correction or a conflict resolution names", () => {
    const log = newLog();
    const old = log.append({
      type: "decision",
      statement: "That finding is wrong.",
      scope: { kind: "repository" },
      exceptions: [],
      conflictId: "conf_0001",
      findingId: "fnd_0002",
      origin: "developer_correction",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    }) as RecordOf<"decision">;
    expect(correctDecision(log, correction(old.id))).toMatchObject({
      conflictId: "conf_0001",
      findingId: "fnd_0002",
      origin: "developer_correction",
      supersedes: [old.id],
    });
  });

  it("corrects a withheld decision, as the developer is asked to (IMPL §2.12)", () => {
    const log = newLog();
    const q = question(log);
    const old = answer(log, q.questionId);
    log.append({ type: "secret_withheld", itemId: old.id, secretRuleId: "aws-access-key-id" });
    const corrected = correctDecision(log, correction(old.id));
    expect([...currentState(log.records).decisions.keys()]).toEqual([corrected.id]);
  });

  it("refuses a decision already superseded, and anything that isn't a decision, appending nothing", () => {
    const log = newLog();
    const q = question(log);
    const old = answer(log, q.questionId);
    correctDecision(log, correction(old.id));
    const before = log.records.length;
    expect(() => correctDecision(log, correction(old.id))).toThrow(/already superseded/);
    expect(() => correctDecision(log, correction(q.id))).toThrow(/isn't a decision/);
    expect(() => correctDecision(log, correction("dec_9999"))).toThrow(/no decision/);
    expect(log.records).toHaveLength(before);
  });
});

describe("unmarkFinding (IMPL §4.5, DM §8.2)", () => {
  function marked(log: SessionLog) {
    const snapshot = log.append(
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
      { id: "snap_0001" },
    );
    const evidence = log.append({
      type: "evidence",
      snapshotId: snapshot.id,
      kind: "lines",
      path: "src/a.ts",
      fileHash: `sha256:${"a".repeat(64)}`,
      lineStart: 1,
      lineEnd: 1,
      excerpt: "export const a = 1;",
      basis: "code_observation",
    });
    const finding = log.start({
      type: "finding",
      snapshotId: snapshot.id,
      producedBy: "call_0001",
      status: "active",
      kind: "claim",
      statement: "Code is in one module.",
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidenceIds: [evidence.id],
    });
    const correction = log.append({
      type: "decision",
      statement: "That finding is wrong.",
      scope: { kind: "repository" },
      exceptions: [],
      findingId: finding.findingId,
      origin: "developer_correction",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    }) as RecordOf<"decision">;
    return { finding, correction };
  }

  const unmark = (supersedes: string) => ({
    supersedes,
    statement: "The finding is right after all.",
    actor: "developer",
    decidedAt: "2026-11-01T10:30:00.000Z",
  });

  it("supersedes the correction with one that names no finding, so the finding is current again", () => {
    const log = newLog();
    const { finding, correction } = marked(log);
    expect(currentState(log.records).correctedFindings.has(finding.findingId)).toBe(true);
    const undone = unmarkFinding(log, unmark(correction.id));
    expect(undone).toMatchObject({
      origin: "developer_correction",
      scope: correction.scope,
      supersedes: [correction.id],
    });
    expect(undone).not.toHaveProperty("findingId");
    const state = currentState(log.records);
    expect(state.findings.has(finding.findingId)).toBe(true);
    expect(state.correctedFindings.has(finding.findingId)).toBe(false);
  });

  it("refuses an answer, a superseded correction and anything that isn't a decision", () => {
    const log = newLog();
    const { finding, correction } = marked(log);
    const q = question(log);
    const answered = answer(log, q.questionId);
    expect(() => unmarkFinding(log, unmark(answered.id))).toThrow(/doesn't mark a finding wrong/);
    unmarkFinding(log, unmark(correction.id));
    const before = log.records.length;
    expect(() => unmarkFinding(log, unmark(correction.id))).toThrow(/already superseded/);
    expect(() => unmarkFinding(log, unmark(finding.id))).toThrow(/isn't a decision/);
    expect(log.records).toHaveLength(before);
  });
});
