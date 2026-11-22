import { describe, expect, it } from "vitest";
import { fixedClock, MemoryFs } from "../../../test/support/memory-fs.js";
import { type Answer, harness, response } from "../../../test/support/run-harness.js";
import {
  callOne,
  findingAlias,
  NODES,
  throughRecommend,
} from "../../../test/support/run-scripts.js";
import { answerQuestion, correctDecision } from "../session/answers.js";
import type { Revised } from "../session/log.js";
import type { RecordOf } from "../session/records.js";
import { recordSnapshot } from "../session/snapshot.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { recordInspection, runAnalyse } from "./analysis.js";
import { runGenerateQuestions, runRecommend } from "./clarify.js";
import { runRegeneration } from "./regenerate.js";

// Running `regenerate_recommendations` through the core API with recorded responses
// (IMPL §3.3.6, §1.7, §3.2.6).

/** The developer corrects their answer: a new decision that supersedes it (DM §8.2). */
async function correct(t: Awaited<ReturnType<typeof throughRecommend>>) {
  return t.h.session.change((log) =>
    correctDecision(log, {
      supersedes: t.decisionId,
      statement: "The tests run in CI only.",
      scope: { kind: "repository" },
      exceptions: [],
      actor: "developer",
      decidedAt: "2026-11-01T10:40:00.000Z",
    }),
  );
}

const action =
  (body: Record<string, unknown>): Answer =>
  (request) =>
    response(request, JSON.stringify({ actions: [body], additions: [], heldBack: [] }));

const revisions = (t: Awaited<ReturnType<typeof throughRecommend>>) =>
  t.h.session.records.filter(
    (r): r is Revised<"recommendation_revision"> =>
      r.type === "recommendation_revision" && r.status !== "failed_validation",
  );

const lastCall = (t: Awaited<ReturnType<typeof throughRecommend>>) =>
  t.h.session.records.filter((r): r is RecordOf<"model_call"> => r.type === "model_call").at(-1);

