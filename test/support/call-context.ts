import { parseGuidanceBlocks } from "../../src/core/destination/guidance-blocks.js";
import { buildExclusionRules } from "../../src/core/snapshot/exclusions.js";
import type { IgnoreRules } from "../../src/core/snapshot/git.js";
import type { SnapshotFile } from "../../src/core/snapshot/snapshot.js";
import { createAliasTable } from "../../src/core/validation/aliases.js";
import type { AnalyseContext } from "../../src/core/validation/analyse.js";
import type {
  AnalyseExpansionContext,
  CallOneFinding,
} from "../../src/core/validation/analyse-expansion.js";
import type { Basis, CitableItem, SentRun } from "../../src/core/validation/citations.js";
import type { AliasedFinding } from "../../src/core/validation/conflicts.js";
import { coverageIndex } from "../../src/core/validation/coverage.js";
import type { Scope } from "../../src/core/validation/duplicates.js";
import { expansionIndex } from "../../src/core/validation/expansion.js";
import type { GapType, QuestionContext } from "../../src/core/validation/generate-questions.js";
import type {
  RecommendContext,
  RecommendEvidence,
  RecommendFinding,
  RecommendQuestion,
} from "../../src/core/validation/recommend.js";
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
  /** For `listed_only`: `too_large`, `contains_nul` or `not_utf8`. */
  readonly reason?: string;
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
  /** analyse_expansion: call-1 records after the known facts. generate_questions: input findings. */
  readonly findings?: readonly (FixtureCallOneFinding | FixtureQuestionFinding)[];
  readonly conflicts?: readonly {
    readonly alias: string;
    readonly members: readonly string[];
    readonly status?: "unresolved" | "resolved";
  }[];
  readonly questionBudget?: number;
}

/** `recommend`: the call's input records, by alias, and the destination as text. */
export interface FixtureRecommendContext {
  readonly files: readonly FixtureFile[];
  readonly userExclusions?: readonly string[];
  readonly ignoreRules: IgnoreRules;
  readonly destination:
    | { readonly state: "absent" }
    | { readonly state: "present"; readonly text: string };
  readonly findings?: readonly (Omit<RecommendFinding, "current" | "evidence"> & {
    readonly alias: string;
    readonly current?: boolean;
    readonly evidence?: readonly DistributiveOmit<RecommendEvidence, "id">[];
  })[];
  readonly decisions?: readonly {
    readonly alias: string;
    readonly statement: string;
    readonly exceptions?: readonly string[];
    readonly current?: boolean;
  }[];
  readonly conflicts?: readonly {
    readonly alias: string;
    readonly members: readonly string[];
    readonly status: "unresolved" | "resolved";
  }[];
  readonly questions?: readonly ({ readonly alias: string } & RecommendQuestion)[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A call-1 record: a claim unless `kind` says otherwise, produced by the model by default. */
export type FixtureCallOneFinding =
  | (FixtureFinding & {
      readonly kind?: "claim";
      readonly producedBy?: "deterministic" | "model";
    })
  | {
      readonly alias: string;
      readonly kind: "gap";
      readonly producedBy?: "deterministic" | "model";
      readonly statement: string;
      readonly gapType: GapType;
      readonly relatedPaths: readonly string[];
    }
  | { readonly alias: string; readonly kind: "absenceClaim"; readonly pathGlob: string };

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
        hash: `sha256:${"0".repeat(64)}`,
        rule: "fixture",
        reason: "io_error",
        ...file,
      }) as SnapshotFile,
  );
}

const SNAPSHOT_HASH = `sha256:${"5a".repeat(32)}` as const;
const CHANGED_HASH = `sha256:${"c4".repeat(32)}` as const;

function base(
  fixture: FixtureContext,
  reversed: boolean,
  findings: readonly { readonly alias: string }[],
) {
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
  const prior = (fixture.findings ?? []) as readonly FixtureCallOneFinding[];
  const { files, citable, coverage, factIds } = base(fixture, reversed, prior);
  const conflicts = fixture.conflicts ?? [];
  const callOne = (f: FixtureCallOneFinding): CallOneFinding => {
    if (f.kind === "absenceClaim")
      return { alias: f.alias, kind: "absenceClaim", producedBy: "model", pathGlob: f.pathGlob };
    if (f.kind === "gap")
      return {
        alias: f.alias,
        kind: "gap",
        producedBy: f.producedBy ?? "model",
        statement: f.statement,
        gapType: f.gapType,
        relatedPaths: f.relatedPaths,
      };
    return {
      alias: f.alias,
      kind: "claim",
      producedBy: f.producedBy ?? "model",
      statement: f.statement,
      scope: f.scope,
      paths: f.evidencePaths,
    };
  };
  const facts = (fixture.knownFacts ?? []).map((fact) =>
    callOne({ ...fact, producedBy: "deterministic" }),
  );
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
    callOne: {
      findings: [...facts, ...prior.map(callOne)],
      conflicts: conflicts.map((conflict) => ({
        alias: conflict.alias,
        members: conflict.members,
      })),
    },
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

/** Evidence IDs are `ev-<alias>-<n>`, counting from 1 in the finding's evidence order. */
export function recommendContext(
  fixture: FixtureRecommendContext,
  reversed = false,
): RecommendContext {
  const findings = fixture.findings ?? [];
  const decisions = fixture.decisions ?? [];
  const conflicts = fixture.conflicts ?? [];
  const questions = fixture.questions ?? [];
  inAliasOrder("F", findings);
  inAliasOrder("D", decisions);
  inAliasOrder("C", conflicts);
  inAliasOrder("Q", questions);
  const files = order(snapshotFiles(fixture.files), reversed);
  const destination =
    fixture.destination.state === "absent"
      ? ({ state: "absent" } as const)
      : (() => {
          const bytes = new TextEncoder().encode(fixture.destination.text);
          return { state: "present" as const, bytes, parsed: parseGuidanceBlocks(bytes) };
        })();
  const blocks = destination.state === "present" ? destination.parsed.blocks : [];
  return {
    aliases: createAliasTable("recommend", {
      findings: findings.map((f) => `record:${f.alias}`),
      conflicts: conflicts.map((c) => `record:${c.alias}`),
      questions: questions.map((q) => `record:${q.alias}`),
      decisions: decisions.map((d) => `record:${d.alias}`),
      blocks: blocks.map((b) => ({ blockId: b.blockId, hash: b.hash })),
    }),
    coverage: coverageIndex(
      {
        files,
        exclusions: buildExclusionRules({ userExclusions: fixture.userExclusions ?? [] }),
        ignoreRules: fixture.ignoreRules,
      },
      [],
    ),
    anchorable: anchorablePaths(files.map((file) => file.path)),
    destination,
    input: {
      findings: new Map(
        order(findings, reversed).map(({ alias, current, evidence, ...rest }) => [
          alias,
          {
            ...rest,
            current: current ?? true,
            evidence: (evidence ?? []).map(
              (e, i) => ({ ...e, id: `ev-${alias}-${i + 1}` }) as RecommendEvidence,
            ),
          },
        ]),
      ),
      decisions: new Map(
        order(decisions, reversed).map((d) => [
          d.alias,
          { statement: d.statement, exceptions: d.exceptions ?? [], current: d.current ?? true },
        ]),
      ),
      conflicts: new Map(
        order(conflicts, reversed).map((c) => [c.alias, { members: c.members, status: c.status }]),
      ),
      questions: new Map(
        order(questions, reversed).map((q) => [
          q.alias,
          { status: q.status, resolves: q.resolves },
        ]),
      ),
    },
  };
}
