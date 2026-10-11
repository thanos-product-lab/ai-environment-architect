import { type Hash, sha256 } from "../hash.js";

// Guidance Blocks (DM §7): a lossless, addressable parse of the destination `CLAUDE.md`.
//
// A small line-based subset of CommonMark, read on bytes. The structure is found on a latin1
// view of the file, where one character is one byte, so string offsets are byte offsets. Every
// marker the parser looks for is ASCII, and no UTF-8 multi-byte sequence contains an ASCII
// byte, so this finds the same structure as reading the decoded text.

export type BlockType = "heading" | "paragraph" | "list_item" | "code_block" | "other";

/** Byte offsets in the original file: `start` inclusive, `end` exclusive. */
export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

/** The exact indentation and marker of a list item's first line, such as `-` or `2.`. */
export interface ListMarker {
  readonly indent: string;
  readonly marker: string;
}

interface BlockFields {
  readonly blockId: string;
  /** Text of the enclosing headings, outermost first. A heading block's path excludes itself. */
  readonly headingPath: readonly string[];
  readonly sourceSpan: ByteSpan;
  /** SHA-256 of the block's exact bytes. */
  readonly hash: Hash;
}

export type GuidanceBlock =
  | (BlockFields & { readonly type: Exclude<BlockType, "list_item"> })
  | (BlockFields & { readonly type: "list_item"; readonly listMarker: ListMarker });

export type LineEndingStyle = "lf" | "crlf" | "cr" | "mixed" | "none";

export interface LineEndings {
  readonly style: LineEndingStyle;
  readonly counts: { readonly lf: number; readonly crlf: number; readonly cr: number };
}

export type RoundTripFailureReason =
  /** The splitter threw. */
  | "parser_error"
  /** Spans overlap, are out of order, are empty or run past the end of the file. */
  | "span_order"
  /** Bytes other than the BOM, spaces, tabs and line endings are outside every block. */
  | "content_outside_blocks"
  | "hash_mismatch"
  | "duplicate_block_id"
  | "rebuild_mismatch";

export type RoundTrip =
  | { readonly state: "verified" }
  | { readonly state: "failed"; readonly reason: RoundTripFailureReason };

export interface ParsedDestination {
  /**
   * In file order. If the round trip failed, one `other` block covering the whole file (none
   * for an empty file), and only additions in a new section at the end are allowed.
   */
  readonly blocks: readonly GuidanceBlock[];
  /** Assembly converts new content to this style (DM §9.3). */
  readonly lineEndings: LineEndings;
  readonly roundTrip: RoundTrip;
}

/** A block as the splitter finds it, before IDs and hashes are attached. */
export type RawBlock =
  | {
      readonly type: "heading";
      readonly start: number;
      readonly end: number;
      readonly level: number;
      readonly text: string;
    }
  | {
      readonly type: "list_item";
      readonly start: number;
      readonly end: number;
      readonly listMarker: ListMarker;
    }
  | {
      readonly type: "paragraph" | "code_block" | "other";
      readonly start: number;
      readonly end: number;
    };

export type BlockSplitter = (bytes: Uint8Array) => RawBlock[];

/**
 * Parses the destination's bytes into Guidance Blocks and verifies the round trip. Never throws.
 * The caller passes valid UTF-8 (other destinations are `unavailable`); invalid bytes only
 * affect heading text, which then contains U+FFFD.
 */
export function parseGuidanceBlocks(
  bytes: Uint8Array,
  split: BlockSplitter = splitBlocks,
): ParsedDestination {
  const lineEndings = countLineEndings(bytes);
  let blocks: GuidanceBlock[];
  try {
    blocks = assignIds(split(bytes), bytes);
  } catch {
    return fallback(bytes, lineEndings, "parser_error");
  }
  const roundTrip = verifyRoundTrip(bytes, blocks);
  return roundTrip.state === "verified"
    ? { blocks, lineEndings, roundTrip }
    : fallback(bytes, lineEndings, roundTrip.reason);
}

function fallback(
  bytes: Uint8Array,
  lineEndings: LineEndings,
  reason: RoundTripFailureReason,
): ParsedDestination {
  const blocks: GuidanceBlock[] =
    bytes.length === 0
      ? []
      : [
          {
            blockId: "other-1",
            type: "other",
            headingPath: [],
            sourceSpan: { start: 0, end: bytes.length },
            hash: sha256(bytes),
          },
        ];
  return { blocks, lineEndings, roundTrip: { state: "failed", reason } };
}

