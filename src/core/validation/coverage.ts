import { isWithheldPath, pathHash, type RecordedPath } from "../context/secrets.js";
import type { SelectionGap } from "../context/tiers.js";
import { couldMatchBelow, matchSegments } from "../glob.js";
import { comparePaths, normalisePath } from "../paths.js";
import type { ExclusionRule } from "../snapshot/exclusions.js";
import type { IgnoreRules } from "../snapshot/git.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot.js";
import type { SentRun } from "./citations.js";
import { accept, type ItemCheck, reject } from "./pipeline.js";

// Coverage-aware validation (IMPL §1.11). Paths and globs in model output are resolved against
// the full snapshot file list, so a gap about content that was never sent is labelled "not
// inspected", and an absence claim says only what the file list can show.
//
// Path fields are normalised as path tokens in text are (`normalisePath`): one leading `./` and
// one trailing `/` removed, and a path with a `..` segment names nothing.

/** A gap's coverage (DM §6.3), set by code. Recorded paths are withheld ones by hash. */
export type GapCoverage =
  | { readonly state: "inspected" }
  | {
      readonly state: "not_inspected";
      /** Matched entries that weren't sent in full. */
      readonly entries: readonly RecordedPath[];
      /**
       * Directories capture didn't enter that a related path names explicitly, or could only
       * reach when they are unreadable, symbolic links or user exclusions (IMPL §1.11).
       */
      readonly directories: readonly RecordedPath[];
    };

export type PathClass = "listed" | "uncovered" | "unlisted";

/** A directory capture didn't enter: excluded, wholly ignored, unreadable, or a symbolic link. */
interface Unentered {
  readonly path: string;
  readonly segments: readonly string[];
  readonly withheld: boolean;
  /** How the absence wording names it, such as "`node_modules/` (excluded)". */
  readonly label: string;
  /**
   * Whether a gap that could only reach it is relabelled: unreadable entries, symbolic links and
   * user exclusions hide project content; default exclusions and ignored directories don't.
   */
  readonly countsWhenReached: boolean;
}

export interface CoverageIndex {
  /** Every entry path, any status, in bytewise order. */
  readonly entries: readonly SnapshotFile[];
  /** Entries and the directories that contain them, in bytewise order. */
  readonly listed: readonly string[];
  readonly unentered: readonly Unentered[];
  /** Paths whose sent lines, over all items of the call, cover every line. */
  readonly sentInFull: ReadonlySet<string>;
  readonly ignoreRules: IgnoreRules;
}

export interface CoverageContext {
  readonly coverage: CoverageIndex;
}

/** What one call sent of a file: an item's sent runs. Initial and expansion items alike. */
export interface SentFile {
  readonly path: string;
  readonly totalLines: number;
  readonly sent: readonly SentRun[];
}

export function coverageIndex(
  snapshot: Pick<Snapshot, "files" | "exclusions" | "ignoreRules">,
  sent: Iterable<SentFile>,
): CoverageIndex {
  const { files, exclusions, ignoreRules } = snapshot;
  const entries = [...files].sort((a, b) => comparePaths(a.path, b.path));
  const userPatterns = userExclusionPatterns(exclusions);
  const listed = new Set<string>();
  for (const { path } of entries) {
    const segments = path.split("/");
    for (let end = 1; end <= segments.length; end++) listed.add(segments.slice(0, end).join("/"));
  }
  const unentered = entries.flatMap((file): Unentered[] => {
    const label = unenteredLabel(file);
    if (label === undefined) return [];
    return [
      {
        path: file.path,
        segments: file.path.split("/"),
        withheld: isWithheldPath(file.path),
        label,
        countsWhenReached:
          file.status === "unreadable" ||
          file.status === "symlink" ||
          (file.status === "excluded" && userPatterns.has(file.rule)),
      },
    ];
  });
  return {
    entries,
    listed: [...listed].sort(comparePaths),
    unentered,
    sentInFull: sentInFull(sent),
    ignoreRules,
  };
}

/**
 * Patterns whose first rule, in rule order, is a user exclusion. An excluded entry records the
 * pattern of the first rule that matched it, so a pattern a default rule also has is a default.
 */
