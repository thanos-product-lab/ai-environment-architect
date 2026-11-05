import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The M5 closing audit as a test (IMPL §3.3.5, §3.3.6, §3.8): every pinned rule has a recorded
// response that rejects it, and an accepted near miss: a fixture whose `nearMissOf` names one of
// those rejecting fixtures, and which is validated with no rejection of any rule. `call-fixtures.test.ts`
// checks what each fixture expects; this checks that the pairs exist.

const ROOT = join(import.meta.dirname, "fixtures", "responses");
const SPEC = join(import.meta.dirname, "..", "docs", "architecture", "IMPLEMENTATION_SPEC.md");

const range = (prefix: string, last: number) =>
  Array.from({ length: last }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`);

const PINNED = {
  recommend: [...range("REC", 10), ...range("REF", 5), "HELD-001", "DUP-004"],
  regenerate_recommendations: ["REGEN-001", "REGEN-002", "HELD-001", "DUP-004"],
} as const;

interface Case {
  readonly nearMissOf?: string;
  readonly expect: {
    readonly status: string;
    readonly events: readonly { readonly rule: string; readonly outcome: string }[];
  };
}

function cases(call: string): ReadonlyMap<string, Case> {
  const dir = join(ROOT, call);
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "valid.json")
      .filter((name) => !name.startsWith("context"))
      .map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as Case]),
  );
}

const rejects = (fixture: Case | undefined, rule: string) =>
  fixture?.expect.events.some((e) => e.rule === rule && e.outcome === "rejected") ?? false;

/** Validated with no rejection at all, so another rule can't stand in for the one under test. */
const accepted = (fixture: Case) =>
  fixture.expect.status === "validated" &&
  fixture.expect.events.every((e) => e.outcome !== "rejected");

describe("every pinned rule has a rejecting fixture and an accepted near miss (IMPL §3.8)", () => {
  for (const [call, rules] of Object.entries(PINNED)) {
    const fixtures = cases(call);
    it.each(rules)(`${call}: %s`, (rule) => {
      const rejecting = [...fixtures].filter(([, f]) => rejects(f, rule)).map(([name]) => name);
      const nearMisses = [...fixtures]
        .filter(([, f]) => f.nearMissOf !== undefined && rejecting.includes(f.nearMissOf))
        .filter(([, f]) => accepted(f))
        .map(([name]) => name);
      expect(rejecting, "a fixture that rejects the rule").not.toEqual([]);
      expect(nearMisses, "a near miss of one of those fixtures").not.toEqual([]);
    });
  }

  it("the pinned list is exactly the REC, REF, HELD and REGEN rules the spec names, and DUP-004", () => {
    const named = new Set([
      ...(readFileSync(SPEC, "utf8").match(/\b(?:REC|REF|HELD|REGEN)-\d{3}\b/g) ?? []),
      "DUP-004",
    ]);
    const pinned = new Set<string>([...PINNED.recommend, ...PINNED.regenerate_recommendations]);
    expect([...named].filter((rule) => !pinned.has(rule)).sort(), "named, not pinned").toEqual([]);
    expect([...pinned].filter((rule) => !named.has(rule)).sort(), "pinned, not named").toEqual([]);
  });

  it("every nearMissOf names a fixture of its own call", () => {
    for (const call of Object.keys(PINNED)) {
      const fixtures = cases(call);
      for (const [name, f] of fixtures)
        if (f.nearMissOf !== undefined) expect(fixtures.has(f.nearMissOf), name).toBe(true);
    }
  });
});
