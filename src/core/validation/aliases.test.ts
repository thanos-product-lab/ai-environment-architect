import { describe, expect, it } from "vitest";
import { blockRanges } from "../context/item.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import type { Hash } from "../hash.js";
import { blockAlias, CALL_ALIAS_KINDS, createAliasTable, resolveReference } from "./aliases.js";

// Aliases (IMPL §3.2.1): the model refers to records only by short aliases, and code maps each
// one to a real ID.

const HASH_A: Hash = "sha256:aaaa";
const HASH_B: Hash = "sha256:bbbb";

describe("alias tables (IMPL §3.2.1)", () => {
  it("allows each kind only in the calls the spec lists", () => {
    expect(CALL_ALIAS_KINDS).toEqual({
      analyse: ["T", "E", "B"],
      analyse_expansion: ["T", "E", "F", "C", "B"],
      generate_questions: ["F", "C", "B"],
      recommend: ["F", "C", "Q", "D", "B"],
      regenerate_recommendations: ["F", "C", "Q", "D", "R", "B"],
    });
  });

  it("uses context item IDs as rendered, and numbers the rest from 1 in the given order", () => {
    const table = createAliasTable("analyse_expansion", {
      items: ["T1-001", "T5-007", "E-1"],
      findings: ["find_b", "find_a"],
      conflicts: ["conf_x"],
      blocks: [
        { blockId: "Rules/heading", hash: HASH_A },
        { blockId: "Rules/list-item-1", hash: HASH_B },
      ],
    });
    expect(table.entries).toEqual([
      { alias: "T1-001", kind: "T", target: { kind: "item", itemId: "T1-001" } },
      { alias: "T5-007", kind: "T", target: { kind: "item", itemId: "T5-007" } },
      { alias: "E-1", kind: "E", target: { kind: "item", itemId: "E-1" } },
      { alias: "F-1", kind: "F", target: { kind: "record", recordId: "find_b" } },
      { alias: "F-2", kind: "F", target: { kind: "record", recordId: "find_a" } },
      { alias: "C-1", kind: "C", target: { kind: "record", recordId: "conf_x" } },
      {
        alias: "B-1",
        kind: "B",
        target: { kind: "block", blockId: "Rules/heading", hash: HASH_A },
      },
      {
        alias: "B-2",
        kind: "B",
        target: { kind: "block", blockId: "Rules/list-item-1", hash: HASH_B },
      },
    ]);
  });

  it("numbers B aliases exactly as the BLOCKS section renders them", () => {
    const table = createAliasTable("analyse", {
      blocks: [
        { blockId: "a", hash: HASH_A },
        { blockId: "b", hash: HASH_B },
      ],
    });
    expect(table.entries.map((entry) => entry.alias)).toEqual([blockAlias(1), blockAlias(2)]);
    expect(blockAlias(2)).toBe("B-2");
  });

  it("maps each alias the BLOCKS section shows to the block on those lines", () => {
    const bytes = new TextEncoder().encode(
      "# Rules\n\nIntro.\n\n- one\n- two\n\n## Testing\n\n```sh\npnpm test\n```\n",
    );
    const parsed = parseGuidanceBlocks(bytes);
    const shown = blockRanges(bytes, parsed.blocks);
    const table = createAliasTable("analyse", { blocks: parsed.blocks });
    expect(shown).toHaveLength(parsed.blocks.length);
    for (const line of shown) {
      const target = table.entries.find((entry) => entry.alias === line.alias)?.target;
      if (target?.kind !== "block") throw new Error(`no block for ${line.alias}`);
      const block = parsed.blocks.find((candidate) => candidate.blockId === target.blockId);
      expect(block?.hash).toBe(target.hash);
      // The block's first line, counted from its byte offset independently of blockRanges.
      const start = block?.sourceSpan.start ?? -1;
      const firstLine = bytes.subarray(0, start).filter((byte) => byte === 0x0a).length + 1;
      expect(firstLine).toBe(line.first);
    }
  });

  it("accepts a tier's 1000th item ID", () => {
    expect(createAliasTable("analyse", { items: ["T2-1000"] }).entries[0]?.alias).toBe("T2-1000");
  });

  it("gives the same table for the same input", () => {
    const sources = { items: ["T1-001"], findings: ["f_1", "f_2"] };
    expect(createAliasTable("analyse_expansion", sources)).toEqual(
      createAliasTable("analyse_expansion", sources),
    );
  });

  it("refuses a kind the call doesn't accept", () => {
    expect(() => createAliasTable("analyse", { findings: ["find_1"] })).toThrow(/F.*analyse/);
    expect(() => createAliasTable("generate_questions", { items: ["T1-001"] })).toThrow(
      /T.*generate_questions/,
    );
  });

  it("refuses a context item ID that isn't rendered form", () => {
    expect(() => createAliasTable("analyse", { items: ["T5-7"] })).toThrow(/T5-7/);
    expect(() => createAliasTable("analyse", { items: ["T4-001"] })).toThrow(/T4-001/);
    expect(() => createAliasTable("analyse", { items: ["E-01"] })).toThrow(/E-01/);
  });

  it("refuses the same item ID twice", () => {
    expect(() => createAliasTable("analyse", { items: ["T1-001", "T1-001"] })).toThrow(/T1-001/);
  });
});

