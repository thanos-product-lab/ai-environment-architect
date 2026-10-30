import { isWithheldPath } from "../context/secrets.js";
import { comparePaths } from "../paths.js";
import type { Basis, Evidence } from "./citations.js";
import {
  type AcceptedItems,
  accept,
  type CrossItemCheck,
  type CrossItemRejection,
  type ItemCheck,
  reject,
} from "./pipeline.js";

// Support checks (IMPL §3.2.3). They run after provenance, on the evidence code extracted, and
// catch statements that clearly go beyond it. They never prove a claim right: what they can't
// check is left to the developer at review, labelled "source checked".
//
// The word lists are versioned with the validator: changing one changes what is accepted, so it
// increases `VALIDATOR_VERSION` (§3.5). Matching is whole-word and case-insensitive.

/** Directive language (SUP-004), also used by REC-007 (§3.3.5). "use … instead" is matched apart. */
export const DIRECTIVE_WORDS = [
  "must",
  "should",
  "always",
  "never",
  "do not",
  "don't",
  "required",
  "prefer",
] as const;

/** Universal quantifiers that samples can't support (SUP-003). */
export const UNIVERSAL_WORDS = ["all", "every", "always", "never", "none", "only"] as const;

/**
 * Spelled numbers (SUP-002), allowed only where a cited excerpt holds the same word, as digits
 * are. "one" is left out: it is too often a pronoun. Provisional (§3.9).
 */
export const NUMBER_WORDS = [
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "dozen",
  "dozens",
  "hundred",
  "hundreds",
  "thousand",
  "thousands",
] as const;

/** Quantities and frequencies only counting could establish (SUP-002). Provisional (§3.9). */
export const QUANTITY_WORDS = [
  "most",
  "many",
  "several",
  "few",
  "numerous",
  "majority",
  "minority",
  "half",
  "mostly",
  "usually",
  "often",
  "typically",
  "frequently",
  "rarely",
  "seldom",
  "multiple",
] as const;

const PRESCRIPTIVE_BASES: ReadonlySet<Basis> = new Set(["documentation", "existing_guidance"]);

export interface SupportContext {
  /** Listed paths that may anchor a statement: never a withheld one (§1.11). */
  readonly anchorable: ReadonlySet<string>;
}

/** A finding as support sees it: its statement, and the evidence of its accepted citations. */
export interface SupportedFinding {
  readonly statement: string;
  readonly mode: "descriptive" | "prescriptive";
  readonly evidence?: readonly Evidence[];
}

export type SupportResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly detail: string };

/**
 * Snapshot entry paths, of any status, and the directories that contain them, in bytewise order.
 * A withheld path is left out: the model never saw its name, so it anchors nothing (§1.11).
 */
export function anchorablePaths(entries: readonly string[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    const segments = entry.split("/");
    for (let end = 1; end <= segments.length; end++) paths.add(segments.slice(0, end).join("/"));
  }
  return new Set([...paths].filter((path) => !isWithheldPath(path)).sort(comparePaths));
}

