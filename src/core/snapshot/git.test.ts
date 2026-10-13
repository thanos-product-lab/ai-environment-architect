import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
} from "../../../test/support/memory-fs.js";
import { sha256 } from "../hash.js";
import {
  type GitHead,
  type GitMetadata,
  type GitReader,
  type GitTreeEntry,
  gitBlobId,
  type ObjectFormat,
} from "./git.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS, type SnapshotFile } from "./snapshot.js";

const COMMIT = "c".repeat(40);

/** A committed regular file with these contents. */
const blob = (path: string, text: string, format: ObjectFormat = "sha1"): GitTreeEntry => ({
  path,
  mode: "100644",
  objectId: gitBlobId(Buffer.from(text), format),
  size: Buffer.byteLength(text),
});
const link = (path: string, target: string): GitTreeEntry => ({
  ...blob(path, target),
  mode: "120000",
});
const submodule = (path: string): GitTreeEntry => ({
  path,
  mode: "160000",
  objectId: "d".repeat(40),
  size: null,
});

const reader = (head: GitHead): GitReader => ({ readHead: async () => head });
const committed = (tree: GitTreeEntry[], format: ObjectFormat = "sha1"): GitReader =>
  reader({ ok: true, objectFormat: format, commit: COMMIT, tree, ignored: [] });

async function gitOf(
  nodes: Record<string, MemoryNode>,
  git: GitReader | undefined,
  fs = new MemoryFs(nodes),
): Promise<GitMetadata> {
  const deps =
    git === undefined
      ? { fs, clock: fixedClock, ids: fixedIds }
      : { fs, clock: fixedClock, ids: fixedIds, git };
  return (await captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS)).git;
}

const clean = {
  state: "known",
  objectFormat: "sha1",
  commit: COMMIT,
  workingTreeDirty: false,
  modifiedPaths: [],
  deletedPaths: [],
  untrackedCount: 0,
  uncomparedPaths: [],
  submodules: [],
};

describe("git metadata is unknown, never guessed (DM §6.1)", () => {
  it("is unknown when git is not inspected", async () => {
    expect(await gitOf({ "a.txt": "a" }, undefined)).toEqual({
      state: "unknown",
      reason: "not_inspected",
    });
  });

  it.each([
    "git_missing",
    "git_too_old",
    "not_a_repository",
    "unsafe_repository",
    "git_error",
  ] as const)("records the reader's reason %s", async (reason) => {
    expect(await gitOf({ "a.txt": "a" }, reader({ ok: false, reason }))).toEqual({
      state: "unknown",
      reason,
    });
  });

  it("a reader that throws gives git_error and never fails the snapshot", async () => {
    const throwing: GitReader = {
      readHead: async () => {
        throw new Error("boom");
      },
    };
    expect(await gitOf({ "a.txt": "a" }, throwing)).toEqual({
      state: "unknown",
      reason: "git_error",
    });
  });
});

