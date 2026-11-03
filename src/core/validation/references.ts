import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { barePathToken } from "./support.js";

// The reference detector (IMPL §3.4): finds the paths and commands that recommendation content
// mentions, so `REF-001` can check they are declared. Deliberately conservative: content it
// can't classify is left alone, not guessed at.

/** Changes whenever what the detector finds changes, including any of the lists below. */
export const DETECTOR_VERSION = "references/1.0.0";

/** Words that start a command, each matched as a whole word. */
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
  /** The span or line as written. */
  readonly value: string;
}

export interface Detection {
  /** In document order, every occurrence. */
  readonly references: readonly DetectedReference[];
  /** Inline code spans that are neither, URLs included, for `REF-005`. In document order. */
  readonly identifiers: readonly string[];
}

const EXTENSIONS: ReadonlySet<string> = new Set(KNOWN_FILE_EXTENSIONS);
const FILE_NAMES: ReadonlySet<string> = new Set(KNOWN_FILE_NAMES);
const WHITESPACE = /\s/;
// A runner is a whole word: followed by whitespace or the end of the span.
const RUNNER = new RegExp(`^(?:${RUNNERS.join("|")})(?=\\s|$)`);
// `./` followed by a path.
const DOT_SLASH = /^\.\/\S/;
// Backticks pair from the left, so an empty pair is a span too.
const INLINE_CODE = /`([^`]*)`/g;
// Fences as the Guidance Block parser finds them (DM §7), after any container is removed.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCK_QUOTE = /^ {0,3}>/;
const QUOTE_MARKER = /^ {0,3}> ?/;
const LIST_MARKER = /^( {0,3}(?:[-+*]|[0-9]{1,9}[.)]))([ \t]*)/;

function isPathLike(span: string): boolean {
  if (WHITESPACE.test(span) || span.includes("://")) return false;
  if (span.includes("/") || FILE_NAMES.has(span)) return true;
  const dot = span.lastIndexOf(".");
  return dot >= 0 && EXTENSIONS.has(span.slice(dot + 1));
}

/** Classifies an inline code span, or a trimmed fenced line, as written (§3.4). */
export function classifySpan(span: string): ReferenceKind | "identifier" {
  if (RUNNER.test(span) || DOT_SLASH.test(span)) {
    const rest = span.slice(span.search(/\s|$/));
    if (WHITESPACE.test(rest)) return "command";
    return isPathLike(span) ? "path" : "command";
  }
  return isPathLike(span) ? "path" : "identifier";
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

/**
 * Finds the references in recommendation content (§3.4). The content is split into Guidance
 * Blocks (DM §7), and the content of a list item or block quote is split again, so nested
 * blocks count as they would at the top level. Inline code spans pair within one block. Fenced
 * lines give commands only, indented code blocks give nothing, and bare text gives path-like
 * tokens that aren't URLs.
 */
export function detectReferences(content: string): Detection {
  const references: DetectedReference[] = [];
  const identifiers: string[] = [];
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  const bare = (text: string): void => {
    for (const word of text.split(/\s+/)) {
      const token = barePathToken(word);
      if (token !== undefined && !token.includes("://")) {
        references.push({ kind: "path", value: token });
      }
    }
  };

  const prose = (text: string): void => {
    let last = 0;
    for (const match of text.matchAll(INLINE_CODE)) {
      bare(text.slice(last, match.index));
      last = match.index + match[0].length;
      const span = match[1] ?? "";
      const kind = classifySpan(span);
      if (kind === "identifier") identifiers.push(span);
      else references.push({ kind, value: span });
    }
    bare(text.slice(last));
  };

  const walk = (text: string): void => {
    const bytes = new TextEncoder().encode(text);
    // A failed round trip gives one `other` block over the whole text, read as prose.
    for (const block of parseGuidanceBlocks(bytes).blocks) {
      const { start, end } = block.sourceSpan;
      const lines = linesOf(decoder.decode(bytes.subarray(start, end)));
      if (block.type === "code_block") {
        for (const line of fencedLines(lines) ?? []) {
          const value = line.trim();
          if (value !== "" && classifySpan(value) === "command") {
            references.push({ kind: "command", value });
          }
        }
      } else if (block.type === "list_item") {
        walk(listItemContent(lines));
      } else if (block.type === "other" && BLOCK_QUOTE.test(lines[0] ?? "")) {
        walk(lines.map((line) => line.replace(QUOTE_MARKER, "")).join(""));
      } else {
        prose(lines.join(""));
      }
    }
  };

  walk(content);
  return { references, identifiers };
}
