import {
  type ByteSpan,
  isBlank,
  type Line,
  splitBlocks,
  splitLines,
} from "../destination/guidance-blocks.js";
import type { Hash } from "../hash.js";
import { cutLabel, findDeclarations } from "./declarations.js";
import { escapeDelimiters } from "./escape.js";

// Excerpting and item rendering (IMPL §1.6).
//
// A file is rendered in full when that fits the limit. Otherwise parts are added in file order
// while the rendered item, header and outline included, still fits. Sizes are computed from
// per-line byte counts so each attempt costs little; the final text is measured again.

/**
 * `none` never excerpts (tier 1), `markdown` keeps sections (tier 2), `lines` keeps whole lines
 * from the start (tier 3), and `code` keeps declarations (tier 5), or whole lines when none are
 * detected.
 */
export type ExcerptStrategy = "none" | "markdown" | "code" | "lines";

export interface ItemInput {
  /** `T<tier>-<sequence>`. */
  readonly id: string;
  readonly path: string;
  readonly hash: Hash;
  readonly tier: number;
  readonly reason: string;
  /** The file's bytes, valid UTF-8 and already verified against `hash`. */
  readonly content: Uint8Array;
  /** The destination's Guidance Blocks, rendered in a BLOCKS section (IMPL §1.5). */
  readonly blocks?: readonly BlockLines[];
}

/** A Guidance Block's ID and the lines it covers. */
export interface BlockLines {
  readonly first: number;
  readonly last: number;
  readonly id: string;
}

/** 1-based, inclusive. */
export interface LineRange {
  readonly first: number;
  readonly last: number;
}

export type OutlineMark = "included" | "omitted" | "truncated";

export interface OutlineEntry {
  readonly line: number;
  readonly label: string;
  readonly mark: OutlineMark;
  /** The label before it was cut, only when it was cut. Never rendered; the secret scan reads it. */
  readonly uncutLabel?: string;
}

export interface RenderedItem {
  readonly text: string;
  /** UTF-8 bytes of `text`. */
  readonly bytes: number;
  readonly excerpt: boolean;
  /** The lines sent, in order, with adjacent ranges merged. */
  readonly included: readonly LineRange[];
  readonly totalLines: number;
  /** Empty for a full item. */
  readonly outline: readonly OutlineEntry[];
}

/** The item for `input` within `limitBytes`, or undefined when not even one line fits. */
export function renderItem(
  input: ItemInput,
  strategy: ExcerptStrategy,
  limitBytes: number,
): RenderedItem | undefined {
  const layout = new Layout(input);
  const n = layout.lines.length;
  const full = layout.finish(n === 0 ? [] : [{ first: 1, last: n }], undefined, limitBytes);
  if (full !== undefined || strategy === "none" || n === 0) return full;
  if (strategy === "markdown") return markdownExcerpt(layout, limitBytes);
  if (strategy === "code") {
    const declarations = findDeclarations(input.path, layout.lines);
    if (declarations !== undefined && declarations.length > 0) {
      const units: Unit[] = [];
      const first = declarations[0]?.start ?? 1;
      // An import block of blank lines has no outline entry and is not sent, like a blank
      // Markdown preamble.
      if (layout.lines.slice(0, first - 1).some((text) => !isBlank(text))) {
        units.push({ first: 1, last: first - 1, label: "imports" });
      }
      declarations.forEach((declaration, index) => {
        const next = declarations[index + 1];
        const last = next === undefined ? n : next.start - 1;
        units.push({
          first: declaration.start,
          last,
          label: declaration.label,
          ...optionalUncut(declaration.uncutLabel),
        });
      });
      return codeExcerpt(layout, units, limitBytes);
    }
  }
  return linesExcerpt(layout, limitBytes);
}

interface Unit {
  readonly first: number;
  readonly last: number;
  readonly label: string;
  readonly uncutLabel?: string;
}

/** An outline label as entered: its text, and its uncut text when that differs. */
interface Label {
  readonly line: number;
  readonly label: string;
  readonly uncutLabel?: string;
}

