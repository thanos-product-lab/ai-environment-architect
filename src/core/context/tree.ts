import { comparePaths } from "../paths.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { escapeDelimiters } from "./escape.js";
import { isWithheldPath, scanText } from "./secrets.js";

// Tier 4, the directory tree (IMPL §1.6).
//
// The tree renders the entire snapshot file list, so the model knows what exists that it has not
// read. One line per entry, indented two spaces per level, siblings in bytewise name order.
// Directories end in `/`; files carry a marker. If the tree exceeds its cap, the depth is reduced
// by one until it fits.

export interface TreeSettings {
  readonly treeDepth: number;
  readonly treeCollapseThreshold: number;
}

/** Content markers from the final selection. Readable files with none are `[-]`, not sent. */
export type ContentMark = "R" | "E" | "S";

export interface RenderedTree {
  readonly text: string;
  /** UTF-8 bytes of `text`. */
  readonly bytes: number;
  /** The depth rendered: 0 when even depth 1 did not fit and only a summary is shown. */
  readonly depth: number;
}

export const WITHHELD_NAME = "<withheld>";

interface Node {
  /** The repository-relative path to this node. */
  readonly path: string;
  readonly name: string;
  readonly children: Map<string, Node>;
  entry?: SnapshotFile;
}

export function renderTree(
  files: readonly SnapshotFile[],
  marks: ReadonlyMap<string, ContentMark>,
  settings: TreeSettings,
  capBytes: number,
): RenderedTree {
  const root: Node = { path: "", name: "", children: new Map() };
  const withheld = withheldSegments(files);
  for (const file of files) {
    let node = root;
    for (const segment of file.path.split("/")) {
      let child = node.children.get(segment);
      if (child === undefined) {
        const path = node.path === "" ? segment : `${node.path}/${segment}`;
        child = { path, name: segment, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.entry = file;
  }
  const fileCount = files.filter((file) => !isDirectory(file)).length;
  const finish = (depth: number, body: string): RenderedTree => {
    const text = `<<<TREE depth=${depth} files=${fileCount}>>>\n${body}<<<END TREE>>>\n`;
    return { text, bytes: Buffer.byteLength(text, "utf8"), depth };
  };

  for (let depth = settings.treeDepth; depth >= 1; depth--) {
    const lines: string[] = [];
    renderChildren(root, 1, depth, settings.treeCollapseThreshold, marks, withheld, lines);
    const tree = finish(depth, lines.join(""));
    if (tree.bytes <= capBytes) return tree;
  }
  // The smallest form, used even if a very small cap can't hold it.
  return finish(0, `… ${root.children.size} more\n`);
}

function renderChildren(
  node: Node,
  level: number,
  depth: number,
  threshold: number,
  marks: ReadonlyMap<string, ContentMark>,
  withheld: ReadonlySet<string>,
  out: string[],
): void {
  const children = [...node.children.values()].sort((a, b) => comparePaths(a.name, b.name));
  const indent = "  ".repeat(level - 1);
  for (const child of children.slice(0, threshold)) {
    renderNode(child, level, depth, threshold, marks, withheld, out);
  }
  if (children.length > threshold) out.push(`${indent}… ${children.length - threshold} more\n`);
}

function renderNode(
  node: Node,
  level: number,
  depth: number,
  threshold: number,
  marks: ReadonlyMap<string, ContentMark>,
  withheld: ReadonlySet<string>,
  out: string[],
): void {
  const indent = "  ".repeat(level - 1);
  const name = withheld.has(node.path) ? WITHHELD_NAME : displayName(node.name);
  const entry = node.entry;
  if (entry === undefined) {
    if (level >= depth) {
      out.push(`${indent}${name}/ (${countFiles(node)} files)\n`);
    } else {
      out.push(`${indent}${name}/\n`);
      renderChildren(node, level + 1, depth, threshold, marks, withheld, out);
    }
    return;
  }
  switch (entry.status) {
    case "excluded":
      out.push(
        entry.kind === "directory" ? `${indent}${name}/ [excluded]\n` : `${indent}[X] ${name}\n`,
      );
      return;
    case "unreadable":
      out.push(`${indent}[U] ${name}${entry.kind === "directory" ? "/" : ""}\n`);
      return;
    case "symlink":
      out.push(`${indent}[>] ${name} -> ${displayName(entry.target)}\n`);
      return;
    case "listed_only":
      out.push(`${indent}[${isWithheldPath(entry.path) ? "S" : "L"}] ${name}\n`);
      return;
    case "read": {
      const mark = isWithheldPath(entry.path) ? "S" : (marks.get(entry.path) ?? "-");
      out.push(`${indent}[${mark}] ${name}\n`);
      return;
    }
  }
}

/**
 * Paths of the nodes whose names are withheld because an entry's full path matches the secret
 * scan. A match can span several segments, such as `token=abc/def…`, so every segment it may
 * cover is withheld: from the last segment whose suffix of the path still matches to the first
 * segment whose prefix matches, or every segment if those don't overlap.
 */
function withheldSegments(files: readonly SnapshotFile[]): Set<string> {
  const withheld = new Set<string>();
  for (const file of files) {
    if (!isWithheldPath(file.path)) continue;
    const segments = file.path.split("/");
    let first = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (isWithheldPath(segments.slice(i).join("/"))) {
        first = i;
        break;
      }
    }
    let last = segments.length - 1;
    for (let j = 0; j < segments.length; j++) {
      if (isWithheldPath(segments.slice(0, j + 1).join("/"))) {
        last = j;
        break;
      }
    }
    if (first > last) [first, last] = [0, segments.length - 1];
    for (let k = first; k <= last; k++) withheld.add(segments.slice(0, k + 1).join("/"));
  }
  return withheld;
}

function isDirectory(file: SnapshotFile): boolean {
  return (file.status === "excluded" || file.status === "unreadable") && file.kind === "directory";
}

function countFiles(node: Node): number {
  let count = node.entry !== undefined && !isDirectory(node.entry) ? 1 : 0;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}

/** C0, DEL and C1 controls, and the Unicode line and paragraph separators. */
function hasControl(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/** A name that matches the secret scan is withheld; one with control characters is a JSON string. */
function displayName(name: string): string {
  if (scanText(name) !== undefined) return WITHHELD_NAME;
  return escapeDelimiters(hasControl(name) ? JSON.stringify(name) : name);
}
