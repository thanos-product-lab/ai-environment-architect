import type { SelectionGap } from "../context/tiers.js";
import type { KnownFact } from "../facts/known-facts.js";
import { normalisePath } from "../paths.js";
import type {
  AbsenceClaim,
  AnalyseItems,
  AnalyseValidation,
  ContentNotice,
  Finding,
  Gap,
} from "../validation/analyse.js";
import type {
  AnalyseExpansionItems,
  AnalyseExpansionValidation,
} from "../validation/analyse-expansion.js";
import type { CitationContext, EntryEvidence, Evidence } from "../validation/citations.js";
import { deterministicGapCoverage } from "../validation/coverage.js";
import type { Accepted, ValidationEvent, ValidationResult } from "../validation/pipeline.js";
import { currentState } from "./current.js";
import { type FailedTarget, recordFailedItems } from "./failed.js";
import type { Revised, SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// Accepted model output into records (IMPL §4.4.3, §4.5). Code creates every evidence record and
// ID; the model's aliases are resolved through the call's table, whose `F` and `C` entries name
// the current revisions sent. Records are appended so that every reference points back:
// evidence, then findings, then withdrawals, then conflicts and their outcomes, then content
// notices, then the failed items.

export interface CallRecording {
  readonly log: SessionLog;
  readonly snapshotId: string;
  /** The call's lineage ID: `producedBy` of every record it creates. */
  readonly modelCallId: string;
  /** The call's alias table and citable items, as validation saw them. */
  readonly context: CitationContext;
}

/** The lineage IDs given to the response's local keys. */
export interface RecordedKeys {
  readonly findings: ReadonlyMap<string, string>;
  readonly conflicts: ReadonlyMap<string, string>;
}

const FAILED_TARGETS: Readonly<Record<string, FailedTarget>> = {
  findings: { type: "finding", kind: "claim" },
  gaps: { type: "finding", kind: "gap" },
  absenceClaims: { type: "finding", kind: "absence" },
  conflicts: { type: "conflict" },
  revisions: { type: "failed_item", collection: "revisions" },
  expansionRequests: { type: "failed_item", collection: "expansionRequests" },
  contentNotices: { type: "failed_item", collection: "contentNotices" },
};

/**
 * Known facts and the deterministic gaps (IMPL §3.2.5, §1.5): findings produced by code, with
 * entry or line evidence. Returns their record IDs in order, for the alias table.
 */
export function recordKnownFacts(
  log: SessionLog,
  snapshotId: string,
  facts: readonly KnownFact[],
  gaps: readonly SelectionGap[],
): string[] {
  const facts_ = facts.map(
    (fact) =>
      log.start({
        type: "finding",
        snapshotId,
        producedBy: "deterministic",
        status: "active",
        kind: "claim",
        statement: fact.statement,
        mode: fact.mode,
        scope:
          fact.scope.kind === "repository"
            ? fact.scope
            : { kind: "paths", paths: [...fact.scope.paths] },
        basis: [...fact.basis],
        evidenceIds: fact.evidence.map((e) => appendEvidence(log, snapshotId, e).id),
        fact: fact.fact,
      }).id,
  );
  const gaps_ = gaps.map(
    (gap) =>
      log.start({
        type: "finding",
        snapshotId,
        producedBy: "deterministic",
        status: "active",
        kind: "gap",
        statement: gap.statement,
        gapType: gap.gapType,
        relatedPaths: [...gap.relatedPaths],
        relatedPathHashes:
          gap.relatedPathHashes === undefined ? undefined : [...gap.relatedPathHashes],
        coverage: deterministicGapCoverage(gap),
        evidenceIds: [],
      }).id,
  );
  return [...facts_, ...gaps_];
}

export function recordAnalyse(call: CallRecording, validation: AnalyseValidation): RecordedKeys {
  const { result } = validation;
  if (result.status !== "validated") return { findings: new Map(), conflicts: new Map() };
  const recorder = new Recorder(call, result);
  recorder.findings(result.accepted.findings, new Map());
  recorder.gaps(result.accepted.gaps);
  recorder.absenceClaims(result.accepted.absenceClaims);
  recorder.conflicts(result.accepted.conflicts, validation.conflictMembers, new Map());
  recorder.notices(result.accepted.contentNotices);
  recordFailedItems(call.log, call.modelCallId, result, FAILED_TARGETS);
  return recorder.keys();
}

/**
 * As `recordAnalyse`, plus the revisions of call-1 records: a finding `withdraw` appends its
 * next revision; a `replace` makes the replacement supersede the target. Every call-1 conflict's
 * outcome maps as §4.5 says, and `kept` appends nothing.
 */
export function recordAnalyseExpansion(
  call: CallRecording,
  validation: AnalyseExpansionValidation,
): RecordedKeys {
  const { result } = validation;
  if (result.status !== "validated") return { findings: new Map(), conflicts: new Map() };
  const recorder = new Recorder(call, result);
  const { accepted, redirects } = result;

  // Every call-1 record the response acts on must still be the revision it was sent, checked
  // before anything is appended, so a refusal leaves the log as it was.
  for (const { value } of accepted.revisions)
    recorder.aliasRecord(value.target, value.target.startsWith("F-") ? "finding" : "conflict");
  for (const outcome of validation.conflictOutcomes)
    if (outcome.status !== "kept") recorder.aliasRecord(outcome.alias, "conflict");

  const replacedFindings = new Map<string, string[]>();
  const withdrawnFindings: string[] = [];
  for (const { value } of accepted.revisions) {
    if (!value.target.startsWith("F-")) continue;
    const record = recorder.aliasRecord(value.target, "finding");
    if (value.action === "withdraw") withdrawnFindings.push(record.findingId);
    else {
      const key = redirects.get(value.replacement) ?? value.replacement;
      replacedFindings.set(key, [...(replacedFindings.get(key) ?? []), record.id]);
    }
  }
  const replacedConflicts = new Map<string, string[]>();
  for (const outcome of validation.conflictOutcomes)
    if (outcome.status === "replaced") {
      const record = recorder.aliasRecord(outcome.alias, "conflict");
      const key = outcome.replacement;
      replacedConflicts.set(key, [...(replacedConflicts.get(key) ?? []), record.id]);
    }

  recorder.findings(accepted.findings, replacedFindings);
  recorder.gaps(accepted.gaps);
  recorder.absenceClaims(accepted.absenceClaims);
  for (const findingId of withdrawnFindings)
    call.log.revise("finding", findingId, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
      revisedBy: call.modelCallId,
    });
  recorder.conflicts(accepted.conflicts, validation.conflictMembers, replacedConflicts);
  for (const outcome of validation.conflictOutcomes) {
    if (outcome.status === "kept" || outcome.status === "replaced") continue;
    const { conflictId } = recorder.aliasRecord(outcome.alias, "conflict");
    if (outcome.status === "revised")
      call.log.revise("conflict", conflictId, {
        findingIds: outcome.members.map((member) => recorder.findingLineage(member)),
        status: "unresolved",
        resolvingDecisionId: undefined,
        revisedBy: call.modelCallId,
      });
    else
      call.log.revise("conflict", conflictId, {
        status: "withdrawn",
        withdrawnReason: outcome.withdrawnReason,
        revisedBy: call.modelCallId,
      });
  }
  recorder.notices(accepted.contentNotices);
  recordFailedItems(call.log, call.modelCallId, result, FAILED_TARGETS);
  return recorder.keys();
}

