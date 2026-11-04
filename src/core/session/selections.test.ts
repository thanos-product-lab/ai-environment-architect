import { describe, expect, it } from "vitest";
import { callDraft, completedCall, newLog } from "../../../test/support/session.js";
import { type GuidanceBlock, parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { currentState } from "./current.js";
import { recordFailedRecommendationRevision } from "./failed.js";
import type { Revised, SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";
import { changedBlocks, exclusions, type SelectionRequest, select } from "./selections.js";

// Selections and mutual exclusion (DM §9.1 "No dependencies between recommendations", DM §9.2,
// IMPL §4.4.2 "Current selections", §2.7, §4.11, DM §17).

const encode = (text: string) => new TextEncoder().encode(text);

const GUIDE = [
  "# Guide",
  "",
  "Intro.",
  "",
  "## Testing",
  "",
  "- Run the tests.",
  "",
  "### Deep",
  "",
  "Deep text.",
  "",
  "## Other",
  "",
  "Other text.",
  "",
].join("\n");

interface Fixture {
  readonly log: SessionLog;
  readonly destination: { readonly bytes: Uint8Array; readonly blocks: readonly GuidanceBlock[] };
  readonly findingId: string;
  readonly callId: string;
}

/** Appends a snapshot of `text` as the destination: a capture, or a refresh. */
function appendSnapshot(log: SessionLog, text: string) {
  const bytes = encode(text);
  const parsed = parseGuidanceBlocks(bytes);
  const snapshot = log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: [{ path: "CLAUDE.md", status: "read", size: bytes.length, hash: sha256(bytes) }],
    destination: {
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
  return { snapshotId: snapshot.id, destination: { bytes, blocks: parsed.blocks } };
}

function fixture(text = GUIDE): Fixture {
  const log = newLog();
  const { snapshotId, destination } = appendSnapshot(log, text);
  const bytes = destination.bytes;
  const ev = log.append({
    type: "evidence",
    snapshotId,
    kind: "lines",
    path: "CLAUDE.md",
    fileHash: sha256(bytes),
    lineStart: 1,
    lineEnd: 1,
    excerpt: "# Guide",
    basis: "existing_guidance",
  });
  const finding = log.start({
    type: "finding",
    snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement: "The guide exists.",
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["existing_guidance"],
    evidenceIds: [ev.id],
  });
  const call = log.start(callDraft({ purpose: "recommend" }));
  log.revise("model_call", call.modelCallId, completedCall());
  return {
    log,
    destination,
    findingId: finding.findingId,
    callId: call.modelCallId,
  };
}

/** A refresh: a new active snapshot whose destination is `text`. */
function refresh(f: Fixture, text: string): Fixture {
  return { ...f, destination: appendSnapshot(f.log, text).destination };
}

function block(f: Fixture, id: string) {
  const found = f.destination.blocks.find((b) => b.blockId === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return { blockId: found.blockId, blockHash: found.hash };
}

type Operation = "add" | "revise" | "remove";

function recommend(
  f: Fixture,
  operation: Operation,
  target: Revised<"recommendation_revision">["target"],
): Revised<"recommendation_revision"> {
  return f.log.start({
    type: "recommendation_revision",
    kind: "fact",
    operation,
    target,
    ...(operation === "remove" ? {} : { content: "New text." }),
    rationale: "Helps.",
    support: [{ kind: "finding", findingId: f.findingId }],
    references: [],
    scope: { kind: "repository" },
    producedBy: f.callId,
    status: "valid",
  });
}

const on = (f: Fixture, operation: Operation, blockId: string) =>
  recommend(f, operation, { kind: "block", ...block(f, blockId) });

function request(
  revision: Revised<"recommendation_revision">,
  state: SelectionRequest["state"] = "accepted",
): SelectionRequest {
  return {
    recommendationId: revision.recommendationId,
    revisionId: revision.id,
    state,
    actor: "developer",
    selectedAt: "2026-11-01T10:30:00.000Z",
  };
}

function accept(f: Fixture, revision: Revised<"recommendation_revision">) {
  return select(f.log, f.destination.bytes, request(revision));
}

function selected(outcome: ReturnType<typeof select>): RecordOf<"selection"> {
  if (!outcome.selected) throw new Error(`refused: ${JSON.stringify(outcome)}`);
  return outcome.selection;
}

const selectionsOf = (f: Fixture) => currentState(f.log.records).selections;

describe("the selection record (DM §9.2)", () => {
  it("records the recommendation, the exact revision, the state, the actor and the time", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    const selection = selected(accept(f, r));
    expect(selection).toMatchObject({
      type: "selection",
      recommendationId: r.recommendationId,
      revisionId: r.id,
      state: "accepted",
      actor: "developer",
      selectedAt: "2026-11-01T10:30:00.000Z",
    });
    expect(selection.id).toMatch(/^sel_/);
  });

  it("appends a new selection per change and keeps the history", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    const first = selected(accept(f, r));
    const second = selected(select(f.log, f.destination.bytes, request(r, "rejected")));
    const third = selected(select(f.log, f.destination.bytes, request(r, "pending")));
    const all = f.log.records.filter((x) => x.type === "selection");
    expect(all.map((x) => x.id)).toEqual([first.id, second.id, third.id]);
    expect(all.map((x) => (x as RecordOf<"selection">).state)).toEqual([
      "accepted",
      "rejected",
      "pending",
    ]);
  });

  it("the current selection is the latest per recommendation", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    const b = recommend(f, "add", { kind: "newSection", heading: "Notes" });
    accept(f, a);
    accept(f, b);
    const latest = selected(select(f.log, f.destination.bytes, request(a, "rejected")));
    const current = selectionsOf(f);
    expect(current.get(a.recommendationId)?.id).toBe(latest.id);
    expect(current.get(b.recommendationId)?.state).toBe("accepted");
  });

  it("a pending selection can undo an accept, and a recommendation with none is pending", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    expect(selectionsOf(f).get(r.recommendationId)).toBeUndefined();
    accept(f, r);
    selected(select(f.log, f.destination.bytes, request(r, "pending")));
    expect(selectionsOf(f).get(r.recommendationId)?.state).toBe("pending");
  });
});

