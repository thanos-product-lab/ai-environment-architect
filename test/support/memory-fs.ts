import { sha256 } from "../../src/core/hash.js";
import { gitBlobId, type ObjectFormat } from "../../src/core/snapshot/git.js";
import type {
  DirectoryEntry,
  FailureReason,
  LinkResult,
  ListResult,
  ReadResult,
  RepositoryFs,
} from "../../src/core/snapshot/repository-fs.js";

// An in-memory RepositoryFs for core tests. Parent directories are implied by their children.

export type MemoryNode =
  | string
  | Uint8Array
  | { readonly kind: "file"; readonly content: (readCount: number) => Uint8Array | undefined }
  | { readonly kind: "unreadable_file"; readonly reason: FailureReason }
  | { readonly kind: "directory"; readonly failure?: FailureReason }
  | { readonly kind: "symlink"; readonly target: string; readonly targetIsUtf8?: boolean }
  | { readonly kind: "other" }
  | { readonly kind: "invalid_name" };

export interface MemoryFsOptions {
  /** Reorders each directory listing, to show that results don't depend on enumeration order. */
  readonly order?: (names: string[]) => string[];
}

export class MemoryFs implements RepositoryFs {
  readonly reads: string[] = [];
  readonly listings: string[] = [];
  readonly nodes: Map<string, MemoryNode>;
  private readonly readCounts = new Map<string, number>();
  private readonly order: (names: string[]) => string[];

  constructor(nodes: Record<string, MemoryNode>, options: MemoryFsOptions = {}) {
    this.nodes = new Map(Object.entries(nodes));
    this.order = options.order ?? ((names) => names);
  }

  async list(directory: string): Promise<ListResult> {
    this.listings.push(directory);
    const node = this.nodes.get(directory);
    if (node !== undefined && typeof node === "object" && "kind" in node) {
      if (node.kind === "directory" && node.failure !== undefined) {
        return { ok: false, reason: node.failure };
      }
    }
    const prefix = directory === "" ? "" : `${directory}/`;
    const children = new Map<string, DirectoryEntry>();
    for (const [path, child] of this.nodes) {
      if (!path.startsWith(prefix) || path === directory) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (slash !== -1) {
        children.set(name, { name, kind: "directory", nameIsUtf8: true });
      } else if (!children.has(name)) {
        children.set(name, entryFor(name, child));
      }
    }
    const ordered = this.order([...children.keys()]);
    return { ok: true, entries: ordered.map((name) => children.get(name) as DirectoryEntry) };
  }

  async read(path: string, maxBytes: number, gitObjectFormat?: ObjectFormat): Promise<ReadResult> {
    this.reads.push(path);
    const count = (this.readCounts.get(path) ?? 0) + 1;
    this.readCounts.set(path, count);
    const node = this.nodes.get(path);
    if (node === undefined) return { ok: false, reason: "not_found" };
    let bytes: Uint8Array | undefined;
    if (typeof node === "string") bytes = Buffer.from(node, "utf8");
    else if (node instanceof Uint8Array) bytes = node;
    else if (node.kind === "file") bytes = node.content(count);
    else if (node.kind === "unreadable_file") return { ok: false, reason: node.reason };
    else return { ok: false, reason: "not_regular_file" };
    if (bytes === undefined) return { ok: false, reason: "not_found" };
    const result = {
      ok: true as const,
      size: bytes.length,
      hash: sha256(bytes),
      ...(gitObjectFormat === undefined ? {} : { gitBlobId: gitBlobId(bytes, gitObjectFormat) }),
    };
    return bytes.length <= maxBytes ? { ...result, bytes } : result;
  }

  async readLink(path: string): Promise<LinkResult> {
    const node = this.nodes.get(path);
    if (
      node !== undefined &&
      typeof node === "object" &&
      "kind" in node &&
      node.kind === "symlink"
    ) {
      return { ok: true, target: node.target, targetIsUtf8: node.targetIsUtf8 ?? true };
    }
    return { ok: false, reason: "not_found" };
  }
}

function entryFor(name: string, node: MemoryNode): DirectoryEntry {
  if (typeof node === "string" || node instanceof Uint8Array) {
    return { name, kind: "file", nameIsUtf8: true };
  }
  switch (node.kind) {
    case "file":
    case "unreadable_file":
      return { name, kind: "file", nameIsUtf8: true };
    case "directory":
      return { name, kind: "directory", nameIsUtf8: true };
    case "symlink":
      return { name, kind: "symlink", nameIsUtf8: true };
    case "other":
      return { name, kind: "other", nameIsUtf8: true };
    case "invalid_name":
      return { name, kind: "file", nameIsUtf8: false };
  }
}

/** A deterministic shuffle for enumeration-order tests (a small linear congruential generator). */
export function seededShuffle(seed: number): (names: string[]) => string[] {
  return (names) => {
    const result = [...names];
    let state = seed >>> 0;
    for (let i = result.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const j = state % (i + 1);
      [result[i], result[j]] = [result[j] as string, result[i] as string];
    }
    return result;
  };
}

export const fixedClock = { now: () => new Date("2026-10-11T09:00:00.000Z") };

export const fixedIds = { next: (prefix: string) => `${prefix}_fixed` };
