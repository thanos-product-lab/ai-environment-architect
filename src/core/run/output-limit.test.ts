import { describe, expect, it } from "vitest";
import { type Answer, harness, response } from "../../../test/support/run-harness.js";
import { callOne, NODES, questions } from "../../../test/support/run-scripts.js";
import { AGENT_CONFIG_TOKEN_LIMIT } from "../context/tiers.js";
import { loadSession } from "../session/load.js";
import type { RecordOf } from "../session/records.js";
import { recordInspection, runAnalyse, runCallTwo, runExpansionStep } from "./analysis.js";
import { runGenerateQuestions } from "./clarify.js";
import { raiseOutputLimit } from "./output-limit.js";

// Raising the output limit after a truncation (IMPL §3.6, §4.6, §3.8).

const truncated: Answer = (request) => {
  const sent = response(request, "{");
  if (sent.kind !== "response" || sent.message === undefined) throw new Error("no message");
  return { ...sent, message: { ...sent.message, stopReason: "max_tokens" } };
};

/** Call 1, then a call 3 that is truncated. */
async function truncatedCallThree(later: Answer[], options: Parameters<typeof harness>[2] = {}) {
  const answers: Answer[] = [];
  const h = await harness(NODES, answers, options);
  answers.push(callOne(h), truncated, ...later);
  const inspection = await recordInspection(h.session, h.context);
  const one = await runAnalyse(h.session, h.deps, {
    context: h.context,
    inspection,
    destination: h.destination,
  });
  if (one.kind !== "completed") throw new Error(one.kind);
  const run = { sent: one.sent, inspection, destination: h.destination };
  const three = await runGenerateQuestions(h.session, h.deps, run);
  if (three.kind !== "failed") throw new Error(`expected a truncation, got ${three.kind}`);
  expect(three.error.kind).toBe("truncated");
  return { h, run, callId: three.modelCallId };
}

const configs = (records: readonly { type: string }[]) =>
  records.filter((r): r is RecordOf<"generation_config"> => r.type === "generation_config");

describe("raising the output limit (IMPL §4.6)", () => {
  it("appends one output_limit_raised revision and resends the truncated call under the new limit", async () => {
    const { h, run, callId } = await truncatedCallThree([questions]);
    const before = configs(h.session.records).at(-1) as RecordOf<"generation_config">;
    const raised = await raiseOutputLimit(h.session, h.deps, {
      truncated: callId,
      limits: { generate_questions: 24_000 },
      resend: (options) => runGenerateQuestions(h.session, h.deps, run, options),
    });
    expect(raised.kind).toBe("resent");
    if (raised.kind !== "resent") return;
    expect(raised.outcome.kind).toBe("completed");
    const after = configs(h.session.records).at(-1) as RecordOf<"generation_config">;
    expect(configs(h.session.records)).toHaveLength(2);
    expect(after).toMatchObject({ reason: "output_limit_raised", budget: before.budget });
    expect(after.settings.tokens.reservedOutputTokens).toEqual({
      ...before.settings.tokens.reservedOutputTokens,
      generate_questions: 24_000,
    });
    expect({ ...after.settings, tokens: undefined }).toEqual({
      ...before.settings,
      tokens: undefined,
    });
    expect(after.settingsHash).not.toBe(before.settingsHash);
    expect(h.sent.at(-1)?.maxTokens).toBe(24_000);
    const last = h.session.records
      .filter((r): r is RecordOf<"model_call"> => r.type === "model_call")
      .at(-1);
    expect(last).toMatchObject({
      retryOf: callId,
      state: "completed",
      purpose: "generate_questions",
    });
    expect(h.session.records.some((r) => r.type === "question")).toBe(true);
    // The saved session loads again: load check 3 accepts the raise (§4.9).
    const loaded = await loadSession(h.store.sessionFile as Uint8Array, h.store);
    expect(loaded.ok).toBe(true);
  });

  it("refuses a value that isn't higher, or doesn't raise the truncated call, appending and sending nothing", async () => {
    const { h, run, callId } = await truncatedCallThree([]);
    const sent = h.sent.length;
    const records = h.session.records.length;
    const resend = (options: Parameters<typeof runGenerateQuestions>[3]) =>
      runGenerateQuestions(h.session, h.deps, run, options);
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { generate_questions: 16_000 },
        resend,
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/isn't higher/) });
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { recommend: 20_000 },
        resend,
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/generate_questions/) });
    expect(h.sent).toHaveLength(sent);
    expect(h.session.records).toHaveLength(records);
  });

  it("refuses a value above the model's output maximum", async () => {
    const { h, run, callId } = await truncatedCallThree([]);
    const records = h.session.records.length;
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { generate_questions: 70_000 },
        resend: (options) => runGenerateQuestions(h.session, h.deps, run, options),
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/output maximum, 64000/) });
    expect(h.session.records).toHaveLength(records);
  });

  it("refuses a value that would make the call fail its token check, before anything is appended", async () => {
    // 1,000 tokens in, 1,000 of margin: a limit above 18,000 can't fit 20,000.
    const { h, run, callId } = await truncatedCallThree([], {
      count: () => 1_000,
      maxInputTokens: 20_000,
    });
    const sent = h.sent.length;
    const before = configs(h.session.records).length;
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { generate_questions: 19_000 },
        resend: (options) => runGenerateQuestions(h.session, h.deps, run, options),
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/token check/) });
    expect(configs(h.session.records)).toHaveLength(before);
    expect(h.sent).toHaveLength(sent);
  });

  it("refuses an unknown purpose, and several purposes when one isn't higher", async () => {
    const { h, run, callId } = await truncatedCallThree([]);
    const records = h.session.records.length;
    const resend = (options: Parameters<typeof runGenerateQuestions>[3]) =>
      runGenerateQuestions(h.session, h.deps, run, options);
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { generate_questions: 20_000, nonsense: 30_000 } as never,
        resend,
      }),
    ).toMatchObject({ kind: "refused", reason: "nonsense isn't a call" });
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { generate_questions: 20_000, recommend: 16_000 },
        resend,
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/recommend: 16000/) });
    expect(h.session.records).toHaveLength(records);
  });

  it("refuses a raise when the model publishes no output maximum", async () => {
    const { h, run, callId } = await truncatedCallThree([], { maxOutputTokens: null });
    expect(
      await raiseOutputLimit(h.session, h.deps, {
        truncated: callId,
        limits: { generate_questions: 20_000 },
        resend: (options) => runGenerateQuestions(h.session, h.deps, run, options),
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/maximum is unavailable/) });
  });

  it("checks the budget with the new limit: the raise is appended, then the send stops at the budget", async () => {
    // The estimate grows with the reserved output, so a token ceiling the raise passes stops it.
    const { h, run, callId } = await truncatedCallThree([], { budget: { maxTokens: 40_000 } });
    const sent = h.sent.length;
    const raised = await raiseOutputLimit(h.session, h.deps, {
      truncated: callId,
      limits: { generate_questions: 60_000 },
      resend: (options) => runGenerateQuestions(h.session, h.deps, run, options),
    });
    expect(raised).toMatchObject({ kind: "resent", outcome: { kind: "not_sent" } });
    expect(h.sent).toHaveLength(sent);
    expect(h.session.records.at(-1)).toMatchObject({
      type: "session_state",
      reason: "budget_reached",
      unsentPurpose: "generate_questions",
    });
  });
});

