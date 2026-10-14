import { createHash } from "node:crypto";
import { comparePaths } from "../paths.js";
import type { RepositoryFs } from "./repository-fs.js";
import type { SnapshotFile } from "./snapshot.js";

// Git metadata for a snapshot (DM §6.1): supporting data only, never a substitute for file
// hashes. Git is read through an injected GitReader; core compares the committed tree with the
// snapshot itself. The one command that looks at the working tree lists ignored entries, before
// capture, so that capture can keep them out of the context and skip ignored directories
// (IMPL §1.4).

export type ObjectFormat = "sha1" | "sha256";

export interface GitTreeEntry {
  /** Repository-relative path. When not valid UTF-8, escaped as in the snapshot. */
  readonly path: string;
  /** Git file mode: `100644`, `100755`, `120000` (symbolic link) or `160000` (submodule). */
  readonly mode: string;
  readonly objectId: string;
  /** Blob size in bytes; null for a submodule. */
  readonly size: number | null;
}

export type GitUnknownReason =
  /** No GitReader was supplied. */
  | "not_inspected"
  | "git_missing"
  /**
   * Older than 2.38 (safe.bareRepository), or older than 2.44, which honours GIT_NO_LAZY_FETCH,
   * in a partial clone, where reading could fetch.
   */
  | "git_too_old"
  | "not_a_repository"
  /** Git refused the repository, for example because of safe.directory ownership checks. */
  | "unsafe_repository"
  | "git_error";

export type GitHead =
  | {
      readonly ok: true;
      readonly objectFormat: ObjectFormat;
      /** Null when the branch has no commits yet. */
      readonly commit: string | null;
      readonly tree: readonly GitTreeEntry[];
    }
  | { readonly ok: false; readonly reason: GitUnknownReason };

export type GitIgnoredList =
  | {
      readonly ok: true;
      /**
       * Untracked paths that the repository's ignore rules match, as git lists them: a directory
       * whose whole content is ignored is one entry ending in `/`.
       */
      readonly paths: readonly string[];
    }
  | { readonly ok: false; readonly reason: GitUnknownReason };

export interface GitReader {
  /** Called before capture. */
  readIgnored(): Promise<GitIgnoredList>;
  /** Called after capture. */
  readHead(): Promise<GitHead>;
}

/** Whether the repository's ignore rules could be read (DM §6.1, IMPL §1.4). */
export type IgnoreRules =
  | { readonly state: "applied" }
  | { readonly state: "not_applied"; readonly reason: GitUnknownReason };

/** Ignored files and wholly ignored directories (without their trailing `/`), from git. */
export interface IgnoredEntries {
  readonly rules: IgnoreRules;
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

/** Lists ignored entries before capture. Never fails: without git, nothing is ignored. */
export async function readIgnoreRules(git: GitReader | undefined): Promise<IgnoredEntries> {
  const none = (reason: GitUnknownReason): IgnoredEntries => ({
    rules: { state: "not_applied", reason },
    files: new Set(),
    directories: new Set(),
  });
  if (git === undefined) return none("not_inspected");
  try {
    const listed = await git.readIgnored();
    if (!listed.ok) return none(listed.reason);
    return {
      rules: { state: "applied" },
      files: new Set(listed.paths.filter((path) => !path.endsWith("/"))),
      directories: new Set(
        listed.paths.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1)),
      ),
    };
  } catch {
    return none("git_error");
  }
}

export type GitMetadata =
  | { readonly state: "unknown"; readonly reason: GitUnknownReason }
  | {
      readonly state: "known";
      readonly objectFormat: ObjectFormat;
      readonly commit: string | null;
      /** Whether the working-tree bytes of compared paths differ from the commit. */
      readonly workingTreeDirty: boolean | "unknown";
      /** Tracked paths whose bytes, or whose kind (file or link), differ. */
      readonly modifiedPaths: readonly string[];
      /** Tracked paths missing from the working tree. */
      readonly deletedPaths: readonly string[];
      /** Paths in the snapshot, neither excluded nor ignored, that the commit doesn't track. */
      readonly untrackedCount: number;
      /** Tracked paths that could not be compared, for example because they were unreadable. */
      readonly uncomparedPaths: readonly string[];
      /** Submodules are listed but not compared. */
      readonly submodules: readonly string[];
    };

