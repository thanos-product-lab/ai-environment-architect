import type { GuidanceBlock } from "../destination/guidance-blocks.js";
import type { Revised } from "./log.js";

// Target resolution (IMPL §4.4.2, DM §12). A recommendation revision's target names blocks by ID
// and hash in the snapshot active when it was created. In the active snapshot it resolves to the
// block with the same ID and hash, otherwise to the only block with that hash. This re-anchoring
// is derived and never written. Writing the `target_changed` invalidation for a target that
// resolves to nothing belongs to change propagation (IMPL §3.3.6).

export interface BlockRef {
  readonly blockId: string;
  readonly blockHash: string;
}

export type RecordedTarget = Revised<"recommendation_revision">["target"];

/** The block a ref names in `blocks`, or undefined when none or several share only its hash. */
export function resolveBlockRef(
  ref: BlockRef,
  blocks: readonly GuidanceBlock[],
): GuidanceBlock | undefined {
  const exact = blocks.find((b) => b.blockId === ref.blockId && b.hash === ref.blockHash);
  if (exact !== undefined) return exact;
  const same = blocks.filter((b) => b.hash === ref.blockHash);
  return same.length === 1 ? same[0] : undefined;
}

/** The target with every block it names resolved in `blocks`, or undefined if one doesn't. */
export function resolveTarget(
  target: RecordedTarget,
  blocks: readonly GuidanceBlock[],
): RecordedTarget | undefined {
  if (target.kind === "newSection") {
    if (target.after === undefined) return target;
    const after = resolveBlockRef(target.after, blocks);
    return after === undefined
      ? undefined
      : { ...target, after: { blockId: after.blockId, blockHash: after.hash } };
  }
  const block = resolveBlockRef(target, blocks);
  return block === undefined
    ? undefined
    : { kind: target.kind, blockId: block.blockId, blockHash: block.hash };
}
