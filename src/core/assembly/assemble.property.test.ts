import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import "../../../test/support/fast-check-seed.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { type AssemblyRevision, assemble } from "./assemble.js";

// DM §9.3 properties over every destination fixture: the result doesn't depend on the order the
// revisions are given in, and when assembly succeeds, untouched blocks keep their bytes and order
// and every change is attributed to its revision.

const fixtures = new URL("../../../test/fixtures/destinations/", import.meta.url);
const destinations = readdirSync(fixtures)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => {
    const bytes = new Uint8Array(readFileSync(new URL(name, fixtures)));
    return { name, bytes, parsed: parseGuidanceBlocks(bytes) };
  });

type Choice = "keep" | "remove" | "revise" | "add";

describe("assembly properties (DM §9.3)", () => {
  it("is independent of input order and keeps untouched blocks byte-identical and in order", () => {
    const arbitrary = fc
      .constantFrom(...destinations.filter((d) => d.parsed.roundTrip.state === "verified"))
      .chain((d) =>
        fc.tuple(
          fc.constant(d),
          fc.array(fc.constantFrom<Choice>("keep", "remove", "revise", "add"), {
            minLength: d.parsed.blocks.length,
            maxLength: d.parsed.blocks.length,
          }),
          fc.integer(),
        ),
      );
    fc.assert(
      fc.property(arbitrary, ([d, choices, shuffleSeed]) => {
        const revisions: AssemblyRevision[] = [];
        /** How many attribution entries each revision must have: one per change or removed block. */
        const changes = new Map<string, number>();
        const untouched: string[] = [];
        const blocks = d.parsed.blocks;
        /** Blocks up to this index are inside a removed section: only additions may anchor there. */
        let removedUntil = -1;
        blocks.forEach((block, index) => {
          const ref = { blockId: block.blockId, blockHash: block.hash };
          const base = { revisionId: `rrev_${index}`, firstSeq: index + 1 };
          const push = (revision: AssemblyRevision, count = 1) => {
            revisions.push(revision);
            changes.set(revision.revisionId, count);
          };
          const choice = choices[index];
          const own = Buffer.from(
            d.bytes.subarray(block.sourceSpan.start, block.sourceSpan.end),
          ).toString("utf8");
          const inRemoved = index <= removedUntil;
          if (choice === "remove" && !inRemoved) {
            let last = index;
            if (block.type === "heading") {
              // A section ends before the next heading at its depth or shallower.
              const depth = block.headingPath.length;
              while (
                last + 1 < blocks.length &&
                !(
                  blocks[last + 1]?.type === "heading" &&
                  (blocks[last + 1]?.headingPath.length ?? 0) <= depth
                )
              ) {
                last++;
              }
              removedUntil = last;
            }
            push(
              { ...base, operation: "remove", target: { kind: "block", ...ref } },
              last - index + 1,
            );
            return;
          }
          if (choice === "revise" && block.type === "paragraph" && !inRemoved) {
            const target = { kind: "block" as const, ...ref };
            push({ ...base, operation: "revise", target, content: `Revised ${index}.` });
            return;
          }
          if (!inRemoved) untouched.push(own);
          if (choice === "add") {
            push({
              ...base,
              operation: "add",
              target: { kind: block.type === "heading" ? "section" : "after", ...ref },
              content: `Added ${index}.`,
            });
          } else if (choice === "revise" && block.type === "heading") {
            push({
              ...base,
              operation: "add",
              target: { kind: "newSection", heading: `New ${index}`, after: ref },
              content: `Section ${index}.`,
            });
          }
        });

        const shuffled = [...revisions].sort(
          (a, b) =>
            ((a.firstSeq * 7919 + shuffleSeed) % 13) - ((b.firstSeq * 7919 + shuffleSeed) % 13),
        );
        const destination = { state: "present" as const, bytes: d.bytes, parsed: d.parsed };
        const forward = assemble(destination, revisions);
        expect(assemble(destination, shuffled)).toEqual(forward);
        if (!forward.ok) return;

        const output = Buffer.from(forward.content).toString("utf8");
        let from = 0;
        for (const text of untouched) {
          const at = output.indexOf(text, from);
          expect(at).toBeGreaterThanOrEqual(0);
          from = at + text.length;
        }
        const counts = new Map<string, number>();
        for (const { revisionId } of forward.attribution) {
          counts.set(revisionId, (counts.get(revisionId) ?? 0) + 1);
        }
        expect(counts).toEqual(changes);
      }),
      { numRuns: 300 },
    );
  });
});
