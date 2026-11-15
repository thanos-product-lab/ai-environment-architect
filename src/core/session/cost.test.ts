import { describe, expect, it } from "vitest";
import {
  callDraft,
  completedCall,
  hashOf,
  newLog,
  TEST_SETTINGS,
} from "../../../test/support/session.js";
import { recoverInterruptedWork } from "./calls.js";
import {
  type CallUsage,
  callCost,
  checkBeforeSend,
  estimateCall,
  type PriceTable,
  priceTableHash,
} from "./cost.js";
import type { SessionLog } from "./log.js";
import { sessionRecord } from "./records.js";

// The budget estimate and the cost of a call (IMPL §3.6 "The estimate", §4.6 "Cost is always an
// estimate"). The prices here are made up, so these tests don't change when real prices do; the
// real table is pinned to its version in `src/adapters/claude/prices.test.ts`.

const TABLE: PriceTable = {
  version: "prices/test",
  date: "2026-11-15",
  models: {
    // USD per million tokens.
    "claude-test": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.5 },
    "claude-test-other": { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
  },
};

/** The `priceTable` a call made under `TABLE` records. */
const RECORDED = { version: TABLE.version, date: TABLE.date };

const known = <T>(value: T) => ({ state: "known" as const, value });

function usage(parts: Partial<CallUsage> = {}): CallUsage {
  return {
    input: known(0),
    output: known(0),
    cacheRead: known(0),
    cacheWrite: known(0),
    ...parts,
  };
}

function withConfig(budget: { maxTokens?: number; maxCostUsd?: number } = {}): SessionLog {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  log.start({
    type: "generation_config",
    settings: TEST_SETTINGS,
    settingsHash: hashOf("9"),
    requestedModel: "claude-test",
    effort: "medium",
    budget,
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    retainModelInputs: true,
  });
  return log;
}

describe("the estimate before a send (IMPL §3.6)", () => {
  it("estimates tokens as the input tokens plus reservedOutputTokens", () => {
    const estimate = estimateCall(TABLE, {
      model: "claude-test",
      inputTokens: 12_000,
      reservedOutputTokens: 16_000,
      cachesInput: false,
    });
    expect(estimate.tokens).toEqual(known(28_000));
  });

  it("prices the input at the input price and reservedOutputTokens at the output price, since thinking is billed as output", () => {
    const estimate = estimateCall(TABLE, {
      model: "claude-test",
      inputTokens: 12_000,
      reservedOutputTokens: 16_000,
      cachesInput: false,
    });
    expect(estimate.cost).toEqual(known((12_000 * 4 + 16_000 * 20) / 1_000_000));
  });

  it("prices the input at the cache-write price when the request sets a cache breakpoint", () => {
    const estimate = estimateCall(TABLE, {
      model: "claude-test",
      inputTokens: 12_000,
      reservedOutputTokens: 16_000,
      cachesInput: true,
    });
    expect(estimate.cost).toEqual(known((12_000 * 5 + 16_000 * 20) / 1_000_000));
  });

  it("gives an unknown cost, with a reason naming the model, for a model missing from the table, and still known tokens", () => {
    for (const model of ["claude-missing", "toString", "__proto__", "constructor"]) {
      const estimate = estimateCall(TABLE, {
        model,
        inputTokens: 100,
        reservedOutputTokens: 200,
        cachesInput: false,
      });
      expect(estimate.cost, model).toEqual({ state: "unknown", reason: `no_price:${model}` });
      expect(estimate.tokens, model).toEqual(known(300));
    }
  });
});

describe("the cost after a call (IMPL §4.6)", () => {
  it("refuses to price a call from a table other than the one it records", () => {
    for (const recorded of [
      { version: "prices/other", date: TABLE.date },
      { version: TABLE.version, date: "2026-11-16" },
    ])
      expect(() => callCost(TABLE, recorded, known("claude-test"), usage())).toThrow(
        /records price table/,
      );
  });

  it("prices the four usage counts, cached tokens included, with the basis estimated", () => {
    const cost = callCost(
      TABLE,
      RECORDED,
      known("claude-test"),
      usage({
        input: known(1_000),
        output: known(2_000),
        cacheRead: known(3_000),
        cacheWrite: known(4_000),
      }),
    );
    expect(cost).toEqual(
      known({
        amount: (1_000 * 4 + 2_000 * 20 + 3_000 * 0.5 + 4_000 * 5) / 1_000_000,
        currency: "USD",
        basis: "estimated",
      }),
    );
  });

  it("prices by the returned model, which the billing follows", () => {
    const cost = callCost(
      TABLE,
      RECORDED,
      known("claude-test-other"),
      usage({ input: known(1_000_000) }),
    );
    expect(cost).toMatchObject(known({ amount: 1 }));
  });

  it("is unknown, never zero, when any usage count is unknown, naming the unknown counts", () => {
    const cost = callCost(
      TABLE,
      RECORDED,
      known("claude-test"),
      usage({
        input: known(1_000),
        cacheRead: { state: "unknown", reason: "not_reported" },
        cacheWrite: { state: "unknown", reason: "not_reported" },
      }),
    );
    expect(cost).toEqual({ state: "unknown", reason: "usage_unknown:cacheRead,cacheWrite" });
  });

  it("is unknown when the returned model is missing from the table, or unknown", () => {
    expect(callCost(TABLE, RECORDED, known("claude-missing"), usage())).toEqual({
      state: "unknown",
      reason: "no_price:claude-missing",
    });
    expect(
      callCost(TABLE, RECORDED, { state: "unknown", reason: "not_reported" }, usage()),
    ).toEqual({
      state: "unknown",
      reason: "returned_model_unknown",
    });
  });

  it("is accepted on an ended revision whose returned model differs from the requested one, and both are kept", () => {
    const log = newLog();
    const started = log.start(callDraft({ requestedModel: "claude-test" }));
    const u = usage({ input: known(1_000_000) });
    const ended = log.revise(
      "model_call",
      started.modelCallId,
      completedCall({
        returnedModel: known("claude-test-other"),
        usage: u,
        cost: callCost(TABLE, RECORDED, known("claude-test-other"), u),
      }),
    );
    expect(sessionRecord.safeParse(ended).success).toBe(true);
    expect(ended).toMatchObject({
      requestedModel: "claude-test",
      returnedModel: known("claude-test-other"),
      cost: known({ amount: 1, currency: "USD", basis: "estimated" }),
    });
  });
});

