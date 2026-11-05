import { describe, expect, it } from "vitest";
import { callDraft, completedCall, newLog } from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { buildExclusionRules } from "../snapshot/exclusions.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { createAliasTable } from "../validation/aliases.js";
import { coverageIndex } from "../validation/coverage.js";
import type { RecommendFinding } from "../validation/recommend.js";
import { type RegenerateContext, validateRegenerate } from "../validation/regenerate.js";
import { anchorablePaths } from "../validation/support.js";
import { answerQuestion } from "./answers.js";
import { proposeArtifact } from "./artifacts.js";
import { currentState } from "./current.js";
import type { Revised, SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";
import {
  affectedRecommendations,
  changeSummary,
  invalidateChangedTargets,
  planRegeneration,
  recordRegenerate,
  regenerationInput,
} from "./regeneration.js";
import { exclusions, select } from "./selections.js";

// Change propagation and regeneration (IMPL §3.3.6, §4.4.1–§4.4.2, §4.11; DM §9.4, §12).

const encode = (text: string) => new TextEncoder().encode(text);

const GUIDE = "# Guide\n\nIntro.\n\n## Testing\n\nTesting text.\n\n## Other\n\nOther text.\n";

interface Session {
  readonly log: SessionLog;
  snapshotId: string;
  bytes: Uint8Array;
  readonly callId: string;
}

function appendSnapshot(log: SessionLog, text: string | undefined) {
  const bytes = text === undefined ? undefined : encode(text);
  const files: SnapshotFile[] = [
    { path: "src/a.ts", status: "read", size: 10, hash: sha256(encode("a")) } as SnapshotFile,
    ...(bytes === undefined
      ? []
      : [{ path: "CLAUDE.md", status: "read", size: bytes.length, hash: sha256(bytes) } as never]),
  ];
  const parsed = bytes === undefined ? undefined : parseGuidanceBlocks(bytes);
  const snapshot = log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: files as never,
    destination:
      bytes === undefined || parsed === undefined
        ? { state: "absent" }
        : {
            state: "present",
            contentRef: `content/${sha256(bytes).replace(":", "-")}`,
            hash: sha256(bytes),
            blocks: parsed.blocks as never,
            lineEndings: parsed.lineEndings,
            roundTrip: parsed.roundTrip,
          },
    readFailures: [],
    stability: { state: "stable" },
    git: { state: "unknown", reason: "not_inspected" },
    ignoreRules: { state: "applied" },
  });
  return { snapshotId: snapshot.id, bytes };
}

function completed(log: SessionLog, purpose: "recommend" | "regenerate_recommendations") {
  const call = log.start(callDraft({ purpose }));
  log.revise("model_call", call.modelCallId, completedCall());
  return call.modelCallId;
}

function session(text = GUIDE): Session {
  const log = newLog();
  const { snapshotId, bytes } = appendSnapshot(log, text);
  return { log, snapshotId, bytes: bytes as Uint8Array, callId: completed(log, "recommend") };
}

/** A refresh: a new active snapshot. Its findings are earlier-snapshot from now on. */
function refresh(s: Session, text: string) {
  const { snapshotId, bytes } = appendSnapshot(s.log, text);
  s.snapshotId = snapshotId;
  s.bytes = bytes as Uint8Array;
}

function finding(s: Session, excerpt = "export const a = 1;") {
  const ev = s.log.append({
    type: "evidence",
    snapshotId: s.snapshotId,
    kind: "lines",
    path: "src/a.ts",
    fileHash: sha256(encode("a")),
    lineStart: 1,
    lineEnd: 1,
    excerpt,
    basis: "code_observation",
  });
  return s.log.start({
    type: "finding",
    snapshotId: s.snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement: "Code is in one module.",
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["code_observation"],
    evidenceIds: [ev.id],
  });
}

function question(
  s: Session,
  targets: { findingIds?: string[]; conflictIds?: string[] },
  status: "open" | "skipped" | "answered" = "open",
) {
  return s.log.start({
    type: "question",
    producedBy: "call_0001",
    prompt: "Which?",
    reason: "Unclear.",
    findingIds: targets.findingIds ?? [],
    conflictIds: targets.conflictIds ?? [],
    gapIds: [],
    options: [],
    scope: { kind: "repository" },
    status,
  });
}

function conflict(s: Session, findingIds: string[]) {
  return s.log.start({
    type: "conflict",
    snapshotId: s.snapshotId,
    producedBy: "call_0001",
    findingIds,
    description: "They disagree.",
    status: "unresolved",
  });
}

