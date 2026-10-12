import { comparePaths } from "../paths.js";

// Workspace members and package membership (IMPL §1.5, tier 5).
//
// Members are read from the root package.json `workspaces`, lerna.json `packages`, and the
// `packages:` list in pnpm-workspace.yaml. Other workspace formats, and anything that does not
// parse, contribute nothing, so packages fall back to top-level directories.

export interface WorkspaceSources {
  readonly packageJson?: string;
  readonly lernaJson?: string;
  readonly pnpmWorkspace?: string;
}

/** Member patterns, in source order: package.json, lerna.json, pnpm-workspace.yaml. */
export function workspacePatterns(sources: WorkspaceSources): string[] {
  const packageJson = parseJson(sources.packageJson);
  const workspaces = isObject(packageJson) ? packageJson["workspaces"] : undefined;
  const lerna = parseJson(sources.lernaJson);
  return [
    ...strings(isObject(workspaces) ? workspaces["packages"] : workspaces),
    ...strings(isObject(lerna) ? lerna["packages"] : undefined),
    ...(sources.pnpmWorkspace === undefined ? [] : pnpmPackages(sources.pnpmWorkspace)),
  ];
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** The top-level `packages:` key, as a block list or a one-line flow list. */
function pnpmPackages(yaml: string): string[] {
  const lines = yaml.split(/\r\n|\r|\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const rest = withoutComment((lines[start] ?? "").replace(/^packages\s*:/, "")).trim();
  if (rest.startsWith("[")) {
    if (!rest.endsWith("]")) return [];
    return rest
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter((item) => item !== "");
  }
  if (rest !== "") return [];
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const content = withoutComment(line);
    if (content.trim() === "") continue;
    // Indented, or a compact sequence at column zero.
    const item = /^\s*-\s+(.*)$/.exec(content);
    if (item === null) break;
    const value = unquote((item[1] ?? "").trim());
    if (value !== "") patterns.push(value);
  }
  return patterns;
}

/** Removes a `#` comment that starts the line or follows whitespace, outside quotes. */
function withoutComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquote(value: string): string {
  const first = value[0];
  if ((first === "'" || first === '"') && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The directories matched by `patterns`, minus those matched by a `!` pattern, sorted bytewise.
 * `*` matches within one segment, `**` matches any number of segments.
 */
export function matchWorkspaceMembers(
  patterns: readonly string[],
  directories: readonly string[],
): string[] {
  const include = patterns.filter((p) => !p.startsWith("!")).map(segmentsOf);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => segmentsOf(p.slice(1)));
  return directories
    .filter((directory) => {
      const path = directory === "" ? [] : directory.split("/");
      return (
        include.some((pattern) => matches(pattern, path)) &&
        !exclude.some((pattern) => matches(pattern, path))
      );
    })
    .sort(comparePaths);
}

function segmentsOf(pattern: string): string[] {
  return pattern
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
}

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) {
      if (matches(rest, path.slice(skip))) return true;
    }
    return false;
  }
  const [segment, ...remaining] = path;
  return segment !== undefined && segmentMatches(head, segment) && matches(rest, remaining);
}

function segmentMatches(pattern: string, segment: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === segment;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!segment.startsWith(first) || segment.length < first.length + last.length) return false;
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = segment.indexOf(part, position);
    if (found === -1 || found + part.length > segment.length - last.length) return false;
    position = found + part.length;
  }
  return segment.endsWith(last);
}

/** The deepest package containing `path`, or the root package "". */
export function packageOf(packages: readonly string[], path: string): string {
  let best = "";
  for (const pkg of packages) {
    if (pkg !== "" && path.startsWith(`${pkg}/`) && pkg.length > best.length) best = pkg;
  }
  return best;
}
