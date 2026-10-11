import { type ParsedDestination, parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import type { Hash } from "../hash.js";
import { comparePaths } from "../paths.js";
import type { Clock, IdSource } from "../ports.js";
import { buildExclusionRules, type ExclusionRule, findExclusion } from "./exclusions.js";
import { type GitMetadata, type GitReader, readGitMetadata } from "./git.js";
import type { EntryKind, FailureReason, ReadResult, RepositoryFs } from "./repository-fs.js";

// Snapshot (DM §6.1) with the candidate rules of IMPL §1.4.

export type ListedOnlyReason = "too_large" | "contains_nul" | "not_utf8";

export type SnapshotFile =
  /** A candidate for content inclusion. */
  | { readonly path: string; readonly status: "read"; readonly size: number; readonly hash: Hash }
  /** Hashed but not a candidate. */
  | {
      readonly path: string;
      readonly status: "listed_only";
      readonly size: number;
      readonly hash: Hash;
      readonly reason: ListedOnlyReason;
    }
  /** Matched an exclusion. Never opened. An excluded directory is one entry and is not entered. */
  | {
      readonly path: string;
      readonly status: "excluded";
      readonly kind: EntryKind;
      readonly rule: string;
    }
  /** A symbolic link, recorded with its target and never followed. */
  | { readonly path: string; readonly status: "symlink"; readonly target: string }
  /** Could not be read, or its name is not valid UTF-8; the reason is also in `readFailures`. */
  | {
      readonly path: string;
      readonly status: "unreadable";
      readonly kind: EntryKind;
      readonly reason: ReadFailureReason;
    };

export type ReadFailureReason = FailureReason | "path_not_utf8";

export interface ReadFailure {
  readonly path: string;
  readonly reason: ReadFailureReason;
}

export type Destination =
  | { readonly state: "absent" }
  /** Captured, with its Guidance Blocks (DM §7). */
  | ({
      readonly state: "present";
      readonly bytes: Uint8Array;
      readonly hash: Hash;
    } & ParsedDestination)
  /** A root `CLAUDE.md` exists but can't be captured safely, so the session must stop. */
  | { readonly state: "unavailable"; readonly reason: DestinationUnavailableReason };

export type DestinationUnavailableReason =
  /** The root `CLAUDE.md` is a symbolic link. */
  | "symlink"
  /**
   * It would be `listed_only` under the candidate rules (IMPL §1.4): larger than
   * `maxReadableFileBytes`, containing a NUL byte, or not valid UTF-8.
   */
  | ListedOnlyReason
  /** No `CLAUDE.md`, but a root entry whose name differs only in ASCII case, such as `claude.md`. */
  | "case_variant"
  | FailureReason;

export type Stability =
  | { readonly state: "stable" }
  | { readonly state: "unstable"; readonly changedPaths: readonly string[] };

export interface Snapshot {
  readonly id: string;
  readonly capturedAt: string;
  readonly scope: { readonly roots: readonly string[] };
  readonly exclusions: readonly ExclusionRule[];
  /** Coverage: every path under the scope, sorted bytewise. */
  readonly files: readonly SnapshotFile[];
  readonly destination: Destination;
  readonly readFailures: readonly ReadFailure[];
  readonly stability: Stability;
  /** Supporting metadata only; never a substitute for file hashes. */
  readonly git: GitMetadata;
}

export interface SnapshotSettings {
  /** IMPL §1.4 and §1.14. Default 262,144. */
  readonly maxReadableFileBytes: number;
  /** Patterns added to the default exclusions (grammar in `exclusions.ts`). */
  readonly userExclusions: readonly string[];
  /** The product's session storage, when it is inside the repository (DM §15). */
  readonly sessionStoragePath?: string;
}

export const DEFAULT_SNAPSHOT_SETTINGS: SnapshotSettings = {
  maxReadableFileBytes: 262_144,
  userExclusions: [],
};

export const DESTINATION_PATH = "CLAUDE.md";

export interface SnapshotDeps {
  readonly fs: RepositoryFs;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** Omitted when git isn't inspected; the metadata is then unknown. */
  readonly git?: GitReader;
}

export async function captureSnapshot(
  deps: SnapshotDeps,
  settings: SnapshotSettings,
): Promise<Snapshot> {
  const capturedAt = deps.clock.now().toISOString();
  const id = deps.ids.next("snap");
  const exclusions = buildExclusionRules(settings);

  // Capture is not atomic. Observe twice and compare; if anything differed, retry once.
  let earlier = await observe(deps.fs, exclusions, settings.maxReadableFileBytes);
  let later = await observe(deps.fs, exclusions, settings.maxReadableFileBytes);
  let changedPaths = differences(earlier, later);
  if (changedPaths.length > 0) {
    earlier = await observe(deps.fs, exclusions, settings.maxReadableFileBytes);
    later = await observe(deps.fs, exclusions, settings.maxReadableFileBytes);
    changedPaths = differences(earlier, later);
  }

  const files = [...later.files.values()].sort((a, b) => comparePaths(a.path, b.path));
  return {
    id,
    capturedAt,
    scope: { roots: ["."] },
    exclusions,
    files,
    destination: destinationOf(later),
    readFailures: [...later.failures]
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => comparePaths(a.path, b.path)),
    stability:
      changedPaths.length === 0 ? { state: "stable" } : { state: "unstable", changedPaths },
    git: await readGitMetadata(deps.git, files, deps.fs),
  };
}

