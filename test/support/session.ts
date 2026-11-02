import type { Clock, IdSource } from "../../src/core/ports.js";
import { type Changes, type LineageStart, SessionLog } from "../../src/core/session/log.js";

// Deterministic ports for session tests: IDs count up per prefix, and the clock ticks one
// second per reading, so every record's ID and `createdAt` are predictable.

export function countingIds(): IdSource {
  const counts = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      return `${prefix}_${String(n).padStart(4, "0")}`;
    },
  };
}

export function tickingClock(start = Date.UTC(2026, 10, 1, 10, 15, 0)): Clock {
  let now = start;
  return {
    now() {
      const date = new Date(now);
      now += 1000;
      return date;
    },
  };
}

export function newLog(): SessionLog {
  return new SessionLog({ clock: tickingClock(), ids: countingIds() });
}

export const hashOf = (byte: string) => `sha256:${byte.repeat(64 / byte.length)}` as const;

/** The first revision of a model call, valid in shape, with `overrides` applied. */
export function callDraft(
  overrides: Partial<LineageStart<"model_call">> = {},
): LineageStart<"model_call"> {
  return {
    type: "model_call",
    state: "started",
    purpose: "analyse",
    attempt: 1,
    requestedModel: "claude-test",
    promptVersion: "1.0.0",
    promptHash: hashOf("1"),
    schemaVersion: "1.0.0",
    schemaHash: hashOf("2"),
    validatorVersion: "validate/0.12.0",
    detectorVersion: "detect/0.1.0",
    inputManifest: {
      manifestVersion: 2,
      algorithmVersion: "context-select/1.7.0",
      secretRulesVersion: "secret-scan/1.1.0",
      declarationPatternsVersion: "declarations/1.0.0",
      settingsHash: hashOf("3"),
      snapshotId: "snap_0001",
      contextHash: hashOf("4"),
      retainedInputRef: null,
      budget: { initialContextBytes: 310000, usedBytes: 1000 },
      knownFacts: { capBytes: 10000, usedBytes: 40, facts: 0, leftOut: 0 },
      tokenCheck: null,
      tiers: [{ tier: 4, capBytes: 20000, usedBytes: 300, treeDepth: 3 }],
      items: [],
      skipped: [],
      excluded: [],
      ignoreRules: { state: "applied" },
      ignored: [],
      expansion: null,
    },
    retainedInputRef: null,
    aliases: { call: "analyse", entries: [] },
    budget: {
      spentCostUsd: { state: "known", value: 0 },
      spentTokens: { state: "known", value: 0 },
    },
    estimatedCost: { state: "known", value: 0.5 },
    startedAt: "2026-11-01T10:16:00.000Z",
    ...overrides,
  } as LineageStart<"model_call">;
}

/** What a completed call adds, with known usage and cost. */
export function completedCall(
  overrides: Partial<Changes<"model_call">> = {},
): Changes<"model_call"> {
  return {
    state: "completed",
    returnedModel: { state: "known", value: "claude-test-1" },
    retainedResponseRef: null,
    usage: {
      input: { state: "known", value: 1000 },
      output: { state: "known", value: 200 },
      cacheRead: { state: "known", value: 0 },
      cacheWrite: { state: "known", value: 0 },
    },
    cost: { state: "known", value: { amount: 0.25, currency: "USD", basis: "reported" } },
    validationEvents: [],
    counts: {
      proposed: { state: "known", value: 0 },
      accepted: 0,
      corrected: 0,
      relabelled: 0,
      rejectedByRule: {},
    },
    endedAt: { state: "known", value: "2026-11-01T10:16:30.000Z" },
    durationMs: { state: "known", value: 30000 },
    ...overrides,
  } as Changes<"model_call">;
}
