import { describe, expect, it } from "vitest";
import { callDraft, completedCall, hashOf, newLog } from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { buildExclusionRules } from "../snapshot/exclusions.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { createAliasTable } from "../validation/aliases.js";
import { coverageIndex } from "../validation/coverage.js";
import { type RecommendContext, validateRecommend } from "../validation/recommend.js";
import { anchorablePaths } from "../validation/support.js";
import { currentState } from "./current.js";
import type { Revised, SessionLog } from "./log.js";
import { recordRecommend } from "./recommendations.js";
import type { RecordOf } from "./records.js";

// `recommend` output into records, and the derived held-back entries and no-change reason
// (IMPL §3.3.5, §4.4.1–§4.4.3).

const DESTINATION = new TextEncoder().encode("# Guide\n\nIntro.\n");

function snapshot(log: SessionLog) {
  return log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: [
      { path: "package.json", status: "read", size: 10, hash: hashOf("a") },
      { path: "src/a.ts", status: "read", size: 10, hash: hashOf("b") },
    ],
    destination: { state: "absent" },
    readFailures: [],
    stability: { state: "stable" },
    git: { state: "unknown", reason: "not_inspected" },
    ignoreRules: { state: "applied" },
  });
}

function claim(log: SessionLog, snapshotId: string, path: string, excerpt: string) {
  const ev = log.append({
    type: "evidence",
    snapshotId,
    kind: "lines",
    path,
    fileHash: hashOf("a"),
    lineStart: 1,
    lineEnd: 1,
    excerpt,
    basis: "code_observation",
  });
  const finding = log.start({
    type: "finding",
    snapshotId,
    producedBy: "deterministic",
    status: "active",
    kind: "claim",
    statement: `\`${path}\` holds code.`,
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["code_observation"],
    evidenceIds: [ev.id],
  });
  return { finding, evidenceId: ev.id };
}

function question(log: SessionLog, findingId: string, status: "skipped" | "answered") {
  return log.start({
    type: "question",
    producedBy: "call_0001",
    prompt: "Which?",
    reason: "Unclear.",
    findingIds: [findingId],
    conflictIds: [],
    gapIds: [],
    options: [],
    scope: { kind: "repository" },
    status,
  });
}

function completedRecommendCall(
  log: SessionLog,
  purpose: "recommend" | "regenerate_recommendations" = "recommend",
) {
  const call = log.start(callDraft({ purpose }));
  log.revise("model_call", call.modelCallId, completedCall());
  return call.modelCallId;
}

/** A session with two claims, a skipped and an answered question, and the recommend context. */
function scenario() {
  const log = newLog();
  const snap = snapshot(log);
  const code = claim(log, snap.id, "src/a.ts", "export const a = 1;");
  const script = claim(log, snap.id, "package.json", '"test": "vitest run",');
  const other = claim(log, snap.id, "src/a.ts", "export const b = 2;");
  const skipped = question(log, other.finding.findingId, "skipped");
  const answered = question(log, other.finding.findingId, "answered");
  const parsed = parseGuidanceBlocks(DESTINATION);
  const aliases = createAliasTable("recommend", {
    findings: [code.finding.id, script.finding.id, other.finding.id],
    questions: [skipped.id, answered.id],
    blocks: parsed.blocks.map((b) => ({ blockId: b.blockId, hash: b.hash })),
  });
  const files = ["package.json", "src/a.ts"].map(
    (path) => ({ path, status: "read", size: 1, hash: hashOf("a") }) as SnapshotFile,
  );
  const context: RecommendContext = {
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
    destination: { state: "present", bytes: DESTINATION, parsed },
    input: {
      findings: new Map([
        [
          "F-1",
          {
            kind: "claim",
            mode: "descriptive",
            basis: ["code_observation"],
            current: true,
            evidence: [
              {
                id: code.evidenceId,
                kind: "lines",
                path: "src/a.ts",
                excerpt: "export const a = 1;",
              },
            ],
          },
        ],
        [
          "F-2",
          {
            kind: "claim",
            mode: "descriptive",
            basis: ["code_observation"],
            current: true,
            evidence: [
              {
                id: script.evidenceId,
                kind: "lines",
                path: "package.json",
                excerpt: '"test": "vitest run",',
              },
            ],
            command: { file: "package.json", name: "test" },
          },
        ],
        [
          "F-3",
          {
            kind: "claim",
            mode: "descriptive",
            basis: ["code_observation"],
            current: true,
            evidence: [],
          },
        ],
      ]),
      decisions: new Map(),
      conflicts: new Map(),
      questions: new Map([
        ["Q-1", { status: "skipped", resolves: ["F-3"] }],
        ["Q-2", { status: "answered", resolves: ["F-3"] }],
      ]),
    },
  };
  return { log, code, script, skipped, answered, aliases, context, blocks: parsed.blocks };
}

