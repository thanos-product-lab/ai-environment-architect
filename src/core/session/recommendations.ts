import type { AssemblyTarget } from "../assembly/assemble.js";
import type { AliasTable } from "../validation/aliases.js";
import type {
  HeldBack,
  RecommendationItem,
  RecommendValidation,
  ResolvedReference,
} from "../validation/recommend.js";
import {
  type FailedTarget,
  recordFailedItems,
  recordFailedRecommendationRevision,
} from "./failed.js";
import { lineageOf, type Revised, type SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// `recommend` output into records (IMPL §3.3.5, §4.4.1, §4.4.3). Every accepted recommendation
// starts a lineage with a `valid` first revision; code resolves its aliases through the call's
// table: support to typed entries (a finding by lineage ID, a decision by record ID), the target
// to the block's ID and hash, and each reference to its finding and evidence. Accepted held-back
// entries and the no-change reason are immutable records. Every rejected item becomes a failed
// record, in the pipeline's order.

export interface RecommendRecording {
  readonly log: SessionLog;
  /** The call's lineage ID: `producedBy` and `modelCallId` of every record it creates. */
  readonly modelCallId: string;
  /** The call's alias table, as validation saw it. */
  readonly aliases: AliasTable;
}

export interface RecordedRecommendations {
  /** The `recommendationId` given to each accepted local key. */
  readonly recommendations: ReadonlyMap<string, string>;
  readonly heldBack: readonly RecordOf<"held_back">[];
  readonly noChangeReason?: RecordOf<"no_change_reason">;
}

const FAILED_TARGETS: Readonly<Record<string, FailedTarget>> = {
  heldBack: { type: "failed_item", collection: "heldBack" },
  noChangeReason: { type: "failed_item", collection: "noChangeReason" },
};

export function recordRecommend(
  call: RecommendRecording,
  validation: RecommendValidation,
): RecordedRecommendations {
  const { result } = validation;
  if (result.status !== "validated") return { recommendations: new Map(), heldBack: [] };
  const { log, modelCallId } = call;
  const resolve = aliasResolver(call);

  const recommendations = new Map<string, string>();
  for (const { key, value } of result.accepted.recommendations) {
    const revision = log.start({
      type: "recommendation_revision",
      ...revisionFields(value, resolve, modelCallId),
    });
    recommendations.set(key, revision.recommendationId);
  }

  const heldBack = recordHeldBack(
    log,
    modelCallId,
    result.accepted.heldBack.map(({ value }) => value),
    resolve,
  );

  const reason = result.accepted.noChangeReason[0];
  const noChangeReason =
    reason === undefined
      ? undefined
      : log.append({ type: "no_change_reason", reason: reason.value.text, modelCallId });

  for (const item of result.rejected) {
    if (item.collection === "recommendations") {
      recordFailedRecommendationRevision(log, {
        producedBy: modelCallId,
        itemKey: item.key,
        rule: item.rule,
        proposed: result.response.recommendations[item.index],
      });
    } else recordFailedItems(log, modelCallId, { ...result, rejected: [item] }, FAILED_TARGETS);
  }

  return { recommendations, heldBack, ...(noChangeReason === undefined ? {} : { noChangeReason }) };
}

type Resolved = RecordOf<
  "finding" | "decision" | "question" | "conflict" | "recommendation_revision"
>;

/**
 * The fields of a valid revision from an accepted recommendation, its aliases resolved through
 * the call's table: support to typed entries, the target to block IDs and hashes, and each
 * reference to its finding and evidence (§4.4.1).
 */
export function revisionFields(
  value: RecommendationItem,
  resolve: (alias: string) => Resolved,
  producedBy: string,
) {
  if (value.resolvedTarget === undefined || value.resolvedReferences === undefined)
    throw new Error(`recommendation ${value.key} was accepted unresolved`);
  return {
    kind: value.kind,
    operation: value.operation,
    target: recordedTarget(value.resolvedTarget),
    content: value.content,
    rationale: value.rationale,
    support: value.support.map((alias) => {
      const record = resolve(alias);
      if (record.type === "finding")
        return { kind: "finding" as const, findingId: lineage(record) };
      if (record.type === "decision") return { kind: "decision" as const, decisionId: record.id };
      throw new Error(`support ${alias} names a ${record.type}`);
    }),
    references: value.resolvedReferences.map((r) => recordedReference(r, resolve)),
    scope:
      value.scope.kind === "repository"
        ? value.scope
        : { kind: "paths" as const, paths: [...value.scope.paths] },
    producedBy,
    status: "valid" as const,
  };
}

/** One immutable `held_back` record per accepted entry, blockers by lineage ID. */
export function recordHeldBack(
  log: SessionLog,
  modelCallId: string,
  entries: readonly HeldBack[],
  resolve: (alias: string) => Resolved,
): RecordOf<"held_back">[] {
  return entries.map((value) =>
    log.append({
      type: "held_back",
      topic: value.topic,
      blockedBy: value.blockedBy.map((alias) => {
        const record = resolve(alias);
        const id = lineageOf(record);
        if ((record.type === "question" || record.type === "conflict") && id !== undefined)
          return id;
        throw new Error(`blockedBy ${alias} names a ${record.type}`);
      }),
      modelCallId,
    }),
  );
}

/** An alias to the exact record sent, through the call's table (§3.2.1, §4.4.1). */
export function aliasResolver(call: RecommendRecording): (alias: string) => Resolved {
  return (alias) => {
    const entry = call.aliases.entries.find((e) => e.alias === alias);
    if (entry?.target.kind !== "record") throw new Error(`${alias} names no record`);
    const record = call.log.get(entry.target.recordId);
    if (record === undefined) throw new Error(`no record ${entry.target.recordId}`);
    return record as Resolved;
  };
}

function lineage(record: RecordOf<"finding">): string {
  const id = lineageOf(record);
  if (id === undefined) throw new Error(`finding ${record.id} failed validation`);
  return id;
}

function recordedTarget(target: AssemblyTarget): Revised<"recommendation_revision">["target"] {
  if (target.kind !== "newSection")
    return { kind: target.kind, blockId: target.blockId, blockHash: target.blockHash };
  return {
    kind: "newSection",
    heading: target.heading,
    ...(target.after === undefined
      ? {}
      : { after: { blockId: target.after.blockId, blockHash: target.after.blockHash } }),
  };
}

function recordedReference(reference: ResolvedReference, resolve: (alias: string) => Resolved) {
  const finding = resolve(reference.support);
  if (finding.type !== "finding") throw new Error(`${reference.support} isn't a finding`);
  const fields = {
    value: reference.value,
    supportingFindingId: lineage(finding),
    evidenceId: reference.evidenceId,
  };
  return reference.kind === "path"
    ? { kind: "path" as const, ...fields, verification: "exists_in_snapshot" as const }
    : { kind: "command" as const, ...fields, verification: "found_not_run" as const };
}