describe("selecting only the current revision (DM §9.2)", () => {
  it("refuses a revision that a later one superseded", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    f.log.revise("recommendation_revision", r.recommendationId, {
      content: "Edited.",
    });
    expect(() => accept(f, r)).toThrow(/current/);
  });

  it("refuses an invalidated recommendation, which has no current revision", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    const invalidated = f.log.revise("recommendation_revision", r.recommendationId, {
      status: "invalidated",
      invalidatedReason: "dropped_by_model",
      revisedBy: f.callId,
    });
    expect(() => accept(f, r)).toThrow(/current/);
    expect(() =>
      select(f.log, f.destination.bytes, { ...request(r), revisionId: invalidated.id }),
    ).toThrow(/current/);
  });

  it("refuses a revision that failed validation", () => {
    const f = fixture();
    const failed = recordFailedRecommendationRevision(f.log, {
      producedBy: f.callId,
      itemKey: "recommendations/r1",
      rule: "REC-001",
      proposed: {},
    });
    expect(() =>
      select(f.log, f.destination.bytes, {
        recommendationId: failed.recommendationId,
        revisionId: failed.id,
        state: "accepted",
        actor: "developer",
        selectedAt: "2026-11-01T10:30:00.000Z",
      }),
    ).toThrow(/current/);
  });

  it("refuses a revision of another recommendation", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    const b = recommend(f, "add", { kind: "newSection", heading: "Notes" });
    expect(() => select(f.log, f.destination.bytes, { ...request(a), revisionId: b.id })).toThrow(
      /current/,
    );
  });
});

describe("selections count only while their revision is current (IMPL §4.4.2, §4.11)", () => {
  for (const state of ["accepted", "rejected"] as const)
    it(`an ${state} selection stops counting when a new revision supersedes its revision`, () => {
      const f = fixture();
      const r = on(f, "revise", "Guide/paragraph-1");
      selected(select(f.log, f.destination.bytes, request(r, state)));
      const before = f.log.records.length;
      f.log.revise("recommendation_revision", r.recommendationId, {
        content: "Edited.",
      });
      expect(selectionsOf(f).get(r.recommendationId)).toBeUndefined();
      // Pending again, without any selection written for the developer.
      expect(f.log.records.slice(before).map((x) => x.type)).toEqual(["recommendation_revision"]);
    });

  it("an invalidated recommendation has no current selection", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    accept(f, r);
    f.log.revise("recommendation_revision", r.recommendationId, {
      status: "invalidated",
      invalidatedReason: "target_changed",
    });
    expect(selectionsOf(f).has(r.recommendationId)).toBe(false);
  });

  it("a failed edit leaves the earlier revision and its selection current", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    const selection = selected(accept(f, r));
    recordFailedRecommendationRevision(f.log, {
      recommendationId: r.recommendationId,
      producedBy: "developer_edit",
      itemKey: "$edit",
      rule: "REF-002",
      proposed: {},
    });
    expect(selectionsOf(f).get(r.recommendationId)?.id).toBe(selection.id);
  });

  it("the new revision can be selected again", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    accept(f, r);
    const edited = f.log.revise("recommendation_revision", r.recommendationId, {
      content: "Edited.",
    });
    const again = selected(accept(f, edited));
    expect(selectionsOf(f).get(r.recommendationId)?.id).toBe(again.id);
  });
});

