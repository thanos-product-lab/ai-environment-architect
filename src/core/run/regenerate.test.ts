import { describe, expect, it } from "vitest";
import { type Answer, response } from "../../../test/support/run-harness.js";
import { throughRecommend } from "../../../test/support/run-scripts.js";
import type { Revised } from "../session/log.js";
import type { RecordOf } from "../session/records.js";
import { runRegeneration } from "./regenerate.js";

// Running `regenerate_recommendations` through the core API with recorded responses
// (IMPL §3.3.6, §1.7, §3.2.6).

/** The developer corrects their answer: a new decision that supersedes it (DM §8.2). */
async function correct(t: Awaited<ReturnType<typeof throughRecommend>>) {
  return t.h.session.change(
    (log) =>
      log.append({
        type: "decision",
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
        questionId: t.questionId,
        origin: "answered_question",
        actor: "developer",
        decidedAt: "2026-11-01T10:40:00.000Z",
        supersedes: [t.decisionId],
      }) as RecordOf<"decision">,
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
