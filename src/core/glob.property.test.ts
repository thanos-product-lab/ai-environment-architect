import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { couldMatchBelow, matchSegments, segmentMatches } from "./glob.js";

// The table-based matchers agree with their definitions (IMPL §1.5, §1.11).

/** The backtracking definition: `**` absorbs zero or more segments. */
function reference(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++)
      if (reference(rest, path.slice(skip))) return true;
    return false;
  }
  const [segment, ...remaining] = path;
  return segment !== undefined && segmentMatches(head, segment) && reference(rest, remaining);
}

// A small alphabet makes matches and near misses likely.
const name = fc.constantFrom("a", "b", "ab", "ba");
const patternSegment = fc.constantFrom("a", "b", "*", "**", "a*", "*b", "ab");
const pattern = fc.array(patternSegment, { maxLength: 5 });
const path = fc.array(name, { maxLength: 5 });

describe("glob matchers", () => {
  it("matchSegments agrees with the backtracking definition", () => {
    fc.assert(
      fc.property(pattern, path, (p, q) => {
        expect(matchSegments(p, q)).toBe(reference(p, q));
      }),
      { numRuns: 2000 },
    );
  });

  it("couldMatchBelow holds exactly when some path below the directory matches", () => {
    // Below a directory means one to four more segments; patterns here are at most five long, so
    // a match needing more would need more pattern segments than exist.
    const suffixes: string[][] = [[]];
    for (let depth = 0; depth < 4; depth++)
      for (const suffix of [...suffixes])
        if (suffix.length === depth)
          for (const n of ["a", "b", "ab", "ba", "c"]) suffixes.push([...suffix, n]);
    const below = suffixes.filter((suffix) => suffix.length > 0);
    fc.assert(
      fc.property(pattern, fc.array(name, { minLength: 1, maxLength: 3 }), (p, directory) => {
        const brute = below.some((suffix) => reference(p, [...directory, ...suffix]));
        expect(couldMatchBelow(p, directory)).toBe(brute);
      }),
      { numRuns: 1000 },
    );
  });
});
