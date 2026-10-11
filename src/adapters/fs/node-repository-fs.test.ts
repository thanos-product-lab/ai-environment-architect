import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint } from "../../../test/support/fingerprint.js";
import { fixedClock, fixedIds } from "../../../test/support/memory-fs.js";
import { sha256 } from "../../core/hash.js";
import {
  captureSnapshot,
  DEFAULT_SNAPSHOT_SETTINGS,
  type Snapshot,
} from "../../core/snapshot/snapshot.js";
import { openRepositoryFs } from "./node-repository-fs.js";

const fixtures = fileURLToPath(new URL("../../../test/fixtures/repos/", import.meta.url));

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "aea-snapshot-"));
  temporaryDirectories.push(dir);
  return dir;
}

/** Restores permissions so cleanup can delete everything. Names stay bytes: some aren't UTF-8. */
function chmodTree(dir: string | Buffer): void {
  for (const name of readdirSync(dir, { encoding: "buffer" })) {
    const path = Buffer.concat([Buffer.from(dir), Buffer.from("/"), name]);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    chmodSync(path, stat.isDirectory() ? 0o755 : 0o644);
    if (stat.isDirectory()) chmodTree(path);
  }
}

async function snapshotOf(root: string): Promise<Snapshot> {
  return captureSnapshot(
    { fs: await openRepositoryFs(root), clock: fixedClock, ids: fixedIds },
    DEFAULT_SNAPSHOT_SETTINGS,
  );
}

const statusOf = (snapshot: Snapshot, path: string) =>
  snapshot.files.find((f) => f.path === path)?.status;

describe("snapshots of the fixture repositories", () => {
  it("no-claude-md has an absent destination", async () => {
    const snapshot = await snapshotOf(join(fixtures, "no-claude-md"));
    expect(snapshot.destination).toEqual({ state: "absent" });
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "src/index.ts",
    ]);
  });

  it("empty-claude-md has a present destination with zero bytes", async () => {
    const snapshot = await snapshotOf(join(fixtures, "empty-claude-md"));
    expect(snapshot.destination).toMatchObject({ state: "present", bytes: new Uint8Array() });
  });

  it("an empty repository has no files and an absent destination", async () => {
    const snapshot = await snapshotOf(temporaryDirectory());
    expect(snapshot.files).toEqual([]);
    expect(snapshot.destination).toEqual({ state: "absent" });
    expect(snapshot.stability).toEqual({ state: "stable" });
  });

  it("nested-packages reads the nested CLAUDE.md but uses only the root one as destination", async () => {
    const snapshot = await snapshotOf(join(fixtures, "nested-packages"));
    expect(statusOf(snapshot, "packages/api/CLAUDE.md")).toBe("read");
    expect(snapshot.destination).toMatchObject({
      state: "present",
      bytes: new Uint8Array(readFileSync(join(fixtures, "nested-packages/CLAUDE.md"))),
    });
  });

  it("large-and-binary applies the size, NUL, UTF-8 and binary-type rules", async () => {
    const snapshot = await snapshotOf(join(fixtures, "large-and-binary"));
    expect(statusOf(snapshot, "data/at-limit.txt")).toBe("read");
    expect(statusOf(snapshot, "data/over-limit.txt")).toBe("listed_only");
    expect(statusOf(snapshot, "data/has-nul.txt")).toBe("listed_only");
    expect(statusOf(snapshot, "data/latin1.txt")).toBe("listed_only");
    expect(statusOf(snapshot, "assets/logo.png")).toBe("excluded");
  });

  it("secret-names excludes every secret-bearing name except the example files", async () => {
    const snapshot = await snapshotOf(join(fixtures, "secret-names"));
    const notExcluded = snapshot.files.filter((f) => f.status !== "excluded").map((f) => f.path);
    expect(notExcluded).toEqual([".env.example", ".env.sample", "src/config.ts"]);
  });

  it("two captures of the same repository are identical", async () => {
    const root = join(fixtures, "nested-packages");
    expect(await snapshotOf(root)).toEqual(await snapshotOf(root));
  });
});

