import { canonicalJson } from "../context/select.js";
import { type Hash, sha256 } from "../hash.js";
import { type BudgetCheck, type BudgetEstimate, checkBudget } from "./calls.js";
import type { CallBudget, Known, SessionRecord } from "./records.js";

// The budget estimate before a send and the cost after it (IMPL §3.6 "The estimate", §4.6 "Cost is
// always an estimate"). Pure functions over a price table that the caller passes in; the table
// itself is data in the adapter, `src/adapters/claude/prices.ts`.
//
// - The estimate is an upper bound: the input tokens counted (or estimated from bytes) plus
//   `reservedOutputTokens`, which `max_tokens` caps, thinking included.
// - A known cost is always `estimated`: the API reports usage, not cost.
// - A model missing from the table, or any usage count unknown, gives an unknown with a reason,
//   never zero.

/** One model's prices, in USD per million tokens. */
export interface ModelPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

export interface PriceTable {
  readonly version: string;
  /** When the prices were checked on the provider's pricing page, as an ISO date. */
  readonly date: string;
  readonly models: Readonly<Record<string, ModelPrices>>;
}

export interface CallUsage {
  readonly input: Known<number>;
  readonly output: Known<number>;
  readonly cacheRead: Known<number>;
  readonly cacheWrite: Known<number>;
}

export interface EstimateInput {
  readonly model: string;
  /** The token check's input tokens for the request that will be sent (§1.10). */
  readonly inputTokens: number;
  readonly reservedOutputTokens: number;
  /** Whether the request sets a cache breakpoint, so its input is written to the cache. */
  readonly cachesInput: boolean;
}

export type CallCost = Known<{ amount: number; currency: "USD"; basis: "estimated" }>;

const PER_MILLION = 1_000_000;

/** The model's prices; own keys only, so `toString` or `__proto__` is never a model. */
function pricesOf(table: PriceTable, model: string): ModelPrices | undefined {
  return Object.hasOwn(table.models, model) ? table.models[model] : undefined;
}

/** The §3.6 estimate for a call about to be sent. */
export function estimateCall(table: PriceTable, input: EstimateInput): BudgetEstimate {
  const tokens: Known<number> = {
    state: "known",
    value: input.inputTokens + input.reservedOutputTokens,
  };
  const prices = pricesOf(table, input.model);
  if (prices === undefined)
    return { cost: { state: "unknown", reason: `no_price:${input.model}` }, tokens };
  const inputPrice = input.cachesInput ? prices.cacheWrite : prices.input;
  return {
    cost: {
      state: "known",
      value:
        (input.inputTokens * inputPrice + input.reservedOutputTokens * prices.output) / PER_MILLION,
    },
    tokens,
  };
}

const USAGE_PARTS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * A call's cost from its reported usage, priced by the model that answered, which is the one
 * billed. The requested and returned models are both recorded on the call. `recorded` is the
 * `priceTable` on the call's `started` revision: a call is priced from the table it records.
 */
export function callCost(
  table: PriceTable,
  recorded: { readonly version: string; readonly date: string },
  returnedModel: Known<string>,
  usage: CallUsage,
): CallCost {
  if (table.version !== recorded.version || table.date !== recorded.date)
    throw new Error(
      `the call records price table ${recorded.version} (${recorded.date}), not ${table.version} (${table.date})`,
    );
  const unknownParts = USAGE_PARTS.filter((part) => usage[part].state === "unknown");
  if (unknownParts.length > 0)
    return { state: "unknown", reason: `usage_unknown:${unknownParts.join(",")}` };
  if (returnedModel.state === "unknown")
    return { state: "unknown", reason: "returned_model_unknown" };
  const prices = pricesOf(table, returnedModel.value);
  if (prices === undefined) return { state: "unknown", reason: `no_price:${returnedModel.value}` };
  let sum = 0;
  for (const part of USAGE_PARTS) {
    const count = usage[part];
    if (count.state === "known") sum += count.value * prices[part];
  }
  return {
    state: "known",
    value: { amount: sum / PER_MILLION, currency: "USD", basis: "estimated" },
  };
}

export interface BeforeSend {
  readonly check: BudgetCheck;
  /** What the call's `started` revision records from the check. */
  readonly started: {
    readonly budget: CallBudget;
    readonly estimatedCost: Known<number>;
    readonly estimatedTokens: Known<number>;
    readonly priceTable: { readonly version: string; readonly date: string };
  };
}

/**
 * The §3.6 budget check before a send: the estimate, then `checkBudget` over the spend so far.
 * Every send, retries included, goes through it.
 */
export function checkBeforeSend(
  records: readonly SessionRecord[],
  table: PriceTable,
  input: EstimateInput,
): BeforeSend {
  const estimate = estimateCall(table, input);
  const check = checkBudget(records, estimate);
  return {
    check,
    started: {
      budget: check.budget,
      estimatedCost: estimate.cost,
      estimatedTokens: estimate.tokens,
      priceTable: { version: table.version, date: table.date },
    },
  };
}

/** The SHA-256 of the table's canonical JSON, which pins its contents to its version. */
export function priceTableHash(table: PriceTable): Hash {
  return sha256(new TextEncoder().encode(canonicalJson(table)));
}
