import type { Hash } from "../hash.js";
import type { ObjectFormat } from "./git.js";

// Read-only view of one repository, injected into snapshot capture. Paths are repository-relative
// with `/` separators; the root directory is "". Implementations never write and never follow
// symbolic links.

export type EntryKind = "file" | "directory" | "symlink" | "other";

export interface DirectoryEntry {
  /** The entry's name. When the name is not valid UTF-8, a `\xNN`-escaped form. */
  readonly name: string;
  readonly kind: EntryKind;
  readonly nameIsUtf8: boolean;
}

export type FailureReason = "not_found" | "permission_denied" | "not_regular_file" | "io_error";

export type ListResult =
  | { readonly ok: true; readonly entries: readonly DirectoryEntry[] }
  | { readonly ok: false; readonly reason: FailureReason };

export type ReadResult =
  | {
      readonly ok: true;
      readonly size: number;
      readonly hash: Hash;
      /** The full content, present only when `size` is at most the requested `maxBytes`. */
      readonly bytes?: Uint8Array;
      /** Git's blob ID for the content, when an object format was requested. */
      readonly gitBlobId?: string;
    }
  | { readonly ok: false; readonly reason: FailureReason };

export type LinkResult =
  | {
      readonly ok: true;
      /** When not valid UTF-8, a `\xNN`-escaped form. */
      readonly target: string;
      readonly targetIsUtf8: boolean;
    }
  | { readonly ok: false; readonly reason: FailureReason };

export interface RepositoryFs {
  list(directory: string): Promise<ListResult>;
  /**
   * Hashes the whole file, and returns its bytes too when it is at most `maxBytes` long. With an
   * object format, also computes git's blob ID while reading, so large files are never buffered.
   */
  read(path: string, maxBytes: number, gitObjectFormat?: ObjectFormat): Promise<ReadResult>;
  readLink(path: string): Promise<LinkResult>;
}