/**
 * Rebuilds the file from the bytes between blocks and each block's own bytes, and compares it
 * with the original byte for byte. Also checks span order, hashes, that nothing but the BOM,
 * spaces, tabs and line endings is outside a block, and that block IDs are unique.
 */
export function verifyRoundTrip(bytes: Uint8Array, blocks: readonly GuidanceBlock[]): RoundTrip {
  const failed = (reason: RoundTripFailureReason): RoundTrip => ({ state: "failed", reason });
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const { sourceSpan, hash } of blocks) {
    const { start, end } = sourceSpan;
    if (start < offset || end <= start || end > bytes.length) return failed("span_order");
    if (!isSeparator(bytes, offset, start)) return failed("content_outside_blocks");
    const own = bytes.subarray(start, end);
    if (sha256(own) !== hash) return failed("hash_mismatch");
    parts.push(bytes.subarray(offset, start), own);
    offset = end;
  }
  if (!isSeparator(bytes, offset, bytes.length)) return failed("content_outside_blocks");
  parts.push(bytes.subarray(offset));
  if (new Set(blocks.map((b) => b.blockId)).size !== blocks.length) {
    return failed("duplicate_block_id");
  }
  if (!Buffer.concat(parts).equals(bytes)) return failed("rebuild_mismatch");
  return { state: "verified" };
}

function isSeparator(bytes: Uint8Array, from: number, to: number): boolean {
  const bom = hasBom(bytes) ? 3 : 0;
  for (let i = Math.max(from, bom); i < to; i++) {
    const byte = bytes[i];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  return true;
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function countLineEndings(bytes: Uint8Array): LineEndings {
  const counts = { lf: 0, crlf: 0, cr: 0 };
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) counts.lf++;
    else if (bytes[i] === 0x0d) {
      if (bytes[i + 1] === 0x0a) {
        counts.crlf++;
        i++;
      } else counts.cr++;
    }
  }
  const used = (["lf", "crlf", "cr"] as const).filter((style) => counts[style] > 0);
  const style: LineEndingStyle =
    used.length === 0 ? "none" : used.length === 1 ? (used[0] ?? "none") : "mixed";
  return { style, counts };
}

// ---------------------------------------------------------------------------------------------
// Block IDs

const TYPE_TOKENS = {
  paragraph: "paragraph",
  list_item: "list-item",
  code_block: "code-block",
  other: "other",
} as const;

interface Section {
  readonly level: number;
  readonly segment: string;
  readonly text: string;
  /** Blocks of each type directly in this section. */
  readonly counts: Map<string, number>;
  /** Occurrences of each child heading segment, to suffix repeated siblings. */
  readonly children: Map<string, number>;
}

/**
 * `<segments>/<type>-<n>`, or `<segments>/heading` for the heading that opens a section. A
 * segment is the escaped heading text, suffixed `[k]` for the k-th sibling with the same text.
 */
function assignIds(raw: readonly RawBlock[], bytes: Uint8Array): GuidanceBlock[] {
  const newSection = (level: number, segment: string, text: string): Section => ({
    level,
    segment,
    text,
    counts: new Map(),
    children: new Map(),
  });
  const stack: Section[] = [newSection(0, "", "")];
  const top = (): Section => stack[stack.length - 1] as Section;
  const segments = (): string[] => stack.slice(1).map((s) => s.segment);
  const headingPath = (): string[] => stack.slice(1).map((s) => s.text);

  return raw.map((block): GuidanceBlock => {
    const sourceSpan = { start: block.start, end: block.end };
    const hash = sha256(bytes.subarray(block.start, block.end));
    if (block.type === "heading") {
      while (stack.length > 1 && top().level >= block.level) stack.pop();
      const path = headingPath();
      const parent = top();
      const base = escapeSegment(block.text);
      const occurrence = (parent.children.get(base) ?? 0) + 1;
      parent.children.set(base, occurrence);
      const segment = occurrence === 1 ? base : `${base}[${occurrence}]`;
      stack.push(newSection(block.level, segment, block.text));
      const blockId = [...segments(), "heading"].join("/");
      return { blockId, type: "heading", headingPath: path, sourceSpan, hash };
    }
    const section = top();
    const token = TYPE_TOKENS[block.type];
    const n = (section.counts.get(token) ?? 0) + 1;
    section.counts.set(token, n);
    const blockId = [...segments(), `${token}-${n}`].join("/");
    const common = { blockId, headingPath: headingPath(), sourceSpan, hash };
    return block.type === "list_item"
      ? { ...common, type: "list_item", listMarker: block.listMarker }
      : { ...common, type: block.type };
  });
}