function userExclusionPatterns(rules: readonly ExclusionRule[]): ReadonlySet<string> {
  const sources = new Map<string, ExclusionRule["source"]>();
  for (const rule of rules) if (!sources.has(rule.pattern)) sources.set(rule.pattern, rule.source);
  return new Set(
    [...sources].filter(([, source]) => source === "user").map(([pattern]) => pattern),
  );
}

function unenteredLabel(file: SnapshotFile): string | undefined {
  if (file.status === "symlink") {
    const target = isWithheldPath(file.target) ? "<withheld>" : file.target;
    return `\`${file.path} -> ${target}\` (symbolic link)`;
  }
  if (file.status === "excluded" || file.status === "ignored" || file.status === "unreadable") {
    if (file.kind === "directory") return `\`${file.path}/\` (${file.status})`;
    if (file.kind === "symlink") return `\`${file.path}\` (${file.status})`;
  }
  return undefined;
}

function sentInFull(sent: Iterable<SentFile>): ReadonlySet<string> {
  const lines = new Map<string, { total: number; covered: Set<number> }>();
  for (const item of sent) {
    const file = lines.get(item.path) ?? { total: item.totalLines, covered: new Set<number>() };
    // Items of one snapshot are cut from the same text, so a mismatch is a bug upstream.
    if (file.total !== item.totalLines)
      throw new Error(`items of one file disagree on its line count: ${item.path}`);
    for (const run of item.sent)
      for (let line = run.first; line < run.first + run.lines.length; line++)
        file.covered.add(line);
    lines.set(item.path, file);
  }
  const full = new Set<string>();
  for (const [path, { total, covered }] of lines) {
    let complete = true;
    for (let line = 1; line <= total && complete; line++) complete = covered.has(line);
    if (complete) full.add(path);
  }
  return full;
}

/** A path field's segments after normalisation, or undefined when it names nothing. */
function patternOf(path: string): string[] | undefined {
  return normalisePath(path)?.split("/");
}

/** Whether a path field matches an entry or directory path (IMPL §1.11). */
export function globMatches(glob: string, path: string): boolean {
  const pattern = patternOf(glob);
  return pattern !== undefined && matchSegments(pattern, path.split("/"));
}

/** Whether some path under `directory` could match the glob (IMPL §1.11). */
export function couldMatchInside(glob: string, directory: string): boolean {
  const pattern = patternOf(glob);
  return pattern !== undefined && couldMatchBelow(pattern, directory.split("/"));
}

/**
 * The entries a pattern matches: those it matches directly, and everything under a directory it
 * matches, whether named literally or matched by a glob.
 */
function matchedEntries(pattern: readonly string[], index: CoverageIndex): SnapshotFile[] {
  return index.entries.filter((file) => {
    const segments = file.path.split("/");
    for (let end = 1; end <= segments.length; end++)
      if (matchSegments(pattern, segments.slice(0, end))) return true;
    return false;
  });
}

function reachedDirectories(pattern: readonly string[], index: CoverageIndex): Unentered[] {
  return index.unentered.filter((directory) => couldMatchBelow(pattern, directory.segments));
}

/**
 * Whether the pattern points at the directory explicitly: its leading wildcard-free segments
 * name the directory or a path below it. `node_modules/x.js` does; a glob that starts with
 * `**` only could.
 */
function namesExplicitly(pattern: readonly string[], directory: Unentered): boolean {
  const literal = pattern.slice(0, firstWildcard(pattern));
  return (
    literal.length >= directory.segments.length &&
    directory.segments.every((segment, i) => literal[i] === segment)
  );
}

export function resolvePath(glob: string, index: CoverageIndex): PathClass {
  const pattern = patternOf(glob);
  if (pattern === undefined) return "unlisted";
  if (matchedEntries(pattern, index).length > 0) return "listed";
  return reachedDirectories(pattern, index).length > 0 ? "uncovered" : "unlisted";
}

export type CoverageFailure = {
  readonly ok: false;
  readonly rule: string;
  readonly detail: string;
};

