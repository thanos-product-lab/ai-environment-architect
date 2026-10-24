import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiSchemaFromJson, schemaStats, toApiSchema } from "./api-schema.js";
import { LIMITED } from "./common.js";

// The JSON Schema sent to the API (IMPL §3.7): only the subset structured outputs support, with
// every removed limit still checked by Zod after parsing.

describe("toApiSchema (IMPL §3.7)", () => {
  it("removes the limits the API can't enforce, and the $schema line", () => {
    const schema = z.strictObject({
      text: LIMITED.text(300),
      plain: z.string().min(1).max(5),
      many: LIMITED.list(z.string(), { min: 2, max: 6 }),
      some: LIMITED.list(z.string(), { min: 1, max: 6 }),
      count: z.number().int().min(0).max(10),
    });
    expect(toApiSchema(schema)).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        plain: { type: "string" },
        many: { type: "array", items: { type: "string" }, minItems: 1 },
        some: { type: "array", items: { type: "string" }, minItems: 1 },
        count: { type: "integer" },
      },
      required: ["text", "plain", "many", "some", "count"],
      additionalProperties: false,
    });
  });

  it("keeps patterns, enums, constants, unions and optional fields", () => {
    const schema = z.strictObject({
      key: z.string().regex(/^f[1-9][0-9]{0,3}$/),
      mode: z.enum(["descriptive", "prescriptive"]),
      scope: z.union([
        z.strictObject({ kind: z.literal("repository") }),
        z.strictObject({ kind: z.literal("paths"), paths: z.array(z.string()) }),
      ]),
      note: z.string().optional(),
    });
    expect(toApiSchema(schema)).toEqual({
      type: "object",
      properties: {
        key: { type: "string", pattern: "^f[1-9][0-9]{0,3}$" },
        mode: { type: "string", enum: ["descriptive", "prescriptive"] },
        scope: {
          anyOf: [
            {
              type: "object",
              properties: { kind: { type: "string", const: "repository" } },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "paths" },
                paths: { type: "array", items: { type: "string" } },
              },
              required: ["kind", "paths"],
              additionalProperties: false,
            },
          ],
        },
        note: { type: "string" },
      },
      required: ["key", "mode", "scope"],
      additionalProperties: false,
    });
  });

  it("refuses oneOf, which a discriminated union produces", () => {
    const schema = z.strictObject({
      value: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("a") }),
        z.strictObject({ kind: z.literal("b") }),
      ]),
    });
    expect(() => toApiSchema(schema)).toThrow(/oneOf.*value/);
  });

  it("refuses a record, whose keys the model would choose", () => {
    const schema = z.strictObject({ counts: z.record(z.string(), z.number()) });
    expect(() => toApiSchema(schema)).toThrow(/counts/);
  });

  it("refuses an object that allows unknown fields", () => {
    expect(() => toApiSchema(z.object({ a: z.string() }))).toThrow(/additionalProperties/);
    expect(() => toApiSchema(z.looseObject({ a: z.string() }))).toThrow(/additionalProperties/);
  });

  it("refuses patterns the API doesn't support", () => {
    for (const pattern of [
      /^(?=a)a$/,
      /^(?!a)b$/,
      /\bword\b/,
      /^(a)\1$/,
      /^(?:a|b)$/,
      /^a{1,500}$/,
    ]) {
      expect(() => toApiSchema(z.strictObject({ a: z.string().regex(pattern) }))).toThrow(
        /pattern/,
      );
    }
  });

  it("refuses $ref, recursion and unsupported string formats", () => {
    expect(() =>
      apiSchemaFromJson({ $ref: "#/$defs/x", $defs: { x: { type: "string" } } }),
    ).toThrow(/\$ref/);
    expect(() => apiSchemaFromJson({ type: "string", format: "binary" })).toThrow(/format/);
    expect(apiSchemaFromJson({ type: "string", format: "date-time" })).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  it("refuses allOf, $defs and additionalProperties given as a schema, which the calls don't need", () => {
    expect(() => apiSchemaFromJson({ allOf: [{ type: "string" }] })).toThrow(/allOf/);
    expect(() => apiSchemaFromJson({ type: "string", $defs: { x: { type: "string" } } })).toThrow(
      /\$defs/,
    );
    expect(() =>
      apiSchemaFromJson({
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
      }),
    ).toThrow(/additionalProperties/);
  });

  it("refuses a schema over 24 optional or 16 union parameters", () => {
    const optional = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`o${index}`, z.string().optional()]),
    );
    expect(() => toApiSchema(z.strictObject(optional))).toThrow(/25 optional/);
    const unions = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`u${index}`, z.union([z.string(), z.number()])]),
    );
    expect(() => toApiSchema(z.strictObject(unions))).toThrow(/17 union/);
    const atLimit = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`o${index}`, z.string().optional()]),
    );
    expect(() => toApiSchema(z.strictObject(atLimit))).not.toThrow();
  });

  it("refuses an unknown keyword rather than passing it on", () => {
    expect(() => apiSchemaFromJson({ type: "string", contentEncoding: "base64" })).toThrow(
      /contentEncoding/,
    );
  });

  it("names where an unsupported keyword is", () => {
    expect(() =>
      apiSchemaFromJson({
        type: "object",
        properties: { a: { type: "array", items: { not: { type: "string" } } } },
        required: ["a"],
        additionalProperties: false,
      }),
    ).toThrow(/a\.items/);
  });

  it("doesn't change the schema it is given, and gives the same result twice", () => {
    const json = {
      type: "object",
      properties: { a: { type: "string", maxLength: 3 } },
      required: ["a"],
      additionalProperties: false,
    };
    const copy = structuredClone(json);
    expect(apiSchemaFromJson(json)).toEqual(apiSchemaFromJson(json));
    expect(json).toEqual(copy);
  });
});

describe("schemaStats (IMPL §3.7)", () => {
  it("counts optional properties and union parameters, as the API's limits do", () => {
    const schema = z.strictObject({
      a: z.string().optional(),
      b: z.array(
        z.strictObject({
          c: z.union([z.literal("x"), z.strictObject({ d: z.string().optional() })]),
          e: z.string().nullable(),
        }),
      ),
    });
    expect(schemaStats(toApiSchema(schema))).toEqual({ optional: 2, unions: 2 });
  });
});