function optionalUncut(uncutLabel: string | undefined): { uncutLabel?: string } {
  return uncutLabel === undefined ? {} : { uncutLabel };
}

/**
 * The lines each block covers. A span starting in the BOM, before line 1, starts at line 1.
 * A block's end is exclusive and never includes its final line ending (DM §7).
 */
export function blockRanges(
  content: Uint8Array,
  blocks: readonly { readonly blockId: string; readonly sourceSpan: ByteSpan }[],
): BlockLines[] {
  const starts = splitLines(content).map((line) => line.start);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  return blocks.map((block) => ({
    first: lineAt(block.sourceSpan.start),
    last: lineAt(Math.max(block.sourceSpan.start, block.sourceSpan.end - 1)),
    id: block.blockId,
  }));
}

const OMITTED = " [omitted]";
const TRUNCATED = " [truncated]";
const GAP = " …\n";
// Each line is decoded on its own; the file's BOM is already skipped, and a U+FEFF that starts a
// later line is content.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function formatRange(range: LineRange): string {
  return range.first === range.last ? `${range.first}` : `${range.first}-${range.last}`;
}

function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map(formatRange).join(",");
}

function quote(value: string): string {
  return escapeDelimiters(JSON.stringify(value));
}

/** Line texts and the byte sizes of their rendered forms. */
class Layout {
  readonly raw: Line[];
  readonly lines: string[];
  readonly width: number;
  /** `prefix[k]`: bytes of rendered lines 1..k. */
  readonly prefix: number[];
  readonly input: ItemInput;
  /** The BLOCKS section, or "" when the item has no blocks. */
  readonly blocksText: string;

  constructor(input: ItemInput) {
    this.input = input;
    this.raw = splitLines(input.content);
    this.lines = this.raw.map((line) => utf8.decode(input.content.subarray(line.start, line.end)));
    this.width = Math.max(4, `${this.lines.length}`.length);
    this.prefix = [0];
    this.lines.forEach((_, index) => {
      this.prefix.push((this.prefix[index] ?? 0) + byteLength(this.contentLine(index + 1)));
    });
    this.blocksText =
      input.blocks === undefined
        ? ""
        : `BLOCKS\n${input.blocks
            .map((block) => `${formatRange(block).padStart(this.width, " ")} ${quote(block.id)}\n`)
            .join("")}`;
  }

  pad(line: number): string {
    return `${line}`.padStart(this.width, " ");
  }

  contentLine(line: number): string {
    const text = this.lines[line - 1] ?? "";
    return `${this.pad(line)} |${text === "" ? "" : ` ${escapeDelimiters(text)}`}\n`;
  }

  outlineLine(entry: OutlineEntry): string {
    const suffix = entry.mark === "omitted" ? OMITTED : entry.mark === "truncated" ? TRUNCATED : "";
    return `${this.pad(entry.line)} ${escapeDelimiters(entry.label)}${suffix}\n`;
  }

  header(excerpt: boolean, ranges: readonly LineRange[]): string {
    const { id, path, hash, tier, reason } = this.input;
    return (
      `<<<ITEM id=${id} path=${quote(path)} hash=${quote(hash)}\n` +
      `        tier=${tier} reason=${quote(reason)} excerpt=${excerpt}\n` +
      `        included=${quote(formatRanges(ranges))} totalLines=${this.lines.length}>>>\n`
    );
  }

  /** Bytes of the item with `ranges` included and an outline of `outlineBytes`. */
  size(ranges: readonly LineRange[], outlineBytes: number | undefined): number {
    let content = 0;
    for (const range of ranges) {
      content += (this.prefix[range.last] ?? 0) - (this.prefix[range.first - 1] ?? 0);
    }
    return (
      byteLength(this.header(outlineBytes !== undefined, ranges)) +
      (outlineBytes === undefined ? 0 : byteLength("OUTLINE\n") + outlineBytes) +
      byteLength(this.blocksText) +
      byteLength("CONTENT\n") +
      content +
      gapCount(ranges, this.lines.length) * byteLength(GAP) +
      byteLength(`<<<END ${this.input.id}>>>\n`)
    );
  }

