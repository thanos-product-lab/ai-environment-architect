import { createHash } from "node:crypto";
import { comparePaths } from "../paths.js";
import type { RepositoryFs } from "./repository-fs.js";
import type { SnapshotFile } from "./snapshot.js";

// Git metadata for a snapshot (DM §6.1): supporting data only, never a substitute for file
// hashes. Git is read through an injected GitReader; core compares the committed tree with the
// snapshot itself, so no git command ever inspects the working tree.

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
  /** Older than the version that honours GIT_NO_LAZY_FETCH, so reading could fetch. */
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

export interface GitReader {
  readHead(): Promise<GitHead>;
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
      /** Paths in the snapshot, not excluded, that the commit doesn't track. */
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

export async function readGitMetadata(
  git: GitReader | undefined,
  files: readonly SnapshotFile[],
  fs: RepositoryFs,
): Promise<GitMetadata> {
  if (git === undefined) return { state: "unknown", reason: "not_inspected" };
  try {
    const head = await git.readHead();
    if (!head.ok) return { state: "unknown", reason: head.reason };
    return {
      state: "known",
      objectFormat: head.objectFormat,
      commit: head.commit,
      ...(await compare(head.tree, head.objectFormat, files, fs)),
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
      if (ancestor?.status === "excluded") continue;
      if (ancestor?.status === "unreadable") uncompared.add(ancestor.path);
      else deleted.push(entry.path);
      continue;
    }
    switch (file.status) {
      case "excluded":
        continue;
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
      case "listed_only": {
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
    if (file.status === "excluded" || tracked.has(file.path)) continue;
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
