import { unescapeDelimiters } from "../context/escape.js";
import { type ItemInput, lineTexts, type RenderedItem } from "../context/item.js";
import type { TierMembership } from "../context/tiers.js";
import type { Hash } from "../hash.js";
import { comparePaths } from "../paths.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import { type AliasTable, resolveReference } from "./aliases.js";
import { basisOf } from "./basis.js";
import {
  accept,
  type CheckEvent,
  type ItemCheck,
  reject,
  type ValidationEvent,
} from "./pipeline.js";

// Citations and provenance (IMPL §3.2.2). A citation proves where a quote came from: the quote
// occurs, exactly, in lines of one item that were sent in this call. It says nothing about
// whether the quote supports the claim (§3.2.3). The only repair is CIT-R01, which moves the line
// range to the quote's single occurrence and changes nothing else.

export type Basis = "documentation" | "code_observation" | "existing_guidance";

/** A citation as the model writes it. */
export interface Citation {
  /** `T5-007` or `E-2`. */
  readonly item: string;
  /** `40-52`; a single line is `40-40`. */
  readonly lines: string;
  /** Verbatim text from within those lines, delimiter escape as rendered. */
  readonly quote: string;
}

/** A run of consecutive sent lines: the file's own text, without the delimiter escape. */
export interface SentRun {
  readonly first: number;
  readonly lines: readonly string[];
}

/** What validation knows about one context or expansion item. It never holds unsent lines. */
export interface CitableItem {
  readonly path: string;
  /** The hash the snapshot recorded. */
  readonly snapshotHash: Hash;
  /** The file's hash read again before validation; undefined when it couldn't be read. */
  readonly currentHash: Hash | undefined;
  /** Derived by code from the tier the file belongs to (§3.2.4). */
  readonly basis: Basis;
  readonly totalLines: number;
  /** The item's `included` ranges, in order. Empty for an outline-only item. */
  readonly sent: readonly SentRun[];
}

export interface CitationContext {
  readonly aliases: AliasTable;
  /** Keyed by item ID, for every `T` and `E` alias in the table. */
  readonly items: ReadonlyMap<string, CitableItem>;
}

/** Evidence as code creates it (DM §6.2). ID and snapshot ID are assigned when it is persisted. */
export interface Evidence {
  readonly kind: "lines";
  readonly path: string;
  readonly fileHash: Hash;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** The file's text for the final range, lines joined with `\n`. */
  readonly excerpt: string;
  readonly basis: Basis;
}

/** Evidence that a file exists in the snapshot, with no lines (DM §6.2). Only code creates it. */
export interface EntryEvidence {
  readonly kind: "entry";
  readonly path: string;
  readonly fileHash: Hash;
  readonly basis: Basis;
}

export interface Correction {
  readonly originalLines: string;
  readonly correctedLines: string;
}

export type CitationResult =
  | {
      readonly ok: true;
      /** The citation with its final range; the item and quote are never changed. */
      readonly citation: Citation;
      readonly evidence: Evidence;
      readonly correction?: Correction;
    }
  | {
      readonly ok: false;
      readonly rule: string;
      /** Code-generated: never the quote, the file's text or an unknown alias. */
      readonly detail: string;
      /** For CIT-002, the changed path, so the session can mark the snapshot unstable. */
      readonly original?: { readonly path: string };
    };

const MIN_QUOTE_CODE_POINTS = 12;
/** Provisional (IMPL §3.9): the longest final range a citation may have. Excerpts are never cut. */
export const MAX_CITED_LINES = 40;
/** Format characters and combining marks: invisible on their own, so not counted (provisional). */
const UNCOUNTED = /[\p{Cf}\p{Mn}\p{Me}]/gu;
// Unicode White_Space, not `\s`, which also matches U+FEFF, a format character.
const ONLY_PUNCTUATION = /^[\p{White_Space}\p{P}\p{S}]*$/u;
/** A lone surrogate: half of a character, which no UTF-8 file text contains. */
const LONE_SURROGATE = /\p{Cs}/u;

