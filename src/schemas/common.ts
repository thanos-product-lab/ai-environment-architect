import { z } from "zod";

// Building blocks for the call schemas (IMPL §3.3). Each item is defined once, by a function of
// `Limits`:
//
// - `SHAPE` builds what structured outputs enforce during generation: types, enums, patterns,
//   required fields and closed objects, with `minItems` of at most 1. The schema stage checks it.
// - `LIMITED` adds the limits the API can't enforce: lengths in code points, array sizes. The
//   item stage checks it as LIMIT-001 (IMPL §3.5), and the version fingerprint covers it.

export interface Size {
  readonly min: number;
  readonly max: number;
}

export interface Limits {
  /** A string of at most `max` code points, matching `pattern` if given. */
  readonly text: (max: number, pattern?: RegExp) => z.ZodType<string>;
  readonly list: <T extends z.ZodType>(item: T, size: Size) => z.ZodArray<T>;
}

export const SHAPE: Limits = {
  text: (_max, pattern) => (pattern === undefined ? z.string() : z.string().regex(pattern)),
  list: (item, { min }) => (min >= 1 ? z.array(item).min(1) : z.array(item)),
};

export const LIMITED: Limits = {
  text: (max, pattern) =>
    (pattern === undefined ? z.string() : z.string().regex(pattern))
      .refine((value) => codePoints(value) <= max, {
        message: `at most ${max} characters`,
        params: { maximum: max, unit: "characters" },
      })
      .meta({ maxCodePoints: max }),
  list: (item, { min, max }) => z.array(item).min(min).max(max),
};

/**
 * How lengths are counted. The fingerprint includes it, so changing the count changes the
 * fingerprint even though the JSON Schema doesn't show it (IMPL §3.7).
 */
export const LENGTH_UNIT = "code-points/1";

function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Field lengths and sizes shared by several calls (IMPL §3.3). */
export const FIELD_LIMITS = {
  statement: 300,
  uncertainty: 200,
  reason: 200,
  description: 300,
  noticeDescription: 200,
  quote: 200,
  path: 512,
  alias: 16,
  lineRange: 32,
  lineRanges: 512,
  blockTarget: 16,
  literal: 200,
  prompt: 200,
  questionReason: 300,
  optionLabel: 120,
  heading: 80,
  content: 1200,
  rationale: 400,
  referenceValue: 512,
  topic: 200,
  noChangeReason: 400,
  scopePaths: { min: 1, max: 10 },
  citations: { min: 1, max: 6 },
  relatedPaths: { min: 1, max: 10 },
  conflictFindings: { min: 2, max: 10 },
  readEntries: { min: 1, max: 10 },
  aliasList: { min: 1, max: 10 },
  options: { min: 0, max: 4 },
  references: { min: 0, max: 20 },
} as const;

const L = FIELD_LIMITS;

/** A response-local key: its letter and a number from 1 to 9999, so at most five characters. */
export function localKey(letter: "f" | "g" | "a" | "c" | "q" | "r"): z.ZodString {
  return z.string().regex(new RegExp(`^${letter}[1-9][0-9]{0,3}$`));
}

export const lineRange = (l: Limits) => l.text(L.lineRange, /^[1-9][0-9]*-[1-9][0-9]*$/);
export const lineRanges = (l: Limits) =>
  l.text(L.lineRanges, /^[1-9][0-9]*-[1-9][0-9]*(,[1-9][0-9]*-[1-9][0-9]*)*$/);
export const blockTarget = (l: Limits) => l.text(L.blockTarget, /^B-[1-9][0-9]*$/);

/** An alias reference. No pattern, so a wrong one fails one item (ALIAS-001, ALIAS-003). */
export const alias = (l: Limits) => l.text(L.alias);
export const path = (l: Limits) => l.text(L.path);

export const scope = (l: Limits) =>
  z.union([
    z.strictObject({ kind: z.literal("repository") }),
    z.strictObject({ kind: z.literal("paths"), paths: l.list(path(l), L.scopePaths) }),
  ]);

export const citation = (l: Limits) =>
  z.strictObject({ item: alias(l), lines: lineRange(l), quote: l.text(L.quote) });

export const finding = (l: Limits) =>
  z.strictObject({
    key: localKey("f"),
    statement: l.text(L.statement),
    mode: z.enum(["descriptive", "prescriptive"]),
    scope: scope(l),
    citations: l.list(citation(l), L.citations),
    uncertainty: l.text(L.uncertainty).optional(),
  });

export const gap = (l: Limits) =>
  z.strictObject({
    key: localKey("g"),
    statement: l.text(L.statement),
    gapType: z.enum([
      "no_command",
      "no_documentation",
      "undetermined_ownership",
      "undetermined_convention",
      "other",
    ]),
    relatedPaths: l.list(path(l), L.relatedPaths),
  });

export const absenceClaim = (l: Limits) =>
  z.strictObject({ key: localKey("a"), pathGlob: path(l), reason: l.text(L.reason) });

/** In `analyse`, members are local keys; in `analyse_expansion`, local keys or F aliases. */
export const conflict = (l: Limits) =>
  z.strictObject({
    key: localKey("c"),
    description: l.text(L.description),
    findings: l.list(alias(l), L.conflictFindings),
  });

export const contentNotice = (l: Limits) =>
  z.strictObject({
    item: alias(l),
    lines: lineRange(l),
    description: l.text(L.noticeDescription),
  });

export const target = (l: Limits) =>
  z.union([
    z.strictObject({ kind: z.literal("block"), block: blockTarget(l) }),
    z.strictObject({ kind: z.literal("after"), block: blockTarget(l) }),
    z.strictObject({ kind: z.literal("section"), heading: blockTarget(l) }),
    z.strictObject({
      kind: z.literal("newSection"),
      heading: l.text(L.heading),
      after: blockTarget(l).optional(),
    }),
  ]);

/** A recommendation without its key, as a regeneration's `revision` carries it (IMPL §3.3.6). */
export const recommendationBody = (l: Limits) =>
  z.strictObject({
    kind: z.enum(["fact", "policy"]),
    operation: z.enum(["add", "revise", "remove"]),
    target: target(l),
    content: l.text(L.content).optional(),
    rationale: l.text(L.rationale),
    support: l.list(alias(l), L.aliasList),
    references: l.list(
      z.strictObject({
        kind: z.enum(["path", "command"]),
        value: l.text(L.referenceValue),
        support: alias(l),
      }),
      L.references,
    ),
    scope: scope(l),
  });

export const recommendation = (l: Limits) =>
  z.strictObject({ key: localKey("r"), ...recommendationBody(l).shape });

export const heldBack = (l: Limits) =>
  z.strictObject({ topic: l.text(L.topic), blockedBy: l.list(alias(l), L.aliasList) });