describe("call 5 (IMPL §3.3.6)", () => {
  it("sends the affected recommendation and the change summary, and records a revise", async () => {
    const t = await throughRecommend([
      action({
        target: "R-1",
        action: "revise",
        reason: "The decision changed.",
        revision: {
          kind: "policy",
          operation: "add",
          target: { kind: "newSection", heading: "Testing" },
          rationale: "The developer decided the tests run in CI only.",
          support: ["D-1"],
          references: [],
          scope: { kind: "repository" },
          content: "Run the tests in CI.",
        },
      }),
    ]);
    const decision = await correct(t);
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, {
      kind: "decision",
      decisionId: decision.id,
    });
    expect(outcome).toMatchObject({ kind: "ran", calls: [{ kind: "completed" }] });
    const user = t.h.sent.at(-1)?.user ?? "";
    expect(user).toContain(
      '<<<RECOMMENDATIONS>>>\nR-1  [add · policy]  target: new section "Testing"',
    );
    expect(user).toContain(
      "<<<CHANGES>>>\n- D-1 replaces an earlier decision, which is no longer sent.\n<<<END CHANGES>>>",
    );
    expect(user).toContain(
      "<<<LIMITS>>>\nactions: 30\nadditions: 5\nheldBack: 10\n<<<END LIMITS>>>",
    );
    const call = lastCall(t);
    expect(call?.purpose).toBe("regenerate_recommendations");
    const latest = revisions(t).at(-1);
    expect(latest).toMatchObject({
      status: "valid",
      content: "Run the tests in CI.",
      producedBy: call?.modelCallId,
    });
  });

  it("fails a keep whose support has no alias in the call with REC-001, as revalidation_failed", async () => {
    const t = await throughRecommend([
      action({ target: "R-1", action: "keep", reason: "Still right." }),
    ]);
    const decision = await correct(t);
    await runRegeneration(t.h.session, t.h.deps, t.run, {
      kind: "decision",
      decisionId: decision.id,
    });
    const latest = revisions(t).at(-1);
    expect(latest).toMatchObject({
      status: "invalidated",
      invalidatedReason: "revalidation_failed",
    });
    const call = lastCall(t);
    if (call?.state !== "completed") throw new Error("call 5 didn't complete");
    expect(call.validationEvents).toContainEqual(
      expect.objectContaining({ itemKey: "R-1", rule: "REC-001" }),
    );
  });

  it("invalidates an affected recommendation whose text matches the scan, and sends nothing", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const t = await throughRecommend([], `Run the tests with the key ${key}.`);
    const before = t.h.sent.length;
    const decision = await correct(t);
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, {
      kind: "decision",
      decisionId: decision.id,
    });
    expect(outcome.kind).toBe("no_call");
    expect(t.h.sent).toHaveLength(before);
    expect(revisions(t).at(-1)).toMatchObject({
      status: "invalidated",
      invalidatedReason: "secret_match",
      secretRuleId: "aws-access-key-id",
    });
  });

  it("makes no call when nothing is affected", async () => {
    const t = await throughRecommend([]);
    const before = t.h.sent.length;
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, { kind: "refresh" });
    expect(outcome.kind).toBe("no_call");
    expect(t.h.sent).toHaveLength(before);
  });

  it("scans the records before fixing the affected set, so a withheld finding's dependants are sent", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const t = await throughRecommend([
      action({ target: "R-1", action: "keep", reason: "Still right." }),
    ]);
    // A finding whose statement matches the scan, and a recommendation that cites it. Real calls
    // never produce this, since each call scans before numbering; a new scan rule could.
    await t.h.session.change((log) => {
      const snapshotId = log.records.find((r) => r.type === "snapshot")?.id as string;
      const evidence = log.records.find((r) => r.type === "evidence" && r.kind === "lines");
      const finding = log.start({
        type: "finding",
        snapshotId,
        producedBy: "call_0001",
        status: "active",
        kind: "claim",
        statement: `The key ${key} is used.`,
        mode: "descriptive",
        scope: { kind: "repository" },
        basis: ["existing_guidance"],
        evidenceIds: [evidence?.id as string],
      } as never) as { findingId: string };
      const existing = revisions(t)[0] as Revised<"recommendation_revision">;
      log.start({
        type: "recommendation_revision",
        kind: "fact",
        operation: "add",
        target: existing.target,
        content: "The tests run before pushing.",
        rationale: "Seen in the rules.",
        support: [{ kind: "finding", findingId: finding.findingId }],
        references: [],
        scope: { kind: "repository" },
        producedBy: existing.producedBy,
        status: "valid",
      } as never);
    });
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, { kind: "refresh" });
    expect(outcome).toMatchObject({ kind: "ran", calls: [{ kind: "completed" }] });
    const user = t.h.sent.at(-1)?.user ?? "";
    expect(user).toContain("R-1  [add · fact]");
    expect(user).not.toContain(key);
    expect(user).toContain(
      "- 1 finding that the recommendations below cite is no longer current.\n",
    );
  });
});

