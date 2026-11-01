import { describe, expect, it } from "vitest";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import {
  checkExpansionRequest,
  type ExpansionRequest,
  expansionIndex,
  expansionLimitCheck,
} from "./expansion.js";

// The static expansion checks (IMPL §1.8), run with the `analyse` item validation (§3.3.2 step 9).

const WITHHELD = "config/AKIAIOSFODNN7EXAMPLE.txt";

const files: SnapshotFile[] = [
  { path: "README.md", status: "read", size: 1, hash: "sha256:1" },
  { path: "src/a.ts", status: "read", size: 1, hash: "sha256:2" },
  { path: "src/b.ts", status: "read", size: 1, hash: "sha256:3" },
  { path: "docs/big.md", status: "listed_only", size: 1, hash: "sha256:4", reason: "too_large" },
  { path: "x.log", status: "ignored", kind: "file", size: 1, hash: "sha256:5" },
  { path: "node_modules", status: "excluded", kind: "directory", rule: "node_modules" },
  { path: "vendor", status: "symlink", target: "../shared" },
  { path: "broken.ts", status: "unreadable", kind: "file", reason: "permission_denied" },
  { path: WITHHELD, status: "read", size: 1, hash: "sha256:6" },
  { path: "packages/web/index.ts", status: "read", size: 1, hash: "sha256:7" },
];