/** Percent-encodes `%`, `/`, `[`, `]` and C0, DEL and C1 control characters. */
function escapeSegment(text: string): string {
  let escaped = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const encode = control || "%/[]".includes(char);
    escaped += encode ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : char;
  }
  return escaped;
}

// ---------------------------------------------------------------------------------------------
// Splitting

interface Line {
  /** Byte offset of the first byte. */
  readonly start: number;
  /** Byte offset of the line ending, or of the end of the file. */
  readonly end: number;
  /** The line's content, without its line ending, as latin1. */
  readonly text: string;
}

interface Fence {
  readonly char: string;
  readonly length: number;
}

const utf8 = new TextDecoder("utf-8");

/** The default splitter: a CommonMark subset (DM §7). */
export function splitBlocks(bytes: Uint8Array): RawBlock[] {
  const lines = splitLines(bytes);
  const blocks: RawBlock[] = [];
  const at = (index: number): Line => lines[index] as Line;
  const text = (index: number): string => at(index).text;
  const push = (type: "paragraph" | "code_block" | "other", first: number, last: number) =>
    blocks.push({ type, start: at(first).start, end: at(last).end });
  /** The last non-blank line in `first..last`; `first` is never blank. */
  const lastNonBlank = (first: number, last: number): number => {
    let index = last;
    while (index > first && isBlank(text(index))) index--;
    return index;
  };
  const decode = (index: number): string =>
    utf8.decode(bytes.subarray(at(index).start, at(index).end));

  let i = 0;
  const count = lines.length;

  // Front matter: `---` on the first line, closed by `---` or `...`, with no blank line between.
  if (count > 0 && text(0) === "---") {
    let close = 1;
    while (
      close < count &&
      text(close) !== "---" &&
      text(close) !== "..." &&
      !isBlank(text(close))
    ) {
      close++;
    }
    if (close < count && !isBlank(text(close))) {
      push("other", 0, close);
      i = close + 1;
    }
  }

  while (i < count) {
    const line = text(i);
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = fenceOpen(line);
    if (fence !== undefined) {
      let close = i + 1;
      while (close < count && !fenceCloses(text(close), fence)) close++;
      if (close < count) {
        push("code_block", i, close);
        i = close + 1;
      } else {
        push("code_block", i, lastNonBlank(i, count - 1));
        i = count;
      }
      continue;
    }

    const atx = ATX_HEADING.exec(line);
    if (atx !== null) {
      const level = (atx[1] ?? "").length;
      blocks.push({
        type: "heading",
        start: at(i).start,
        end: at(i).end,
        level,
        text: atxText(decode(i)),
      });
      i++;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      push("other", i, i);
      i++;
      continue;
    }

    const html = htmlStart(line);
    if (html !== undefined) {
      const { end } = html;
      if (end === undefined) {
        let next = i + 1;
        while (next < count && !isBlank(text(next))) next++;
        push("other", i, next - 1);
        i = next;
        continue;
      }
      let close = i;
      while (close < count && !end.test(text(close))) close++;
      if (close < count) {
        push("other", i, close);
        i = close + 1;
      } else {
        push("other", i, lastNonBlank(i, count - 1));
        i = count;
      }
      continue;
    }

    if (BLOCK_QUOTE.test(line)) {
      let next = i + 1;
      while (next < count) {
        const candidate = text(next);
        if (isBlank(candidate)) break;
        if (!BLOCK_QUOTE.test(candidate) && interruptsParagraph(candidate)) break;
        next++;
      }
      push("other", i, next - 1);
      i = next;
      continue;
    }

    const item = listItem(line);
    if (item !== undefined) {
      const last = listItemEnd(lines, i, item);
      blocks.push({
        type: "list_item",
        start: at(i).start,
        end: at(last).end,
        listMarker: { indent: item.indent, marker: item.marker },
      });
      i = last + 1;
      continue;
    }

    if (indentation(line) >= 4) {
      let next = i + 1;
      while (next < count && (isBlank(text(next)) || indentation(text(next)) >= 4)) next++;
      push("code_block", i, lastNonBlank(i, next - 1));
      i = next;
      continue;
    }

    if (i + 1 < count && line.includes("|") && TABLE_DELIMITER.test(text(i + 1))) {
      let next = i + 2;
      while (next < count && !isBlank(text(next)) && !interruptsParagraph(text(next))) next++;
      push("other", i, next - 1);
      i = next;
      continue;
    }

    // A paragraph, which becomes a setext heading if an underline follows.
    let next = i + 1;
    let underline: number | undefined;
    while (next < count) {
      const candidate = text(next);
      if (isBlank(candidate)) break;
      const setext = SETEXT_UNDERLINE.exec(candidate);
      if (setext !== null) {
        underline = (setext[1] ?? "").startsWith("=") ? 1 : 2;
        break;
      }
      if (interruptsParagraph(candidate)) break;
      next++;
    }
    if (underline !== undefined) {
      const words: string[] = [];
      for (let index = i; index < next; index++) words.push(trimSpaces(decode(index)));
      blocks.push({
        type: "heading",
        start: at(i).start,
        end: at(next).end,
        level: underline,
        text: words.join(" "),
      });
      i = next + 1;
    } else {
      push("paragraph", i, next - 1);
      i = next;
    }
  }
  return blocks;
}

