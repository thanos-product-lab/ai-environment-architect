import type { ModelRequest } from "../request.js";
import { DESTINATION_PATH } from "../snapshot/snapshot.js";
import { recordedPath, type SecretRuleId, scanText } from "./secrets.js";
import {
  type ReadyContext,
  type Reduction,
  type ReductionStep,
  reduceContext,
  type TokenCheckRecord,
} from "./select.js";
import { type DestinationStop, type SelectionGap, TEST_EXAMPLE_REASON } from "./tiers.js";
import type { CallPurpose, TokenSettings } from "./token-settings.js";

// The token check (IMPL §1.10). Before every call, the complete request is scanned (§1.7) and
// counted, and must leave room for the output and a margin within the model's input limit:
//
//   inputTokens + reservedOutputTokens(call) + safetyMargin ≤ modelContextLimit
//
// If it doesn't fit, items are removed one at a time in a fixed order, and the request is
// rendered, scanned and counted again after each removal, until it fits or nothing removable is
// left. The check can only remove, so the byte selection stays the same across models, and the
// final context is the same for a fixed model and input limit.

export { type Reduction, reduceContext } from "./select.js";

export type TokenCount =
  | { readonly state: "counted"; readonly inputTokens: number }
  | { readonly state: "failed"; readonly reason: string };

/** The provider's token counting (`POST /v1/messages/count_tokens`), through the adapter. */
export interface TokenCounter {
  countTokens(request: ModelRequest): Promise<TokenCount>;
}

export type LimitLookup =
  | {
      readonly state: "known";
      /** `max_input_tokens` in the Models API: the check's `modelContextLimit`. */
      readonly maxInputTokens: number;
      /** `max_tokens` in the Models API, or null when it gives none. */
      readonly maxOutputTokens: number | null;
    }
  | { readonly state: "failed"; readonly reason: string };

/** The selected model's limits (`GET /v1/models/{id}`), through the adapter. */
export interface ModelLimits {
  modelLimits(model: string): Promise<LimitLookup>;
}

export interface TokenCheckDeps {
  readonly counter: TokenCounter;
  readonly models: ModelLimits;
  readonly tokens: TokenSettings;
}

/** The removals a call allows, in order, and its request with the first `removed` of them made. */
export interface ReductionPlan {
  readonly units: readonly Reduction[];
  render(removed: number): ModelRequest;
}

export type TokenCheckResult =
  | {
      readonly state: "fits";
      readonly request: ModelRequest;
      /** How many of the plan's units were removed. */
      readonly removed: number;
      readonly tokenCheck: TokenCheckRecord;
    }
  /** Every unit removed, and still too large: the call is not sent. */
  | {
      readonly state: "does_not_fit";
      readonly request: ModelRequest;
      readonly removed: number;
      readonly tokenCheck: TokenCheckRecord;
    }
  /** The request matched the secret scan, so it was neither counted nor sent (§1.7). */
  | { readonly state: "secret_match"; readonly ruleId: SecretRuleId; readonly removed: number }
  /** The call is not sent without the input limit: a guessed one could change what is sent. */
  | { readonly state: "limit_unavailable"; readonly reason: string };

/** The rule ID of the first secret-scan match in what the request sends, if any. */
export function scanRequest(request: ModelRequest): SecretRuleId | undefined {
  return (
    scanText(request.system) ??
    scanText(request.user) ??
    (request.retryMessage === undefined ? undefined : scanText(request.retryMessage)) ??
    scanText(JSON.stringify(request.schema))
  );
}

/**
 * 1 token per 3 bytes, rounded up, over the system prompt, the user content (a schema retry's
 * message included) and the schema.
 */
export function estimateTokens(request: ModelRequest): number {
  const bytes =
    Buffer.byteLength(request.system, "utf8") +
    Buffer.byteLength(request.user, "utf8") +
    Buffer.byteLength(request.retryMessage ?? "", "utf8") +
    Buffer.byteLength(JSON.stringify(request.schema), "utf8");
  return Math.ceil(bytes / 3);
}

/** Counts by the provider until a count fails; from then on, by the estimate. */
class Measure {
  method: TokenCheckRecord["method"] = "provider_count";
  private readonly counter: TokenCounter;

  constructor(counter: TokenCounter) {
    this.counter = counter;
  }

  async count(request: ModelRequest): Promise<number> {
    if (this.method === "provider_count") {
      const counted = await this.counter.countTokens(request);
      if (counted.state === "counted") return counted.inputTokens;
      this.method = "estimate";
    }
    return estimateTokens(request);
  }
}

