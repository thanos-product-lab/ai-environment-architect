import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
  seededShuffle,
} from "../../../test/support/memory-fs.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { buildExclusionRules } from "./exclusions.js";
import {
  captureSnapshot,
  DEFAULT_SNAPSHOT_SETTINGS,
  type Snapshot,
  type SnapshotSettings,
} from "./snapshot.js";

const capture = (fs: MemoryFs, settings: Partial<SnapshotSettings> = {}): Promise<Snapshot> =>
  captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    { ...DEFAULT_SNAPSHOT_SETTINGS, ...settings },
  );

const fileOf = (snapshot: Snapshot, path: string) => snapshot.files.find((f) => f.path === path);

describe("snapshot record (DM §6.1)", () => {
  it("takes its ID and capture time from the injected providers", async () => {
    const snapshot = await capture(new MemoryFs({ "a.txt": "a\n" }));
    expect(snapshot.id).toBe("snap_fixed");
    expect(snapshot.capturedAt).toBe("2026-10-11T09:00:00.000Z");
  });

  it("covers the whole repository root", async () => {
    const snapshot = await capture(new MemoryFs({ "a.txt": "a\n" }));
    expect(snapshot.scope).toEqual({ roots: ["."] });
  });

  it("records the default, user and session storage exclusions", async () => {
    const settings = { userExclusions: ["*.log"], sessionStoragePath: ".sessions" };
    const snapshot = await capture(new MemoryFs({}), settings);
    expect(snapshot.exclusions).toEqual(buildExclusionRules(settings));
  });

  it("sorts paths bytewise by UTF-8, not by UTF-16 code units", async () => {
    // U+FF5A (EF BD 9A) sorts before U+1F600 (F0 9F 98 80) in UTF-8, but after it in UTF-16.
    const fs = new MemoryFs({
      "😀.md": "x",
      "ｚ.md": "x",
      "B.md": "x",
      "a.md": "x",
      "a/b.md": "x",
    });
    const snapshot = await capture(fs);
    expect(snapshot.files.map((f) => f.path)).toEqual(["B.md", "a.md", "a/b.md", "ｚ.md", "😀.md"]);
  });

  it("records a candidate file as read, with its size and hash", async () => {
    const snapshot = await capture(new MemoryFs({ "src/index.ts": "export {};\n" }));
    expect(snapshot.files).toEqual([
      {
        path: "src/index.ts",
        status: "read",
        size: 11,
        hash: sha256(Buffer.from("export {};\n")),
      },
    ]);
  });

  it("an empty repository has no files and an absent destination", async () => {
    const snapshot = await capture(new MemoryFs({}));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.destination).toEqual({ state: "absent" });
    expect(snapshot.stability).toEqual({ state: "stable" });
  });
});

describe("candidate rules (IMPL §1.4)", () => {
  it("a file of exactly maxReadableFileBytes is read; one byte more is listed_only", async () => {
    const fs = new MemoryFs({ "at.txt": "x".repeat(10), "over.txt": "x".repeat(11) });
    const snapshot = await capture(fs, { maxReadableFileBytes: 10 });
    expect(fileOf(snapshot, "at.txt")?.status).toBe("read");
    expect(fileOf(snapshot, "over.txt")).toEqual({
      path: "over.txt",
      status: "listed_only",
      reason: "too_large",
      size: 11,
      hash: sha256(Buffer.from("x".repeat(11))),
    });
  });

  it("a file containing a NUL byte is listed_only", async () => {
    const snapshot = await capture(new MemoryFs({ "a.txt": Buffer.from([0x61, 0x00, 0x0a]) }));
    expect(fileOf(snapshot, "a.txt")).toMatchObject({
      status: "listed_only",
      reason: "contains_nul",
    });
  });

  it("a file that is not valid UTF-8 is listed_only", async () => {
    const snapshot = await capture(new MemoryFs({ "a.txt": Buffer.from([0x63, 0xe9, 0x0a]) }));
    expect(fileOf(snapshot, "a.txt")).toMatchObject({ status: "listed_only", reason: "not_utf8" });
  });

  it("a UTF-8 byte order mark doesn't stop a file being read", async () => {
    const snapshot = await capture(new MemoryFs({ "a.md": Buffer.from([0xef, 0xbb, 0xbf, 0x61]) }));
    expect(fileOf(snapshot, "a.md")?.status).toBe("read");
  });
});

