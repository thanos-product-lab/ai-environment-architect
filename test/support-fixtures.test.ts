import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comparePaths } from "../src/core/paths.js";
import type { Basis, Evidence } from "../src/core/validation/citations.js";
import {
  anchorablePaths,
  checkSupport,
  hasDistinctSources,
  type SupportContext,
} from "../src/core/validation/support.js";

// Adversarial support fixtures (IMPL §3.2.3, §3.8), written from the spec without seeing the
// implementation. Each case is one finding with the evidence of its accepted citations, or one
// conflict with its members' evidence paths, against one shared file list.

const DIR = join(import.meta.dirname, "fixtures", "support");

interface Expect {
  readonly outcome: "accepted" | "rejected";
  readonly rule: string | null;
}

type Case =
  | {
      readonly finding: {
        readonly statement: string;
        readonly mode: "descriptive" | "prescriptive";
        readonly evidence: readonly { path: string; basis: Basis; excerpt: string }[];
      };
      readonly expect: Expect;
      readonly nearMissOf?: string;
    }
  | {
      readonly conflict: { readonly members: readonly { evidence: { path: string }[] }[] };
      readonly expect: Expect;
      readonly nearMissOf?: string;
    };

/** A withheld name: AWS's documented example key ID, which the secret scan matches (IMPL §1.7). */
const PLACEHOLDERS: Record<string, string> = { "{{aws-access-key-id}}": "AKIAIOSFODNN7EXAMPLE" };

function load(name: string): unknown {
  const text = readFileSync(join(DIR, name), "utf8").replace(/\{\{[a-z-]+\}\}/g, (placeholder) => {
    const value = PLACEHOLDERS[placeholder];
    if (value === undefined) throw new Error(`unknown placeholder in ${name}`);
    return value;
  });
  return JSON.parse(text);
}

const fixture = load("context.json") as {
  entries: string[];
};
const context: SupportContext = { anchorable: anchorablePaths(fixture.entries) };

const cases = readdirSync(DIR)
  .filter((name) => name.endsWith(".json") && name !== "context.json")
  .sort(comparePaths)
  .map((name) => [name, load(name) as Case] as const);

function outcome(fixtureCase: Case): Expect {
  if ("conflict" in fixtureCase)
    return hasDistinctSources(
      fixtureCase.conflict.members.map((member) => member.evidence.map((e) => e.path)),
    )
      ? { outcome: "accepted", rule: null }
      : { outcome: "rejected", rule: "SUP-005" };
  const evidence: Evidence[] = fixtureCase.finding.evidence.map((e) => ({
    ...e,
    fileHash: "sha256:1111",
    lineStart: 1,
    lineEnd: 1,
  }));
  const result = checkSupport({ ...fixtureCase.finding, evidence }, context);
  return result.ok
    ? { outcome: "accepted", rule: null }
    : { outcome: "rejected", rule: result.rule };
}

describe("support fixtures (IMPL §3.2.3, §3.8)", () => {
  it("has a rejecting fixture and an accepted near miss for every rule", () => {
    const rules = new Set(cases.map(([, c]) => c.expect.rule));
    for (const rule of ["SUP-001", "SUP-002", "SUP-003", "SUP-004", "SUP-005"])
      expect(rules).toContain(rule);
    const nearMisses = new Set(cases.map(([, c]) => c.nearMissOf));
    for (const rule of ["SUP-001", "SUP-002", "SUP-003", "SUP-004", "SUP-005"])
      expect(nearMisses).toContain(rule);
    for (const [, c] of cases)
      expect(c.nearMissOf === undefined).toBe(c.expect.outcome === "rejected");
  });

  it.each(cases)("%s", (_name, fixtureCase) => {
    expect(outcome(fixtureCase)).toEqual({
      outcome: fixtureCase.expect.outcome,
      rule: fixtureCase.expect.rule,
    });
  });
});
