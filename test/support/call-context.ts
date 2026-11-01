import { buildExclusionRules } from "../../src/core/snapshot/exclusions.js";
import type { IgnoreRules } from "../../src/core/snapshot/git.js";
import type { SnapshotFile } from "../../src/core/snapshot/snapshot.js";
import { createAliasTable } from "../../src/core/validation/aliases.js";
import type { AnalyseContext } from "../../src/core/validation/analyse.js";
import type { AnalyseExpansionContext } from "../../src/core/validation/analyse-expansion.js";
import type { Basis, CitableItem, SentRun } from "../../src/core/validation/citations.js";
import type { AliasedFinding } from "../../src/core/validation/conflicts.js";
import { coverageIndex } from "../../src/core/validation/coverage.js";
import type { Scope } from "../../src/core/validation/duplicates.js";
import { expansionIndex } from "../../src/core/validation/expansion.js";
import type { GapType, QuestionContext } from "../../src/core/validation/generate-questions.js";
import { anchorablePaths } from "../../src/core/validation/support.js";

// Call contexts for whole-call validation, from the fixture format of
// `test/fixtures/responses/` (README). The fixtures name only what validation reads: hashes,
// sizes and reasons are filled in. `reversed` builds the same context from inputs in reverse
// order, to show that validation doesn't depend on it.

export interface FixtureFile {
  readonly path: string;
  readonly status: SnapshotFile["status"];
  readonly kind?: string;
  readonly target?: string;
  readonly rule?: string;
}

export interface FixtureItem {
  readonly alias: string;
  readonly path: string;
  readonly basis: Basis;
  readonly totalLines: number;
  readonly sent: readonly SentRun[];
  readonly changed?: boolean;
}

export interface FixtureFinding {
  readonly alias: string;
  readonly statement: string;
  readonly scope: Scope;
  readonly evidencePaths: readonly string[];
}

export interface FixtureContext {
  readonly files: readonly FixtureFile[];
  readonly userExclusions?: readonly string[];
  readonly ignoreRules: IgnoreRules;
  readonly scopeRoots?: readonly string[];
  readonly items?: readonly FixtureItem[];
  readonly knownFacts?: readonly FixtureFinding[];
  readonly blocks?: number;
  readonly maxExpansionRequests?: number;
  /** analyse_expansion: call-1 model findings. generate_questions: input findings. */
  readonly findings?: readonly (FixtureFinding | FixtureQuestionFinding)[];
  readonly conflicts?: readonly {
    readonly alias: string;
    readonly members: readonly string[];
    readonly status?: "unresolved" | "resolved";
  }[];
  readonly questionBudget?: number;
}

export interface FixtureQuestionFinding {
  readonly alias: string;
  readonly kind: "claim" | "gap";
  readonly basis: readonly Basis[];
  readonly gapType?: GapType;
}

const order = <T>(list: readonly T[], reversed: boolean): T[] =>
  reversed ? [...list].reverse() : [...list];

function snapshotFiles(list: readonly FixtureFile[]): SnapshotFile[] {
  return list.map(
    (file) =>
      ({
        size: 1,
        hash: "sha256:00",
        rule: "fixture",
        reason: "io_error",
        ...file,
      }) as SnapshotFile,
  );
}

const SNAPSHOT_HASH = "sha256:5a";
const CHANGED_HASH = "sha256:c4";

function base(fixture: FixtureContext, reversed: boolean, findings: readonly FixtureFinding[]) {
  const files = order(snapshotFiles(fixture.files), reversed);
  const items = order(fixture.items ?? [], reversed);
  const knownFacts: AliasedFinding[] = (fixture.knownFacts ?? []).map(aliased);
  const citable = new Map<string, CitableItem>(
    items.map((item) => [
      item.alias,
      {
        path: item.path,
        snapshotHash: SNAPSHOT_HASH,
        currentHash: item.changed === true ? CHANGED_HASH : SNAPSHOT_HASH,
        basis: item.basis,
        totalLines: item.totalLines,
        sent: item.sent,
      },
    ]),
  );
  const sent = items.map((item) => ({
    path: item.path,
    totalLines: item.totalLines,
    sent: item.sent,
  }));
  const coverage = coverageIndex(
    {
      files,
      exclusions: buildExclusionRules({ userExclusions: fixture.userExclusions ?? [] }),
      ignoreRules: fixture.ignoreRules,
    },
    sent,
  );
  // The table numbers records by position, so a fixture must list them in alias order.
  const records = [...(fixture.knownFacts ?? []), ...findings];
  inAliasOrder("F", records);
  inAliasOrder("C", fixture.conflicts ?? []);
  const factIds = records.map((f) => `record:${f.alias}`);
  return { files, items, knownFacts, citable, sent, coverage, factIds };
}