describe("exclusions in the snapshot", () => {
  it("lists an excluded file with its rule, and never opens it", async () => {
    const fs = new MemoryFs({ ".env": "X=1\n", "src/a.ts": "a" });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, ".env")).toEqual({
      path: ".env",
      status: "excluded",
      kind: "file",
      rule: ".env",
    });
    expect(fs.reads).not.toContain(".env");
  });

  it("lists an excluded directory once and never enters it", async () => {
    const fs = new MemoryFs({ "node_modules/x/index.js": "x", "src/a.ts": "a" });
    const snapshot = await capture(fs);
    expect(snapshot.files.map((f) => f.path)).toEqual(["node_modules", "src/a.ts"]);
    expect(fileOf(snapshot, "node_modules")).toMatchObject({
      status: "excluded",
      kind: "directory",
      rule: "node_modules/",
    });
    expect(fs.listings.some((dir) => dir.startsWith("node_modules"))).toBe(false);
  });

  it("does not exclude files because .gitignore lists them", async () => {
    const fs = new MemoryFs({
      ".gitignore": "scratch/\n*.log\n",
      "scratch/a.ts": "a",
      "x.log": "x",
    });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, "scratch/a.ts")?.status).toBe("read");
    expect(fileOf(snapshot, "x.log")?.status).toBe("read");
  });

  it("applies user exclusions", async () => {
    const fs = new MemoryFs({ "debug.log": "x", "a.ts": "a" });
    const snapshot = await capture(fs, { userExclusions: ["*.log"] });
    expect(fileOf(snapshot, "debug.log")).toMatchObject({ status: "excluded", rule: "*.log" });
  });
});

describe("symbolic links and special files", () => {
  it("records a symbolic link with its target and never follows it", async () => {
    const fs = new MemoryFs({
      "docs/guide.md": "g",
      "link.md": { kind: "symlink", target: "docs/guide.md" },
      outside: { kind: "symlink", target: "../../etc" },
    });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, "link.md")).toEqual({
      path: "link.md",
      status: "symlink",
      target: "docs/guide.md",
    });
    expect(fileOf(snapshot, "outside")).toEqual({
      path: "outside",
      status: "symlink",
      target: "../../etc",
    });
    expect(fs.reads).not.toContain("link.md");
    expect(fs.listings).not.toContain("outside");
  });

  it("records a special file as unreadable without opening it", async () => {
    const fs = new MemoryFs({ pipe: { kind: "other" } });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, "pipe")).toEqual({
      path: "pipe",
      status: "unreadable",
      kind: "other",
      reason: "not_regular_file",
    });
    expect(snapshot.readFailures).toEqual([{ path: "pipe", reason: "not_regular_file" }]);
    expect(fs.reads).not.toContain("pipe");
  });
});