function decision(
  s: Session,
  fields: { questionId?: string; conflictId?: string; findingId?: string; supersedes?: string },
) {
  const { supersedes, ...rest } = fields;
  return s.log.append({
    type: "decision",
    statement: "Use the shared client.",
    scope: { kind: "repository" },
    exceptions: [],
    origin: rest.findingId === undefined ? "answered_question" : "developer_correction",
    actor: "developer",
    decidedAt: "2026-11-01T10:20:00.000Z",
    ...rest,
    ...(supersedes === undefined ? {} : { supersedes: [supersedes] as [string] }),
  });
}

function answer(s: Session, questionId: string) {
  return answerQuestion(s.log, {
    questionId,
    statement: "Use the shared client.",
    scope: { kind: "repository" },
    exceptions: [],
    actor: "developer",
    decidedAt: "2026-11-01T10:20:00.000Z",
  });
}

type Support = Revised<"recommendation_revision">["support"][number];

function block(s: Session, blockId: string) {
  const found = parseGuidanceBlocks(s.bytes).blocks.find((b) => b.blockId === blockId);
  if (found === undefined) throw new Error(`no block ${blockId}`);
  return { blockId: found.blockId, blockHash: found.hash };
}

function recommend(
  s: Session,
  support: Support[],
  fields: Partial<{
    operation: "add" | "revise" | "remove";
    target: Revised<"recommendation_revision">["target"];
    content: string;
    kind: "fact" | "policy";
  }> = {},
): Revised<"recommendation_revision"> {
  const operation = fields.operation ?? "add";
  return s.log.start({
    type: "recommendation_revision",
    kind: fields.kind ?? "fact",
    operation,
    target: fields.target ?? { kind: "after", ...block(s, "Guide/paragraph-1") },
    ...(operation === "remove" ? {} : { content: fields.content ?? "Code is in one module." }),
    rationale: "Helps.",
    support,
    references: [],
    scope: { kind: "repository" },
    producedBy: s.callId,
    status: "valid",
  });
}

const onFinding = (f: Revised<"finding">): Support => ({ kind: "finding", findingId: f.findingId });
const onDecision = (d: RecordOf<"decision">): Support => ({ kind: "decision", decisionId: d.id });

function accept(s: Session, r: Revised<"recommendation_revision">) {
  const outcome = select(s.log, s.bytes, {
    recommendationId: r.recommendationId,
    revisionId: r.id,
    state: "accepted",
    actor: "developer",
    selectedAt: "2026-11-01T10:30:00.000Z",
  });
  if (!outcome.selected) throw new Error("not selected");
}

// --- A regeneration call's context, built from the records, as M6 will --------------------

function regenerateContext(
  s: Session,
  batch: readonly string[],
  affectedSet: readonly string[] = batch,
) {
  const state = currentState(s.log.records);
  const findings = [...state.findings.values()];
  const decisions = [...state.decisions.values()];
  const conflicts = [...state.conflicts.values()];
  const questions = [...state.questions.values()];
  const parsed = parseGuidanceBlocks(s.bytes);
  const aliases = createAliasTable("regenerate_recommendations", {
    findings: findings.map((f) => f.id),
    conflicts: conflicts.map((c) => c.id),
    questions: questions.map((q) => q.id),
    decisions: decisions.map((d) => d.id),
    recommendations: batch.map((id) => state.recommendations.get(id)?.id as string),
    blocks: parsed.blocks.map((b) => ({ blockId: b.blockId, hash: b.hash })),
  });
  const fAlias = (id: string) => `F-${findings.findIndex((f) => f.findingId === id) + 1}`;
  const files = ["CLAUDE.md", "src/a.ts"].map(
    (path) => ({ path, status: "read", size: 1, hash: sha256(encode("a")) }) as SnapshotFile,
  );
  const context: RegenerateContext = {
    aliases,
    coverage: coverageIndex(
      {
        files,
        exclusions: buildExclusionRules({ userExclusions: [] }),
        ignoreRules: { state: "applied" } as never,
      },
      [],
    ),
    anchorable: anchorablePaths(files.map((f) => f.path)),
    destination: { state: "present", bytes: s.bytes, parsed },
    input: {
      findings: new Map(
        findings.map((f, i): [string, RecommendFinding] => [
          `F-${i + 1}`,
          {
            kind: "claim",
            mode: "descriptive",
            basis: ["code_observation"],
            current: true,
            evidence: (f as { evidenceIds: string[] }).evidenceIds.map((id) => {
              const ev = s.log.require("evidence", id) as { excerpt: string; path: string };
              return {
                id,
                kind: "lines",
                path: ev.path,
                excerpt: ev.excerpt,
                basis: "code_observation",
              };
            }),
          },
        ]),
      ),
      decisions: new Map(
        decisions.map((d, i) => [
          `D-${i + 1}`,
          { current: true, statement: d.statement, exceptions: d.exceptions },
        ]),
      ),
      conflicts: new Map(
        conflicts.map((c, i) => [
          `C-${i + 1}`,
          { members: c.findingIds.map(fAlias), status: c.status as "unresolved" | "resolved" },
        ]),
      ),
      questions: new Map(
        questions.map((q, i) => [
          `Q-${i + 1}`,
          { status: q.status, resolves: q.findingIds.map(fAlias) },
        ]),
      ),
    },
    ...regenerationInput(s.log.records, s.bytes, aliases, affectedSet),
  };
  return { context, aliases };
}