/**
 * SCOPE-001: each scope path matches a listed path that is not withheld. The model never saw a
 * withheld name, so it can't scope a finding to one (IMPL §1.11).
 */
export function checkScopePaths(
  paths: readonly string[],
  index: CoverageIndex,
): { readonly ok: true } | CoverageFailure {
  const position = paths.findIndex((path) => {
    const pattern = patternOf(path);
    if (pattern === undefined) return true;
    return !index.listed.some(
      (listed) => !isWithheldPath(listed) && matchSegments(pattern, listed.split("/")),
    );
  });
  if (position === -1) return { ok: true };
  return { ok: false, rule: "SCOPE-001", detail: `scope path ${position} is not a listed path` };
}

/**
 * GAP-001, then the coverage check behind GAP-002: a gap stays inspected only if every file its
 * related paths match was sent in full, and no related path names a directory capture didn't
 * enter, or could reach one that hides project content (unreadable, a symbolic link, or a user
 * exclusion).
 */
export function checkGap(
  relatedPaths: readonly string[],
  index: CoverageIndex,
): { readonly ok: true; readonly coverage: GapCoverage } | CoverageFailure {
  const position = relatedPaths.findIndex((path) => resolvePath(path, index) === "unlisted");
  if (position !== -1)
    return {
      ok: false,
      rule: "GAP-001",
      detail: `related path ${position} is neither listed nor under a directory capture didn't enter`,
    };
  const entries = new Set<string>();
  const directories = new Set<string>();
  const unentered = new Map(index.unentered.map((directory) => [directory.path, directory]));
  for (const path of relatedPaths) {
    // GAP-001 passed, so every related path names something.
    const pattern = patternOf(path) ?? [];
    const counts = (directory: Unentered) =>
      directory.countsWhenReached || namesExplicitly(pattern, directory);
    // A directory capture didn't enter is recorded once, as a directory, however it is reached.
    for (const file of matchedEntries(pattern, index)) {
      const directory = unentered.get(file.path);
      if (directory !== undefined) {
        if (counts(directory)) directories.add(file.path);
      } else if (!index.sentInFull.has(file.path)) entries.add(file.path);
    }
    for (const directory of reachedDirectories(pattern, index))
      if (counts(directory)) directories.add(directory.path);
  }
  if (entries.size === 0 && directories.size === 0)
    return { ok: true, coverage: { state: "inspected" } };
  return {
    ok: true,
    coverage: {
      state: "not_inspected",
      entries: recorded(entries),
      directories: recorded(directories),
    },
  };
}

function recorded(paths: Iterable<string>): RecordedPath[] {
  return [...paths]
    .sort(comparePaths)
    .map((path) => (isWithheldPath(path) ? { pathHash: pathHash(path) } : { path }));
}

/**
 * The deterministic gaps of IMPL §1.5 are about files that were never read, so they are
 * `not_inspected` from the start, with their related paths.
 */
export function deterministicGapCoverage(gap: SelectionGap): GapCoverage {
  return {
    state: "not_inspected",
    entries: [
      ...recorded(gap.relatedPaths),
      ...[...(gap.relatedPathHashes ?? [])].sort(comparePaths).map((hash) => ({ pathHash: hash })),
    ],
    directories: [],
  };
}

/**
 * ABS-003: the glob is copied into the claim's statement, so it may not hold text that could
 * read as more than a glob: a backtick would close the code span around it.
 */
