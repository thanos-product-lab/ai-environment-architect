import { sectionLastIndex } from "../assembly/assemble.js";
import type { GuidanceBlock } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import type { Revised } from "./log.js";
import type { RecordOf, SessionRecord } from "./records.js";
import { resolveBlockRef } from "./targets.js";

// Mutual exclusion (DM §9.1 "No dependencies between recommendations"). Two `revise` or `remove`
// recommendations on one block are exclusive, and so are a `remove` of a heading and any
// `revise` or `remove` of a block in its section, the heading included. Additions are never
// exclusive. Targets are compared in the active snapshot, through target resolution (IMPL
// §4.4.2), so a refresh can make two accepted recommendations clash (DM §9.2).

/** The active snapshot's destination: its bytes give heading levels (DM §9.1). */
export interface ActiveDestination {
  readonly bytes: Uint8Array;
  readonly blocks: readonly GuidanceBlock[];
}

type Revision = Revised<"recommendation_revision">;

export type ExclusionReason =
  /** Both revise or remove the same block. */
  | { readonly reason: "same_block" }
  /**
   * One removes a section that holds the other's block, the heading included; `sectionRemovedBy`
   * says which.
   */
  | { readonly reason: "section"; readonly sectionRemovedBy: string };

/**
 * The active snapshot's destination, from the bytes the caller read for it. The bytes must hash
 * to the snapshot's destination; a destination that isn't present has no bytes and no blocks.
 */
export function activeDestination(
  records: readonly SessionRecord[],
  bytes: Uint8Array | undefined,
): ActiveDestination {
  const snapshot = records.filter((r): r is RecordOf<"snapshot"> => r.type === "snapshot").at(-1);
  if (snapshot === undefined) throw new Error("the session has no snapshot");
  const { destination } = snapshot;
  if (destination.state !== "present") {
    if (bytes !== undefined) throw new Error(`the active destination is ${destination.state}`);
    return { bytes: new Uint8Array(), blocks: [] };
  }
  if (bytes === undefined || sha256(bytes) !== destination.hash)
    throw new Error(`these bytes aren't the destination of the active snapshot ${snapshot.id}`);
  return { bytes, blocks: destination.blocks as readonly GuidanceBlock[] };
}

/** The block indices a revision changes in the destination; none for an addition. */
function changedRange(revision: Revision, destination: ActiveDestination): readonly number[] {
  if (revision.operation === "add") return [];
  const { target } = revision;
  if (target.kind !== "block")
    throw new Error(`${revision.id}: a ${revision.operation} needs a block target`);
  const block = resolveBlockRef(target, destination.blocks);
  if (block === undefined)
    throw new Error(
      `${revision.id}: its target resolves to no block; invalidate it as target_changed first`,
    );
  const index = destination.blocks.indexOf(block);
  const last = removesSection(revision, block)
    ? sectionLastIndex(destination.bytes, destination.blocks, index)
    : index;
  return Array.from({ length: last - index + 1 }, (_, i) => index + i);
}

function removesSection(revision: Revision, block: GuidanceBlock): boolean {
  return revision.operation === "remove" && block.type === "heading";
}

/**
 * The blocks, by ID in the destination, that a `revise` or `remove` changes: its block, or a
 * removed heading's whole section. None for an addition.
 */
export function changedBlocks(
  revision: Revision,
  destination: ActiveDestination,
): readonly string[] {
  return changedRange(revision, destination).map(
    (i) => (destination.blocks[i] as GuidanceBlock).blockId,
  );
}

/**
 * Why `a` and `b` can't both be accepted, or undefined. When exactly one removes a section that
 * holds the other's block, the heading included, the reason is `section`; otherwise two changes
 * of one block, such as two removals of one section, are `same_block`.
 */
export function exclusionBetween(
  a: Revision,
  b: Revision,
  destination: ActiveDestination,
): ExclusionReason | undefined {
  const ra = changedRange(a, destination);
  const rb = changedRange(b, destination);
  const [fa, fb] = [ra[0], rb[0]];
  if (fa === undefined || fb === undefined) return undefined;
  // A range is one block, or a section from its heading, and sections nest without partly
  // overlapping: one holds the other's block exactly when it holds its first index.
  const aSection = removesSection(a, destination.blocks[fa] as GuidanceBlock);
  const bSection = removesSection(b, destination.blocks[fb] as GuidanceBlock);
  if (aSection !== bSection || fa !== fb) {
    if (aSection && ra.includes(fb))
      return { reason: "section", sectionRemovedBy: a.recommendationId };
    if (bSection && rb.includes(fa))
      return { reason: "section", sectionRemovedBy: b.recommendationId };
  }
  return fa === fb ? { reason: "same_block" } : undefined;
}
