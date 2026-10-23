import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AliasTable, createAliasTable, resolveReference } from "./aliases.js";
import {
  accept,
  type CallValidator,
  RULE_IDS,
  reject,
  VALIDATOR_VERSION,
  validateResponse,
} from "./pipeline.js";

// The validation pipeline (IMPL §3.5), driven by a small invented call. Its rules (TEST-*) stand
// in for the per-call rules that later steps add; only SCHEMA and ALIAS-* are real.

const note = z.strictObject({
  key: z.string(),
  text: z.string(),
  refs: z.array(z.string()),
  citations: z.array(z.string()).optional(),
});
const link = z.strictObject({ key: z.string(), notes: z.array(z.string()) });
const flag = z.strictObject({ text: z.string() });
const schema = z.strictObject({
  notes: z.array(note),
  links: z.array(link),
  flags: z.array(flag),
});
type Response = z.infer<typeof schema>;
type Note = z.infer<typeof note>;
type Link = z.infer<typeof link>;
type Flag = z.infer<typeof flag>;

interface Context {
  readonly aliases: AliasTable;
}

const call: CallValidator<Response, Context, { notes: Note; links: Link; flags: Flag }> = {
  schema,
  order: ["notes", "links", "flags"],
  collections: {
    notes: {
      items: (response) => response.notes,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [
        (item, context, response) => {
          for (const ref of item.refs) {
            const resolved = resolveReference(context.aliases, response.localKeys, ref, {
              aliases: ["F"],
            });
            if (!resolved.ok) return reject(resolved.rule, resolved.detail);
          }
          return accept(item);
        },
        // Drops citations that aren't "good", like a citation rule rejecting one citation.
        (item) => {
          const citations = item.citations ?? [];
          const kept = citations.filter((citation) => citation === "good");
          const events = citations.flatMap((citation, index) =>
            citation === "good"
              ? []
              : [
                  {
                    rule: "TEST-CITE",
                    outcome: "rejected" as const,
                    detail: "not good",
                    subKey: `citations/${index}`,
                  },
                ],
          );
          if (citations.length > 0 && kept.length === 0)
            return reject("TEST-CITE-NONE", "no citation left", ...events);
          return accept({ ...item, citations: kept }, ...events);
        },
        (item) => (item.text === "" ? reject("TEST-EMPTY", "empty text") : accept(item)),
        (item) =>
          item.text.startsWith(" ")
            ? accept(
                { ...item, text: item.text.trimStart() },
                {
                  rule: "TEST-FIX",
                  outcome: "corrected",
                  detail: "trimmed",
                  original: { text: item.text },
                },
              )
            : accept(item),
        (item) =>
          item.text === "maybe"
            ? accept(item, { rule: "TEST-LABEL", outcome: "relabelled", detail: "relabelled" })
            : accept(item),
      ],
    },
    links: {
      items: (response) => response.links,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [
        (item, _context, response) => {
          for (const ref of item.notes) {
            const resolved = resolveReference(_context.aliases, response.localKeys, ref, {
              aliases: ["F"],
              localKeys: ["n"],
            });
            if (!resolved.ok) return reject(resolved.rule, resolved.detail);
          }
          return accept(item);
        },
      ],
    },
    flags: {
      items: (response) => response.flags,
      key: () => ({ kind: "position" }),
      checks: [(item) => (item.text === "bad" ? reject("TEST-FLAG", "bad flag") : accept(item))],
    },
  },
  crossItem: [
    // Like CONF-001: a link needs at least two of its local notes to have survived.
    (surviving) => {
      const notes = new Set(surviving.notes.map((item) => item.key));
      // Returned last first, to show the pipeline puts events in item order.
      return surviving.links
        .filter((item) => item.value.notes.filter((ref) => notes.has(ref)).length < 2)
        .map((item) => ({
          collection: "links" as const,
          index: item.index,
          rule: "TEST-LINK",
          detail: "fewer than two notes survived",
        }))
        .reverse();
    },
    (surviving) =>
      surviving.flags.length > 1
        ? surviving.flags.slice(1).map((item) => ({
            collection: "flags" as const,
            index: item.index,
            rule: "TEST-ONE-FLAG",
            detail: "only one flag",
          }))
        : [],
    (surviving) =>
      surviving.notes
        .filter((item) => item.value.text === "drop")
        .map((item) => ({
          collection: "notes" as const,
          index: item.index,
          rule: "TEST-DROP",
          detail: "dropped",
        })),
  ],
};