const recommendation = (extra: Record<string, unknown> = {}) => ({
  key: "r1",
  kind: "fact",
  operation: "add",
  target: { kind: "after", block: "B-2" },
  content: "Code is in `src/a.ts`; the suite runs with `pnpm test`.",
  rationale: "Observed.",
  support: ["F-1", "F-2"],
  references: [
    { kind: "path", value: "src/a.ts", support: "F-1" },
    { kind: "command", value: "pnpm test", support: "F-2" },
  ],
  scope: { kind: "repository" },
  ...extra,
});

function record(s: ReturnType<typeof scenario>, response: object) {
  const modelCallId = completedRecommendCall(s.log);
  const validation = validateRecommend(JSON.stringify(response), s.context);
  const recorded = recordRecommend({ log: s.log, modelCallId, aliases: s.aliases }, validation);
  return { modelCallId, recorded };
}

const ofType = <T extends RecordOf<"held_back">["type"] | string>(log: SessionLog, type: T) =>
  log.records.filter((r) => r.type === type);

describe("recording recommend output (IMPL §3.3.5, §4.4.1, §4.4.3)", () => {
  it("starts a valid lineage per accepted recommendation, with its aliases resolved", () => {
    const s = scenario();
    const { modelCallId, recorded } = record(s, {
      recommendations: [recommendation()],
      heldBack: [],
    });
    const [revision] = ofType(
      s.log,
      "recommendation_revision",
    ) as Revised<"recommendation_revision">[];
    expect(recorded.recommendations.get("r1")).toBe(revision?.recommendationId);
    const b2 = s.blocks[1];
    expect(revision).toMatchObject({
      revision: 1,
      status: "valid",
      producedBy: modelCallId,
      kind: "fact",
      operation: "add",
      target: { kind: "after", blockId: b2?.blockId, blockHash: b2?.hash },
      support: [
        { kind: "finding", findingId: s.code.finding.findingId },
        { kind: "finding", findingId: s.script.finding.findingId },
      ],
      references: [
        {
          kind: "path",
          value: "src/a.ts",
          supportingFindingId: s.code.finding.findingId,
          evidenceId: s.code.evidenceId,
          verification: "exists_in_snapshot",
        },
        {
          kind: "command",
          value: "pnpm test",
          supportingFindingId: s.script.finding.findingId,
          evidenceId: s.script.evidenceId,
          verification: "found_not_run",
        },
      ],
    });
    expect(revision).not.toHaveProperty("supersedes");
    expect(revision).not.toHaveProperty("revisedBy");
  });

  it("records held-back entries by lineage ID, and failed items in pipeline order", () => {
    const s = scenario();
    const { modelCallId, recorded } = record(s, {
      recommendations: [recommendation(), recommendation({ key: "r2", support: ["F-99"] })],
      heldBack: [
        { topic: "Which client", blockedBy: ["Q-1"] },
        { topic: "Answered already", blockedBy: ["Q-2"] },
      ],
      noChangeReason: "Nothing to change.",
    });
    expect(recorded.heldBack.map((h) => [h.topic, h.blockedBy, h.modelCallId])).toEqual([
      ["Which client", [s.skipped.questionId], modelCallId],
    ]);
    expect(recorded.noChangeReason).toBeUndefined();

    const failed = s.log.records.filter(
      (r) => (r as { status?: string }).status === "failed_validation",
    );
    expect(
      failed.map((r) => [
        r.type,
        (r as { collection?: string }).collection,
        (r as { itemKey: string }).itemKey,
        (r as { rejectedBy: string[] }).rejectedBy,
      ]),
    ).toEqual([
      ["recommendation_revision", undefined, "r2", ["ALIAS-001"]],
      ["failed_item", "heldBack", "heldBack/1", ["HELD-001"]],
      ["failed_item", "noChangeReason", "noChangeReason", ["REC-009"]],
    ]);
    // A failed recommendation starts its own lineage and supersedes nothing.
    const failedRevision = failed[0] as RecordOf<"recommendation_revision">;
    expect(failedRevision).toMatchObject({ revision: 1, proposed: { key: "r2" } });
    expect(failed[2]).toMatchObject({ proposed: "Nothing to change." });
  });

  it("records an accepted no-change reason", () => {
    const s = scenario();
    const { modelCallId, recorded } = record(s, {
      recommendations: [],
      heldBack: [],
      noChangeReason: "The file already says it.",
    });
    expect(recorded.noChangeReason).toMatchObject({
      type: "no_change_reason",
      reason: "The file already says it.",
      modelCallId,
    });
  });

  it("records nothing for a response that fails the schema", () => {
    const s = scenario();
    const before = s.log.records.length;
    const modelCallId = completedRecommendCall(s.log);
    const after = s.log.records.length;
    const validation = validateRecommend("not json", s.context);
    recordRecommend({ log: s.log, modelCallId, aliases: s.aliases }, validation);
    expect(s.log.records.length).toBe(after);
    expect(after).toBe(before + 2);
  });

  it("lets an invalidation supersede the valid revision, naming its call", () => {
    const s = scenario();
    const { recorded } = record(s, { recommendations: [recommendation()], heldBack: [] });
    const id = recorded.recommendations.get("r1") as string;
    const regeneration = completedRecommendCall(s.log, "regenerate_recommendations");
    const invalidated = s.log.revise("recommendation_revision", id, {
      status: "invalidated",
      invalidatedReason: "dropped_by_model",
      revisedBy: regeneration,
    });
    expect(invalidated).toMatchObject({ revision: 2, status: "invalidated" });
    expect(currentState(s.log.records).recommendations.size).toBe(0);
  });
});