describe("the blocks a revise or remove changes (DM §9.1 Headings)", () => {
  it("a revise or remove of a block changes that block, and an addition changes none", () => {
    const f = fixture();
    expect(changedBlocks(on(f, "revise", "Guide/paragraph-1"), f.destination)).toEqual([
      "Guide/paragraph-1",
    ]);
    expect(changedBlocks(on(f, "revise", "Guide/Testing/heading"), f.destination)).toEqual([
      "Guide/Testing/heading",
    ]);
    const add = recommend(f, "add", { kind: "after", ...block(f, "Guide/paragraph-1") });
    expect(changedBlocks(add, f.destination)).toEqual([]);
  });

  it("a remove of a heading changes its whole section, subsections included", () => {
    const f = fixture();
    expect(changedBlocks(on(f, "remove", "Guide/Testing/heading"), f.destination)).toEqual([
      "Guide/Testing/heading",
      "Guide/Testing/list-item-1",
      "Guide/Testing/Deep/heading",
      "Guide/Testing/Deep/paragraph-1",
    ]);
  });

  it("a section ends at the next heading of the same or a higher level, setext included", () => {
    const f = fixture("Top\n===\n\nA.\n\n### Low\n\nB.\n\nNext\n----\n\nC.\n\n# Last\n");
    expect(changedBlocks(on(f, "remove", "Top/heading"), f.destination)).toEqual([
      "Top/heading",
      "Top/paragraph-1",
      "Top/Low/heading",
      "Top/Low/paragraph-1",
      "Top/Next/heading",
      "Top/Next/paragraph-1",
    ]);
    expect(changedBlocks(on(f, "remove", "Top/Next/heading"), f.destination)).toEqual([
      "Top/Next/heading",
      "Top/Next/paragraph-1",
    ]);
  });

  it("follows a target re-anchored in the active snapshot", () => {
    const f = fixture();
    const r = on(f, "remove", "Guide/Other/heading");
    const moved = parseGuidanceBlocks(encode(`Preface.\n\n${GUIDE}`));
    const destination = { bytes: encode(`Preface.\n\n${GUIDE}`), blocks: moved.blocks };
    expect(changedBlocks(r, destination)).toEqual([
      "Guide/Other/heading",
      "Guide/Other/paragraph-1",
    ]);
  });

  it("a target that resolves to no block is a bug in the caller", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    const other = encode("# Elsewhere\n");
    expect(() =>
      changedBlocks(r, { bytes: other, blocks: parseGuidanceBlocks(other).blocks }),
    ).toThrow(/target_changed/);
  });
});

