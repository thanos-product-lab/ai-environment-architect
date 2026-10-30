import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathHash, type RecordedPath } from "../src/core/context/secrets.js";
import { comparePaths } from "../src/core/paths.js";
import { buildExclusionRules } from "../src/core/snapshot/exclusions.js";
import type { IgnoreRules } from "../src/core/snapshot/git.js";
import type { SnapshotFile } from "../src/core/snapshot/snapshot.js";
import {
  checkAbsenceClaim,
  checkGap,
  checkScopePaths,
  coverageIndex,
  type GapCoverage,
} from "../src/core/validation/coverage.js";

// Adversarial coverage fixtures (IMPL §1.11, §3.8), written from the spec without seeing the
// implementation. Each case is one scope, gap or absence claim against one shared snapshot.

const DIR = join(import.meta.dirname, "fixtures", "coverage");
const RULES = ["SCOPE-001", "GAP-001", "GAP-002", "ABS-001", "ABS-002", "ABS-003"];

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

interface FixtureFile {
  readonly path: string;
  readonly status: SnapshotFile["status"];
  readonly kind?: string;
  readonly target?: string;
}

interface FixtureSent {
  readonly path: string;
  readonly totalLines: number;
  readonly ranges: [number, number][];
}

const fixture = load("context.json") as {
  files: FixtureFile[];
  userExclusions?: string[];
  ignoreRules: IgnoreRules;
  sent: FixtureSent[];
};

/** The fields coverage reads; hashes, sizes and reasons don't affect it. */
const snapshotFiles = (list: readonly FixtureFile[]): SnapshotFile[] =>
  list.map(
    (file) =>
      ({
        size: 1,
        hash: "sha256:00",
        rule: "fixture",
        reason: "io_error",
        ...file,
      }) as SnapshotFile,
  );
const sentFiles = (list: readonly FixtureSent[]) =>
  list.map((item) => ({
    path: item.path,
    totalLines: item.totalLines,
    sent: item.ranges.map(([first, last]) => ({
      first,
      lines: Array.from({ length: last - first + 1 }, () => ""),
    })),
  }));

type Expect =
  | { outcome: "accepted" | "rejected"; rule: string | null; statement?: string }
  | { outcome: "accepted" | "relabelled" | "rejected"; rule: string | null; coverage?: Expected };

type FixturePath = { path: string } | { pathHash: string };

type Expected =
  | { state: "inspected" }
  | { state: "not_inspected"; entries: FixturePath[]; directories: FixturePath[] };

type Case = {
  readonly expect: Expect;
  readonly nearMissOf?: string;
  readonly ignoreRules?: IgnoreRules;
  /** A case may replace the shared snapshot, for a repository shape it alone needs. */
  readonly files?: FixtureFile[];
  readonly userExclusions?: string[];
  readonly sent?: FixtureSent[];
} & (
  | { readonly gap: { relatedPaths: string[] } }
  | { readonly absenceClaim: { pathGlob: string } }
  | { readonly scope: { paths: string[] } }
);

/** `{"pathHash":"withheld:<path>"}` in a fixture is the hash of that path. */
function recorded(paths: readonly FixturePath[]): RecordedPath[] {
  return paths.map((p) =>
    "pathHash" in p ? { pathHash: pathHash(p.pathHash.replace(/^withheld:/, "")) } : p,
  );
}

function expected(coverage: Expected): GapCoverage {
  return coverage.state === "inspected"
    ? coverage
    : {
        state: "not_inspected",
        entries: recorded(coverage.entries),
        directories: recorded(coverage.directories),
      };
}

const cases = readdirSync(DIR)
  .filter((name) => name.endsWith(".json") && name !== "context.json")
  .sort(comparePaths)
  .map((name) => [name, load(name) as Case] as const);

function run(fixtureCase: Case, reversed: boolean) {
  const files = snapshotFiles(fixtureCase.files ?? fixture.files);
  const sent = sentFiles(fixtureCase.sent ?? fixture.sent);
  const index = coverageIndex(
    {
      files: reversed ? files.reverse() : files,
      exclusions: buildExclusionRules({
        userExclusions: fixtureCase.userExclusions ?? fixture.userExclusions ?? [],
      }),
      ignoreRules: fixtureCase.ignoreRules ?? fixture.ignoreRules,
    },
    reversed ? sent.reverse() : sent,
  );
  if ("scope" in fixtureCase) {
    const result = checkScopePaths(fixtureCase.scope.paths, index);
    return result.ok
      ? { outcome: "accepted", rule: null }
      : { outcome: "rejected", rule: result.rule, detail: result.detail };
  }
  if ("gap" in fixtureCase) {
    const result = checkGap(fixtureCase.gap.relatedPaths, index);
    if (!result.ok) return { outcome: "rejected", rule: result.rule, detail: result.detail };
    return result.coverage.state === "inspected"
      ? { outcome: "accepted", rule: null, coverage: result.coverage }
      : { outcome: "relabelled", rule: "GAP-002", coverage: result.coverage };
  }
  const result = checkAbsenceClaim(fixtureCase.absenceClaim.pathGlob, index);
  return result.ok
    ? { outcome: "accepted", rule: null, statement: result.statement }
    : { outcome: "rejected", rule: result.rule, detail: result.detail };
}

describe("coverage fixtures (IMPL §1.11, §3.8)", () => {
  it("has a rejecting or relabelling fixture and an accepted near miss for every rule", () => {
    const rules = new Set(cases.map(([, c]) => c.expect.rule));
    const nearMisses = new Set(cases.map(([, c]) => c.nearMissOf));
    for (const rule of RULES) {
      expect(rules).toContain(rule);
      expect(nearMisses).toContain(rule);
    }
  });

  it.each(cases)("%s", (_name, fixtureCase) => {
    const { coverage, statement, detailExcludes, ...rest } = fixtureCase.expect as Expect & {
      coverage?: Expected | null;
      statement?: string | null;
      detailExcludes?: string[];
    };
    const actual = run(fixtureCase, false);
    expect(actual).toMatchObject({
      ...rest,
      ...(coverage == null ? {} : { coverage: expected(coverage) }),
      ...(statement == null ? {} : { statement }),
    });
    // A rejection detail never echoes a withheld name (IMPL §1.11).
    for (const text of detailExcludes ?? []) expect(actual.detail ?? "").not.toContain(text);
    // Snapshot enumeration order never changes the outcome (IMPL §1.3).
    expect(run(fixtureCase, true)).toEqual(actual);
  });
});
