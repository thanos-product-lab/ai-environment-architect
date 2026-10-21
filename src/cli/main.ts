#!/usr/bin/env node
// The command line. Until M7 it has `--version` and the "What we read" preview, `inspect`.
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openRepositoryFs } from "../adapters/fs/node-repository-fs.js";
import { openGitReader } from "../adapters/git/git-reader.js";
import { inspect } from "./inspect.js";

export interface RunResult {
  readonly code: number;
  readonly output: string;
  /** What the command prints goes to stdout, even when it exits 1; usage and errors to stderr. */
  readonly stream: "stdout" | "stderr";
}

const USAGE = `Usage:
  <cli> inspect [path] [--list | --json] [--debug]
      Show what would be sent for analysis for the repository at path
      (default: the current directory). Nothing is sent or written.
      --list   every file, with the reason it was or wasn't sent
      --json   the input manifest: paths, hashes and reasons, no content
      --debug  add stack traces to errors
  <cli> --version
`;

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

export async function run(args: readonly string[], cwd = process.cwd()): Promise<RunResult> {
  if (args.length === 1 && args[0] === "--version") {
    return { code: 0, output: `${version()}\n`, stream: "stdout" };
  }
  if (args[0] !== "inspect") return usage();

  const flags = new Set<string>();
  const paths: string[] = [];
  for (const arg of args.slice(1)) {
    if (arg.startsWith("--")) flags.add(arg);
    else paths.push(arg);
  }
  const known = new Set(["--list", "--json", "--debug"]);
  if (
    paths.length > 1 ||
    [...flags].some((flag) => !known.has(flag)) ||
    (flags.has("--list") && flags.has("--json"))
  ) {
    return usage();
  }

  const root = resolve(cwd, paths[0] ?? ".");
  const debug = flags.has("--debug");
  try {
    const problem = await notADirectory(root);
    if (problem !== undefined) return { code: 1, output: `${problem}\n`, stream: "stderr" };
    const result = await inspect(
      root,
      {
        fs: await openRepositoryFs(root),
        git: openGitReader(root),
        clock: { now: () => new Date() },
        ids: { next: (prefix) => `${prefix}_${randomUUID()}` },
      },
      { list: flags.has("--list"), json: flags.has("--json") },
    );
    return { ...result, stream: "stdout" };
  } catch (error) {
    const message = `Couldn't read the repository at ${root}.`;
    return { code: 1, output: failure(message, error, debug), stream: "stderr" };
  }

  async function notADirectory(path: string): Promise<string | undefined> {
    try {
      const info = await stat(path);
      return info.isDirectory() ? undefined : `${path} is a file, not a directory.`;
    } catch (error) {
      return failure(`No directory at ${path}.`, error, debug).trimEnd();
    }
  }
}

function usage(): RunResult {
  return { code: 2, output: USAGE, stream: "stderr" };
}

/** A plain message; the stack trace only with --debug. */
function failure(message: string, error: unknown, debug: boolean): string {
  if (!debug) return `${message}\n`;
  const detail = error instanceof Error ? (error.stack ?? String(error)) : String(error);
  return `${message}\n\n${detail}\n`;
}

// import.meta.main needs Node 24.2, but engines allows any 24.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const result = await run(process.argv.slice(2));
  (result.stream === "stdout" ? process.stdout : process.stderr).write(result.output);
  process.exitCode = result.code;
}
