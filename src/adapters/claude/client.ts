import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { Known } from "../../core/session/records.js";
import type { JsonSchema } from "../../schemas/api-schema.js";

// The Claude API adapter (ADR 0003, IMPL §3.7, §4.8). The only code that calls the Claude API.
//
// - One send per request: the SDK's retries are off, so every send can be its own model call,
//   recorded before it is sent (IMPL §4.6). The retry policy (§3.6) is the caller's.
// - Our committed JSON Schema goes unchanged as `output_config.format`, never through the SDK's
//   schema helpers, which rewrite schemas.
// - Non-streaming, read with `.asResponse()`, so the response body is kept as the bytes received.
// - `timeout` is always passed, so a raised output limit doesn't hit the SDK's refusal of a
//   non-streaming request expected to take over 10 minutes.
// - No sampling parameters, no `thinking` (adaptive by default), no refusal fallbacks.
// - Nothing the SDK reads from the environment reaches the request: the key, token and base
//   URL are passed, logging is off, and a `fetch` wrapper sends only fixed headers, so
//   `ANTHROPIC_CUSTOM_HEADERS` can't change the API version, add a beta or replace the key.
// - The wrapper reads every body, an HTTP error's too, under the SDK's abort signal, so the
//   timeout covers the whole response and its bytes are kept (IMPL §4.8).
// - Only bodies, and an error's `retry-after` value, are returned; never a credential.

/** The `anthropic-version` every 1.x SDK sends (ADR 0003). A test checks the header. */
export const API_VERSION = "2026-10-21";

const BASE_URL = "https://api.anthropic.com";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A complete request: what code assembled, with the call's settings. */
export interface MessageRequest {
  readonly model: string;
  /** The call's `reservedOutputTokens` (IMPL §1.10). */
  readonly maxTokens: number;
  readonly effort: Effort;
  readonly system: string;
  readonly user: string;
  /** The call's committed JSON Schema, `CALL_SCHEMAS[call].apiSchema`. */
  readonly schema: JsonSchema;
}

/** What a 200 response says, read for the model call's record. Never the refusal's explanation. */
export interface ReadMessage {
  readonly returnedModel: string;
  readonly stopReason: string | null;
  /** With `stopReason: "refusal"`: the API's `stop_details.category`, if it gives one. */
  readonly refusalCategory?: string;
  /** Every `text` block, in order. Thinking blocks are ignored (IMPL §3.7). */
  readonly textBlocks: readonly string[];
  /** The type of every block that is neither `text` nor thinking. */
  readonly otherBlocks: readonly string[];
  readonly usage: {
    readonly input: Known<number>;
    readonly output: Known<number>;
    readonly cacheRead: Known<number>;
    readonly cacheWrite: Known<number>;
  };
}

export type SendResult =
  | {
      readonly kind: "response";
      readonly requestBytes: Uint8Array;
      /** The body exactly as received, to retain for replay (IMPL §4.8). */
      readonly responseBytes: Uint8Array;
      /** Undefined when the body isn't a message, which the caller treats as a failed call. */
      readonly message: ReadMessage | undefined;
    }
  | {
      readonly kind: "http_error";
      readonly requestBytes: Uint8Array;
      /** The error body exactly as received; it is retained like any response (IMPL §4.8). */
      readonly responseBytes: Uint8Array;
      readonly status: number;
      /** The `retry-after` header as sent, if any; the retry policy reads it (IMPL §3.6). */
      readonly retryAfter?: string;
    }
  | { readonly kind: "connection" | "timeout"; readonly requestBytes: Uint8Array };

/** The body sent: exactly these fields, so nothing else can reach the API. */
export function messageBody(request: MessageRequest): MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    output_config: {
      effort: request.effort,
      format: { type: "json_schema", schema: request.schema as Record<string, unknown> },
    },
  };
}

/**
 * The bytes the SDK sends for `body`: it serialises a JSON body with `JSON.stringify`. The
 * contract test checks they equal what `fetch` receives.
 */
export function bodyBytes(body: MessageCreateParamsNonStreaming): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * The SDK's own allowance for a non-streaming request: the larger of 10 minutes and
 * 3600 × max_tokens / 128000 seconds (ADR 0003), in whole milliseconds.
 */
export function nonStreamingTimeoutMs(maxTokens: number): number {
  return Math.max(600_000, Math.ceil((3_600_000 * maxTokens) / 128_000));
}

