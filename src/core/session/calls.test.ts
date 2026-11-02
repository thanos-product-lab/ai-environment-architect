import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  callDraft,
  completedCall,
  countingIds,
  hashOf,
  newLog,
  tickingClock,
} from "../../../test/support/session.js";
import type { InputManifest } from "../context/select.js";
import type { AliasTable } from "../validation/aliases.js";
import type { ValidationEvent } from "../validation/pipeline.js";
import { activeEffort, checkBudget, recoverInterruptedWork, unfinishedWork } from "./calls.js";
import { type DeepReadonly, SessionLog } from "./log.js";
import {
  type aliasTable,
  type inputManifest,
  sessionRecord,
  type validationEvent,
} from "./records.js";

// Model calls and effort (IMPL §4.6, §4.11; DM §13).

function withConfig(
  budget: { maxTokens?: number; maxCostUsd?: number } = {},
  log = newLog(),
): SessionLog {
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  log.start({
    type: "generation_config",
    settings: {
      snapshot: { maxReadableFileBytes: 1, userExclusions: [], includeIgnored: [] },
      context: {
        initialContextBytes: 1,
        knownFactsBytes: 1,
        tierCaps: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0 },
        maxDestinationBytes: 0,
        perFileCaps: { tier2: 0, tier3: 0, tier5: 0 },
        testReserveBytes: 0,
        testExampleBytes: 0,
        maxSourceFiles: 0,
        sourceExtensions: [],
        treeDepth: 0,
        treeCollapseThreshold: 0,
      },
    },
    settingsHash: hashOf("9"),
    requestedModel: "claude-test",
    budget,
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    retainModelInputs: true,
  });
  return log;
}

const known = <T>(value: T) => ({ state: "known" as const, value });
const unknown = (reason: string) => ({ state: "unknown" as const, reason });

describe("model-call records (IMPL §4.6)", () => {
  it("writes started as revision 1 and the end as revision 2, superseding it and repeating its fields", () => {
    const log = newLog();
    const started = log.start(callDraft());
    const ended = log.revise("model_call", started.modelCallId, completedCall());
    expect(started).toMatchObject({ id: "callr_0001", modelCallId: "call_0001", revision: 1 });
    expect(ended).toMatchObject({
      revision: 2,
      supersedes: [started.id],
      state: "completed",
      purpose: started.purpose,
      inputManifest: started.inputManifest,
      estimatedCost: started.estimatedCost,
    });
  });

  it("allows no third revision", () => {
    const log = newLog();
    const started = log.start(callDraft());
    log.revise("model_call", started.modelCallId, completedCall());
    expect(() =>
      log.revise("model_call", started.modelCallId, completedCall({ state: "failed" })),
    ).toThrow(/invalid model_call record/);
  });

  it("refuses an ended state on revision 1 and started on revision 2", () => {
    const log = newLog();
    expect(() => log.start({ ...callDraft(), ...completedCall() } as never)).toThrow();
    const started = log.start(callDraft());
    expect(() =>
      log.revise("model_call", started.modelCallId, { state: "started" } as never),
    ).toThrow();
  });

  it("makes every send its own call: transport, schema and fresh retries each start a lineage linked by retryOf", () => {
    const log = newLog();
    const first = log.start(callDraft());
    log.revise("model_call", first.modelCallId, completedCall({ state: "failed" }));
    const second = log.start(callDraft({ attempt: 2, retryOf: first.modelCallId }));
    log.revise("model_call", second.modelCallId, completedCall({ state: "failed" }));
    const third = log.start(callDraft({ attempt: 3, retryOf: second.modelCallId }));
    expect(new Set([first, second, third].map((c) => c.modelCallId)).size).toBe(3);
    expect(third.retryOf).toBe(second.modelCallId);
  });

  it("sets retryOf exactly when attempt is after the first", () => {
    const log = newLog();
    expect(() => log.start(callDraft({ attempt: 2 }))).toThrow(/retryOf/);
    expect(() => log.start(callDraft({ attempt: 1, retryOf: "call_0009" }))).toThrow(/retryOf/);
  });

  it("records citation counts only on analyse and analyse_expansion, and questionOrder only on generate_questions", () => {
    const log = newLog();
    const analyse = log.start(callDraft());
    expect(() =>
      log.revise(
        "model_call",
        analyse.modelCallId,
        completedCall({
          correctedCitationRate: { state: "known", corrected: 1, checked: 4, rate: 0.25 },
          citationsProposed: { state: "known", count: 4 },
        }),
      ),
    ).not.toThrow();
    const questions = log.start(
      callDraft({
        purpose: "generate_questions",
        aliases: { call: "generate_questions", entries: [] },
      }),
    );
    expect(() =>
      log.revise(
        "model_call",
        questions.modelCallId,
        completedCall({ citationsProposed: { state: "known", count: 1 } }),
      ),
    ).toThrow(/citation/);
    const other = log.start(callDraft());
    expect(() =>
      log.revise("model_call", other.modelCallId, completedCall({ questionOrder: ["q1"] })),
    ).toThrow(/questionOrder/);
  });

  it("rejects a cost or usage written as zero-like null instead of unknown", () => {
    const log = newLog();
    const started = log.start(callDraft());
    expect(() =>
      log.revise("model_call", started.modelCallId, completedCall({ cost: null } as never)),
    ).toThrow();
    expect(
      sessionRecord.safeParse({ ...started, estimatedCost: { state: "unknown" } }).success,
    ).toBe(false);
  });

  it("stores the pipeline's alias tables, validation events and the selection's input manifest as they are", () => {
    type Stored<S extends z.ZodType> = DeepReadonly<z.infer<S>>;
    const manifest = {} as InputManifest;
    const table = {} as AliasTable;
    const event = {} as ValidationEvent;
    const a: Stored<typeof inputManifest> = manifest;
    const b: Stored<typeof aliasTable> = table;
    const c: Stored<typeof validationEvent> = event;
    expect([a, b, c]).toHaveLength(3);
  });
});

