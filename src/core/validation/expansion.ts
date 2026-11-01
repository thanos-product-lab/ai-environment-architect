import type { z } from "zod";
import type { analyse } from "../../schemas/analyse.js";
import { isWithheldPath } from "../context/secrets.js";
import { matchSegments } from "../glob.js";
import { normalisePath } from "../paths.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import type { SentFile } from "./coverage.js";
import { accept, type ItemCheck, reject } from "./pipeline.js";

// The static expansion checks (IMPL §1.8), run with the `analyse` item validation (§3.3.2
// step 9). Whether a range lies within its file, and the expansion byte budget, need the file's
// content, so they are checked when a request is executed.

export type ExpansionRequest = z.infer<typeof analyse.response>["expansionRequests"][number];

/** The expansion settings (IMPL §1.8, §1.14), recorded with the session's configuration. */
export interface ExpansionSettings {
  /** At most the `analyse` schema's ceiling of 5; a lower setting rejects requests beyond it. */
  readonly maxExpansionRequests: number;
  /** The total of all expansion items in the one expansion round. */
  readonly expansionBytes: number;
  /** The cap on each `read` entry. */
  readonly expansionEntryBytes: number;
}

export const DEFAULT_EXPANSION_SETTINGS: ExpansionSettings = {
  maxExpansionRequests: 5,
  expansionBytes: 60_000,
  expansionEntryBytes: 8_000,
};

export interface ExpansionIndex {
  /** `maxExpansionRequests` (§1.14): at most the schema's ceiling of 5. */
  readonly maxRequests: number;
  /** The snapshot's scope roots as segments; `.` is the empty list, which covers everything. */
  readonly scopeRoots: readonly (readonly string[])[];
  /**
   * `read` entries, and `listed_only` ones too large to excerpt, that are not withheld or blocked:
   * what a `read` may name. A file that holds a NUL byte or isn't UTF-8 is never readable.
   */
  readonly readable: ReadonlySet<string>;
  /** The readable `listed_only` entries, which only a range read can see (EXP-006). */
  readonly rangesOnly: ReadonlySet<string>;
  /** `read` entries that are not withheld or blocked, as segments: what a search runs over. */
  readonly searchable: readonly (readonly string[])[];
  /** What the initial context sent of each file. */
  readonly sent: ReadonlyMap<string, { readonly totalLines: number; readonly lines: Set<number> }>;
}

export interface ExpansionContext {
  readonly expansion: ExpansionIndex;
}

export function expansionIndex(input: {
  readonly files: readonly SnapshotFile[];
  readonly scopeRoots: readonly string[];
  readonly sent: Iterable<SentFile>;
  readonly maxRequests: number;
  /** Files selection blocked because their content matched the secret scan (§1.7). */
  readonly blocked?: readonly string[];
}): ExpansionIndex {
  // A file blocked by content keeps its snapshot status, so selection's record decides.
  const blocked = new Set(input.blocked ?? []);
  const visible = input.files.filter(
    (file) => !isWithheldPath(file.path) && !blocked.has(file.path),
  );
  const sent = new Map<string, { totalLines: number; lines: Set<number> }>();
  for (const item of input.sent) {
    const file = sent.get(item.path) ?? { totalLines: item.totalLines, lines: new Set<number>() };
    // Items of one snapshot are cut from the same text, so a mismatch is a bug upstream.
    if (file.totalLines !== item.totalLines)
      throw new Error(`items of one file disagree on its line count: ${item.path}`);
    for (const run of item.sent)
      for (let line = run.first; line < run.first + run.lines.length; line++) file.lines.add(line);
    sent.set(item.path, file);
  }
  return {
    maxRequests: input.maxRequests,
    scopeRoots: input.scopeRoots.map((root) => (root === "." ? [] : root.split("/"))),
    readable: new Set(
      visible
        .filter(
          (file) =>
            file.status === "read" ||
            (file.status === "listed_only" && file.reason === "too_large"),
        )
        .map((file) => file.path),
    ),
    rangesOnly: new Set(
      visible
        .filter((file) => file.status === "listed_only" && file.reason === "too_large")
        .map((file) => file.path),
    ),
    searchable: visible.filter((file) => file.status === "read").map((f) => f.path.split("/")),
    sent,
  };
}

type Failure = { readonly ok: false; readonly rule: string; readonly detail: string };
const failure = (rule: string, detail: string): Failure => ({ ok: false, rule, detail });

