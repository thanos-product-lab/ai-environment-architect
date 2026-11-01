import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Core stays pure (CLAUDE.md invariants, IMPL §1.3, §4.11): no filesystem, processes or
// environment, and time, randomness and ordering only through injected providers and bytewise
// comparison. This scans every non-test source file in `src/core/` and names each file and line
// that breaks the rule. Comment lines are skipped, so a comment may still mention a name.

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "node:fs", pattern: /["']node:fs(?:\/promises)?["']/ },
  { name: "node:child_process", pattern: /["']node:child_process["']/ },
  { name: "process.", pattern: /\bprocess\./ },
  { name: "Date.now", pattern: /\bDate\.now\b/ },
  { name: "new Date()", pattern: /\bnew Date\(\s*\)/ },
  { name: "Math.random", pattern: /\bMath\.random\b/ },
  { name: "localeCompare", pattern: /\blocaleCompare\b/ },
];

const ROOT = join(import.meta.dirname, "..");
const CORE = join(ROOT, "src", "core");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    })
    .sort();
}

/** `<file>:<line>: <name>` for every forbidden use outside comment lines. */
function violations(file: string, text: string): string[] {
  const found: string[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return;
    }
    if (trimmed.startsWith("//")) return;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      return;
    }
    for (const { name, pattern } of FORBIDDEN)
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${name}`);
  });
  return found;
}

describe("core boundaries (CLAUDE.md invariants, IMPL §4.11)", () => {
  it("no source file in src/core/ reads the filesystem, processes, environment, clock, randomness or locale", () => {
    const files = sources(CORE);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((path) =>
      violations(relative(ROOT, path), readFileSync(path, "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("catches each forbidden use, with the file and line", () => {
    const text = [
      'import { readFile } from "node:fs/promises";',
      'import { spawn } from "node:child_process";',
      "const home = process.env.HOME;",
      "const t = Date.now();",
      "const d = new Date();",
      "const r = Math.random();",
      "names.sort((a, b) => a.localeCompare(b));",
    ].join("\n");
    expect(violations("src/core/x.ts", text)).toEqual([
      "src/core/x.ts:1: node:fs",
      "src/core/x.ts:2: node:child_process",
      "src/core/x.ts:3: process.",
      "src/core/x.ts:4: Date.now",
      "src/core/x.ts:5: new Date()",
      "src/core/x.ts:6: Math.random",
      "src/core/x.ts:7: localeCompare",
    ]);
  });

  it("allows comments, a Date built from a value, and injected providers", () => {
    const text = [
      "// process.env is read by the CLI, never here",
      "/**",
      " * Math.random would break determinism.",
      " */",
      "const d = new Date(clock.now().getTime());",
      'const id = ids.next("ev");',
    ].join("\n");
    expect(violations("src/core/x.ts", text)).toEqual([]);
  });
});