interface Limit {
  readonly contextLimit: number;
  /** `reservedOutputTokens + safetyMargin`, the margin rounded up to a whole token. */
  readonly reserved: number;
  readonly reservedOutputTokens: number;
}

export async function checkTokens(
  purpose: CallPurpose,
  plan: ReductionPlan,
  deps: TokenCheckDeps,
): Promise<TokenCheckResult> {
  const first = plan.render(0);
  const limit = await lookUp(purpose, first.model, deps);
  if (limit.state === "failed") return { state: "limit_unavailable", reason: limit.reason };
  return run(purpose, plan, limit.value, new Measure(deps.counter), first);
}

/**
 * One call's check under a limit already looked up and a measure already in use: a second count
 * within the same call, such as call 1's recount without the destination, keeps both.
 */
async function run(
  purpose: CallPurpose,
  plan: ReductionPlan,
  limit: Limit,
  measure: Measure,
  first: ModelRequest = plan.render(0),
): Promise<Exclude<TokenCheckResult, { state: "limit_unavailable" }>> {
  for (let removed = 0; ; removed++) {
    const request = removed === 0 ? first : plan.render(removed);
    if (request.maxTokens !== limit.reservedOutputTokens)
      throw new Error(
        `the request's max_tokens (${request.maxTokens}) is not ${purpose}'s reservedOutputTokens (${limit.reservedOutputTokens})`,
      );
    const ruleId = scanRequest(request);
    if (ruleId !== undefined) return { state: "secret_match", ruleId, removed };
    const inputTokens = await measure.count(request);
    const tokenCheck: TokenCheckRecord = {
      model: request.model,
      method: measure.method,
      inputTokens,
      reservedOutputTokens: limit.reservedOutputTokens,
      contextLimit: limit.contextLimit,
      reductions: plan.units.slice(0, removed),
    };
    if (inputTokens + limit.reserved <= limit.contextLimit)
      return { state: "fits", request, removed, tokenCheck };
    if (removed >= plan.units.length)
      return { state: "does_not_fit", request, removed, tokenCheck };
  }
}

async function lookUp(
  purpose: CallPurpose,
  model: string,
  deps: TokenCheckDeps,
): Promise<{ state: "known"; value: Limit } | { state: "failed"; reason: string }> {
  const looked = await deps.models.modelLimits(model);
  if (looked.state === "failed") return looked;
  const reservedOutputTokens = deps.tokens.reservedOutputTokens[purpose];
  const margin = Math.ceil(deps.tokens.safetyMargin * looked.maxInputTokens);
  return {
    state: "known",
    value: {
      contextLimit: looked.maxInputTokens,
      reserved: reservedOutputTokens + margin,
      reservedOutputTokens,
    },
  };
}

// --- Calls 1 and 2: the initial context -------------------------------------------------------

const TIER_STEP: Readonly<Record<1 | 2 | 5, ReductionStep>> = {
  1: "tier1",
  2: "tier2",
  5: "tier5",
};

/**
 * The removals calls 1 and 2 allow, in order: tier 5 last selected first, test examples last;
 * then tier 2, then other tier 1 configuration, each last selected first. The known facts, tier 3
 * manifests, the destination and expansion results are never removed.
 */
export function contextReductions(context: ReadyContext): Reduction[] {
  const unit = (item: ReadyContext["items"][number]): Reduction => ({
    step: TIER_STEP[item.tier as 1 | 2 | 5],
    id: item.id,
    ...recordedPath(item.path),
    bytes: item.rendered.bytes,
  });
  const lastFirst = (tier: 1 | 2 | 5) =>
    context.items.filter((item) => item.tier === tier && !isDestination(item)).reverse();
  const tier5 = lastFirst(5);
  return [
    ...tier5.filter((item) => item.reason !== TEST_EXAMPLE_REASON),
    ...tier5.filter((item) => item.reason === TEST_EXAMPLE_REASON),
    ...lastFirst(2),
    ...lastFirst(1),
  ].map(unit);
}

function isDestination(item: ReadyContext["items"][number]): boolean {
  return item.tier === 1 && item.path === DESTINATION_PATH;
}

