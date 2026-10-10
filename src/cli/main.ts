#!/usr/bin/env node
// Placeholder until M7. It only answers --version, for the CI smoke test.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function version(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("package.json has no version");
}

export function run(args: readonly string[]): { code: number; output: string } {
  if (args.length === 1 && args[0] === "--version") {
    return { code: 0, output: `${version()}\n` };
  }
  return { code: 2, output: "Not implemented yet. Only --version is available.\n" };
}

// import.meta.main needs Node 24.2, but engines allows any 24.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const result = run(process.argv.slice(2));
  (result.code === 0 ? process.stdout : process.stderr).write(result.output);
  process.exitCode = result.code;
}