/** As ABS-003 (§1.11): a glob holds no backtick, whitespace, control or format character. */
const NOT_A_GLOB = /[`\p{White_Space}\p{Cc}\p{Cf}]/u;
const CONTROL = /\p{Cc}/u;
const ONLY_PUNCTUATION = /^[\p{White_Space}\p{P}\p{S}]*$/u;
const MIN_LITERAL_CODE_POINTS = 3;

function ranges(lines: string): [number, number][] {
  return lines.split(",").map((range) => range.split("-").map(Number) as [number, number]);
}

/** EXP-001, EXP-006, then EXP-002 to EXP-005 (§1.8); the first failure rejects the request. */
export function checkExpansionRequest(
  request: ExpansionRequest,
  index: ExpansionIndex,
): { readonly ok: true } | Failure {
  if (request.kind === "read") {
    const paths = request.entries.map((entry) => normalisePath(entry.path));
    const unreadable = paths.findIndex((path) => path === undefined || !index.readable.has(path));
    if (unreadable !== -1) return failure("EXP-001", `entry ${unreadable} is not a readable file`);

    const unranged = request.entries.findIndex(
      (entry, i) => entry.lines === undefined && index.rangesOnly.has(paths[i] as string),
    );
    if (unranged !== -1)
      return failure("EXP-006", `entry ${unranged} is too large to read without line ranges`);

    const reversed = request.entries.findIndex(
      (entry) =>
        entry.lines !== undefined && ranges(entry.lines).some(([start, end]) => start > end),
    );
    if (reversed !== -1) return failure("EXP-002", `entry ${reversed} has a range that ends first`);

    const addsSomething = request.entries.some((entry, i) => {
      const sent = index.sent.get(paths[i] as string);
      if (sent === undefined) return true;
      if (entry.lines === undefined) {
        for (let line = 1; line <= sent.totalLines; line++) if (!sent.lines.has(line)) return true;
        return false;
      }
      return ranges(entry.lines).some(([start, end]) => {
        for (let line = start; line <= end; line++) if (!sent.lines.has(line)) return true;
        return false;
      });
    });
    if (!addsSomething) return failure("EXP-003", "every entry asks only for lines already sent");
    return { ok: true };
  }

  if (request.glob !== undefined) {
    const glob = request.glob;
    if (NOT_A_GLOB.test(glob))
      return failure("EXP-004", "the glob holds a backtick, whitespace, or a control character");
    const normalised = normalisePath(glob);
    if (normalised === undefined) return failure("EXP-004", "the glob holds a .. segment");
    const pattern = normalised.split("/");
    const underRoot = index.scopeRoots.some((root) =>
      root.every((segment, i) => pattern[i] === segment),
    );
    if (!underRoot) return failure("EXP-004", "the glob is outside the snapshot's scope roots");
    // A glob matching a directory covers everything under it (§1.11).
    const matches = index.searchable.some((path) =>
      path.some((_, end) => matchSegments(pattern, path.slice(0, end + 1))),
    );
    if (!matches) return failure("EXP-004", "the glob matches no searchable file");
  }

  const literal = request.literal;
  if (CONTROL.test(literal)) return failure("EXP-005", "the literal holds a control character");
  if ([...literal].length < MIN_LITERAL_CODE_POINTS)
    return failure("EXP-005", `the literal is shorter than ${MIN_LITERAL_CODE_POINTS} characters`);
  if (ONLY_PUNCTUATION.test(literal))
    return failure("EXP-005", "the literal is only whitespace, punctuation or symbols");
  return { ok: true };
}

/** LIMIT-002: requests beyond `maxExpansionRequests`, in response order (§1.8). */
export function expansionLimitCheck<C extends ExpansionContext>(): ItemCheck<ExpansionRequest, C> {
  return (value, context, _response, position) => {
    if (position === undefined) throw new Error("LIMIT-002 needs the item's position");
    const max = context.expansion.maxRequests;
    return position < max
      ? accept(value)
      : reject("LIMIT-002", `beyond maxExpansionRequests, ${max}`);
  };
}

/** The static EXP rules as an item check (§3.3.2 step 9). */
export function expansionRequestCheck<C extends ExpansionContext>(): ItemCheck<
  ExpansionRequest,
  C
> {
  return (value, context) => {
    const result = checkExpansionRequest(value, context.expansion);
    return result.ok ? accept(value) : reject(result.rule, result.detail);
  };
}
