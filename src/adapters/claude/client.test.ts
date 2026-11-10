import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySession } from "../../../test/support/memory-store.js";
import {
  callDraft,
  completedCall,
  hashOf,
  newLog,
  TEST_SETTINGS,
} from "../../../test/support/session.js";
import {
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
} from "../../core/session/records.js";
import { retainedExchange } from "../../core/session/retained.js";
import { serialiseSession } from "../../core/session/serialise.js";
import { saveSession } from "../../core/session/store.js";
import type { CallPurpose } from "../../core/validation/aliases.js";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import {
  API_VERSION,
  bodyBytes,
  createClaudeClient,
  type MessageRequest,
  messageBody,
  nonStreamingTimeoutMs,
  readBody,
  type SendResult,
} from "./client.js";

// The Claude API adapter (ADR 0003, IMPL §3.7, §3.8 "Adapter and failures", §4.8), through an
// injected `fetch`. No live model is ever called.

/** Built from fragments, so no committed file looks like a credential (IMPL §1.7). */
const SENTINEL_KEY = ["sk", "ant", "sentinel", "0123456789abcdefSENTINEL"].join("-");
const decoder = new TextDecoder();

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A fake `fetch` that records each request and answers from `respond`. */
function fakeFetch(respond: (n: number) => Response | Error = () => okResponse()) {
  const captured: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : decoder.decode(init?.body as Uint8Array),
    });
    const answer = respond(captured.length);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, captured };
}

const MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5-20261101",
  content: [
    { type: "thinking", thinking: "…", signature: "sig" },
    { type: "text", text: '{"findings":[]}' },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 340,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

/** The body as the server sent it, spacing included, so a re-serialisation would show. */
const RESPONSE_TEXT = `{ "id": "msg_01",\n  "message": ${JSON.stringify(MESSAGE)} }`;

function okResponse(message: object = MESSAGE, text?: string): Response {
  return new Response(text ?? JSON.stringify(message, null, 1), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": "req_01" },
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "x", message: "no" } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function request(call: CallPurpose = "analyse", maxTokens = 16_000): MessageRequest {
  return {
    model: "claude-opus-5-5",
    maxTokens,
    effort: "medium",
    system: "You analyse repositories.",
    user: "<context>…</context>",
    schema: CALL_SCHEMAS[call].apiSchema,
  };
}

const CALLS = [
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
] as const satisfies readonly CallPurpose[];

describe("the request (ADR 0003, IMPL §3.7)", () => {
  for (const call of CALLS)
    it(`${call}: sends the committed JSON Schema unchanged, and the body's bytes are the retained input`, async () => {
      const { fetch, captured } = fakeFetch();
      const client = createClaudeClient({ apiKey: SENTINEL_KEY, fetch });
      const result = await client.send(request(call));
      expect(captured).toHaveLength(1);
      const sent = captured[0] as Captured;
      const committed = readFileSync(
        new URL(`../../schemas/json/${call}.json`, import.meta.url),
        "utf8",
      );
      const body = JSON.parse(sent.body);
      expect(body.output_config.format).toEqual({
        type: "json_schema",
        schema: JSON.parse(committed),
      });
      // Property order too: the model writes fields in the order the schema declares (§3.7).
      expect(JSON.stringify(body.output_config.format.schema)).toBe(
        JSON.stringify(JSON.parse(committed)),
      );
      expect(sent.body).toBe(decoder.decode(result.requestBytes));
      expect(result.requestBytes).toEqual(bodyBytes(messageBody(request(call))));
    });

  it("holds effort, no sampling parameters and no streaming, and goes to the Messages API", async () => {
    const { fetch, captured } = fakeFetch();
    await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    const sent = captured[0] as Captured;
    const body = JSON.parse(sent.body);
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.output_config.effort).toBe("medium");
    expect(body.max_tokens).toBe(16_000);
    expect(body.model).toBe("claude-opus-5-5");
    for (const field of ["temperature", "top_p", "top_k", "stream", "fallbacks", "thinking"])
      expect(body, field).not.toHaveProperty(field);
    expect(Object.keys(body).sort()).toEqual(
      ["max_tokens", "messages", "model", "output_config", "system"].sort(),
    );
    expect(body.messages).toEqual([{ role: "user", content: "<context>…</context>" }]);
    expect(body.system).toBe("You analyse repositories.");
  });

  it("records the anthropic-version the SDK sends", async () => {
    const { fetch, captured } = fakeFetch();
    await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    expect(API_VERSION).toBe("2026-10-21");
    expect(captured[0]?.headers.get("anthropic-version")).toBe(API_VERSION);
  });

  it("always passes timeout: 10 minutes, or 3600 × max_tokens / 128000 seconds when longer", async () => {
    expect(nonStreamingTimeoutMs(16_000)).toBe(600_000);
    expect(nonStreamingTimeoutMs(64_000)).toBe(1_800_000);
    expect(nonStreamingTimeoutMs(12_345)).toBe(600_000);
    expect(nonStreamingTimeoutMs(40_001)).toBe(Math.ceil((3_600_000 * 40_001) / 128_000));
    for (const maxTokens of [16_000, 64_000]) {
      const { fetch, captured } = fakeFetch();
      // A raised output limit: without a timeout of our own, the SDK refuses a non-streaming
      // request expected to take over 10 minutes (ADR 0003).
      const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(
        request("analyse", maxTokens),
      );
      expect(result.kind).toBe("response");
      expect(captured[0]?.headers.get("x-stainless-timeout")).toBe(
        String(Math.trunc(nonStreamingTimeoutMs(maxTokens) / 1000)),
      );
    }
  });

  it("builds the same bytes for the same request", () => {
    expect(bodyBytes(messageBody(request()))).toEqual(bodyBytes(messageBody(request())));
  });
});

describe("the response (IMPL §3.7, §4.6, §4.8)", () => {
  it("keeps the exact response bytes, as received, before parsing", async () => {
    const { fetch } = fakeFetch(() => okResponse(MESSAGE, `${JSON.stringify(MESSAGE)}\n  `));
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(decoder.decode(result.responseBytes)).toBe(`${JSON.stringify(MESSAGE)}\n  `);
  });

  it("reads the returned model, the stop reason, the text block and the four usage counts", async () => {
    const { fetch } = fakeFetch();
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(result.message).toEqual({
      returnedModel: "claude-opus-5-5-20261101",
      stopReason: "end_turn",
      // Thinking blocks are ignored; only text blocks are read (§3.7).
      textBlocks: ['{"findings":[]}'],
      otherBlocks: [],
      usage: {
        input: { state: "known", value: 1200 },
        output: { state: "known", value: 340 },
        cacheRead: { state: "known", value: 0 },
        cacheWrite: { state: "known", value: 0 },
      },
    });
  });

  it("records an unreported usage count as unknown, never zero", async () => {
    const { fetch } = fakeFetch(() =>
      okResponse({
        ...MESSAGE,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null },
      }),
    );
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(result.message?.usage).toEqual({
      input: { state: "known", value: 10 },
      output: { state: "known", value: 5 },
      cacheRead: { state: "unknown", reason: "not_reported" },
      cacheWrite: { state: "unknown", reason: "not_reported" },
    });
  });

  it("reads a refusal's category, and lists blocks that aren't text or thinking", async () => {
    const { fetch } = fakeFetch(() =>
      okResponse({
        ...MESSAGE,
        content: [{ type: "tool_use", id: "t", name: "x", input: {} }],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "Not shown." },
      }),
    );
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(result.message).toMatchObject({
      stopReason: "refusal",
      refusalCategory: "cyber",
      textBlocks: [],
      otherBlocks: ["tool_use"],
    });
    expect(JSON.stringify(result.message)).not.toContain("Not shown.");
  });

  it("reads a refusal whose category is null as a refusal with no category", async () => {
    const { fetch } = fakeFetch(() =>
      okResponse({
        ...MESSAGE,
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: null },
      }),
    );
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(result.message?.stopReason).toBe("refusal");
    expect(result.message).not.toHaveProperty("refusalCategory");
  });

  it("counts a text block without text with the other blocks, so it can't pass as one text block", async () => {
    const { fetch } = fakeFetch(() =>
      okResponse({ ...MESSAGE, content: [{ type: "text", text: "{}" }, { type: "text" }] }),
    );
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(result.message).toMatchObject({ textBlocks: ["{}"], otherBlocks: ["text"] });
  });

  it("keeps the bytes of a body that isn't a message, with no message read", async () => {
    const { fetch } = fakeFetch(() => okResponse(MESSAGE, RESPONSE_TEXT));
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "response") throw new Error(result.kind);
    expect(decoder.decode(result.responseBytes)).toBe(RESPONSE_TEXT);
    expect(result.message).toBeUndefined();
  });
});