// A letter, digit or underscore next to a match means it is part of a longer word.
const WORD = "[\\p{L}\\p{N}_]";
// Backticks pair from the left, so an empty pair is a token too.
const INLINE_CODE = /`([^`]*)`/g;
const LEADING = /^[("']+/;
const TRAILING = /[.,;:!?)"']+$/;
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
/** Any Unicode decimal digit (Nd), matched as written: `５` is not `5`. */
const DIGITS = /\p{Nd}+/gu;
// "use … instead" counts only on one line, in that order.
const USE_INSTEAD = new RegExp(
  `(?<!${WORD})use(?!${WORD})[^\\n]*?(?<!${WORD})instead(?!${WORD})`,
  "iu",
);

function wordPattern(word: string): RegExp {
  const source = word
    .split(" ")
    .map((part) => part.replace("'", "['’]"))
    .join("[ \\t]+");
  return new RegExp(`(?<!${WORD})${source}(?!${WORD})`, "iu");
}

const patterns = new Map<string, RegExp>();
function containsWord(text: string, word: string): boolean {
  let pattern = patterns.get(word);
  if (pattern === undefined) {
    pattern = wordPattern(word);
    patterns.set(word, pattern);
  }
  return pattern.test(text);
}

/** Bare path-like tokens (§3.4): segments joined by `/`, the last ending in a file extension. */
function isPathLike(token: string): boolean {
  const last = token.slice(token.lastIndexOf("/") + 1);
  return token.includes("/") && EXTENSION.test(last);
}

interface Tokens {
  readonly code: readonly string[];
  readonly paths: readonly string[];
  /** The statement without its inline code and path-like tokens, which SUP-001 checks. */
  readonly rest: string;
}

function tokenize(statement: string): Tokens {
  const code = [...statement.matchAll(INLINE_CODE)].map((match) => match[1] ?? "");
  const paths: string[] = [];
  const rest: string[] = [];
  for (const token of statement.replace(INLINE_CODE, " ").split(/\s+/)) {
    const bare = token.replace(LEADING, "").replace(TRAILING, "");
    if (isPathLike(bare)) paths.push(bare);
    else rest.push(token);
  }
  return { code, paths, rest: rest.join(" ") };
}

export function checkSupport(finding: SupportedFinding, context: SupportContext): SupportResult {
  const evidence = finding.evidence;
  if (evidence === undefined) throw new Error("support checks run after citations");
  const excerpts = evidence.map((e) => e.excerpt);
  const { code, paths, rest } = tokenize(finding.statement);

  // SUP-001: every inline-code and path-like token is in a cited excerpt or is a listed path.
  const anchored = (token: string): boolean =>
    excerpts.some((excerpt) => excerpt.includes(token)) || isListed(token, context);
  if (!code.every(anchored))
    return failure("SUP-001", "inline code not in a cited excerpt or the file list");
  if (!paths.every(anchored))
    return failure("SUP-001", "a path not in a cited excerpt or the file list");

  // SUP-002: no counts. A number is allowed only where a cited excerpt holds it whole.
  for (const [digits] of rest.matchAll(DIGITS)) {
    const whole = new RegExp(`(?<!\\p{Nd})${digits}(?!\\p{Nd})`, "u");
    if (!excerpts.some((excerpt) => whole.test(excerpt)))
      return failure("SUP-002", "a number not in a cited excerpt");
  }
  for (const word of NUMBER_WORDS)
    if (containsWord(rest, word) && !excerpts.some((excerpt) => containsWord(excerpt, word)))
      return failure("SUP-002", `number word "${word}" not in a cited excerpt`);
  for (const word of QUANTITY_WORDS)
    if (containsWord(rest, word)) return failure("SUP-002", `counted quantity "${word}"`);

  // SUP-003: samples support "some", not "all".
  if (finding.mode === "descriptive" && evidence.every((e) => e.basis === "code_observation"))
    for (const word of UNIVERSAL_WORDS)
      if (containsWord(rest, word))
        return failure("SUP-003", `universal quantifier "${word}" from code observations only`);

  // SUP-004: a prescriptive finding needs a documented or configured directive.
  if (
    finding.mode === "prescriptive" &&
    !evidence.some((e) => PRESCRIPTIVE_BASES.has(e.basis) && hasDirective(e.excerpt))
  )
    return failure(
      "SUP-004",
      "no documentation or existing guidance citation with directive language",
    );

  return { ok: true };
}

/** Whether text holds directive language (§3.2.3 list, or "use … instead" on one line). */
export function hasDirective(text: string): boolean {
  return DIRECTIVE_WORDS.some((word) => containsWord(text, word)) || USE_INSTEAD.test(text);
}

function failure(rule: string, detail: string): SupportResult {
  return { ok: false, rule, detail };
}

/** SUP-001 to SUP-004 as an item check, after provenance (§3.3.2 step 3). */
export function supportCheck<V extends SupportedFinding, C extends SupportContext>(): ItemCheck<
  V,
  C
> {
  return (value, context) => {
    const result = checkSupport(value, context);
    return result.ok ? accept(value) : reject(result.rule, result.detail);
  };
}

/**
 * Whether a path token names a listed path (§1.11): one leading `./` and one trailing `/` are
 * removed first, and `../` is never resolved, so a token holding it lists nothing. Excerpts are
 * matched with the token as written.
 */
export function isListed(token: string, context: SupportContext): boolean {
  const path = token.startsWith("./") ? token.slice(2) : token;
  return (
    context.anchorable.has(path) ||
    (path.endsWith("/") && context.anchorable.has(path.slice(0, -1)))
  );
}

/**
 * SUP-005: every member cites at least one file that not every other member cites, so no side of
 * the conflict rests only on sources the others share.
 */
export function hasDistinctSources(memberPaths: readonly (readonly string[])[]): boolean {
  const members = memberPaths.map((paths) => new Set(paths));
  return members.every((own, i) =>
    [...own].some((path) => members.some((other, j) => j !== i && !other.has(path))),
  );
}

export interface DistinctSourcesSpec<A, C, K extends keyof A & string> {
  readonly collection: K;
  /** The evidence paths of each member finding, local keys and `F` aliases alike. */
  readonly memberPaths: (
    conflict: A[K],
    surviving: AcceptedItems<A>,
    context: C,
  ) => readonly (readonly string[])[];
}

/** SUP-005 as a cross-item check, run after CONF-001 (§3.3.2 step 7). */
export function distinctSourcesCheck<A, C, K extends keyof A & string>(
  spec: DistinctSourcesSpec<A, C, K>,
): CrossItemCheck<A, C> {
  return (surviving, context) =>
    surviving[spec.collection].flatMap((conflict): CrossItemRejection<A>[] =>
      hasDistinctSources(spec.memberPaths(conflict.value, surviving, context))
        ? []
        : [
            {
              collection: spec.collection,
              index: conflict.index,
              rule: "SUP-005",
              detail: "a member finding cites no file that not every other member cites",
            },
          ],
    );
}
