import { describe, expect, it } from "vitest";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { resolveBlockRef, resolveTarget } from "./targets.js";

// Target resolution (IMPL §4.4.2, DM §12): the block with the same ID and hash, otherwise the
// only block with that hash. Derived, never written.

const encode = (text: string) => new TextEncoder().encode(text);
const blocksOf = (text: string) => parseGuidanceBlocks(encode(text)).blocks;
const byId = (blocks: ReturnType<typeof blocksOf>, id: string) => {
  const block = blocks.find((b) => b.blockId === id);
  if (block === undefined) throw new Error(`no block ${id}`);
  return block;
};

const before = blocksOf("# Guide\n\nUse pnpm.\n\nRun the tests.\n");

describe("target resolution (IMPL §4.4.2)", () => {
  it("resolves to the block with the same ID and hash", () => {
    const block = byId(before, "Guide/paragraph-2");
    expect(resolveBlockRef({ blockId: block.blockId, blockHash: block.hash }, before)).toBe(block);
  });

  it("re-anchors to the only block with that hash when the ID moved", () => {
    const old = byId(before, "Guide/paragraph-2");
    const after = blocksOf("# Guide\n\nIntro.\n\nUse pnpm.\n\nRun the tests.\n");
    const moved = resolveBlockRef({ blockId: old.blockId, blockHash: old.hash }, after);
    expect(moved?.blockId).toBe("Guide/paragraph-3");
    expect(moved?.hash).toBe(old.hash);
  });

  it("prefers the same ID and hash over another block with that hash", () => {
    const blocks = blocksOf("# Guide\n\nSame.\n\nSame.\n");
    const second = byId(blocks, "Guide/paragraph-2");
    expect(resolveBlockRef({ blockId: second.blockId, blockHash: second.hash }, blocks)).toBe(
      second,
    );
  });

  it("resolves to nothing when two other blocks share the hash", () => {
    const old = byId(before, "Guide/paragraph-1");
    const after = blocksOf("# Other\n\nUse pnpm.\n\nUse pnpm.\n");
    expect(resolveBlockRef({ blockId: old.blockId, blockHash: old.hash }, after)).toBeUndefined();
  });

  it("resolves to nothing when no block has the hash", () => {
    const old = byId(before, "Guide/paragraph-1");
    const after = blocksOf("# Guide\n\nUse npm.\n");
    expect(resolveBlockRef({ blockId: old.blockId, blockHash: old.hash }, after)).toBeUndefined();
  });

  it("resolves every block a target names, and a new section with no anchor as it is", () => {
    const heading = byId(before, "Guide/heading");
    const after = blocksOf("Intro.\n\n# Guide\n\nUse pnpm.\n\nRun the tests.\n");
    const ref = { blockId: heading.blockId, blockHash: heading.hash };
    expect(resolveTarget({ kind: "section", ...ref }, after)).toEqual({
      kind: "section",
      ...ref,
    });
    expect(resolveTarget({ kind: "newSection", heading: "Notes", after: ref }, after)).toEqual({
      kind: "newSection",
      heading: "Notes",
      after: ref,
    });
    expect(resolveTarget({ kind: "newSection", heading: "Notes" }, [])).toEqual({
      kind: "newSection",
      heading: "Notes",
    });
    const gone = blocksOf("# Elsewhere\n");
    expect(resolveTarget({ kind: "block", ...ref }, gone)).toBeUndefined();
    expect(
      resolveTarget({ kind: "newSection", heading: "Notes", after: ref }, gone),
    ).toBeUndefined();
  });
});