function regenerate(
  s: Session,
  batch: readonly string[],
  response: object,
  affectedSet: readonly string[] = batch,
) {
  const { context, aliases } = regenerateContext(s, batch, affectedSet);
  const validation = validateRegenerate(JSON.stringify(response), context);
  const modelCallId = completed(s.log, "regenerate_recommendations");
  const recorded = recordRegenerate({ log: s.log, modelCallId, aliases }, validation);
  return { validation, modelCallId, recorded };
}

const latest = (s: Session, recommendationId: string) =>
  s.log.revisions("recommendation_revision", recommendationId).at(-1) as Record<string, unknown>;

const body = (extra: Record<string, unknown> = {}) => ({
  kind: "fact",
  operation: "add",
  target: { kind: "after", block: "B-2" },
  content: "Code is in one module.",
  rationale: "Observed.",
  support: ["F-1"],
  references: [],
  scope: { kind: "repository" },
  ...extra,
});

// --- The affected set ---------------------------------------------------------------------

describe("the affected set (IMPL §3.3.6, DM §12)", () => {
  it("holds a recommendation supported by a superseded decision, and not an unrelated one", () => {
    const s = session();
    const f = finding(s);
    const q = question(s, { findingIds: [f.findingId] });
    const d1 = decision(s, { questionId: q.questionId });
    const onD1 = recommend(s, [onDecision(d1)], { kind: "policy" });
    const other = recommend(s, [onFinding(f)], { content: "Other text here." });
    const d2 = decision(s, { questionId: q.questionId, supersedes: d1.id });
    expect(affectedRecommendations(s.log.records, [d2.id])).toEqual([
      onD1.recommendationId,
      // Covered: the changed decision's question resolves its finding.
      other.recommendationId,
    ]);
    // Without the trigger, only support that is no longer current counts.
    expect(affectedRecommendations(s.log.records, [])).toEqual([onD1.recommendationId]);
  });

  it("holds a recommendation whose finding the developer corrected (§4.5, §4.11)", () => {
    const s = session();
    const f = finding(s);
    const g = finding(s, "export const b = 2;");
    const onF = recommend(s, [onFinding(f)]);
    recommend(s, [onFinding(g)], { content: "Other text here." });
    const d = decision(s, { findingId: f.findingId });
    expect(affectedRecommendations(s.log.records, [d.id])).toEqual([onF.recommendationId]);
  });

  it("holds a recommendation whose finding was withdrawn, or is of an earlier snapshot", () => {
    const s = session();
    const f = finding(s);
    const g = finding(s, "export const b = 2;");
    const onF = recommend(s, [onFinding(f)]);
    const onG = recommend(s, [onFinding(g)], { content: "Other text here." });
    s.log.revise("finding", f.findingId, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
    });
    expect(affectedRecommendations(s.log.records, [])).toEqual([onF.recommendationId]);
    refresh(s, GUIDE);
    expect(affectedRecommendations(s.log.records, [])).toEqual([
      onF.recommendationId,
      onG.recommendationId,
    ]);
  });

  it("covers the members of a conflict the question resolves, and of the decision's conflict", () => {
    const s = session();
    const [f, g, h] = [finding(s), finding(s, "b = 2;"), finding(s, "c = 3;")];
    const c = conflict(s, [f.findingId, g.findingId]);
    const q = question(s, { conflictIds: [c.conflictId] });
    const onF = recommend(s, [onFinding(f)]);
    const onG = recommend(s, [onFinding(g)], { content: "Other text here." });
    recommend(s, [onFinding(h)], { content: "Third text here." });
    const viaQuestion = decision(s, { questionId: q.questionId });
    expect(affectedRecommendations(s.log.records, [viaQuestion.id])).toEqual([
      onF.recommendationId,
      onG.recommendationId,
    ]);
    const viaConflict = decision(s, { conflictId: c.conflictId });
    expect(affectedRecommendations(s.log.records, [viaConflict.id])).toEqual([
      onF.recommendationId,
      onG.recommendationId,
    ]);
  });
});