describe("recommendation revision records (IMPL §4.4.1, DM §9.1)", () => {
  it("lets an invalidation change only its status and reason, and revisedBy", () => {
    const s = scenario();
    const { recorded } = record(s, { recommendations: [recommendation()], heldBack: [] });
    const id = recorded.recommendations.get("r1") as string;
    expect(() =>
      s.log.revise("recommendation_revision", id, {
        status: "invalidated",
        invalidatedReason: "target_changed",
        rationale: "Changed on invalidation.",
      }),
    ).toThrow(/invalidation/);
  });

  it("keeps validationEvents to developer_edit revisions", () => {
    const s = scenario();
    const modelCallId = completedRecommendCall(s.log);
    const draft = {
      type: "recommendation_revision" as const,
      kind: "fact" as const,
      operation: "add" as const,
      target: { kind: "newSection" as const, heading: "Notes" },
      content: "Notes.",
      rationale: "Why.",
      support: [{ kind: "finding" as const, findingId: s.code.finding.findingId }],
      references: [],
      scope: { kind: "repository" as const },
      status: "valid" as const,
      validationEvents: [],
    };
    expect(() => s.log.start({ ...draft, producedBy: modelCallId })).toThrow(/validationEvents/);
    expect(() => s.log.start({ ...draft, producedBy: "developer_edit" })).not.toThrow();
  });
});

