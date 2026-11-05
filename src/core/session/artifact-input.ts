import type { AssemblyRevision, AssemblyTarget } from "../assembly/assemble.js";
import type { GuidanceBlock } from "../destination/guidance-blocks.js";
import { lineageOf, type Revised } from "./log.js";
import type { SessionRecord } from "./records.js";
import { resolveTarget } from "./targets.js";

// What an artifact revision is built from (DM §9.4). Proposing an artifact and the load check
// that assembles it again (IMPL §4.9 check 9) share these, so both derive the same input.

type Revision = Revised<"recommendation_revision">;

/** The decisions the revisions depend on: their decision support, once each, in their order. */
export function decisionIdsOf(revisions: readonly Revision[]): string[] {
  const ids: string[] = [];
  for (const revision of revisions)
    for (const entry of revision.support)
      if (entry.kind === "decision" && !ids.includes(entry.decisionId)) ids.push(entry.decisionId);
  return ids;
}

/**
 * The revisions as assembly takes them, with targets resolved in `blocks`, the destination of the
 * artifact's snapshot. `firstSeq` is the `seq` of each recommendation's first revision. Names the
 * first revision whose target resolves to no block instead.
 */
export function assemblyRevisionsOf(
  records: readonly SessionRecord[],
  revisions: readonly Revision[],
  blocks: readonly GuidanceBlock[],
): { readonly revisions: AssemblyRevision[] } | { readonly unresolved: string } {
  const firstSeq = new Map<string, number>();
  for (const record of records)
    if (record.type === "recommendation_revision") {
      const lineage = lineageOf(record) as string;
      if (!firstSeq.has(lineage)) firstSeq.set(lineage, record.seq);
    }
  const result: AssemblyRevision[] = [];
  for (const revision of revisions) {
    const target = resolveTarget(revision.target, blocks);
    if (target === undefined) return { unresolved: revision.id };
    result.push({
      revisionId: revision.id,
      firstSeq: firstSeq.get(revision.recommendationId) ?? revision.seq,
      operation: revision.operation,
      target: assemblyTarget(target),
      ...(revision.content === undefined ? {} : { content: revision.content }),
    });
  }
  return { revisions: result };
}

/** A recorded target as assembly types it: a `newSection` without `after` has no such key. */
export function assemblyTarget(target: Revision["target"]): AssemblyTarget {
  if (target.kind === "newSection")
    return target.after === undefined
      ? { kind: "newSection", heading: target.heading }
      : { kind: "newSection", heading: target.heading, after: target.after };
  return target;
}
