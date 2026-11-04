import type { Changes, SessionLog } from "./log.js";
import type {
  CallBudget,
  EffortIntervalRecord,
  Known,
  ModelCallRecord,
  RecordOf,
  SessionRecord,
  Total,
} from "./records.js";

// Model calls and effort (IMPL §4.6; DM §13). Pure functions over the records, except
// `recoverInterruptedWork`, which appends to a log that only the lock holder has.
//
// - A call still `started`, or an interval still `open`, on resume was interrupted. Its end,
//   usage and cost are unknown, never zero, because it may have been billed.
// - The budget counts an unknown cost as the call's `estimatedCost`, and never reports the
//   estimate as cost. Unknown parts with no stand-in make the check impossible until a
//   `generation_config` revision with the reason `budget_raised` or `budget_confirmed` settles
//   them; a settled call then counts its known parts only.
// - Active effort is the sum of the closed intervals; an interrupted or in-progress one makes it a
//   lower bound, never unknown.

const INTERRUPTED = "interrupted";

export type Progress = "in_progress" | "interrupted";

export interface UnfinishedWork {
  readonly calls: readonly { readonly modelCallId: string; readonly progress: Progress }[];
  readonly intervals: readonly {
    readonly effortIntervalId: string;
    readonly progress: Progress;
  }[];
}

type Side = "cost" | "tokens";

export type BudgetCheck =
  | { readonly result: "send"; readonly budget: CallBudget }
  | {
      readonly result: "budget_reached";
      readonly budget: CallBudget;
      readonly exceeded: readonly Side[];
    }
  | {
      readonly result: "cannot_check";
      readonly budget: CallBudget;
      readonly unknown: readonly Side[];
      /** The calls whose unknown parts stop the check, by `modelCallId`, in log order. */
      readonly calls: readonly string[];
    };

export interface BudgetEstimate {
  /** The §3.6 estimate for the call about to be sent, in USD. */
  readonly cost: Known<number>;
  readonly tokens: Known<number>;
}

export type EffortTotal =
  | { readonly state: "known"; readonly value: number }
  | {
      readonly state: "lower_bound";
      readonly value: number;
      readonly interruptedIntervals: number;
      readonly inProgressIntervals: number;
    };

export interface ActiveEffort {
  /** Milliseconds, from the intervals (method `awaiting_user_intervals`). */
  readonly measured: EffortTotal;
  /** The developer's current correction, if any; reported beside `measured` (§2.13). */
  readonly correction?: RecordOf<"effort_correction">;
}

/** The latest revision of each lineage of `type`, in the log order of the lineage's start. */
function latestByLineage<T extends ModelCallRecord | EffortIntervalRecord>(
  records: readonly SessionRecord[],
  type: T["type"],
  lineage: (record: T) => string,
): T[] {
  const latest = new Map<string, T>();
  for (const record of records)
    if (record.type === type) latest.set(lineage(record as T), record as T);
  return [...latest.values()];
}

const calls = (records: readonly SessionRecord[]) =>
  latestByLineage<ModelCallRecord>(records, "model_call", (r) => r.modelCallId);
const intervals = (records: readonly SessionRecord[]) =>
  latestByLineage<EffortIntervalRecord>(records, "effort_interval", (r) => r.effortIntervalId);

// --- Interruption -----------------------------------------------------------------------------

const unknownBecauseInterrupted = { state: "unknown", reason: INTERRUPTED } as const;

/**
 * The interrupted-work rules for the process holding the lock (§4.9), after apply recovery
 * (`recoverInterruptedApply`, DM §11.2):
 * interrupted model calls, then effort intervals, then a `session_state` with the reason
 * `interrupted` if the last state was `running`. Returns the records appended.
 */
