import { type BlockType, parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { barePathToken, stripTokenPunctuation } from "./support.js";

// The reference detector (IMPL §3.4): finds the paths and commands that recommendation content
// mentions, so `REF-001` can check they are declared. It fails closed: over-detection costs a
// rejected recommendation, under-detection lets an unchecked reference into the developer's file.

/** Changes whenever what the detector finds changes, including any of the lists below. */
export const DETECTOR_VERSION = "references/1.2.0";

/** Words that start a command in code, each matched as a whole word, case-insensitively. */
export const RUNNERS = [
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "make",
  "just",
  "task",
  "python",
  "pytest",
  "uv",
  "poetry",
  "cargo",
  "go",
  "docker",
] as const;

/** Runners that start a command in plain text too, in lowercase exactly: not ordinary words. */
export const PROSE_RUNNERS = [
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "pytest",
  "uv",
  "poetry",
  "cargo",
  "docker",
  "python",
] as const;

/** Matched exactly, after a final `.`. */
export const KNOWN_FILE_EXTENSIONS = [
  "md",
  "mdx",
  "txt",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "lock",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "html",
  "css",
  "scss",
  "vue",
  "svelte",
] as const;

/** Matched exactly, as the whole span. */
export const KNOWN_FILE_NAMES = [
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "justfile",
  "Justfile",
  "Procfile",
  "Gemfile",
  "LICENSE",
] as const;

export type ReferenceKind = "path" | "command";

export interface DetectedReference {
  readonly kind: ReferenceKind;
  /** The span, line or words as written. */
  readonly value: string;
  /** What classification and the `REF` rules use: trimmed, without a prompt or fragment. */
  readonly match: string;
}

export interface DetectedIdentifier {
  readonly value: string;
  readonly match: string;
}

export interface Detection {
  /** In document order, every occurrence. */
  readonly references: readonly DetectedReference[];
  /** Spans and link targets that are neither, URLs included, for `REF-005`. Document order. */
  readonly identifiers: readonly DetectedIdentifier[];
}

const EXTENSIONS: ReadonlySet<string> = new Set(KNOWN_FILE_EXTENSIONS);
const FILE_NAMES: ReadonlySet<string> = new Set(KNOWN_FILE_NAMES);
const PROSE: ReadonlySet<string> = new Set(PROSE_RUNNERS);
/** Unicode `White_Space`, for every rule of §3.4. */
const WHITESPACE = /\p{White_Space}/u;
const WORDS = /\P{White_Space}+/gu;
const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
// A runner is a whole word: followed by whitespace or the end of the span.
const RUNNER = new RegExp(`^(?:${RUNNERS.join("|")})(?=\\p{White_Space}|$)`, "iu");
// `./` followed by a path.
const DOT_SLASH = /^\.\/\P{White_Space}/u;
// Backticks pair from the left, so an empty pair is a span too.
const INLINE_CODE = /`([^`]*)`/g;
// Inline links and images. Inline code is masked with NUL first, so it can sit in the link text.
const LINK =
  /!?\[[^\]]*\]\(\p{White_Space}*(?:<([^<>\n\0]*)>|([^\p{White_Space}()<>\0]*))(?:\p{White_Space}+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\p{White_Space}*\)/gu;
// Two or more characters with no `.`, so `README.md:10` and `C:/x.md` are not schemes.
const SCHEME = /^[A-Za-z][A-Za-z0-9+-]+:/;
const PROMPT = /^\$\p{White_Space}+/u;
const PRE_RUNNER = /^[("'*_]+/;
const CLAUSE_END = /[.,;:!?)]["'*_]*$/;
const COMMAND_TAIL = /[.,;:!?)"'*_]+$/;
// Fences as the Guidance Block parser finds them (DM §7), after any container is removed.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCK_QUOTE = /^ {0,3}>/;
const QUOTE_MARKER = /^ {0,3}> ?/;
const LIST_MARKER = /^( {0,3}(?:[-+*]|[0-9]{1,9}[.)]))([ \t]*)/;

function trim(text: string): string {
  return text.replace(EDGES, "");
}

function isPathLike(span: string): boolean {
  if (WHITESPACE.test(span) || span.includes("://")) return false;
  if (span.includes("/") || FILE_NAMES.has(span)) return true;
  const dot = span.lastIndexOf(".");
  return dot >= 0 && EXTENSIONS.has(span.slice(dot + 1));
}

/**
 * A bare word as a path token: punctuation, then emphasis around it, removed (§3.4). Path-like as
 * §3.2.3 defines it, or naming a known file without a `/`, as `package.json` and `Makefile` do.
 */
function barePath(word: string): string | undefined {
  let token = stripTokenPunctuation(word);
  for (;;) {
    const first = token.charAt(0);
    if (token.length < 2 || (first !== "*" && first !== "_") || !token.endsWith(first)) break;
    token = stripTokenPunctuation(token.slice(1, -1));
  }
  if (token.includes("://") || WHITESPACE.test(token)) return undefined;
  if (barePathToken(token) !== undefined || isKnownFile(token)) return token;
  return undefined;
}

/**
 * The last segment is a known file name, or a name ending in a known extension with something
 * before the dot and no `*`, as at the root (1.2.0). So `.js` and `*.test.ts` are not files.
 */
function isKnownFile(token: string): boolean {
  const last = token.slice(token.lastIndexOf("/") + 1);
  if (FILE_NAMES.has(last)) return true;
  const dot = last.lastIndexOf(".");
  return dot > 0 && !last.includes("*") && EXTENSIONS.has(last.slice(dot + 1));
}

/** Classifies an inline code span, or a fenced line, after trimming it (§3.4). */
export function classifySpan(span: string): ReferenceKind | "identifier" {
  const text = trim(span);
  if (RUNNER.test(text) || DOT_SLASH.test(text)) {
    // Trimmed, so any whitespace follows the runner.
    if (WHITESPACE.test(text)) return "command";
    return isPathLike(text) ? "path" : "command";
  }
  return isPathLike(text) ? "path" : "identifier";
}

/** Lines with their line endings, so prose keeps its text as written. */
function linesOf(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function withoutEnding(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/, "");
}

/** The lines of a fenced code block between its fences; the closing fence may be missing. */
function fencedLines(lines: readonly string[]): string[] | undefined {
  const open = FENCE_OPEN.exec(lines[0] ?? "")?.[1];
  if (open === undefined) return undefined;
  const inner = lines.slice(1).map(withoutEnding);
  const close = FENCE_CLOSE.exec(inner.at(-1) ?? "")?.[1];
  if (close !== undefined && close.charAt(0) === open.charAt(0) && close.length >= open.length) {
    inner.pop();
  }
  return inner;
}

/**
 * A list item's content without its marker and indentation (CommonMark): the content column
 * follows one to four spaces after the marker, or one when there are more, so that the content
 * starts with an indented code block, or none.
 */
function listItemContent(lines: readonly string[]): string {
  const first = lines[0] ?? "";
  const match = LIST_MARKER.exec(first);
  if (match === null) return lines.join("");
  const marker = match[1] ?? "";
  const gap = match[2] ?? "";
  const rest = first.slice(match[0].length);
  const width = withoutEnding(rest) === "" || gap.length > 4 || gap.includes("\t") ? 1 : gap.length;
  const column = marker.length + width;
  const strip = new RegExp(`^ {0,${column}}`);
  return [first.slice(column), ...lines.slice(1).map((line) => line.replace(strip, ""))].join("");
}

interface Event {
  readonly at: number;
  readonly reference?: DetectedReference;
  readonly identifier?: DetectedIdentifier;
}

/**
 * Finds the references in recommendation content (§3.4). The content is split into Guidance
 * Blocks (DM §7), and the content of a list item or block quote is split again, so nested
 * blocks count as they would at the top level. Inline code spans pair within one block. Fenced
 * lines give commands only, indented code blocks give nothing, and bare text gives link targets,
 * plain-text commands, and path-like tokens and known file names that aren't URLs.
 */
export function detectReferences(content: string): Detection {
  const references: DetectedReference[] = [];
  const identifiers: DetectedIdentifier[] = [];

  /** Bare text with no inline code or link in it: commands and path tokens, line by line. */
  const bare = (text: string, offset: number, events: Event[]): void => {
    for (const line of text.matchAll(/[^\r\n]+/g)) {
      const words = [...line[0].matchAll(WORDS)];
      for (let i = 0; i < words.length; i++) {
        const word = words[i] as RegExpExecArray;
        const at = offset + line.index + word.index;
        const lead = PRE_RUNNER.exec(word[0])?.[0].length ?? 0;
        if (PROSE.has(word[0].slice(lead)) && i + 1 < words.length) {
          let last = i + 1;
          while (last + 1 < words.length && !CLAUSE_END.test((words[last] as RegExpExecArray)[0])) {
            last++;
          }
          const end =
            (words[last] as RegExpExecArray).index + (words[last] as RegExpExecArray)[0].length;
          const value = line[0].slice(word.index + lead, end).replace(COMMAND_TAIL, "");
          if (WHITESPACE.test(value)) {
            events.push({ at, reference: { kind: "command", value, match: trim(value) } });
            i = last;
            continue;
          }
        }
        const path = barePath(word[0]);
        if (path !== undefined)
          events.push({ at, reference: { kind: "path", value: path, match: path } });
      }
    }
  };

  const target = (raw: string, at: number, events: Event[]): void => {
    if (raw === "") return;
    if (SCHEME.test(raw)) {
      events.push({ at, identifier: { value: raw, match: raw } });
      return;
    }
    const match = raw.split("#")[0] ?? "";
    if (match !== "") events.push({ at, reference: { kind: "path", value: raw, match } });
  };

  const prose = (text: string): void => {
    const events: Event[] = [];
    // Ranges that end bare text: inline code spans and link syntax around the link text.
    const cuts: { start: number; end: number }[] = [];
    let masked = text;
    for (const span of text.matchAll(INLINE_CODE)) {
      const start = span.index;
      const end = start + span[0].length;
      cuts.push({ start, end });
      masked = masked.slice(0, start) + "\0".repeat(end - start) + masked.slice(end);
      const value = span[1] ?? "";
      const match = trim(value);
      if (match === "") continue;
      const kind = classifySpan(match);
      events.push(
        kind === "identifier"
          ? { at: start, identifier: { value, match } }
          : { at: start, reference: { kind, value, match } },
      );
    }
    for (const link of masked.matchAll(LINK)) {
      const start = link.index;
      const end = start + link[0].length;
      const textStart = start + (link[0].startsWith("!") ? 2 : 1);
      const close = masked.lastIndexOf("](", end);
      cuts.push({ start, end: textStart }, { start: close, end });
      const raw = link[1] ?? link[2] ?? "";
      target(raw, start + link[0].indexOf(raw, close - start), events);
    }
    cuts.sort((a, b) => a.start - b.start);
    let last = 0;
    for (const cut of cuts) {
      if (cut.start > last) bare(text.slice(last, cut.start), last, events);
      last = Math.max(last, cut.end);
    }
    bare(text.slice(last), last, events);
    // Stable, so events at one position keep the order they were found in.
    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.reference !== undefined) references.push(event.reference);
      if (event.identifier !== undefined) identifiers.push(event.identifier);
    }
  };

  walkBlocks(content, (block) => {
    if (block.kind === "code") {
      for (const value of fencedLines(block.lines) ?? []) {
        const match = trim(value).replace(PROMPT, "");
        if (match !== "" && classifySpan(match) === "command") {
          references.push({ kind: "command", value, match });
        }
      }
    } else prose(block.text);
  });
  return { references, identifiers };
}

/** A block of content as the detector reads it: code lines, or prose text with its type. */
export type ContentBlock =
  | { readonly kind: "code"; readonly lines: readonly string[] }
  | { readonly kind: "prose"; readonly type: BlockType; readonly text: string };

/**
 * Content split into Guidance Blocks (DM §7), with a list item's content, after its marker and
 * indentation, and a block quote's, after its `>` markers, split again the same way (§3.4).
 */
export function walkBlocks(content: string, visit: (block: ContentBlock) => void): void {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const walk = (text: string): void => {
    const bytes = new TextEncoder().encode(text);
    // A failed round trip gives one `other` block over the whole text, read as prose.
    for (const block of parseGuidanceBlocks(bytes).blocks) {
      const { start, end } = block.sourceSpan;
      const lines = linesOf(decoder.decode(bytes.subarray(start, end)));
      if (block.type === "code_block") visit({ kind: "code", lines });
      else if (block.type === "list_item") walk(listItemContent(lines));
      else if (block.type === "other" && BLOCK_QUOTE.test(lines[0] ?? ""))
        walk(lines.map((line) => line.replace(QUOTE_MARKER, "")).join(""));
      else visit({ kind: "prose", type: block.type, text: lines.join("") });
    }
  };
  walk(content);
}