const NOT_A_GLOB = /[`\p{White_Space}\p{Cc}\p{Cf}]/u;

const IGNORE_RULES_NOT_APPLIED =
  "Ignore rules were not applied, so ignored files could not be identified.";

/**
 * ABS-003, then ABS-001 and ABS-002 against the full file list. An accepted claim gets a
 * statement written by code, never by the model, naming the unentered directories the glob could
 * reach. It quotes the glob as the model wrote it.
 */
export function checkAbsenceClaim(
  pathGlob: string,
  index: CoverageIndex,
): { readonly ok: true; readonly statement: string } | CoverageFailure {
  if (NOT_A_GLOB.test(pathGlob))
    return {
      ok: false,
      rule: "ABS-003",
      detail: "the glob holds a backtick, whitespace, or a control or format character",
    };
  const pattern = patternOf(pathGlob);
  if (pattern === undefined)
    return { ok: false, rule: "ABS-003", detail: "the glob holds a .. segment" };
  const matched = matchedEntries(pattern, index);
  if (matched.length > 0) {
    const shown = matched.find((file) => !isWithheldPath(file.path));
    return {
      ok: false,
      rule: "ABS-001",
      detail:
        shown === undefined
          ? "a withheld entry matches the glob"
          : `\`${shown.path}\` (${shown.status}) matches the glob`,
    };
  }

  // Only `*` and `**` exist, so a glob can match only inside a directory exactly when it names
  // that directory explicitly and has segments beyond it.
  const confined = index.unentered.find(
    (directory) =>
      pattern.length > directory.segments.length && namesExplicitly(pattern, directory),
  );
  if (confined !== undefined)
    return {
      ok: false,
      rule: "ABS-002",
      detail: `the glob can match only inside ${confined.withheld ? "a withheld directory" : confined.label}`,
    };

  // The wording names every directory the glob could reach, whatever kind it is.
  const reached = reachedDirectories(pattern, index);
  const named = reached.filter((directory) => !directory.withheld).map((d) => d.label);
  const withheld = reached.length - named.length;
  const parts = [`No files matched \`${pathGlob}\` within the inspected scope.`];
  if (reached.length > 0) {
    const count =
      withheld === 0
        ? []
        : [`${withheld} withheld ${withheld === 1 ? "directory" : "directories"}`];
    const listing =
      named.length > 0 && count.length > 0
        ? `${named.join(", ")} and ${count[0]}`
        : [...named, ...count].join("");
    parts.push(`Not inspected: ${listing}.`);
  }
  if (index.ignoreRules.state === "not_applied") parts.push(IGNORE_RULES_NOT_APPLIED);
  return { ok: true, statement: parts.join(" ") };
}

function firstWildcard(pattern: readonly string[]): number {
  const at = pattern.findIndex((segment) => segment.includes("*"));
  return at === -1 ? pattern.length : at;
}

type Scope =
  | { readonly kind: "repository" }
  | { readonly kind: "paths"; readonly paths: readonly string[] };

/** SCOPE-001 as an item check (IMPL §3.3.2 step 4). */
export function scopeCheck<
  V extends { readonly scope: Scope },
  C extends CoverageContext,
>(): ItemCheck<V, C> {
  return (value, context) => {
    if (value.scope.kind === "repository") return accept(value);
    const result = checkScopePaths(value.scope.paths, context.coverage);
    return result.ok ? accept(value) : reject(result.rule, result.detail);
  };
}

/** GAP-001 and GAP-002 as an item check (IMPL §3.3.2 step 5). Sets the gap's coverage. */
export function gapCheck<
  V extends { readonly relatedPaths: readonly string[]; readonly coverage?: GapCoverage },
  C extends CoverageContext,
>(): ItemCheck<V, C> {
  return (value, context) => {
    const result = checkGap(value.relatedPaths, context.coverage);
    if (!result.ok) return reject(result.rule, result.detail);
    const gap = { ...value, coverage: result.coverage };
    if (result.coverage.state === "inspected") return accept(gap);
    const entries = result.coverage.entries.length;
    const directories = result.coverage.directories.length;
    return accept(gap, {
      rule: "GAP-002",
      outcome: "relabelled",
      detail:
        `not inspected: ${entries} ${entries === 1 ? "entry" : "entries"} not sent in full, ` +
        `${directories} ${directories === 1 ? "directory" : "directories"} not entered`,
    });
  };
}

/** ABS-003, ABS-001 and ABS-002 as an item check (IMPL §3.3.2 step 6). Sets the claim's statement. */
export function absenceClaimCheck<
  V extends { readonly pathGlob: string; readonly statement?: string },
  C extends CoverageContext,
>(): ItemCheck<V, C> {
  return (value, context) => {
    const result = checkAbsenceClaim(value.pathGlob, context.coverage);
    return result.ok
      ? accept({ ...value, statement: result.statement })
      : reject(result.rule, result.detail);
  };
}