describe("resolving references (IMPL §3.2.1)", () => {
  const table = createAliasTable("recommend", {
    findings: ["find_1"],
    questions: ["ques_1"],
    decisions: ["deci_1"],
  });
  const noKeys = new Set<string>();

  it("resolves an alias of an accepted kind", () => {
    expect(resolveReference(table, noKeys, "F-1", { aliases: ["F", "D"] })).toEqual({
      ok: true,
      reference: { kind: "alias", alias: "F-1", target: { kind: "record", recordId: "find_1" } },
    });
  });

  it("ALIAS-001 rejects an alias that isn't in the call's table", () => {
    expect(resolveReference(table, noKeys, "F-2", { aliases: ["F"] })).toEqual({
      ok: false,
      rule: "ALIAS-001",
      detail: "an alias not in this call's input",
    });
  });

  it("ALIAS-001 matches exactly: no case change, trimming or padding", () => {
    for (const value of ["f-1", " F-1", "F-1 ", "F-01", "F1"]) {
      expect(resolveReference(table, noKeys, value, { aliases: ["F"] })).toMatchObject({
        ok: false,
        rule: "ALIAS-001",
      });
    }
  });

  it("ALIAS-001 never repeats the unknown value in its detail", () => {
    const copied = "API_KEY = 'copied from a source file'";
    const result = resolveReference(table, noKeys, copied, { aliases: ["F"], localKeys: ["f"] });
    expect(result).toMatchObject({ ok: false, rule: "ALIAS-001" });
    expect(JSON.stringify(result)).not.toContain("copied");
  });

  it("ALIAS-003 rejects an alias of a kind the field doesn't accept", () => {
    expect(resolveReference(table, noKeys, "Q-1", { aliases: ["F", "D"] })).toEqual({
      ok: false,
      rule: "ALIAS-003",
      detail: "Q-1 is a Q alias; this field accepts F, D",
    });
  });

  it("resolves a local key defined in the same response, when the field accepts its kind", () => {
    const keys = new Set(["f1", "g1"]);
    expect(resolveReference(table, keys, "f1", { aliases: ["F"], localKeys: ["f"] })).toEqual({
      ok: true,
      reference: { kind: "local", key: "f1" },
    });
  });

  it("ALIAS-001 rejects a local key the response doesn't define", () => {
    expect(
      resolveReference(table, new Set(["f1"]), "f2", { aliases: [], localKeys: ["f"] }),
    ).toEqual({ ok: false, rule: "ALIAS-001", detail: "a local key not defined in this response" });
  });

  it("ALIAS-003 rejects a local key of the wrong kind", () => {
    expect(
      resolveReference(table, new Set(["g1"]), "g1", { aliases: ["F"], localKeys: ["f"] }),
    ).toEqual({
      ok: false,
      rule: "ALIAS-003",
      detail: "g1 is a g key; this field accepts F, f",
    });
  });

  it("doesn't treat local keys as valid where a field accepts only aliases", () => {
    expect(resolveReference(table, new Set(["f1"]), "f1", { aliases: ["F"] })).toMatchObject({
      ok: false,
      rule: "ALIAS-003",
    });
  });
});
