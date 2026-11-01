import { describe, expect, it } from "vitest";
import {
  claimIdentity,
  duplicateCheck,
  findingIdentity,
  gapIdentity,
  normaliseStatement,
  resolvesIdentity,
} from "./duplicates.js";
import type { Accepted } from "./pipeline.js";

// Duplicates (IMPL §3.3.2 step 7, §3.3.4 step 4).

const accepted = <V>(key: string, index: number, value: V): Accepted<V> => ({
  key,
  index,
  value,
  corrected: false,
  relabelled: false,
});

describe("normalised statements (IMPL §3.3.2 step 7)", () => {
  it("applies NFC, collapses White_Space runs to one space and trims, keeping case", () => {
    expect(normaliseStatement("  Café\t\n uses   `pnpm`. ")).toBe("Café uses `pnpm`.");
    expect(normaliseStatement("Tests live")).not.toBe(normaliseStatement("tests live"));
  });

  it("collapses no-break and ideographic spaces, but not U+FEFF, which is not White_Space", () => {
    expect(normaliseStatement("a 　b")).toBe("a b");
    expect(normaliseStatement("a﻿b")).toBe("a﻿b");
  });
});

describe("identities (IMPL §3.3.2 step 7)", () => {
  it("compares scopes as sets of normalised paths, in any order", () => {
    const a = findingIdentity("X.", { kind: "paths", paths: ["./src/a.ts", "docs/"] });
    const b = findingIdentity("X.", { kind: "paths", paths: ["docs", "src/a.ts", "docs"] });
    expect(a).toBe(b);
    expect(a).not.toBe(findingIdentity("X.", { kind: "repository" }));
    expect(a).not.toBe(findingIdentity("X.", { kind: "paths", paths: ["docs"] }));
  });

  it("separates statement and scope, so text can't impersonate a scope", () => {
    expect(findingIdentity("a", { kind: "paths", paths: ["b"] })).not.toBe(
      findingIdentity("a b", { kind: "repository" }),
    );
  });

  it("gives gaps the statement, gap type and related-path set", () => {
    const base = gapIdentity("No test command.", "no_command", ["src", "./lib/"]);
    expect(gapIdentity(" No test  command.", "no_command", ["lib", "src"])).toBe(base);
    expect(gapIdentity("No test command.", "other", ["src", "lib"])).not.toBe(base);
  });

  it("gives absence claims their normalised glob", () => {
    expect(claimIdentity("./src/**/*.test.ts")).toBe(claimIdentity("src/**/*.test.ts"));
    expect(claimIdentity("src/")).toBe(claimIdentity("src"));
  });

  it("compares resolves sets in any order, once each", () => {
    expect(resolvesIdentity(["F-2", "C-1", "F-2"])).toBe(resolvesIdentity(["C-1", "F-2"]));
  });
});

describe("duplicateCheck (IMPL §3.3.2 step 7)", () => {
  type A = { findings: { statement: string } };
  const surviving = {
    findings: [
      accepted("f1", 0, { statement: "Tests use Vitest." }),
      accepted("f2", 1, { statement: "Tests  use Vitest. " }),
      accepted("f3", 2, { statement: "Lint uses Biome." }),
      accepted("f4", 3, { statement: "Tests use Vitest." }),
    ],
  };

  it("DUP-001 keeps the first and redirects each later duplicate to it", () => {
    const check = duplicateCheck<A, unknown, "findings">({
      collection: "findings",
      rule: "DUP-001",
      identity: (value) => normaliseStatement(value.statement),
    });
    expect(check(surviving, undefined)).toEqual([
      expect.objectContaining({ index: 1, rule: "DUP-001", mergedInto: "f1" }),
      expect.objectContaining({ index: 3, rule: "DUP-001", mergedInto: "f1" }),
    ]);
  });

  it("DUP-002 drops an item matching a prior record and redirects it to that alias only", () => {
    const check = duplicateCheck<A, unknown, "findings">({
      collection: "findings",
      rule: "DUP-002",
      identity: (value) => normaliseStatement(value.statement),
      prior: () => [{ alias: "F-1", identity: "Lint uses Biome." }],
      withinResponse: false,
    });
    expect(check(surviving, undefined)).toEqual([
      expect.objectContaining({ index: 2, rule: "DUP-002", mergedInto: "F-1" }),
    ]);
  });

  it("names only the kept key or alias in the detail, never the statement", () => {
    const check = duplicateCheck<A, unknown, "findings">({
      collection: "findings",
      rule: "DUP-001",
      identity: (value) => normaliseStatement(value.statement),
    });
    for (const rejection of check(surviving, undefined))
      expect(rejection.detail).not.toContain("Vitest");
  });
});
