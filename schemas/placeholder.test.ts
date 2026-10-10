import { describe, expect, it } from "vitest";
import { z } from "zod";
import { placeholder } from "./placeholder.js";

describe("schema placeholder", () => {
  it("generates JSON Schema from a Zod schema", () => {
    expect(z.toJSONSchema(placeholder)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });
});
