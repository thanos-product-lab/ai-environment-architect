import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { CallPurpose } from "../core/validation/aliases.js";
import { schemaStats } from "./api-schema.js";
import { CALL_SCHEMAS, prettyJson } from "./index.js";

// The five call schemas (IMPL §3.3, §3.7). Each has a Zod response schema for the schema stage,
// item schemas with the per-item limits (LIMIT-001), and the JSON Schema sent to the API.

const CALLS: readonly CallPurpose[] = [
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
];

function fixture(call: CallPurpose, name = "valid"): Record<string, unknown> {
  const url = new URL(`../../test/fixtures/responses/${call}/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function issues(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`);
}

/** Replaces one element of a fixture's collection, keeping the rest. */
function withItem(
  call: CallPurpose,
  collection: string,
  index: number,
  change: (item: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  const value = fixture(call);
  const items = value[collection] as Record<string, unknown>[];
  items[index] = change(structuredClone(items[index] as Record<string, unknown>)) as Record<
    string,
    unknown
  >;
  return value;
}

describe("JSON Schema sent to the API (IMPL §3.7)", () => {
  // Keywords structured outputs support (checked 24 October 2026), plus `items` and `properties`.
  const ALLOWED = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "anyOf",
    "pattern",
    "minItems",
    "description",
    "default",
    "format",
  ]);

  function walk(
    node: unknown,
    visit: (node: Record<string, unknown>, path: string) => void,
    path = "",
  ): void {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    visit(record, path);
    for (const [key, child] of Object.entries(record)) {
      if (key === "properties")
        for (const [name, property] of Object.entries(child as Record<string, unknown>))
          walk(property, visit, `${path}.${name}`);
      else if (key === "anyOf")
        (child as unknown[]).forEach((option, index) => {
          walk(option, visit, `${path}.anyOf[${index}]`);
        });
      else if (key === "items") walk(child, visit, `${path}[]`);
    }
  }

  for (const call of CALLS) {
    describe(call, () => {
      const api = CALL_SCHEMAS[call].apiSchema;

      it("uses only supported keywords, with every object closed", () => {
        walk(api, (node, path) => {
          for (const key of Object.keys(node)) expect(ALLOWED, `${path}: ${key}`).toContain(key);
          if (node["type"] === "object") {
            expect(node["additionalProperties"], path).toBe(false);
            const names = Object.keys((node["properties"] ?? {}) as object);
            for (const name of (node["required"] ?? []) as string[]) expect(names).toContain(name);
          }
          if (node["minItems"] !== undefined) expect([0, 1], path).toContain(node["minItems"]);
        });
      });

      it("stays within 24 optional and 16 union parameters", () => {
        const stats = schemaStats(api);
        expect(stats.optional).toBeLessThanOrEqual(24);
        expect(stats.unions).toBeLessThanOrEqual(16);
      });

      it("is the same whether generated from the item limits or the response shape", () => {
        expect(CALL_SCHEMAS[call].apiSchemaFromShape).toEqual(api);
      });

      it("matches the committed file in src/schemas/json/", async () => {
        await expect(prettyJson(api)).toMatchFileSnapshot(`./json/${call}.json`);
      });

      it("accepts the valid recorded response, and every item passes its limits", () => {
        const value = fixture(call);
        expect(issues(CALL_SCHEMAS[call].response, value)).toEqual([]);
        for (const [collection, schema] of Object.entries(CALL_SCHEMAS[call].items))
          for (const item of value[collection] as unknown[])
            expect(issues(schema, item), collection).toEqual([]);
      });

      it("rejects an unknown field at the top level", () => {
        expect(issues(CALL_SCHEMAS[call].response, { ...fixture(call), extra: 1 })).toEqual([
          ": unrecognized_keys",
        ]);
      });
    });
  }
});