export type ContextCallResult =
  | {
      readonly state: "fits";
      readonly request: ModelRequest;
      /** The context sent, its manifest with `tokenCheck` set. */
      readonly context: ReadyContext;
      /**
       * This call's gap for the agent configuration it removed, if any (IMPL §1.10): recorded
       * as a deterministic finding before the call is sent.
       */
      readonly gap?: SelectionGap;
    }
  /**
   * Call 2 still doesn't fit: it isn't sent, and the session records `stage_skipped`
   * (`skipExpansion`) and continues with call 1's results.
   */
  | { readonly state: "skipped"; readonly lastRequest: ModelRequest }
  /** Call 1 would fit without the destination: the destination rule stops the session (§1.5). */
  | {
      readonly state: "stopped";
      readonly stop: Extract<DestinationStop, { reason: "destination_exceeds_input_limit" }>;
    }
  /** Call 1 doesn't fit even without the destination: the session stops. */
  | {
      readonly state: "context_exceeds_input_limit";
      readonly inputTokens: number;
      readonly contextLimit: number;
    }
  | Extract<TokenCheckResult, { state: "secret_match" | "limit_unavailable" }>;

/**
 * The token check for call 1 or 2. `build` makes the complete request around a context, so a
 * removal is re-rendered with everything else unchanged: for call 2, call 1's results and the
 * expansion results, which are never removed.
 */
export async function checkContextCall(
  purpose: "analyse" | "analyse_expansion",
  context: ReadyContext,
  build: (context: ReadyContext) => ModelRequest,
  deps: TokenCheckDeps,
): Promise<ContextCallResult> {
  const units = contextReductions(context);
  const ids = (n: number) => new Set(units.slice(0, n).map((u) => ("id" in u ? u.id : "")));
  const reduced = (n: number) => (n === 0 ? context : reduceContext(context, ids(n)));
  const first = build(context);
  const limit = await lookUp(purpose, first.model, deps);
  if (limit.state === "failed") return { state: "limit_unavailable", reason: limit.reason };
  const measure = new Measure(deps.counter);
  const result = await run(
    purpose,
    { units, render: (n) => build(reduced(n)) },
    limit.value,
    measure,
    first,
  );
  switch (result.state) {
    case "secret_match":
      return result;
    case "fits": {
      const sent = reduced(result.removed);
      const gap =
        sent.tokenCheckGaps.length > context.tokenCheckGaps.length
          ? sent.tokenCheckGaps.at(-1)
          : undefined;
      return {
        state: "fits",
        request: result.request,
        context: { ...sent, manifest: { ...sent.manifest, tokenCheck: result.tokenCheck } },
        ...(gap === undefined ? {} : { gap }),
      };
    }
    case "does_not_fit":
      break;
  }
  if (purpose === "analyse_expansion") return { state: "skipped", lastRequest: result.request };

  // Call 1: is the destination the cause? Count the fully reduced request once more without it,
  // under the same limit and by the same method: it is part of the same call's check.
  const { contextLimit } = result.tokenCheck;
  const destination = context.items.find(isDestination);
  if (destination !== undefined) {
    const without = await run(
      purpose,
      {
        units: [],
        render: () => build(reduceContext(context, ids(units.length).add(destination.id))),
      },
      limit.value,
      measure,
    );
    if (without.state === "secret_match") return without;
    if (without.state === "fits")
      return {
        state: "stopped",
        stop: {
          reason: "destination_exceeds_input_limit",
          inputTokens: result.tokenCheck.inputTokens,
          contextLimit,
        },
      };
  }
  return {
    state: "context_exceeds_input_limit",
    inputTokens: result.tokenCheck.inputTokens,
    contextLimit,
  };
}

// --- Calls 3–5: cited excerpts, then the tree depth -------------------------------------------

/** A cited excerpt in a call 3–5 request, in rendering order, with the findings that cite it. */
export interface CitedExcerpt {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly findings: readonly string[];
}

/**
 * The removals calls 3–5 allow (IMPL §1.10 step 4): every excerpt none of whose citing findings
 * an open question or candidate recommendation references, last rendered first, then the tree
 * depth one level at a time down to 0. In call 3 nothing is referenced yet, so every excerpt
 * may go.
 */
export function excerptReductions(
  excerpts: readonly CitedExcerpt[],
  referenced: ReadonlySet<string>,
  treeDepth: number,
): Reduction[] {
  const removable = excerpts
    .filter((excerpt) => excerpt.findings.every((finding) => !referenced.has(finding)))
    .reverse()
    .map(
      (excerpt): Reduction => ({
        step: "excerpt",
        id: excerpt.id,
        ...recordedPath(excerpt.path),
        bytes: excerpt.bytes,
      }),
    );
  const depths: Reduction[] = [];
  for (let depth = treeDepth - 1; depth >= 0; depth--)
    depths.push({ step: "tree_depth", treeDepth: depth });
  return [...removable, ...depths];
}