  /** The rendered item, or undefined if it exceeds the limit. No outline means a full item. */
  finish(
    ranges: readonly LineRange[],
    outline: readonly OutlineEntry[] | undefined,
    limitBytes: number,
  ): RenderedItem | undefined {
    if (outline !== undefined && ranges.length === 0) return undefined;
    const excerpt = outline !== undefined;
    let text = this.header(excerpt, ranges);
    if (outline !== undefined)
      text += `OUTLINE\n${outline.map((e) => this.outlineLine(e)).join("")}`;
    text += this.blocksText;
    text += "CONTENT\n";
    let next = 1;
    for (const range of ranges) {
      if (range.first > next) text += GAP;
      for (let line = range.first; line <= range.last; line++) text += this.contentLine(line);
      next = range.last + 1;
    }
    if (ranges.length > 0 && next <= this.lines.length) text += GAP;
    text += `<<<END ${this.input.id}>>>\n`;
    const bytes = byteLength(text);
    if (bytes > limitBytes) {
      if (excerpt) throw new Error(`excerpt of ${this.input.path} exceeds its limit`);
      return undefined;
    }
    return {
      text,
      bytes,
      excerpt,
      included: ranges,
      totalLines: this.lines.length,
      outline: outline ?? [],
    };
  }
}

function gapCount(ranges: readonly LineRange[], totalLines: number): number {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return 0;
  return (first.first > 1 ? 1 : 0) + (ranges.length - 1) + (last.last < totalLines ? 1 : 0);
}

/** Adds ranges in file order while the item still fits, tracking outline marks. */
class Selection {
  readonly ranges: LineRange[] = [];
  readonly marks: OutlineMark[];
  private outlineBytes: number;

  private readonly layout: Layout;
  private readonly entries: readonly Label[];
  private readonly limitBytes: number;

  constructor(layout: Layout, entries: readonly Label[], limitBytes: number) {
    this.layout = layout;
    this.entries = entries;
    this.limitBytes = limitBytes;
    this.marks = entries.map(() => "omitted");
    this.outlineBytes = entries.reduce(
      (sum, entry) => sum + byteLength(layout.outlineLine({ ...entry, mark: "omitted" })),
      0,
    );
  }

  /** Includes `range` and sets the marks if the item still fits. `range` follows every range so far. */
  tryAdd(range: LineRange, marks: readonly (readonly [number, OutlineMark])[]): boolean {
    const ranges = appendRange(this.ranges, range);
    let outlineBytes = this.outlineBytes;
    for (const [index, mark] of marks) {
      outlineBytes += this.markBytes(mark) - this.markBytes(this.marks[index] ?? "omitted");
    }
    if (this.layout.size(ranges, outlineBytes) > this.limitBytes) return false;
    this.ranges.splice(0, this.ranges.length, ...ranges);
    for (const [index, mark] of marks) this.marks[index] = mark;
    this.outlineBytes = outlineBytes;
    return true;
  }

  finish(): RenderedItem | undefined {
    const outline = this.entries.map((entry, index) => ({
      ...entry,
      mark: this.marks[index] ?? "omitted",
    }));
    return this.layout.finish(this.ranges, outline, this.limitBytes);
  }

  private markBytes(mark: OutlineMark): number {
    return mark === "omitted" ? OMITTED.length : mark === "truncated" ? TRUNCATED.length : 0;
  }
}

function appendRange(ranges: readonly LineRange[], range: LineRange): LineRange[] {
  const last = ranges[ranges.length - 1];
  if (last !== undefined && last.last + 1 === range.first) {
    return [...ranges.slice(0, -1), { first: last.first, last: range.last }];
  }
  return [...ranges, { first: range.first, last: range.last }];
}

function codeExcerpt(layout: Layout, units: readonly Unit[], limitBytes: number) {
  const selection = new Selection(
    layout,
    units.map((unit) => ({
      line: unit.first,
      label: unit.label,
      ...optionalUncut(unit.uncutLabel),
    })),
    limitBytes,
  );
  units.forEach((unit, index) => {
    selection.tryAdd(unit, [[index, "included"]]);
  });
  return selection.finish();
}

