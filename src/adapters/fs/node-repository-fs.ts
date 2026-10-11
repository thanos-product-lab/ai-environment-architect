import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hash } from "../../core/hash.js";
import type { ObjectFormat } from "../../core/snapshot/git.js";
import type {
  DirectoryEntry,
  EntryKind,
  FailureReason,
  LinkResult,
  ListResult,
  ReadResult,
  RepositoryFs,
} from "../../core/snapshot/repository-fs.js";

// A read-only RepositoryFs over a local directory. Nothing here writes, takes a lock or runs
// repository code.
//
// Symbolic links are never followed:
// - Files are opened with O_NOFOLLOW, which refuses a link as the last path component, and with
//   O_NONBLOCK, so a named pipe that replaces a file can't block the open.
// - O_NOFOLLOW doesn't cover the directories above the file. After opening, the parent
//   directory's real path must still be the expected path under the root, or nothing is read.
// - A directory is listed only if its real path is the expected path both before and after
//   reading it.
// What remains is a race Node can't close without openat(2): a directory swapped for a link and
// back again between the open and the check. The open would then reach outside the root, but the
// check after the swap back would pass and the file would be read. Repositories under inspection
// are not expected to be attacked while the tool runs.

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHUNK_BYTES = 65_536;

/** A read-only RepositoryFs over a local directory. */
export async function openRepositoryFs(root: string): Promise<RepositoryFs> {
  const realRoot = await realpath(root);
  if (!(await lstat(realRoot)).isDirectory()) {
    throw new Error(`The repository root is not a directory: ${root}`);
  }
  const absolute = (path: string): string => {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`Not a repository-relative path: ${path}`);
    }
    return path === "" ? realRoot : join(realRoot, path);
  };

  return {
    async list(directory: string): Promise<ListResult> {
      const path = absolute(directory);
      try {
        if ((await realpath(path)) !== path) return { ok: false, reason: "not_regular_file" };
        const entries = await readdir(path, { withFileTypes: true, encoding: "buffer" });
        if ((await realpath(path)) !== path) return { ok: false, reason: "not_regular_file" };
        return { ok: true, entries: entries.map(toEntry) };
      } catch (error) {
        return { ok: false, reason: failureReason(error) };
      }
    },

    async read(
      path: string,
      maxBytes: number,
      gitObjectFormat?: ObjectFormat,
    ): Promise<ReadResult> {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const file = absolute(path);
        handle = await open(file, READ_FLAGS);
        if ((await realpath(dirname(file))) !== dirname(file)) {
          return { ok: false, reason: "not_regular_file" };
        }
        const stat = await handle.stat();
        if (!stat.isFile()) return { ok: false, reason: "not_regular_file" };
        const hash = createHash("sha256");
        // Git's header needs the size up front; if the file changes size while being read, the
        // blob ID is dropped below and the caller can't use it.
        const blob = gitObjectFormat === undefined ? undefined : createHash(gitObjectFormat);
        blob?.update(`blob ${stat.size}\0`);
        const chunks: Buffer[] = [];
        let size = 0;
        const buffer = Buffer.alloc(CHUNK_BYTES);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          blob?.update(chunk);
          size += bytesRead;
          if (size <= maxBytes) chunks.push(Buffer.from(chunk));
          else chunks.length = 0;
        }
        const blobId = blob !== undefined && size === stat.size ? blob.digest("hex") : undefined;
        const result = {
          ok: true as const,
          size,
          hash: `sha256:${hash.digest("hex")}` as Hash,
          ...(blobId === undefined ? {} : { gitBlobId: blobId }),
        };
        return size <= maxBytes
          ? { ...result, bytes: new Uint8Array(Buffer.concat(chunks)) }
          : result;
      } catch (error) {
        return { ok: false, reason: failureReason(error) };
      } finally {
        await handle?.close();
      }
    },

    async readLink(path: string): Promise<LinkResult> {
      try {
        const { name, isUtf8 } = decodeName(await readlink(absolute(path), "buffer"));
        return { ok: true, target: name, targetIsUtf8: isUtf8 };
      } catch (error) {
        return { ok: false, reason: failureReason(error) };
      }
    },
  };
}

function toEntry(dirent: Dirent<Buffer>): DirectoryEntry {
  let kind: EntryKind = "other";
  if (dirent.isSymbolicLink()) kind = "symlink";
  else if (dirent.isDirectory()) kind = "directory";
  else if (dirent.isFile()) kind = "file";
  const { name, isUtf8 } = decodeName(dirent.name);
  return { name, kind, nameIsUtf8: isUtf8 };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decodes a name as UTF-8, or escapes every byte outside printable ASCII (and `\`) as `\xNN`.
 * A valid name that literally contains text such as `\xff` is left as it is, so it could equal
 * the escaped form of a different name. Both are rare, and such a pair only ever makes a
 * comparison uncompared or unreadable, never silently equal content.
 */
export function decodeName(bytes: Buffer): { name: string; isUtf8: boolean } {
  try {
    return { name: strictUtf8.decode(bytes), isUtf8: true };
  } catch {
    let name = "";
    for (const byte of bytes) {
      name +=
        byte >= 0x20 && byte < 0x7f && byte !== 0x5c
          ? String.fromCharCode(byte)
          : `\\x${byte.toString(16).padStart(2, "0")}`;
    }
    return { name, isUtf8: false };
  }
}

function failureReason(error: unknown): FailureReason {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "ELOOP":
    case "EISDIR":
    case "ENXIO":
      return "not_regular_file";
    default:
      return "io_error";
  }
}
