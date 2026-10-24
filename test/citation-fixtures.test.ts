import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Hash } from "../src/core/hash.js";
import { comparePaths } from "../src/core/paths.js";
import { createAliasTable } from "../src/core/validation/aliases.js";
import {
  type CitableItem,
  type Citation,
  type CitationContext,
  type Cited,
  citationCheck,
  validateCitation,
} from "../src/core/validation/citations.js";

// Adversarial citation fixtures (IMPL §3.2.2, §3.8), written from the spec without seeing the
// implementation. Each case is one finding's citations, with the expected outcome of each and of
// the finding, against one shared synthetic context.

const DIR = join(import.meta.dirname, "fixtures", "citations");

interface FixtureItem {
  readonly id: string;
  readonly path: string;
  readonly snapshotHash: Hash;
  readonly currentHash: Hash | null;
  readonly totalLines: number;
  readonly sent: CitableItem["sent"];
}

interface Case {
  readonly citations: Citation[];
  readonly expect: readonly {
    readonly outcome: "accepted" | "rejected" | "corrected";
    readonly rule: string | null;
    readonly correctedLines?: string;
  }[];
  readonly finding: {
    readonly outcome: "accepted" | "rejected";
    readonly rule: string | null;
    readonly droppedCitations: number;
  };
}

const fixture = JSON.parse(readFileSync(join(DIR, "context.json"), "utf8")) as {
  items: FixtureItem[];
};
const context: CitationContext = {
  aliases: createAliasTable("analyse_expansion", {
    items: fixture.items.map((item) => item.id),
    findings: ["find_1"],
  }),
  items: new Map(
    fixture.items.map((item) => [
      item.id,
      {
        path: item.path,
        snapshotHash: item.snapshotHash,
        currentHash: item.currentHash ?? undefined,
        basis: "code_observation",
        totalLines: item.totalLines,
        sent: item.sent,
      },
    ]),
  ),
};

function cases(directory: string): [string, Case][] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "context.json")
    .sort(comparePaths)
    .map((name) => [name, JSON.parse(readFileSync(join(directory, name), "utf8")) as Case]);
}

function run(name: string, fixtureCase: Case): void {
  fixtureCase.citations.forEach((citation, index) => {
    const result = validateCitation(citation, context, new Set(["f1"]));
    const expected = fixtureCase.expect[index];
    const actual = !result.ok
      ? { outcome: "rejected", rule: result.rule }
      : result.correction === undefined
        ? { outcome: "accepted", rule: null }
        : {
            outcome: "corrected",
            rule: "CIT-R01",
            correctedLines: result.correction.correctedLines,
          };
    expect(actual, `${name} citation ${index}`).toEqual(expected);
  });
  const finding = citationCheck<Cited & { key: string }, CitationContext>()(
    { key: "f1", citations: fixtureCase.citations },
    context,
    { localKeys: new Set(["f1"]) },
  );
  if (fixtureCase.finding.outcome === "rejected")
    expect(finding).toMatchObject({ kind: "reject", rule: fixtureCase.finding.rule });
  else
    expect(finding).toMatchObject({
      kind: "accept",
      value: { droppedCitations: fixtureCase.finding.droppedCitations },
    });
}

describe("citation fixtures (IMPL §3.2.2)", () => {
  for (const [name, fixtureCase] of cases(DIR)) it(name, () => run(name, fixtureCase));
});

describe("citation fixtures for points the spec leaves open (IMPL §3.9)", () => {
  for (const [name, fixtureCase] of cases(join(DIR, "undecided")))
    it(name, () => run(name, fixtureCase));
});