describe("read failures", () => {
  it("records a file that can't be read", async () => {
    const fs = new MemoryFs({
      "locked.txt": { kind: "unreadable_file", reason: "permission_denied" },
    });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, "locked.txt")).toEqual({
      path: "locked.txt",
      status: "unreadable",
      kind: "file",
      reason: "permission_denied",
    });
    expect(snapshot.readFailures).toEqual([{ path: "locked.txt", reason: "permission_denied" }]);
  });

  it("records a directory that can't be listed", async () => {
    const fs = new MemoryFs({
      private: { kind: "directory", failure: "permission_denied" },
      "a.ts": "a",
    });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, "private")).toEqual({
      path: "private",
      status: "unreadable",
      kind: "directory",
      reason: "permission_denied",
    });
    expect(snapshot.readFailures).toEqual([{ path: "private", reason: "permission_denied" }]);
  });

  it("keeps a name that is not valid UTF-8 in coverage as unreadable", async () => {
    const fs = new MemoryFs({ "bad\\xff.txt": { kind: "invalid_name" }, "a.ts": "a" });
    const snapshot = await capture(fs);
    expect(fileOf(snapshot, "bad\\xff.txt")).toEqual({
      path: "bad\\xff.txt",
      status: "unreadable",
      kind: "file",
      reason: "path_not_utf8",
    });
    expect(snapshot.readFailures).toEqual([{ path: "bad\\xff.txt", reason: "path_not_utf8" }]);
    expect(fs.reads).not.toContain("bad\\xff.txt");
  });

  it("orders read failures bytewise by path", async () => {
    const fs = new MemoryFs({
      "b.txt": { kind: "unreadable_file", reason: "io_error" },
      "a.txt": { kind: "unreadable_file", reason: "io_error" },
    });
    const snapshot = await capture(fs, {});
    expect(snapshot.readFailures.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("destination (DM §6.1, §7)", () => {
  it("is absent when there is no root CLAUDE.md", async () => {
    const snapshot = await capture(new MemoryFs({ "packages/api/CLAUDE.md": "nested" }));
    expect(snapshot.destination).toEqual({ state: "absent" });
  });

  it("an empty CLAUDE.md is present with zero bytes", async () => {
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": "" }));
    expect(snapshot.destination).toEqual({
      state: "present",
      bytes: new Uint8Array(),
      hash: sha256(new Uint8Array()),
      ...parseGuidanceBlocks(new Uint8Array()),
    });
    expect(snapshot.destination).toMatchObject({ blocks: [], roundTrip: { state: "verified" } });
  });

  it("keeps the original bytes and hash of a present destination", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("# Rules\r\n")]);
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": bytes }));
    expect(snapshot.destination).toEqual({
      state: "present",
      bytes,
      hash: sha256(bytes),
      ...parseGuidanceBlocks(bytes),
    });
    expect(fileOf(snapshot, "CLAUDE.md")?.status).toBe("read");
  });

  it("parses a present destination into Guidance Blocks with its line endings", async () => {
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": "# Rules\r\n\r\n- one\r\n" }));
    expect(snapshot.destination).toMatchObject({
      state: "present",
      lineEndings: { style: "crlf" },
      roundTrip: { state: "verified" },
    });
    const blocks = snapshot.destination.state === "present" ? snapshot.destination.blocks : [];
    expect(blocks.map((b) => b.blockId)).toEqual(["Rules/heading", "Rules/list-item-1"]);
  });

  it("distinguishes absent and empty destinations (DM §17)", async () => {
    const absent = await capture(new MemoryFs({ "README.md": "x" }));
    const empty = await capture(new MemoryFs({ "CLAUDE.md": "" }));
    expect(absent.destination).toEqual({ state: "absent" });
    expect(empty.destination).toMatchObject({ state: "present", blocks: [] });
  });

  it("a destination of blank lines only is present with zero blocks", async () => {
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": "\n  \n\r\n" }));
    expect(snapshot.destination).toMatchObject({
      state: "present",
      blocks: [],
      roundTrip: { state: "verified" },
    });
  });

  it("is unavailable when the destination is larger than maxReadableFileBytes", async () => {
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": "x".repeat(11) }), {
      maxReadableFileBytes: 10,
    });
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "too_large" });
    expect(fileOf(snapshot, "CLAUDE.md")?.status).toBe("listed_only");
  });

  it("is unavailable when the destination is not valid UTF-8", async () => {
    const bytes = new Uint8Array([0x63, 0xe9, 0x0a]);
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": bytes }));
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "not_utf8" });
    expect(fileOf(snapshot, "CLAUDE.md")).toMatchObject({
      status: "listed_only",
      reason: "not_utf8",
    });
  });

  it("is unavailable when the destination contains a NUL byte", async () => {
    const bytes = new Uint8Array([0x23, 0x20, 0x41, 0x00, 0x0a]);
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": bytes }));
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "contains_nul" });
  });

  it("accepts a destination that starts with a UTF-8 byte order mark", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x78]);
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": bytes }));
    expect(snapshot.destination).toMatchObject({ state: "present" });
  });

  it("is unavailable when only a case variant such as claude.md exists at the root", async () => {
    const snapshot = await capture(new MemoryFs({ "claude.md": "# Rules\n" }));
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "case_variant" });
  });

  it("uses CLAUDE.md when a case variant exists beside it", async () => {
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md": "a", "claude.md": "b" }));
    expect(snapshot.destination).toMatchObject({ state: "present" });
  });

  it("is captured even when a user exclusion matches it", async () => {
    const fs = new MemoryFs({ "CLAUDE.md": "# Rules\n", "docs/a.md": "a" });
    const snapshot = await capture(fs, { userExclusions: ["*.md", "CLAUDE.md"] });
    expect(snapshot.destination).toMatchObject({ state: "present" });
    expect(fileOf(snapshot, "docs/a.md")?.status).toBe("excluded");
  });

  it("is unavailable when the root CLAUDE.md is a symbolic link", async () => {
    const fs = new MemoryFs({ "CLAUDE.md": { kind: "symlink", target: "docs/AGENTS.md" } });
    const snapshot = await capture(fs);
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "symlink" });
  });

  it("is unavailable when the root CLAUDE.md is a directory", async () => {
    const snapshot = await capture(new MemoryFs({ "CLAUDE.md/x.md": "x" }));
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "not_regular_file" });
  });

  it("is unavailable when the root CLAUDE.md can't be read", async () => {
    const fs = new MemoryFs({
      "CLAUDE.md": { kind: "unreadable_file", reason: "permission_denied" },
    });
    const snapshot = await capture(fs);
    expect(snapshot.destination).toEqual({ state: "unavailable", reason: "permission_denied" });
  });
});

