import type { z } from "zod";
import type { AssemblyDestination } from "../assembly/assemble.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import type { AliasTable } from "../validation/aliases.js";
import { aloneFailure } from "../validation/recommend.js";
import type {
  AffectedRecommendation,
  ExistingRecommendation,
  RecommendationBody,
  RegenerateValidation,
} from "../validation/regenerate.js";
import { assemblyTarget } from "./artifact-input.js";
import { currentState } from "./current.js";
import { activeDestination } from "./exclusion.js";
import {
  type FailedTarget,
  recordFailedItems,
  recordFailedRecommendationRevision,
} from "./failed.js";
import { type Changes, isFailed, lineageOf, type Revised, type SessionLog } from "./log.js";
import { aliasResolver, recordHeldBack, revisionFields } from "./recommendations.js";
import type { invalidatedReason, RecordOf, SessionRecord } from "./records.js";
import { resolveTarget } from "./targets.js";

// Change propagation (DM §12) and `regenerate_recommendations` into records (IMPL §3.3.6).
//
// - After a refresh, before anything else uses the recommendations, code invalidates as
//   `target_changed` every current revision whose target resolves to no block, or that no
//   longer passes alone with its target resolved, re-anchored or not.
// - The affected set: current recommendations with support that is no longer current, or a
//   finding the changed decisions' questions or conflicts cover. It is split into calls of 30.
// - A new decision that affects nothing calls the model only to unblock a held-back entry that
//   was current just before it.
// - The response's effects: a passing `keep` changes nothing; a failing one, a `drop`, and an
//   uncovered or failed action invalidate, naming the call in `revisedBy`; a `revise` appends
//   the next revision, so the recommendation is pending again.

type Revision = Revised<"recommendation_revision">;

/** The ceiling of the schema's `actions` (IMPL §3.3.6). */
export const MAX_ACTIONS_PER_CALL = 30;

export type RegenerationTrigger =
  | { readonly kind: "decision"; readonly decisionId: string }
  | { readonly kind: "refresh" };

/** The calls to make, each the recommendation IDs it is sent; none when no call is made. */
export interface RegenerationPlan {
  readonly calls: readonly (readonly string[])[];
}

/** What changed, for the call's summary. Rendering it is the prompt's (M6). */
export interface ChangeSummary {
  /** The trigger's decision, then those it supersedes. */
  readonly changedDecisionIds: readonly string[];
  /** Recommendations invalidated as `target_changed` since the last regeneration was sent. */
  readonly targetChanged: readonly string[];
}

function invalidate(
  log: SessionLog,
  recommendationId: string,
  reason: z.infer<typeof invalidatedReason>,
  revisedBy?: string,
): Revision {
  return log.revise("recommendation_revision", recommendationId, {
    status: "invalidated",
    invalidatedReason: reason,
    ...(revisedBy === undefined ? {} : { revisedBy }),
  });
}

/** The active snapshot's destination as assembly takes it, from bytes checked against its hash. */
function assemblyDestination(
  records: readonly SessionRecord[],
  destinationBytes: Uint8Array | undefined,
): AssemblyDestination {
  const snapshot = records.filter((r): r is RecordOf<"snapshot"> => r.type === "snapshot").at(-1);
  if (snapshot?.destination.state === "unavailable")
    throw new Error(`the destination is unavailable (${snapshot.destination.reason})`);
  const { bytes } = activeDestination(records, destinationBytes);
  if (destinationBytes === undefined) return { state: "absent" };
  return { state: "present", bytes, parsed: parseGuidanceBlocks(bytes) };
}

/**
 * Appends a `target_changed` invalidation, by code and so with no `revisedBy`, for every current
 * revision whose target resolves to no block in the active snapshot, or that fails REC-002's
 * destination rule or REC-003 alone with its target resolved there (§4.4.2, DM §9.4, §12).
 * Run after a refresh, before anything else uses the recommendations.
 */
export function invalidateChangedTargets(
  log: SessionLog,
  destinationBytes: Uint8Array | undefined,
): Revision[] {
  const destination = assemblyDestination(log.records, destinationBytes);
  const blocks = destination.state === "present" ? destination.parsed.blocks : [];
  const invalidated: Revision[] = [];
  for (const revision of currentState(log.records).recommendations.values()) {
    const target = resolveTarget(revision.target, blocks);
    const fails =
      target === undefined ||
      aloneFailure(
        {
          operation: revision.operation,
          target: assemblyTarget(target),
          content: revision.content,
        },
        destination,
      ) !== undefined;
    if (fails) invalidated.push(invalidate(log, revision.recommendationId, "target_changed"));
  }
  return invalidated;
}