/** Drops every affected recommendation the request names. */
const dropAll: Answer = (request) => {
  const aliases = [...request.user.matchAll(/^(R-\d+) {2}\[/gm)].map((m) => m[1] as string);
  return response(
    request,
    JSON.stringify({
      actions: aliases.map((target) => ({ target, action: "drop", reason: "No longer right." })),
      additions: [],
      heldBack: [],
    }),
  );
};

function rAliases(call: RecordOf<"model_call"> | undefined): string[] {
  return (call?.aliases.entries ?? []).filter((e) => e.kind === "R").map((e) => e.alias);
}

describe("call 5 paths (IMPL §3.3.6, §3.2.6)", () => {
  it("splits an affected set over 30 into calls of 30 and the rest, each naming only its part", async () => {
    const t = await throughRecommend([dropAll, dropAll]);
    const [first] = revisions(t);
    if (first === undefined) throw new Error("no recommendation");
    await t.h.session.change((log) => {
      for (let i = 1; i <= 30; i++)
        log.start({
          type: "recommendation_revision",
          kind: "policy",
          operation: "add",
          target: { kind: "newSection", heading: `Section ${i}` },
          content: `Policy ${i} applies.`,
          rationale: "The developer decided.",
          support: first.support,
          references: [],
          scope: { kind: "repository" },
          producedBy: first.producedBy,
          status: "valid",
        } as never);
    });
    const decision = await correct(t);
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, {
      kind: "decision",
      decisionId: decision.id,
    });
    expect(outcome).toMatchObject({
      kind: "ran",
      calls: [{ kind: "completed" }, { kind: "completed" }],
    });
    const regenerations = t.h.session.records.filter(
      (r): r is RecordOf<"model_call"> =>
        r.type === "model_call" &&
        r.purpose === "regenerate_recommendations" &&
        r.state === "completed",
    );
    expect(regenerations.map((c) => rAliases(c).length)).toEqual([30, 1]);
    const dropped = revisions(t).filter((r) => r.invalidatedReason === "dropped_by_model");
    expect(dropped).toHaveLength(31);
  });

  it("still sends the next part after the complete-request scan empties one (IMPL §1.7)", async () => {
    // As JSON, the line break becomes `\n` and joins the password to the host, so each of the
    // first part's rationales matches only in the complete request.
    const hidden = ["Use postgres://admin:", "hunter\nx@db.internal for the tests."].join("");
    const t = await throughRecommend([dropAll], undefined, {}, hidden);
    const [first] = revisions(t);
    if (first === undefined) throw new Error("no recommendation");
    await t.h.session.change((log) => {
      for (let i = 1; i <= 30; i++)
        log.start({
          type: "recommendation_revision",
          kind: "policy",
          operation: "add",
          target: { kind: "newSection", heading: `Section ${i}` },
          content: `Policy ${i} applies.`,
          rationale: i < 30 ? hidden : "The developer decided.",
          support: first.support,
          references: [],
          scope: { kind: "repository" },
          producedBy: first.producedBy,
          status: "valid",
        } as never);
    });
    const before = t.h.sent.length;
    const decision = await correct(t);
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, {
      kind: "decision",
      decisionId: decision.id,
    });
    expect(outcome).toMatchObject({
      kind: "ran",
      calls: [{ kind: "emptied" }, { kind: "completed" }],
    });
    // Only the second part was sent, naming its one recommendation.
    expect(t.h.sent).toHaveLength(before + 1);
    expect(rAliases(lastCall(t))).toEqual(["R-1"]);
    const invalidated = revisions(t).filter((r) => r.invalidatedReason === "secret_match");
    expect(invalidated).toHaveLength(30);
    expect(invalidated.every((r) => r.secretRuleId === "connection-string")).toBe(true);
    expect(revisions(t).filter((r) => r.invalidatedReason === "dropped_by_model")).toHaveLength(1);
  });

  it("writes the change summary's lines after a refresh: a stale finding and a changed target", async () => {
    const t = await throughRecommend([dropAll]);
    const [first] = revisions(t);
    if (first === undefined) throw new Error("no recommendation");
    const snapshot = t.h.session.records.find(
      (r): r is RecordOf<"snapshot"> => r.type === "snapshot",
    ) as RecordOf<"snapshot">;
    if (snapshot.destination.state !== "present") throw new Error("no destination");
    const listItem = snapshot.destination.blocks.at(-1) as { blockId: string; hash: string };
    const finding = t.h.session.records.find(
      (r) => r.type === "finding" && "statement" in r && r.statement.startsWith("The rules ask"),
    ) as { findingId: string };
    await t.h.session.change((log) => {
      // Anchored after the list item, which the refresh changes.
      log.start({
        type: "recommendation_revision",
        kind: "policy",
        operation: "add",
        target: { kind: "after", blockId: listItem.blockId, blockHash: listItem.hash },
        content: "Run the linter too.",
        rationale: "The developer decided.",
        support: first.support,
        references: [],
        scope: { kind: "repository" },
        producedBy: first.producedBy,
        status: "valid",
      } as never);
      // Supported by a finding of the first snapshot, which the refresh leaves stale.
      log.start({
        type: "recommendation_revision",
        kind: "fact",
        operation: "add",
        target: { kind: "newSection", heading: "Pushing" },
        content: "The tests run before pushing.",
        rationale: "Seen in the rules.",
        support: [{ kind: "finding", findingId: finding.findingId }],
        references: [],
        scope: { kind: "repository" },
        producedBy: first.producedBy,
        status: "valid",
      } as never);
    });
    // The refresh: a new snapshot whose list item says something else.
    const changed = "# Rules\n\n- Run the tests before every push.\n";
    const fs = new MemoryFs({ ...NODES, "CLAUDE.md": changed });
    const again = await captureSnapshot(
      { fs, clock: fixedClock, ids: { next: (prefix: string) => `${prefix}_refresh` } },
      DEFAULT_SNAPSHOT_SETTINGS,
    );
    await t.h.session.change((log, files) => {
      const { content } = recordSnapshot(log, again);
      if (content !== undefined) files.contents.push(content.bytes);
    });
    const destination = new TextEncoder().encode(changed);
    await runRegeneration(t.h.session, t.h.deps, { ...t.run, destination }, { kind: "refresh" });
    const user = t.h.sent.at(-1)?.user ?? "";
    expect(user.slice(user.indexOf("<<<CHANGES>>>"))).toBe(
      [
        "<<<CHANGES>>>",
        "- 1 finding that the recommendations below cite is no longer current.",
        "- 1 recommendation was withdrawn because its target changed.",
        "<<<END CHANGES>>>",
        "",
      ].join("\n"),
    );
    expect(revisions(t).filter((r) => r.invalidatedReason === "target_changed")).toHaveLength(1);
  });

  it("sends a call with no recommendations when a new decision only unblocks a held-back topic", async () => {
    const questionsTwo: Answer = (request) =>
      response(
        request,
        JSON.stringify({
          questions: [
            {
              key: "q1",
              prompt: "Do the tests also run in CI?",
              reason: "The rules don't say.",
              resolves: [findingAlias(request)],
              scope: { kind: "repository" },
              options: [],
            },
            {
              key: "q2",
              prompt: "Is CLAUDE.md the only agent configuration?",
              reason: "Others may exist.",
              resolves: ["F-1"],
              scope: { kind: "repository" },
              options: [],
            },
          ],
        }),
      );
    const recommendWithHeldBack: Answer = (request) =>
      response(
        request,
        JSON.stringify({
          recommendations: [],
          heldBack: [{ topic: "Where agent configuration lives", blockedBy: ["Q-2"] }],
          noChangeReason: "The one topic waits on a skipped question.",
        }),
      );
    const answers: Answer[] = [];
    const h = await harness(NODES, answers);
    answers.push(callOne(h), questionsTwo, recommendWithHeldBack, (request) =>
      response(request, JSON.stringify({ actions: [], additions: [], heldBack: [] })),
    );
    const inspection = await recordInspection(h.session, h.context);
    const one = await runAnalyse(h.session, h.deps, {
      context: h.context,
      inspection,
      destination: h.destination,
    });
    if (one.kind !== "completed") throw new Error(one.kind);
    const run = { sent: one.sent, inspection, destination: h.destination };
    await runGenerateQuestions(h.session, h.deps, run);
    const [q1, q2] = h.session.records.filter(
      (r): r is Revised<"question"> => r.type === "question" && "prompt" in r,
    );
    if (q1 === undefined || q2 === undefined) throw new Error("two questions expected");
    await h.session.change((log) => {
      answerQuestion(log, {
        questionId: q1.questionId,
        statement: "The tests run in CI too.",
        scope: { kind: "repository" },
        exceptions: [],
        actor: "developer",
        decidedAt: "2026-11-01T10:20:00.000Z",
      });
      log.revise("question", q2.questionId, { status: "skipped" } as never);
    });
    await runRecommend(h.session, h.deps, run);
    expect(h.session.records.filter((r) => r.type === "held_back")).toHaveLength(1);
    const { decision } = await h.session.change((log) =>
      answerQuestion(log, {
        questionId: q2.questionId,
        statement: "Only CLAUDE.md.",
        scope: { kind: "repository" },
        exceptions: [],
        actor: "developer",
        decidedAt: "2026-11-01T10:30:00.000Z",
      }),
    );
    const outcome = await runRegeneration(h.session, h.deps, run, {
      kind: "decision",
      decisionId: decision.id,
    });
    expect(outcome).toMatchObject({ kind: "ran", calls: [{ kind: "completed" }] });
    const user = h.sent.at(-1)?.user ?? "";
    expect(user).toContain("<<<RECOMMENDATIONS>>>\n<<<END RECOMMENDATIONS>>>\n");
    expect(user).toContain("- D-2 is new.");
  });
});
