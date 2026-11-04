import {
  type BlockType,
  type ByteSpan,
  type GuidanceBlock,
  type LineEndings,
  type ParsedDestination,
  parseGuidanceBlocks,
} from "../destination/guidance-blocks.js";
import { type Hash, sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";

// Assembly (DM §9.3): the accepted recommendation revisions applied to the captured destination,
// deterministically, by code. A pure function over the parsed destination and the revisions.

/** One captured block: its ID and hash in the destination being assembled. */
export interface BlockRef {
  readonly blockId: string;
  readonly blockHash: Hash;
}

/** DM §9.1 targets, resolved to blocks by code. */
export type AssemblyTarget =
  /** `revise`, `remove`. */
  | ({ readonly kind: "block" } & BlockRef)
  /** `add` directly after the block. */
  | ({ readonly kind: "after" } & BlockRef)
  /** `add` after the section's own blocks; the ref names its heading block. */
  | ({ readonly kind: "section" } & BlockRef)
  /** `add` a new section; `after` names a heading block. */
  | { readonly kind: "newSection"; readonly heading: string; readonly after?: BlockRef };

export type Operation = "add" | "revise" | "remove";

/** An accepted recommendation revision, as assembly needs it. */
export interface AssemblyRevision {
  readonly revisionId: string;
  /** The `seq` of the recommendation's first revision: the order of additions at one position. */
  readonly firstSeq: number;
  readonly operation: Operation;
  readonly target: AssemblyTarget;
  readonly content?: string;
}

export type AssemblyDestination =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly bytes: Uint8Array; readonly parsed: ParsedDestination };

/** DM §9.4: one entry per change, in file order. */
export interface AttributionEntry {
  readonly revisionId: string;
  readonly operation: Operation;
  /** `revise` and `remove`: the original block; one entry per removed block of a section. */
  readonly originalBlockId?: string;
  /** New content: its bytes in the proposed content. */
  readonly proposedSpan?: ByteSpan;
}

/** The check that failed (DM §9.3 step 6, and the resolution before it). */
export type AssemblyCheck =
  /** The target names no block with that ID and hash, or a `section` or `after` heading isn't one. */
  | "target"
  /** The operation doesn't fit its target and content, or isn't allowed after a failed round trip. */
  | "operation"
  /** The content has no block, or doesn't parse with a verified round trip on its own. */
  | "content"
  /** The content's block types don't fit the revision, or a heading isn't revised as one ATX
   * line of the same level (DM §9.1). */
  | "types"
  /** Two revisions share a revision ID, so one couldn't be attributed exactly once. */
  | "duplicate_revision"
  /** Two revisions change one block. Selection's mutual exclusion should prevent it (DM §9.1). */
  | "one_change_per_block"
  /** The assembled file doesn't parse back into the untouched blocks and the new ones. */
  | "reparse";

export type AssemblyFailure =
  /** Revisions that pass alone but can't be combined: the developer rejects one (DM §9.4). */
  | { readonly kind: "conflict"; readonly revisionId: string; readonly conflictsWith: string }
  | {
      readonly kind: "internal_error";
      readonly check: AssemblyCheck;
      readonly revisionIds: readonly string[];
    };

export type AssemblyResult =
  | {
      readonly ok: true;
      readonly content: Uint8Array;
      readonly hash: Hash;
      readonly attribution: readonly AttributionEntry[];
    }
  | { readonly ok: false; readonly failure: AssemblyFailure };

/**
 * Assembles the accepted revisions into the destination (DM §9.3). When the revisions fail
 * together, they are added one at a time in the order of step 3, and the first whose addition
 * fails is named with the earlier revision whose removal lets the rest pass (DM §9.4). A revision
 * that fails alone, and any other failure, is an internal error.
 */