export function validateCitation(
  citation: Citation,
  context: CitationContext,
  localKeys: ReadonlySet<string>,
): CitationResult {
  // 1. Quote rules (CIT-007), on the file's text the quote stands for. Uncounted characters
  // still have to match exactly below.
  const quote = unescapeDelimiters(citation.quote);
  const counted = quote.replace(UNCOUNTED, "");
  if ([...counted].length < MIN_QUOTE_CODE_POINTS)
    return failure("CIT-007", `quote shorter than ${MIN_QUOTE_CODE_POINTS} characters`);
  if (ONLY_PUNCTUATION.test(counted))
    return failure("CIT-007", "quote is only whitespace, punctuation or symbols");

  // 2. Item (CIT-001), or an alias of another kind (ALIAS-003).
  const resolved = resolveReference(context.aliases, localKeys, citation.item, {
    aliases: ["T", "E"],
  });
  if (!resolved.ok)
    return resolved.rule === "ALIAS-003"
      ? failure("ALIAS-003", resolved.detail)
      : failure("CIT-001", "an item not in this call's input");
  const alias = citation.item;
  const item = context.items.get(alias);
  if (item === undefined) throw new Error(`no citable item for ${alias}`);

  // 3. File currency (CIT-002).
  if (item.currentHash !== item.snapshotHash)
    return {
      ok: false,
      rule: "CIT-002",
      detail:
        item.currentHash === undefined
          ? `${alias} could not be read again`
          : `${alias} changed since the snapshot`,
      original: { path: item.path },
    };

  // 4. Sent content (CIT-006).
  if (item.sent.length === 0) return failure("CIT-006", `${alias} has no sent lines`);

  // 5. Range (CIT-003). The schema guarantees the `a-b` form.
  const [start, end] = citation.lines.split("-").map(Number) as [number, number];
  const run = item.sent.find(
    (candidate) => start >= candidate.first && end < candidate.first + candidate.lines.length,
  );
  if (start > end) return failure("CIT-003", "range starts after it ends");
  if (run === undefined) return failure("CIT-003", `range is not within ${alias}'s sent lines`);

  // A lone surrogate would match half of a character in the UTF-16 search below.
  if (LONE_SURROGATE.test(quote)) return failure("CIT-004", "quote is not well-formed text");

  // 6. Quote in range.
  if (lineText(run, start, end).includes(quote))
    return end - start + 1 > MAX_CITED_LINES
      ? tooLong()
      : { ok: true, citation, evidence: evidence(item, run, start, end) };

  // 7. Line-range correction (CIT-R01), searching only this item's sent lines.
  const occurrences = item.sent.flatMap((candidate) => findOccurrences(candidate, quote));
  if (occurrences.length === 0)
    return failure("CIT-004", `quote not found in ${alias}'s sent lines`);
  if (occurrences.length > 1)
    return failure("CIT-005", `quote occurs ${occurrences.length} times in ${alias}'s sent lines`);
  const [only] = occurrences as [Occurrence];
  if (only.end - only.start + 1 > MAX_CITED_LINES) return tooLong();
  const correctedLines = `${only.start}-${only.end}`;
  return {
    ok: true,
    citation: { ...citation, lines: correctedLines },
    evidence: evidence(item, only.run, only.start, only.end),
    correction: { originalLines: citation.lines, correctedLines },
  };
}

function failure(rule: string, detail: string): CitationResult {
  return { ok: false, rule, detail };
}

/** CIT-010 (provisional), on the final range: after correction, when there is one. */
function tooLong(): CitationResult {
  return failure("CIT-010", `range longer than ${MAX_CITED_LINES} lines`);
}

function lineText(run: SentRun, start: number, end: number): string {
  return run.lines.slice(start - run.first, end - run.first + 1).join("\n");
}

function evidence(item: CitableItem, run: SentRun, start: number, end: number): Evidence {
  return {
    kind: "lines",
    path: item.path,
    fileHash: item.snapshotHash,
    lineStart: start,
    lineEnd: end,
    excerpt: lineText(run, start, end),
    basis: item.basis,
  };
}

interface Occurrence {
  readonly run: SentRun;
  readonly start: number;
  readonly end: number;
}