/** Lines after the BOM. LF, CRLF and a lone CR each end a line. */
function splitLines(bytes: Uint8Array): Line[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const lines: Line[] = [];
  let start = hasBom(bytes) ? 3 : 0;
  while (start < view.length) {
    let end = start;
    while (end < view.length && view[end] !== "\n" && view[end] !== "\r") end++;
    lines.push({ start, end, text: view.slice(start, end) });
    if (end === view.length) break;
    start = view[end] === "\r" && view[end + 1] === "\n" ? end + 2 : end + 1;
  }
  return lines;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLOCK_QUOTE = /^ {0,3}>/;
const LIST_MARKER = /^( {0,3})([-+*]|[0-9]{1,9}[.)])(?=[ \t]|$)/;
const TABLE_DELIMITER =
  /^ {0,3}(?=[^|]*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function trimSpaces(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** The text of an ATX heading line: markers, surrounding spaces and closing sequence removed. */
function atxText(line: string): string {
  const content = trimSpaces(line.replace(/^ {0,3}#{1,6}/, ""));
  if (/^#+$/.test(content)) return "";
  return trimSpaces(content.replace(/[ \t]+#+$/, ""));
}

/** Leading indentation in columns; a tab advances to the next multiple of 4. */
function indentation(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns++;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** Removes up to `columns` columns of leading indentation. */
function stripColumns(line: string, columns: number): string {
  let used = 0;
  let index = 0;
  while (index < line.length && used < columns) {
    if (line[index] === " ") used++;
    else if (line[index] === "\t") used += 4 - (used % 4);
    else break;
    index++;
  }
  return line.slice(index);
}

function fenceOpen(line: string): Fence | undefined {
  const match = FENCE.exec(line);
  if (match === null) return undefined;
  const marker = match[1] ?? "";
  if (marker.startsWith("`") && (match[2] ?? "").includes("`")) return undefined;
  return { char: marker.charAt(0), length: marker.length };
}

function fenceCloses(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  const marker = match?.[1];
  return marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length;
}

interface ListItemStart {
  readonly indent: string;
  readonly marker: string;
  /** The column where the item's content starts. */
  readonly contentColumn: number;
  /** The first line has nothing after the marker. */
  readonly empty: boolean;
  /** The first line's content after the marker. */
  readonly content: string;
  /** The content is indented 5 or more columns past the marker, so it starts as indented code. */
  readonly codeStart: boolean;
}

function listItem(line: string): ListItemStart | undefined {
  const match = LIST_MARKER.exec(line);
  if (match === null) return undefined;
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  const markerEnd = indent.length + marker.length;
  const rest = line.slice(markerEnd);
  const content = rest.replace(/^[ \t]+/, "");
  const empty = content.length === 0;
  let spacing = 0;
  for (const char of rest) {
    if (char === " ") spacing++;
    else if (char === "\t") spacing += 4 - ((markerEnd + spacing) % 4);
    else break;
  }
  // Content indented 5 or more columns past the marker starts as indented code, one column in.
  const codeStart = !empty && spacing > 4;
  const contentColumn = markerEnd + (empty || codeStart ? 1 : spacing);
  return { indent, marker, contentColumn, empty, content, codeStart };
}

/**
 * Whether a line that starts a block opens a paragraph, which later lines may continue lazily.
 * Indented code, fences, headings, breaks, HTML and empty list items do not.
 */
function opensParagraph(line: string): boolean {
  if (isBlank(line) || indentation(line) >= 4) return false;
  if (fenceOpen(line) !== undefined || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line)) {
    return false;
  }
  if (htmlStart(line) !== undefined) return false;
  const quote = BLOCK_QUOTE.exec(line);
  if (quote !== null) return opensParagraph(line.slice(quote[0].length).replace(/^ /, ""));
  const item = listItem(line);
  if (item !== undefined) return !item.empty && !item.codeStart && opensParagraph(item.content);
  return true;
}

interface HtmlStart {
  /** The line that ends the block contains a match; when undefined, a blank line ends it. */
  readonly end?: RegExp;
  /** Whether the block can interrupt a paragraph. Only CommonMark type 7 can't. */
  readonly interrupts: boolean;
}

const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|" +
  "dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|" +
  "header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|" +
  "param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/** CommonMark HTML block start conditions, types 1 to 7, in order. */
const HTML_STARTS: readonly (HtmlStart & { readonly start: RegExp })[] = [
  {
    start: /^ {0,3}<(?:pre|script|style|textarea)(?=[ \t>]|$)/i,
    end: /<\/(?:pre|script|style|textarea)>/i,
    interrupts: true,
  },
  { start: /^ {0,3}<!--/, end: /-->/, interrupts: true },
  { start: /^ {0,3}<\?/, end: /\?>/, interrupts: true },
  { start: /^ {0,3}<![A-Za-z]/, end: />/, interrupts: true },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, interrupts: true },
  {
    start: new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?=[ \\t>]|/>|$)`, "i"),
    interrupts: true,
  },
  {
    // A line holding only one complete open or closing tag.
    start:
      /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/,
    interrupts: false,
  },
];

function htmlStart(line: string): HtmlStart | undefined {
  return HTML_STARTS.find(({ start }) => start.test(line));
}

/** Whether a line can end a paragraph, or the lazy continuation of one. */
function interruptsParagraph(line: string): boolean {
  if (ATX_HEADING.test(line) || fenceOpen(line) !== undefined || THEMATIC_BREAK.test(line)) {
    return true;
  }
  if (BLOCK_QUOTE.test(line) || htmlStart(line)?.interrupts === true) return true;
  const item = listItem(line);
  if (item === undefined || item.empty) return false;
  return !/^[0-9]/.test(item.marker) || /^0*1[.)]$/.test(item.marker);
}

/**
 * The last line of a top-level list item. The item includes lines indented to its content
 * column (nested items, continuation and code), blank lines between them, and lazy
 * continuation lines of an open paragraph.
 */
function listItemEnd(lines: readonly Line[], first: number, item: ListItemStart): number {
  const firstIsText = !item.empty && !item.codeStart;
  let fence = firstIsText ? fenceOpen(item.content) : undefined;
  let paragraphOpen = firstIsText && opensParagraph(item.content);
  let afterBlank = false;
  let last = first;
  for (let index = first + 1; index < lines.length; index++) {
    const line = (lines[index] as Line).text;
    if (isBlank(line)) {
      afterBlank = true;
      paragraphOpen = false;
      continue;
    }
    if (indentation(line) >= item.contentColumn) {
      const inner = stripColumns(line, item.contentColumn);
      if (fence !== undefined) {
        if (fenceCloses(inner, fence)) fence = undefined;
        paragraphOpen = false;
      } else if (paragraphOpen && SETEXT_UNDERLINE.test(inner)) {
        paragraphOpen = false;
      } else {
        fence = fenceOpen(inner);
        paragraphOpen =
          fence === undefined &&
          ((paragraphOpen && !interruptsParagraph(inner)) || opensParagraph(inner));
      }
      last = index;
      afterBlank = false;
      continue;
    }
    const lazy =
      !afterBlank &&
      fence === undefined &&
      paragraphOpen &&
      !interruptsParagraph(line) &&
      listItem(line) === undefined;
    if (!lazy) break;
    last = index;
  }
  return last;
}