describe("interrupted work (IMPL §4.6, §4.9)", () => {
  it("ends a started call as interrupted, with end, usage, cost and proposed unknown, never zero", () => {
    const log = withConfig();
    const call = log.start(callDraft());
    recoverInterruptedWork(log);
    const ended = log.revisions("model_call", call.modelCallId).at(-1);
    const why = unknown("interrupted");
    expect(ended).toMatchObject({
      revision: 2,
      state: "interrupted",
      endedAt: why,
      durationMs: why,
      returnedModel: why,
      usage: { input: why, output: why, cacheRead: why, cacheWrite: why },
      cost: why,
      counts: { proposed: why, accepted: 0 },
      retainedResponseRef: null,
    });
  });

  it("closes an open effort interval with leftAt unknown, reason interrupted", () => {
    const log = withConfig();
    const interval = log.start({
      type: "effort_interval",
      state: "open",
      stage: "clarify",
      enteredAt: "2026-11-01T10:20:00.000Z",
    });
    recoverInterruptedWork(log);
    expect(log.revisions("effort_interval", interval.effortIntervalId).at(-1)).toMatchObject({
      revision: 2,
      state: "closed",
      leftAt: unknown("interrupted"),
    });
  });

  it("then appends a session_state with reason interrupted when the last state was running, in that order", () => {
    const log = withConfig();
    log.start(callDraft());
    log.start({
      type: "effort_interval",
      state: "open",
      stage: "clarify",
      enteredAt: "2026-11-01T10:20:00.000Z",
    });
    const appended = recoverInterruptedWork(log);
    expect(appended.map((r) => r.type)).toEqual(["model_call", "effort_interval", "session_state"]);
    expect(appended.at(-1)).toMatchObject({ reason: "interrupted", stage: "inspect" });
  });

  it("leaves finished work and a state that isn't running alone", () => {
    const log = withConfig();
    const call = log.start(callDraft());
    log.revise("model_call", call.modelCallId, completedCall());
    log.revise("session_state", "session_state", { status: "awaiting_user" });
    expect(recoverInterruptedWork(log)).toEqual([]);
  });

  it("clears a budget_reached state's unsent purpose when it records the interruption", () => {
    const log = withConfig();
    log.revise("session_state", "session_state", {
      reason: "budget_reached",
      unsentPurpose: "recommend",
    });
    const [state] = recoverInterruptedWork(log);
    expect(state).toMatchObject({ reason: "interrupted" });
    expect(state).not.toHaveProperty("unsentPurpose");
  });
});

