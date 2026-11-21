import type { LineRange } from "../context/item.js";
import { lineTexts } from "../context/item.js";
import type { ReadyContext } from "../context/select.js";
import type { TierMembership } from "../context/tiers.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import type { Hash } from "../hash.js";
import type { NumberedRecords } from "../requests/records.js";
import type { Revised } from "../session/log.js";
import type { EvidenceRecord, SessionRecord } from "../session/records.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import type { Snapshot } from "../snapshot/snapshot.js";
import type { AliasTable } from "../validation/aliases.js";
import type { AnalyseContext } from "../validation/analyse.js";
import type { AnalyseExpansionContext, CallOneFinding } from "../validation/analyse-expansion.js";
import { basisOf } from "../validation/basis.js";
import type { CitableItem, SentRun } from "../validation/citations.js";
import type { AliasedFinding } from "../validation/conflicts.js";
import { type CoverageIndex, coverageIndex, type SentFile } from "../validation/coverage.js";
import { expansionIndex } from "../validation/expansion.js";
import type { QuestionContext } from "../validation/generate-questions.js";
import type {
  RecommendContext,
  RecommendEvidence,
  RecommendFinding,
} from "../validation/recommend.js";
import { anchorablePaths } from "../validation/support.js";

// The validation context of each call (IMPL §3.2.2, §3.3), built from what the call sent and
// from the session's records. Validation can then check citations against exactly the lines
// sent, and alias references against exactly the records numbered.

/** A context or expansion item as sent: its ID, file, snapshot hash and sent ranges. */
export interface SentItem {
  readonly id: string;
  readonly path: string;
  readonly hash: Hash;
  readonly included: readonly LineRange[];
  readonly totalLines: number;
}

/**
 * Each item's citable form (§3.2.2), keyed by ID. The file is read again first: its current hash
 * is what `CIT-002` compares, and a file that can't be read again counts as changed. The sent
 * lines are taken only from content that still matches the snapshot hash; a changed file fails
 * `CIT-002` before its lines are looked at.
 */
export async function citableItems(
  items: readonly SentItem[],
  membership: TierMembership,
  fs: RepositoryFs,
): Promise<Map<string, CitableItem>> {
  const reads = new Map<string, { hash: Hash | undefined; lines: readonly string[] | undefined }>();
  // Read whole on purpose: the hash covers the whole file, and a `listed_only` file that call 2
  // read by line range (§1.8) is larger than `maxReadableFileBytes`.
  const read = async (path: string) => {
    const cached = reads.get(path);
    if (cached !== undefined) return cached;
    const result = await fs.read(path, Number.MAX_SAFE_INTEGER);
    const value =
      result.ok && result.bytes !== undefined
        ? { hash: result.hash, lines: lineTexts(result.bytes) }
        : { hash: result.ok ? result.hash : undefined, lines: undefined };
    reads.set(path, value);
    return value;
  };
  const citable = new Map<string, CitableItem>();
  for (const item of items) {
    const { hash, lines } = await read(item.path);
    const current = hash === item.hash ? lines : undefined;
    const sent: SentRun[] =
      current === undefined
        ? []
        : item.included.map((range) => ({
            first: range.first,
            lines: current.slice(range.first - 1, range.last),
          }));
    citable.set(item.id, {
      path: item.path,
      snapshotHash: item.hash,
      currentHash: hash,
      basis: basisOf(item.path, membership),
      totalLines: item.totalLines,
      sent,
    });
  }
  return citable;
}

/** The context's items as sent. */
export function contextItems(context: ReadyContext): SentItem[] {
  return context.items.map((item) => ({
    id: item.id,
    path: item.path,
    hash: item.hash,
    included: item.rendered.included,
    totalLines: item.rendered.totalLines,
  }));
}

/**
 * What each item sent, for coverage (§1.11): from its sent ranges, so a file that changed before
 * validation still counts as sent. Coverage reads only which lines were sent, not their text.
 */
export function sentFiles(items: readonly SentItem[]): SentFile[] {
  return items.map((item) => ({
    path: item.path,
    totalLines: item.totalLines,
    sent: item.included.map((range) => ({
      first: range.first,
      lines: Array.from({ length: range.last - range.first + 1 }, () => ""),
    })),
  }));
}

function listed(snapshot: Snapshot): ReadonlySet<string> {
  return anchorablePaths(snapshot.files.map((file) => file.path));
}

/** Call 1 (§3.3.2). */
export function analyseValidationContext(
  context: ReadyContext,
  aliases: AliasTable,
  citable: ReadonlyMap<string, CitableItem>,
  maxExpansionRequests: number,
  evidencePaths: (alias: string) => readonly string[],
): AnalyseContext {
  const { snapshot } = context.parts;
  const sent = sentFiles(contextItems(context));
  return {
    aliases,
    items: citable,
    anchorable: listed(snapshot),
    coverage: coverageIndex(snapshot, sent),
    expansion: expansionIndex({
      files: snapshot.files,
      scopeRoots: snapshot.scope.roots,
      sent,
      maxRequests: maxExpansionRequests,
      blocked: context.parts.blocked.map((entry) => entry.path),
    }),
    knownFacts: context.knownFacts.flatMap(({ fact, alias }): AliasedFinding[] =>
      alias === null
        ? []
        : [{ alias, statement: fact.statement, scope: fact.scope, paths: evidencePaths(alias) }],
    ),
  };
}

