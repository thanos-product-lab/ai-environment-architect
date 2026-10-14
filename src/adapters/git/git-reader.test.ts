import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint } from "../../../test/support/fingerprint.js";
import { fixedClock, fixedIds } from "../../../test/support/memory-fs.js";
import type { GitMetadata } from "../../core/snapshot/git.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../../core/snapshot/snapshot.js";
import { openRepositoryFs } from "../fs/node-repository-fs.js";
import { type GitReaderOptions, openGitReader } from "./git-reader.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "aea-git-"));
  temporaryDirectories.push(dir);
  return dir;
}

/** Runs git for test setup, isolated from the developer's own git configuration. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env["PATH"], GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

function repository(files: Record<string, string>, objectFormat = "sha1"): string {
  const root = temporaryDirectory();
  git(root, "init", "-q", "-b", "main", `--object-format=${objectFormat}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (Object.keys(files).length > 0) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
  }
  return root;
}

async function gitMetadataOf(root: string, options: GitReaderOptions = {}): Promise<GitMetadata> {
  const deps = {
    fs: await openRepositoryFs(root),
    clock: fixedClock,
    ids: fixedIds,
    git: openGitReader(root, options),
  };
  return (await captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS)).git;
}

const installedVersion = (() => {
  const match = /git version (\d+)\.(\d+)/.exec(
    execFileSync("git", ["--version"], { encoding: "utf8" }),
  );
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])];
})();
const atLeast = (major: number, minor: number) =>
  (installedVersion[0] ?? 0) > major ||
  ((installedVersion[0] ?? 0) === major && (installedVersion[1] ?? 0) >= minor);
/** Whether the git on PATH is new enough for the reader (2.38, for safe.bareRepository). */
const gitIsRecent = atLeast(2, 38);

/**
 * The real git, reporting an older version: like git before 2.44, it rejects --no-lazy-fetch.
 * Shows how the reader treats older git without needing one installed.
 */
