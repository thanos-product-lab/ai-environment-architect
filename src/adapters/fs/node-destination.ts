import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../core/hash.js";
import type { DestinationFs, DestinationState, WriteResult } from "../../core/session/apply.js";
import { DESTINATION_PATH } from "../../core/snapshot/snapshot.js";

// The root `CLAUDE.md` on disk: the only file apply writes in a target repository (DM §11.2).
//
// - The destination is `CLAUDE.md` directly in the root's real path, so it can't name anything
//   outside the root. Temporary files are single path segments in the same directory.
// - Nothing follows a symbolic link: a link at the destination is reported unavailable, read with
//   O_NOFOLLOW, and a rename replaces the link itself, never what it points to.
// - A temporary file is created exclusively, takes the destination's permissions, and is synced
//   before the rename; the directory is synced after it.
// - Write failures are results, so apply can record them. Anything else is thrown.

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export async function openDestination(root: string): Promise<DestinationFs> {
  const directory = await realpath(root);
  if (!(await lstat(directory)).isDirectory())
    throw new Error(`The repository root is not a directory: ${root}`);
  const destination = join(directory, DESTINATION_PATH);
  const temporary = (name: string) => {
    if (
      name === "" ||
      name === "." ||
      name === ".." ||
      name === DESTINATION_PATH ||
      /[/\\]/.test(name)
    )
      throw new Error(`not a temporary file name beside the destination: ${JSON.stringify(name)}`);
    return join(directory, name);
  };

  return {
    async inspect(): Promise<DestinationState> {
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(destination);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return { state: "absent" };
        return { state: "unavailable", reason: reasonOf(error) };
      }
      if (stats.isSymbolicLink()) return { state: "unavailable", reason: "symlink" };
      if (!stats.isFile()) return { state: "unavailable", reason: "not_regular_file" };
      try {
        const handle = await open(destination, READ_FLAGS);
        try {
          return { state: "present", hash: sha256(await readFile(handle)) };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (hasCode(error, "ENOENT")) return { state: "absent" };
        return { state: "unavailable", reason: reasonOf(error) };
      }
    },

    async writeTemporary(name: string, bytes: Uint8Array): Promise<WriteResult> {
      const path = temporary(name);
      const mode = await modeOf(destination);
      try {
        const handle = await open(path, "wx", mode ?? 0o644);
        try {
          if (mode !== undefined) await handle.chmod(mode);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },

    async replace(name: string): Promise<WriteResult> {
      const path = temporary(name);
      try {
        await rename(path, destination);
        await syncDirectory(directory);
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },

    async remove(name: string): Promise<WriteResult> {
      const path = temporary(name);
      try {
        await rm(path, { force: true });
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

/** The permission bits of a regular file at `path`, or undefined. */
async function modeOf(path: string): Promise<number | undefined> {
  try {
    const stats = await lstat(path);
    return stats.isFile() ? stats.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function failure(error: unknown): WriteResult {
  if (hasCode(error, "EEXIST")) return { ok: false, reason: "exists" };
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM"))
    return { ok: false, reason: "permission_denied" };
  if (hasCode(error, "ENOSPC") || hasCode(error, "EDQUOT"))
    return { ok: false, reason: "no_space" };
  if (error instanceof Error && "code" in error) return { ok: false, reason: "io_error" };
  throw error;
}

function reasonOf(error: unknown): string {
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) return "permission_denied";
  if (hasCode(error, "ELOOP")) return "symlink";
  return "io_error";
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
