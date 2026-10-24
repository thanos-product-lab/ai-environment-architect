import { z } from "zod";
import { canonicalJson } from "../core/context/select.js";
import { type Hash, sha256 } from "../core/hash.js";
import type { CallPurpose } from "../core/validation/aliases.js";
import { analyse } from "./analyse.js";
import { analyseExpansion } from "./analyse_expansion.js";
import { type JsonSchema, toApiSchema } from "./api-schema.js";
import { LENGTH_UNIT } from "./common.js";
import { generateQuestions } from "./generate_questions.js";
import { recommend } from "./recommend.js";
import { regenerateRecommendations } from "./regenerate_recommendations.js";

// The schema of every call (IMPL §3.3, §3.7), with what each model call records.

interface Definition<R extends z.ZodType, I> {
  readonly version: string;
  /** Checked at the schema stage: the API's shape, plus collection sizes. */
  readonly response: R;
  /** The same, with every per-item limit; covered by the fingerprint. */
  readonly limited: z.ZodType;
  /** Each collection's item with its limits, for LIMIT-001. */
  readonly items: I;
}

function describe<R extends z.ZodType, I>(definition: Definition<R, I>) {
  const apiSchema = toApiSchema(definition.limited);
  return {
    version: definition.version,
    response: definition.response,
    items: definition.items,
    /** Sent unchanged as `output_config.format` (IMPL §3.7). */
    apiSchema,
    /** Generated from the response shape instead; a test checks it equals `apiSchema`. */
    apiSchemaFromShape: toApiSchema(definition.response),
    schemaHash: hashJson(apiSchema),
    /** Covers the limits only Zod checks, so changing one without a new version fails a test. */
    limitsFingerprint: hashJson({
      lengthUnit: LENGTH_UNIT,
      schema: z.toJSONSchema(definition.limited) as JsonSchema,
    }),
  };
}

function hashJson(value: unknown): Hash {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
}

export const CALL_SCHEMAS = {
  analyse: describe(analyse),
  analyse_expansion: describe(analyseExpansion),
  generate_questions: describe(generateQuestions),
  recommend: describe(recommend),
  regenerate_recommendations: describe(regenerateRecommendations),
} satisfies Record<CallPurpose, unknown>;

/**
 * The committed files' format: the schema's own property order, which is the order the model
 * writes fields in, with a two-space indent and a final line break. `schemaHash` sorts keys
 * instead, so it doesn't depend on serialisation.
 */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