describe("one send per request: the SDK's retries are off (ADR 0003, IMPL §3.6, §4.6)", () => {
  const cases: [string, () => Response | Error, SendResult["kind"]][] = [
    ["HTTP 500", () => errorResponse(500), "http_error"],
    ["HTTP 529", () => errorResponse(529), "http_error"],
    ["HTTP 429", () => errorResponse(429, { "retry-after": "7" }), "http_error"],
    ["HTTP 408", () => errorResponse(408), "http_error"],
    ["HTTP 409", () => errorResponse(409), "http_error"],
    ["HTTP 400", () => errorResponse(400), "http_error"],
    ["a connection error", () => new TypeError("fetch failed"), "connection"],
  ];
  for (const [what, respond, kind] of cases)
    it(`${what} is sent once and reported as ${kind}`, async () => {
      const { fetch, captured } = fakeFetch(respond);
      const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
      expect(captured).toHaveLength(1);
      expect(result.kind).toBe(kind);
      expect(decoder.decode(result.requestBytes)).toBe(captured[0]?.body);
    });

  it("gives an HTTP error's status, its retry-after header and its body", async () => {
    const { fetch } = fakeFetch(() => errorResponse(429, { "retry-after": "7" }));
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    expect(result).toMatchObject({ kind: "http_error", status: 429, retryAfter: "7" });
    expect(Object.keys(result).sort()).toEqual(
      ["kind", "requestBytes", "responseBytes", "retryAfter", "status"].sort(),
    );
  });

  it("keeps an HTTP error's body exactly as received, to retain like any response (IMPL §4.8)", async () => {
    const text = '{"type":"error",  "error":{"type":"overloaded_error","message":"Overloaded"}}';
    const { fetch } = fakeFetch(
      () => new Response(text, { status: 529, headers: { "content-type": "application/json" } }),
    );
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    if (result.kind !== "http_error") throw new Error(result.kind);
    expect(decoder.decode(result.responseBytes)).toBe(text);
  });

  it("reports a body that fails while it is read as a connection error, sent once", async () => {
    const { fetch, captured } = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"type":"mess'));
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    expect(captured).toHaveLength(1);
    expect(result.kind).toBe("connection");
  });

  it("reports a timeout as timeout, sent once", async () => {
    const { fetch, captured } = fakeFetch(() =>
      Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
    );
    const client = createClaudeClient({ apiKey: SENTINEL_KEY, fetch });
    const result = await client.send(request());
    expect(captured).toHaveLength(1);
    expect(result.kind).toBe("timeout");
  });
});

describe("reading a body under the timeout (ADR 0003, IMPL §3.6)", () => {
  it("rejects as an abort, which the SDK reports as a timeout, when the signal fires mid-body", async () => {
    const controller = new AbortController();
    const stalled = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("{"));
        },
      }),
    );
    const read = readBody(stalled, controller.signal);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out a body that stalls, through the SDK's own timer, sent once", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, captured } = fakeFetch(
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("{"));
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const sent = createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
      await vi.advanceTimersByTimeAsync(nonStreamingTimeoutMs(16_000) + 1);
      expect((await sent).kind).toBe("timeout");
      expect(captured).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a body in chunks, byte for byte", async () => {
    const parts = ['{"a":', ' "é"', "}"];
    const body = new Response(
      new ReadableStream({
        start(c) {
          for (const part of parts) c.enqueue(new TextEncoder().encode(part));
          c.close();
        },
      }),
    );
    expect(decoder.decode(await readBody(body))).toBe(parts.join(""));
  });
});