describe("stability check (DM §6.1)", () => {
  const changing = (contents: (string | undefined)[]): MemoryNode => ({
    kind: "file",
    content: (n) => {
      const text = contents[Math.min(n, contents.length) - 1];
      return text === undefined ? undefined : Buffer.from(text);
    },
  });

  it("a file that changes once during capture is retried and the snapshot is stable", async () => {
    const fs = new MemoryFs({ "a.txt": changing(["old", "new"]) });
    const snapshot = await capture(fs);
    expect(snapshot.stability).toEqual({ state: "stable" });
    expect(fileOf(snapshot, "a.txt")).toMatchObject({ hash: sha256(Buffer.from("new")) });
  });

  it("a file that keeps changing makes the snapshot unstable with its path", async () => {
    const fs = new MemoryFs({
      "a.txt": { kind: "file", content: (n) => Buffer.from(`v${n}`) },
      "b.txt": "steady",
    });
    const snapshot = await capture(fs);
    expect(snapshot.stability).toEqual({ state: "unstable", changedPaths: ["a.txt"] });
    // Four observations; the last one is kept.
    expect(fileOf(snapshot, "a.txt")).toMatchObject({ hash: sha256(Buffer.from("v4")) });
  });

  it("a file that disappears during capture and stays gone leaves a stable snapshot", async () => {
    const fs = new MemoryFs({ "a.txt": "a", "gone.txt": changing(["here", undefined]) });
    const snapshot = await capture(fs);
    expect(snapshot.stability).toEqual({ state: "stable" });
    expect(fileOf(snapshot, "gone.txt")).toMatchObject({
      status: "unreadable",
      reason: "not_found",
    });
  });

  /** Adds `node` at `path` on every second root listing and removes it on the others. */
  const flickering = (path: string, node: MemoryNode): MemoryFs => {
    let listings = 0;
    const fs = new MemoryFs({ "a.txt": "a" });
    const list = fs.list.bind(fs);
    fs.list = async (dir) => {
      if (dir === "") {
        listings += 1;
        if (listings % 2 === 0) fs.nodes.set(path, node);
        else fs.nodes.delete(path);
      }
      return list(dir);
    };
    return fs;
  };

  it("a file that appears between listings and keeps changing is unstable", async () => {
    const snapshot = await capture(flickering("new.txt", "n"));
    expect(snapshot.stability).toEqual({ state: "unstable", changedPaths: ["new.txt"] });
  });

  it("an empty directory that keeps appearing and disappearing is unstable", async () => {
    const snapshot = await capture(flickering("empty", { kind: "directory" }));
    expect(snapshot.stability).toEqual({ state: "unstable", changedPaths: ["empty"] });
  });
});

describe("determinism (IMPL §1.3, §1.15)", () => {
  const tree: Record<string, MemoryNode> = {
    "CLAUDE.md": "# Rules\n",
    "README.md": "readme",
    ".env": "X=1",
    "node_modules/a/index.js": "x",
    "packages/api/src/server.ts": "s",
    "packages/api/test/server.test.ts": "t",
    "packages/web/src/app.ts": "w",
    "packages/web/CLAUDE.md": "nested",
    "assets/logo.png": Buffer.from([0x89, 0x50]),
    link: { kind: "symlink", target: "README.md" },
    "é.md": "e",
  };

  it("enumeration order doesn't change the snapshot", async () => {
    const reference = await capture(new MemoryFs(tree));
    const orders = [
      (names: string[]) => [...names].reverse(),
      ...[1, 2, 3, 4, 5].map((seed) => seededShuffle(seed)),
    ];
    for (const order of orders) {
      expect(await capture(new MemoryFs(tree, { order }))).toEqual(reference);
    }
  });
});