describe("read-only view of unfinished work (IMPL §4.6)", () => {
  function unfinished() {
    const log = withConfig();
    const call = log.start(callDraft());
    const interval = log.start({
      type: "effort_interval",
      state: "open",
      stage: "clarify",
      enteredAt: "2026-11-01T10:20:00.000Z",
    });
    return { log, call, interval };
  }

  it("shows a started call and open interval as in progress while a live process holds the lock", () => {
    const { log, call, interval } = unfinished();
    expect(unfinishedWork(log.records, { lockedByLiveProcess: true })).toEqual({
      calls: [{ modelCallId: call.modelCallId, progress: "in_progress" }],
      intervals: [{ effortIntervalId: interval.effortIntervalId, progress: "in_progress" }],
    });
  });

  it("shows them as interrupted otherwise, and writes nothing", () => {
    const { log, call, interval } = unfinished();
    const before = log.records.length;
    expect(unfinishedWork(log.records, { lockedByLiveProcess: false })).toEqual({
      calls: [{ modelCallId: call.modelCallId, progress: "interrupted" }],
      intervals: [{ effortIntervalId: interval.effortIntervalId, progress: "interrupted" }],
    });
    expect(log.records).toHaveLength(before);
  });
});

describe("the budget with unknown costs (IMPL §4.6, §3.6)", () => {
  const estimate = { cost: known(0.5), tokens: known(1000) };

  it("sums known costs and, for an interrupted call, its estimatedCost, which is never reported as its cost", () => {
    const log = withConfig({ maxCostUsd: 10 });
    const a = log.start(callDraft({ estimatedCost: known(0.4) }));
    log.revise("model_call", a.modelCallId, completedCall());
    log.start(callDraft({ estimatedCost: known(0.7) }));
    recoverInterruptedWork(log);
    const check = checkBudget(log.records, estimate);
    expect(check.budget.spentCostUsd).toEqual(known(0.25 + 0.7));
    expect(check.result).toBe("send");
    const interrupted = log.records.filter((r) => r.type === "model_call").at(-1);
    expect(interrupted).toMatchObject({ cost: unknown("interrupted") });
  });

  it("stops a call whose estimate would pass the cost ceiling", () => {
    const log = withConfig({ maxCostUsd: 1 });
    const a = log.start(callDraft());
    log.revise("model_call", a.modelCallId, completedCall());
    expect(checkBudget(log.records, { cost: known(0.8), tokens: known(0) })).toMatchObject({
      result: "budget_reached",
      exceeded: ["cost"],
    });
  });

  it("can't check when a call's cost and estimate are both unknown, and names the call", () => {
    const log = withConfig({ maxCostUsd: 10 });
    const a = log.start(callDraft({ estimatedCost: unknown("no_price") }));
    recoverInterruptedWork(log);
    const check = checkBudget(log.records, estimate);
    expect(check).toMatchObject({
      result: "cannot_check",
      unknown: ["cost"],
      calls: [a.modelCallId],
    });
    expect(check.budget.spentCostUsd).toMatchObject({ state: "unknown", knownPartsSum: 0 });
  });

  it("can't check tokens when a call's usage is unknown", () => {
    const log = withConfig({ maxTokens: 100000 });
    const a = log.start(callDraft());
    recoverInterruptedWork(log);
    expect(checkBudget(log.records, estimate)).toMatchObject({
      result: "cannot_check",
      unknown: ["tokens"],
      calls: [a.modelCallId],
    });
  });

  it("counts all four usage counts as tokens, and stops at the token ceiling", () => {
    const log = withConfig({ maxTokens: 2000 });
    const a = log.start(callDraft());
    log.revise(
      "model_call",
      a.modelCallId,
      completedCall({
        usage: {
          input: known(500),
          output: known(100),
          cacheRead: known(200),
          cacheWrite: known(50),
        },
      }),
    );
    const check = checkBudget(log.records, { cost: known(0), tokens: known(1200) });
    expect(check.budget.spentTokens).toEqual(known(850));
    expect(check).toMatchObject({ result: "budget_reached", exceeded: ["tokens"] });
  });

  it("never checks a ceiling that isn't set", () => {
    const log = withConfig();
    log.start(callDraft({ estimatedCost: unknown("no_price") }));
    recoverInterruptedWork(log);
    expect(
      checkBudget(log.records, { cost: unknown("no_price"), tokens: unknown("no_count") }),
    ).toMatchObject({ result: "send" });
  });

  it("records the limits in force in the call budget", () => {
    const log = withConfig({ maxTokens: 5000, maxCostUsd: 2 });
    expect(checkBudget(log.records, estimate).budget).toMatchObject({
      maxTokens: 5000,
      maxCostUsd: 2,
    });
  });

  it("a budget_confirmed revision settles the unknowns before it, counting their known parts only", () => {
    const log = withConfig({ maxCostUsd: 10, maxTokens: 100000 });
    log.start(callDraft({ estimatedCost: unknown("no_price") }));
    recoverInterruptedWork(log);
    log.revise("generation_config", "generation_config", { reason: "budget_confirmed" });
    const check = checkBudget(log.records, { cost: unknown("no_price"), tokens: known(10) });
    expect(check.result).toBe("send");
    // The total itself stays unknown: settling isn't knowing.
    expect(check.budget.spentCostUsd).toMatchObject({ state: "unknown", knownPartsSum: 0 });
  });

  it("raising the budget settles them too", () => {
    const log = withConfig({ maxCostUsd: 1 });
    log.start(callDraft({ estimatedCost: unknown("no_price") }));
    recoverInterruptedWork(log);
    log.revise("generation_config", "generation_config", {
      reason: "budget_raised",
      budget: { maxCostUsd: 5 },
    });
    expect(checkBudget(log.records, estimate)).toMatchObject({
      result: "send",
      budget: { maxCostUsd: 5 },
    });
  });

  it("a call started after the confirmation makes the check impossible again", () => {
    const log = withConfig({ maxCostUsd: 10 });
    log.start(callDraft({ estimatedCost: unknown("no_price") }));
    recoverInterruptedWork(log);
    log.revise("generation_config", "generation_config", { reason: "budget_confirmed" });
    const later = log.start(callDraft({ estimatedCost: unknown("no_price") }));
    recoverInterruptedWork(log);
    expect(checkBudget(log.records, estimate)).toMatchObject({
      result: "cannot_check",
      calls: [later.modelCallId],
    });
  });

  it("can't check a call whose own estimate is unknown until the budget is confirmed", () => {
    const log = withConfig({ maxCostUsd: 10 });
    expect(checkBudget(log.records, { cost: unknown("no_price"), tokens: known(1) })).toMatchObject(
      {
        result: "cannot_check",
        unknown: ["cost"],
        calls: [],
      },
    );
    log.revise("generation_config", "generation_config", { reason: "budget_confirmed" });
    expect(checkBudget(log.records, { cost: unknown("no_price"), tokens: known(1) }).result).toBe(
      "send",
    );
  });
});