describe("versions and fingerprints (IMPL §3.7)", () => {
  for (const call of CALLS) {
    it(`${call}: the current schema is a recorded version`, () => {
      const current = {
        version: CALL_SCHEMAS[call].version,
        schemaHash: CALL_SCHEMAS[call].schemaHash,
        limitsFingerprint: CALL_SCHEMAS[call].limitsFingerprint,
      };
      expect(HISTORY[call]).toContainEqual(current);
    });
  }

  it("no version is recorded with two fingerprints", () => {
    for (const call of CALLS) {
      const versions = HISTORY[call].map((entry) => entry.version);
      expect(new Set(versions).size, call).toBe(versions.length);
    }
  });
});

// Every released schema version, append-only. Changing a schema or a limit changes a hash: add
// a new entry with a new version, never edit an old one, then run `corepack pnpm schemas:update`.
const HISTORY: Record<
  CallPurpose,
  readonly { version: string; schemaHash: string; limitsFingerprint: string }[]
> = {
  analyse: [
    {
      version: "analyse/1.0.0",
      schemaHash: "sha256:5df6b0adc41c3f69ca335bec41394d1cbf0cda469f22ba024be1eaafa5d34518",
      limitsFingerprint: "sha256:2f168fb4df7256d1054b2a8c4a79a836ed01b3f016fe5c992d439fc8bf1cc6e0",
    },
  ],
  analyse_expansion: [
    {
      version: "analyse_expansion/1.0.0",
      schemaHash: "sha256:032802a5e0a9d16c14a740f670b29b7c38ab95eb96e724d20da32c133d9d42b6",
      limitsFingerprint: "sha256:cf27dcbcb7ec675ad65eba291d62ba7bb80d5d4d316a066cc38c060abca60091",
    },
  ],
  generate_questions: [
    {
      version: "generate_questions/1.0.0",
      schemaHash: "sha256:a9944c89b648209b38642fb3e33a649383cc811d7428d029db1947c6fc7093d0",
      limitsFingerprint: "sha256:f016e043b60623a5ed7d53f139696256f7b085baee3ff3efde27c7fd96c7db7b",
    },
  ],
  recommend: [
    {
      version: "recommend/1.0.0",
      schemaHash: "sha256:5910184ac7655fefa4eedbfb0153e256e7809f28c37e0c023761b626cd42d4a7",
      limitsFingerprint: "sha256:bb02e2c3d57d91d88eedcda330e58b14cc58e5843e9f75c3b39fd6671465bde8",
    },
  ],
  regenerate_recommendations: [
    {
      version: "regenerate_recommendations/1.0.0",
      schemaHash: "sha256:a295c4b308797c9973491d4b4995fdb9d9d3ece6688571759e55cca22f5aa045",
      limitsFingerprint: "sha256:a6a40d3576ef49c10afcdbb3189142a77c45c53925bb2e3371ee01082089863a",
    },
  ],
};

describe("collection limits fail the schema stage (IMPL §3.3)", () => {
  const over: readonly [CallPurpose, string, number][] = [
    ["analyse", "findings", 40],
    ["analyse", "gaps", 15],
    ["analyse", "absenceClaims", 10],
    ["analyse", "conflicts", 10],
    ["analyse", "expansionRequests", 5],
    ["analyse", "contentNotices", 10],
    ["analyse_expansion", "findings", 20],
    ["analyse_expansion", "gaps", 10],
    ["analyse_expansion", "absenceClaims", 10],
    ["analyse_expansion", "conflicts", 10],
    ["analyse_expansion", "revisions", 20],
    ["analyse_expansion", "contentNotices", 10],
    ["generate_questions", "questions", 20],
    ["recommend", "recommendations", 15],
    ["recommend", "heldBack", 10],
    ["regenerate_recommendations", "actions", 30],
    ["regenerate_recommendations", "additions", 5],
    ["regenerate_recommendations", "heldBack", 10],
  ];
  const sample: Record<string, unknown> = {
    findings: fixture("analyse")["findings"],
    gaps: fixture("analyse")["gaps"],
    absenceClaims: fixture("analyse")["absenceClaims"],
    conflicts: fixture("analyse")["conflicts"],
    expansionRequests: fixture("analyse")["expansionRequests"],
    contentNotices: fixture("analyse")["contentNotices"],
    revisions: fixture("analyse_expansion")["revisions"],
    questions: fixture("generate_questions")["questions"],
    recommendations: fixture("recommend")["recommendations"],
    heldBack: fixture("recommend")["heldBack"],
    actions: fixture("regenerate_recommendations")["actions"],
    additions: fixture("regenerate_recommendations")["additions"],
  };

  for (const [call, collection, max] of over) {
    it(`${call}: at most ${max} ${collection}`, () => {
      const one = (sample[collection] as unknown[])[0];
      const atMax = { ...fixture(call), [collection]: Array.from({ length: max }, () => one) };
      const overMax = {
        ...fixture(call),
        [collection]: Array.from({ length: max + 1 }, () => one),
      };
      expect(accepts(CALL_SCHEMAS[call].response, atMax)).toBe(true);
      expect(issues(CALL_SCHEMAS[call].response, overMax)).toEqual([`${collection}: too_big`]);
    });
  }
});