describe("the check before a send (IMPL §3.6, §4.6)", () => {
  const input = {
    model: "claude-test",
    inputTokens: 12_000,
    reservedOutputTokens: 16_000,
    cachesInput: false,
  };

  it("gives the started revision its budget, estimatedCost, estimatedTokens and the table's version and date", () => {
    const log = withConfig({ maxCostUsd: 10 });
    const { check, started } = checkBeforeSend(log.records, TABLE, input);
    expect(check.result).toBe("send");
    expect(started).toEqual({
      budget: check.budget,
      estimatedCost: estimateCall(TABLE, input).cost,
      estimatedTokens: estimateCall(TABLE, input).tokens,
      priceTable: { version: "prices/test", date: "2026-11-15" },
    });
    expect(sessionRecord.safeParse(log.start(callDraft(started))).success).toBe(true);
  });

  it("stops a call whose estimate would pass the cost ceiling", () => {
    const log = withConfig({ maxCostUsd: 0.3 });
    expect(checkBeforeSend(log.records, TABLE, input).check).toMatchObject({
      result: "budget_reached",
      exceeded: ["cost"],
    });
  });

  it("stops a call whose estimated tokens would pass the token ceiling", () => {
    const log = withConfig({ maxTokens: 27_999 });
    expect(checkBeforeSend(log.records, TABLE, input).check).toMatchObject({
      result: "budget_reached",
      exceeded: ["tokens"],
    });
  });

  it("can't pass for a model missing from the table until the developer confirms the budget", () => {
    const log = withConfig({ maxCostUsd: 10 });
    const missing = { ...input, model: "claude-missing" };
    expect(checkBeforeSend(log.records, TABLE, missing).check).toMatchObject({
      result: "cannot_check",
      unknown: ["cost"],
    });
    log.revise("generation_config", "generation_config", { reason: "budget_confirmed" });
    const after = checkBeforeSend(log.records, TABLE, missing);
    expect(after.check.result).toBe("send");
    expect(after.started.estimatedCost).toEqual({
      state: "unknown",
      reason: "no_price:claude-missing",
    });
  });

  it("counts partly known usage as the call's estimatedTokens, never as zero, and the unknown cost as its estimatedCost", () => {
    const log = withConfig({ maxTokens: 1_000_000, maxCostUsd: 10 });
    const first = log.start(callDraft(checkBeforeSend(log.records, TABLE, input).started));
    const partial = usage({
      input: known(12_000),
      output: known(9_000),
      cacheRead: { state: "unknown", reason: "not_reported" },
    });
    log.revise(
      "model_call",
      first.modelCallId,
      completedCall({
        usage: partial,
        cost: callCost(TABLE, RECORDED, known("claude-test"), partial),
      }),
    );
    const { check } = checkBeforeSend(log.records, TABLE, input);
    expect(check.result).toBe("send");
    // Usage and cost are unknown, so the budget stands in the call's estimates, never zero:
    // 12,000 input plus 16,000 reserved output tokens, more than the 21,000 known.
    expect(check.budget.spentCostUsd).toEqual(known(0.368));
    expect(check.budget.spentTokens).toEqual(known(28_000));
  });

  it("counts an interrupted call's estimate in the spend, never as its cost", () => {
    const log = withConfig({ maxCostUsd: 10 });
    log.start(callDraft(checkBeforeSend(log.records, TABLE, input).started));
    recoverInterruptedWork(log);
    const { check } = checkBeforeSend(log.records, TABLE, input);
    expect(check.budget.spentCostUsd).toEqual(known(0.368));
  });
});

describe("the table's hash (IMPL §4.6)", () => {
  it("doesn't depend on key order, and changes with any price", () => {
    const reordered: PriceTable = {
      date: TABLE.date,
      models: {
        "claude-test-other": { cacheRead: 4, cacheWrite: 3, output: 2, input: 1 },
        "claude-test": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.5 },
      },
      version: TABLE.version,
    };
    expect(priceTableHash(reordered)).toBe(priceTableHash(TABLE));
    const changed: PriceTable = {
      ...TABLE,
      models: {
        ...TABLE.models,
        "claude-test": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 },
      },
    };
    expect(priceTableHash(changed)).not.toBe(priceTableHash(TABLE));
  });
});