/** The latest revision of a lineage that didn't fail validation, whatever its status. */
function latestOf<T extends "question" | "conflict">(
  records: readonly SessionRecord[],
  type: T,
  lineage: string,
): Revised<T> | undefined {
  return records
    .filter((r) => r.type === type && !isFailed(r) && lineageOf(r) === lineage)
    .at(-1) as Revised<T> | undefined;
}

function decisionOf(records: readonly SessionRecord[], id: string): RecordOf<"decision"> {
  const record = records.find((r) => r.id === id);
  if (record?.type !== "decision") throw new Error(`no decision ${id}`);
  return record;
}

/** The decision and every one it supersedes. */
function changedDecisions(records: readonly SessionRecord[], ids: readonly string[]): string[] {
  const changed: string[] = [];
  for (const id of ids)
    for (const each of [id, ...(decisionOf(records, id).supersedes ?? [])])
      if (!changed.includes(each)) changed.push(each);
  return changed;
}

/**
 * The affected set (§3.3.6, DM §12), as `recommendationId`s in the order of their current
 * revisions: support that is no longer current, a changed decision, or a finding that a changed
 * decision's question resolves, directly or through a conflict it resolves, or that is a member
 * of the decision's conflict. `changedDecisionIds` is the trigger's decision, or none.
 */
export function affectedRecommendations(
  records: readonly SessionRecord[],
  changedDecisionIds: readonly string[],
): string[] {
  const state = currentState(records);
  const changed = new Set(changedDecisions(records, changedDecisionIds));
  const covered = new Set<string>();
  const members = (conflictId: string) => {
    for (const id of latestOf(records, "conflict", conflictId)?.findingIds ?? []) covered.add(id);
  };
  for (const id of changed) {
    const decision = decisionOf(records, id);
    if (decision.questionId !== undefined) {
      const question = latestOf(records, "question", decision.questionId);
      for (const findingId of question?.findingIds ?? []) covered.add(findingId);
      for (const conflictId of question?.conflictIds ?? []) members(conflictId);
    }
    if (decision.conflictId !== undefined) members(decision.conflictId);
  }
  return [...state.recommendations.values()]
    .filter((revision) =>
      revision.support.some((entry) =>
        entry.kind === "finding"
          ? !state.findings.has(entry.findingId) || covered.has(entry.findingId)
          : !state.decisions.has(entry.decisionId) || changed.has(entry.decisionId),
      ),
    )
    .map((revision) => revision.recommendationId);
}

/**
 * Whether a new decision unblocks a held-back entry that was current just before it was
 * appended: its question, or the conflict it resolves, is one the entry's `blockedBy` names.
 * An answer appends its decision before the question's `answered` revision.
 */
function unblocksHeldBack(records: readonly SessionRecord[], decisionId: string): boolean {
  const decision = decisionOf(records, decisionId);
  const before = records.filter((r) => r.seq < decision.seq);
  const names = [decision.questionId, decision.conflictId].filter((id) => id !== undefined);
  return currentState(before).heldBack.some((entry) =>
    entry.blockedBy.some((id) => names.includes(id)),
  );
}

/** The regeneration calls a change needs (§3.3.6). Run after `invalidateChangedTargets`. */
export function planRegeneration(
  records: readonly SessionRecord[],
  trigger: RegenerationTrigger,
): RegenerationPlan {
  const decisionIds = trigger.kind === "decision" ? [trigger.decisionId] : [];
  const affected = affectedRecommendations(records, decisionIds);
  if (affected.length > 0) {
    const calls: string[][] = [];
    for (let i = 0; i < affected.length; i += MAX_ACTIONS_PER_CALL)
      calls.push(affected.slice(i, i + MAX_ACTIONS_PER_CALL));
    return { calls };
  }
  if (trigger.kind === "decision" && unblocksHeldBack(records, trigger.decisionId))
    return { calls: [[]] };
  return { calls: [] };
}