describe("the budget: review fixes (IMPL §4.6)", () => {
  it("a settled call with partly known usage counts its known parts", () => {
    const log = withConfig({ maxTokens: 100000 });
    const a = log.start(callDraft());
    log.revise(
      "model_call",
      a.modelCallId,
      completedCall({
        state: "failed",
        usage: {
          input: known(90000),
          output: unknown("not_reported"),
          cacheRead: known(0),
          cacheWrite: known(0),
        },
      }),
    );
    expect(checkBudget(log.records, { cost: known(0), tokens: known(1) }).result).toBe(
      "cannot_check",
    );
    log.revise("generation_config", "generation_config", { reason: "budget_confirmed" });
    const check = checkBudget(log.records, { cost: known(0), tokens: known(20000) });
    expect(check.budget.spentTokens).toMatchObject({ state: "unknown", knownPartsSum: 90000 });
    expect(check).toMatchObject({ result: "budget_reached", exceeded: ["tokens"] });
  });

  it("a generation_config revision is a raise or a confirmation, never another reason", () => {
    const log = withConfig({ maxCostUsd: 10 });
    expect(() =>
      log.revise("generation_config", "generation_config", {
        reason: "budget_lowered",
        budget: { maxCostUsd: 5 },
      } as never),
    ).toThrow(/invalid generation_config record/);
  });
});