describe("planning the calls (IMPL §3.3.6, §4.11)", () => {
  it("splits an affected set of 31 into calls of 30 and 1, in recommendation order", () => {
    const s = session();
    const f = finding(s);
    const recs = Array.from({ length: 31 }, (_, i) =>
      recommend(s, [onFinding(f)], { content: `Text number ${i + 1}.` }),
    );
    const d = decision(s, { findingId: f.findingId });
    const plan = planRegeneration(s.log.records, { kind: "decision", decisionId: d.id });
    expect(plan.calls.map((c) => c.length)).toEqual([30, 1]);
    expect(plan.calls.flat()).toEqual(recs.map((r) => r.recommendationId));
  });

  it("a split call's DUP-004 doesn't compare with a later part of the affected set", () => {
    const s = session();
    const f = finding(s);
    const recs = Array.from({ length: 31 }, (_, i) =>
      recommend(s, [onFinding(f)], { content: `Text number ${i + 1}.` }),
    );
    const g = finding(s, "export const b = 2;");
    const d = decision(s, { findingId: f.findingId });
    const plan = planRegeneration(s.log.records, { kind: "decision", decisionId: d.id });
    const [first] = plan.calls as [string[]];
    const { validation } = regenerate(
      s,
      first,
      {
        actions: first.map((_, i) =>
          i === 0
            ? {
                target: "R-1",
                action: "revise",
                reason: "Same as the last.",
                revision: body({ content: "Text number 31.", support: ["F-1"] }),
              }
            : { target: `R-${i + 1}`, action: "drop", reason: "Gone." },
        ),
        additions: [],
        heldBack: [],
      },
      plan.calls.flat(),
    );
    expect(validation.result.events).toEqual([]);
    expect(latest(s, recs[0]?.recommendationId as string)).toMatchObject({
      content: "Text number 31.",
      support: [{ kind: "finding", findingId: g.findingId }],
    });
  });

  it("a new decision with an empty affected set calls only to unblock a current held-back entry", () => {
    const s = session();
    const f = finding(s);
    const q = question(s, { findingIds: [f.findingId] }, "skipped");
    const unrelated = question(s, { findingIds: [f.findingId] }, "skipped");
    s.log.append({
      type: "held_back",
      topic: "Which client to use.",
      blockedBy: [q.questionId],
      modelCallId: s.callId,
    });
    const other = answer(s, unrelated.questionId).decision;
    expect(planRegeneration(s.log.records, { kind: "decision", decisionId: other.id })).toEqual({
      calls: [],
    });
    const d = answer(s, q.questionId).decision;
    expect(planRegeneration(s.log.records, { kind: "decision", decisionId: d.id })).toEqual({
      calls: [[]],
    });
    // Once the entry isn't current, a later decision on that question unblocks nothing.
    const again = decision(s, { questionId: q.questionId, supersedes: d.id });
    expect(planRegeneration(s.log.records, { kind: "decision", decisionId: again.id })).toEqual({
      calls: [],
    });
  });

  it("a refresh with nothing affected makes no call", () => {
    const s = session();
    expect(planRegeneration(s.log.records, { kind: "refresh" })).toEqual({ calls: [] });
  });
});

describe("answerQuestion (IMPL §3.3.6, §4.4.1)", () => {
  it("appends the decision, then the question's answered revision", () => {
    const s = session();
    const q = question(s, { findingIds: [finding(s).findingId] });
    const before = s.log.records.length;
    const { decision: d, question: answered } = answer(s, q.questionId);
    expect(s.log.records.slice(before).map((r) => r.id)).toEqual([d.id, answered.id]);
    expect(d).toMatchObject({ questionId: q.questionId, origin: "answered_question" });
    expect(answered).toMatchObject({ status: "answered", revision: 2, supersedes: [q.id] });
  });

  it("answers a skipped question", () => {
    const s = session();
    const q = question(s, { findingIds: [finding(s).findingId] }, "skipped");
    expect(answer(s, q.questionId).question.status).toBe("answered");
  });

  it("refuses an answered or unknown question, appending nothing", () => {
    const s = session();
    const q = question(s, { findingIds: [finding(s).findingId] }, "answered");
    const before = s.log.records.length;
    expect(() => answer(s, q.questionId)).toThrow(/answered/);
    expect(() => answer(s, "q_missing")).toThrow(/no current question/);
    expect(s.log.records.length).toBe(before);
  });
});