/** Every occurrence within one run, overlapping ones included, with the lines it spans. */
function findOccurrences(run: SentRun, quote: string): Occurrence[] {
  const text = run.lines.join("\n");
  // `lineStarts[k]` is the offset of line `run.first + k` in `text`.
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of run.lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (position: number): number => {
    let k = 0;
    while (k + 1 < lineStarts.length && (lineStarts[k + 1] ?? 0) <= position) k++;
    return run.first + k;
  };
  // A `\n` joins two lines, so the range must hold both: a quote starting with one starts on the
  // line before it, and a quote ending with one ends on the line after it.
  const endsWithBreak = quote.endsWith("\n");
  const found: Occurrence[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1))
    found.push({
      run,
      start: lineAt(at),
      end: lineAt(at + quote.length - 1) + (endsWithBreak ? 1 : 0),
    });
  return found;
}

/** Fields a finding gains when its citations are validated. */
export interface Cited {
  readonly citations: readonly Citation[];
  /** Parallel to the accepted `citations`. */
  readonly evidence?: readonly Evidence[];
  /** How many proposed citations were dropped, merged duplicates included (DM §6.3). */
  readonly droppedCitations?: number;
}

/**
 * Validates each citation of an item. A failed citation drops only itself, and a duplicate of an
 * earlier one is merged into it (CIT-009); the item is rejected with CIT-008 when none is left,
 * after its citations' events.
 */
export function citationCheck<V extends Cited, C extends CitationContext>(): ItemCheck<V, C> {
  return (value, context, response) => {
    const events: CheckEvent[] = [];
    const kept: Citation[] = [];
    const found: Evidence[] = [];
    value.citations.forEach((citation, index) => {
      const subKey = `citations/${index}`;
      const result = validateCitation(citation, context, response.localKeys);
      if (!result.ok) {
        events.push({
          rule: result.rule,
          outcome: "rejected",
          detail: result.detail,
          ...(result.original === undefined ? {} : { original: result.original }),
          subKey,
        });
        return;
      }
      if (result.correction !== undefined)
        events.push({
          rule: "CIT-R01",
          outcome: "corrected",
          detail: `range corrected to the quote's only occurrence`,
          original: result.correction,
          subKey,
        });
      // CIT-009: a second citation of the same path and final range adds nothing. Overlapping but
      // different ranges are kept.
      const { path, lineStart, lineEnd } = result.evidence;
      if (
        found.some((e) => e.path === path && e.lineStart === lineStart && e.lineEnd === lineEnd)
      ) {
        events.push({
          rule: "CIT-009",
          outcome: "rejected",
          detail: "same path and range as an earlier citation of this item",
          subKey,
        });
        return;
      }
      kept.push(result.citation);
      found.push(result.evidence);
    });
    if (kept.length === 0) return reject("CIT-008", "no valid citation left", ...events);
    return accept(
      {
        ...value,
        citations: kept,
        evidence: found,
        droppedCitations: value.citations.length - kept.length,
      },
      ...events,
    );
  };
}

/**
 * The citable form of a rendered item: its sent lines only, as the file's own text. Its basis is
 * derived here from the tier the file belongs to (§3.2.4), so no caller can choose it.
 */
export function citableItem(
  input: Pick<ItemInput, "path" | "hash" | "content">,
  rendered: Pick<RenderedItem, "included" | "totalLines">,
  membership: TierMembership,
  currentHash: Hash | undefined,
): CitableItem {
  const lines = lineTexts(input.content);
  return {
    path: input.path,
    snapshotHash: input.hash,
    currentHash,
    basis: basisOf(input.path, membership),
    totalLines: rendered.totalLines,
    sent: rendered.included.map((range) => ({
      first: range.first,
      lines: lines.slice(range.first - 1, range.last),
    })),
  };
}

/** Each path's current hash, in bytewise path order; undefined when it can't be read. */
export async function readCurrentHashes(
  fs: RepositoryFs,
  paths: readonly string[],
): Promise<ReadonlyMap<string, Hash | undefined>> {
  const unique = [...new Set(paths)].sort(comparePaths);
  const hashes = new Map<string, Hash | undefined>();
  for (const path of unique) {
    const result = await fs.read(path, 0);
    hashes.set(path, result.ok ? result.hash : undefined);
  }
  return hashes;
}

/** The paths CIT-002 found changed, once each, in bytewise order. */
export function unstablePaths(events: readonly ValidationEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events)
    if (event.rule === "CIT-002") {
      const path = (event.original as { path?: unknown } | undefined)?.path;
      if (typeof path === "string") paths.add(path);
    }
  return [...paths].sort(comparePaths);
}
