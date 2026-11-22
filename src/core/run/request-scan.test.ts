import { describe, expect, it } from "vitest";
import { testPromptSet } from "../../../test/support/prompts.js";
import { type Answer, type Harness, harness, response } from "../../../test/support/run-harness.js";
import {
  callOne,
  EMPTY_ANALYSE,
  NODES,
  questions,
  throughRecommend,
} from "../../../test/support/run-scripts.js";
import { findSecret } from "../context/secrets.js";
import { scanRequest } from "../context/token-check.js";
import { correctDecision } from "../session/answers.js";
import type { RecordOf } from "../session/records.js";
import type { CallPurpose } from "../validation/aliases.js";
import { recordInspection, runAnalyse, runExpansionStep } from "./analysis.js";
import { runGenerateQuestions, runRecommend } from "./clarify.js";
import { runRegeneration } from "./regenerate.js";

// The scan of the complete request (IMPL §1.7), through the core API with recorded responses.
// Each record is scanned before it is numbered; the complete request is scanned again before
// it is counted and sent. A match there leaves out every record it overlaps and builds the call
// again; a match in no record is in code's fixed text and fails as an internal error.
//
// A match can't span two records, since each record's lines end in a line break and every rule
// works within one line. It can appear where rendering changes a text field: a field holding a
// line break is sent as a JSON string, which turns the break into `\n`. A connection string
// broken across lines then matches only in the request.

/** Raw, its line break stops `connection-string`; as JSON, `\n` joins the password to the host. */
const HIDDEN = ["Use postgres://admin:", "hunter\nx@db.internal for the tests."].join("");
const PASSWORD = "hunter";
const KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const calls = (h: Harness) =>
  h.session.records.filter((r): r is RecordOf<"model_call"> => r.type === "model_call");
const withheld = (h: Harness) =>
  h.session.records.filter((r): r is RecordOf<"secret_withheld"> => r.type === "secret_withheld");

/** The fixture: raw, no rule matches; rendered as a JSON string, one does. */
it("the fixture matches only once rendered as a JSON string", () => {
  expect(findSecret(HIDDEN)).toBeUndefined();
  expect(findSecret(JSON.stringify(HIDDEN))?.ruleId).toBe("connection-string");
});

/** The placeholder prompts, with a secret in the system prompt of `call`. */
function promptsWithSecretIn(call: CallPurpose) {
  const base = testPromptSet();
  return {
    testOnly: true,
    prompt(c: CallPurpose) {
      const prompt = base.prompt(c);
      return c === call ? { ...prompt, text: `${prompt.text}\nid = ${KEY}\n` } : prompt;
    },
  };
}