// --- target_changed ------------------------------------------------------------------------

describe("target_changed after a refresh (IMPL §3.3.6, §4.4.2, §3.8; DM §9.4, §12)", () => {
  it("invalidates a target that resolves to no block, by code and with no revisedBy", () => {
    const s = session();
    const f = finding(s);
    const gone = recommend(s, [onFinding(f)], {
      operation: "revise",
      target: { kind: "block", ...block(s, "Guide/Other/paragraph-1") },
      content: "Changed text.",
    });
    const kept = recommend(s, [onFinding(f)], { content: "Other text here." });
    refresh(s, "# Guide\n\nIntro.\n\n## Testing\n\nTesting text.\n");
    const invalidated = invalidateChangedTargets(s.log, s.bytes);
    expect(invalidated.map((r) => r.recommendationId)).toEqual([gone.recommendationId]);
    expect(latest(s, gone.recommendationId)).toMatchObject({
      status: "invalidated",
      invalidatedReason: "target_changed",
    });
    expect(latest(s, gone.recommendationId)["revisedBy"]).toBeUndefined();
    expect(latest(s, kept.recommendationId)["id"]).toBe(kept.id);
  });

  it("invalidates a target whose hash two blocks now share", () => {
    const s = session();
    const r = recommend(s, [onFinding(finding(s))], {
      operation: "revise",
      target: { kind: "block", ...block(s, "Guide/Other/paragraph-1") },
      content: "Changed text.",
    });
    refresh(s, "# Guide\n\nIntro.\n\nOther text.\n\n## Testing\n\nOther text.\n");
    expect(invalidateChangedTargets(s.log, s.bytes).map((x) => x.recommendationId)).toEqual([
      r.recommendationId,
    ]);
  });

  it("keeps a re-anchored target that still passes alone, and writes nothing for it", () => {
    const s = session();
    recommend(s, [onFinding(finding(s))], {
      target: { kind: "section", ...block(s, "Guide/Testing/heading") },
    });
    refresh(s, GUIDE.replace("# Guide", "# Handbook"));
    const before = s.log.records.length;
    expect(invalidateChangedTargets(s.log, s.bytes)).toEqual([]);
    expect(s.log.records.length).toBe(before);
  });

  it("§3.8: invalidates a re-anchored revision that no longer passes REC-003 alone", () => {
    const s = session();
    const r = recommend(s, [onFinding(finding(s))], {
      target: { kind: "section", ...block(s, "Guide/Testing/heading") },
      content: "    indented code",
    });
    // Renamed, so the section's heading has a new ID; and its last block is now a list item,
    // which the indented code would merge into.
    refresh(s, GUIDE.replace("# Guide", "# Handbook").replace("Testing text.", "- An item."));
    expect(invalidateChangedTargets(s.log, s.bytes).map((x) => x.recommendationId)).toEqual([
      r.recommendationId,
    ]);
  });

  it("invalidates an unchanged target that no longer passes alone, its section's last block changed", () => {
    const s = session();
    const r = recommend(s, [onFinding(finding(s))], {
      target: { kind: "section", ...block(s, "Guide/Testing/heading") },
      content: "    indented code",
    });
    refresh(s, GUIDE.replace("Testing text.", "Testing text.\n\n- An item."));
    expect(invalidateChangedTargets(s.log, s.bytes).map((x) => x.recommendationId)).toEqual([
      r.recommendationId,
    ]);
  });

  it("invalidates block targets when the destination becomes absent, but not a new section", () => {
    const s = session();
    const f = finding(s);
    const onBlock = recommend(s, [onFinding(f)]);
    const section = recommend(s, [onFinding(f)], {
      target: { kind: "newSection", heading: "Notes" },
      content: "Other text here.",
    });
    appendSnapshot(s.log, undefined);
    const invalidated = invalidateChangedTargets(s.log, undefined);
    expect(invalidated.map((x) => x.recommendationId)).toEqual([onBlock.recommendationId]);
    expect(latest(s, section.recommendationId)["id"]).toBe(section.id);
  });

  it("the change summary names the target_changed invalidations since the last regeneration", () => {
    const s = session();
    const f = finding(s);
    const gone = recommend(s, [onFinding(f)], {
      operation: "revise",
      target: { kind: "block", ...block(s, "Guide/Other/paragraph-1") },
      content: "Changed text.",
    });
    refresh(s, "# Guide\n\nIntro.\n");
    invalidateChangedTargets(s.log, s.bytes);
    expect(changeSummary(s.log.records, { kind: "refresh" })).toEqual({
      changedDecisionIds: [],
      targetChanged: [gone.recommendationId],
    });
    // A call that hasn't completed, such as one still to be retried, told the model nothing.
    s.log.start(callDraft({ purpose: "regenerate_recommendations" }));
    expect(changeSummary(s.log.records, { kind: "refresh" }).targetChanged).toEqual([
      gone.recommendationId,
    ]);
    completed(s.log, "regenerate_recommendations");
    expect(changeSummary(s.log.records, { kind: "refresh" }).targetChanged).toEqual([]);
  });
});