export function assemble(
  destination: AssemblyDestination,
  revisions: readonly AssemblyRevision[],
): AssemblyResult {
  const file = describe(destination);
  const seen = new Set<string>();
  for (const { revisionId } of [...revisions].sort(bySeq)) {
    if (seen.has(revisionId)) return internal("duplicate_revision", [revisionId]);
    seen.add(revisionId);
  }
  const prepared: Prepared[] = [];
  for (const revision of [...revisions].sort(bySeq)) {
    const result = prepare(file, revision);
    if ("check" in result) return internal(result.check, [revision.revisionId]);
    prepared.push(result);
  }
  prepared.sort(byPosition);

  const overlap = findOverlap(prepared);
  if (overlap !== undefined) return internal("one_change_per_block", overlap);

  const all = build(file, prepared);
  if (all.ok) return all;
  for (const one of prepared) {
    const alone = build(file, [one]);
    if (!alone.ok) return internal(alone.check, [one.revision.revisionId]);
  }
  for (let count = 2; count <= prepared.length; count++) {
    const added = prepared.slice(0, count);
    const attempt = build(file, added);
    if (attempt.ok) continue;
    const failing = added[count - 1] as Prepared;
    const partner = added.slice(0, -1).find(
      (other) =>
        build(
          file,
          added.filter((p) => p !== other),
        ).ok,
    );
    return partner === undefined
      ? internal(attempt.check, [failing.revision.revisionId])
      : {
          ok: false,
          failure: {
            kind: "conflict",
            revisionId: failing.revision.revisionId,
            conflictsWith: partner.revision.revisionId,
          },
        };
  }
  return internal(
    all.check,
    prepared.map((p) => p.revision.revisionId),
  );
}

const internal = (check: AssemblyCheck, revisionIds: readonly string[]): AssemblyResult => ({
  ok: false,
  failure: { kind: "internal_error", check, revisionIds },
});

// ---------------------------------------------------------------------------------------------
// The destination

interface File {
  readonly absent: boolean;
  readonly bytes: Uint8Array;
  readonly blocks: readonly GuidanceBlock[];
  /** The round trip failed (DM §7): one fallback block, and only a new section at the end. */
  readonly fallback: boolean;
  /** The line ending for new content (DM §7). */
  readonly eol: string;
}

function describe(destination: AssemblyDestination): File {
  if (destination.state === "absent") {
    return { absent: true, bytes: new Uint8Array(), blocks: [], fallback: false, eol: "\n" };
  }
  const { bytes, parsed } = destination;
  return {
    absent: false,
    bytes,
    blocks: parsed.blocks,
    fallback: parsed.roundTrip.state === "failed" && bytes.length > 0,
    eol: lineEnding(parsed.lineEndings),
  };
}

/** The file's style; `mixed` uses the most frequent, ties LF, CRLF, CR; `none` uses LF. */
function lineEnding({ style, counts }: LineEndings): string {
  if (style === "crlf") return "\r\n";
  if (style === "cr") return "\r";
  if (style !== "mixed") return "\n";
  const most = Math.max(counts.lf, counts.crlf, counts.cr);
  return counts.lf === most ? "\n" : counts.crlf === most ? "\r\n" : "\r";
}

// ---------------------------------------------------------------------------------------------
// Resolving each revision (DM §9.3 step 2)

/** A block of new content, or an untouched block, as the reparse must find it. */
interface ExpectedBlock {
  readonly type: BlockType;
  readonly bytes: Uint8Array;
}

interface Prepared {
  readonly revision: AssemblyRevision;
  /** `replace` is a `revise`. */
  readonly kind: "replace" | "remove" | "insert";
  /** `replace` and `remove`: the indices of the blocks changed, first to last. */
  readonly first: number;
  readonly last: number;
  /** `insert`: the block it goes after, or -1 when there is none. */
  readonly anchor: number;
  /** `replace` and `insert`: the new bytes, in the file's line endings, and their blocks. */
  readonly bytes: Uint8Array;
  readonly blocks: readonly ExpectedBlock[];
}

