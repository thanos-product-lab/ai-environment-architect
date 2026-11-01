import type { RejectedItem, ValidationResult } from "../validation/pipeline.js";
import type { SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// Items that failed validation (IMPL §4.4.3). Every item the item or cross-item stage rejects
// becomes one record: its own type where it has one, otherwise a `failed_item`. It holds the
// envelope, the rule that rejected it and the item exactly as written, and nothing else: no
// evidence, no basis, no code-written statement. A schema failure has no items, so none.

/** Where a collection's failed items go. */
export type FailedTarget =
  | { readonly type: "finding"; readonly kind: "claim" | "gap" | "absence" }
  | { readonly type: "conflict" }
  | { readonly type: "question" }
  | {
      readonly type: "failed_item";
      readonly collection: RecordOf<"failed_item">["collection"];
    };

type Validated = Extract<ValidationResult<unknown, unknown>, { status: "validated" }>;

/** One failed record per rejected item, in the order the pipeline lists them. */
export function recordFailedItems(
  log: SessionLog,
  producedBy: string,
  result: Validated,
  targets: Readonly<Record<string, FailedTarget>>,
): void {
  for (const item of result.rejected) {
    const target = targets[item.collection];
    if (target === undefined) throw new Error(`no failed-record target for ${item.collection}`);
    const fields = {
      status: "failed_validation" as const,
      producedBy,
      itemKey: item.key,
      rejectedBy: [item.rule] as [string],
      proposed: proposedItem(result.response, item),
    };
    if (target.type === "finding") log.append({ type: "finding", kind: target.kind, ...fields });
    else if (target.type === "failed_item")
      log.append({ type: "failed_item", collection: target.collection, ...fields });
    else log.append({ type: target.type, ...fields });
  }
}

/**
 * A recommendation revision that failed validation. It keeps its lineage: a new one for a new
 * recommendation, or the existing one for a regeneration `revise` or a developer edit. It
 * supersedes nothing, so the earlier valid revision stays current (§4.4.1).
 */
export function recordFailedRecommendationRevision(
  log: SessionLog,
  failed: {
    readonly recommendationId?: string;
    readonly producedBy: string;
    readonly itemKey: string;
    /** The one rule that rejected it (§4.4.3). */
    readonly rule: string;
    readonly proposed: unknown;
  },
): RecordOf<"recommendation_revision"> {
  const fields = {
    type: "recommendation_revision" as const,
    status: "failed_validation" as const,
    producedBy: failed.producedBy,
    itemKey: failed.itemKey,
    rejectedBy: [failed.rule] as [string],
    proposed: json(failed.proposed),
  };
  if (failed.recommendationId === undefined) return log.start(fields);
  const last = log.revisions("recommendation_revision", failed.recommendationId).at(-1);
  if (last === undefined) throw new Error(`no recommendation ${failed.recommendationId}`);
  return log.append({
    ...fields,
    recommendationId: failed.recommendationId,
    revision: last.revision + 1,
  });
}

/** The item as the response wrote it, after the schema stage. */
function proposedItem(response: unknown, item: RejectedItem) {
  const collection = (response as Record<string, unknown>)[item.collection];
  if (!Array.isArray(collection) || collection[item.index] === undefined)
    throw new Error(`no proposed item ${item.collection}/${item.index}`);
  return json(collection[item.index]);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A copy as JSON holds it: the response was parsed from JSON, so nothing is lost. */
function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