function inAliasOrder(kind: string, records: readonly { readonly alias: string }[]): void {
  records.forEach((record, i) => {
    if (record.alias !== `${kind}-${i + 1}`)
      throw new Error(`fixture lists ${record.alias} where ${kind}-${i + 1} belongs`);
  });
}

function aliased(finding: FixtureFinding): AliasedFinding {
  return {
    alias: finding.alias,
    statement: finding.statement,
    scope: finding.scope,
    paths: finding.evidencePaths,
  };
}

function blocks(count = 0) {
  return Array.from({ length: count }, (_, i) => ({
    blockId: `paragraph-${i + 1}`,
    hash: `sha256:b${i}` as const,
  }));
}

export function analyseContext(fixture: FixtureContext, reversed = false): AnalyseContext {
  const { files, knownFacts, citable, sent, coverage, factIds } = base(fixture, reversed, []);
  return {
    aliases: createAliasTable("analyse", {
      items: (fixture.items ?? []).map((item) => item.alias),
      findings: factIds,
      blocks: blocks(fixture.blocks),
    }),
    items: citable,
    anchorable: anchorablePaths(files.map((file) => file.path)),
    coverage,
    expansion: expansionIndex({
      files,
      scopeRoots: fixture.scopeRoots ?? ["."],
      sent,
      maxRequests: fixture.maxExpansionRequests ?? 5,
    }),
    knownFacts,
  };
}

export function analyseExpansionContext(
  fixture: FixtureContext,
  reversed = false,
): AnalyseExpansionContext {
  const prior = (fixture.findings ?? []) as readonly FixtureFinding[];
  const { files, knownFacts, citable, coverage, factIds } = base(fixture, reversed, prior);
  const conflicts = fixture.conflicts ?? [];
  return {
    aliases: createAliasTable("analyse_expansion", {
      items: (fixture.items ?? []).map((item) => item.alias),
      findings: factIds,
      conflicts: conflicts.map((conflict) => `record:${conflict.alias}`),
      blocks: blocks(fixture.blocks),
    }),
    items: citable,
    anchorable: anchorablePaths(files.map((file) => file.path)),
    coverage,
    knownFacts,
    priorFindings: prior.map(aliased),
    priorConflicts: conflicts.map((conflict) => ({
      alias: conflict.alias,
      members: conflict.members,
    })),
  };
}

export function questionContext(fixture: FixtureContext, reversed = false): QuestionContext {
  const findings = (fixture.findings ?? []) as readonly FixtureQuestionFinding[];
  const conflicts = fixture.conflicts ?? [];
  inAliasOrder("F", findings);
  inAliasOrder("C", conflicts);
  const files = order(snapshotFiles(fixture.files), reversed);
  return {
    aliases: createAliasTable("generate_questions", {
      findings: findings.map((f) => `record:${f.alias}`),
      conflicts: conflicts.map((c) => `record:${c.alias}`),
      blocks: blocks(fixture.blocks),
    }),
    coverage: coverageIndex(
      {
        files,
        exclusions: buildExclusionRules({ userExclusions: fixture.userExclusions ?? [] }),
        ignoreRules: fixture.ignoreRules,
      },
      [],
    ),
    questions: {
      findings: new Map(
        order(findings, reversed).map((f) => [
          f.alias,
          {
            kind: f.kind,
            basis: f.basis,
            ...(f.gapType === undefined ? {} : { gapType: f.gapType }),
          },
        ]),
      ),
      conflicts: new Map(
        order(conflicts, reversed).map((c) => [
          c.alias,
          { members: c.members, status: c.status ?? "unresolved" },
        ]),
      ),
      budget: fixture.questionBudget ?? 5,
    },
  };
}