describe("mutual exclusion (DM §9.1, §17; IMPL §2.7)", () => {
  it("DM §17: two revisions of one block can't both be accepted", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    const b = on(f, "revise", "Guide/paragraph-1");
    selected(accept(f, a));
    const before = f.log.records.length;
    expect(accept(f, b)).toEqual({
      selected: false,
      exclusions: [{ recommendationId: a.recommendationId, reason: "same_block" }],
    });
    // Nothing is written, and the other recommendation is left as it was.
    expect(f.log.records.length).toBe(before);
    expect(selectionsOf(f).get(a.recommendationId)?.state).toBe("accepted");
    expect(selectionsOf(f).has(b.recommendationId)).toBe(false);
  });

  it("a revise and a remove of one block, and two removes, are exclusive", () => {
    for (const [first, second] of [
      ["revise", "remove"],
      ["remove", "revise"],
      ["remove", "remove"],
    ] as const) {
      const f = fixture();
      const a = on(f, first, "Guide/Testing/list-item-1");
      const b = on(f, second, "Guide/Testing/list-item-1");
      selected(accept(f, a));
      expect(accept(f, b), `${first} then ${second}`).toMatchObject({ selected: false });
    }
  });

  it("DM §17: a section removal and a change to a block in it can't both be accepted, either way", () => {
    for (const inside of [
      "Guide/Testing/list-item-1",
      "Guide/Testing/Deep/heading",
      "Guide/Testing/Deep/paragraph-1",
    ])
      for (const operation of ["revise", "remove"] as const) {
        const f = fixture();
        const section = on(f, "remove", "Guide/Testing/heading");
        const change = on(f, operation, inside);
        selected(accept(f, section));
        expect(accept(f, change), `${operation} ${inside}`).toEqual({
          selected: false,
          exclusions: [
            {
              recommendationId: section.recommendationId,
              reason: "section",
              sectionRemovedBy: section.recommendationId,
            },
          ],
        });

        const g = fixture();
        const section2 = on(g, "remove", "Guide/Testing/heading");
        const change2 = on(g, operation, inside);
        selected(accept(g, change2));
        expect(accept(g, section2), `section after ${operation} ${inside}`).toEqual({
          selected: false,
          exclusions: [
            {
              recommendationId: change2.recommendationId,
              reason: "section",
              sectionRemovedBy: section2.recommendationId,
            },
          ],
        });
      }
  });

  it("a revise of a heading against its section's removal has the section reason, either way", () => {
    const f = fixture();
    const section = on(f, "remove", "Guide/Testing/heading");
    const heading = on(f, "revise", "Guide/Testing/heading");
    selected(accept(f, heading));
    expect(accept(f, section)).toEqual({
      selected: false,
      exclusions: [
        {
          recommendationId: heading.recommendationId,
          reason: "section",
          sectionRemovedBy: section.recommendationId,
        },
      ],
    });
    const g = fixture();
    const section2 = on(g, "remove", "Guide/Testing/heading");
    const heading2 = on(g, "revise", "Guide/Testing/heading");
    selected(accept(g, section2));
    expect(accept(g, heading2)).toEqual({
      selected: false,
      exclusions: [
        {
          recommendationId: section2.recommendationId,
          reason: "section",
          sectionRemovedBy: section2.recommendationId,
        },
      ],
    });
  });

  it("two removals of one section are the same block", () => {
    const f = fixture();
    const a = on(f, "remove", "Guide/Testing/heading");
    const b = on(f, "remove", "Guide/Testing/heading");
    selected(accept(f, a));
    expect(accept(f, b)).toEqual({
      selected: false,
      exclusions: [{ recommendationId: a.recommendationId, reason: "same_block" }],
    });
  });

  it("a nested section removal is inside the outer one", () => {
    const f = fixture();
    const outer = on(f, "remove", "Guide/heading");
    const inner = on(f, "remove", "Guide/Testing/heading");
    selected(accept(f, inner));
    expect(accept(f, outer)).toEqual({
      selected: false,
      exclusions: [
        {
          recommendationId: inner.recommendationId,
          reason: "section",
          sectionRemovedBy: outer.recommendationId,
        },
      ],
    });
  });

  it("blocks outside the section, and sibling sections, aren't affected", () => {
    const f = fixture();
    const section = on(f, "remove", "Guide/Testing/heading");
    selected(accept(f, section));
    selected(accept(f, on(f, "revise", "Guide/paragraph-1")));
    selected(accept(f, on(f, "remove", "Guide/Other/heading")));
  });

  it("additions are never exclusive, even inside a removed section or after a revised block", () => {
    const f = fixture();
    const section = on(f, "remove", "Guide/Testing/heading");
    const revised = on(f, "revise", "Guide/paragraph-1");
    selected(accept(f, section));
    selected(accept(f, revised));
    for (const target of [
      { kind: "after" as const, ...block(f, "Guide/Testing/list-item-1") },
      { kind: "section" as const, ...block(f, "Guide/Testing/Deep/heading") },
      { kind: "after" as const, ...block(f, "Guide/paragraph-1") },
      { kind: "newSection" as const, heading: "Notes", after: block(f, "Guide/Testing/heading") },
      { kind: "newSection" as const, heading: "Notes" },
    ])
      selected(accept(f, recommend(f, "add", target)));
    expect(changedBlocks(section, f.destination)).toHaveLength(4);
  });

  it("rejecting or leaving pending is never refused", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    const b = on(f, "revise", "Guide/paragraph-1");
    selected(accept(f, a));
    selected(select(f.log, f.destination.bytes, request(b, "rejected")));
    selected(select(f.log, f.destination.bytes, request(b, "pending")));
  });

  it("only selections that count exclude: a rejected one, or one whose revision is superseded, doesn't", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    const b = on(f, "revise", "Guide/paragraph-1");
    selected(accept(f, a));
    selected(select(f.log, f.destination.bytes, request(a, "rejected")));
    selected(accept(f, b));

    const g = fixture();
    const c = on(g, "revise", "Guide/paragraph-1");
    const d = on(g, "revise", "Guide/paragraph-1");
    selected(accept(g, c));
    g.log.revise("recommendation_revision", c.recommendationId, {
      content: "Edited.",
    });
    selected(accept(g, d));
  });

  it("names every accepted recommendation it excludes, in recommendation order", () => {
    const f = fixture();
    const inside = on(f, "revise", "Guide/Testing/list-item-1");
    const deep = on(f, "remove", "Guide/Testing/Deep/heading");
    const section = on(f, "remove", "Guide/Testing/heading");
    selected(accept(f, inside));
    selected(accept(f, deep));
    expect(accept(f, section)).toEqual({
      selected: false,
      exclusions: [
        {
          recommendationId: inside.recommendationId,
          reason: "section",
          sectionRemovedBy: section.recommendationId,
        },
        {
          recommendationId: deep.recommendationId,
          reason: "section",
          sectionRemovedBy: section.recommendationId,
        },
      ],
    });
  });

  it("re-accepting an accepted recommendation isn't excluded by itself", () => {
    const f = fixture();
    const r = on(f, "remove", "Guide/Testing/heading");
    selected(accept(f, r));
    selected(accept(f, r));
  });

  it("compares targets re-anchored in the active snapshot", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    selected(accept(f, a));
    // After a refresh, the same paragraph has a new ID; b targets it there.
    const r = refresh(f, `# Guide\n\nNew first.\n\n${GUIDE.slice("# Guide\n\n".length)}`);
    const b = recommend(r, "revise", { kind: "block", ...block(r, "Guide/paragraph-2") });
    expect(select(r.log, r.destination.bytes, request(b))).toMatchObject({
      selected: false,
      exclusions: [{ recommendationId: a.recommendationId, reason: "same_block" }],
    });
  });
});

