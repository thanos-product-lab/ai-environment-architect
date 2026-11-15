import { describe, expect, it } from "vitest";
import { MemorySession } from "../../../test/support/memory-store.js";
import { callDraft, hashOf, newLog, TEST_SETTINGS } from "../../../test/support/session.js";
import type { Clock } from "../ports.js";
import type { ModelRequest, SendResult } from "../request.js";
import type { CallPurpose } from "../validation/aliases.js";
import type { ValidationResult } from "../validation/pipeline.js";
import type { PriceTable } from "./cost.js";
import { checkBeforeSend } from "./cost.js";
import type { SessionLog } from "./log.js";
import {
  type RecordOf,
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
} from "./records.js";
import { retainedFile } from "./retained.js";
import {
  BACKOFF_MS,
  type CallPlan,
  freshRetry,
  MAX_RETRY_AFTER_MS,
  type ModelSender,
  runCall,
  type SendDeps,
  schemaRetryMessage,
} from "./send.js";
import { HeldSession } from "./store.js";

// The retry and failure policy (IMPL §3.6), with the recording of every send (§4.6, §4.8). A
// fake sender answers from a script, the clock and the waits are injected, and no model is
// called.

const TABLE: PriceTable = {
  version: "prices/test",
  date: "2026-11-15",
  models: { "claude-test": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.5 } },
};

const HEADER: Omit<SessionFile, "records"> = {
  format: SESSION_FORMAT,
  schemaVersion: SESSION_SCHEMA_VERSION,
  writtenBy: "0.1.0",
  session: {
    id: "ses_0001",
    createdAt: "2026-11-01T10:15:00.000Z",
    productVersion: "0.1.0",
    adapter: "claude-code",
    outputScope: ["root CLAUDE.md"],
    repository: { name: "kutt", root: "/r/kutt" },
    targetPath: "CLAUDE.md",
  },
};

const encode = (text: string) => new TextEncoder().encode(text);
/** A value the secret scan matches (`aws-access-key-id`), from the scan's own fixtures. */
const SECRET = "AKIAIOSFODNN7EXAMPLE";
const known = <T>(value: T) => ({ state: "known" as const, value });

function baseLog(
  options: { budget?: { maxTokens?: number; maxCostUsd?: number }; retain?: boolean } = {},
): SessionLog {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [],
      destination: { state: "absent" },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    },
    { id: "snap_0001" },
  );
  log.start({
    type: "generation_config",
    settings: TEST_SETTINGS,
    settingsHash: hashOf("9"),
    requestedModel: "claude-test",
    effort: "medium",
    budget: options.budget ?? {},
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    retainModelInputs: options.retain ?? true,
  });
  return log;
}

const REQUEST: ModelRequest = {
  model: "claude-test",
  maxTokens: 1000,
  effort: "medium",
  system: "system prompt",
  user: "user content",
  schema: { type: "object" },
};

const INPUT_TOKENS = 2000;
/** The estimate of one send of `REQUEST`: 2000 input at 4, 1000 output at 20, per million. */
const ESTIMATE = (INPUT_TOKENS * 4 + 1000 * 20) / 1_000_000;

const bytesOf = (request: ModelRequest) => encode(JSON.stringify(request));

type Answer = SendResult | ((request: ModelRequest) => SendResult);

/** A sender that answers from `script` in order, and records what it was asked to send. */
function scriptedSender(script: readonly Answer[], onSend?: () => void) {
  const sent: ModelRequest[] = [];
  const sender: ModelSender = {
    requestBytes: bytesOf,
    async send(request) {
      onSend?.();
      sent.push(request);
      const answer = script[sent.length - 1];
      if (answer === undefined) throw new Error(`no scripted answer for send ${sent.length}`);
      return typeof answer === "function" ? answer(request) : answer;
    },
  };
  return { sender, sent };
}

// --- Scripted answers ---------------------------------------------------------------------------

const USAGE = {
  input: known(2000),
  output: known(400),
  cacheRead: known(0),
  cacheWrite: known(0),
};

function message(
  request: ModelRequest,
  fields: {
    stopReason?: string | null;
    text?: readonly string[];
    other?: readonly string[];
    refusalCategory?: string;
  } = {},
): SendResult {
  const text = fields.text ?? ["{}"];
  return {
    kind: "response",
    requestBytes: bytesOf(request),
    responseBytes: encode(JSON.stringify({ text })),
    message: {
      returnedModel: "claude-test",
      stopReason: fields.stopReason === undefined ? "end_turn" : fields.stopReason,
      ...(fields.refusalCategory === undefined ? {} : { refusalCategory: fields.refusalCategory }),
      textBlocks: text,
      otherBlocks: fields.other ?? [],
      usage: USAGE,
    },
  };
}

const ok =
  (text = "{}") =>
  (request: ModelRequest) =>
    message(request, { text: [text] });