/**
 * A decision resolves a current, unresolved conflict: its next revision, `resolved`, names the
 * decision (§4.5).
 */
export function resolveConflict(
  log: SessionLog,
  conflictId: string,
  decisionId: string,
): Revised<"conflict"> {
  const decision = log.require("decision", decisionId);
  if (decision.conflictId !== conflictId)
    throw new Error(`${decisionId} doesn't answer conflict ${conflictId}`);
  // Only a current conflict can be resolved: not withdrawn or replaced, of the active snapshot,
  // and with every member finding current, so none corrected (§4.4.2).
  const current = currentState(log.records).conflicts.get(conflictId);
  if (current === undefined) throw new Error(`conflict ${conflictId} is not current`);
  if (current.status !== "unresolved") throw new Error(`conflict ${conflictId} is not unresolved`);
  return log.revise("conflict", conflictId, {
    status: "resolved",
    resolvingDecisionId: decisionId,
  });
}

type Items = AnalyseItems | AnalyseExpansionItems;
type Validated = Extract<ValidationResult<Items, unknown>, { status: "validated" }>;

class Recorder {
  readonly #call: CallRecording;
  readonly #result: Validated;
  readonly #events = new Map<string, ValidationEvent[]>();
  readonly #findings = new Map<string, string>();
  readonly #conflicts = new Map<string, string>();