function olderGit(version: string): string {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const path = join(temporaryDirectory(), "git");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi`,
      'for a in "$@"; do',
      '  if [ "$a" = "--no-lazy-fetch" ]; then echo "unknown option: --no-lazy-fetch" >&2; exit 129; fi',
      "done",
      `exec "${real}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** A fake git executable: answers --version, and otherwise prints to stderr and fails. */
function fakeGit(version: string, stderr: string): string {
  const path = join(temporaryDirectory(), "git");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\necho "${stderr}" >&2\nexit 128\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(!gitIsRecent)("commit and object format", () => {
  it("reads the commit of a clean SHA-1 repository", async () => {
    const root = repository({ "README.md": "# Demo\n", "src/a.ts": "export {};\n" });
    const head = git(root, "rev-parse", "HEAD").trim();
    expect(await gitMetadataOf(root)).toEqual({
      state: "known",
      objectFormat: "sha1",
      commit: head,
      workingTreeDirty: false,
      modifiedPaths: [],
      deletedPaths: [],
      untrackedCount: 0,
      uncomparedPaths: [],
      submodules: [],
    });
  });

  it("reads a SHA-256 repository", async () => {
    const root = repository({ "README.md": "# Demo\n" }, "sha256");
    const metadata = await gitMetadataOf(root);
    expect(metadata).toMatchObject({
      state: "known",
      objectFormat: "sha256",
      workingTreeDirty: false,
    });
    expect(metadata.state === "known" && metadata.commit?.length).toBe(64);
  });

  it("a repository with no commits has no commit, and its files are untracked", async () => {
    const root = repository({});
    writeFileSync(join(root, "a.txt"), "a");
    expect(await gitMetadataOf(root)).toMatchObject({
      state: "known",
      commit: null,
      workingTreeDirty: true,
      untrackedCount: 1,
    });
  });
});

describe.skipIf(!gitIsRecent)("dirty working tree", () => {
  it("a clean linked worktree is clean (its .git is a file)", async () => {
    const main = repository({ "a.txt": "a\n" });
    const worktree = join(temporaryDirectory(), "wt");
    git(main, "worktree", "add", "-q", worktree);
    expect(await gitMetadataOf(worktree)).toMatchObject({
      state: "known",
      workingTreeDirty: false,
      untrackedCount: 0,
    });
  });

  it("ignores the executable bit and staged changes: only bytes count", async () => {
    const root = repository({ "run.sh": "echo\n", "a.txt": "a\n" });
    chmodSync(join(root, "run.sh"), 0o755);
    expect(await gitMetadataOf(root)).toMatchObject({ workingTreeDirty: false });
    writeFileSync(join(root, "a.txt"), "staged\n");
    git(root, "add", "a.txt");
    writeFileSync(join(root, "a.txt"), "a\n");
    expect(await gitMetadataOf(root)).toMatchObject({ workingTreeDirty: false });
  });

  it("a file ignored by .gitignore is not untracked", async () => {
    const root = repository({ ".gitignore": "*.log\n", "a.txt": "a\n" });
    writeFileSync(join(root, "debug.log"), "x\n");
    expect(await gitMetadataOf(root)).toMatchObject({ workingTreeDirty: false, untrackedCount: 0 });
  });

  it("parses paths with tabs and newlines, and submodule entries", async () => {
    const root = repository({ "tab\there.txt": "t\n", "new\nline.txt": "n\n" });
    const commit = git(root, "rev-parse", "HEAD").trim();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${commit},libs/ui`);
    git(root, "commit", "-q", "-m", "submodule");
    expect(await gitMetadataOf(root)).toMatchObject({
      workingTreeDirty: false,
      deletedPaths: [],
      submodules: ["libs/ui"],
    });
  });

  it("reports modified, deleted and untracked files", async () => {
    const root = repository({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    writeFileSync(join(root, "a.txt"), "changed\n");
    unlinkSync(join(root, "b.txt"));
    writeFileSync(join(root, "new.txt"), "n\n");
    expect(await gitMetadataOf(root)).toMatchObject({
      workingTreeDirty: true,
      modifiedPaths: ["a.txt"],
      deletedPaths: ["b.txt"],
      untrackedCount: 1,
    });
  });

  it("compares symbolic links by target", async () => {
    const root = repository({ "docs/a.md": "a\n" });
    execFileSync("ln", ["-s", "docs/a.md", join(root, "link.md")]);
    git(root, "add", "link.md");
    git(root, "commit", "-q", "-m", "link");
    expect(await gitMetadataOf(root)).toMatchObject({ workingTreeDirty: false });
  });
});

describe.skipIf(!gitIsRecent)("ignored files (IMPL §1.4)", () => {
  async function snapshotOf(root: string) {
    const deps = {
      fs: await openRepositoryFs(root),
      clock: fixedClock,
      ids: fixedIds,
      git: openGitReader(root),
    };
    return captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS);
  }
  const statuses = (files: readonly { path: string; status: string }[]) =>
    Object.fromEntries(files.map((file) => [file.path, file.status]));

  it("applies .gitignore at any depth and .git/info/exclude; tracked and other files stay", async () => {
    const root = repository({
      ".gitignore": "logs/\n*.log\n",
      "server/.gitignore": "config.js\n",
      "kept.log": "tracked before the rule\n",
      "server/index.js": "x\n",
    });
    git(root, "add", "-f", "kept.log");
    git(root, "commit", "-q", "-m", "tracked log");
    mkdirSync(join(root, "logs/old"), { recursive: true });
    writeFileSync(join(root, "logs/old/app.log"), "l\n");
    writeFileSync(join(root, "server/config.js"), "c\n");
    writeFileSync(join(root, "notes.md"), "untracked, not ignored\n");
    writeFileSync(join(root, "local.txt"), "x\n");
    writeFileSync(join(root, ".git/info/exclude"), "local.txt\n");
    writeFileSync(join(root, "tab\there.log"), "t\n");

    const snapshot = await snapshotOf(root);
    expect(statuses(snapshot.files)).toMatchObject({
      "kept.log": "read",
      logs: "ignored",
      "server/config.js": "ignored",
      "server/index.js": "read",
      "notes.md": "read",
      "local.txt": "ignored",
      "tab\there.log": "ignored",
    });
    // A wholly ignored directory is one entry, never entered.
    expect(snapshot.files.find((file) => file.path === "logs")).toEqual({
      path: "logs",
      status: "ignored",
      kind: "directory",
    });
    expect(snapshot.files.some((file) => file.path.startsWith("logs/"))).toBe(false);
    expect(snapshot.ignoreRules).toEqual({ state: "applied" });
    expect(snapshot.git).toMatchObject({ workingTreeDirty: true, untrackedCount: 1 });
  });

  it("enters a directory that holds a tracked file, listing its ignored files one by one", async () => {
    const root = repository({ ".gitignore": "build-cache/\n", "build-cache/keep.txt": "k\n" });
    git(root, "add", "-f", "build-cache/keep.txt");
    git(root, "commit", "-q", "-m", "keep");
    writeFileSync(join(root, "build-cache/x.bin.txt"), "x\n");
    const snapshot = await snapshotOf(root);
    expect(statuses(snapshot.files)).toMatchObject({
      "build-cache/keep.txt": "read",
      "build-cache/x.bin.txt": "ignored",
    });
  });

  it("ignores a core.excludesFile set in the repository's own config", async () => {
    const root = repository({ "a.txt": "a\n" });
    const outside = join(temporaryDirectory(), "excludes");
    writeFileSync(outside, "local.txt\n");
    git(root, "config", "core.excludesFile", outside);
    writeFileSync(join(root, "local.txt"), "x\n");
    const snapshot = await snapshotOf(root);
    expect(statuses(snapshot.files)).toMatchObject({ "local.txt": "read" });
  });

  it("lists ignored files without writing to the repository", async () => {
    const root = repository({ ".gitignore": "*.log\n", "a.txt": "a\n" });
    writeFileSync(join(root, "x.log"), "x\n");
    const before = fingerprint(join(root, ".git"));
    await snapshotOf(root);
    expect(fingerprint(join(root, ".git"))).toEqual(before);
  });
});

describe.skipIf(!gitIsRecent)("untrusted repositories", () => {
  it("writes nothing inside the repository, including .git", async () => {
    const root = repository({ "a.txt": "a\n", "src/b.ts": "b\n" });
    writeFileSync(join(root, "a.txt"), "changed\n");
    const before = fingerprint(root);
    await gitMetadataOf(root);
    expect(fingerprint(root)).toEqual(before);
  });

  it("never runs an fsmonitor hook configured by the repository", async () => {
    const root = repository({ "a.txt": "a\n" });
    const marker = join(temporaryDirectory(), "ran");
    const hook = join(temporaryDirectory(), "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    git(root, "config", "core.fsmonitor", hook);
    await gitMetadataOf(root);
    expect(existsSync(marker)).toBe(false);
  });

  it("ignores GIT_DIR and global config from the environment", async () => {
    const root = repository({ "a.txt": "a\n" });
    const other = repository({ "other.txt": "o\n" });
    // Git fails outright on an invalid config file it reads, so a known result proves it wasn't.
    const globalConfig = join(temporaryDirectory(), "gitconfig");
    writeFileSync(globalConfig, "[[[ not a config file\n");
    const saved = { dir: process.env["GIT_DIR"], global: process.env["GIT_CONFIG_GLOBAL"] };
    process.env["GIT_DIR"] = join(other, ".git");
    process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
    try {
      expect(await gitMetadataOf(root)).toMatchObject({
        state: "known",
        workingTreeDirty: false,
        untrackedCount: 0,
      });
    } finally {
      for (const [key, value] of [
        ["GIT_DIR", saved.dir],
        ["GIT_CONFIG_GLOBAL", saved.global],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not read a bare-repository layout at the root", async () => {
    const root = temporaryDirectory();
    git(root, "init", "-q", "--bare", ".");
    expect(await gitMetadataOf(root)).toEqual({ state: "unknown", reason: "not_a_repository" });
  });

  it("a repository whose core.worktree points elsewhere is not this folder", async () => {
    const root = repository({ "a.txt": "a\n" });
    git(root, "config", "core.worktree", temporaryDirectory());
    expect(await gitMetadataOf(root)).toEqual({ state: "unknown", reason: "not_a_repository" });
  });
});

describe("unknown, with a reason, never a failure", () => {
  it.skipIf(gitIsRecent)("the installed git is too old", async () => {
    expect(await gitMetadataOf(repository({ "a.txt": "a\n" }))).toEqual({
      state: "unknown",
      reason: "git_too_old",
    });
  });

  it.skipIf(!gitIsRecent)("a folder that is not a repository", async () => {
    expect(await gitMetadataOf(temporaryDirectory())).toEqual({
      state: "unknown",
      reason: "not_a_repository",
    });
  });

  it.skipIf(!gitIsRecent)(
    "a subfolder of a repository is not treated as that repository",
    async () => {
      const root = repository({ "sub/a.txt": "a\n" });
      expect(await gitMetadataOf(join(root, "sub"))).toEqual({
        state: "unknown",
        reason: "not_a_repository",
      });
    },
  );

  it("git is missing", async () => {
    const root = repository({ "a.txt": "a\n" });
    expect(await gitMetadataOf(root, { gitPath: "/nonexistent/git" })).toEqual({
      state: "unknown",
      reason: "git_missing",
    });
  });

  it("git older than 2.38 is too old", async () => {
    const root = repository({ "a.txt": "a\n" });
    expect(await gitMetadataOf(root, { gitPath: fakeGit("2.37.9", "unused") })).toEqual({
      state: "unknown",
      reason: "git_too_old",
    });
  });

  it.skipIf(!gitIsRecent)(
    "git older than 2.44 reads an ordinary repository, without --no-lazy-fetch",
    async () => {
      const root = repository({ ".gitignore": "*.log\n", "a.txt": "a\n" });
      writeFileSync(join(root, "x.log"), "x\n");
      const deps = {
        fs: await openRepositoryFs(root),
        clock: fixedClock,
        ids: fixedIds,
        git: openGitReader(root, { gitPath: olderGit("2.39.5") }),
      };
      const snapshot = await captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS);
      expect(snapshot.git).toMatchObject({ state: "known", workingTreeDirty: false });
      expect(snapshot.ignoreRules).toEqual({ state: "applied" });
      expect(snapshot.files.find((file) => file.path === "x.log")?.status).toBe("ignored");
    },
  );

  it.skipIf(!gitIsRecent).each([
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "true"],
  ])("git older than 2.44 refuses a partial clone (%s)", async (key, value) => {
    const root = repository({ "a.txt": "a\n" });
    git(root, "config", key, value);
    const deps = {
      fs: await openRepositoryFs(root),
      clock: fixedClock,
      ids: fixedIds,
      git: openGitReader(root, { gitPath: olderGit("2.39.5") }),
    };
    const snapshot = await captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS);
    expect(snapshot.git).toEqual({ state: "unknown", reason: "git_too_old" });
    expect(snapshot.ignoreRules).toEqual({ state: "not_applied", reason: "git_too_old" });
  });

  it.skipIf(!gitIsRecent).each([
    ["a promisor key in an included file", "promisor"],
    ["a config git can't read", "unreadable"],
  ])("git older than 2.44 refuses %s", async (_, kind) => {
    const root = repository({ "a.txt": "a\n" });
    if (kind === "promisor") {
      const included = join(temporaryDirectory(), "included.gitconfig");
      writeFileSync(included, '[remote "origin"]\n\tpromisor = true\n');
      git(root, "config", "include.path", included);
    } else {
      // HOME isn't passed to git, so a `~/` include can't be resolved.
      git(root, "config", "include.path", "~/missing.gitconfig");
    }
    const deps = {
      fs: await openRepositoryFs(root),
      clock: fixedClock,
      ids: fixedIds,
      git: openGitReader(root, { gitPath: olderGit("2.39.5") }),
    };
    const snapshot = await captureSnapshot(deps, DEFAULT_SNAPSHOT_SETTINGS);
    expect(snapshot.git).toMatchObject({ state: "unknown" });
    expect(snapshot.ignoreRules).toMatchObject({ state: "not_applied" });
  });

  it.skipIf(!atLeast(2, 44))("git 2.44 or later reads a partial clone", async () => {
    const root = repository({ "a.txt": "a\n" });
    git(root, "config", "remote.origin.promisor", "true");
    expect(await gitMetadataOf(root)).toMatchObject({ state: "known" });
  });

  it("git refuses the repository because of safe.directory", async () => {
    const root = repository({ "a.txt": "a\n" });
    const refusing = fakeGit(
      "2.50.0",
      `fatal: detected dubious ownership in repository at '${root}'`,
    );
    expect(await gitMetadataOf(root, { gitPath: refusing })).toEqual({
      state: "unknown",
      reason: "unsafe_repository",
    });
  });

  it.skipIf(!gitIsRecent)(
    "a HEAD that points to a missing object is an error, not 'no commits'",
    async () => {
      const root = repository({ "a.txt": "a\n" });
      writeFileSync(join(root, ".git/refs/heads/main"), `${"0123456789".repeat(4)}\n`);
      expect(await gitMetadataOf(root)).toEqual({ state: "unknown", reason: "git_error" });
    },
  );

  it("any other git failure is git_error", async () => {
    const root = repository({ "a.txt": "a\n" });
    expect(
      await gitMetadataOf(root, { gitPath: fakeGit("2.50.0", "fatal: something else") }),
    ).toEqual({
      state: "unknown",
      reason: "git_error",
    });
  });
});
