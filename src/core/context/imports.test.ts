import { describe, expect, it } from "vitest";
import { findImports, resolveImport } from "./imports.js";

// `@path` imports in tier 1 Markdown (IMPL §1.5, tier 1).

const find = (text: string) => findImports(new TextEncoder().encode(text));

describe("finding imports", () => {
  it("finds `@path` at the start of a line or after whitespace, in order", () => {
    expect(find("@docs/a.md\nSee @b.md and\t@c/d.md.\n")).toEqual(["docs/a.md", "b.md", "c/d.md"]);
  });

  it("ignores `@` inside a word, such as an email address", () => {
    expect(find("Mail dev@example.com or a@b\n")).toEqual([]);
  });

  it("removes trailing punctuation and closing brackets or quotes", () => {
    expect(
      find("see @a.md), @b.md; @c.md: @d.md! @e.md? 'x @f.md' x @g.md\" x @h.md] x @i.md}\n"),
    ).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md"]);
  });

  it("needs whitespace or the line start before `@`, not a bracket or quote", () => {
    expect(find('(@a.md) "@b.md" [@c.md]\n')).toEqual([]);
  });

  it("ignores a bare `@`", () => {
    expect(find("a @ b @.\n")).toEqual([]);
  });

  it("ignores imports inside fenced and indented code blocks", () => {
    const text = [
      "@a.md",
      "",
      "```",
      "@fenced.md",
      "```",
      "",
      "    @indented.md",
      "",
      "@b.md",
      "",
    ].join("\n");
    expect(find(text)).toEqual(["a.md", "b.md"]);
  });

  it("ignores imports inside inline code spans, matching backtick runs by length", () => {
    expect(find("`@a.md` ``@b.md ` still code`` @c.md\n")).toEqual(["c.md"]);
  });

  it("ignores imports in a code span that continues onto the next line", () => {
    expect(find("Run `pnpm add\n@scope/pkg.md` now, then @a.md\n")).toEqual(["a.md"]);
  });

  it("treats an unclosed backtick run as text", () => {
    expect(find("a ` @b.md\n")).toEqual(["b.md"]);
  });

  it("reads lines after a BOM and with CRLF or CR endings", () => {
    expect(find("﻿@a.md\r\n@b.md\r@c.md")).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("keeps non-ASCII paths", () => {
    expect(find("@docs/café.md\n")).toEqual(["docs/café.md"]);
  });
});

describe("resolving imports", () => {
  it("resolves relative to the importing file's directory", () => {
    expect(resolveImport("CLAUDE.md", "docs/a.md")).toEqual({ inside: true, path: "docs/a.md" });
    expect(resolveImport("pkg/AGENTS.md", "a.md")).toEqual({ inside: true, path: "pkg/a.md" });
    expect(resolveImport("pkg/sub/X.md", "../a.md")).toEqual({ inside: true, path: "pkg/a.md" });
    expect(resolveImport("pkg/X.md", "./b/./c.md")).toEqual({ inside: true, path: "pkg/b/c.md" });
  });

  it("treats a path that leaves the root as outside", () => {
    expect(resolveImport("CLAUDE.md", "../other/x.md")).toEqual({ inside: false });
    expect(resolveImport("pkg/X.md", "../../x.md")).toEqual({ inside: false });
  });

  it("treats absolute and home-directory paths as outside", () => {
    expect(resolveImport("CLAUDE.md", "/etc/x.md")).toEqual({ inside: false });
    expect(resolveImport("CLAUDE.md", "~/.claude/x.md")).toEqual({ inside: false });
  });
});