export function changeSummary(
  records: readonly SessionRecord[],
  trigger: RegenerationTrigger,
): ChangeSummary {
  // A call that failed, was interrupted or is still to be retried hasn't told the model.
  const completed = new Set(
    records.flatMap((r) =>
      r.type === "model_call" && r.state === "completed" ? [r.modelCallId] : [],
    ),
  );
  const lastSent =
    records
      .filter(
        (r) =>
          r.type === "model_call" &&
          r.revision === 1 &&
          r.purpose === "regenerate_recommendations" &&
          completed.has(r.modelCallId),
      )
      .at(-1)?.seq ?? 0;
  const targetChanged: string[] = [];
  for (const r of records)
    if (
      r.type === "recommendation_revision" &&
      r.seq > lastSent &&
      r.status === "invalidated" &&
      r.invalidatedReason === "target_changed"
    )
      targetChanged.push(r.recommendationId as string);
  return {
    changedDecisionIds:
      trigger.kind === "decision" ? changedDecisions(records, [trigger.decisionId]) : [],
    targetChanged,
  };
}

// --- The call's input ----------------------------------------------------------------------

/**
 * The regeneration-specific part of the call's context (§3.3.6): each `R` alias's current
 * revision in the table's aliases, and the current recommendations outside the plan's whole
 * affected set, for DUP-004, with targets resolved in the active snapshot. `affectedSet` is every
 * recommendation the plan's calls are sent, so a split call doesn't compare with a later part.
 * Run after `invalidateChangedTargets`.
 */
export function regenerationInput(
  records: readonly SessionRecord[],
  destinationBytes: Uint8Array | undefined,
  aliases: AliasTable,
  affectedSet: readonly string[],
): {
  readonly affected: ReadonlyMap<string, AffectedRecommendation>;
  readonly unaffected: readonly ExistingRecommendation[];
} {
  const { blocks } = activeDestination(records, destinationBytes);
  const byId = new Map(records.map((r) => [r.id, r]));
  const findingAlias = new Map<string, string>();
  const decisionAlias = new Map<string, string>();
  const blockAlias = new Map<string, string>();
  for (const entry of aliases.entries) {
    if (entry.target.kind === "block")
      blockAlias.set(`${entry.target.blockId}\n${entry.target.hash}`, entry.alias);
    if (entry.target.kind !== "record") continue;
    const record = byId.get(entry.target.recordId);
    if (entry.kind === "F" && record?.type === "finding")
      findingAlias.set(lineageOf(record) as string, entry.alias);
    if (entry.kind === "D") decisionAlias.set(entry.target.recordId, entry.alias);
  }

  const toBlock = (ref: { blockId: string; blockHash: string }) => {
    const alias = blockAlias.get(`${ref.blockId}\n${ref.blockHash}`);
    if (alias === undefined) throw new Error(`block ${ref.blockId} has no alias in this call`);
    return alias;
  };
  const aliasForm = (revision: Revision): RecommendationBody | undefined => {
    const target = resolveTarget(revision.target, blocks);
    if (target === undefined)
      throw new Error(`${revision.id}: invalidate it as target_changed first`);
    const support: string[] = [];
    for (const entry of revision.support) {
      const alias =
        entry.kind === "finding"
          ? findingAlias.get(entry.findingId)
          : decisionAlias.get(entry.decisionId);
      if (alias === undefined) return undefined;
      support.push(alias);
    }
    const references: RecommendationBody["references"] = [];
    for (const reference of revision.references) {
      const alias = findingAlias.get(reference.supportingFindingId);
      if (alias === undefined) return undefined;
      references.push({ kind: reference.kind, value: reference.value, support: alias });
    }
    return {
      kind: revision.kind,
      operation: revision.operation,
      target:
        target.kind === "newSection"
          ? {
              kind: "newSection",
              heading: target.heading,
              ...(target.after === undefined ? {} : { after: toBlock(target.after) }),
            }
          : target.kind === "section"
            ? { kind: "section", heading: toBlock(target) }
            : { kind: target.kind, block: toBlock(target) },
      ...(revision.content === undefined ? {} : { content: revision.content }),
      rationale: revision.rationale,
      support,
      references,
      scope:
        revision.scope.kind === "repository"
          ? { kind: "repository" }
          : { kind: "paths", paths: [...revision.scope.paths] },
    };
  };

  const affected = new Map<string, AffectedRecommendation>();
  const sent = new Set<string>();
  for (const entry of aliases.entries) {
    if (entry.kind !== "R" || entry.target.kind !== "record") continue;
    const record = byId.get(entry.target.recordId);
    if (record?.type !== "recommendation_revision" || isFailed(record))
      throw new Error(`${entry.alias} names no recommendation revision`);
    const revision = record as unknown as Revision;
    sent.add(revision.recommendationId);
    affected.set(entry.alias, { operation: revision.operation, revision: aliasForm(revision) });
  }
  const unaffected = [...currentState(records).recommendations.values()]
    .filter(
      (revision) =>
        !sent.has(revision.recommendationId) && !affectedSet.includes(revision.recommendationId),
    )
    .map((revision): ExistingRecommendation => {
      const target = resolveTarget(revision.target, blocks);
      if (target === undefined)
        throw new Error(`${revision.id}: invalidate it as target_changed first`);
      return {
        operation: revision.operation,
        target: assemblyTarget(target),
        content: revision.content,
      };
    });
  return { affected, unaffected };
}