const stopped = (stopReason: string | null, refusalCategory?: string) => (request: ModelRequest) =>
  message(request, { stopReason, ...(refusalCategory === undefined ? {} : { refusalCategory }) });
const http =
  (status: number, retryAfter?: string) =>
  (request: ModelRequest): SendResult => ({
    kind: "http_error",
    requestBytes: bytesOf(request),
    responseBytes: encode(`{"type":"error","status":${status}}`),
    status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
const transport =
  (kind: "connection" | "timeout") =>
  (request: ModelRequest): SendResult => ({ kind, requestBytes: bytesOf(request) });
const unreadable = (request: ModelRequest): SendResult => ({
  kind: "response",
  requestBytes: bytesOf(request),
  responseBytes: encode("not a message"),
  message: undefined,
});

// --- The validator the plan uses ---------------------------------------------------------------

/**
 * "{}" is accepted with one item; "BAD" fails the schema; "ALL_REJECTED" has two items, both
 * rejected. A stand-in for a call's validator, whose own rules have their own tests.
 */
function fakeValidate(text: string): ValidationResult<unknown, unknown> {
  const counts = (proposed: number, accepted: number, rejected: number) => ({
    proposed: { state: "known" as const, count: proposed },
    accepted,
    corrected: 0,
    relabelled: 0,
    rejectionsByRule: rejected === 0 ? [] : [{ rule: "CIT-004", count: rejected }],
  });
  if (text === "SECRET_BAD")
    return {
      status: "schema_failed",
      validatorVersion: "validate/test",
      // A path no real schema has, standing in for one that matches the secret scan.
      issues: [{ path: `questions.${SECRET}`, code: "invalid_type" }],
      events: [
        {
          itemKey: "$response",
          stage: "schema",
          rule: "SCHEMA",
          outcome: "rejected",
          detail: "questions.<key>: invalid_type",
        },
      ],
      counts: {
        proposed: { state: "unknown", reason: "schema_failed" },
        accepted: 0,
        corrected: 0,
        relabelled: 0,
        rejectionsByRule: [{ rule: "SCHEMA", count: 1 }],
      },
    };
  if (text === "BAD")
    return {
      status: "schema_failed",
      validatorVersion: "validate/test",
      issues: [
        { path: "questions.0.text", code: "invalid_type" },
        { path: "", code: "unrecognized_keys" },
      ],
      events: [
        {
          itemKey: "$response",
          stage: "schema",
          rule: "SCHEMA",
          outcome: "rejected",
          detail: "questions.0.text: invalid_type",
        },
        {
          itemKey: "$response",
          stage: "schema",
          rule: "SCHEMA",
          outcome: "rejected",
          detail: "(root): unrecognized_keys",
        },
      ],
      counts: {
        proposed: { state: "unknown", reason: "schema_failed" },
        accepted: 0,
        corrected: 0,
        relabelled: 0,
        rejectionsByRule: [{ rule: "SCHEMA", count: 2 }],
      },
    };
  const all = text === "ALL_REJECTED";
  const event = (itemKey: string) => ({
    itemKey,
    stage: "item" as const,
    rule: "CIT-004",
    outcome: "rejected" as const,
    detail: "quote not found",
  });
  return {
    status: "validated",
    validatorVersion: "validate/test",
    response: {},
    accepted: {},
    redirects: new Map(),
    rejected: [],
    events: all ? [event("q1"), event("q2")] : [],
    counts: all ? counts(2, 0, 2) : counts(1, 1, 0),
  };
}

function plan(
  purpose: CallPurpose = "generate_questions",
  validate: (text: string) => ValidationResult<unknown, unknown> = fakeValidate,
): CallPlan<ValidationResult<unknown, unknown>> {
  const {
    type: _t,
    state: _s,
    purpose: _p,
    attempt: _a,
    requestedModel: _m,
    priceTable: _pt,
    retainedInputRef: _r,
    budget: _b,
    estimatedCost: _e,
    estimatedTokens: _et,
    startedAt: _st,
    ...started
  } = callDraft({ aliases: { call: purpose, entries: [] } });
  return {
    purpose,
    request: REQUEST,
    inputTokens: INPUT_TOKENS,
    started,
    validate,
    resultOf: (validation) => validation,
  };
}

/** A clock that reads the wall time the waits have advanced, one second per reading. */
function testClock(): { clock: Clock; waits: number[]; sleep: (ms: number) => Promise<void> } {
  let now = Date.UTC(2026, 10, 1, 11, 0, 0);
  const waits: number[] = [];
  return {
    clock: {
      now() {
        const date = new Date(now);
        now += 1000;
        return date;
      },
    },
    waits,
    async sleep(ms) {
      waits.push(ms);
      now += ms;
    },
  };
}

async function setup(
  script: readonly Answer[],
  options: Parameters<typeof baseLog>[0] & { onSend?: (session: HeldSession) => void } = {},
) {
  const store = new MemorySession();
  const session = new HeldSession(store, HEADER, baseLog(options));
  await session.save();
  const { sender, sent } = scriptedSender(script, () => options.onSend?.(session));
  const time = testClock();
  const deps: SendDeps = { sender, prices: TABLE, clock: time.clock, sleep: time.sleep };
  return { store, session, sent, deps, waits: time.waits };
}

/** The latest revision of every model call, in the order they started. */
function calls(session: HeldSession): RecordOf<"model_call">[] {
  const latest = new Map<string, RecordOf<"model_call">>();
  for (const record of session.records)
    if (record.type === "model_call") latest.set(record.modelCallId, record);
  return [...latest.values()];
}

function ended(call: RecordOf<"model_call">) {
  if (call.state === "started") throw new Error(`${call.modelCallId} hasn't ended`);
  return call;
}

// --- Recording every send (§4.6) ---------------------------------------------------------------

describe("every send is its own model call (IMPL §3.6, §4.6)", () => {
  it("saves the started revision before the request is sent", async () => {
    const seen: (string | undefined)[] = [];
    const { session, deps } = await setup([ok()], {
      onSend: (s) => {
        const last = s.records.at(-1);
        seen.push(last?.type === "model_call" ? last.state : last?.type);
      },
    });
    await runCall(session, deps, plan());
    expect(seen).toEqual(["started"]);
  });

  it("numbers the sends of one step from 1, each retry naming the previous attempt", async () => {
    const { session, deps } = await setup([transport("connection"), http(503), ok()]);
    await runCall(session, deps, plan());
    const all = calls(session);
    expect(all.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(all.map((c) => c.retryOf)).toEqual([
      undefined,
      all[0]?.modelCallId,
      all[1]?.modelCallId,
    ]);
    expect(all.map((c) => c.state)).toEqual(["failed", "failed", "completed"]);
  });

  it("records the requested model, the price table, and the budget and estimate of checkBeforeSend", async () => {
    const { session, deps } = await setup([ok()], { budget: { maxCostUsd: 10 } });
    const before = checkBeforeSend(session.records, TABLE, {
      model: "claude-test",
      inputTokens: INPUT_TOKENS,
      reservedOutputTokens: 1000,
      cachesInput: false,
    });
    await runCall(session, deps, plan());
    const [call] = calls(session);
    expect(call).toMatchObject({
      requestedModel: "claude-test",
      purpose: "generate_questions",
      ...before.started,
    });
    expect(call?.estimatedCost).toEqual(known(ESTIMATE));
  });

  it("takes startedAt, endedAt and durationMs from the injected clock", async () => {
    const { session, deps } = await setup([ok()]);
    await runCall(session, deps, plan());
    const call = ended(calls(session)[0] as RecordOf<"model_call">);
    expect(call.endedAt.state).toBe("known");
    if (call.endedAt.state !== "known" || call.durationMs.state !== "known") return;
    expect(Date.parse(call.endedAt.value) - Date.parse(call.startedAt)).toBe(call.durationMs.value);
    expect(call.startedAt.startsWith("2026-11-01T11:")).toBe(true);
  });

  it("records the returned model, the usage and the cost priced from the call's table", async () => {
    const { session, deps } = await setup([ok()]);
    await runCall(session, deps, plan());
    const call = ended(calls(session)[0] as RecordOf<"model_call">);
    expect(call.returnedModel).toEqual(known("claude-test"));
    expect(call.usage).toEqual(USAGE);
    expect(call.cost).toEqual(
      known({ amount: (2000 * 4 + 400 * 20) / 1_000_000, currency: "USD", basis: "estimated" }),
    );
  });

  it("records the validator's events and counts on the completed call", async () => {
    const { session, deps } = await setup([ok("ALL_REJECTED")]);
    await runCall(session, deps, plan());
    const call = ended(calls(session)[0] as RecordOf<"model_call">);
    expect(call.validationEvents.map((e) => e.itemKey)).toEqual(["q1", "q2"]);
    expect(call.counts).toEqual({
      proposed: known(2),
      accepted: 0,
      corrected: 0,
      relabelled: 0,
      rejectedByRule: { "CIT-004": 2 },
    });
  });
});

describe("retained exchanges for every send (IMPL §4.8)", () => {
  it("retains the request before it is sent and the response with the end, as the call and its manifest reference them", async () => {
    const { session, store, deps } = await setup([ok()]);
    await runCall(session, deps, plan());
    const call = ended(calls(session)[0] as RecordOf<"model_call">);
    const input = retainedFile("inputs", bytesOf(REQUEST));
    expect(call.retainedInputRef).toBe(input.ref);
    expect(call.inputManifest.retainedInputRef).toBe(input.ref);
    expect(store.files.get(input.ref)).toEqual(input.bytes);
    const answer = message(REQUEST);
    if (answer.kind !== "response") throw new Error("expected a response");
    const output = retainedFile("responses", answer.responseBytes);
    expect(call.retainedResponseRef).toBe(output.ref);
    expect(store.files.get(output.ref)).toEqual(output.bytes);
  });

  it("retains an HTTP error's body, and no response after a connection failure", async () => {
    const { session, deps } = await setup([http(400), transport("connection"), ok()]);
    await runCall(session, deps, plan());
    const { session: s2, deps: d2 } = await setup([transport("connection"), ok()]);
    await runCall(s2, d2, plan());
    expect(ended(calls(session)[0] as RecordOf<"model_call">).retainedResponseRef).toMatch(
      /^responses\//,
    );
    expect(ended(calls(s2)[0] as RecordOf<"model_call">).retainedResponseRef).toBeNull();
  });

  it("records null references with retention off", async () => {
    const { session, store, deps } = await setup([ok()], { retain: false });
    await runCall(session, deps, plan());
    const call = ended(calls(session)[0] as RecordOf<"model_call">);
    expect(call.retainedInputRef).toBeNull();
    expect(call.inputManifest.retainedInputRef).toBeNull();
    expect(call.retainedResponseRef).toBeNull();
    expect([...store.files.keys()].filter((k) => !k.startsWith("content/"))).toEqual([]);
  });

  it("refuses a sender whose sent bytes differ from the bytes it retained", async () => {
    const { session, deps } = await setup([
      (request) => ({ ...message(request), requestBytes: encode("other") }),
    ]);
    await expect(runCall(session, deps, plan())).rejects.toThrow(/bytes/);
  });
});

// --- The budget before every send ---------------------------------------------------------------

describe("the generation budget before every send (IMPL §3.6, §4.6)", () => {
  it("sends nothing and stops the session with budget_reached when the estimate exceeds the budget", async () => {
    const { session, sent, deps } = await setup([ok()], { budget: { maxCostUsd: ESTIMATE / 2 } });
    const outcome = await runCall(session, deps, plan());
    expect(outcome.kind).toBe("not_sent");
    expect(sent).toEqual([]);
    expect(calls(session)).toEqual([]);
    expect(session.records.at(-1)).toMatchObject({
      type: "session_state",
      reason: "budget_reached",
      unsentPurpose: "generate_questions",
    });
  });

  it("checks a retry again, counting the failed send's estimate, and doesn't send it over the budget", async () => {
    const { session, sent, deps } = await setup([transport("connection"), ok()], {
      budget: { maxCostUsd: ESTIMATE * 1.5 },
    });
    const outcome = await runCall(session, deps, plan());
    expect(sent).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "not_sent", retryOf: calls(session)[0]?.modelCallId });
    if (outcome.kind === "not_sent") expect(outcome.check.result).toBe("budget_reached");
    expect(session.records.at(-1)).toMatchObject({ reason: "budget_reached" });
  });

  it("sends a transport retry under a token ceiling, counting the failed send's estimatedTokens (§4.6)", async () => {
    const { session, sent, deps } = await setup([transport("connection"), ok()], {
      budget: { maxTokens: 1_000_000 },
    });
    const outcome = await runCall(session, deps, plan());
    expect(outcome.kind).toBe("completed");
    expect(sent).toHaveLength(2);
    expect(calls(session)[0]?.estimatedTokens).toEqual(known(INPUT_TOKENS + 1000));
    expect(calls(session)[1]?.budget.spentTokens).toEqual(known(INPUT_TOKENS + 1000));
  });

  it("doesn't send a transport retry whose estimate, with the failed send's, passes the token ceiling", async () => {
    const { session, sent, deps } = await setup([transport("connection"), ok()], {
      budget: { maxTokens: (INPUT_TOKENS + 1000) * 2 - 1 },
    });
    const outcome = await runCall(session, deps, plan());
    expect(sent).toHaveLength(1);
    if (outcome.kind !== "not_sent") throw new Error("expected not_sent");
    expect(outcome.check).toMatchObject({ result: "budget_reached", exceeded: ["tokens"] });
  });

  it("sends nothing when the check can't be made, as for a model missing from the price table", async () => {
    const { session, sent, deps } = await setup([ok()], { budget: { maxCostUsd: 10 } });
    const outcome = await runCall(session, deps, {
      ...plan(),
      request: { ...REQUEST, model: "claude-unpriced" },
    });
    expect(sent).toEqual([]);
    if (outcome.kind !== "not_sent") throw new Error("expected not_sent");
    expect(outcome.check.result).toBe("cannot_check");
    expect(session.records.at(-1)).toMatchObject({ reason: "budget_reached" });
  });

  it("estimates a schema retry with its message: the count plus 1 token per 3 bytes of the message", async () => {
    const { session, deps } = await setup([ok("BAD"), ok()]);
    await runCall(session, deps, plan());
    const message_ = schemaRetryMessage([
      { path: "questions.0.text", code: "invalid_type" },
      { path: "", code: "unrecognized_keys" },
    ]);
    const tokens = INPUT_TOKENS + Math.ceil(encode(message_).length / 3);
    expect(calls(session)[1]?.estimatedCost).toEqual(known((tokens * 4 + 1000 * 20) / 1_000_000));
  });
});

// --- The failure table ------------------------------------------------------------------------

describe("transport failures (IMPL §3.6)", () => {
  const retried: [string, Answer, string, string][] = [
    ["a connection error", transport("connection"), "connection", "connection"],
    ["a timeout", transport("timeout"), "timeout", "timeout"],
    ["HTTP 408", http(408), "server", "http_408"],
    ["HTTP 409", http(409), "server", "http_409"],
    ["HTTP 500", http(500), "server", "http_500"],
    ["HTTP 503", http(503), "server", "http_503"],
    ["HTTP 529", http(529), "server", "http_529"],
    ["a 200 whose body isn't a message", unreadable, "server", "unreadable_response"],
  ];

  for (const [name, failure, kind, msg] of retried) {
    it(`retries ${name} with the identical request after 1 second`, async () => {
      const { session, sent, deps, waits } = await setup([failure, ok()]);
      const outcome = await runCall(session, deps, plan());
      expect(outcome.kind).toBe("completed");
      expect(sent).toEqual([REQUEST, REQUEST]);
      expect(waits).toEqual([1000]);
      expect(ended(calls(session)[0] as RecordOf<"model_call">).error).toEqual({
        kind,
        message: msg,
      });
    });

    it(`fails the call after 3 retries of ${name}, waiting 1, 2 and 4 seconds`, async () => {
      const { session, sent, deps, waits } = await setup([
        failure,
        failure,
        failure,
        failure,
        ok(),
      ]);
      const outcome = await runCall(session, deps, plan());
      expect(outcome).toMatchObject({ kind: "failed", error: { kind, message: msg } });
      expect(sent).toHaveLength(4);
      expect(waits).toEqual([...BACKOFF_MS]);
      expect(calls(session).map((c) => c.state)).toEqual(["failed", "failed", "failed", "failed"]);
    });
  }

  it("uses the backoff of 1, 2 and 4 seconds", () => {
    expect(BACKOFF_MS).toEqual([1000, 2000, 4000]);
  });

  it("records the usage, the returned model and the proposed count as unknown with no_response, and the cost unknown, when no response arrived", async () => {
    for (const failure of [transport("connection"), transport("timeout"), http(500), unreadable]) {
      const { session, deps } = await setup([failure, ok()]);
      await runCall(session, deps, plan("analyse"));
      const call = ended(calls(session)[0] as RecordOf<"model_call">);
      const noResponse = { state: "unknown", reason: "no_response" };
      expect(call.returnedModel).toEqual(noResponse);
      expect(call.usage).toEqual({
        input: noResponse,
        output: noResponse,
        cacheRead: noResponse,
        cacheWrite: noResponse,
      });
      expect(call.counts.proposed).toEqual(noResponse);
      expect(call.cost).toEqual({
        state: "unknown",
        reason: "usage_unknown:input,output,cacheRead,cacheWrite",
      });
      expect(call.validationEvents).toEqual([]);
      expect(call.correctedCitationRate).toEqual(noResponse);
      expect(call.citationsProposed).toEqual(noResponse);
    }
  });
});

describe("rate limits (IMPL §3.6)", () => {
  it("waits for the seconds in retry-after", async () => {
    const { session, deps, waits } = await setup([http(429, "7"), ok()]);
    await runCall(session, deps, plan());
    expect(waits).toEqual([7000]);
    expect(ended(calls(session)[0] as RecordOf<"model_call">).error).toEqual({
      kind: "rate_limit",
      message: "http_429",
    });
  });

  it("waits until an HTTP date in retry-after, and not at all for a date already past", async () => {
    // The clock reads 11:00:00 at the start and ticks one second per reading.
    const { session, deps, waits } = await setup([
      http(429, "Sun, 01 Nov 2026 11:01:00 GMT"),
      http(429, "Sun, 01 Nov 2026 10:00:00 GMT"),
      ok(),
    ]);
    await runCall(session, deps, plan());
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(50_000);
    expect(waits[0]).toBeLessThanOrEqual(60_000);
    expect(waits[1]).toBe(0);
  });

  it("uses the backoff when retry-after is missing or unreadable", async () => {
    const { session, deps, waits } = await setup([http(429), http(429, "soon"), ok()]);
    await runCall(session, deps, plan());
    expect(waits).toEqual([1000, 2000]);
  });

  it("reads only a date in GMT, so the wait doesn't depend on the time zone", async () => {
    const { session, deps, waits } = await setup([
      http(429, "Sun, 01 Nov 2026 11:01:00"),
      http(429, "2026-11-01T11:01:00"),
      http(429, "Sun, 01 Nov 2026 11:01:00 +0100"),
      ok(),
    ]);
    await runCall(session, deps, plan());
    expect(waits).toEqual([...BACKOFF_MS]);
  });

  it("counts rate limits towards the 3 retries", async () => {
    const { session, sent, deps } = await setup([
      http(429, "1"),
      http(503),
      http(429, "1"),
      http(429, "1"),
      ok(),
    ]);
    const outcome = await runCall(session, deps, plan());
    expect(sent).toHaveLength(4);
    expect(outcome).toMatchObject({ kind: "failed", error: { kind: "rate_limit" } });
  });

  it("fails the call without waiting when retry-after asks for more than 5 minutes, and allows exactly 5", async () => {
    expect(MAX_RETRY_AFTER_MS).toBe(300_000);
    const over = await setup([http(429, "301"), ok()]);
    const outcome = await runCall(over.session, over.deps, plan());
    expect(outcome).toMatchObject({ kind: "failed", error: { kind: "rate_limit" } });
    expect(over.sent).toHaveLength(1);
    expect(over.waits).toEqual([]);

    const at = await setup([http(429, "300"), ok()]);
    expect((await runCall(at.session, at.deps, plan())).kind).toBe("completed");
    expect(at.waits).toEqual([300_000]);
  });
});

describe("other request errors (IMPL §3.6)", () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422]) {
    it(`fails HTTP ${status} with the kind request and no retry`, async () => {
      const { session, sent, deps, waits } = await setup([http(status), ok()]);
      const outcome = await runCall(session, deps, plan());
      expect(outcome).toMatchObject({
        kind: "failed",
        error: { kind: "request", message: `http_${status}` },
      });
      expect(sent).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(calls(session)).toHaveLength(1);
    });
  }
});