describe("after the target_changed invalidations, nothing throws (M5)", () => {
  function scenario(acceptOther = false) {
    const s = session();
    const f = finding(s);
    const gone = recommend(s, [onFinding(f)], {
      operation: "revise",
      target: { kind: "block", ...block(s, "Guide/Other/paragraph-1") },
      content: "Changed text.",
    });
    accept(s, gone);
    const other = recommend(s, [onFinding(f)], {
      operation: "revise",
      target: { kind: "block", ...block(s, "Guide/paragraph-1") },
      content: "New intro.",
    });
    if (acceptOther) accept(s, other);
    refresh(s, "# Guide\n\nIntro.\n");
    return { s, other };
  }

  it("currentState with a destination", () => {
    const { s } = scenario(true);
    expect(() => currentState(s.log.records, { destination: s.bytes })).toThrow(/target_changed/);
    invalidateChangedTargets(s.log, s.bytes);
    expect(currentState(s.log.records, { destination: s.bytes }).clashes).toEqual([]);
  });

  it("select", () => {
    const { s, other } = scenario();
    expect(() => accept(s, other)).toThrow(/target_changed/);
    invalidateChangedTargets(s.log, s.bytes);
    expect(() => accept(s, other)).not.toThrow();
  });

  it("exclusions", () => {
    const { s, other } = scenario();
    expect(() => exclusions(s.log.records, s.bytes, other.recommendationId)).toThrow(
      /target_changed/,
    );
    invalidateChangedTargets(s.log, s.bytes);
    expect(exclusions(s.log.records, s.bytes, other.recommendationId)).toEqual([]);
  });
});

// --- Recording a regeneration --------------------------------------------------------------

