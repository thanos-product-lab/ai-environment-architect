import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comparePaths } from "../src/core/paths.js";
import { detectReferences } from "../src/core/validation/references.js";
import { anchorablePaths, isListed, type SupportContext } from "../src/core/validation/support.js";

// Adversarial reference-detector fixtures (IMPL §3.4, §3.8), written from the spec without seeing
// the implementation. Each case is one recommendation's content with the references and
// identifiers the detector should find, and, for path references, whether REF-002 lists them
// after the path normalisation of §1.11.

const DIR = join(import.meta.dirname, "fixtures", "references");

interface Case {
  readonly content: string;
  readonly expect: {
    /** `match` defaults to `value`. */
    readonly references: readonly { kind: "path" | "command"; value: string; match?: string }[];
    /** A string is an identifier whose value and matching form are equal. */
    readonly identifiers: readonly (string | { value: string; match: string })[];
  };
  readonly listed?: Readonly<Record<string, boolean>>;
}

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

const fixture = load("context.json") as { entries: string[] };
const context: SupportContext = { anchorable: anchorablePaths(fixture.entries) };

const cases = readdirSync(DIR)
  .filter((name) => name.endsWith(".json") && name !== "context.json")
  .sort(comparePaths)
  .map((name) => [name, load(name) as Case] as const);

describe("reference detector fixtures (IMPL §3.4)", () => {
  it("has fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s", (_name, testCase) => {
    const detection = detectReferences(testCase.content);
    expect(detection.references).toEqual(
      testCase.expect.references.map((r) => ({ ...r, match: r.match ?? r.value })),
    );
    expect(detection.identifiers).toEqual(
      testCase.expect.identifiers.map((i) => (typeof i === "string" ? { value: i, match: i } : i)),
    );
    for (const [match, listed] of Object.entries(testCase.listed ?? {})) {
      expect(detection.references.some((r) => r.kind === "path" && r.match === match)).toBe(true);
      expect(isListed(match, context), `REF-002 for ${match}`).toBe(listed);
    }
  });
});