describe("a match in a record (IMPL §1.7)", () => {
  it("call 4: withholds the decision it overlaps and sends the call without it", async () => {
    const nothing: Answer = (request) =>
      response(request, JSON.stringify({ recommendations: [], heldBack: [] }));
    const t = await throughRecommend([nothing]);
    const sentBefore = t.h.sent.length;
    // A corrected decision with the hidden connection string, then call 4 again.
    await t.h.session.change((log) =>
      correctDecision(log, {
        supersedes: t.decisionId,
        statement: HIDDEN,
        scope: { kind: "repository" },
        exceptions: [],
        actor: "developer",
        decidedAt: "2026-11-01T10:40:00.000Z",
      }),
    );
    const decision = t.h.session.records.filter((r) => r.type === "decision").at(-1) as {
      id: string;
    };
    const outcome = await runRecommend(t.h.session, t.h.deps, t.run);

    expect(withheld(t.h).map((w) => [w.itemId, w.secretRuleId])).toEqual([
      [decision.id, "connection-string"],
    ]);
    // Sent once, after the withholding, and the request no longer matches.
    expect(t.h.sent).toHaveLength(sentBefore + 1);
    const request = t.h.sent.at(-1);
    expect(request === undefined ? "x" : scanRequest(request)).toBeUndefined();
    expect(request?.user).not.toContain("postgres://");
    expect(request?.user).not.toMatch(/^D-\d+ /m);
    expect(outcome.kind).not.toBe("stopped");
    // Nothing records the matched text.
    const recorded = t.h.session.records.filter((r) => r.type !== "decision");
    expect(JSON.stringify(recorded)).not.toContain(PASSWORD);
  });

  it("call 2: withholds the call-1 finding it overlaps and sends call 2 without it", async () => {
    const answers: Answer[] = [];
    const h = await harness(NODES, answers);
    const item = h.context.items.find((i) => i.path === "CLAUDE.md")?.id as string;
    const one = {
      ...EMPTY_ANALYSE,
      findings: [
        {
          key: "f1",
          statement: HIDDEN,
          mode: "descriptive",
          scope: { kind: "repository" },
          citations: [{ item, lines: "3-3", quote: "Run the tests before pushing." }],
        },
      ],
      expansionRequests: [
        { kind: "read", entries: [{ path: "notes/extra.txt" }], reason: "Read the notes." },
      ],
    };
    const { expansionRequests: _, ...rest } = EMPTY_ANALYSE;
    answers.push(JSON.stringify(one), JSON.stringify({ ...rest, revisions: [] }));
    const inspection = await recordInspection(h.session, h.context);
    const first = await runAnalyse(h.session, h.deps, {
      context: h.context,
      inspection,
      destination: h.destination,
    });
    if (first.kind !== "completed") throw new Error(first.kind);
    const finding = h.session.records.find(
      (r) => r.type === "finding" && "statement" in r && r.statement === HIDDEN,
    ) as { findingId: string } | undefined;
    expect(finding).toBeDefined();

    const two = await runExpansionStep(h.session, h.deps, {
      callOne: first,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("completed");
    expect(withheld(h).map((w) => [w.itemId, w.secretRuleId])).toEqual([
      [finding?.findingId, "connection-string"],
    ]);
    expect(h.sent).toHaveLength(2);
    const request = h.sent[1];
    expect(request === undefined ? "x" : scanRequest(request)).toBeUndefined();
    expect(request?.user).toContain("<<<CALL 1 RESULTS>>>\n<<<END CALL 1 RESULTS>>>\n");
  });

  it("call 2: a second match takes a second round, and each round leaves out one more record", async () => {
    const answers: Answer[] = [];
    const h = await harness(NODES, answers);
    const item = h.context.items.find((i) => i.path === "CLAUDE.md")?.id as string;
    const other = ["Point mysql://root:", "hunter\nx@db.internal at the fixtures."].join("");
    const finding = (key: string, statement: string) => ({
      key,
      statement,
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [{ item, lines: "3-3", quote: "Run the tests before pushing." }],
    });
    const one = {
      ...EMPTY_ANALYSE,
      findings: [finding("f1", HIDDEN), finding("f2", other)],
      expansionRequests: [
        { kind: "read", entries: [{ path: "notes/extra.txt" }], reason: "Read the notes." },
      ],
    };
    const { expansionRequests: _, ...rest } = EMPTY_ANALYSE;
    answers.push(JSON.stringify(one), JSON.stringify({ ...rest, revisions: [] }));
    const inspection = await recordInspection(h.session, h.context);
    const first = await runAnalyse(h.session, h.deps, {
      context: h.context,
      inspection,
      destination: h.destination,
    });
    if (first.kind !== "completed") throw new Error(first.kind);
    const ids = h.session.records.flatMap((r) =>
      r.type === "finding" && "statement" in r && (r.statement === HIDDEN || r.statement === other)
        ? [(r as { findingId: string }).findingId]
        : [],
    );
    expect(ids).toHaveLength(2);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: first,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("completed");
    // One record per round, in rendering order, and a single send once the request is clean.
    expect(withheld(h).map((w) => w.itemId)).toEqual(ids);
    expect(h.sent).toHaveLength(2);
    const request = h.sent[1];
    expect(request === undefined ? "x" : scanRequest(request)).toBeUndefined();
  });

  it("call 5: invalidates the recommendation it overlaps, and a part left empty sends nothing", async () => {
    const t = await throughRecommend([], undefined, {}, HIDDEN);
    const rec = t.h.session.records.find((r) => r.type === "recommendation_revision") as {
      recommendationId: string;
    };
    const before = t.h.sent.length;
    const decision = await t.h.session.change((log) =>
      correctDecision(log, {
        supersedes: t.decisionId,
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
        actor: "developer",
        decidedAt: "2026-11-01T10:40:00.000Z",
      }),
    );
    const outcome = await runRegeneration(t.h.session, t.h.deps, t.run, {
      kind: "decision",
      decisionId: decision.id,
    });
    expect(outcome).toEqual({ kind: "ran", calls: [{ kind: "emptied" }] });
    expect(t.h.sent).toHaveLength(before);
    const latest = t.h.session.records
      .filter((r) => r.type === "recommendation_revision")
      .at(-1) as Record<string, unknown>;
    expect(latest).toMatchObject({
      recommendationId: rec.recommendationId,
      status: "invalidated",
      invalidatedReason: "secret_match",
      secretRuleId: "connection-string",
    });
    expect(latest).not.toHaveProperty("revisedBy");
  });
});

describe("a match in no record is an internal error (IMPL §1.7)", () => {
  it("call 1: a match in the system prompt sends nothing and appends nothing", async () => {
    const answers: Answer[] = [];
    const h = await harness(NODES, answers, { prompts: promptsWithSecretIn("analyse") });
    answers.push(callOne(h));
    const inspection = await recordInspection(h.session, h.context);
    const before = h.session.records.length;
    await expect(
      runAnalyse(h.session, h.deps, { context: h.context, inspection, destination: h.destination }),
    ).rejects.toThrow(/internal error: .*aws-access-key-id/);
    expect(h.sent).toHaveLength(0);
    expect(h.session.records).toHaveLength(before);
  });

  it("call 3: a match in the system prompt sends nothing and records no model call", async () => {
    const answers: Answer[] = [];
    const h = await harness(NODES, answers, { prompts: promptsWithSecretIn("generate_questions") });
    answers.push(callOne(h), questions);
    const inspection = await recordInspection(h.session, h.context);
    const one = await runAnalyse(h.session, h.deps, {
      context: h.context,
      inspection,
      destination: h.destination,
    });
    if (one.kind !== "completed") throw new Error(one.kind);
    const callsBefore = calls(h).length;
    await expect(
      runGenerateQuestions(h.session, h.deps, {
        sent: one.sent,
        inspection,
        destination: h.destination,
      }),
    ).rejects.toThrow(/internal error: .*aws-access-key-id/);
    expect(h.sent).toHaveLength(1);
    expect(calls(h)).toHaveLength(callsBefore);
    expect(withheld(h)).toEqual([]);
    expect(JSON.stringify(h.session.records)).not.toContain(KEY);
  });
});