describe("record shape: review fixes (IMPL §4.6)", () => {
  it("refuses an interrupted call with a known end, duration, usage or cost", () => {
    for (const changes of [
      { endedAt: known("2026-11-01T10:16:30.000Z") },
      { durationMs: known(0) },
      { cost: known({ amount: 0, currency: "USD", basis: "estimated" }) },
      { usage: { input: known(0), output: known(0), cacheRead: known(0), cacheWrite: known(0) } },
    ]) {
      const log = newLog();
      const call = log.start(callDraft());
      const why = unknown("interrupted");
      expect(() =>
        log.revise(
          "model_call",
          call.modelCallId,
          completedCall({
            state: "interrupted",
            endedAt: why,
            durationMs: why,
            cost: why,
            usage: { input: why, output: why, cacheRead: why, cacheWrite: why },
            ...changes,
          } as never),
        ),
      ).toThrow(/interrupted/);
    }
  });

  it("refuses an interval that ends before it starts", () => {
    const log = newLog();
    const open = log.start({
      type: "effort_interval",
      state: "open",
      stage: "clarify",
      enteredAt: "2026-11-01T10:20:00.000Z",
    });
    expect(() =>
      log.revise("effort_interval", open.effortIntervalId, {
        state: "closed",
        leftAt: known("2026-11-01T10:19:59.999Z"),
      }),
    ).toThrow(/leftAt/);
  });

  it("refuses a manifest skipped entry with a field the manifest doesn't define", () => {
    const log = newLog();
    const draft = callDraft();
    expect(() =>
      log.start({
        ...draft,
        inputManifest: {
          ...draft.inputManifest,
          skipped: [{ path: "a.md", reason: "tier2:cap-reached", content: "x" }],
        },
      } as never),
    ).toThrow();
  });
});

describe("active effort (IMPL §4.6, §2.13)", () => {
  function interval(log: SessionLog, enteredAt: string, leftAt?: string) {
    const open = log.start({ type: "effort_interval", state: "open", stage: "clarify", enteredAt });
    if (leftAt !== undefined)
      log.revise("effort_interval", open.effortIntervalId, {
        state: "closed",
        leftAt: known(leftAt),
      });
    return open;
  }

  it("is the sum of the closed intervals", () => {
    const log = withConfig();
    interval(log, "2026-11-01T10:20:00.000Z", "2026-11-01T10:21:00.000Z");
    interval(log, "2026-11-01T10:30:00.000Z", "2026-11-01T10:30:30.500Z");
    expect(activeEffort(log.records, { lockedByLiveProcess: false }).measured).toEqual({
      state: "known",
      value: 90500,
    });
  });

  it("is a lower bound, never unknown or zero, when an interval was interrupted", () => {
    const log = withConfig();
    interval(log, "2026-11-01T10:20:00.000Z", "2026-11-01T10:21:00.000Z");
    interval(log, "2026-11-01T10:30:00.000Z");
    recoverInterruptedWork(log);
    expect(activeEffort(log.records, { lockedByLiveProcess: false }).measured).toEqual({
      state: "lower_bound",
      value: 60000,
      interruptedIntervals: 1,
      inProgressIntervals: 0,
    });
  });

  it("read-only: an open interval is interrupted without a live holder, in progress with one", () => {
    const log = withConfig();
    interval(log, "2026-11-01T10:30:00.000Z");
    expect(activeEffort(log.records, { lockedByLiveProcess: false }).measured).toEqual({
      state: "lower_bound",
      value: 0,
      interruptedIntervals: 1,
      inProgressIntervals: 0,
    });
    expect(activeEffort(log.records, { lockedByLiveProcess: true }).measured).toEqual({
      state: "lower_bound",
      value: 0,
      interruptedIntervals: 0,
      inProgressIntervals: 1,
    });
  });

  it("reports the current correction beside the measured value; a later one supersedes it", () => {
    const log = withConfig();
    interval(log, "2026-11-01T10:20:00.000Z", "2026-11-01T10:21:00.000Z");
    const first = log.append({ type: "effort_correction", totalMs: 120000, reason: "Lunch." });
    log.append({
      type: "effort_correction",
      totalMs: 90000,
      reason: "Shorter lunch.",
      supersedes: [first.id],
    });
    const effort = activeEffort(log.records, { lockedByLiveProcess: false });
    expect(effort.measured).toEqual({ state: "known", value: 60000 });
    expect(effort.correction).toMatchObject({ totalMs: 90000, reason: "Shorter lunch." });
  });

  it("refuses closing an interval as revision 1, and a third revision", () => {
    const log = new SessionLog({ clock: tickingClock(), ids: countingIds() });
    expect(() =>
      log.start({
        type: "effort_interval",
        state: "closed",
        stage: "clarify",
        enteredAt: "2026-11-01T10:20:00.000Z",
        leftAt: known("2026-11-01T10:21:00.000Z"),
      } as never),
    ).toThrow();
    const open = interval(log, "2026-11-01T10:20:00.000Z", "2026-11-01T10:21:00.000Z");
    expect(() =>
      log.revise("effort_interval", open.effortIntervalId, {
        leftAt: known("2026-11-01T10:22:00.000Z"),
      }),
    ).toThrow();
  });
});