/** Git's object ID for a blob with these bytes. */
export function gitBlobId(bytes: Uint8Array, format: ObjectFormat): string {
  return createHash(format === "sha1" ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * Compares the committed tree with the snapshot. `ignored` is git's own list: a file it names is
 * not untracked, as in `git status`, even when `includeIgnored` kept it as a candidate.
 */
export async function readGitMetadata(
  git: GitReader | undefined,
  files: readonly SnapshotFile[],
  fs: RepositoryFs,
  ignored: IgnoredEntries,
): Promise<GitMetadata> {
  if (git === undefined) return { state: "unknown", reason: "not_inspected" };
  try {
    const head = await git.readHead();
    if (!head.ok) return { state: "unknown", reason: head.reason };
    return {
      state: "known",
      objectFormat: head.objectFormat,
      commit: head.commit,
      ...(await compare(head.tree, head.objectFormat, files, fs, ignored)),
    };
  } catch {
    // Supporting data never fails the snapshot.
    return { state: "unknown", reason: "git_error" };
  }
}

const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

async function compare(
  tree: readonly GitTreeEntry[],
  format: ObjectFormat,
  files: readonly SnapshotFile[],
  fs: RepositoryFs,
  ignored: IgnoredEntries,
) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const submodules = tree.filter((e) => e.mode === SUBMODULE_MODE).map((e) => e.path);
  const tracked = new Set(tree.map((e) => e.path));
  const modified: string[] = [];
  const deleted: string[] = [];
  const uncompared = new Set<string>();

  for (const entry of tree) {
    if (entry.mode === SUBMODULE_MODE) continue;
    const file = byPath.get(entry.path);
    if (file === undefined) {
      // Missing, or inside something capture didn't enter.
      const ancestor = nearestAncestor(entry.path, byPath);
      // Capture enters neither excluded nor ignored directories.
      if (ancestor?.status === "excluded" || ancestor?.status === "ignored") continue;
      if (ancestor?.status === "unreadable") uncompared.add(ancestor.path);
      else deleted.push(entry.path);
      continue;
    }
    // Git lists only untracked paths as ignored, so an ignored file is tracked only if it was
    // committed during capture; it is then compared like any other.
    if (file.status === "excluded" || (file.status === "ignored" && file.kind === "directory")) {
      continue;
    }
    switch (file.status) {
      case "unreadable":
        uncompared.add(file.path);
        continue;
      case "symlink":
        if (
          entry.mode !== SYMLINK_MODE ||
          gitBlobId(Buffer.from(file.target, "utf8"), format) !== entry.objectId
        ) {
          modified.push(entry.path);
        }
        continue;
      case "read":
      case "listed_only":
      case "ignored": {
        if (entry.mode === SYMLINK_MODE || entry.size !== file.size) {
          modified.push(entry.path);
          continue;
        }
        // Read again, streaming, to compute the blob ID; it must still be the snapshot's bytes.
        const result = await fs.read(file.path, 0, format);
        if (!result.ok || result.hash !== file.hash || result.gitBlobId === undefined) {
          uncompared.add(file.path);
        } else if (result.gitBlobId !== entry.objectId) {
          modified.push(entry.path);
        }
      }
    }
  }

  let untrackedCount = 0;
  for (const file of files) {
    // As in `git status`, ignored entries are not untracked changes.
    if (file.status === "excluded" || file.status === "ignored" || tracked.has(file.path)) continue;
    if (isListedIgnored(ignored, file.path)) continue;
    if (submodules.some((s) => file.path === s || file.path.startsWith(`${s}/`))) continue;
    if (file.status === "unreadable" && file.kind === "directory") uncompared.add(file.path);
    else untrackedCount += 1;
  }

  const modifiedPaths = modified.sort(comparePaths);
  const deletedPaths = deleted.sort(comparePaths);
  const uncomparedPaths = [...uncompared].sort(comparePaths);
  const differs = modifiedPaths.length > 0 || deletedPaths.length > 0 || untrackedCount > 0;
  return {
    workingTreeDirty: differs ? true : uncomparedPaths.length > 0 ? ("unknown" as const) : false,
    modifiedPaths,
    deletedPaths,
    untrackedCount,
    uncomparedPaths,
    submodules: submodules.sort(comparePaths),
  };
}

/** Whether git listed the path as ignored, itself or through a directory above it. */
function isListedIgnored(ignored: IgnoredEntries, path: string): boolean {
  if (ignored.files.has(path)) return true;
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    if (ignored.directories.has(path.slice(0, end))) return true;
  }
  return false;
}

/** The snapshot entry for the closest enclosing path, if capture recorded one. */
function nearestAncestor(
  path: string,
  byPath: ReadonlyMap<string, SnapshotFile>,
): SnapshotFile | undefined {
  for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
    const entry = byPath.get(path.slice(0, end));
    if (entry !== undefined) return entry;
  }
  return undefined;
}