const context: Context = {
  aliases: createAliasTable("analyse_expansion", { findings: ["find_1", "find_2"] }),
};

function run(response: unknown) {
  return validateResponse(call, JSON.stringify(response), context);
}

const n = (key: string, text = "ok", extra: Partial<Note> = {}): Note => ({
  key,
  text,
  refs: [],
  ...extra,
});

describe("validator version (IMPL §3.5)", () => {
  it("pins the rule list to validate/0.1.0", () => {
    expect({ version: VALIDATOR_VERSION, rules: RULE_IDS }).toEqual({
      version: "validate/0.1.0",
      rules: ["SCHEMA", "ALIAS-001", "ALIAS-002", "ALIAS-003"],
    });
  });

  it("records the validator version on every result", () => {
    expect(run({ notes: [], links: [], flags: [] }).validatorVersion).toBe("validate/0.1.0");
    expect(validateResponse(call, "not json", context).validatorVersion).toBe("validate/0.1.0");
  });
});

describe("schema stage (IMPL §3.5, §3.6)", () => {
  it("SCHEMA rejects text that isn't JSON, as the whole response", () => {
    const result = validateResponse(call, "{ nope", context);
    expect(result.status).toBe("schema_failed");
    expect(result.events).toEqual([
      {
        itemKey: "$response",
        stage: "schema",
        rule: "SCHEMA",
        outcome: "rejected",
        detail: "(root): invalid_json",
      },
    ]);
    if (result.status === "schema_failed")
      expect(result.issues).toEqual([{ path: "", code: "invalid_json" }]);
  });

  it("SCHEMA rejects unknown fields and wrong types, one event per issue with path and code", () => {
    const result = run({
      notes: [{ key: "n1", text: 5, refs: [], extra: true }],
      links: [],
      flags: [],
    });
    expect(result.status).toBe("schema_failed");
    if (result.status !== "schema_failed") return;
    expect(result.issues).toEqual([
      { path: "notes.0.text", code: "invalid_type" },
      { path: "notes.0", code: "unrecognized_keys" },
    ]);
    expect(result.events.map((event) => event.detail)).toEqual([
      "notes.0.text: invalid_type",
      "notes.0: unrecognized_keys",
    ]);
    expect(result.events.every((event) => event.itemKey === "$response")).toBe(true);
  });

  it("SCHEMA never copies the received value into an event or issue", () => {
    const leaked = "const token = 'SOURCE_TEXT_COPIED_BY_THE_MODEL'";
    const result = run({ notes: [{ key: "n1", text: [leaked], refs: [] }], links: [], flags: [] });
    expect(result.status).toBe("schema_failed");
    expect(JSON.stringify(result)).not.toContain("SOURCE_TEXT_COPIED_BY_THE_MODEL");
    const field = run({ notes: [], links: [], flags: [], [leaked]: 1 });
    expect(JSON.stringify(field)).not.toContain("SOURCE_TEXT_COPIED_BY_THE_MODEL");
  });

  it("SCHEMA withholds path segments the model chose, such as record keys", () => {
    const keyed: CallValidator<{ counts: Record<string, number> }, Context, { none: never }> = {
      schema: z.strictObject({ counts: z.record(z.string(), z.number()) }),
      order: ["none"],
      collections: { none: { items: () => [], key: () => ({ kind: "position" }), checks: [] } },
      crossItem: [],
    };
    const result = validateResponse(
      keyed,
      JSON.stringify({ counts: { "SECRET source line": "x" } }),
      context,
    );
    if (result.status !== "schema_failed") throw new Error(result.status);
    expect(result.issues).toEqual([{ path: "counts.<key>", code: "invalid_type" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("records the proposed count as unknown after a schema failure, and tallies SCHEMA", () => {
    const result = run({ notes: "wrong", links: [], flags: 1 });
    expect(result.counts).toEqual({
      proposed: { state: "unknown", reason: "schema_failed" },
      accepted: 0,
      corrected: 0,
      relabelled: 0,
      rejectionsByRule: [{ rule: "SCHEMA", count: 2 }],
    });
  });

  it("accepts nothing and runs no item rule when the schema fails", () => {
    const result = run({ notes: [n("n1", "")], links: [], flags: "wrong" });
    expect(result.status).toBe("schema_failed");
    expect(result.events.every((event) => event.stage === "schema")).toBe(true);
    expect("accepted" in result).toBe(false);
  });
});

describe("item stage (IMPL §3.5)", () => {
  it("accepts a valid response completely", () => {
    const result = run({
      notes: [n("n1"), n("n2", "fine", { refs: ["F-2"] })],
      links: [{ key: "l1", notes: ["n1", "n2"] }],
      flags: [{ text: "fine" }],
    });
    expect(result.status).toBe("validated");
    if (result.status !== "validated") return;
    expect(result.events).toEqual([]);
    expect(result.accepted.notes.map((item) => item.key)).toEqual(["n1", "n2"]);
    expect(result.accepted.links.map((item) => item.key)).toEqual(["l1"]);
    expect(result.accepted.flags).toEqual([
      { key: "flags/0", index: 0, value: { text: "fine" }, corrected: false, relabelled: false },
    ]);
    expect(result.counts).toEqual({
      proposed: { state: "known", count: 4 },
      accepted: 4,
      corrected: 0,
      relabelled: 0,
      rejectionsByRule: [],
    });
  });

  it("drops an item at its first failed rule and runs no later rule on it", () => {
    // "" fails TEST-EMPTY, so TEST-FIX never runs on it.
    const result = run({ notes: [n("n1", ""), n("n2", " x")], links: [], flags: [] });
    expect(result.status).toBe("validated");
    if (result.status !== "validated") return;
    expect(result.events).toEqual([
      {
        itemKey: "n1",
        stage: "item",
        rule: "TEST-EMPTY",
        outcome: "rejected",
        detail: "empty text",
      },
      {
        itemKey: "n2",
        stage: "item",
        rule: "TEST-FIX",
        outcome: "corrected",
        detail: "trimmed",
        original: { text: " x" },
      },
    ]);
  });

  it("keeps a corrected or relabelled item, with the changed value, and counts it", () => {
    const result = run({ notes: [n("n1", " x"), n("n2", "maybe")], links: [], flags: [] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes.map((item) => item.value.text)).toEqual(["x", "maybe"]);
    expect(result.accepted.notes.map((item) => [item.corrected, item.relabelled])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(result.counts).toMatchObject({ accepted: 2, corrected: 1, relabelled: 1 });
  });

  it("names a dropped citation as a sub-item, and keeps the finding with the rest", () => {
    const result = run({
      notes: [n("n1", "ok", { citations: ["good", "bad", "good", "bad"] })],
      links: [],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.map((event) => [event.itemKey, event.rule, event.outcome])).toEqual([
      ["n1/citations/1", "TEST-CITE", "rejected"],
      ["n1/citations/3", "TEST-CITE", "rejected"],
    ]);
    expect(result.accepted.notes[0]?.value.citations).toEqual(["good", "good"]);
    expect(result.counts).toMatchObject({
      accepted: 1,
      rejectionsByRule: [{ rule: "TEST-CITE", count: 2 }],
    });
  });

  it("keeps each failed citation's event when the finding is dropped for having none left", () => {
    const result = run({
      notes: [n("n1", "ok", { citations: ["bad", "bad"] })],
      links: [],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes).toEqual([]);
    expect(result.events.map((event) => [event.itemKey, event.rule])).toEqual([
      ["n1/citations/0", "TEST-CITE"],
      ["n1/citations/1", "TEST-CITE"],
      ["n1", "TEST-CITE-NONE"],
    ]);
  });

  it("names an item with a malformed local key by position, and lets it define nothing", () => {
    const result = run({
      notes: [n("n 1"), n("nnn1", ""), n("n1")],
      links: [{ key: "l1", notes: ["n 1", "n1"] }],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes.map((item) => item.key)).toEqual(["notes/0", "n1"]);
    expect(result.events.map((event) => [event.itemKey, event.rule, event.detail])).toEqual([
      ["notes/1", "TEST-EMPTY", "empty text"],
      ["l1", "ALIAS-001", "an alias not in this call's input"],
    ]);
  });

  it("ALIAS-001 rejects an item that uses an alias missing from the call's input", () => {
    const result = run({ notes: [n("n1", "ok", { refs: ["F-3"] })], links: [], flags: [] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes).toEqual([]);
    expect(result.events).toEqual([
      {
        itemKey: "n1",
        stage: "item",
        rule: "ALIAS-001",
        outcome: "rejected",
        detail: "an alias not in this call's input",
      },
    ]);
  });

  it("ALIAS-001 near miss: an alias in the input is accepted", () => {
    const result = run({ notes: [n("n1", "ok", { refs: ["F-1"] })], links: [], flags: [] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes).toHaveLength(1);
  });

  it("ALIAS-002 rejects every item that defines a duplicated local key, across collections", () => {
    const result = run({
      notes: [n("n1"), n("n2"), n("n1", "")],
      links: [{ key: "n2", notes: [] }],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes).toEqual([]);
    expect(result.accepted.links).toEqual([]);
    expect(result.events.map((event) => [event.itemKey, event.rule, event.stage])).toEqual([
      ["n1", "ALIAS-002", "item"],
      ["n2", "ALIAS-002", "item"],
      ["n1", "ALIAS-002", "item"],
      ["n2", "ALIAS-002", "item"],
    ]);
    expect(result.counts).toMatchObject({
      proposed: { state: "known", count: 4 },
      accepted: 0,
      rejectionsByRule: [{ rule: "ALIAS-002", count: 4 }],
    });
  });

  it("ALIAS-002 is checked first: a duplicated item's other rules never run", () => {
    const result = run({ notes: [n("n1", ""), n("n1", " x")], links: [], flags: [] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.map((event) => event.rule)).toEqual(["ALIAS-002", "ALIAS-002"]);
  });

  it("ALIAS-002 near miss: keys that differ only in case are different keys", () => {
    const result = run({ notes: [n("n1"), n("N1")], links: [], flags: [] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.notes).toHaveLength(2);
  });

  it("ALIAS-003 rejects an item that uses a local key where only aliases are accepted", () => {
    const result = run({ notes: [n("n1"), n("n2", "ok", { refs: ["n1"] })], links: [], flags: [] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.map((event) => [event.itemKey, event.rule])).toEqual([
      ["n2", "ALIAS-003"],
    ]);
  });

  it("ALIAS-003 near miss: a local key of a kind the field accepts resolves", () => {
    const result = run({
      notes: [n("n1"), n("n2")],
      links: [{ key: "l1", notes: ["n1", "n2"] }],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events).toEqual([]);
    expect(result.accepted.links.map((item) => item.key)).toEqual(["l1"]);
  });

  it("keys items without a local key by collection and position", () => {
    const result = run({ notes: [], links: [], flags: [{ text: "ok" }, { text: "bad" }] });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.map((event) => event.itemKey)).toEqual(["flags/1"]);
  });
});

describe("cross-item stage (IMPL §3.5)", () => {
  it("sees only items that passed the item stage, and may reject some of them", () => {
    const result = run({
      notes: [n("n1"), n("n2", "")],
      links: [{ key: "l1", notes: ["n1", "n2"] }],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.accepted.links).toEqual([]);
    expect(result.events.map((event) => [event.itemKey, event.stage, event.rule])).toEqual([
      ["n2", "item", "TEST-EMPTY"],
      ["l1", "cross_item", "TEST-LINK"],
    ]);
  });

  it("a reference to a rejected local key fails the referring item's own rule, not ALIAS-001", () => {
    const result = run({
      notes: [n("n1"), n("n2", "")],
      links: [{ key: "l1", notes: ["n1", "n2"] }],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.some((event) => event.rule.startsWith("ALIAS"))).toBe(false);
  });

  it("orders cross-item events by rule, then by item", () => {
    const result = run({
      notes: [n("n1"), n("n2")],
      links: [
        { key: "l1", notes: ["n1"] },
        { key: "l2", notes: ["n2"] },
      ],
      flags: [{ text: "a" }, { text: "b" }],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.map((event) => [event.itemKey, event.rule])).toEqual([
      ["l1", "TEST-LINK"],
      ["l2", "TEST-LINK"],
      ["flags/1", "TEST-ONE-FLAG"],
    ]);
  });

  it("keeps sub-item events of an item a cross-item rule later rejects", () => {
    const result = run({
      notes: [n("n1", "drop", { citations: ["good", "bad"] })],
      links: [],
      flags: [],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.events.map((event) => [event.itemKey, event.stage, event.rule])).toEqual([
      ["n1/citations/1", "item", "TEST-CITE"],
      ["n1", "cross_item", "TEST-DROP"],
    ]);
    expect(result.counts.rejectionsByRule).toEqual([
      { rule: "TEST-CITE", count: 1 },
      { rule: "TEST-DROP", count: 1 },
    ]);
  });

  it("counts rejections by rule, sorted by rule ID", () => {
    const result = run({
      notes: [n("n1", ""), n("n2", "ok", { refs: ["F-9"] }), n("n3", "")],
      links: [],
      flags: [{ text: "bad" }],
    });
    if (result.status !== "validated") throw new Error(result.status);
    expect(result.counts).toEqual({
      proposed: { state: "known", count: 4 },
      accepted: 0,
      corrected: 0,
      relabelled: 0,
      rejectionsByRule: [
        { rule: "ALIAS-001", count: 1 },
        { rule: "TEST-EMPTY", count: 2 },
        { rule: "TEST-FLAG", count: 1 },
      ],
    });
  });
});

describe("determinism (IMPL §3.8)", () => {
  const keys = fc.constantFrom("n1", "n2", "n3", "N1", "l1", "x", "n 1", "nnn1");
  const texts = fc.constantFrom("", "ok", " x", "maybe", "bad");
  const refs = fc.array(fc.constantFrom("F-1", "F-2", "F-3", "n1", "n2", "f-1"), { maxLength: 3 });
  const citations = fc.option(fc.array(fc.constantFrom("good", "bad"), { maxLength: 4 }), {
    nil: undefined,
  });
  const response = fc.record({
    notes: fc.array(
      fc
        .record({ key: keys, text: texts, refs, citations })
        .map((item) =>
          item.citations === undefined ? { key: item.key, text: item.text, refs: item.refs } : item,
        ),
      { maxLength: 6 },
    ),
    links: fc.array(fc.record({ key: keys, notes: refs }), { maxLength: 3 }),
    flags: fc.array(fc.record({ text: texts }), { maxLength: 3 }),
  });

  it("the same response, input and validator version give identical records and events", () => {
    fc.assert(
      fc.property(response, (value) => {
        expect(run(value)).toEqual(run(value));
      }),
    );
  });

  it("every proposed item is either accepted or has exactly one rejection event", () => {
    fc.assert(
      fc.property(response, (value) => {
        const result = run(value);
        if (result.status !== "validated") return;
        const proposed = value.notes.length + value.links.length + value.flags.length;
        const rejectedItems = result.events.filter(
          (event) => event.outcome === "rejected" && !event.itemKey.includes("/citations/"),
        ).length;
        const accepted =
          result.accepted.notes.length +
          result.accepted.links.length +
          result.accepted.flags.length;
        expect(result.counts.proposed).toEqual({ state: "known", count: proposed });
        expect(result.counts.accepted).toBe(accepted);
        expect(accepted + rejectedItems).toBe(proposed);
      }),
    );
  });
});
