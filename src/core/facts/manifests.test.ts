import { describe, expect, it } from "vitest";
import {
  justfileRecipes,
  makefileTargets,
  packageJsonScripts,
  pyprojectScripts,
  taskfileTasks,
} from "./manifests.js";

// Reading command names from manifests (IMPL §3.2.5).

const lines = (text: string) => text.split("\n");
const names = (defs: readonly { name: string }[]) => defs.map((d) => d.name);

describe("package.json scripts", () => {
  it("reads string members of the top-level scripts object, with the lines that define them", () => {
    const result = packageJsonScripts(
      lines(
        [
          "{",
          '  "name": "x",',
          '  "scripts": {',
          '    "build": "tsc",',
          '    "test":',
          '      "vitest run",',
          '    "n": 5,',
          '    "o": { "x": "y" }',
          "  },",
          '  "nested": { "scripts": { "no": "x" } }',
          "}",
        ].join("\n"),
      ),
    );
    expect(result).toEqual({
      ok: true,
      commands: [
        { name: "build", lineStart: 4, lineEnd: 4 },
        { name: "test", lineStart: 5, lineEnd: 6 },
      ],
    });
  });

  it("keeps the last of a duplicated key, as JSON.parse does, in both scripts and the top level", () => {
    const result = packageJsonScripts(
      lines(
        [
          "{",
          '  "scripts": { "a": "1" },',
          '  "scripts": {',
          '    "b": "1",',
          '    "b": "2"',
          "  }",
          "}",
        ].join("\n"),
      ),
    );
    expect(result).toEqual({ ok: true, commands: [{ name: "b", lineStart: 5, lineEnd: 5 }] });
  });

  it("decodes escaped keys", () => {
    const result = packageJsonScripts(lines('{ "scripts": { "a\\u0062": "x" } }'));
    expect(result).toEqual({ ok: true, commands: [{ name: "ab", lineStart: 1, lineEnd: 1 }] });
  });

  it("fails on invalid JSON, and finds nothing without a scripts object", () => {
    expect(packageJsonScripts(lines('{ "scripts": { "a": "x", } }'))).toEqual({ ok: false });
    expect(packageJsonScripts(lines('{ "scripts": ["a"] }'))).toEqual({ ok: true, commands: [] });
    expect(packageJsonScripts(lines("[]"))).toEqual({ ok: true, commands: [] });
  });
});

describe("pyproject.toml scripts", () => {
  it("reads keys of [project.scripts] and [tool.poetry.scripts] up to the next table", () => {
    const text = [
      "[project]",
      'name = "x"',
      "[ project.scripts ] # entry points",
      'serve = "x.main:run"',
      '"quoted-name" = "x:y"',
      "'literal' = \"x:y\"",
      'dotted.key = "x:y"',
      "",
      "[tool.poetry.scripts]",
      '  tool_1 = "x:z"',
      "[tool.other]",
      'nope = "x"',
    ].join("\n");
    expect(pyprojectScripts(lines(text))).toEqual([
      { name: "serve", lineStart: 4, lineEnd: 4 },
      { name: "quoted-name", lineStart: 5, lineEnd: 5 },
      { name: "literal", lineStart: 6, lineEnd: 6 },
      { name: "tool_1", lineStart: 10, lineEnd: 10 },
    ]);
  });

  it("doesn't read inline tables or escaped quoted keys", () => {
    const text = ["[project]", 'scripts = { a = "x:y" }', "[project.scripts]", '"a\\tb" = "x"'];
    expect(pyprojectScripts(text)).toEqual([]);
  });
});

describe("Makefile targets", () => {
  it("reads target lines, each word before the colon a target", () => {
    const text = [
      "build test: deps ## help",
      "\techo build",
      "lint:: x",
      "install:",
      "VAR := 1",
      "VAR2 ::= 1",
      "A = b:c",
      "B:=1",
      "C ?= x",
      "D: E = 1",
      ".PHONY: build",
      "%.o: %.c",
      "$(OUT): x",
      "vpath %.c src:lib",
      "export PATH: x",
      "# comment: x",
      " indented: x",
      "define BLOCK",
      "inside: x",
      "endef",
      "after: x \\",
      "  continued: y",
      "build: again",
    ].join("\n");
    expect(makefileTargets(lines(text))).toEqual([
      { name: "build", lineStart: 1, lineEnd: 1 },
      { name: "test", lineStart: 1, lineEnd: 1 },
      { name: "lint", lineStart: 3, lineEnd: 3 },
      { name: "install", lineStart: 4, lineEnd: 4 },
      { name: "D", lineStart: 10, lineEnd: 10 },
      { name: "after", lineStart: 21, lineEnd: 21 },
      { name: "build", lineStart: 23, lineEnd: 23 },
    ]);
  });
});

