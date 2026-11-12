import type { JsonSchema } from "../schemas/api-schema.js";

// A complete model request, as code assembled it (IMPL §1.10, §3.7). The token check counts it
// and the adapter sends it, so both see the same fields.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest {
  readonly model: string;
  /** The call's `reservedOutputTokens` (IMPL §1.10), sent as `max_tokens`. */
  readonly maxTokens: number;
  readonly effort: Effort;
  readonly system: string;
  readonly user: string;
  /** The call's committed JSON Schema, `CALL_SCHEMAS[call].apiSchema`. */
  readonly schema: JsonSchema;
}
