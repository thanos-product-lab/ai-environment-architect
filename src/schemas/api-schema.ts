import { z } from "zod";

// The JSON Schema sent to the API as `output_config.format` (IMPL §3.7). Structured outputs
// support a subset of JSON Schema (checked 24 October 2026). This keeps that subset, removes the
// limits the API can't enforce (Zod checks them after parsing), and refuses anything else, so an
// unsupported construct fails a test here instead of a request.

export type JsonSchema = { readonly [key: string]: unknown };

/** Limits the API can't enforce. Zod still checks every one of them. */
const REMOVED = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // Our own code-point limits (src/schemas/common.ts).
  "maxCodePoints",
]);

const KEPT = new Set(["type", "enum", "const", "description", "default", "required"]);

const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** The largest `{n,m}` bound we send; the API rejects "large ranges" without saying how large. */
const MAX_QUANTIFIER = 64;

/** The API's per-request limits (IMPL §3.7). One schema is sent per request. */
export const MAX_OPTIONAL = 24;
export const MAX_UNIONS = 16;

export function toApiSchema(schema: z.ZodType): JsonSchema {
  assertStrict(schema, "");
  const api = apiSchemaFromJson(z.toJSONSchema(schema) as JsonSchema);
  const stats = schemaStats(api);
  if (stats.optional > MAX_OPTIONAL)
    throw new Error(`${stats.optional} optional parameters; the API allows ${MAX_OPTIONAL}`);
  if (stats.unions > MAX_UNIONS)
    throw new Error(`${stats.unions} union parameters; the API allows ${MAX_UNIONS}`);
  return api;
}

/**
 * Zod writes `additionalProperties: false` even for a plain `z.object`, which strips unknown
 * fields instead of rejecting them, so the JSON can't show it. Every object must be strict.
 */
function assertStrict(schema: z.ZodType, at: string): void {
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  const where = at === "" ? "(root)" : at;
  const child = (value: unknown, name: string) => assertStrict(value as z.ZodType, join(at, name));
  switch (def.type) {
    case "object": {
      const catchall = def["catchall"] as z.ZodType | undefined;
      if (catchall?._zod.def.type !== "never")
        throw new Error(
          `object must reject unknown fields (additionalProperties: false) at ${where}`,
        );
      for (const [name, property] of Object.entries(def["shape"] as Record<string, z.ZodType>))
        child(property, name);
      return;
    }
    case "array":
      child(def["element"], "items");
      return;
    case "union":
      (def["options"] as z.ZodType[]).forEach((option, index) => {
        child(option, `anyOf[${index}]`);
      });
      return;
    case "optional":
      assertStrict(def["innerType"] as z.ZodType, at);
      return;
    default:
      return;
  }
}

/** Exported for tests of constructs Zod doesn't produce. Never changes `json`. */
export function apiSchemaFromJson(json: JsonSchema): JsonSchema {
  return convert(json, "");
}

function convert(node: JsonSchema, at: string): JsonSchema {
  const where = at === "" ? "(root)" : at;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (REMOVED.has(key)) continue;
    if (KEPT.has(key)) out[key] = structuredClone(value);
    else if (key === "properties") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [
          name,
          convert(child, join(at, name)),
        ]),
      );
    } else if (key === "items") out[key] = convert(value as JsonSchema, join(at, "items"));
    else if (key === "anyOf")
      out[key] = (value as JsonSchema[]).map((option, index) =>
        convert(option, `${join(at, "anyOf")}[${index}]`),
      );
    else if (key === "minItems") {
      // 0 constrains nothing; above 1 is unsupported, and Zod checks the real minimum.
      if ((value as number) >= 1) out[key] = 1;
    } else if (key === "additionalProperties") {
      if (value !== false) throw new Error(`additionalProperties must be false at ${where}`);
      out[key] = false;
    } else if (key === "pattern") out[key] = checkPattern(value as string, where);
    else if (key === "format") {
      if (!FORMATS.has(value as string)) throw new Error(`unsupported format ${value} at ${where}`);
      out[key] = value;
    } else throw new Error(`unsupported keyword ${key} at ${where}`);
  }
  if (out["type"] === "object" && out["additionalProperties"] !== false)
    throw new Error(`additionalProperties must be false at ${where}`);
  return out;
}

function checkPattern(pattern: string, where: string): string {
  const unsupported =
    /\(\?/.test(pattern) || // lookarounds and non-capturing groups
    /\\[bB]/.test(pattern) || // word boundaries
    /\\[1-9]/.test(pattern) || // backreferences
    [...pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].some(
      ([, low, high]) => Number(low) > MAX_QUANTIFIER || Number(high ?? 0) > MAX_QUANTIFIER,
    );
  if (unsupported) throw new Error(`unsupported pattern ${pattern} at ${where}`);
  return pattern;
}

function join(at: string, name: string): string {
  return at === "" ? name : `${at}.${name}`;
}

export interface SchemaStats {
  /** Object properties that are not required, across the whole schema. */
  readonly optional: number;
  /** Parameters with union types: `anyOf`, or a `type` array. */
  readonly unions: number;
}

/** The counts the API limits per request: 24 optional and 16 union parameters (IMPL §3.7). */
export function schemaStats(schema: JsonSchema): SchemaStats {
  let optional = 0;
  let unions = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if (record["anyOf"] !== undefined || Array.isArray(record["type"])) unions += 1;
      if (record["type"] === "object") {
        const properties = Object.keys((record["properties"] ?? {}) as object).length;
        optional += properties - ((record["required"] ?? []) as unknown[]).length;
      }
      for (const [key, child] of Object.entries(record))
        if (key === "properties") Object.values(child as object).forEach(visit);
        else if (key === "items" || key === "anyOf") visit(child);
    }
  };
  visit(schema);
  return { optional, unions };
}
