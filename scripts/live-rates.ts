// The rates of a live run (M6 live-run protocol, steps 6 and 7), appended to docs/LIVE_RUNS.md:
//
//   pnpm live-rates test/fixtures/live/<repo>/<run-id>
//
// It reads the run's exported session, with the load checks, and recomputes the share of saved
// sessions in which call 2 ran from every run directory. Nothing is counted by hand; the Console
// fields are left for the developer to fill in.

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSession } from "../src/core/session/load.js";
import type { SessionFile } from "../src/core/session/records.js";
import { exportedReader } from "./live/export.js";
import { appendRates, callTwoShare, renderRates, runRates } from "./live/rates.js";

const PRODUCT = fileURLToPath(new URL("../", import.meta.url));
const LIVE = join(PRODUCT, "test", "fixtures", "live");
const LOG = join(PRODUCT, "docs", "LIVE_RUNS.md");

async function filesOf(dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out.set(relative(dir, path).split("\\").join("/"), await readFile(path));
    }
  return out;
}

/** A run directory's session, with every load check. */
export async function loadRun(dir: string): Promise<SessionFile> {
  const files = await filesOf(dir);
  const bytes = files.get("session.json");
  if (bytes === undefined) throw new Error(`${dir} has no session.json`);
  const loaded = await loadSession(bytes, exportedReader(files));
  if (!loaded.ok)
    throw new Error(
      `${dir}: load check ${loaded.failure.check} (${loaded.failure.name}): ${loaded.failure.detail}`,
    );
  return loaded.file;
}

async function runDirectories(): Promise<string[]> {
  if (!existsSync(LIVE)) return [];
  const dirs: string[] = [];
  for (const repo of await readdir(LIVE, { withFileTypes: true }))
    if (repo.isDirectory())
      for (const run of await readdir(join(LIVE, repo.name), { withFileTypes: true }))
        if (run.isDirectory() && existsSync(join(LIVE, repo.name, run.name, "session.json")))
          dirs.push(join(LIVE, repo.name, run.name));
  return dirs.sort();
}

export async function main(argv: readonly string[]): Promise<number> {
  const [dir, ...rest] = argv;
  if (dir === undefined || rest.length > 0) {
    process.stderr.write("Usage: pnpm live-rates test/fixtures/live/<repo>/<run-id>\n");
    return 2;
  }
  const file = await loadRun(resolve(dir));
  const all = await Promise.all((await runDirectories()).map(loadRun));
  const section = renderRates(runRates(file), callTwoShare(all));
  const existing = existsSync(LOG) ? await readFile(LOG, "utf8") : undefined;
  await writeFile(LOG, appendRates(existing, file.session.id, section));
  process.stdout.write(
    `Appended ${file.session.id} to docs/LIVE_RUNS.md. Fill in the Console fields.\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