type Failed = { readonly check: AssemblyCheck };

function prepare(file: File, revision: AssemblyRevision): Prepared | Failed {
  const { operation, target, content } = revision;
  const base = { revision, first: -1, last: -1, anchor: -1, bytes: new Uint8Array(), blocks: [] };
  const shapeFits =
    operation === "add"
      ? target.kind !== "block" && content !== undefined
      : target.kind === "block" && (operation === "revise") === (content !== undefined);
  if (!shapeFits) return { check: "operation" };
  if (file.fallback || file.absent) {
    if (target.kind !== "newSection" || target.after !== undefined) return { check: "operation" };
  }

  const resolve = (ref: BlockRef): number => {
    const index = file.blocks.findIndex((b) => b.blockId === ref.blockId);
    return file.blocks[index]?.hash === ref.blockHash ? index : -1;
  };
  const heading = (ref: BlockRef): number => {
    const index = resolve(ref);
    return file.blocks[index]?.type === "heading" ? index : -1;
  };

  if (target.kind === "block") {
    const index = resolve(target);
    if (index < 0) return { check: "target" };
    const block = file.blocks[index] as GuidanceBlock;
    if (operation === "remove") {
      const last = block.type === "heading" ? sectionEnd(file, index) : index;
      return { ...base, kind: "remove", first: index, last };
    }
    const parsed = parseContent(content ?? "", file.eol);
    if ("check" in parsed) return parsed;
    if (parsed.blocks.length !== 1 || parsed.blocks[0]?.type !== block.type) {
      return { check: "types" };
    }
    if (block.type === "heading") {
      const line = Buffer.from(parsed.bytes).toString("latin1");
      const atx = ATX.exec(line);
      const oneLine = !/[\r\n]/.test(line);
      if (!oneLine || atx === null || (atx[1] ?? "").length !== headingLevel(file, index)) {
        return { check: "types" };
      }
    }
    return { ...base, kind: "replace", first: index, last: index, ...parsed };
  }

  const parsed = parseContent(content ?? "", file.eol);
  if ("check" in parsed) return parsed;
  if (parsed.blocks.some((b) => b.type === "heading")) return { check: "types" };

  if (target.kind === "after") {
    const anchor = resolve(target);
    return anchor < 0 ? { check: "target" } : { ...base, kind: "insert", anchor, ...parsed };
  }
  if (target.kind === "section") {
    const index = heading(target);
    if (index < 0) return { check: "target" };
    let anchor = index;
    while (file.blocks[anchor + 1] !== undefined && file.blocks[anchor + 1]?.type !== "heading") {
      anchor++;
    }
    return { ...base, kind: "insert", anchor, ...parsed };
  }

  let level = 2;
  let anchor = file.blocks.length - 1;
  if (target.after !== undefined) {
    const index = heading(target.after);
    if (index < 0) return { check: "target" };
    level = headingLevel(file, index);
    anchor = sectionEnd(file, index);
  }
  const title = target.heading.replace(/^[ \t]+|[ \t]+$/g, "");
  const rendered = `${"#".repeat(level)} ${title}${file.eol}${file.eol}`;
  const section = parseContent(rendered + (content ?? ""), file.eol);
  if ("check" in section) return section;
  const [first, ...rest] = section.blocks;
  if (first?.type !== "heading" || !sameBlocks(rest, parsed.blocks)) return { check: "types" };
  return { ...base, kind: "insert", anchor, ...section };
}

