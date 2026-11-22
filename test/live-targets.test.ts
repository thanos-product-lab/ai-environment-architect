import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIVE_KEY_VARIABLE, readApiKey } from "../scripts/live/setup.js";
import {
  checkTarget,
  parseDevelopmentRepositories,
  snapshotProblem,
} from "../scripts/live/targets.js";
import type { GitHead } from "../src/core/snapshot/git.js";
import type { Snapshot } from "../src/core/snapshot/snapshot.js";

// The live run's guard (M6 live-run protocol, step 1) and its key (step 2).

const PRODUCT = fileURLToPath(new URL("../", import.meta.url));
const TABLE = readFileSync(join(PRODUCT, "docs", "DEVELOPMENT_REPOSITORIES.md"), "utf8");
const REPOSITORIES = parseDevelopmentRepositories(TABLE);
const OFETCH = REPOSITORIES.find((r) => r.name === "ofetch");
if (OFETCH === undefined) throw new Error("ofetch isn't listed");

function git(
  head: GitHead = { ok: true, objectFormat: "sha1", commit: OFETCH?.commit ?? null, tree: [] },
) {
  return { readHead: async () => head };
}
const at = (commit: string | null | undefined): GitHead => ({
  ok: true,
  objectFormat: "sha1",
  commit: commit ?? null,
  tree: [],
});

describe("the development repositories table", () => {
  it("lists the three repositories, each with a full pinned SHA", () => {
    expect(REPOSITORIES.map((r) => r.name)).toEqual(["ofetch", "kutt", "claude-code-action"]);
    for (const r of REPOSITORIES) expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a row whose pin isn't a full SHA", () => {
    const short = TABLE.replace(OFETCH.commit, OFETCH.commit.slice(0, 7));
    expect(() => parseDevelopmentRepositories(short)).toThrow(/full pinned SHA/);
  });
});

describe("checkTarget", () => {
  it("accepts a listed repository at its pin", async () => {
    expect(await checkTarget("ofetch", REPOSITORIES, git())).toEqual({
      ok: true,
      repository: OFETCH,
    });
  });

  it("refuses a repository that isn't listed", async () => {
    expect(await checkTarget("other", REPOSITORIES, git())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/isn't listed/),
    });
  });

  it("refuses a root git can't read, such as one that isn't its repository's top level", async () => {
    expect(
      await checkTarget("ofetch", REPOSITORIES, git({ ok: false, reason: "not_a_repository" })),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/not_a_repository/) });
  });

  it("refuses a HEAD other than the pin", async () => {
    expect(await checkTarget("ofetch", REPOSITORIES, git(at("f".repeat(40))))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not its pinned/),
    });
  });

  it("refuses another listed repository's pin, so a name can't stand for another root", async () => {
    const kutt = REPOSITORIES.find((r) => r.name === "kutt");
    expect(await checkTarget("ofetch", REPOSITORIES, git(at(kutt?.commit)))).toMatchObject({
      ok: false,
    });
  });

  it("refuses a repository with no commit", async () => {
    expect(await checkTarget("ofetch", REPOSITORIES, git(at(null)))).toMatchObject({ ok: false });
  });
});

describe("snapshotProblem", () => {
  const snapshot = (git: Snapshot["git"], stable = true) =>
    ({
      git,
      stability: stable ? { state: "stable" } : { state: "unstable", changedPaths: ["a"] },
    }) as unknown as Snapshot;
  const clean = {
    state: "known",
    objectFormat: "sha1",
    commit: OFETCH.commit,
    workingTreeDirty: false,
    modifiedPaths: [],
    deletedPaths: [],
    untrackedCount: 0,
  } as unknown as Snapshot["git"];

  it("accepts a stable snapshot, clean at the pin", () => {
    expect(snapshotProblem(snapshot(clean), OFETCH.commit)).toBeUndefined();
  });

  it.each([
    ["no git metadata", snapshot({ state: "unknown", reason: "git_missing" })],
    ["another commit", snapshot({ ...clean, commit: "f".repeat(40) } as Snapshot["git"])],
    ["a modified file", snapshot({ ...clean, workingTreeDirty: true } as Snapshot["git"])],
    [
      "an unknown working tree",
      snapshot({ ...clean, workingTreeDirty: "unknown" } as Snapshot["git"]),
    ],
    ["an untracked file", snapshot({ ...clean, untrackedCount: 1 } as Snapshot["git"])],
    ["a deleted file", snapshot({ ...clean, deletedPaths: ["a.ts"] } as Snapshot["git"])],
    ["a change while it was read", snapshot(clean, false)],
  ])("refuses %s", (_, s) => {
    expect(snapshotProblem(s, OFETCH.commit)).toEqual(expect.any(String));
  });
});

describe("the API key", () => {
  it(`is read from ${LIVE_KEY_VARIABLE} only`, () => {
    expect(readApiKey({ [LIVE_KEY_VARIABLE]: "sk-live" })).toEqual({ ok: true, key: "sk-live" });
    expect(readApiKey({ ANTHROPIC_API_KEY: "sk-general" })).toMatchObject({ ok: false });
    expect(readApiKey({ [LIVE_KEY_VARIABLE]: " " })).toMatchObject({ ok: false });
  });
});

describe("the run script, as a process", () => {
  const run = (args: readonly string[], env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        join(PRODUCT, "test/support/ts-resolve.mjs"),
        join(PRODUCT, "scripts/live-run.ts"),
        ...args,
      ],
      { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...env } },
    );

  it("prints its usage for a missing phase", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage:/);
  });

  it("refuses a repository that isn't listed, before it reads a key or creates a session", () => {
    const home = mkdtempSync(join(tmpdir(), "live-run-"));
    const result = run(["analyse", "--repo", "other", "--root", PRODUCT, "--max-cost-usd", "1"], {
      AI_ENVIRONMENT_ARCHITECT_HOME: home,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refused: other isn't listed/);
  });

  it("refuses this product's own repository under a listed name, since it isn't at the pin", () => {
    const result = run(["analyse", "--repo", "ofetch", "--root", PRODUCT, "--max-cost-usd", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refused: ofetch is at .*, not its pinned/);
  });
});