export interface ClientOptions {
  /** Passed explicitly, so the SDK never reads a key or token from the environment. */
  readonly apiKey: string;
  /** Tests inject one; no live model is called in tests. */
  readonly fetch?: Fetch;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClaudeClient {
  send(request: MessageRequest): Promise<SendResult>;
}

/** Statuses whose response can't have a body, so it is rebuilt with none. */
const NO_BODY = new Set([101, 204, 205, 304]);

export function createClaudeClient(options: ClientOptions): ClaudeClient {
  const inner: Fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async send(request) {
      const body = messageBody(request);
      const requestBytes = bodyBytes(body);
      /** The body of the one response this send gets, as received. */
      let received: Uint8Array | undefined;
      const fetch: Fetch = async (input, init) => {
        const timeoutMs = nonStreamingTimeoutMs(request.maxTokens);
        const response = await inner(input, {
          ...init,
          headers: sentHeaders(options.apiKey, timeoutMs),
        });
        received = await readBody(response, init?.signal ?? undefined);
        return new Response(NO_BODY.has(response.status) ? null : received.slice(), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      // One client per send, so the wrapper's `received` belongs to this send only.
      const sdk = new Anthropic({
        apiKey: options.apiKey,
        authToken: null,
        baseURL: BASE_URL,
        maxRetries: 0,
        openTelemetry: false,
        logLevel: "off",
        fetch,
      });
      try {
        await sdk.messages
          .create(body, { timeout: nonStreamingTimeoutMs(request.maxTokens) })
          .asResponse();
        if (received === undefined) throw new Error("the response body wasn't read");
        return {
          kind: "response",
          requestBytes,
          responseBytes: received,
          message: readMessage(received),
        };
      } catch (error) {
        // A timeout is a connection error in the SDK, so it is tested first.
        if (error instanceof APIConnectionTimeoutError) return { kind: "timeout", requestBytes };
        if (error instanceof APIConnectionError) return { kind: "connection", requestBytes };
        if (error instanceof APIError && typeof error.status === "number") {
          if (received === undefined) throw new Error("the error body wasn't read");
          const retryAfter = error.headers?.get("retry-after") ?? undefined;
          return {
            kind: "http_error",
            requestBytes,
            responseBytes: received,
            status: error.status,
            ...(retryAfter === undefined ? {} : { retryAfter }),
          };
        }
        throw error;
      }
    },
  };
}

/**
 * The headers sent, every one a fixed value: the SDK merges `ANTHROPIC_CUSTOM_HEADERS` over its
 * own, so nothing it built is copied. The key goes as SDK 1.4.0 sends it, and
 * `x-stainless-timeout` tells the server the client's timeout, as the SDK does.
 */
function sentHeaders(apiKey: string, timeoutMs: number): Headers {
  return new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": API_VERSION,
    authorization: `Bearer ${apiKey}`,
    "x-stainless-timeout": String(Math.trunc(timeoutMs / 1000)),
  });
}

/**
 * The whole body, or a rejection: an abort (the SDK's timeout) rejects with an `AbortError`,
 * which the SDK reports as a timeout, and a failed read rejects as a connection error does.
 */
export async function readBody(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const aborted = () =>
    Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    throw aborted();
  }
  const chunks: Uint8Array[] = [];
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => {
      // Rejected first: cancelling resolves the pending read as done, which must not win.
      reject(aborted());
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      if (signal?.aborted) throw aborted();
      // `onAbort` rejects before it cancels, so the abort wins over the read cancel resolves.
      const { done, value } = await Promise.race([abort, reader.read()]);
      if (done) break;
      chunks.push(value);
    }
  } catch (error) {
    if ((error as { name?: unknown }).name === "AbortError") throw error;
    throw new TypeError("the response body couldn't be read", { cause: error });
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

const count = z.int().min(0);

/** Only the fields read; others are allowed, since the API may add fields. */
const message = z.object({
  type: z.literal("message"),
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  stop_details: z.object({ category: z.string().nullable().optional() }).nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: count.nullable().optional(),
    output_tokens: count.nullable().optional(),
    cache_read_input_tokens: count.nullable().optional(),
    cache_creation_input_tokens: count.nullable().optional(),
  }),
});

const THINKING = new Set(["thinking", "redacted_thinking"]);

function readMessage(bytes: Uint8Array): ReadMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const parsed = message.safeParse(json);
  if (!parsed.success) return undefined;
  const m = parsed.data;
  const textBlocks: string[] = [];
  const otherBlocks: string[] = [];
  for (const block of m.content)
    if (block.type === "text" && block.text !== undefined) textBlocks.push(block.text);
    // A text block without text isn't one the caller can read, so it is counted with the rest.
    else if (!THINKING.has(block.type)) otherBlocks.push(block.type);
  const category = m.stop_details?.category ?? undefined;
  return {
    returnedModel: m.model,
    stopReason: m.stop_reason,
    ...(m.stop_reason === "refusal" && category !== undefined ? { refusalCategory: category } : {}),
    textBlocks,
    otherBlocks,
    usage: {
      input: reported(m.usage.input_tokens),
      output: reported(m.usage.output_tokens),
      cacheRead: reported(m.usage.cache_read_input_tokens),
      cacheWrite: reported(m.usage.cache_creation_input_tokens),
    },
  };
}

/** Unknown is never zero: a count the API didn't report is unknown. */
function reported(value: number | null | undefined): Known<number> {
  return value === null || value === undefined
    ? { state: "unknown", reason: "not_reported" }
    : { state: "known", value };
}
