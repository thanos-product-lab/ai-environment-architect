import { cpSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openRepositoryFs } from "../src/adapters/fs/node-repository-fs.js";
import { selectContext } from "../src/core/context/select.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../src/core/context/tiers.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../src/core/snapshot/snapshot.js";
import { fixedClock, fixedIds } from "./support/memory-fs.js";

// IMPL §1.15: changing modification times does not change the context. Only a real filesystem
// has them, so this runs the pipeline on a copy of a fixture repository.

const fixture = fileURLToPath(new URL("./fixtures/repos/nested-packages/", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function contextHash(root: string): Promise<string> {
  const fs = await openRepositoryFs(root);
  const settings = { snapshot: DEFAULT_SNAPSHOT_SETTINGS, context: DEFAULT_CONTEXT_SETTINGS };
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    settings.snapshot,
  );
  const result = await selectContext(snapshot, settings, fs);
  if (result.state !== "ready") throw new Error(`expected a context, got ${result.state}`);
  return result.context.hash;
}

function touchAll(dir: string, seconds: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) touchAll(path, seconds);
    utimesSync(path, seconds, seconds);
  }
}

describe("context determinism on a real filesystem", () => {
  it("gives the same contextHash after every modification time changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aea-context-"));
    temporary.push(root);
    cpSync(fixture, root, { recursive: true });
    touchAll(root, 1_000_000_000);
    const before = await contextHash(root);
    touchAll(root, 2_000_000_000);
    expect(await contextHash(root)).toBe(before);
  });
});