describe("recording a regeneration (IMPL §3.3.6, §4.4.1, §4.4.3, §4.11)", () => {
  /** Four affected recommendations on a corrected finding `f`, with `g` still current. */
  function affected() {
    const s = session();
    const f = finding(s);
    const g = finding(s, "export const b = 2;");
    const recs = ["One text.", "Two text.", "Three text.", "Four text."].map((content) =>
      recommend(s, [onFinding(f), onFinding(g)], { content }),
    );
    for (const r of recs) accept(s, r);
    const unaffected = recommend(s, [onFinding(g)], { content: "Unaffected text." });
    const d = decision(s, { findingId: f.findingId });
    const batch = affectedRecommendations(s.log.records, [d.id]);
    expect(batch).toEqual(recs.map((r) => r.recommendationId));
    return { s, recs, unaffected, batch };
  }

  it("keep fails revalidation, drop and revise, and an omitted one, each with its record", () => {
    const { s, recs, batch } = affected();
    const { validation, modelCallId } = regenerate(s, batch, {
      actions: [
        { target: "R-1", action: "keep", reason: "Still right." },
        { target: "R-2", action: "drop", reason: "No longer needed." },
        {
          target: "R-3",
          action: "revise",
          reason: "Narrowed.",
          revision: body({ content: "Three text, revised." }),
        },
      ],
      additions: [],
      heldBack: [],
    });
    const [r1, r2, r3, r4] = recs.map((r) => r.recommendationId) as [
      string,
      string,
      string,
      string,
    ];
    expect(
      validation.result.events.map(({ itemKey, stage, rule }) => [itemKey, stage, rule]),
    ).toEqual([
      // R-1's support names the corrected finding, which has no alias here.
      ["R-1", "item", "REC-001"],
      ["R-4", "cross_item", "REGEN-001"],
    ]);
    expect(latest(s, r1)).toMatchObject({
      status: "invalidated",
      invalidatedReason: "revalidation_failed",
      revisedBy: modelCallId,
    });
    expect(latest(s, r2)).toMatchObject({
      invalidatedReason: "dropped_by_model",
      revisedBy: modelCallId,
    });
    expect(latest(s, r3)).toMatchObject({
      status: "valid",
      content: "Three text, revised.",
      producedBy: modelCallId,
      revision: 2,
      supersedes: [recs[2]?.id],
    });
    expect(latest(s, r3)["revisedBy"]).toBeUndefined();
    expect(latest(s, r4)).toMatchObject({
      invalidatedReason: "not_reconsidered",
      revisedBy: modelCallId,
    });
    // The revised recommendation is pending again; nothing was written to make it so.
    const state = currentState(s.log.records);
    expect(state.selections.has(r3)).toBe(false);
    expect([...state.recommendations.keys()]).toContain(r3);
  });

  it("a keep that passes revalidation changes nothing, and its selection still counts", () => {
    const s = session();
    const f = finding(s);
    const q = question(s, { findingIds: [f.findingId] });
    const r = recommend(s, [onFinding(f)]);
    accept(s, r);
    const d = decision(s, { questionId: q.questionId });
    const batch = affectedRecommendations(s.log.records, [d.id]);
    expect(batch).toEqual([r.recommendationId]);
    const before = s.log.records.length;
    const { validation } = regenerate(s, batch, {
      actions: [{ target: "R-1", action: "keep", reason: "Still right." }],
      additions: [],
      heldBack: [],
    });
    expect(validation.result.events).toEqual([]);
    // Only the call's two records were appended.
    expect(s.log.records.length).toBe(before + 2);
    expect(currentState(s.log.records).selections.get(r.recommendationId)?.revisionId).toBe(r.id);
  });

  it("failed keep, drop and revise actions: their failed records, then not_reconsidered", () => {
    const { s, recs, batch } = affected();
    const long = "x".repeat(201);
    const { modelCallId } = regenerate(s, batch, {
      actions: [
        { target: "R-1", action: "keep", reason: long },
        { target: "R-2", action: "drop", reason: long },
        {
          target: "R-3",
          action: "revise",
          reason: "Narrowed.",
          revision: body({ operation: "remove" }),
        },
        { target: "F-1", action: "drop", reason: "Wrong alias." },
        { target: "R-4", action: "drop", reason: "Gone." },
      ],
      additions: [],
      heldBack: [],
    });
    const failedItems = s.log.records.filter((r) => r.type === "failed_item");
    expect(failedItems.map((r) => [r.collection, r.itemKey, r.rejectedBy])).toEqual([
      ["actions", "actions/0", ["LIMIT-001"]],
      ["actions", "actions/1", ["LIMIT-001"]],
      ["actions", "actions/3", ["ALIAS-003"]],
    ]);
    const r3 = recs[2]?.recommendationId as string;
    const history = s.log.revisions("recommendation_revision", r3);
    expect(history.map((r) => r.status)).toEqual(["valid", "failed_validation", "invalidated"]);
    // An add revised as a remove keeps no operation (REGEN-002).
    expect(history[1]).toMatchObject({ itemKey: "actions/2", rejectedBy: ["REGEN-002"] });
    for (const r of recs.slice(0, 3))
      expect(latest(s, r.recommendationId)).toMatchObject({
        invalidatedReason: "not_reconsidered",
        revisedBy: modelCallId,
      });
    expect(latest(s, recs[3]?.recommendationId as string)).toMatchObject({
      invalidatedReason: "dropped_by_model",
    });
  });

  it("records additions as new lineages and held-back entries for the call", () => {
    const s = session();
    finding(s);
    const g = finding(s, "export const b = 2;");
    // The question resolves only g, so additions on f don't wait for it (REC-008).
    const q = question(s, { findingIds: [g.findingId] }, "skipped");
    s.log.append({
      type: "held_back",
      topic: "Old.",
      blockedBy: [q.questionId],
      modelCallId: s.callId,
    });
    const { modelCallId, recorded } = regenerate(s, [], {
      actions: [],
      additions: [
        { key: "r1", ...body() },
        { key: "r2", ...body() },
      ],
      heldBack: [{ topic: "Still blocked.", blockedBy: ["Q-1"] }],
    });
    const id = recorded.additions.get("r1") as string;
    expect(latest(s, id)).toMatchObject({ revision: 1, status: "valid", producedBy: modelCallId });
    // The duplicate addition is a failed revision of a new lineage.
    const failed = s.log.records.filter(
      (r) => r.type === "recommendation_revision" && r.status === "failed_validation",
    );
    expect(failed.map((r) => [r.itemKey, r.rejectedBy])).toEqual([["r2", ["DUP-004"]]]);
    expect(recorded.heldBack.map((h) => [h.topic, h.modelCallId])).toEqual([
      ["Still blocked.", modelCallId],
    ]);
  });

  it("a revise or addition duplicating an unaffected recommendation is rejected (DUP-004)", () => {
    const { s, batch } = affected();
    const { validation } = regenerate(s, batch, {
      actions: [
        {
          target: "R-1",
          action: "revise",
          reason: "Same.",
          revision: body({ content: "Unaffected text.", support: ["F-1"] }),
        },
        { target: "R-2", action: "drop", reason: "Gone." },
        { target: "R-3", action: "drop", reason: "Gone." },
        { target: "R-4", action: "drop", reason: "Gone." },
      ],
      additions: [{ key: "r1", ...body({ content: "Unaffected text." }) }],
      heldBack: [],
    });
    expect(validation.result.events.map(({ itemKey, rule }) => [itemKey, rule])).toEqual([
      ["actions/0", "DUP-004"],
      ["r1", "DUP-004"],
      ["R-1", "REGEN-001"],
    ]);
  });

  it("a schema failure records nothing", () => {
    const { s, batch } = affected();
    const before = s.log.records.length;
    regenerate(s, batch, { actions: "no" });
    expect(s.log.records.length).toBe(before + 2);
  });
});