describe("stop reasons, checked before the response is parsed (IMPL §3.6)", () => {
  it("fails a truncated response with the kind truncated, no retry and no validation", async () => {
    let validated = 0;
    const { session, sent, deps } = await setup([stopped("max_tokens"), ok()]);
    const outcome = await runCall(
      session,
      deps,
      plan("analyse", (text) => {
        validated += 1;
        return fakeValidate(text);
      }),
    );
    expect(sent).toHaveLength(1);
    expect(validated).toBe(0);
    expect(outcome).toMatchObject({
      kind: "failed",
      error: { kind: "truncated", message: "reservedOutputTokens 1000" },
    });
    const call = ended(calls(session)[0] as RecordOf<"model_call">);
    const truncated = { state: "unknown", reason: "truncated" };
    expect(call.validationEvents).toEqual([]);
    expect(call.counts.proposed).toEqual(truncated);
    expect(call.correctedCitationRate).toEqual(truncated);
    expect(call.citationsProposed).toEqual(truncated);
    // A response arrived, so its usage is known and it was billed.
    expect(call.usage).toEqual(USAGE);
    expect(call.cost.state).toBe("known");
  });

  it("retries a first refusal once with the identical request and no message", async () => {
    const { session, sent, deps, waits } = await setup([stopped("refusal", "cyber"), ok()]);
    const outcome = await runCall(session, deps, plan());
    expect(outcome.kind).toBe("completed");
    expect(sent).toEqual([REQUEST, REQUEST]);
    expect(waits).toEqual([]);
    expect(ended(calls(session)[0] as RecordOf<"model_call">)).toMatchObject({
      state: "failed",
      error: { kind: "refusal", message: "cyber" },
      counts: { proposed: { state: "unknown", reason: "refusal" } },
    });
  });

  it("fails a second refusal with the category only, or uncategorised when the API gives none", async () => {
    const { deps, session } = await setup([
      stopped("refusal", "cyber"),
      stopped("refusal", "cyber"),
      ok(),
    ]);
    expect(await runCall(session, deps, plan())).toMatchObject({
      kind: "failed",
      error: { kind: "refusal", message: "cyber" },
    });
    const none = await setup([stopped("refusal"), stopped("refusal"), ok()]);
    expect(await runCall(none.session, none.deps, plan())).toMatchObject({
      kind: "failed",
      error: { kind: "refusal", message: "uncategorised" },
    });
    expect(none.sent).toHaveLength(2);
  });

  it("gives an empty refusal category as uncategorised", async () => {
    const { session, deps } = await setup([stopped("refusal", ""), stopped("refusal", "")]);
    expect(await runCall(session, deps, plan())).toMatchObject({
      kind: "failed",
      error: { kind: "refusal", message: "uncategorised" },
    });
    expect(calls(session).map((c) => c.state)).toEqual(["failed", "failed"]);
  });

  it("fails any other stop reason except end_turn with unexpected_stop and the stop reason, with no retry", async () => {
    for (const [reason, msg] of [
      ["pause_turn", "pause_turn"],
      ["tool_use", "tool_use"],
      [null, "none"],
      ["", "none"],
    ] as const) {
      const { session, sent, deps } = await setup([stopped(reason), ok()]);
      const outcome = await runCall(session, deps, plan());
      expect(outcome).toMatchObject({
        kind: "failed",
        error: { kind: "unexpected_stop", message: msg },
      });
      expect(sent).toHaveLength(1);
      expect(ended(calls(session)[0] as RecordOf<"model_call">).counts.proposed).toEqual({
        state: "unknown",
        reason: "unexpected_stop",
      });
    }
  });
});