describe("justfile recipes", () => {
  it("reads recipe lines and leaves out settings, aliases, assignments and private recipes", () => {
    const text = [
      'set shell := ["bash", "-c"]',
      "alias b := build",
      'version := "1"',
      'export X := "1"',
      "build:",
      "  cargo build",
      "@test filter='':",
      'serve url="http://localhost": build',
      "_helper:",
      "[private]",
      "hidden:",
      "[no-cd, private]",
      "hidden2:",
      "[no-cd]",
      "# a comment",
      "shown:",
      "x:=1",
    ].join("\n");
    expect(names(justfileRecipes(lines(text)))).toEqual(["build", "test", "serve", "shown"]);
    expect(justfileRecipes(lines(text))[2]).toEqual({ name: "serve", lineStart: 8, lineEnd: 8 });
  });
});

describe("Taskfile tasks", () => {
  it("reads the keys of the tasks mapping at its first indentation", () => {
    const text = [
      "version: '3'",
      "tasks:   # all tasks",
      "",
      "  # a comment",
      "  build:",
      "    cmds:",
      "      - go build",
      "    deps: [x]",
      '  "test":',
      "  'lint': # quoted",
      "  fmt: {cmds: [x]}",
      "  run:x",
      "vars:",
      "  other: x",
    ].join("\n");
    expect(taskfileTasks(lines(text))).toEqual([
      { name: "build", lineStart: 5, lineEnd: 5 },
      { name: "test", lineStart: 9, lineEnd: 9 },
      { name: "lint", lineStart: 10, lineEnd: 10 },
      { name: "fmt", lineStart: 11, lineEnd: 11 },
    ]);
  });

  it("finds nothing without a block tasks mapping", () => {
    expect(taskfileTasks(lines("tasks: {}\n"))).toEqual([]);
    expect(taskfileTasks(lines("  tasks:\n    a:\n"))).toEqual([]);
  });
});

describe("edge cases the spec settles", () => {
  it("justfile: the first colon ends the parameters, and any other line ends an attribute run", () => {
    const text = [
      'run x="a:=b":',
      "[private]",
      "",
      "after_blank:",
      "[private]",
      "# doc",
      "after_comment:",
      "[no-private]",
      "dashed:",
      "[doc('private builds')]",
      "documented:",
    ];
    expect(names(justfileRecipes(text))).toEqual(["after_blank", "after_comment", "dashed"]);
  });

  it("Taskfile: a key may end with a tab, and a plain key holds no colon", () => {
    expect(names(taskfileTasks(["tasks:", "  a:\t# x", "  deploy:prod:", "  b:"]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("pyproject: a subtable ends the scripts table, and spaces around = are optional", () => {
    const text = ["[project.scripts]", 'a="x"', "[project.scripts.more]", 'b = "y"'];
    expect(names(pyprojectScripts(text))).toEqual(["a"]);
  });
});

describe("forms the spec review found", () => {
  it("Makefile: define blocks may be indented or prefixed, and & marks grouped targets", () => {
    const text = [
      "override define A",
      "x: y",
      "endef",
      "  define B",
      "z: y",
      "  endef",
      "export private define C",
      "w: y",
      "endef",
      "a b &: c",
    ];
    expect(names(makefileTargets(text))).toEqual(["a", "b"]);
  });

  it("Taskfile: a space before the colon, or the merge key, is not a task", () => {
    expect(names(taskfileTasks(["tasks:", "  <<: *defaults", "  build :", "  ok:"]))).toEqual([
      "ok",
    ]);
  });

  it("justfile: mod and import lines are not recipes", () => {
    const text = ["mod foo 'a:b'", "import? 'x:y'", "real:"];
    expect(names(justfileRecipes(text))).toEqual(["real"]);
  });
});