/** Content without blank lines before its first block or after its last, converted (step 4). */
function parseContent(
  content: string,
  eol: string,
): { bytes: Uint8Array; blocks: ExpectedBlock[] } | Failed {
  const lines = content.split(/\r\n|\r|\n/);
  const blank = (line: string | undefined) => line !== undefined && /^[ \t]*$/.test(line);
  while (blank(lines[0])) lines.shift();
  while (blank(lines[lines.length - 1])) lines.pop();
  const bytes = new Uint8Array(Buffer.from(lines.join(eol), "utf8"));
  const parsed = parseGuidanceBlocks(bytes);
  if (parsed.roundTrip.state !== "verified" || parsed.blocks.length === 0) {
    return { check: "content" };
  }
  return { bytes, blocks: expected(bytes, parsed.blocks) };
}

const expected = (bytes: Uint8Array, blocks: readonly GuidanceBlock[]): ExpectedBlock[] =>
  blocks.map((b) => ({
    type: b.type,
    bytes: bytes.subarray(b.sourceSpan.start, b.sourceSpan.end),
  }));

function sameBlocks(a: readonly ExpectedBlock[], b: readonly ExpectedBlock[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.type === b[i]?.type && Buffer.from(x.bytes).equals(b[i]?.bytes ?? []))
  );
}

const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;

function headingLevel(file: File, index: number): number {
  return blockHeadingLevel(file.bytes, file.blocks[index] as GuidanceBlock);
}

/** A heading's level: its number of `#`, or 1 for a setext `=` underline and 2 for `-`. */
export function blockHeadingLevel(bytes: Uint8Array, block: GuidanceBlock): number {
  const { start, end } = block.sourceSpan;
  const text = Buffer.from(bytes.subarray(start, end)).toString("latin1");
  const atx = ATX.exec(text);
  if (atx !== null) return (atx[1] ?? "").length;
  const underline = text.split(/\r\n|\r|\n/).at(-1) ?? "";
  return underline.trim().startsWith("=") ? 1 : 2;
}

function sectionEnd(file: File, index: number): number {
  return sectionLastIndex(file.bytes, file.blocks, index);
}

/**
 * The index of the last block of the heading at `index`'s section (DM §9.1): up to the next
 * heading of the same or a higher level, or the end of the file.
 */