describe("schema failures (IMPL §3.6)", () => {
  it("retries once with the identical request plus a message listing each issue's path and code", async () => {
    const { session, sent, deps } = await setup([ok("BAD"), ok()]);
    const outcome = await runCall(session, deps, plan());
    expect(outcome.kind).toBe("completed");
    expect(sent[0]).toEqual(REQUEST);
    expect(sent[1]).toEqual({
      ...REQUEST,
      retryMessage: schemaRetryMessage([
        { path: "questions.0.text", code: "invalid_type" },
        { path: "", code: "unrecognized_keys" },
      ]),
    });
    const first = ended(calls(session)[0] as RecordOf<"model_call">);
    expect(first).toMatchObject({
      state: "failed",
      error: { kind: "schema" },
      counts: { proposed: { state: "unknown", reason: "schema_failed" } },
    });
    expect(first.validationEvents.map((e) => e.rule)).toEqual(["SCHEMA", "SCHEMA"]);
  });

  it("writes the message from paths and codes only, the root as (root)", () => {
    const text = schemaRetryMessage([
      { path: "questions.0.text", code: "invalid_type" },
      { path: "", code: "unrecognized_keys" },
    ]);
    expect(text).toContain("- questions.0.text: invalid_type\n");
    expect(text).toContain("- (root): unrecognized_keys\n");
  });

  it("fails the call with the kind schema after a second schema failure", async () => {
    const { session, sent, deps } = await setup([ok("BAD"), ok("BAD"), ok()]);
    const outcome = await runCall(session, deps, plan());
    expect(outcome).toMatchObject({ kind: "failed", error: { kind: "schema" } });
    expect(sent).toHaveLength(2);
  });

  it("treats a response that isn't exactly one text block as a schema failure at content, not_one_text_block", async () => {
    const shapes: { text: readonly string[]; other?: readonly string[] }[] = [
      { text: [] },
      { text: ["{}", "{}"] },
      { text: ["{}"], other: ["tool_use"] },
    ];
    for (const shape of shapes) {
      const { session, sent, deps } = await setup([(r) => message(r, shape), ok()]);
      await runCall(session, deps, plan());
      const first = ended(calls(session)[0] as RecordOf<"model_call">);
      expect(first.validationEvents).toEqual([
        {
          itemKey: "$response",
          stage: "schema",
          rule: "SCHEMA",
          outcome: "rejected",
          detail: "content: not_one_text_block",
        },
      ]);
      expect(sent[1]?.retryMessage).toBe(
        schemaRetryMessage([{ path: "content", code: "not_one_text_block" }]),
      );
    }
  });

  it("gives the schema retry its own 3 transport retries, sending the retry request each time", async () => {
    const { session, sent, deps, waits } = await setup([
      http(503),
      ok("BAD"),
      http(503),
      http(503),
      http(503),
      ok(),
    ]);
    const outcome = await runCall(session, deps, plan());
    expect(outcome.kind).toBe("completed");
    expect(sent.map((r) => r.retryMessage === undefined)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(waits).toEqual([1000, 1000, 2000, 4000]);
  });

  it("doesn't send a schema retry whose message matches the secret scan, and ends the step with the schema failure", async () => {
    const { session, sent, deps } = await setup([ok("SECRET_BAD"), ok()]);
    const outcome = await runCall(session, deps, plan());
    expect(sent).toHaveLength(1);
    expect(outcome).toMatchObject({
      kind: "failed",
      modelCallId: calls(session)[0]?.modelCallId,
      error: { kind: "schema" },
    });
    expect(calls(session)).toHaveLength(1);
  });

  it("refuses to send a request that matches the secret scan, which its caller must withhold first", async () => {
    const { session, sent, deps } = await setup([ok()]);
    await expect(
      runCall(session, deps, { ...plan(), request: { ...REQUEST, user: SECRET } }),
    ).rejects.toThrow(/aws-access-key-id/);
    expect(sent).toEqual([]);
    expect(calls(session)).toEqual([]);
  });

  it("retries a refusal after a schema failure with the retry request", async () => {
    const { sent, deps, session } = await setup([ok("BAD"), stopped("refusal"), ok()]);
    await runCall(session, deps, plan());
    expect(sent[2]?.retryMessage).toBe(sent[1]?.retryMessage);
    expect(sent[2]?.retryMessage).toBeDefined();
  });
});

describe("item failures and every item rejected (IMPL §3.6, §2.12)", () => {
  it("doesn't retry an item failure: the call completes with the validation for the caller to persist", async () => {
    const { session, sent, deps } = await setup([ok("ALL_REJECTED"), ok()]);
    const outcome = await runCall(session, deps, plan());
    expect(sent).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "completed", allRejected: true });
    if (outcome.kind === "completed") expect(outcome.validation.status).toBe("validated");
    expect(calls(session)[0]?.state).toBe("completed");
  });

  it("isn't every item rejected when an item was accepted", async () => {
    const { session, deps } = await setup([ok()]);
    expect(await runCall(session, deps, plan())).toMatchObject({
      kind: "completed",
      allRejected: false,
    });
  });

  it("offers one fresh retry of the identical request, naming the completed call", async () => {
    const { session, sent, deps } = await setup([ok("ALL_REJECTED"), ok("ALL_REJECTED"), ok()]);
    const first = await runCall(session, deps, plan());
    if (first.kind !== "completed") throw new Error("expected completed");
    const retry = await freshRetry(session, deps, plan(), first.modelCallId);
    expect(retry.kind).toBe("completed");
    expect(sent).toEqual([REQUEST, REQUEST]);
    const [a, b] = calls(session);
    expect(b).toMatchObject({ attempt: 2, retryOf: a?.modelCallId });
    if (retry.kind !== "completed") return;
    await expect(freshRetry(session, deps, plan(), retry.modelCallId)).rejects.toThrow(
      /one fresh retry/,
    );
  });

  it("refuses a fresh retry of a call that had accepted items or didn't complete", async () => {
    const accepted = await setup([ok(), ok()]);
    const done = await runCall(accepted.session, accepted.deps, plan());
    if (done.kind !== "completed") throw new Error("expected completed");
    await expect(
      freshRetry(accepted.session, accepted.deps, plan(), done.modelCallId),
    ).rejects.toThrow(/every item rejected/);

    const failed = await setup([http(400), ok()]);
    const outcome = await runCall(failed.session, failed.deps, plan());
    if (outcome.kind !== "failed") throw new Error("expected failed");
    await expect(
      freshRetry(failed.session, failed.deps, plan(), outcome.modelCallId),
    ).rejects.toThrow(/every item rejected/);
  });

  it("doesn't give a fresh retry a second schema or refusal retry: each is once per step", async () => {
    for (const used of ["BAD", "refusal"] as const) {
      const first: Answer = used === "BAD" ? ok("BAD") : stopped("refusal");
      const again: Answer = used === "BAD" ? ok("BAD") : stopped("refusal");
      const { session, sent, deps } = await setup([first, ok("ALL_REJECTED"), again, ok()]);
      const step = await runCall(session, deps, plan());
      if (step.kind !== "completed") throw new Error("expected completed");
      const retry = await freshRetry(session, deps, plan(), step.modelCallId);
      expect(retry, used).toMatchObject({ kind: "failed" });
      expect(sent, used).toHaveLength(3);
      // The fresh retry sends the original request, without the schema retry's message.
      expect(sent[2], used).toEqual(REQUEST);
    }
  });

  it("refuses a fresh retry once another call has been sent", async () => {
    const { session, deps } = await setup([ok("ALL_REJECTED"), ok()]);
    const first = await runCall(session, deps, plan());
    if (first.kind !== "completed") throw new Error("expected completed");
    await runCall(session, deps, plan("recommend"));
    await expect(freshRetry(session, deps, plan(), first.modelCallId)).rejects.toThrow(/last send/);
  });

  it("refuses a fresh retry with another purpose or another request", async () => {
    const { session, sent, deps } = await setup([ok("ALL_REJECTED")]);
    const first = await runCall(session, deps, plan());
    if (first.kind !== "completed") throw new Error("expected completed");
    await expect(freshRetry(session, deps, plan("recommend"), first.modelCallId)).rejects.toThrow(
      /not recommend/,
    );
    await expect(
      freshRetry(
        session,
        deps,
        { ...plan(), request: { ...REQUEST, user: "other" } },
        first.modelCallId,
      ),
    ).rejects.toThrow(/identical/);
    expect(sent).toHaveLength(1);
  });

  it("refuses a fresh retry of a call that isn't the step's latest send", async () => {
    const { session, deps } = await setup([ok("ALL_REJECTED"), ok("ALL_REJECTED")]);
    const first = await runCall(session, deps, plan());
    if (first.kind !== "completed") throw new Error("expected completed");
    await freshRetry(session, deps, plan(), first.modelCallId);
    await expect(freshRetry(session, deps, plan(), first.modelCallId)).rejects.toThrow();
  });
});

describe("the outcome of a step", () => {
  it("returns the failure of the last send with its modelCallId", async () => {
    const { session, deps } = await setup([http(401)]);
    const outcome = await runCall(session, deps, plan());
    expect(outcome).toEqual({
      kind: "failed",
      modelCallId: calls(session)[0]?.modelCallId,
      error: { kind: "request", message: "http_401" },
    });
  });

  it("leaves a send that throws started, for recovery to mark interrupted", async () => {
    const { session, deps } = await setup([
      () => {
        throw new Error("boom");
      },
    ]);
    await expect(runCall(session, deps, plan())).rejects.toThrow("boom");
    expect(calls(session).map((c) => c.state)).toEqual(["started"]);
  });
});