  constructor(call: CallRecording, result: Validated) {
    this.#call = call;
    this.#result = result;
    for (const event of result.events) {
      const list = this.#events.get(event.itemKey) ?? [];
      list.push(event);
      this.#events.set(event.itemKey, list);
    }
  }

  keys(): RecordedKeys {
    return { findings: this.#findings, conflicts: this.#conflicts };
  }

  /** The current record an `F` or `C` alias names. A miss is a bug in the caller. */
  aliasRecord<T extends "finding" | "conflict">(alias: string, type: T): Revised<T> {
    const entry = this.#call.context.aliases.entries.find((e) => e.alias === alias);
    if (entry?.target.kind !== "record") throw new Error(`${alias} names no record`);
    const record = this.#call.log.require(type, entry.target.recordId);
    if ((record as { status: string }).status === "failed_validation")
      throw new Error(`${alias} names a record that failed validation`);
    // The call acted on the revision it was sent; if the lineage has moved on since, nothing it
    // says about that revision can be applied (§4.4.1, alias targets).
    const { id } = record as { readonly id: string };
    if (this.#call.log.isSuperseded(id))
      throw new Error(`${alias} names ${id}, which has been superseded since the call`);
    return record as Revised<T>;
  }

  /** A member as validation resolved it: a local key of this response, or an `F` alias. */
  findingLineage(member: string): string {
    const local = this.#findings.get(member);
    if (local !== undefined) return local;
    return this.aliasRecord(member, "finding").findingId;
  }

  findings(
    accepted: readonly Accepted<Finding>[],
    replaced: ReadonlyMap<string, readonly string[]>,
  ): void {
    const { log, snapshotId, modelCallId } = this.#call;
    const proposed = (this.#result.response as { findings: readonly Finding[] }).findings;
    for (const item of accepted) {
      const { value } = item;
      const citations = proposed[item.index]?.citations ?? [];
      const failedCitations: FailedCitation[] = [];
      const kept: (ReturnType<typeof correctionOf> | undefined)[] = [];
      citations.forEach((citation, index) => {
        const events = this.#events.get(`${item.key}/citations/${index}`) ?? [];
        const rejectedBy = [
          ...new Set(events.filter((e) => e.outcome === "rejected").map((e) => e.rule)),
        ];
        if (rejectedBy.length > 0) failedCitations.push({ ...citation, rejectedBy });
        else kept.push(correctionOf(events));
      });
      if (
        value.evidence === undefined ||
        value.droppedCitations === undefined ||
        value.basis === undefined
      )
        throw new Error(`${item.key}: finding not checked`);
      const evidence = value.evidence;
      if (evidence.length !== kept.length)
        throw new Error(`${item.key}: evidence and citations differ`);
      const evidenceIds = evidence.map((e, i) => appendEvidence(log, snapshotId, e, kept[i]).id);
      const finding = log.start({
        type: "finding",
        snapshotId,
        producedBy: modelCallId,
        status: "active",
        kind: "claim",
        statement: value.statement,
        mode: value.mode,
        scope: value.scope,
        basis: [...value.basis],
        evidenceIds,
        uncertainty: value.uncertainty,
        droppedCitations: value.droppedCitations,
        failedCitations: failedCitations.length > 0 ? failedCitations : undefined,
        supersedes: replaced.get(item.key),
      });
      this.#findings.set(item.key, finding.findingId);
    }
  }

  gaps(accepted: readonly Accepted<Gap>[]): void {
    const { log, snapshotId, modelCallId } = this.#call;
    for (const item of accepted) {
      const { value } = item;
      if (value.coverage === undefined) throw new Error(`${item.key}: gap without coverage`);
      const gap = log.start({
        type: "finding",
        snapshotId,
        producedBy: modelCallId,
        status: "active",
        kind: "gap",
        statement: value.statement,
        gapType: value.gapType,
        relatedPaths: value.relatedPaths,
        coverage: value.coverage,
        evidenceIds: [],
      });
      this.#findings.set(item.key, gap.findingId);
    }
  }

  absenceClaims(accepted: readonly Accepted<AbsenceClaim>[]): void {
    const { log, snapshotId, modelCallId } = this.#call;
    for (const item of accepted) {
      const { value } = item;
      const pathGlob = normalisePath(value.pathGlob);
      if (
        value.statement === undefined ||
        value.unenteredDirectories === undefined ||
        pathGlob === undefined
      )
        throw new Error(`${item.key}: absence claim not checked`);
      const evidence = log.append({
        type: "evidence",
        snapshotId,
        kind: "absence_check",
        pathGlob,
        unenteredDirectories: [...value.unenteredDirectories],
        basis: "code_observation",
      });
      const claim = log.start({
        type: "finding",
        snapshotId,
        producedBy: modelCallId,
        status: "active",
        kind: "absence",
        statement: value.statement,
        pathGlob: value.pathGlob,
        reason: value.reason,
        basis: ["code_observation"],
        evidenceIds: [evidence.id],
      });
      this.#findings.set(item.key, claim.findingId);
    }
  }

  conflicts(
    accepted: readonly Accepted<{ readonly key: string; readonly description: string }>[],
    members: ReadonlyMap<string, readonly string[]>,
    replaced: ReadonlyMap<string, readonly string[]>,
  ): void {
    const { log, snapshotId, modelCallId } = this.#call;
    for (const item of accepted) {
      const list = members.get(item.key);
      if (list === undefined) throw new Error(`${item.key}: conflict without members`);
      const conflict = log.start({
        type: "conflict",
        snapshotId,
        producedBy: modelCallId,
        findingIds: list.map((member) => this.findingLineage(member)),
        description: item.value.description,
        status: "unresolved",
        supersedes: replaced.get(item.key),
      });
      this.#conflicts.set(item.key, conflict.conflictId);
    }
  }

  notices(accepted: readonly Accepted<ContentNotice>[]): void {
    const { log, snapshotId, modelCallId, context } = this.#call;
    for (const { value } of accepted) {
      const item = context.items.get(value.item);
      if (item === undefined) throw new Error(`no citable item for ${value.item}`);
      const [lineStart, lineEnd] = value.lines.split("-").map(Number) as [number, number];
      log.append({
        type: "content_notice",
        snapshotId,
        modelCallId,
        item: value.item,
        path: item.path,
        fileHash: item.snapshotHash,
        lineStart,
        lineEnd,
        description: value.description,
      });
    }
  }
}

type FailedCitation = NonNullable<
  Extract<RecordOf<"finding">, { kind: "claim"; status: "active" | "withdrawn" }>["failedCitations"]
>[number];

/** A citation's `CIT-R01` correction, from its events. */
function correctionOf(events: readonly ValidationEvent[]) {
  const corrected = events.find((e) => e.rule === "CIT-R01" && e.outcome === "corrected");
  return corrected?.original as
    | { readonly originalLines: string; readonly correctedLines: string }
    | undefined;
}

function appendEvidence(
  log: SessionLog,
  snapshotId: string,
  evidence: Evidence | EntryEvidence,
  correction?: { readonly originalLines: string; readonly correctedLines: string },
): RecordOf<"evidence"> {
  if (evidence.kind === "entry") return log.append({ type: "evidence", snapshotId, ...evidence });
  return log.append({
    type: "evidence",
    snapshotId,
    ...evidence,
    correction:
      correction === undefined
        ? undefined
        : { originalLines: correction.originalLines, correctedLines: correction.correctedLines },
  });
}