// README.md is sent in full; src/a.ts lines 1-10 of 20.
const sent = [
  { path: "README.md", totalLines: 3, sent: [{ first: 1, lines: ["a", "b", "c"] }] },
  {
    path: "src/a.ts",
    totalLines: 20,
    sent: [{ first: 1, lines: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`) }],
  },
];

const index = expansionIndex({ files, scopeRoots: ["."], sent, maxRequests: 2 });

const read = (...entries: { path: string; lines?: string }[]): ExpansionRequest => ({
  kind: "read",
  entries,
  reason: "see more",
});
const search = (literal: string, glob?: string): ExpansionRequest => ({
  kind: "search",
  literal,
  ...(glob === undefined ? {} : { glob }),
  reason: "find uses",
});

const rule = (request: ExpansionRequest, at = index) => {
  const result = checkExpansionRequest(request, at);
  return result.ok ? null : result.rule;
};

describe("LIMIT-002 (IMPL §1.8)", () => {
  it("LIMIT-002 rejects requests beyond maxExpansionRequests in response order", () => {
    const check = expansionLimitCheck();
    const context = { expansion: index };
    const scope = { localKeys: new Set<string>() };
    const request = read({ path: "src/b.ts" });
    expect(check(request, context, scope, 1).kind).toBe("accept");
    expect(check(request, context, scope, 2)).toMatchObject({ kind: "reject", rule: "LIMIT-002" });
  });
});

describe("EXP-001 (IMPL §1.8)", () => {
  it.each([
    ["an ignored file", "x.log"],
    ["an excluded directory", "node_modules"],
    ["a path under an excluded directory", "node_modules/react/index.js"],
    ["a symbolic link", "vendor"],
    ["an unreadable file", "broken.ts"],
    ["a withheld path", WITHHELD],
    ["an unlisted path", "src/missing.ts"],
    ["a directory", "src"],
    ["a `..` segment", "src/../README.md"],
  ])("EXP-001 rejects %s", (_name, path) => {
    expect(rule(read({ path }))).toBe("EXP-001");
  });

  it("EXP-001 accepts read and listed_only entries, after normalisation", () => {
    expect(rule(read({ path: "./src/b.ts" }))).toBeNull();
    expect(rule(read({ path: "docs/big.md", lines: "1-40" }))).toBeNull();
  });

  it("EXP-001 never names the path in its detail", () => {
    const result = checkExpansionRequest(read({ path: "src/b.ts" }, { path: WITHHELD }), index);
    expect(result).toEqual({
      ok: false,
      rule: "EXP-001",
      detail: "entry 1 is not a readable file",
    });
  });

  it("EXP-001 is checked before EXP-002 for every entry", () => {
    expect(rule(read({ path: "src/b.ts", lines: "9-3" }, { path: "x.log" }))).toBe("EXP-001");
  });
});

describe("files secret-blocked by content (IMPL §1.7, §1.8)", () => {
  // src/b.ts keeps status `read`; selection blocked it because its content matched the scan.
  const blocked = expansionIndex({
    files,
    scopeRoots: ["."],
    sent,
    maxRequests: 5,
    blocked: ["src/b.ts"],
  });

  it("EXP-001 rejects a read of a file blocked by its content", () => {
    expect(rule(read({ path: "src/b.ts" }), blocked)).toBe("EXP-001");
  });

  it("EXP-004 doesn't count a blocked file as searchable", () => {
    expect(rule(search("fetchUser", "src/b.ts"), blocked)).toBe("EXP-004");
    expect(rule(search("fetchUser", "src/*.ts"), blocked)).toBeNull();
  });
});

describe("line counts (IMPL §1.11)", () => {
  it("refuses items of one file that disagree on its line count", () => {
    const disagreeing = [...sent, { path: "README.md", totalLines: 4, sent: [] }];
    expect(() =>
      expansionIndex({ files, scopeRoots: ["."], sent: disagreeing, maxRequests: 5 }),
    ).toThrow(/README.md/);
  });
});

describe("EXP-002 (IMPL §1.8)", () => {
  it("EXP-002 rejects a range that starts after it ends", () => {
    expect(rule(read({ path: "src/a.ts", lines: "15-18,14-12" }))).toBe("EXP-002");
  });

  it("EXP-002 accepts a single-line range", () => {
    expect(rule(read({ path: "src/a.ts", lines: "15-15" }))).toBeNull();
  });
});

describe("EXP-003 (IMPL §1.8)", () => {
  it("EXP-003 rejects a request for lines already sent", () => {
    expect(rule(read({ path: "src/a.ts", lines: "2-4,8-10" }))).toBe("EXP-003");
  });

  it("EXP-003 accepts a request with one line not yet sent", () => {
    expect(rule(read({ path: "src/a.ts", lines: "2-4,8-11" }))).toBeNull();
  });

  it("EXP-003 rejects a whole-file read of a file sent in full", () => {
    expect(rule(read({ path: "README.md" }))).toBe("EXP-003");
  });

  it("EXP-003 accepts a whole-file read of a file sent in part or not at all", () => {
    expect(rule(read({ path: "src/a.ts" }))).toBeNull();
    expect(rule(read({ path: "src/b.ts" }))).toBeNull();
  });

  it("EXP-003 accepts a request where only some entries add something", () => {
    expect(rule(read({ path: "README.md" }, { path: "src/b.ts" }))).toBeNull();
  });
});

describe("EXP-004 (IMPL §1.8)", () => {
  it.each([
    ["a backtick", "src/`x`.ts"],
    ["whitespace", "src/a b.ts"],
    ["a format character", "src/​*.ts"],
    ["a `..` segment", "../**/*.ts"],
    ["no searchable file", "lib/**/*.ts"],
    ["only an ignored file", "*.log"],
    ["only a withheld file", "config/*.txt"],
  ])("EXP-004 rejects a glob with %s", (_name, glob) => {
    expect(rule(search("fetchUser", glob))).toBe("EXP-004");
  });

  it("EXP-004 accepts a glob that matches a searchable file, or a directory holding one", () => {
    expect(rule(search("fetchUser", "src/**/*.ts"))).toBeNull();
    expect(rule(search("fetchUser", "./src/"))).toBeNull();
    expect(rule(search("fetchUser"))).toBeNull();
  });

  it("EXP-004 rejects a glob outside the scope roots", () => {
    const scoped = expansionIndex({ files, scopeRoots: ["packages/web"], sent, maxRequests: 5 });
    expect(rule(search("fetchUser", "src/**"), scoped)).toBe("EXP-004");
    expect(rule(search("fetchUser", "**/*.ts"), scoped)).toBe("EXP-004");
    expect(rule(search("fetchUser", "packages/web/*.ts"), scoped)).toBeNull();
  });
});

describe("EXP-005 (IMPL §1.8)", () => {
  it.each([
    ["a line break", "fetch\nUser"],
    ["a tab", "fetch\tUser"],
    ["fewer than 3 code points", "ab"],
    ["only punctuation and whitespace", " -> ;"],
  ])("EXP-005 rejects a literal with %s", (_name, literal) => {
    expect(rule(search(literal))).toBe("EXP-005");
  });

  it("EXP-005 accepts a 3-code-point literal holding a space", () => {
    expect(rule(search("a b"))).toBeNull();
    expect(rule(search("😀ab"))).toBeNull();
  });
});
