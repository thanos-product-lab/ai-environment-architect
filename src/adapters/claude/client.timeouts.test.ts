import { Duplex } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import {
  agentOptions,
  createClaudeClient,
  type MessageRequest,
  nonStreamingTimeoutMs,
} from "./client.js";

// The HTTP agent's timeouts (ADR 0003): Node's built-in fetch gives up after 300 seconds without
// headers, so the adapter's own undici Agent has the send's timeout. A fake server on an
// in-memory socket answers on fake time; no port is opened and no live model is called.

/** Built from fragments, so no committed file looks like a credential (IMPL §1.7). */
const SENTINEL_KEY = ["sk", "ant", "sentinel", "0123456789abcdefSENTINEL"].join("-");
const decoder = new TextDecoder();

const MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5-20261101",
  content: [{ type: "text", text: '{"findings":[]}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

function request(maxTokens = 16_000): MessageRequest {
  return {
    model: "claude-opus-5-5",
    maxTokens,
    effort: "medium",
    system: "You analyse repositories.",
    user: "<context>…</context>",
    schema: CALL_SCHEMAS.analyse.apiSchema,
  };
}

/**
 * A fake server on an in-memory socket, so no port is opened: it answers the first request with
 * `response` after `delayMs` of (fake) time, and records the raw request it received.
 */
function fakeServer(delayMs: number, response = okHttp()) {
  const received: string[] = [];
  /** When the client closed the socket, on the fake clock. */
  const closed: { at?: number } = {};
  const connect = (_options: unknown, callback: (error: Error | null, socket: Duplex) => void) => {
    let answered = false;
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        received.push(String(chunk));
        if (!answered) {
          answered = true;
          setTimeout(() => socket.push(response), delayMs);
        }
        done();
      },
      destroy(error, callback) {
        closed.at ??= Date.now();
        callback(error);
      },
    });
    // What undici asks of a TCP socket, none of which matters in memory.
    Object.assign(socket, {
      setNoDelay: () => socket,
      setKeepAlive: () => socket,
      setTimeout: () => socket,
      ref: () => socket,
      unref: () => socket,
      remoteAddress: "127.0.0.1",
      alpnProtocol: false,
    });
    queueMicrotask(() => callback(null, socket));
    return socket;
  };
  return { connect: connect as never, received, closed };
}

function okHttp(): string {
  const body = JSON.stringify(MESSAGE);
  return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

// undici keeps one shared timer for every connection's timeouts, started on first use. So fake
// time is on for this whole file: a test that switched back to real time would leave that timer
// on a discarded fake clock, and every later test here would pass whatever the timeouts were.
beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});

describe("the HTTP agent's timeouts match the send's (ADR 0003)", () => {
  /** Advances fake time a second at a time, so undici's own timers fire in order. */
  async function advance(ms: number) {
    for (let t = 0; t < ms; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
  }

  it("gives undici's header and body timeouts the send's own timeout", () => {
    expect(agentOptions(nonStreamingTimeoutMs(16_000))).toEqual({
      headersTimeout: 600_000,
      bodyTimeout: 600_000,
    });
    expect(agentOptions(nonStreamingTimeoutMs(64_000))).toEqual({
      headersTimeout: 1_800_000,
      bodyTimeout: 1_800_000,
    });
  });

  it("why: undici's defaults give up on headers after 5 minutes", async () => {
    const { connect } = fakeServer(301_000);
    const agent = new Agent({ connect });
    const outcome = undiciFetch("http://api.test/", { dispatcher: agent }).then(
      () => "answered",
      (error: { cause?: { code?: string } }) => error.cause?.code,
    );
    await advance(302_000);
    expect(await outcome).toBe("UND_ERR_HEADERS_TIMEOUT");
    await agent.destroy();
  });

  it("receives headers sent after more than 5 minutes of fake time", async () => {
    const server = fakeServer(301_000);
    const sent = createClaudeClient({ apiKey: SENTINEL_KEY, connect: server.connect }).send(
      request(),
    );
    await advance(302_000);
    const result = await sent;
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.message?.returnedModel).toBe(MESSAGE.model);
    // The real undici fetch sent our exact body bytes.
    expect(server.received.join("")).toContain(decoder.decode(result.requestBytes));
  });

  it("with a raised output limit, waits the longer timeout too", async () => {
    const server = fakeServer(1_000_000);
    const sent = createClaudeClient({ apiKey: SENTINEL_KEY, connect: server.connect }).send(
      request(64_000),
    );
    await advance(1_001_000);
    expect((await sent).kind).toBe("response");
  });

  it("the SDK's abort reaches undici: the socket closes at the send's deadline, before undici's own timer", async () => {
    const timeoutMs = nonStreamingTimeoutMs(16_000);
    const server = fakeServer(timeoutMs + 60_000);
    const start = Date.now();
    const sent = createClaudeClient({ apiKey: SENTINEL_KEY, connect: server.connect }).send(
      request(),
    );
    // undici's timers fire on a coarse tick, up to about half a second late; the SDK's fires on
    // time. So 1 ms past the deadline, only the SDK's abort can have closed the socket.
    await advance(timeoutMs - 1_000);
    expect(server.closed.at).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await sent).kind).toBe("timeout");
    expect(server.closed.at).toBeDefined();
    expect((server.closed.at ?? 0) - start).toBeLessThanOrEqual(timeoutMs + 1);
  });

  it("sends our fixed headers on the wire through the real undici fetch, and none from the environment", async () => {
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      ["anthropic-version: 2023-06-01", "anthropic-beta: x-2026", "x-api-key: other"].join("\n"),
    );
    try {
      const server = fakeServer(0);
      const sent = createClaudeClient({ apiKey: SENTINEL_KEY, connect: server.connect }).send(
        request(),
      );
      await advance(1_000);
      expect((await sent).kind).toBe("response");
      const raw = server.received.join("");
      const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
      const headers = head
        .split("\r\n")
        .slice(1)
        .map((line) => line.slice(0, line.indexOf(":")).toLowerCase());
      expect(head.split("\r\n")[0]).toBe("POST /v1/messages HTTP/1.1");
      // Ours, then those undici adds itself, which carry nothing of ours.
      expect(headers).toEqual(
        expect.arrayContaining([
          "accept",
          "anthropic-version",
          "authorization",
          "content-type",
          "x-stainless-timeout",
        ]),
      );
      for (const name of ["anthropic-beta", "x-api-key"]) expect(headers, name).not.toContain(name);
      expect(head).toContain("anthropic-version: 2026-10-21");
      // The key appears once, as the bearer token, and nowhere in the body.
      expect(raw.split(SENTINEL_KEY)).toHaveLength(2);
      expect(head).toContain(`authorization: Bearer ${SENTINEL_KEY}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still times out once the send's own timeout passes", async () => {
    const server = fakeServer(nonStreamingTimeoutMs(16_000) + 60_000);
    const sent = createClaudeClient({ apiKey: SENTINEL_KEY, connect: server.connect }).send(
      request(),
    );
    await advance(nonStreamingTimeoutMs(16_000) + 2_000);
    expect((await sent).kind).toBe("timeout");
  });
});
