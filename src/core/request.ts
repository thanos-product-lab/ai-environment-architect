import type { JsonSchema } from "../schemas/api-schema.js";
import type { Known } from "./session/records.js";

// A complete model request, as code assembled it (IMPL §1.10, §3.7), and what one send of it
// returns (§3.6). The token check counts the request and the adapter sends it, so both see the
// same fields; the retry policy in core reads the result.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest {
  readonly model: string;
  /** The call's `reservedOutputTokens` (IMPL §1.10), sent as `max_tokens`. */
  readonly maxTokens: number;
  readonly effort: Effort;
  readonly system: string;
  readonly user: string;
  /**
   * The schema retry's message (IMPL §3.6): sent as a second text block of the user turn, after
   * `user`, so the rest of the request is identical. Code-written: paths and codes only.
   */
  readonly retryMessage?: string;
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
      /** Undefined when the body isn't a message, which the retry policy treats as a server error. */
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