describe("current held-back entries and no-change reason (IMPL §4.4.2)", () => {
  const entry = (log: SessionLog, modelCallId: string, topic: string, blockedBy: string[]) =>
    log.append({ type: "held_back", topic, blockedBy, modelCallId });

  it("keeps the latest completed recommend call's entries and later regenerations'", () => {
    const s = scenario();
    const q = s.skipped.questionId;
    const earlyRegen = completedRecommendCall(s.log, "regenerate_recommendations");
    entry(s.log, earlyRegen, "early regeneration", [q]);
    const first = completedRecommendCall(s.log);
    entry(s.log, first, "first call", [q]);
    const second = completedRecommendCall(s.log);
    const kept = entry(s.log, second, "second call", [q]);
    const unfinished = s.log.start(callDraft({ purpose: "regenerate_recommendations" }));
    entry(s.log, unfinished.modelCallId, "unfinished", [q]);
    const regen = completedRecommendCall(s.log, "regenerate_recommendations");
    const later = entry(s.log, regen, "later regeneration", [q]);
    expect(currentState(s.log.records).heldBack.map((h) => h.id)).toEqual([kept.id, later.id]);
  });

  it("keeps an entry only while a blocker still blocks", () => {
    const s = scenario();
    const call = completedRecommendCall(s.log);
    const blocked = entry(s.log, call, "blocked", [s.skipped.questionId, s.answered.questionId]);
    entry(s.log, call, "answered", [s.answered.questionId]);
    expect(currentState(s.log.records).heldBack.map((h) => h.id)).toEqual([blocked.id]);
    s.log.revise("question", s.skipped.questionId, { status: "answered" });
    expect(currentState(s.log.records).heldBack).toEqual([]);
  });

  it("keeps an entry blocked by a conflict while it is unresolved", () => {
    const s = scenario();
    const conflict = s.log.start({
      type: "conflict",
      snapshotId: s.log.records.find((r) => r.type === "snapshot")?.id as string,
      producedBy: "call_0001",
      findingIds: [s.code.finding.findingId, s.script.finding.findingId],
      description: "They disagree.",
      status: "unresolved",
    });
    const call = completedRecommendCall(s.log);
    const blocked = entry(s.log, call, "contested", [conflict.conflictId]);
    expect(currentState(s.log.records).heldBack.map((h) => h.id)).toEqual([blocked.id]);
    const decision = s.log.append({
      type: "decision",
      statement: "Use the client.",
      scope: { kind: "repository" },
      exceptions: [],
      conflictId: conflict.conflictId,
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:30:00.000Z",
    });
    s.log.revise("conflict", conflict.conflictId, {
      status: "resolved",
      resolvingDecisionId: decision.id,
    });
    expect(currentState(s.log.records).heldBack).toEqual([]);
  });

  it("drops an entry whose blockers are no longer current after a refresh", () => {
    const s = scenario();
    const call = completedRecommendCall(s.log);
    entry(s.log, call, "blocked", [s.skipped.questionId]);
    expect(currentState(s.log.records).heldBack).toHaveLength(1);
    // A new snapshot leaves the question's finding, and so the question, not current.
    snapshot(s.log);
    expect(currentState(s.log.records).heldBack).toEqual([]);
  });

  it("keeps one entry per topic and blockedBy set, the earliest", () => {
    const s = scenario();
    const q = s.skipped.questionId;
    const a = s.answered.questionId;
    // Answered, so it doesn't block, but it is still part of the set.
    const call = completedRecommendCall(s.log);
    const first = entry(s.log, call, "Which client", [q, a]);
    const regen = completedRecommendCall(s.log, "regenerate_recommendations");
    entry(s.log, regen, "Which client", [a, q]);
    const other = entry(s.log, regen, "Which client", [q]);
    expect(currentState(s.log.records).heldBack.map((h) => h.id)).toEqual([first.id, other.id]);
  });

  it("shows the latest recommend call's no-change reason while no recommendation is current", () => {
    const s = scenario();
    const old = completedRecommendCall(s.log);
    s.log.append({ type: "no_change_reason", reason: "Old.", modelCallId: old });
    expect(currentState(s.log.records).noChangeReason?.reason).toBe("Old.");
    const { recorded } = record(s, {
      recommendations: [],
      heldBack: [],
      noChangeReason: "Nothing.",
    });
    expect(currentState(s.log.records).noChangeReason?.id).toBe(recorded.noChangeReason?.id);
    record(s, { recommendations: [recommendation()], heldBack: [] });
    expect(currentState(s.log.records).noChangeReason).toBeUndefined();
  });

  it("hides the no-change reason while a recommendation of a later call is current", () => {
    const s = scenario();
    const { recorded } = record(s, { recommendations: [], heldBack: [], noChangeReason: "No." });
    expect(currentState(s.log.records).noChangeReason?.id).toBe(recorded.noChangeReason?.id);
    // A regeneration addition makes a recommendation current; the recommend call stays latest.
    const regeneration = completedRecommendCall(s.log, "regenerate_recommendations");
    s.log.start({
      type: "recommendation_revision",
      kind: "fact",
      operation: "add",
      target: { kind: "newSection", heading: "Notes" },
      content: "Notes.",
      rationale: "Why.",
      support: [{ kind: "finding", findingId: s.code.finding.findingId }],
      references: [],
      scope: { kind: "repository" },
      producedBy: regeneration,
      status: "valid",
    });
    expect(currentState(s.log.records).noChangeReason).toBeUndefined();
  });
});
