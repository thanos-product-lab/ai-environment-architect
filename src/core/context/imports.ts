import { splitBlocks } from "../destination/guidance-blocks.js";

// `@path` imports in tier 1 Markdown (IMPL §1.5, tier 1).
//
// An import is `@` at the start of a line or after whitespace, followed by non-whitespace, with
// trailing punctuation and closing brackets or quotes removed. Imports in code blocks and inline
// code spans are ignored, as Claude Code ignores them.

const IMPORT = /(?:^|\s)@(\S+)/gmu;
const TRAILING = /[.,;:!?)\]}"']+$/u;

// The file's BOM is already outside every block.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** The imports in a Markdown file, as written, in file order. */
export function findImports(content: Uint8Array): string[] {
  const imports: string[] = [];
  // Whole blocks, because a code span can continue onto the next line.
  for (const block of splitBlocks(content)) {
    if (block.type === "code_block") continue;
    const text = withoutCodeSpans(utf8.decode(content.subarray(block.start, block.end)));
    for (const match of text.matchAll(IMPORT)) {
      const written = (match[1] ?? "").replace(TRAILING, "");
      if (written !== "") imports.push(written);
    }
  }
  return imports;
}

/** Replaces each inline code span with a space. A backtick run closes only with one of equal length. */
function withoutCodeSpans(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      result += text[index];
      index++;
      continue;
    }
    const length = runLength(text, index);
    let close = index + length;
    while (close < text.length) {
      if (text[close] === "`") {
        const run = runLength(text, close);
        if (run === length) break;
        close += run;
      } else close++;
    }
    if (close >= text.length) {
      // Unclosed: the run is text.
      result += text.slice(index, index + length);
      index += length;
    } else {
      result += " ";
      index = close + length;
    }
  }
  return result;
}

function runLength(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end++;
  return end - start;
}

export type ImportTarget =
  | { readonly inside: true; readonly path: string }
  /** Absolute, home-directory, or leaving the root. Never read. */
  | { readonly inside: false };

/** Resolves an import relative to the directory of `importer`, a repository-relative path. */
export function resolveImport(importer: string, written: string): ImportTarget {
  if (written.startsWith("/") || written.startsWith("~")) return { inside: false };
  const segments = importer.split("/").slice(0, -1);
  for (const segment of written.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { inside: false };
      segments.pop();
    } else segments.push(segment);
  }
  return { inside: true, path: segments.join("/") };
}
