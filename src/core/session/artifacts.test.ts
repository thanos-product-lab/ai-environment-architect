import { describe, expect, it } from "vitest";
import { callDraft, completedCall, newLog } from "../../../test/support/session.js";
import { type GuidanceBlock, parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { proposeArtifact, type ReviewRequest, recordReview } from "./artifacts.js";
import { currentState } from "./current.js";
import type { Revised, SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";
import { select } from "./selections.js";
import { contentRefOf } from "./store.js";

// Artifact revisions, reviews and the usable approval (DM §9.4, §10, §12, §17; IMPL §4.4.2
// "Active artifact revision", "Usable approval").

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const GUIDE = ["# Guide", "", "Intro.", "", "## Testing", "", "- Run the tests.", ""].join("\n");

interface Fixture {
  readonly log: SessionLog;
  /** The active snapshot's destination bytes, or undefined when it isn't present. */
  bytes: Uint8Array | undefined;
  blocks: readonly GuidanceBlock[];
  readonly findingId: string;
  readonly callId: string;
}

type Destination =
  | { readonly state: "present"; readonly text: string }
  | { readonly state: "absent" }
  | { readonly state: "unavailable" };

function appendSnapshot(log: SessionLog, destination: Destination) {
  if (destination.state !== "present") {
    log.append({
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [],
      destination:
        destination.state === "absent"
          ? { state: "absent" }
          : { state: "unavailable", reason: "symlink" },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    });
    return { bytes: undefined, blocks: [] };
  }
  const bytes = encode(destination.text);
  const parsed = parseGuidanceBlocks(bytes);
  log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: [{ path: "CLAUDE.md", status: "read", size: bytes.length, hash: sha256(bytes) }],
    destination: {
      state: "present",
      contentRef: contentRefOf(bytes),
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
  return { bytes, blocks: parsed.blocks };
}

function fixture(destination: Destination = { state: "present", text: GUIDE }): Fixture {
  const log = newLog();
  const { bytes, blocks } = appendSnapshot(log, destination);
  const snapshotId = (log.records.at(-1) as { id: string }).id;
  const ev = log.append({
    type: "evidence",
    snapshotId,
    kind: "lines",
    path: "docs/guide.md",
    fileHash: sha256(encode("guide")),
    lineStart: 1,
    lineEnd: 1,
    excerpt: "Guide.",
    basis: "documentation",
  });
  const finding = log.start({
    type: "finding",
    snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement: "A guide exists.",
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["documentation"],
    evidenceIds: [ev.id],
  });
  const call = log.start(callDraft({ purpose: "recommend" }));
  log.revise("model_call", call.modelCallId, completedCall());
  return { log, bytes, blocks, findingId: finding.findingId, callId: call.modelCallId };
}

function refresh(f: Fixture, text: string): void {
  const { bytes, blocks } = appendSnapshot(f.log, { state: "present", text });
  f.bytes = bytes;
  f.blocks = blocks;
}

function ref(f: Fixture, id: string) {
  const block = f.blocks.find((b) => b.blockId === id);
  if (block === undefined) throw new Error(`no block ${id}`);
  return { blockId: block.blockId, blockHash: block.hash };
}

type Target = Revised<"recommendation_revision">["target"];

function recommend(
  f: Fixture,
  operation: "add" | "revise" | "remove",
  target: Target,
  content?: string,
  support: Revised<"recommendation_revision">["support"] = [
    { kind: "finding", findingId: f.findingId },
  ],
): Revised<"recommendation_revision"> {
  return f.log.start({
    type: "recommendation_revision",
    kind: "fact",
    operation,
    target,
    ...(operation === "remove" ? {} : { content: content ?? "New text." }),
    rationale: "Helps.",
    support,
    references: [],
    scope: { kind: "repository" },
    producedBy: f.callId,
    status: "valid",
  });
}

function choose(
  f: Fixture,
  revision: Revised<"recommendation_revision">,
  state: "accepted" | "rejected" | "pending" = "accepted",
) {
  const outcome = select(f.log, f.bytes, {
    recommendationId: revision.recommendationId,
    revisionId: revision.id,
    state,
    actor: "developer",
    selectedAt: "2026-11-01T10:30:00.000Z",
  });
  if (!outcome.selected) throw new Error("the selection was refused");
}

function propose(f: Fixture) {
  return proposeArtifact(f.log, f.bytes);
}

function created(f: Fixture): RecordOf<"artifact_revision"> {
  const outcome = propose(f);
  if (outcome.kind !== "created") throw new Error(`expected a new artifact, got ${outcome.kind}`);
  return outcome.artifact;
}

const artifacts = (f: Fixture) => f.log.records.filter((r) => r.type === "artifact_revision");

function reviewOf(
  f: Fixture,
  artifact: RecordOf<"artifact_revision">,
  outcome: ReviewRequest["outcome"] = "approved",
): RecordOf<"review"> {
  return recordReview(f.log, {
    artifactRevisionId: artifact.id,
    contentHash: artifact.proposedHash,
    outcome,
    actor: "developer",
    reviewedAt: "2026-11-01T10:40:00.000Z",
  });
}

describe("artifact revisions (DM §9.4)", () => {
  it("records the assembled file with its snapshot, original, content, selections and attribution", () => {
    const f = fixture();
    const revise = recommend(f, "revise", { kind: "block", ...ref(f, "Guide/paragraph-1") }, "Hi.");
    const add = recommend(
      f,
      "add",
      { kind: "after", ...ref(f, "Guide/Testing/list-item-1") },
      "- Run the linter.",
    );
    choose(f, add);
    choose(f, revise);
    const outcome = propose(f);
    if (outcome.kind !== "created") throw new Error(outcome.kind);
    const { artifact, content } = outcome;
    const expected = [
      "# Guide",
      "",
      "Hi.",
      "",
      "## Testing",
      "",
      "- Run the tests.",
      "- Run the linter.",
      "",
    ].join("\n");
    expect(decode(content)).toBe(expected);
    expect(artifact).toMatchObject({
      type: "artifact_revision",
      revision: 1,
      snapshotId: f.log.records.find((r) => r.type === "snapshot")?.id,
      targetPath: "CLAUDE.md",
      original: sha256(f.bytes as Uint8Array),
      proposedContent: contentRefOf(content),
      proposedHash: sha256(content),
      // In the order of the recommendations' current revisions, not of acceptance.
      selectedRevisionIds: [revise.id, add.id],
      decisionIds: [],
    });
    expect(artifact.attribution).toEqual([
      {
        revisionId: revise.id,
        operation: "revise",
        originalBlockId: "Guide/paragraph-1",
        proposedSpan: { start: 9, end: 12 },
      },
      {
        revisionId: add.id,
        operation: "add",
        proposedSpan: { start: 43, end: 60 },
      },
    ]);
  });

  it("numbers the session's artifact revisions from 1", () => {
    const f = fixture();
    const a = recommend(f, "add", { kind: "newSection", heading: "One" });
    const b = recommend(f, "add", { kind: "newSection", heading: "Two" });
    choose(f, a);
    expect(created(f).revision).toBe(1);
    choose(f, b);
    expect(created(f).revision).toBe(2);
  });

  it("assembles a new file for an absent destination, with original absent", () => {
    const f = fixture({ state: "absent" });
    choose(f, recommend(f, "add", { kind: "newSection", heading: "Notes" }, "Some notes."));
    const outcome = propose(f);
    if (outcome.kind !== "created") throw new Error(outcome.kind);
    expect(outcome.artifact.original).toBe("absent");
    expect(decode(outcome.content)).toBe("## Notes\n\nSome notes.\n");
  });

  it("records the current decisions the selected revisions depend on, once each", () => {
    const f = fixture();
    const decision = f.log.append({
      type: "decision",
      statement: "Use pnpm.",
      scope: { kind: "repository" },
      exceptions: [],
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    const support = [
      { kind: "finding", findingId: f.findingId },
      { kind: "decision", decisionId: decision.id },
    ] as const;
    choose(f, recommend(f, "add", { kind: "newSection", heading: "A" }, "A.", [...support]));
    choose(f, recommend(f, "add", { kind: "newSection", heading: "B" }, "B.", [...support]));
    expect(created(f).decisionIds).toEqual([decision.id]);
  });

  it("creates nothing when no recommendation is accepted, so the session can end as no_change", () => {
    const f = fixture();
    expect(propose(f)).toEqual({ kind: "nothing_accepted" });
    choose(f, recommend(f, "add", { kind: "newSection", heading: "A" }), "rejected");
    choose(f, recommend(f, "add", { kind: "newSection", heading: "B" }), "pending");
    expect(propose(f)).toEqual({ kind: "nothing_accepted" });
    expect(artifacts(f)).toEqual([]);
  });

  it("is never given a clashing set: a clash is refused before assembly, and nothing is written", () => {
    const f = fixture();
    const first = recommend(f, "revise", { kind: "block", ...ref(f, "Guide/paragraph-1") }, "A.");
    choose(f, first);
    // A refresh re-anchors a second accepted revise onto the same block.
    const second = recommend(f, "revise", { kind: "block", ...ref(f, "Guide/paragraph-1") }, "B.");
    // Accepting is refused, so the clash comes from a hand-edited file.
    f.log.append({
      type: "selection",
      recommendationId: second.recommendationId,
      revisionId: second.id,
      state: "accepted",
      actor: "developer",
      selectedAt: "2026-11-01T10:31:00.000Z",
    });
    expect(propose(f)).toEqual({
      kind: "clash",
      clashes: [
        {
          recommendationIds: [first.recommendationId, second.recommendationId],
          reason: "same_block",
        },
      ],
    });
    expect(artifacts(f)).toEqual([]);
  });

  it("names a conflict between revisions that pass alone but not together, and writes nothing", () => {
    const f = fixture({ state: "present", text: "Paragraph.\n" });
    const after = { kind: "after" as const, ...ref(f, "paragraph-1") };
    const item = recommend(f, "add", after, "- item");
    const code = recommend(f, "add", after, "    code");
    choose(f, item);
    choose(f, code);
    expect(propose(f)).toEqual({
      kind: "assembly_failed",
      failure: { kind: "conflict", revisionId: code.id, conflictsWith: item.id },
    });
    expect(artifacts(f)).toEqual([]);
  });

  it("returns the active artifact revision instead of creating an identical one", () => {
    const f = fixture();
    choose(f, recommend(f, "add", { kind: "newSection", heading: "A" }));
    const artifact = created(f);
    expect(propose(f)).toEqual({ kind: "active", artifact });
    expect(artifacts(f)).toHaveLength(1);
  });

  it("assembles re-anchored targets in the active snapshot, and attributes its blocks", () => {
    const f = fixture();
    const revise = recommend(f, "revise", { kind: "block", ...ref(f, "Guide/paragraph-1") }, "Hi.");
    choose(f, revise);
    // The paragraph moves under a new heading: a new ID, the same hash.
    refresh(f, ["# Guide", "", "## Moved", "", "Intro.", ""].join("\n"));
    const artifact = created(f);
    expect(artifact.snapshotId).toBe(f.log.records.filter((r) => r.type === "snapshot")[1]?.id);
    expect(artifact.attribution[0]).toMatchObject({ originalBlockId: "Guide/Moved/paragraph-1" });
  });

  it("refuses bytes that aren't the active snapshot's destination", () => {
    const f = fixture();
    choose(f, recommend(f, "add", { kind: "newSection", heading: "A" }));
    expect(() => proposeArtifact(f.log, encode("# Other\n"))).toThrow();
    expect(() => proposeArtifact(f.log, undefined)).toThrow();
  });

  it("refuses an unavailable destination", () => {
    const f = fixture({ state: "unavailable" });
    choose(f, recommend(f, "add", { kind: "newSection", heading: "A" }));
    expect(() => propose(f)).toThrow(/unavailable/);
  });

  it("refuses a selected revision that depends on a decision that isn't current", () => {
    const f = fixture();
    const decision = f.log.append({
      type: "decision",
      statement: "Use pnpm.",
      scope: { kind: "repository" },
      exceptions: [],
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    choose(
      f,
      recommend(f, "add", { kind: "newSection", heading: "A" }, "A.", [
        { kind: "decision", decisionId: decision.id },
      ]),
    );
    f.log.append({ ...decision, supersedes: [decision.id] } as never);
    expect(() => propose(f)).toThrow(/regenerate/);
  });
});

describe("the active artifact revision (IMPL §4.4.2, DM §12)", () => {
  function accepted() {
    const f = fixture();
    const a = recommend(f, "add", { kind: "newSection", heading: "A" }, "A.");
    const b = recommend(f, "add", { kind: "newSection", heading: "B" }, "B.");
    choose(f, a);
    const artifact = created(f);
    return { f, a, b, artifact };
  }

  it("is the latest artifact revision while its snapshot, selections and decisions are current", () => {
    const { f, artifact } = accepted();
    expect(currentState(f.log.records).activeArtifact).toEqual(artifact);
  });

  it("is none once another recommendation is accepted, or the selected one rejected", () => {
    const more = accepted();
    choose(more.f, more.b);
    expect(currentState(more.f.log.records).activeArtifact).toBeUndefined();
    const fewer = accepted();
    choose(fewer.f, fewer.a, "rejected");
    expect(currentState(fewer.f.log.records).activeArtifact).toBeUndefined();
  });

  it("is active again when the selections return to the revisions it records", () => {
    const { f, a, artifact } = accepted();
    choose(f, a, "rejected");
    choose(f, a);
    expect(currentState(f.log.records).activeArtifact).toEqual(artifact);
  });

  it("is none after a refresh: its snapshot is no longer active", () => {
    const { f } = accepted();
    refresh(f, GUIDE);
    expect(currentState(f.log.records).activeArtifact).toBeUndefined();
  });

  it("is none when a selected revision is superseded by a new one", () => {
    const { f, a } = accepted();
    f.log.revise("recommendation_revision", a.recommendationId, {
      content: "A, edited.",
    });
    expect(currentState(f.log.records).activeArtifact).toBeUndefined();
  });

  it("is none when a decision it records is superseded", () => {
    const f = fixture();
    const decision = f.log.append({
      type: "decision",
      statement: "Use pnpm.",
      scope: { kind: "repository" },
      exceptions: [],
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    choose(
      f,
      recommend(f, "add", { kind: "newSection", heading: "A" }, "A.", [
        { kind: "decision", decisionId: decision.id },
      ]),
    );
    created(f);
    const { id: _id, seq: _seq, createdAt: _c, type: _t, ...fields } = decision;
    f.log.append({ type: "decision", ...fields, statement: "Use npm.", supersedes: [decision.id] });
    expect(currentState(f.log.records).activeArtifact).toBeUndefined();
  });

  it("is only ever the latest artifact revision", () => {
    const { f, a, b, artifact } = accepted();
    choose(f, b);
    created(f);
    // Back to the first artifact's selections, but a later artifact exists.
    choose(f, b, "rejected");
    expect(currentState(f.log.records).activeArtifact).toBeUndefined();
    expect(propose(f)).toMatchObject({ kind: "created" });
    expect(artifact.selectedRevisionIds).toEqual([a.id]);
  });
});

describe("reviews and the usable approval (DM §10, IMPL §4.4.2)", () => {
  function proposed() {
    const f = fixture();
    const a = recommend(f, "add", { kind: "newSection", heading: "A" }, "A.");
    choose(f, a);
    return { f, a, artifact: created(f) };
  }

  it("records the review with the exact content hash of the artifact revision", () => {
    const { f, artifact } = proposed();
    const review = recordReview(f.log, {
      artifactRevisionId: artifact.id,
      contentHash: artifact.proposedHash,
      outcome: "approved",
      actor: "developer",
      reviewedAt: "2026-11-01T10:40:00.000Z",
      comment: "Looks right.",
    });
    expect(review).toMatchObject({
      type: "review",
      artifactRevisionId: artifact.id,
      contentHash: artifact.proposedHash,
      outcome: "approved",
      actor: "developer",
      reviewedAt: "2026-11-01T10:40:00.000Z",
      comment: "Looks right.",
    });
  });

  it("refuses a review of a hash other than the one proposed", () => {
    const { f, artifact } = proposed();
    expect(() =>
      recordReview(f.log, {
        artifactRevisionId: artifact.id,
        contentHash: sha256(encode("other")),
        outcome: "approved",
        actor: "developer",
        reviewedAt: "2026-11-01T10:40:00.000Z",
      }),
    ).toThrow();
  });

  it("refuses a review of an artifact revision that isn't active", () => {
    const { f, a, artifact } = proposed();
    choose(f, a, "rejected");
    expect(() => reviewOf(f, artifact)).toThrow(/active/);
  });

  it("an approval of the active artifact revision with its hash is usable", () => {
    const { f, artifact } = proposed();
    const review = reviewOf(f, artifact);
    expect(currentState(f.log.records).usableApproval).toEqual(review);
  });

  it("a rejection is not an approval, and a later rejection withdraws an approval", () => {
    const { f, artifact } = proposed();
    reviewOf(f, artifact, "rejected");
    expect(currentState(f.log.records).usableApproval).toBeUndefined();
    const approval = reviewOf(f, artifact);
    expect(currentState(f.log.records).usableApproval).toEqual(approval);
    reviewOf(f, artifact, "rejected");
    expect(currentState(f.log.records).usableApproval).toBeUndefined();
  });

  it("changed selections, decisions or content make an earlier approval unusable (DM §17)", () => {
    const selection = proposed();
    reviewOf(selection.f, selection.artifact);
    choose(selection.f, selection.a, "rejected");
    expect(currentState(selection.f.log.records).usableApproval).toBeUndefined();

    const content = proposed();
    reviewOf(content.f, content.artifact);
    refresh(content.f, GUIDE);
    expect(currentState(content.f.log.records).usableApproval).toBeUndefined();

    const f = fixture();
    const decision = f.log.append({
      type: "decision",
      statement: "Use pnpm.",
      scope: { kind: "repository" },
      exceptions: [],
      origin: "answered_question",
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    });
    choose(
      f,
      recommend(f, "add", { kind: "newSection", heading: "A" }, "A.", [
        { kind: "decision", decisionId: decision.id },
      ]),
    );
    reviewOf(f, created(f));
    expect(currentState(f.log.records).usableApproval).toBeDefined();
    const { id: _id, seq: _seq, createdAt: _c, type: _t, ...fields } = decision;
    f.log.append({ type: "decision", ...fields, statement: "Use npm.", supersedes: [decision.id] });
    expect(currentState(f.log.records).usableApproval).toBeUndefined();
  });

  it("an artifact that repeats a selected revision isn't active when another is accepted", () => {
    const f = fixture();
    const a = recommend(f, "add", { kind: "newSection", heading: "A" }, "A.");
    const b = recommend(f, "add", { kind: "newSection", heading: "B" }, "B.");
    choose(f, a);
    const artifact = created(f);
    choose(f, b);
    // A hand-edited artifact naming `a` twice, so its count matches the two accepted.
    const { id: _id, seq: _seq, createdAt: _c, ...fields } = artifact;
    f.log.append({ ...fields, revision: 2, selectedRevisionIds: [a.id, a.id] });
    expect(currentState(f.log.records).activeArtifact).toBeUndefined();
  });

  it("an approval never transfers to a new artifact revision, even with identical bytes", () => {
    const { f, a, artifact } = proposed();
    reviewOf(f, artifact);
    // A new revision with the same wording, selected again, assembles to the same bytes.
    const edited = f.log.revise("recommendation_revision", a.recommendationId, {
      rationale: "Restated.",
    });
    choose(f, edited);
    const next = created(f);
    expect(next.proposedHash).toBe(artifact.proposedHash);
    expect(currentState(f.log.records).activeArtifact).toEqual(next);
    expect(currentState(f.log.records).usableApproval).toBeUndefined();
  });
});