describe("per-item limits are left to LIMIT-001 (IMPL §3.3, §3.5)", () => {
  const { response, items } = CALL_SCHEMAS.analyse;

  it("a 301-character statement passes the response shape but fails the item's limits", () => {
    const value = withItem("analyse", "findings", 0, (item) => ({
      ...item,
      statement: "x".repeat(301),
    }));
    expect(accepts(response, value)).toBe(true);
    const finding = (value["findings"] as unknown[])[0];
    expect(issues(items.findings, finding)).toEqual(["statement: custom"]);
  });

  it("counts code points, not UTF-16 units: 300 emoji are within the limit", () => {
    const finding = {
      ...(fixture("analyse")["findings"] as object[])[0],
      statement: "😀".repeat(300),
    };
    expect(issues(items.findings, finding)).toEqual([]);
    expect(issues(items.findings, { ...finding, statement: "😀".repeat(301) })).toEqual([
      "statement: custom",
    ]);
  });

  it("seven citations, or a conflict with one finding, fail only the item", () => {
    const finding = (fixture("analyse")["findings"] as Record<string, unknown[]>[])[0];
    const citation = finding?.["citations"]?.[0];
    expect(issues(items.findings, { ...finding, citations: Array(7).fill(citation) })).toEqual([
      "citations: too_big",
    ]);
    const conflict = (fixture("analyse")["conflicts"] as object[])[0];
    expect(
      accepts(response, { ...fixture("analyse"), conflicts: [{ ...conflict, findings: ["f1"] }] }),
    ).toBe(true);
    expect(issues(items.conflicts, { ...conflict, findings: ["f1"] })).toEqual([
      "findings: too_small",
    ]);
  });

  it("an empty citation list fails the response shape, which the API enforces", () => {
    const value = withItem("analyse", "findings", 0, (item) => ({ ...item, citations: [] }));
    expect(issues(response, value)).toEqual(["findings.0.citations: too_small"]);
  });
});