describe("the destination bytes (DM §9.2)", () => {
  it("refuses bytes that aren't the active snapshot's destination", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    const stale = f.destination.bytes;
    const g = refresh(f, `Preface.\n\n${GUIDE}`);
    expect(() => select(g.log, stale, request(r))).toThrow(/active snapshot/);
    expect(() => select(g.log, undefined, request(r))).toThrow(/active snapshot/);
    expect(() => exclusions(g.log.records, stale, r.recommendationId)).toThrow(/active snapshot/);
    expect(() => currentState(g.log.records, { destination: stale })).toThrow(/active snapshot/);
    expect(select(g.log, g.destination.bytes, request(r))).toMatchObject({ selected: true });
  });

  it("an absent destination takes no bytes, and its additions select as usual", () => {
    const log = newLog();
    log.append({
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
    expect(() => currentState(log.records, { destination: encode("x") })).toThrow(/absent/);
    expect(currentState(log.records, { destination: undefined }).clashes).toEqual([]);
  });
});

describe("clashes among accepted selections (DM §9.2, IMPL §4.4.2)", () => {
  it("are derived only when the destination is given", () => {
    const f = fixture();
    expect(currentState(f.log.records).clashes).toBeUndefined();
    expect(currentState(f.log.records, { destination: f.destination.bytes }).clashes).toEqual([]);
  });

  it("a refresh that re-anchors a revised block into a removed section makes a clash", () => {
    const f = fixture("# Guide\n\nMoved text.\n\n## Testing\n\n- Run the tests.\n");
    const revised = on(f, "revise", "Guide/paragraph-1");
    const section = on(f, "remove", "Guide/Testing/heading");
    selected(accept(f, revised));
    selected(accept(f, section));
    expect(currentState(f.log.records, { destination: f.destination.bytes }).clashes).toEqual([]);

    // The paragraph moved under Testing; both targets re-anchor, and nothing is written.
    const r = refresh(f, "# Guide\n\n## Testing\n\n- Run the tests.\n\nMoved text.\n");
    const before = r.log.records.length;
    expect(currentState(r.log.records, { destination: r.destination.bytes }).clashes).toEqual([
      {
        recommendationIds: [revised.recommendationId, section.recommendationId],
        reason: "section",
        sectionRemovedBy: section.recommendationId,
      },
    ]);
    expect(r.log.records.length).toBe(before);
    expect(currentState(r.log.records).selections.get(revised.recommendationId)?.state).toBe(
      "accepted",
    );
  });

  it("a hand-edited pair of accepts on one block is a clash; rejecting one clears it", () => {
    const f = fixture();
    const a = on(f, "revise", "Guide/paragraph-1");
    const b = on(f, "revise", "Guide/paragraph-1");
    on(f, "revise", "Guide/Other/paragraph-1");
    // Written past select, as a hand-edited file would hold them.
    for (const r of [a, b]) f.log.append({ type: "selection", ...request(r) });
    expect(currentState(f.log.records, { destination: f.destination.bytes }).clashes).toEqual([
      { recommendationIds: [a.recommendationId, b.recommendationId], reason: "same_block" },
    ]);
    selected(select(f.log, f.destination.bytes, request(b, "rejected")));
    expect(currentState(f.log.records, { destination: f.destination.bytes }).clashes).toEqual([]);
  });

  it("uses the same reasons as select, and lists every pair in recommendation order", () => {
    const f = fixture();
    const inside = on(f, "revise", "Guide/Testing/list-item-1");
    const section = on(f, "remove", "Guide/Testing/heading");
    const heading = on(f, "revise", "Guide/Testing/heading");
    for (const r of [inside, section, heading]) f.log.append({ type: "selection", ...request(r) });
    const reason = { reason: "section", sectionRemovedBy: section.recommendationId };
    expect(currentState(f.log.records, { destination: f.destination.bytes }).clashes).toEqual([
      { recommendationIds: [inside.recommendationId, section.recommendationId], ...reason },
      { recommendationIds: [section.recommendationId, heading.recommendationId], ...reason },
    ]);
  });
});

describe("exclusions as candidates (IMPL §2.7)", () => {
  it("lists every other current recommendation a recommendation excludes, selected or not", () => {
    const f = fixture();
    const section = on(f, "remove", "Guide/Testing/heading");
    const same = on(f, "remove", "Guide/Testing/heading");
    const inside = on(f, "revise", "Guide/Testing/list-item-1");
    on(f, "revise", "Guide/paragraph-1");
    recommend(f, "add", { kind: "after", ...block(f, "Guide/Testing/list-item-1") });
    const invalid = on(f, "revise", "Guide/Testing/list-item-1");
    f.log.revise("recommendation_revision", invalid.recommendationId, {
      status: "invalidated",
      invalidatedReason: "dropped_by_model",
      revisedBy: f.callId,
    });
    expect(exclusions(f.log.records, f.destination.bytes, section.recommendationId)).toEqual([
      { recommendationId: same.recommendationId, reason: "same_block" },
      {
        recommendationId: inside.recommendationId,
        reason: "section",
        sectionRemovedBy: section.recommendationId,
      },
    ]);
  });

  it("is the same under either recommendation order", () => {
    const forward = fixture();
    const a1 = on(forward, "remove", "Guide/Testing/heading");
    const b1 = on(forward, "revise", "Guide/Testing/Deep/paragraph-1");
    const reverse = fixture();
    const b2 = on(reverse, "revise", "Guide/Testing/Deep/paragraph-1");
    const a2 = on(reverse, "remove", "Guide/Testing/heading");
    expect(exclusions(forward.log.records, forward.destination.bytes, b1.recommendationId)).toEqual(
      [
        {
          recommendationId: a1.recommendationId,
          reason: "section",
          sectionRemovedBy: a1.recommendationId,
        },
      ],
    );
    expect(exclusions(reverse.log.records, reverse.destination.bytes, b2.recommendationId)).toEqual(
      [
        {
          recommendationId: a2.recommendationId,
          reason: "section",
          sectionRemovedBy: a2.recommendationId,
        },
      ],
    );
  });
});

describe("the selection schema", () => {
  it("a selection naming a lineage of the wrong prefix is refused by the schema", () => {
    const f = fixture();
    const r = on(f, "revise", "Guide/paragraph-1");
    expect(() =>
      f.log.append({
        type: "selection",
        recommendationId: "fnd_0001",
        revisionId: r.id,
        state: "accepted",
        actor: "developer",
        selectedAt: "2026-11-01T10:30:00.000Z",
      }),
    ).toThrow(/invalid selection/);
  });
});