describe("resending calls 1 and 2 (IMPL §4.6, §1.10)", () => {
  it("resends call 1 without recording its token-check gap again", async () => {
    const nodes = { ...NODES, ".claude/extra.md": "# Extra\n\nMore rules.\n" };
    const answers: Answer[] = [];
    const h = await harness(nodes, answers, {
      count: (request) => (request.user.includes('path=".claude/extra.md"') ? 10_000_000 : 1_000),
    });
    answers.push(truncated, callOne(h));
    const inspection = await recordInspection(h.session, h.context);
    const input = { context: h.context, inspection, destination: h.destination };
    const first = await runAnalyse(h.session, h.deps, input);
    if (first.kind !== "failed") throw new Error(first.kind);
    const gaps = () =>
      h.session.records.filter(
        (r) =>
          r.type === "finding" &&
          r.kind === "gap" &&
          "statement" in r &&
          r.statement === AGENT_CONFIG_TOKEN_LIMIT,
      );
    expect(gaps()).toHaveLength(1);
    const raised = await raiseOutputLimit(h.session, h.deps, {
      truncated: first.modelCallId,
      limits: { analyse: 20_000 },
      resend: (options) => runAnalyse(h.session, h.deps, input, options),
    });
    expect(raised).toMatchObject({ kind: "resent", outcome: { kind: "completed" } });
    expect(gaps()).toHaveLength(1);
    const last = h.session.records
      .filter((r): r is RecordOf<"model_call"> => r.type === "model_call")
      .at(-1);
    expect(last).toMatchObject({ retryOf: first.modelCallId, attempt: 2, purpose: "analyse" });
  });

  it("refuses a call 2 resend that no longer fits, recording no stage_skipped and appending nothing", async () => {
    const answers: Answer[] = [];
    const h = await harness(NODES, answers, { count: () => 1_000, maxInputTokens: 20_000 });
    const read = { kind: "read", entries: [{ path: "notes/extra.txt" }], reason: "Read it." };
    answers.push(callOne(h, [read]), truncated);
    const inspection = await recordInspection(h.session, h.context);
    const one = await runAnalyse(h.session, h.deps, {
      context: h.context,
      inspection,
      destination: h.destination,
    });
    if (one.kind !== "completed") throw new Error(one.kind);
    const input = { callOne: one, inspection, destination: h.destination };
    const two = await runExpansionStep(h.session, h.deps, input);
    if (two.kind !== "failed") throw new Error(two.kind);
    const records = h.session.records.length;
    const sent = h.sent.length;
    const raised = await raiseOutputLimit(h.session, h.deps, {
      truncated: two.modelCallId,
      limits: { analyse_expansion: 19_000 },
      resend: (options) => runCallTwo(h.session, h.deps, input, two.recorded, options),
    });
    expect(raised).toMatchObject({ kind: "refused", reason: expect.stringMatching(/token check/) });
    expect(h.session.records).toHaveLength(records);
    expect(h.sent).toHaveLength(sent);
  });
});