describe("nothing from the environment reaches the request (ADR 0003)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores custom headers, another key, token or base URL, and never logs", async () => {
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      [
        "anthropic-version: 2023-06-01",
        "anthropic-beta: something-2026",
        "x-api-key: other",
        "Authorization: Bearer other",
        "accept: text/event-stream",
        "user-agent: other",
        "x-stainless-foo: other",
      ].join("\n"),
    );
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-token");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://example.invalid");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const output = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    const { fetch, captured } = fakeFetch();
    await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
    const sent = captured[0] as Captured;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.headers.get("anthropic-version")).toBe(API_VERSION);
    expect(sent.headers.get("authorization")).toBe(`Bearer ${SENTINEL_KEY}`);
    // Exactly the fixed headers, whatever the environment says.
    expect([...sent.headers.keys()].sort()).toEqual(
      [
        "accept",
        "anthropic-version",
        "authorization",
        "content-type",
        "x-stainless-timeout",
      ].sort(),
    );
    expect(sent.headers.get("accept")).toBe("application/json");
    expect([...sent.headers.values()].join("\n")).not.toMatch(/env-key|env-token|other/);
    for (const spy of output) expect(spy).not.toHaveBeenCalled();
  });
});

describe("credentials are never retained (IMPL §4.8, §4.11)", () => {
  const HEADER = {
    id: "ses_0001",
    createdAt: "2026-11-01T10:15:00.000Z",
    productVersion: "0.1.0",
    adapter: "claude-code" as const,
    outputScope: ["root CLAUDE.md"] as ["root CLAUDE.md"],
    repository: { name: "kutt", root: "/Users/dev/kutt" },
    targetPath: "CLAUDE.md" as const,
  };

  /** Records the send the way the run will: request before `started`, response with the end. */
  async function recorded(result: SendResult) {
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
    const input = retainedExchange(true, "inputs", result.requestBytes);
    const base = callDraft();
    const call = log.start(
      callDraft({
        apiVersion: API_VERSION,
        retainedInputRef: input.ref,
        inputManifest: { ...base.inputManifest, retainedInputRef: input.ref },
      }),
    );
    const output =
      "responseBytes" in result
        ? retainedExchange(true, "responses", result.responseBytes)
        : { ref: null, file: undefined };
    log.revise(
      "model_call",
      call.modelCallId,
      completedCall({
        state: result.kind === "response" ? "completed" : "failed",
        retainedResponseRef: output.ref,
        ...(result.kind === "response"
          ? {}
          : {
              error: {
                kind: "server",
                message: `HTTP ${String((result as { status?: number }).status)}`,
              },
            }),
      }),
    );
    const store = new MemorySession();
    const files = [input.file, output.file].filter((f) => f !== undefined);
    const file: SessionFile = {
      format: SESSION_FORMAT,
      schemaVersion: SESSION_SCHEMA_VERSION,
      writtenBy: "0.1.0",
      session: HEADER,
      records: [...log.records],
    };
    await saveSession(store, file, [], files);
    if (store.sessionFile === undefined) throw new Error("the session wasn't saved");
    expect(decoder.decode(store.sessionFile)).toBe(serialiseSession(file));
    // Everything written to the session directory: the session file and the retained exchanges.
    return [store.sessionFile, ...store.files.values()].map((bytes) => decoder.decode(bytes));
  }

  const forbidden = [SENTINEL_KEY, "x-api-key", "authorization", "bearer"];

  for (const [what, respond] of [
    ["a successful call", () => okResponse()],
    ["a failed call", () => errorResponse(500)],
  ] as const)
    it(`${what}: the retained request, the retained response and the session file hold no key or auth header`, async () => {
      const { fetch, captured } = fakeFetch(respond);
      const result = await createClaudeClient({ apiKey: SENTINEL_KEY, fetch }).send(request());
      // The key was sent, in a header only (SDK 1.4.0 sends it as a bearer token).
      const headers = [...(captured[0]?.headers.entries() ?? [])];
      expect(headers.some(([, value]) => value.includes(SENTINEL_KEY))).toBe(true);
      expect(captured[0]?.body).not.toContain(SENTINEL_KEY);
      const written = await recorded(result);
      // The session file, the request, and the response, an error's body included.
      expect(written).toHaveLength(3);
      for (const text of written)
        for (const value of forbidden)
          expect(text.toLowerCase()).not.toContain(value.toLowerCase());
    });
});
