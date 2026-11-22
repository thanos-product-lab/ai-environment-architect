import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { exportRun } from "../scripts/live/export.js";
import {
  type AnalyseSettings,
  analysePhase,
  type PhaseDeps,
  prepareAnalyse,
} from "../scripts/live/phases.js";
import { checkTarget } from "../scripts/live/targets.js";
import { openRepositoryFs } from "../src/adapters/fs/node-repository-fs.js";
import { openGitReader } from "../src/adapters/git/git-reader.js";
import { openStorage } from "../src/adapters/storage/node-storage.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../src/core/context/tiers.js";
import { DEFAULT_TOKEN_SETTINGS } from "../src/core/context/token-settings.js";
import { comparePaths } from "../src/core/paths.js";
import { openSession } from "../src/core/session/store.js";
import { DEFAULT_SNAPSHOT_SETTINGS } from "../src/core/snapshot/snapshot.js";
import type { CallPurpose } from "../src/core/validation/aliases.js";
import { scriptedRunDeps } from "./support/run-harness.js";
import { countingIds, tickingClock } from "./support/session.js";

// `analyse` with the real file system, git and storage adapters, on a temporary git repository,
// with recorded responses in place of the model. The whole repository, `.git` included, must be
// byte for byte and stat for stat what it was before: nothing is written to the target
// (CLAUDE.md invariants, M6 live-run protocol).

const FIXTURE = fileURLToPath(new URL("./fixtures/repos/end-to-end/", import.meta.url));

const recorded = (call: CallPurpose) =>
  readFileSync(
    new URL(`./fixtures/responses/${call}/sessions/end-to-end.json`, import.meta.url),
    "utf8",
  );

const SETTINGS: AnalyseSettings = {
  selection: {
    snapshot: DEFAULT_SNAPSHOT_SETTINGS,
    context: DEFAULT_CONTEXT_SETTINGS,
    tokens: DEFAULT_TOKEN_SETTINGS,
  },
  model: "claude-test",
  effort: "medium",
  maxCostUsd: 50,
  maxExpansionRequests: 5,
  expansionBytes: 50_000,
  expansionEntryBytes: 20_000,
  questionBudget: 5,
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A committed git repository holding the end-to-end fixture, isolated from any user config. */
function repository(): { root: string; commit: string; git: (...args: string[]) => string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "live-run-")));
  temporary.push(base);
  const root = join(base, "repo");
  for (const path of files(FIXTURE)) {
    const to = join(root, relative(FIXTURE, path));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(path));
  }
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "2026-11-22T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-22T10:00:00Z",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return { root, commit: git("rev-parse", "HEAD").trim(), git };
}

/** Every entry under `root`, `.git` included: path, kind, mode, size, mtime and content. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort(comparePaths);
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path, { bigint: true });
      const kind = stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f";
      hash.update(
        `${relative(root, path)}\0${kind}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0`,
      );
      if (kind === "f") hash.update(readFileSync(path));
      if (kind === "l") hash.update(readlinkSync(path));
      if (kind === "d") walk(path);
    }
  };
  walk(root);
  return hash.digest("hex");
}

async function deps(root: string, commit: string, storageDir: string) {
  const fs = await openRepositoryFs(root);
  const git = openGitReader(root);
  const lock = await openStorage(storageDir).lock(
    "ses_integration",
    { startedAt: "2026-11-22T10:00:00.000Z", productVersion: "0.1.0" },
    { create: true },
  );
  if (lock.state !== "acquired") throw new Error(`lock: ${lock.state}`);
  const { deps: run } = scriptedRunDeps(fs, [
    recorded("analyse"),
    recorded("analyse_expansion"),
    recorded("generate_questions"),
  ]);
  const phase: PhaseDeps = {
    writer: lock.session,
    repository: { name: "integration", url: "https://example.invalid/integration", commit, root },
    snapshot: { fs, git },
    ports: { clock: tickingClock(), ids: countingIds() },
    run,
    productVersion: "0.1.0",
  };
  return { phase, git, release: () => lock.session.release() };
}

describe("analyse on a real git repository, with the real adapters", () => {
  it("runs calls 1–3 and leaves the whole repository, .git included, exactly as it was", async () => {
    const { root, commit } = repository();
    const storageDir = join(dirname(root), "storage");
    const before = treeHash(root);

    const { phase, git, release } = await deps(root, commit, storageDir);
    try {
      const repositories = [{ name: "integration", url: "", commit }];
      expect(await checkTarget("integration", repositories, git)).toMatchObject({ ok: true });
      const ready = await prepareAnalyse(phase, SETTINGS);
      if (!ready.ok) throw new Error(ready.reason);
      const result = await analysePhase(phase, SETTINGS, ready.prepared);
      expect(result).toMatchObject({
        ok: true,
        steps: [
          { step: "analyse", kind: "completed" },
          { step: "expansion_round", kind: "completed" },
          { step: "generate_questions", kind: "completed" },
        ],
      });

      // The export holds neither the root nor the storage directory.
      const loaded = await openSession(phase.writer);
      if (!loaded.ok) throw new Error("the session doesn't load");
      await exportRun(loaded.file, phase.writer, [root, storageDir]);
    } finally {
      await release();
    }

    expect(treeHash(root)).toBe(before);
  });

  it("refuses a modified tracked file, found through real git, and still writes nothing", async () => {
    const { root, commit } = repository();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    const before = treeHash(root);

    const { phase, release } = await deps(root, commit, join(dirname(root), "storage"));
    try {
      expect(await prepareAnalyse(phase, SETTINGS)).toEqual({
        ok: false,
        reason: "the snapshot found changes that aren't committed",
      });
    } finally {
      await release();
    }

    expect(treeHash(root)).toBe(before);
  });
});