export function recoverInterruptedWork(log: SessionLog): readonly SessionRecord[] {
  const appended: SessionRecord[] = [];
  for (const call of calls(log.records))
    if (call.state === "started")
      appended.push(
        log.revise("model_call", call.modelCallId, {
          state: "interrupted",
          returnedModel: unknownBecauseInterrupted,
          retainedResponseRef: null,
          usage: {
            input: unknownBecauseInterrupted,
            output: unknownBecauseInterrupted,
            cacheRead: unknownBecauseInterrupted,
            cacheWrite: unknownBecauseInterrupted,
          },
          cost: unknownBecauseInterrupted,
          validationEvents: [],
          counts: {
            proposed: unknownBecauseInterrupted,
            accepted: 0,
            corrected: 0,
            relabelled: 0,
            rejectedByRule: {},
          },
          endedAt: unknownBecauseInterrupted,
          durationMs: unknownBecauseInterrupted,
        } as Changes<"model_call">),
      );
  for (const interval of intervals(log.records))
    if (interval.state === "open")
      appended.push(
        log.revise("effort_interval", interval.effortIntervalId, {
          state: "closed",
          leftAt: unknownBecauseInterrupted,
        } as Changes<"effort_interval">),
      );
  const state = log.records.filter((r) => r.type === "session_state").at(-1);
  if (state?.status === "running")
    appended.push(
      log.revise("session_state", "session_state", {
        // Ready to continue from the same stage.
        status: "ready",
        reason: INTERRUPTED,
        unsentPurpose: undefined,
      }),
    );
  return appended;
}

/**
 * What a read-only command shows for a call still `started` or an interval still `open`: in
 * progress while a live process holds the lock, interrupted otherwise. Writes nothing.
 */
export function unfinishedWork(
  records: readonly SessionRecord[],
  options: { readonly lockedByLiveProcess: boolean },
): UnfinishedWork {
  const progress: Progress = options.lockedByLiveProcess ? "in_progress" : "interrupted";
  return {
    calls: calls(records)
      .filter((call) => call.state === "started")
      .map((call) => ({ modelCallId: call.modelCallId, progress })),
    intervals: intervals(records)
      .filter((interval) => interval.state === "open")
      .map((interval) => ({ effortIntervalId: interval.effortIntervalId, progress })),
  };
}

// --- Budget -----------------------------------------------------------------------------------

interface Spend {
  readonly total: Total;
  readonly knownPartsSum: number;
  /** Calls with an unknown part that no budget revision has settled. */
  readonly unsettled: readonly string[];
}

function spend(
  /** Each call's known part, and whether that is all of it. */
  parts: readonly {
    readonly call: ModelCallRecord;
    readonly known: number;
    readonly complete: boolean;
  }[],
  startSeq: ReadonlyMap<string, number>,
  settledBefore: number,
  what: string,
): Spend {
  let sum = 0;
  const unknownCalls: string[] = [];
  const unsettled: string[] = [];
  for (const { call, known, complete } of parts) {
    sum += known;
    if (!complete) {
      unknownCalls.push(call.modelCallId);
      if ((startSeq.get(call.modelCallId) ?? call.seq) > settledBefore)
        unsettled.push(call.modelCallId);
    }
  }
  const total: Total =
    unknownCalls.length === 0
      ? { state: "known", value: sum }
      : {
          state: "unknown",
          reason: `${what} unknown for ${unknownCalls.join(", ")}`,
          knownPartsSum: sum,
        };
  return { total, knownPartsSum: sum, unsettled };
}

function costOf(call: ModelCallRecord): number | undefined {
  if (call.state !== "started" && call.cost.state === "known") return call.cost.value.amount;
  // Used for the budget only, never reported as the call's cost.
  return call.estimatedCost.state === "known" ? call.estimatedCost.value : undefined;
}

/** Tokens: the four usage counts, and whether every one is known. */
function tokensOf(call: ModelCallRecord): { readonly known: number; readonly complete: boolean } {
  if (call.state === "started") return { known: 0, complete: false };
  let known = 0;
  let complete = true;
  for (const part of Object.values(call.usage)) {
    if (part.state === "known") known += part.value;
    else complete = false;
  }
  return { known, complete };
}

/** The revisions that settle earlier unknowns: a raise or a confirmation (§4.6). */
export const BUDGET_SETTLING_REASONS: ReadonlySet<string> = new Set([
  "budget_raised",
  "budget_confirmed",
]);

/**
 * The §3.6 check before sending a call, with the spend counted as §4.6 says. `budget` is what
 * the call records as its `CallBudget`.
 */