function linesExcerpt(layout: Layout, limitBytes: number): RenderedItem | undefined {
  const n = layout.lines.length;
  const outlineFor = (k: number): OutlineEntry[] => [
    { line: 1, label: `lines ${formatRange({ first: 1, last: k })}`, mark: "included" },
    { line: k + 1, label: `lines ${formatRange({ first: k + 1, last: n })}`, mark: "omitted" },
  ];
  const sizeFor = (k: number): number =>
    layout.size(
      [{ first: 1, last: k }],
      outlineFor(k).reduce((sum, entry) => sum + byteLength(layout.outlineLine(entry)), 0),
    );
  // The size grows with k, so find the largest k that fits.
  let low = 0;
  let high = n - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sizeFor(mid) <= limitBytes) low = mid;
    else high = mid - 1;
  }
  if (low === 0) return undefined;
  return layout.finish([{ first: 1, last: low }], outlineFor(low), limitBytes);
}

interface Section {
  /** Index into the outline entries. */
  readonly entry: number;
  /** The section with its subsections. */
  readonly whole: LineRange;
  /** The heading through the line before the first subheading. */
  readonly own: LineRange;
  readonly children: Section[];
}

function markdownExcerpt(layout: Layout, limitBytes: number): RenderedItem | undefined {
  const n = layout.lines.length;
  const lineAt = new Map(layout.raw.map((line, index) => [line.start, index + 1]));
  const headings = splitBlocks(layout.input.content).flatMap((block) =>
    block.type === "heading"
      ? [{ line: lineOf(lineAt, block.start), level: block.level, text: block.text }]
      : [],
  );

  const entries: Label[] = [];
  const roots: Section[] = [];
  const firstHeading = headings[0]?.line ?? n + 1;
  const preamble = layout.lines.slice(0, firstHeading - 1);
  if (preamble.some((text) => !isBlank(text))) {
    const range = { first: 1, last: firstHeading - 1 };
    entries.push({ line: 1, label: "preamble" });
    roots.push({ entry: 0, whole: range, own: range, children: [] });
  }
  const stack: { level: number; section: Section }[] = [];
  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    let end = n;
    for (const later of headings.slice(index + 1)) {
      if (later.level <= heading.level) {
        end = later.line - 1;
        break;
      }
    }
    const section: Section = {
      entry: entries.length,
      whole: { first: heading.line, last: end },
      own: { first: heading.line, last: next === undefined ? n : next.line - 1 },
      children: [],
    };
    const uncut = `${"#".repeat(heading.level)}${heading.text === "" ? "" : ` ${heading.text}`}`;
    const label = cutLabel(uncut);
    entries.push({
      line: heading.line,
      label,
      ...optionalUncut(label === uncut ? undefined : uncut),
    });
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(section);
    else parent.section.children.push(section);
    stack.push({ level: heading.level, section });
  });

  const selection = new Selection(layout, entries, limitBytes);
  let first = true;
  const all = (section: Section): [number, OutlineMark][] => [
    [section.entry, "included"],
    ...section.children.flatMap(all),
  ];
  const visit = (section: Section): void => {
    if (section.children.length > 0 && selection.tryAdd(section.whole, all(section))) {
      first = false;
      return;
    }
    if (!selection.tryAdd(section.own, [[section.entry, "included"]]) && first) {
      // Cut before the last blank line that lets the first unit fit.
      for (let blank = section.own.last; blank > section.own.first; blank--) {
        if (!isBlank(layout.lines[blank - 1] ?? "")) continue;
        const cut = { first: section.own.first, last: blank - 1 };
        if (selection.tryAdd(cut, [[section.entry, "truncated"]])) break;
      }
    }
    first = false;
    section.children.forEach(visit);
  };
  roots.forEach(visit);
  return selection.finish();
}

function lineOf(lineAt: ReadonlyMap<number, number>, start: number): number {
  const line = lineAt.get(start);
  if (line === undefined) throw new Error(`heading at byte ${start} does not start a line`);
  return line;
}