describe("working tree compared with the commit", () => {
  it("is clean when every compared path has the committed bytes", async () => {
    const git = committed([blob("a.txt", "a\n"), blob("src/b.ts", "b\n")]);
    expect(await gitOf({ "a.txt": "a\n", "src/b.ts": "b\n" }, git)).toEqual(clean);
  });

  it("handles SHA-256 repositories", async () => {
    const commit = "e".repeat(64);
    const git = reader({
      ok: true,
      objectFormat: "sha256",
      commit,
      tree: [blob("a.txt", "a\n", "sha256")],
      ignored: [],
    });
    expect(await gitOf({ "a.txt": "a\n" }, git)).toEqual({
      ...clean,
      objectFormat: "sha256",
      commit,
    });
  });

  it("a file with different bytes of the same size is modified", async () => {
    const git = committed([blob("a.txt", "a\n")]);
    expect(await gitOf({ "a.txt": "b\n" }, git)).toMatchObject({
      workingTreeDirty: true,
      modifiedPaths: ["a.txt"],
    });
  });

  it("a file of a different size is modified without being read again", async () => {
    const fs = new MemoryFs({ "a.txt": "longer\n" });
    const git = committed([blob("a.txt", "a\n")]);
    expect(await gitOf({}, git, fs)).toMatchObject({ modifiedPaths: ["a.txt"] });
    // Two observations during capture, none for the comparison.
    expect(fs.reads.filter((path) => path === "a.txt")).toHaveLength(2);
  });

  it("a large listed_only file is compared too", async () => {
    const big = "x".repeat(300_000);
    expect(await gitOf({ "big.txt": big }, committed([blob("big.txt", big)]))).toEqual(clean);
  });

  it("a tracked file missing from the working tree is deleted", async () => {
    const git = committed([blob("a.txt", "a"), blob("gone.txt", "g")]);
    expect(await gitOf({ "a.txt": "a" }, git)).toMatchObject({
      workingTreeDirty: true,
      deletedPaths: ["gone.txt"],
    });
  });

  it("a tracked file under a directory that is now a symbolic link is deleted", async () => {
    const git = committed([blob("docs/a.md", "a")]);
    const nodes = { docs: { kind: "symlink", target: "elsewhere" } } as const;
    expect(await gitOf(nodes, git)).toMatchObject({ deletedPaths: ["docs/a.md"] });
  });

  it("counts untracked files that are not excluded", async () => {
    const git = committed([blob("a.txt", "a")]);
    const nodes = { "a.txt": "a", "new.ts": "n", "notes/x.md": "x", ".env": "X=1" };
    expect(await gitOf(nodes, git)).toMatchObject({ workingTreeDirty: true, untrackedCount: 2 });
  });

  it("does not compare tracked paths that are excluded, and never opens them", async () => {
    const fs = new MemoryFs({ "a.txt": "a", "pnpm-lock.yaml": "changed", "vendor/x.js": "x" });
    const git = committed([
      blob("a.txt", "a"),
      blob("pnpm-lock.yaml", "original"),
      blob("vendor/x.js", "original"),
    ]);
    expect(await gitOf({}, git, fs)).toEqual(clean);
    expect(fs.reads).not.toContain("pnpm-lock.yaml");
    expect(fs.reads).not.toContain("vendor/x.js");
  });

  it("compares a symbolic link by its target", async () => {
    const nodes = { "l.md": { kind: "symlink", target: "docs/a.md" } } as const;
    expect(await gitOf(nodes, committed([link("l.md", "docs/a.md")]))).toEqual(clean);
    expect(await gitOf(nodes, committed([link("l.md", "docs/b.md")]))).toMatchObject({
      modifiedPaths: ["l.md"],
    });
  });

  it("a file that became a link, or a link that became a file, is modified", async () => {
    const asLink = { "a.md": { kind: "symlink", target: "a" } } as const;
    expect(await gitOf(asLink, committed([blob("a.md", "a")]))).toMatchObject({
      modifiedPaths: ["a.md"],
    });
    expect(await gitOf({ "a.md": "a" }, committed([link("a.md", "a")]))).toMatchObject({
      modifiedPaths: ["a.md"],
    });
  });

  it("lists submodules without comparing them or counting their files as untracked", async () => {
    const git = committed([blob("a.txt", "a"), submodule("libs/ui")]);
    const nodes = { "a.txt": "a", "libs/ui/index.ts": "x", "libs/ui/.git": "gitdir: ../x" };
    expect(await gitOf(nodes, git)).toEqual({ ...clean, submodules: ["libs/ui"] });
  });

  it("an unreadable tracked file makes the result unknown, not clean", async () => {
    const git = committed([blob("a.txt", "a"), blob("locked.txt", "l")]);
    const nodes = {
      "a.txt": "a",
      "locked.txt": { kind: "unreadable_file", reason: "permission_denied" },
    } as const;
    expect(await gitOf(nodes, git)).toMatchObject({
      workingTreeDirty: "unknown",
      uncomparedPaths: ["locked.txt"],
    });
  });

  it("an unreadable directory is uncompared, with the tracked paths inside it", async () => {
    const git = committed([blob("private/a.txt", "a")]);
    const nodes = { private: { kind: "directory", failure: "permission_denied" } } as const;
    expect(await gitOf(nodes, git)).toMatchObject({
      workingTreeDirty: "unknown",
      deletedPaths: [],
      uncomparedPaths: ["private"],
    });
  });

  it("an untracked unreadable directory makes the result unknown", async () => {
    const git = committed([blob("a.txt", "a")]);
    const nodes = {
      "a.txt": "a",
      cache: { kind: "directory", failure: "permission_denied" },
    } as const;
    expect(await gitOf(nodes, git)).toMatchObject({
      workingTreeDirty: "unknown",
      untrackedCount: 0,
      uncomparedPaths: ["cache"],
    });
  });

  it("a symbolic link whose target is not valid UTF-8 is uncompared, not modified", async () => {
    const nodes = { "l.md": { kind: "symlink", target: "bad\\xff", targetIsUtf8: false } } as const;
    expect(await gitOf(nodes, committed([link("l.md", "bad\\xff")]))).toMatchObject({
      workingTreeDirty: "unknown",
      modifiedPaths: [],
      uncomparedPaths: ["l.md"],
    });
  });

  it("a known difference outweighs an uncompared path", async () => {
    const git = committed([blob("a.txt", "a"), blob("locked.txt", "l")]);
    const nodes = {
      "a.txt": "b",
      "locked.txt": { kind: "unreadable_file", reason: "permission_denied" },
    } as const;
    expect(await gitOf(nodes, git)).toMatchObject({ workingTreeDirty: true });
  });

  it("a file that changes after capture is uncompared, not misreported", async () => {
    const fs = new MemoryFs({
      "a.txt": { kind: "file", content: (n) => Buffer.from(n <= 2 ? "a" : "b") },
    });
    expect(await gitOf({}, committed([blob("a.txt", "a")]), fs)).toMatchObject({
      workingTreeDirty: "unknown",
      uncomparedPaths: ["a.txt"],
    });
  });

  it("before the first commit, every file is untracked", async () => {
    const git = reader({ ok: true, objectFormat: "sha1", commit: null, tree: [], ignored: [] });
    expect(await gitOf({ "a.txt": "a", "b.txt": "b" }, git)).toEqual({
      ...clean,
      commit: null,
      workingTreeDirty: true,
      untrackedCount: 2,
    });
  });

  it("lists differences in bytewise path order", async () => {
    const git = committed([blob("b.txt", "1"), blob("a.txt", "1"), blob("B.txt", "1")]);
    expect(await gitOf({ "a.txt": "2", "b.txt": "2", "B.txt": "2" }, git)).toMatchObject({
      modifiedPaths: ["B.txt", "a.txt", "b.txt"],
    });
  });
});