/** One pass over the repository. */
interface Observation {
  readonly files: Map<string, SnapshotFile>;
  readonly failures: Map<string, ReadFailureReason>;
  readonly directories: Set<string>;
  destinationBytes?: Uint8Array;
  /** A root entry named like `CLAUDE.md` in another ASCII case. */
  caseVariant?: string;
}

async function observe(
  fs: RepositoryFs,
  rules: readonly ExclusionRule[],
  maxReadableFileBytes: number,
): Promise<Observation> {
  const observation: Observation = {
    files: new Map(),
    failures: new Map(),
    directories: new Set(),
  };
  const unreadable = (path: string, kind: EntryKind, reason: ReadFailureReason) => {
    observation.files.set(path, { path, status: "unreadable", kind, reason });
    observation.failures.set(path, reason);
  };

  const pending = [""];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const listing = await fs.list(directory);
    if (!listing.ok) {
      if (directory === "") throw new Error(`Cannot list the repository root: ${listing.reason}`);
      unreadable(directory, "directory", listing.reason);
      continue;
    }
    for (const entry of listing.entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (!entry.nameIsUtf8) {
        unreadable(path, entry.kind, "path_not_utf8");
        continue;
      }
      if (directory === "" && path !== DESTINATION_PATH && asciiLower(path) === "claude.md") {
        observation.caseVariant = path;
      }
      // The destination is always captured, whatever the exclusions say.
      const rule = path === DESTINATION_PATH ? undefined : findExclusion(rules, path, entry.kind);
      if (rule !== undefined) {
        observation.files.set(path, {
          path,
          status: "excluded",
          kind: entry.kind,
          rule: rule.pattern,
        });
      } else if (entry.kind === "directory") {
        observation.directories.add(path);
        pending.push(path);
      } else if (entry.kind === "symlink") {
        const link = await fs.readLink(path);
        if (!link.ok) unreadable(path, "symlink", link.reason);
        else if (!link.targetIsUtf8) unreadable(path, "symlink", "path_not_utf8");
        else observation.files.set(path, { path, status: "symlink", target: link.target });
      } else if (entry.kind === "other") {
        unreadable(path, "other", "not_regular_file");
      } else {
        const result = await fs.read(path, maxReadableFileBytes);
        if (!result.ok) {
          unreadable(path, "file", result.reason);
          continue;
        }
        if (path === DESTINATION_PATH && result.bytes !== undefined) {
          // A copy, so the record never shares memory with the adapter's buffer.
          observation.destinationBytes = new Uint8Array(result.bytes);
        }
        observation.files.set(path, classify(path, result, maxReadableFileBytes));
      }
    }
  }
  return observation;
}

/** The candidate rules of IMPL §1.4, for a file that is not excluded. */
function classify(
  path: string,
  result: Extract<ReadResult, { ok: true }>,
  maxReadableFileBytes: number,
): SnapshotFile {
  const { size, hash, bytes } = result;
  let reason: ListedOnlyReason | undefined;
  if (size > maxReadableFileBytes || bytes === undefined) reason = "too_large";
  else if (bytes.includes(0)) reason = "contains_nul";
  else if (!isUtf8(bytes)) reason = "not_utf8";
  return reason === undefined
    ? { path, status: "read", size, hash }
    : { path, status: "listed_only", size, hash, reason };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Paths whose entry, read failure or directory differs between two observations, sorted. */
function differences(a: Observation, b: Observation): string[] {
  const changed = new Set<string>();
  const compare = <T>(left: Map<string, T>, right: Map<string, T>) => {
    for (const path of new Set([...left.keys(), ...right.keys()])) {
      if (JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path))) changed.add(path);
    }
  };
  compare(a.files, b.files);
  compare(a.failures, b.failures);
  for (const path of new Set([...a.directories, ...b.directories])) {
    if (a.directories.has(path) !== b.directories.has(path)) changed.add(path);
  }
  return [...changed].sort(comparePaths);
}

function destinationOf(observation: Observation): Destination {
  if (observation.directories.has(DESTINATION_PATH)) {
    return { state: "unavailable", reason: "not_regular_file" };
  }
  const entry = observation.files.get(DESTINATION_PATH);
  if (entry === undefined) {
    return observation.caseVariant === undefined
      ? { state: "absent" }
      : { state: "unavailable", reason: "case_variant" };
  }
  switch (entry.status) {
    case "symlink":
      return { state: "unavailable", reason: "symlink" };
    case "unreadable":
      // A root entry named exactly `CLAUDE.md` always has a valid UTF-8 name.
      return {
        state: "unavailable",
        reason: entry.reason === "path_not_utf8" ? "io_error" : entry.reason,
      };
    case "listed_only":
      return { state: "unavailable", reason: entry.reason };
    case "read":
      return present(observation, entry.hash);
    case "excluded":
      throw new Error("The destination is never excluded.");
  }
}

function present(observation: Observation, hash: Hash): Destination {
  if (observation.destinationBytes === undefined) {
    throw new Error("A readable destination was observed without its bytes.");
  }
  const bytes = observation.destinationBytes;
  return { state: "present", bytes, hash, ...parseGuidanceBlocks(bytes) };
}

/** Lower-cases ASCII letters only, so the result never depends on locale or Unicode tables. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