export function sectionLastIndex(
  bytes: Uint8Array,
  blocks: readonly GuidanceBlock[],
  index: number,
): number {
  const level = blockHeadingLevel(bytes, blocks[index] as GuidanceBlock);
  let last = index;
  while (last + 1 < blocks.length) {
    const next = blocks[last + 1] as GuidanceBlock;
    if (next.type === "heading" && blockHeadingLevel(bytes, next) <= level) break;
    last++;
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// Order (DM §9.3 step 3)

const bySeq = (a: AssemblyRevision, b: AssemblyRevision): number =>
  a.firstSeq - b.firstSeq || comparePaths(a.revisionId, b.revisionId);

/**
 * By position; at one position a `revise` or `remove`, then additions, then new sections, so an
 * addition never lands under a new section's heading; then by `firstSeq`.
 */
function byPosition(a: Prepared, b: Prepared): number {
  const position = (p: Prepared) => (p.kind === "insert" ? p.anchor : p.first);
  const phase = (p: Prepared) =>
    p.kind !== "insert" ? 0 : p.revision.target.kind === "newSection" ? 2 : 1;
  return position(a) - position(b) || phase(a) - phase(b) || bySeq(a.revision, b.revision);
}

/** The first two revisions, in order, that change one block. */
function findOverlap(prepared: readonly Prepared[]): [string, string] | undefined {
  const owners = new Map<number, string>();
  for (const { kind, first, last, revision } of prepared) {
    if (kind === "insert") continue;
    for (let index = first; index <= last; index++) {
      const owner = owners.get(index);
      if (owner !== undefined) return [owner, revision.revisionId];
      owners.set(index, revision.revisionId);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Building and checking (DM §9.3 steps 3–6)

type Built =
  | {
      readonly ok: true;
      readonly content: Uint8Array;
      readonly hash: Hash;
      readonly attribution: readonly AttributionEntry[];
    }
  | { readonly ok: false; readonly check: AssemblyCheck };

/** What follows an entry: original separator bytes, or the default chosen from the neighbours. */
type Separator = Uint8Array | "default";

interface Entry {
  readonly bytes: Uint8Array;
  readonly blocks: readonly ExpectedBlock[];
  readonly follow: Separator;
  readonly attribution?: AttributionEntry;
}

function build(file: File, prepared: readonly Prepared[]): Built {
  if (file.fallback) return buildAppended(file, prepared);
  const { bytes, blocks, eol } = file;
  const count = blocks.length;
  const changes = new Map<number, Prepared>();
  for (const p of prepared) {
    if (p.kind !== "insert") for (let i = p.first; i <= p.last; i++) changes.set(i, p);
  }
  const removed = (i: number) => changes.get(i)?.kind === "remove";
  const span = (from: number, to: number) => bytes.subarray(from, to);
  const between = (i: number): Separator =>
    i + 1 < count
      ? span(
          (blocks[i] as GuidanceBlock).sourceSpan.end,
          (blocks[i + 1] as GuidanceBlock).sourceSpan.start,
        )
      : "default";
  /** After a removed block: the separator after its whole run, before the next remaining block. */
  const afterRun = (i: number): Separator => {
    let last = i;
    while (last + 1 < count && removed(last + 1)) last++;
    return between(last);
  };

  // Entries in file order. Removed blocks are kept for attribution; additions placed in a removed
  // run are marked, so their attribution follows the run's (DM §9.4).
  const entries: (Entry & { readonly removed?: true; readonly inRun?: true })[] = [];
  const inserts = (anchor: number) =>
    prepared.filter((p) => p.kind === "insert" && p.anchor === anchor);
  const pushInserts = (anchor: number) => {
    const inRun = anchor >= 0 && removed(anchor);
    const follow = anchor < 0 ? "default" : inRun ? afterRun(anchor) : between(anchor);
    for (const p of inserts(anchor)) {
      entries.push({
        bytes: p.bytes,
        blocks: p.blocks,
        follow,
        attribution: { revisionId: p.revision.revisionId, operation: "add" },
        ...(inRun ? { inRun: true as const } : {}),
      });
    }
  };
  if (count === 0) pushInserts(-1);
  for (let i = 0; i < count; i++) {
    const block = blocks[i] as GuidanceBlock;
    const own = span(block.sourceSpan.start, block.sourceSpan.end);
    const change = changes.get(i);
    const revisionId = change?.revision.revisionId ?? "";
    if (change?.kind === "remove") {
      entries.push({
        bytes: own,
        blocks: [],
        follow: "default",
        removed: true,
        attribution: { revisionId, operation: "remove", originalBlockId: block.blockId },
      });
    } else if (change?.kind === "replace") {
      entries.push({
        bytes: change.bytes,
        blocks: change.blocks,
        follow: between(i),
        attribution: { revisionId, operation: "revise", originalBlockId: block.blockId },
      });
    } else {
      entries.push({ bytes: own, blocks: [{ type: block.type, bytes: own }], follow: between(i) });
    }
    pushInserts(i);
  }

  // Serialise (step 5), recording the span of each piece of new content.
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const encode = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
  let lead: Uint8Array;
  let trail: Uint8Array;
  if (count > 0) {
    lead = span(0, (blocks[0] as GuidanceBlock).sourceSpan.start);
    trail = span((blocks[count - 1] as GuidanceBlock).sourceSpan.end, bytes.length);
  } else {
    // An absent file, or one with no blocks: a new file ends with one line ending, and a file
    // with no blocks keeps its bytes after the byte order mark, after the content.
    lead = span(0, bom);
    const rest = span(bom, bytes.length);
    trail =
      rest.length === 0
        ? encode(eol)
        : rest[0] === 0x0a || rest[0] === 0x0d
          ? rest
          : Buffer.concat([encode(eol), rest]);
  }
  const remaining = entries.filter((e) => e.removed !== true);
  if (count > 0 && remaining.length === 0) {
    lead = span(0, bom);
  }

  const parts: Uint8Array[] = [lead];
  let offset = lead.length;
  const attribution: AttributionEntry[] = [];
  /** Additions placed in a removed run, attributed after the run's removed blocks. */
  let held: AttributionEntry[] = [];
  let previous: Entry | undefined;
  for (const entry of entries) {
    if (entry.removed === true) {
      if (entry.attribution !== undefined) attribution.push(entry.attribution);
      continue;
    }
    if (entry.inRun !== true) {
      attribution.push(...held);
      held = [];
    }
    if (previous !== undefined) {
      const separator = separatorBetween(previous, entry, eol);
      parts.push(separator);
      offset += separator.length;
    }
    if (entry.attribution !== undefined) {
      const proposedSpan = { start: offset, end: offset + entry.bytes.length };
      (entry.inRun === true ? held : attribution).push({ ...entry.attribution, proposedSpan });
    }
    parts.push(entry.bytes);
    offset += entry.bytes.length;
    previous = entry;
  }
  attribution.push(...held);
  parts.push(trail);
  const content = new Uint8Array(Buffer.concat(parts));

  // Verify (step 6): the file parses, with a verified round trip, into exactly the untouched
  // blocks and the new ones, in order, with their types and bytes.
  const reparsed = parseGuidanceBlocks(content);
  const want = remaining.flatMap((e) => e.blocks);
  if (
    reparsed.roundTrip.state !== "verified" ||
    !sameBlocks(expected(content, reparsed.blocks), want)
  ) {
    return { ok: false, check: "reparse" };
  }
  return { ok: true, content, hash: sha256(content), attribution };
}

/** A copy of the original separator, or one blank line; one line ending between list items. */
function separatorBetween(before: Entry, after: Entry, eol: string): Uint8Array {
  if (before.follow !== "default") return before.follow;
  const listAfterList =
    before.blocks.at(-1)?.type === "list_item" && after.blocks[0]?.type === "list_item";
  return new Uint8Array(Buffer.from(listAfterList ? eol : eol + eol, "utf8"));
}

/**
 * A destination whose round trip failed (DM §7): new sections are appended after one blank
 * line, and the file ends with one line ending. The original bytes are an unchanged prefix by
 * construction; the appended bytes, parsed alone, must give the new sections' blocks.
 */
function buildAppended(file: File, prepared: readonly Prepared[]): Built {
  const { bytes, eol } = file;
  const last = bytes[bytes.length - 1];
  // A lone CR before an LF would become one CRLF, so it doesn't count as ending the line then.
  const endsWithEol = last === 0x0a || (last === 0x0d && eol !== "\n");
  const parts: Uint8Array[] = [bytes];
  let offset = bytes.length;
  const push = (text: string) => {
    const encoded = new Uint8Array(Buffer.from(text, "utf8"));
    parts.push(encoded);
    offset += encoded.length;
  };
  push(endsWithEol ? eol : eol + eol);
  const attribution: AttributionEntry[] = [];
  prepared.forEach((p, index) => {
    if (index > 0) push(eol + eol);
    attribution.push({
      revisionId: p.revision.revisionId,
      operation: "add",
      proposedSpan: { start: offset, end: offset + p.bytes.length },
    });
    parts.push(p.bytes);
    offset += p.bytes.length;
  });
  push(eol);
  const content = new Uint8Array(Buffer.concat(parts));

  const appended = content.subarray(bytes.length);
  const reparsed = parseGuidanceBlocks(appended);
  const want = prepared.flatMap((p) => p.blocks);
  if (
    reparsed.roundTrip.state !== "verified" ||
    !sameBlocks(expected(appended, reparsed.blocks), want)
  ) {
    return { ok: false, check: "reparse" };
  }
  return { ok: true, content, hash: sha256(content), attribution };
}