describe("read-only inspection", () => {
  it("capturing a snapshot changes nothing in the repository, including .git", async () => {
    const root = temporaryDirectory();
    cpSync(join(fixtures, "unusual-markdown"), root, { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    const before = fingerprint(root);
    await snapshotOf(root);
    expect(fingerprint(root)).toEqual(before);
  });
});

describe("symbolic links", () => {
  it("records links inside and outside the root with their targets, and never follows them", async () => {
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "private.md"), "outside the repository\n");
    const root = temporaryDirectory();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/guide.md"), "guide\n");
    symlinkSync("docs/guide.md", join(root, "file-link.md"));
    symlinkSync("docs", join(root, "dir-link"));
    symlinkSync(outside, join(root, "outside-link"));
    symlinkSync(join(outside, "private.md"), join(root, "outside-file.md"));

    const snapshot = await snapshotOf(root);
    expect(snapshot.files).toEqual([
      { path: "dir-link", status: "symlink", target: "docs" },
      { path: "docs/guide.md", status: "read", size: 6, hash: sha256(Buffer.from("guide\n")) },
      { path: "file-link.md", status: "symlink", target: "docs/guide.md" },
      { path: "outside-file.md", status: "symlink", target: join(outside, "private.md") },
      { path: "outside-link", status: "symlink", target: outside },
    ]);
  });

  it("works when the root itself is reached through a symbolic link", async () => {
    const parent = temporaryDirectory();
    symlinkSync(join(fixtures, "no-claude-md"), join(parent, "repo"));
    const snapshot = await snapshotOf(join(parent, "repo"));
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "src/index.ts",
    ]);
  });

  it("refuses to list or read through a directory that is a symbolic link", async () => {
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "private.md"), "outside\n");
    const root = temporaryDirectory();
    symlinkSync(outside, join(root, "linked"));
    const fs = await openRepositoryFs(root);
    expect(await fs.list("linked")).toEqual({ ok: false, reason: "not_regular_file" });
    expect(await fs.read("linked/private.md", 100)).toEqual({
      ok: false,
      reason: "not_regular_file",
    });
  });

  it("read refuses a path that is a symbolic link", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "a.md"), "a");
    symlinkSync("a.md", join(root, "link.md"));
    const fs = await openRepositoryFs(root);
    expect(await fs.read("link.md", 100)).toEqual({ ok: false, reason: "not_regular_file" });
  });
});

describe("special files and failures", () => {
  it("records a named pipe as unreadable without blocking on it", async () => {
    const root = temporaryDirectory();
    execFileSync("mkfifo", [join(root, "pipe")]);
    const snapshot = await snapshotOf(root);
    expect(snapshot.files).toEqual([
      { path: "pipe", status: "unreadable", kind: "other", reason: "not_regular_file" },
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("records a file without read permission", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "locked.txt"), "x");
    chmodSync(join(root, "locked.txt"), 0o000);
    const snapshot = await snapshotOf(root);
    expect(snapshot.readFailures).toEqual([{ path: "locked.txt", reason: "permission_denied" }]);
  });

  it("read returns bytes only up to maxBytes, and always the hash of the whole file", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "a.txt"), "hello");
    const fs = await openRepositoryFs(root);
    const whole = { ok: true, size: 5, hash: sha256(Buffer.from("hello")) };
    expect(await fs.read("a.txt", 5)).toEqual({
      ...whole,
      bytes: new Uint8Array(Buffer.from("hello")),
    });
    expect(await fs.read("a.txt", 4)).toEqual(whole);
  });

  it("rejects a root that is not a directory", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "file"), "x");
    await expect(openRepositoryFs(join(root, "file"))).rejects.toThrow(/not a directory/);
  });

  // macOS (APFS) refuses names that are not valid UTF-8, so this runs on Linux only.
  it.skipIf(process.platform !== "linux")(
    "escapes a file name that is not valid UTF-8",
    async () => {
      const root = temporaryDirectory();
      const file = Buffer.concat([
        Buffer.from(`${root}/bad`),
        Buffer.from([0xff]),
        Buffer.from(".txt"),
      ]);
      writeFileSync(file, "x");
      try {
        const fs = await openRepositoryFs(root);
        expect(await fs.list("")).toEqual({
          ok: true,
          entries: [{ name: "bad\\xff.txt", kind: "file", nameIsUtf8: false }],
        });
      } finally {
        rmSync(file);
      }
    },
  );
});