describe("a corrected decision, then proposing (M5, DM §9.4, §12)", () => {
  function scenario() {
    const s = session();
    const f = finding(s);
    const q = question(s, { findingIds: [f.findingId] });
    const d1 = decision(s, { questionId: q.questionId });
    const r = recommend(s, [onDecision(d1)], { kind: "policy", content: "Shared client text." });
    accept(s, r);
    expect(proposeArtifact(s.log, s.bytes).kind).toBe("created");
    const d2 = decision(s, { questionId: q.questionId, supersedes: d1.id });
    expect(proposeArtifact(s.log, s.bytes)).toEqual({
      kind: "stale",
      recommendationIds: [r.recommendationId],
    });
    const plan = planRegeneration(s.log.records, { kind: "decision", decisionId: d2.id });
    expect(plan.calls).toEqual([[r.recommendationId]]);
    return { s, r, batch: plan.calls[0] as string[] };
  }

  it("after a schema failure, names the stale recommendation, which the developer rejects", () => {
    const { s, r, batch } = scenario();
    regenerate(s, batch, { actions: "no" });
    expect(proposeArtifact(s.log, s.bytes)).toEqual({
      kind: "stale",
      recommendationIds: [r.recommendationId],
    });
    const outcome = select(s.log, s.bytes, {
      recommendationId: r.recommendationId,
      revisionId: r.id,
      state: "rejected",
      actor: "developer",
      selectedAt: "2026-11-01T10:40:00.000Z",
    });
    expect(outcome.selected).toBe(true);
    expect(proposeArtifact(s.log, s.bytes).kind).toBe("nothing_accepted");
  });

  it("no longer throws after a keep that fails revalidation", () => {
    const { s, batch } = scenario();
    regenerate(s, batch, {
      actions: [{ target: "R-1", action: "keep", reason: "Still right." }],
      additions: [],
      heldBack: [],
    });
    expect(proposeArtifact(s.log, s.bytes).kind).toBe("nothing_accepted");
  });

  it("no longer throws after a revise on the new decision, which is pending again", () => {
    const { s, r, batch } = scenario();
    regenerate(s, batch, {
      actions: [
        {
          target: "R-1",
          action: "revise",
          reason: "Follows the new decision.",
          revision: body({ kind: "policy", content: "Shared client text.", support: ["D-1"] }),
        },
      ],
      additions: [],
      heldBack: [],
    });
    expect(currentState(s.log.records).selections.has(r.recommendationId)).toBe(false);
    expect(proposeArtifact(s.log, s.bytes).kind).toBe("nothing_accepted");
  });
});
