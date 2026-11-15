import { describe, expect, it } from "vitest";
import { MemorySession } from "../../../test/support/memory-store.js";
import { callDraft, hashOf, newLog, TEST_SETTINGS } from "../../../test/support/session.js";
import type { ModelRequest } from "../../core/request.js";
import {
  type RecordOf,
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
} from "../../core/session/records.js";
import { BACKOFF_MS, type CallPlan, runCall } from "../../core/session/send.js";
import { HeldSession } from "../../core/session/store.js";
import type { ValidationResult } from "../../core/validation/pipeline.js";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import { createClaudeClient } from "./client.js";
import { PRICE_TABLE } from "./prices.js";

// The real adapter, with an injected `fetch`, through the core send loop (IMPL §3.6, §4.6, ADR
// 0003): the SDK's own retries are off, so each recorded send is exactly one request on the wire.
// No live model is called.

const SENTINEL_KEY = ["sk", "ant", "sentinel", "send-loop"].join("-");

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

const REQUEST: ModelRequest = {
  model: "claude-opus-5-5",
  maxTokens: 16_000,
  effort: "medium",
  system: "You ask questions.",
  user: "<context>…</context>",
  schema: CALL_SCHEMAS.generate_questions.apiSchema,
};

const MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5-20261101",
  content: [{ type: "text", text: "{}" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 340,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function heldSession(): Promise<HeldSession> {
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
    requestedModel: "claude-opus-5-5",
    effort: "medium",
    budget: {},
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    retainModelInputs: true,
  });
  const session = new HeldSession(new MemorySession(), HEADER, log);
  await session.save();
  return session;
}

/** Accepts "{}" with nothing proposed: the call's own rules have their own tests. */
const accepted: ValidationResult<unknown, unknown> = {
  status: "validated",
  validatorVersion: "validate/test",
  response: {},
  accepted: {},
  redirects: new Map(),
  rejected: [],
  events: [],
  counts: {
    proposed: { state: "known", count: 0 },
    accepted: 0,
    corrected: 0,
    relabelled: 0,
    rejectionsByRule: [],
  },
};

function plan(): CallPlan<ValidationResult<unknown, unknown>> {
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
  } = callDraft({ aliases: { call: "generate_questions", entries: [] } });
  return {
    purpose: "generate_questions",
    request: REQUEST,
    inputTokens: 2000,
    started,
    validate: () => accepted,
    resultOf: (validation) => validation,
  };
}

function modelCalls(session: HeldSession): RecordOf<"model_call">[] {
  const latest = new Map<string, RecordOf<"model_call">>();
  for (const record of session.records)
    if (record.type === "model_call") latest.set(record.modelCallId, record);
  return [...latest.values()];
}

describe("the adapter through the send loop (IMPL §3.6, §4.6, ADR 0003)", () => {
  it("makes exactly one fetch per recorded send on a 503, and the retry after it", async () => {
    const answers = [
      () => json(503, { type: "error", error: { type: "overloaded_error", message: "busy" } }),
      () => json(200, MESSAGE),
    ];
    const bodies: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const answer = answers[bodies.length - 1];
      if (answer === undefined) throw new Error(`unexpected fetch ${bodies.length}`);
      return answer();
    };
    const client = createClaudeClient({ apiKey: SENTINEL_KEY, fetch });
    const session = await heldSession();
    const waits: number[] = [];
    let now = Date.UTC(2026, 10, 1, 11, 0, 0);
    const outcome = await runCall(
      session,
      {
        sender: client,
        prices: PRICE_TABLE,
        clock: {
          now: () => {
            now += 1000;
            return new Date(now);
          },
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
      plan(),
    );

    const calls = modelCalls(session);
    expect(outcome.kind).toBe("completed");
    expect(bodies).toHaveLength(calls.length);
    expect(calls.map((c) => c.state)).toEqual(["failed", "completed"]);
    expect(calls[0]).toMatchObject({ error: { kind: "server", message: "http_503" } });
    expect(waits).toEqual([BACKOFF_MS[0]]);
    // Both sends were the identical request, as retained.
    expect(bodies[1]).toBe(bodies[0]);
    expect(calls[0]?.retainedInputRef).toBe(calls[1]?.retainedInputRef);
  });
});