/** Call 2 (§3.3.3): the call-1 records are exactly the table's `F` and `C` aliases, in order. */
export function analyseExpansionValidationContext(
  snapshot: Snapshot,
  aliases: AliasTable,
  citable: ReadonlyMap<string, CitableItem>,
  sent: readonly SentItem[],
  numbered: NumberedRecords,
  records: readonly SessionRecord[],
): AnalyseExpansionContext {
  const evidence = evidenceById(records);
  const pathsOf = (finding: Revised<"finding">) =>
    finding.evidenceIds.flatMap((id) => {
      const item = evidence.get(id);
      return item !== undefined && "path" in item ? [item.path] : [];
    });
  const findings = numbered.findings.map(({ alias, record }): CallOneFinding => {
    const producedBy = record.producedBy === "deterministic" ? "deterministic" : "model";
    if (record.kind === "absence")
      return { alias, kind: "absenceClaim", producedBy: "model", pathGlob: record.pathGlob };
    if (record.kind === "gap")
      return {
        alias,
        kind: "gap",
        producedBy,
        statement: record.statement,
        gapType: record.gapType,
        relatedPaths: record.relatedPaths,
      };
    return {
      alias,
      kind: "claim",
      producedBy,
      statement: record.statement,
      scope: record.scope,
      paths: pathsOf(record),
    };
  });
  return {
    aliases,
    items: citable,
    anchorable: listed(snapshot),
    coverage: coverageIndex(snapshot, sentFiles(sent)),
    callOne: {
      findings,
      conflicts: numbered.conflicts.map(({ alias, record }) => ({
        alias,
        members: record.findingIds.flatMap((id) => {
          const member = numbered.aliasOf(id);
          return member === undefined ? [] : [member];
        }),
      })),
    },
  };
}

/** Calls 3–5 send no context items, so their coverage holds the file list alone. */
function recordsCoverage(snapshot: Snapshot): CoverageIndex {
  return coverageIndex(snapshot, []);
}

const conflictStatus = (status: string): "unresolved" | "resolved" =>
  status === "resolved" ? "resolved" : "unresolved";

function memberAliases(numbered: NumberedRecords, ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const alias = numbered.aliasOf(id);
    return alias === undefined ? [] : [alias];
  });
}

type QuestionFinding =
  QuestionContext["questions"]["findings"] extends ReadonlyMap<string, infer V> ? V : never;

/** Call 3 (§3.3.4). An absence claim is asked about as a claim, by its basis. */
export function questionValidationContext(
  snapshot: Snapshot,
  aliases: AliasTable,
  numbered: NumberedRecords,
  budget: number,
): QuestionContext {
  return {
    aliases,
    coverage: recordsCoverage(snapshot),
    questions: {
      findings: new Map(
        numbered.findings.map(({ alias, record }): [string, QuestionFinding] =>
          record.kind === "gap"
            ? [alias, { kind: "gap", basis: [], gapType: record.gapType }]
            : [alias, { kind: "claim", basis: record.basis }],
        ),
      ),
      conflicts: new Map(
        numbered.conflicts.map(({ alias, record }) => [
          alias,
          {
            members: memberAliases(numbered, record.findingIds),
            status: conflictStatus(record.status),
          },
        ]),
      ),
      budget,
    },
  };
}

/** Calls 4–5 (§3.3.5): every alias of the table is current, since only current records are numbered. */
export function recommendValidationContext(
  snapshot: Snapshot,
  aliases: AliasTable,
  numbered: NumberedRecords,
  records: readonly SessionRecord[],
  destination: Uint8Array | undefined,
): RecommendContext {
  const evidence = evidenceById(records);
  const findingInput = (record: Revised<"finding">): RecommendFinding => {
    const items = record.evidenceIds.flatMap((id): RecommendEvidence[] => {
      const item = evidence.get(id);
      if (item === undefined) return [];
      if (item.kind === "lines")
        return [{ id, kind: "lines", path: item.path, excerpt: item.excerpt, basis: item.basis }];
      if (item.kind === "entry") return [{ id, kind: "entry", path: item.path }];
      return [{ id, kind: "absence_check" }];
    });
    const fact = record.kind === "claim" ? record.fact : undefined;
    return {
      kind: record.kind,
      ...(record.kind === "claim" ? { mode: record.mode } : {}),
      basis: record.kind === "gap" ? [] : record.basis,
      current: true,
      evidence: items,
      ...(fact?.type === "command" ? { command: { file: fact.file, name: fact.name } } : {}),
    };
  };
  return {
    aliases,
    coverage: recordsCoverage(snapshot),
    anchorable: listed(snapshot),
    destination:
      destination === undefined
        ? { state: "absent" }
        : { state: "present", bytes: destination, parsed: parseGuidanceBlocks(destination) },
    input: {
      findings: new Map(
        numbered.findings.map(({ alias, record }) => [alias, findingInput(record)]),
      ),
      decisions: new Map(
        numbered.decisions.map(({ alias, record }) => [
          alias,
          { current: true, statement: record.statement, exceptions: record.exceptions },
        ]),
      ),
      conflicts: new Map(
        numbered.conflicts.map(({ alias, record }) => [
          alias,
          {
            members: memberAliases(numbered, record.findingIds),
            status: conflictStatus(record.status),
          },
        ]),
      ),
      questions: new Map(
        numbered.questions.map(({ alias, record }) => [
          alias,
          {
            status: record.status,
            resolves: memberAliases(numbered, [
              ...record.findingIds,
              ...record.gapIds,
              ...record.conflictIds,
            ]),
          },
        ]),
      ),
    },
  };
}

function evidenceById(records: readonly SessionRecord[]): ReadonlyMap<string, EvidenceRecord> {
  return new Map(
    records.flatMap((r) => (r.type === "evidence" ? [[r.id, r as EvidenceRecord] as const] : [])),
  );
}
