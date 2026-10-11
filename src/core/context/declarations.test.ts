import { describe, expect, it } from "vitest";
import { sha256 } from "../hash.js";
import {
  DECLARATION_FAMILIES,
  DECLARATION_PATTERNS_VERSION,
  type Declaration,
  findDeclarations,
  languageFamily,
} from "./declarations.js";

// Top-level declaration patterns (IMPL §1.6). They change the context, so they are versioned.

const find = (path: string, source: string): Declaration[] | undefined =>
  findDeclarations(path, source.split("\n"));

describe("declaration patterns version", () => {
  it("pins the pattern set to its version", () => {
    // If this fails, the patterns or the extension mapping changed. Increase
    // DECLARATION_PATTERNS_VERSION and record the new fingerprint here (IMPL §1.6).
    const canonical = JSON.stringify(
      DECLARATION_FAMILIES.map((family) => ({
        name: family.name,
        extensions: family.extensions,
        declarations: family.declarations.map((p) => [p.source, p.flags]),
        decorators: family.decorators.map((p) => [p.source, p.flags]),
        notDeclarations: family.notDeclarations.map((p) => [p.source, p.flags]),
      })),
    );
    expect({
      version: DECLARATION_PATTERNS_VERSION,
      fingerprint: sha256(new TextEncoder().encode(canonical)),
    }).toEqual({
      version: "declarations/1.0.0",
      fingerprint: "sha256:99f205e6c1852a8d5cc1c391acde772353dd10b55968d90a12e52aa59858bb60",
    });
  });
});

describe("languageFamily", () => {
  it("maps extensions case-sensitively and returns undefined for others", () => {
    expect(languageFamily("src/a.ts")).toBe("javascript");
    expect(languageFamily("src/a.mjs")).toBe("javascript");
    expect(languageFamily("a/b.py")).toBe("python");
    expect(languageFamily("main.go")).toBe("go");
    expect(languageFamily("lib.rs")).toBe("rust");
    expect(languageFamily("A.java")).toBe("jvm-dotnet-swift");
    expect(languageFamily("a.rb")).toBe("ruby");
    expect(languageFamily("a.php")).toBe("php");
    expect(languageFamily("README.md")).toBeUndefined();
    expect(languageFamily("Makefile")).toBeUndefined();
    expect(languageFamily(".ts")).toBeUndefined();
  });
});

describe("findDeclarations", () => {
  it("returns undefined for files outside every family", () => {
    expect(find("notes.txt", "function a() {}")).toBeUndefined();
  });

  it("finds JavaScript and TypeScript declarations at column zero, with keyword and name labels", () => {
    const source = [
      'import { x } from "./x";',
      "export async function request<T>(url: string) {",
      "  function inner() {}",
      "}",
      "export default class Client {}",
      "interface Options { a: number }",
      "export type Id = string;",
      "export const enum Mode { A }",
      "const limit = 10;",
      "let { a, b } = x;",
      "export default {",
      'export * from "./y";',
      "export { a, b };",
      "declare module 'z' {}",
      "function* gen() {}",
    ].join("\n");
    expect(find("src/a.ts", source)).toEqual([
      { line: 2, start: 2, label: "export async function request" },
      { line: 5, start: 5, label: "export default class Client" },
      { line: 6, start: 6, label: "interface Options" },
      { line: 7, start: 7, label: "export type Id" },
      { line: 8, start: 8, label: "export const enum Mode" },
      { line: 9, start: 9, label: "const limit" },
      { line: 10, start: 10, label: "let { a, b }" },
      { line: 11, start: 11, label: "export default" },
      { line: 12, start: 12, label: 'export * from "./y"' },
      { line: 13, start: 13, label: "export { a, b }" },
      { line: 14, start: 14, label: "declare module 'z'" },
      { line: 15, start: 15, label: "function* gen" },
    ]);
  });

  it("does not treat CommonJS require assignments as declarations", () => {
    const source = [
      'const express = require("express");',
      'const { join } = require("node:path");',
      "const app = express();",
    ].join("\n");
    expect(find("server.js", source)).toEqual([{ line: 3, start: 3, label: "const app" }]);
  });

  it("starts a declaration at the decorators directly above it", () => {
    const source = ["import x", "", "@dataclass", "@frozen", "class Point:", "    x: int"].join(
      "\n",
    );
    expect(find("a.py", source)).toEqual([{ line: 5, start: 3, label: "class Point" }]);
  });

  it("does not attach decorators separated by a blank line", () => {
    const source = ["@decorator", "", "def f():", "    pass"].join("\n");
    expect(find("a.py", source)).toEqual([{ line: 3, start: 3, label: "def f" }]);
  });

  it("finds Python, Go, Rust, JVM-family, Ruby and PHP declarations", () => {
    expect(find("a.py", "async def run():\n    pass\ndef stop(): pass")).toEqual([
      { line: 1, start: 1, label: "async def run" },
      { line: 3, start: 3, label: "def stop" },
    ]);
    expect(
      find("a.go", "package a\n\nfunc (s *Server) Start() {}\ntype Server struct{}\nvar (\n)"),
    ).toEqual([
      { line: 3, start: 3, label: "func (s *Server) Start" },
      { line: 4, start: 4, label: "type Server" },
      { line: 5, start: 5, label: "var (" },
    ]);
    expect(
      find(
        "lib.rs",
        "use std::fmt;\n#[derive(Debug)]\npub struct A;\nimpl<T> fmt::Display for A {\n}\npub(crate) async fn go() {}\nconst fn k() {}\nmacro_rules! m {}",
      ),
    ).toEqual([
      { line: 3, start: 2, label: "pub struct A" },
      { line: 4, start: 4, label: "impl<T> fmt::Display for A" },
      { line: 6, start: 6, label: "pub(crate) async fn go" },
      { line: 7, start: 7, label: "const fn k" },
      { line: 8, start: 8, label: "macro_rules! m" },
    ]);
    expect(find("A.java", "package a;\n@Service\npublic final class A {\n}")).toEqual([
      { line: 3, start: 2, label: "public final class A" },
    ]);
    expect(find("a.rb", "require 'x'\nmodule Shop\nend\ndef total?\nend")).toEqual([
      { line: 2, start: 2, label: "module Shop" },
      { line: 4, start: 4, label: "def total?" },
    ]);
    expect(find("a.php", "<?php\nfinal class Cart {}\nfunction &ref() {}")).toEqual([
      { line: 2, start: 2, label: "final class Cart" },
      { line: 3, start: 3, label: "function &ref" },
    ]);
  });

  it("ignores indented lines", () => {
    expect(find("a.py", "class A:\n    def m(self): pass")).toEqual([
      { line: 1, start: 1, label: "class A" },
    ]);
  });

  it("cuts long labels to 80 characters", () => {
    const name = "x".repeat(100);
    const [declaration] = find("a.ts", `function ${name}() {}`) ?? [];
    expect(declaration?.label).toBe(`function ${"x".repeat(70)}…`);
    expect(Array.from(declaration?.label ?? "")).toHaveLength(80);
  });
});