describe("ignored files (DM §6.1, IMPL §1.4)", () => {
  const ignoring = (tree: GitTreeEntry[], ignored: string[]): GitReader =>
    reader({ ok: true, objectFormat: "sha1", commit: COMMIT, tree, ignored });

  async function snapshotOf(nodes: Record<string, MemoryNode>, git: GitReader | undefined) {
    const fs = new MemoryFs(nodes);
    const deps =
      git === undefined
        ? { fs, clock: fixedClock, ids: fixedIds }
        : { fs, clock: fixedClock, ids: fixedIds, git };
    return captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS);
  }
  const statusOf = (files: readonly SnapshotFile[], path: string) =>
    files.find((file) => file.path === path)?.status;

  it("records an ignored file as ignored, hashed, and not untracked", async () => {
    const nodes = { "a.txt": "a", "server/config.js": "x", "notes.md": "n" };
    const snapshot = await snapshotOf(nodes, ignoring([blob("a.txt", "a")], ["server/config.js"]));
    expect(snapshot.files.find((file) => file.path === "server/config.js")).toEqual({
      path: "server/config.js",
      status: "ignored",
      size: 1,
      hash: sha256(Buffer.from("x")),
    });
    expect(statusOf(snapshot.files, "notes.md")).toBe("read");
    expect(snapshot.git).toMatchObject({ workingTreeDirty: true, untrackedCount: 1 });
  });

  it("an ignored directory makes every readable file under it ignored", async () => {
    const nodes = { "a.txt": "a", "logs/app.log": "l", "logs/old/x.log": "o", "logs2/y": "y" };
    const snapshot = await snapshotOf(nodes, ignoring([blob("a.txt", "a")], ["logs/"]));
    expect(statusOf(snapshot.files, "logs/app.log")).toBe("ignored");
    expect(statusOf(snapshot.files, "logs/old/x.log")).toBe("ignored");
    expect(statusOf(snapshot.files, "logs2/y")).toBe("read");
  });

  it("only ignored files make no difference to a clean tree", async () => {
    const nodes = { "a.txt": "a", "debug.log": "d" };
    const snapshot = await snapshotOf(nodes, ignoring([blob("a.txt", "a")], ["debug.log"]));
    expect(snapshot.git).toEqual(clean);
  });

  it("an ignored listed_only file is ignored too", async () => {
    const nodes = { "a.txt": "a", "dump.rdb": Uint8Array.from([0, 1, 2]) };
    const snapshot = await snapshotOf(nodes, ignoring([blob("a.txt", "a")], ["dump.rdb"]));
    expect(statusOf(snapshot.files, "dump.rdb")).toBe("ignored");
  });

  it("tracked files, the destination, excluded entries and links are never ignored", async () => {
    const nodes = {
      "CLAUDE.md": "# Guide\n",
      "kept.log": "k",
      ".env": "X=1",
      "l.md": { kind: "symlink", target: "kept.log" },
    } as const;
    const tree = [blob("CLAUDE.md", "# Guide\n"), blob("kept.log", "k")];
    const ignored = ["CLAUDE.md", "kept.log", ".env", "l.md"];
    const snapshot = await snapshotOf(nodes, ignoring(tree, ignored));
    expect(statusOf(snapshot.files, "CLAUDE.md")).toBe("read");
    expect(snapshot.destination.state).toBe("present");
    expect(statusOf(snapshot.files, "kept.log")).toBe("read");
    expect(statusOf(snapshot.files, ".env")).toBe("excluded");
    expect(statusOf(snapshot.files, "l.md")).toBe("symlink");
  });

  it("without git, nothing is ignored and only the default rules apply", async () => {
    const snapshot = await snapshotOf({ "server/config.js": "x" }, undefined);
    expect(statusOf(snapshot.files, "server/config.js")).toBe("read");
    const failed = await snapshotOf(
      { "server/config.js": "x" },
      reader({ ok: false, reason: "git_missing" }),
    );
    expect(statusOf(failed.files, "server/config.js")).toBe("read");
  });

  it("before the first commit, ignore rules still apply", async () => {
    const git = reader({
      ok: true,
      objectFormat: "sha1",
      commit: null,
      tree: [],
      ignored: ["x.log"],
    });
    const snapshot = await snapshotOf({ "a.txt": "a", "x.log": "x" }, git);
    expect(statusOf(snapshot.files, "x.log")).toBe("ignored");
    expect(snapshot.git).toMatchObject({ untrackedCount: 1 });
  });
});