describe("patterns (IMPL §3.3)", () => {
  const { response } = CALL_SCHEMAS.analyse;

  it("local keys are their letter and a number from 1 to 9999", () => {
    for (const key of ["f1", "f9999", "f10"])
      expect(
        accepts(
          response,
          withItem("analyse", "findings", 0, (i) => ({ ...i, key })),
        ),
      ).toBe(true);
    for (const key of ["f0", "f10000", "F1", "g1", "f1 ", "f-1"])
      expect(
        issues(
          response,
          withItem("analyse", "findings", 0, (i) => ({ ...i, key })),
        ),
      ).toEqual(["findings.0.key: invalid_format"]);
  });

  it("line ranges are a-b", () => {
    const citation = (lines: string) =>
      withItem("analyse", "findings", 0, (i) => ({
        ...i,
        citations: [{ item: "T5-003", lines, quote: "import { describe, it } from" }],
      }));
    expect(accepts(response, citation("40-40"))).toBe(true);
    for (const lines of ["40", "0-4", "4-", "1-4,6-7", " 1-4"])
      expect(issues(response, citation(lines))).toEqual([
        "findings.0.citations.0.lines: invalid_format",
      ]);
  });

  it("expansion ranges are one or more line ranges separated by commas", () => {
    const read = (lines: string) =>
      withItem("analyse", "expansionRequests", 0, (i) => ({
        ...i,
        entries: [{ path: "a.ts", lines }],
      }));
    for (const lines of ["1-2", "20-39,97-140"]) expect(accepts(response, read(lines))).toBe(true);
    for (const lines of ["20-39,", ",1-2", "1-2;3-4"])
      expect(issues(response, read(lines))).toEqual([
        "expansionRequests.0.entries.0.lines: invalid_format",
      ]);
  });

  it("B targets are B aliases", () => {
    const target = (block: string) =>
      withItem("recommend", "recommendations", 1, (i) => ({
        ...i,
        target: { kind: "block", block },
      }));
    expect(accepts(CALL_SCHEMAS.recommend.response, target("B-12"))).toBe(true);
    for (const block of ["B-0", "F-1", "b-1", "B1"])
      expect(accepts(CALL_SCHEMAS.recommend.response, target(block))).toBe(false);
  });

  it("alias references have no pattern, so ALIAS-003 can reject a single item", () => {
    const value = withItem("recommend", "recommendations", 0, (i) => ({ ...i, support: ["Q-1"] }));
    expect(accepts(CALL_SCHEMAS.recommend.response, value)).toBe(true);
    const citation = withItem("analyse", "findings", 0, (i) => ({
      ...i,
      citations: [{ item: "not an alias", lines: "1-1", quote: "import { describe, it } from" }],
    }));
    expect(accepts(response, citation)).toBe(true);
  });
});

describe("unions for conditional fields (IMPL §3.3.3, §3.3.6)", () => {
  it("a replace needs its replacement, and a withdraw has none", () => {
    const { response } = CALL_SCHEMAS.analyse_expansion;
    const replace = withItem(
      "analyse_expansion",
      "revisions",
      1,
      ({ replacement: _, ...rest }) => rest,
    );
    expect(accepts(response, replace)).toBe(false);
    const withdraw = withItem("analyse_expansion", "revisions", 0, (i) => ({
      ...i,
      replacement: "f1",
    }));
    expect(accepts(response, withdraw)).toBe(false);
  });

  it("a revise needs its revision, and a keep or drop has none", () => {
    const { response } = CALL_SCHEMAS.regenerate_recommendations;
    const revise = withItem(
      "regenerate_recommendations",
      "actions",
      2,
      ({ revision: _, ...rest }) => rest,
    );
    expect(accepts(response, revise)).toBe(false);
    const revision = (
      fixture("regenerate_recommendations")["actions"] as Record<string, unknown>[]
    )[2]?.["revision"];
    const keep = withItem("regenerate_recommendations", "actions", 0, (i) => ({ ...i, revision }));
    expect(accepts(response, keep)).toBe(false);
  });

  it("a recommendation's operation and target are not tied by the schema; REC-002 checks them", () => {
    const value = withItem("recommend", "recommendations", 3, (i) => ({
      ...i,
      target: { kind: "after", block: "B-1" },
    }));
    expect(accepts(CALL_SCHEMAS.recommend.response, value)).toBe(true);
  });

  it("noChangeReason is optional, with its limit", () => {
    const { response } = CALL_SCHEMAS.recommend;
    expect(
      accepts(response, {
        recommendations: [],
        heldBack: [],
        noChangeReason: "Nothing to change.",
      }),
    ).toBe(true);
    expect(
      issues(response, { recommendations: [], heldBack: [], noChangeReason: "x".repeat(401) }),
    ).toEqual(["noChangeReason: custom"]);
  });
});