// --- Recording the response ----------------------------------------------------------------

export interface RegenerateRecording {
  readonly log: SessionLog;
  readonly modelCallId: string;
  readonly aliases: AliasTable;
}

export interface RecordedRegeneration {
  /** The `recommendationId` given to each accepted addition's local key. */
  readonly additions: ReadonlyMap<string, string>;
  readonly heldBack: readonly RecordOf<"held_back">[];
}

const FAILED_TARGETS: Readonly<Record<string, FailedTarget>> = {
  actions: { type: "failed_item", collection: "actions" },
  heldBack: { type: "failed_item", collection: "heldBack" },
};

/**
 * Appends the records of a validated response (§3.3.6, §4.4.3): failed records first, in the
 * pipeline's order; then each affected recommendation's effect, in alias order; then additions
 * and held-back entries. A response that failed the schema records nothing.
 */
export function recordRegenerate(
  call: RegenerateRecording,
  validation: RegenerateValidation,
): RecordedRegeneration {
  const { result } = validation;
  if (result.status !== "validated") return { additions: new Map(), heldBack: [] };
  const { log, modelCallId, aliases } = call;
  const resolve = aliasResolver(call);
  const affectedAliases = aliases.entries.filter((e) => e.kind === "R").map((e) => e.alias);
  const lineage = (alias: string): string => {
    const record = resolve(alias);
    if (record.type !== "recommendation_revision") throw new Error(`${alias} isn't a revision`);
    return lineageOf(record) as string;
  };

  for (const item of result.rejected) {
    if (item.collection === "actions") {
      const action = result.response.actions[item.index];
      if (action?.action === "revise" && affectedAliases.includes(action.target))
        recordFailedRecommendationRevision(log, {
          recommendationId: lineage(action.target),
          producedBy: modelCallId,
          itemKey: item.key,
          rule: item.rule,
          proposed: action,
        });
      else recordFailedItems(log, modelCallId, { ...result, rejected: [item] }, FAILED_TARGETS);
    } else if (item.collection === "additions")
      recordFailedRecommendationRevision(log, {
        producedBy: modelCallId,
        itemKey: item.key,
        rule: item.rule,
        proposed: result.response.additions[item.index],
      });
    else recordFailedItems(log, modelCallId, { ...result, rejected: [item] }, FAILED_TARGETS);
  }

  const actions = new Map(result.accepted.actions.map(({ value }) => [value.target, value]));
  for (const alias of affectedAliases) {
    const id = lineage(alias);
    const action = actions.get(alias);
    if (action === undefined) invalidate(log, id, "not_reconsidered", modelCallId);
    else if (action.action === "drop") invalidate(log, id, "dropped_by_model", modelCallId);
    else if (action.action === "keep") {
      if (action.kept?.ok !== true) invalidate(log, id, "revalidation_failed", modelCallId);
    } else {
      if (action.checked === undefined)
        throw new Error(`revise of ${alias} was accepted unchecked`);
      // A new revision with new content names its own call in `producedBy` (§4.4.1).
      const changes = revisionFields(action.checked, resolve, modelCallId);
      log.revise(
        "recommendation_revision",
        id,
        changes as unknown as Changes<"recommendation_revision">,
      );
    }
  }

  const additions = new Map<string, string>();
  for (const { key, value } of result.accepted.additions) {
    const revision = log.start({
      type: "recommendation_revision",
      ...revisionFields(value, resolve, modelCallId),
    });
    additions.set(key, revision.recommendationId);
  }
  const heldBack = recordHeldBack(
    log,
    modelCallId,
    result.accepted.heldBack.map(({ value }) => value),
    resolve,
  );
  return { additions, heldBack };
}
