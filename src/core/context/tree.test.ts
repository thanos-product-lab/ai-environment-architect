import { describe, expect, it } from "vitest";
import type { Hash } from "../hash.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { renderTree, type TreeSettings } from "./tree.js";

// Tier 4, the directory tree (IMPL §1.6).

const H: Hash = "sha256:0";
const read = (path: string): SnapshotFile => ({ path, status: "read", size: 1, hash: H });
const listedOnly = (path: string): SnapshotFile => ({
  path,
  status: "listed_only",
  size: 1,
  hash: H,
  reason: "too_large",
});
const excludedDir = (path: string): SnapshotFile => ({
  path,
  status: "excluded",
  kind: "directory",
  rule: "node_modules/",
});
const excludedFile = (path: string): SnapshotFile => ({
  path,
  status: "excluded",
  kind: "file",
  rule: ".env",
});
const link = (path: string, target: string): SnapshotFile => ({ path, status: "symlink", target });
const unreadable = (path: string, kind: "file" | "directory"): SnapshotFile => ({
  path,
  status: "unreadable",
  kind,
  reason: "permission_denied",
});

const SETTINGS: TreeSettings = { treeDepth: 4, treeCollapseThreshold: 40 };
const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

describe("renderTree", () => {
  it("renders every entry with its marker, siblings in bytewise name order", () => {
    const files = [
      read("CLAUDE.md"),
      read("README.md"),
      read("a-b.txt"),
      read("a/x.ts"),
      excludedFile(".env"),
      excludedDir("node_modules"),
      listedOnly("big.log"),
      link("current", "releases/v2"),
      unreadable("locked", "directory"),
      unreadable("secret.bin", "file"),
      read("src/index.ts"),
      read("src/util.ts"),
      read("src/blocked.ts"),
    ];
    const marks = new Map<string, "R" | "E" | "S">([
      ["CLAUDE.md", "R"],
      ["src/index.ts", "E"],
      ["src/blocked.ts", "S"],
    ]);
    const tree = renderTree(files, marks, SETTINGS, 100_000);
    expect(tree.text).toBe(
      lines(
        "<<<TREE depth=4 files=11>>>",
        "[X] .env",
        "[R] CLAUDE.md",
        "[-] README.md",
        "a/",
        "  [-] x.ts",
        "[-] a-b.txt",
        "[L] big.log",
        "[>] current -> releases/v2",
        "[U] locked/",
        "node_modules/ [excluded]",
        "[U] secret.bin",
        "src/",
        "  [S] blocked.ts",
        "  [E] index.ts",
        "  [-] util.ts",
        "<<<END TREE>>>",
      ),
    );
    expect(tree.depth).toBe(4);
    expect(tree.bytes).toBe(Buffer.byteLength(tree.text, "utf8"));
  });

  it("shows file counts for directories at the depth limit", () => {
    const files = [read("a/b/c.ts"), read("a/b/d/e.ts"), excludedDir("a/b/d/node_modules")];
    const tree = renderTree(files, new Map(), { ...SETTINGS, treeDepth: 2 }, 100_000);
    expect(tree.text).toBe(
      lines("<<<TREE depth=2 files=2>>>", "a/", "  b/ (2 files)", "<<<END TREE>>>"),
    );
  });

  it("collapses directories with more entries than the threshold", () => {
    const files = ["a", "b", "c", "d", "e"].map((name) => read(`dir/${name}.ts`));
    const tree = renderTree(files, new Map(), { ...SETTINGS, treeCollapseThreshold: 3 }, 100_000);
    expect(tree.text).toBe(
      lines(
        "<<<TREE depth=4 files=5>>>",
        "dir/",
        "  [-] a.ts",
        "  [-] b.ts",
        "  [-] c.ts",
        "  … 2 more",
        "<<<END TREE>>>",
      ),
    );
  });

  it("reduces the depth until the tree fits its cap, and records the final depth", () => {
    const files = [read("a/b/c/d.ts"), read("a/b/c/e.ts")];
    const full = renderTree(files, new Map(), SETTINGS, 100_000);
    const reduced = renderTree(files, new Map(), SETTINGS, full.bytes - 1);
    expect(reduced.depth).toBe(3);
    expect(reduced.bytes).toBeLessThanOrEqual(full.bytes - 1);
    expect(reduced.text).toBe(
      lines("<<<TREE depth=3 files=2>>>", "a/", "  b/", "    c/ (2 files)", "<<<END TREE>>>"),
    );
  });

  it("renders only a summary at depth 0 when even depth 1 does not fit", () => {
    const files = [read("aaaaaaaaaaaaaaaaaaaa.ts"), read("bbbbbbbbbbbbbbbbbbbb.ts")];
    const tree = renderTree(files, new Map(), SETTINGS, 60);
    expect(tree).toMatchObject({ depth: 0 });
    expect(tree.text).toBe(lines("<<<TREE depth=0 files=2>>>", "… 2 more", "<<<END TREE>>>"));
  });

  it("writes names with control characters as JSON strings and escapes delimiters", () => {
    const files = [read("line\nbreak.md"), read("a<<<b.md"), link("l", "x>>>y")];
    const tree = renderTree(files, new Map(), SETTINGS, 100_000);
    expect(tree.text).toContain('[-] "line\\nbreak.md"\n');
    expect(tree.text).toContain("[-] a<<\\<b.md\n");
    expect(tree.text).toContain("[>] l -> x>>\\>y\n");
  });

  it("withholds a name or link target that matches the secret scan, and marks such files [S]", () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const files = [
      read(`keys/${key}.txt`),
      read(`${key}/notes.md`),
      link("current", `/tmp/${key}`),
    ];
    const tree = renderTree(files, new Map(), SETTINGS, 100_000);
    expect(tree.text).not.toContain(key);
    expect(tree.text).toBe(
      lines(
        "<<<TREE depth=4 files=3>>>",
        "<withheld>/",
        "  [S] notes.md",
        "[>] current -> <withheld>",
        "keys/",
        "  [S] <withheld>",
        "<<<END TREE>>>",
      ),
    );
  });

  it("does not depend on the order of the file list", () => {
    const files = [read("b.ts"), read("a/c.ts"), excludedDir("node_modules"), read("a/b.ts")];
    const reversed = [...files].reverse();
    expect(renderTree(reversed, new Map(), SETTINGS, 100_000)).toEqual(
      renderTree(files, new Map(), SETTINGS, 100_000),
    );
  });
  it("withholds every segment a path match spans", () => {
    const value = ["def1234567", "890abcdefgh"].join("");
    const files = [read(`token=abc/${value}`), read("token=abc/ok.md"), read("docs/a.md")];
    const tree = renderTree(files, new Map(), SETTINGS, 100_000);
    expect(tree.text).not.toContain("token=abc");
    expect(tree.text).not.toContain(value);
    expect(tree.text).toBe(
      lines(
        "<<<TREE depth=4 files=3>>>",
        "docs/",
        "  [-] a.md",
        "<withheld>/",
        "  [S] <withheld>",
        "  [-] ok.md",
        "<<<END TREE>>>",
      ),
    );
  });
});