export function checkBudget(
  records: readonly SessionRecord[],
  estimate: BudgetEstimate,
): BudgetCheck {
  const configs = records.filter((r) => r.type === "generation_config");
  const config = configs.at(-1);
  if (config === undefined) throw new Error("no generation_config to check the budget against");
  // A raise or a confirmation settles every unknown before it.
  const settledBefore =
    configs.filter((c) => c.reason !== undefined && BUDGET_SETTLING_REASONS.has(c.reason)).at(-1)
      ?.seq ?? 0;

  const latest = calls(records);
  /** Each call's `started` revision, by `modelCallId`. */
  const starts = new Map(
    records.flatMap((r) =>
      r.type === "model_call" && r.state === "started" ? [[r.modelCallId, r.seq] as const] : [],
    ),
  );
  const lastStart = Math.max(0, ...starts.values());

  const cost = spend(
    latest.map((call) => {
      const value = costOf(call);
      return { call, known: value ?? 0, complete: value !== undefined };
    }),
    starts,
    settledBefore,
    "cost and estimate",
  );
  const tokens = spend(
    latest.map((call) => ({ call, ...tokensOf(call) })),
    starts,
    settledBefore,
    "token usage",
  );
  const { maxTokens, maxCostUsd } = config.budget;
  const budget: CallBudget = {
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    spentCostUsd: cost.total,
    spentTokens: tokens.total,
  };

  // The next call may be sent with an unknown estimate only after a revision that follows
  // every call started so far.
  const ownEstimateSettled = settledBefore > lastStart;
  const sides: { side: Side; max: number | undefined; spent: Spend; next: Known<number> }[] = [
    { side: "cost", max: maxCostUsd, spent: cost, next: estimate.cost },
    { side: "tokens", max: maxTokens, spent: tokens, next: estimate.tokens },
  ];
  const unknownSides: Side[] = [];
  const blocking = new Set<string>();
  const exceeded: Side[] = [];
  for (const { side, max, spent, next } of sides) {
    if (max === undefined) continue;
    const unsettled = spent.unsettled.length > 0;
    const nextUnknown = next.state === "unknown" && !ownEstimateSettled;
    if (unsettled || nextUnknown) {
      unknownSides.push(side);
      for (const id of spent.unsettled) blocking.add(id);
      continue;
    }
    const nextValue = next.state === "known" ? next.value : 0;
    if (spent.knownPartsSum + nextValue > max) exceeded.push(side);
  }
  if (unknownSides.length > 0)
    return {
      result: "cannot_check",
      budget,
      unknown: unknownSides,
      calls: latest.map((c) => c.modelCallId).filter((id) => blocking.has(id)),
    };
  if (exceeded.length > 0) return { result: "budget_reached", budget, exceeded };
  return { result: "send", budget };
}

// --- Effort -----------------------------------------------------------------------------------

/**
 * Active effort: the sum of the closed intervals. An interval closed on resume (`leftAt`
 * unknown), or one still open, makes it a lower bound: open ones are in progress while a live
 * process holds the lock, and interrupted otherwise.
 */
export function activeEffort(
  records: readonly SessionRecord[],
  options: { readonly lockedByLiveProcess: boolean },
): ActiveEffort {
  let value = 0;
  let interruptedIntervals = 0;
  let inProgressIntervals = 0;
  for (const interval of intervals(records)) {
    if (interval.state === "open") {
      if (options.lockedByLiveProcess) inProgressIntervals += 1;
      else interruptedIntervals += 1;
    } else if (interval.leftAt.state === "unknown") interruptedIntervals += 1;
    else value += Date.parse(interval.leftAt.value) - Date.parse(interval.enteredAt);
  }
  const measured: EffortTotal =
    interruptedIntervals + inProgressIntervals === 0
      ? { state: "known", value }
      : { state: "lower_bound", value, interruptedIntervals, inProgressIntervals };

  const corrections = records.filter((r) => r.type === "effort_correction");
  const superseded = new Set(corrections.flatMap((c) => c.supersedes ?? []));
  const correction = corrections.filter((c) => !superseded.has(c.id)).at(-1);
  return correction === undefined ? { measured } : { measured, correction };
}
