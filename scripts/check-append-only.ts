// Fails when an append-only history file (IMPL §3.7) changed or removed a line since a base
// commit. A file may only grow at its end: the base's lines must be the first lines of the
// current file, unchanged. Run with Node's own type stripping, so CI needs no install or build:
//
//   node scripts/check-append-only.ts <base-commit>
//
// A file that doesn't exist at the base is new, and passes; one that exists there but not now
// was removed, and fails.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const HISTORY_FILES = ["src/schemas/history.jsonl", "src/adapters/prompts/history.jsonl"];

/** Each line of the base that is missing or different at the same place now. */
export function violations(path: string, base: string, current: string): string[] {
  const before = lines(base);
  const after = lines(current);
  const found: string[] = [];
  for (const [index, line] of before.entries()) {
    const now = after[index];
    if (now === undefined) found.push(`${path}:${index + 1}: removed`);
    else if (now !== line) found.push(`${path}:${index + 1}: changed`);
  }
  return found;
}

/** A file's lines; the final line break ends the last line rather than starting another. */
function lines(text: string): string[] {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

function atBase(base: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${base}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function main(argv: readonly string[]): number {
  const base = argv[0];
  if (base === undefined || argv.length !== 1) {
    process.stderr.write("usage: node scripts/check-append-only.ts <base-commit>\n");
    return 2;
  }
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" });
  } catch {
    process.stderr.write(`base commit ${base} is not available\n`);
    return 2;
  }
  const found: string[] = [];
  for (const path of HISTORY_FILES) {
    const before = atBase(base, path);
    if (before === undefined) continue;
    if (!existsSync(path)) found.push(`${path}: removed`);
    else found.push(...violations(path, before, readFileSync(path, "utf8")));
  }
  if (found.length > 0) {
    process.stderr.write(
      `Append-only history edited since ${base}; add a new line instead:\n${found.join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(`Append-only histories unchanged since ${base}.\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
