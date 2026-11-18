import { splitLines } from "../destination/guidance-blocks.js";
import type { Hash } from "../hash.js";
import { comparePaths, normalisePath } from "../paths.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { globMatches } from "../validation/coverage.js";
import type {
  ExpansionIndex,
  ExpansionRequest,
  ExpansionSettings,
} from "../validation/expansion.js";
import {
  type ExcerptStrategy,
  type LineRange,
  lineTexts,
  mergeRanges,
  type RenderedItem,
  renderItem,
  renderLines,
} from "./item.js";
import { type RecordedPath, recordedPath, type SecretRuleId, scanItem } from "./secrets.js";
import { isMarkdown, type TierMembership, tierOf } from "./tiers.js";

// Expansion execution (IMPL §1.8). Requests that passed the static checks run in response order.
// Each is checked again as it runs: EXP-008, EXP-001, EXP-007, EXP-010 and the secret scan entry
// by entry (a search: file by file), then EXP-009 for the request as a whole. The first failure
// rejects the whole request, which returns nothing and uses no budget or item ID.

/** Each request in response order: one to run, or one a static check rejected. */
export type ExpansionInputRequest =
  | { readonly request: ExpansionRequest }
  | { readonly kind: ExpansionRequest["kind"]; readonly rejectedBy: string };

export interface ExpansionInput {
  readonly requests: readonly ExpansionInputRequest[];
  /** The snapshot's files: the hash and size each live read is checked against. */
  readonly files: readonly SnapshotFile[];
  /** What a request may read and search, and what the initial context sent. */
  readonly index: ExpansionIndex;
  /** For the excerpt rules of a read without ranges: tier 3 files keep whole lines. */
  readonly membership: TierMembership;
  readonly settings: ExpansionSettings;
}

export interface ExpansionItem {
  /** `E-<sequence>`. */
  readonly id: string;
  readonly path: string;
  readonly hash: Hash;
  /** `expansion:expansionRequests/<index>`. */
  readonly reason: string;
  /** The file's bytes, verified against the snapshot: for the item's citable form (§3.2.2). */
  readonly content: Uint8Array;
  readonly rendered: RenderedItem;
}

/** The rules a request can fail as it runs, and the secret scan's rejection. */
export type ExecutionRule =
  | "EXP-001"
  | "EXP-007"
  | "EXP-008"
  | "EXP-009"
  | "EXP-010"
  | `secret-scan:${SecretRuleId}`;

export type RequestOutcome =
  | {
      readonly index: number;
      readonly kind: "read";
      readonly outcome: "executed";
      readonly items: readonly ExpansionItem[];
    }
  | {
      readonly index: number;
      readonly kind: "search";
      readonly outcome: "executed";
      readonly items: readonly ExpansionItem[];
      /** Kept matches, at most `MAX_MATCHES`. */
      readonly matches: number;
      /** Whether more matches were found than were kept. */
      readonly capped: boolean;
    }
  | {
      readonly index: number;
      readonly kind: ExpansionRequest["kind"];
      readonly outcome: "rejected";
      /** A static rule, an execution rule, or `secret-scan:<rule ID>`. */
      readonly rule: string;
    };

export interface ExpansionRound {
  readonly requests: readonly RequestOutcome[];
  /** Every item returned, in ID order. */
  readonly items: readonly ExpansionItem[];
  readonly budgetBytes: number;
  readonly usedBytes: number;
  /** Files a secret match blocked for the rest of the session, in path order (IMPL §1.8). */
  readonly blocked: readonly { readonly path: string; readonly ruleId: SecretRuleId }[];
}

export const MAX_MATCHES = 30;
export const CONTEXT_LINES = 3;

type Failure = {
  readonly rule: ExecutionRule;
  /** Set when one of the request's own items matched the secret scan: its file is blocked. */
  readonly blocks?: { readonly path: string; readonly ruleId: SecretRuleId };
};
type Read = { readonly content: Uint8Array; readonly lines: readonly string[] } | Failure;

export async function runExpansion(
  input: ExpansionInput,
  fs: RepositoryFs,
): Promise<ExpansionRound> {
  const snapshotFiles = new Map(input.files.map((file) => [file.path, file]));
  // A file is read once per round: its first read is the live check.
  const reads = new Map<string, Read>();
  const readLive = async (path: string): Promise<Read> => {
    const cached = reads.get(path);
    if (cached !== undefined) return cached;
    const result = await verifiedRead(path, snapshotFiles.get(path), fs);
    reads.set(path, result);
    return result;
  };

  // A secret match blocks its file for the whole round, earlier requests included (§1.8), so
  // the round runs again until a pass blocks nothing new. Blocking only removes content, and the
  // blocked set only grows, so this ends; each file is read once, by the first pass.
  const blocked = new Map<string, SecretRuleId>();
  const matched = new Map<number, ExecutionRule>();
  for (;;) {
    const before = blocked.size;
    const pass = await runPass(input, readLive, blocked, matched);
    if (blocked.size === before) {
      const list = [...blocked]
        .sort(([a], [b]) => comparePaths(a, b))
        .map(([path, ruleId]) => ({ path, ruleId }));
      return { ...pass, blocked: list };
    }
  }
}

async function runPass(
  input: ExpansionInput,
  readLive: (path: string) => Promise<Read>,
  blocked: Map<string, SecretRuleId>,
  matched: Map<number, ExecutionRule>,
): Promise<Omit<ExpansionRound, "blocked">> {
  const requests: RequestOutcome[] = [];
  const items: ExpansionItem[] = [];
  let usedBytes = 0;
  for (const [index, entry] of input.requests.entries()) {
    if (!("request" in entry)) {
      requests.push({ index, kind: entry.kind, outcome: "rejected", rule: entry.rejectedBy });
      continue;
    }
    const { request } = entry;
    // A request whose own item matched stays rejected, even a search that now skips the file.
    const earlier = matched.get(index);
    if (earlier !== undefined) {
      requests.push({ index, kind: request.kind, outcome: "rejected", rule: earlier });
      continue;
    }
    const context: RunContext = { input, index, nextId: items.length + 1, readLive, blocked };
    const result =
      request.kind === "read" ? await runRead(request, context) : await runSearch(request, context);
    if ("rule" in result) {
      if (result.blocks !== undefined) {
        matched.set(index, result.rule);
        if (!blocked.has(result.blocks.path)) blocked.set(result.blocks.path, result.blocks.ruleId);
      }
      requests.push({ index, kind: request.kind, outcome: "rejected", rule: result.rule });
      continue;
    }
    const bytes = result.items.reduce((sum, item) => sum + item.rendered.bytes, 0);
    if (usedBytes + bytes > input.settings.expansionBytes) {
      requests.push({ index, kind: request.kind, outcome: "rejected", rule: "EXP-009" });
      continue;
    }
    usedBytes += bytes;
    items.push(...result.items);
    requests.push(
      request.kind === "read"
        ? { index, kind: "read", outcome: "executed", items: result.items }
        : {
            index,
            kind: "search",
            outcome: "executed",
            items: result.items,
            matches: result.matches ?? 0,
            capped: result.capped ?? false,
          },
    );
  }
  return { requests, items, budgetBytes: input.settings.expansionBytes, usedBytes };
}

interface RunContext {
  readonly input: ExpansionInput;
  readonly index: number;
  readonly nextId: number;
  readonly readLive: (path: string) => Promise<Read>;
  /** Files blocked so far: a read of one is rejected with its rule, and no search reads one. */
  readonly blocked: ReadonlyMap<string, SecretRuleId>;
}

type Ran =
  | {
      readonly items: readonly ExpansionItem[];
      readonly matches?: number;
      readonly capped?: boolean;
    }
  | Failure;

/** EXP-008: the live file, which must be the snapshot's. */
async function verifiedRead(
  path: string,
  file: SnapshotFile | undefined,
  fs: RepositoryFs,
): Promise<Read> {
  if (file === undefined || !("hash" in file)) throw new Error(`${path} has no snapshot hash`);
  const result = await fs.read(path, file.size);
  if (!result.ok || result.bytes === undefined || result.hash !== file.hash)
    return { rule: "EXP-008" };
  // A file too large to read was never checked for NUL bytes or UTF-8 (EXP-001).
  if (file.status === "listed_only" && (result.bytes.includes(0) || !isUtf8(result.bytes)))
    return { rule: "EXP-001" };
  return { content: result.bytes, lines: lineTexts(result.bytes, splitLines(result.bytes)) };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function parseRanges(lines: string): LineRange[] {
  return lines.split(",").map((range) => {
    const [first, last] = range.split("-").map(Number) as [number, number];
    return { first, last };
  });
}

/** The rules of §1.6 a read without ranges is excerpted by. */
function strategyFor(path: string, membership: TierMembership): ExcerptStrategy {
  if (isMarkdown(path)) return "markdown";
  if (tierOf(path, membership) === 3) return "lines";
  return "code";
}

async function runRead(
  request: Extract<ExpansionRequest, { kind: "read" }>,
  context: RunContext,
): Promise<Ran> {
  const { input, index } = context;
  const items: ExpansionItem[] = [];
  for (const entry of request.entries) {
    // The static checks made sure the path normalises to a readable file (EXP-001).
    const path = normalisePath(entry.path) as string;
    const block = context.blocked.get(path);
    if (block !== undefined) return { rule: `secret-scan:${block}` };
    const read = await context.readLive(path);
    if ("rule" in read) return read;
    const ranges = entry.lines === undefined ? undefined : parseRanges(entry.lines);
    if (ranges?.some((range) => range.last > read.lines.length)) return { rule: "EXP-007" };
    const item = {
      id: `E-${context.nextId + items.length}`,
      path,
      hash: (input.files.find((f) => f.path === path) as { hash: Hash }).hash,
      reason: `expansion:expansionRequests/${index}`,
      content: read.content,
    };
    const cap = input.settings.expansionEntryBytes;
    const rendered =
      ranges === undefined
        ? renderItem(item, strategyFor(path, input.membership), cap)
        : renderLines(item, ranges, cap);
    if (rendered === undefined) return { rule: "EXP-010" };
    const ruleId = scanItem({ path, rendered });
    if (ruleId !== undefined) return { rule: `secret-scan:${ruleId}`, blocks: { path, ruleId } };
    items.push({ ...item, rendered });
  }
  return { items };
}

async function runSearch(
  request: Extract<ExpansionRequest, { kind: "search" }>,
  context: RunContext,
): Promise<Ran> {
  const { input, index } = context;
  const files = input.index.searchable
    .map((segments) => segments.join("/"))
    .filter((path) => request.glob === undefined || matchesThroughDirectory(request.glob, path))
    .filter((path) => !context.blocked.has(path))
    .sort(comparePaths);

  // Every file searched is read and checked first: a changed one fails the request (EXP-008).
  const contents: { path: string; content: Uint8Array; lines: readonly string[] }[] = [];
  for (const path of files) {
    const read = await context.readLive(path);
    if ("rule" in read) return read;
    contents.push({ path, ...read });
  }

  let found = 0;
  const kept = new Map<string, number[]>();
  for (const { path, lines } of contents)
    lines.forEach((text, i) => {
      if (!text.includes(request.literal)) return;
      found++;
      if (found <= MAX_MATCHES) kept.set(path, [...(kept.get(path) ?? []), i + 1]);
    });

  const items: ExpansionItem[] = [];
  for (const { path, content, lines } of contents) {
    const matches = kept.get(path);
    if (matches === undefined) continue;
    const sent = input.index.sent.get(path)?.lines ?? new Set<number>();
    const wanted = new Set<number>();
    for (const line of matches) {
      if (sent.has(line)) continue;
      const first = Math.max(1, line - CONTEXT_LINES);
      const last = Math.min(lines.length, line + CONTEXT_LINES);
      for (let l = first; l <= last; l++) if (!sent.has(l)) wanted.add(l);
    }
    if (wanted.size === 0) continue;
    const item = {
      id: `E-${context.nextId + items.length}`,
      path,
      hash: (input.files.find((f) => f.path === path) as { hash: Hash }).hash,
      reason: `expansion:expansionRequests/${index}`,
      content,
    };
    const ranges = mergeRanges([...wanted].map((line) => ({ first: line, last: line })));
    // A search has no per-entry cap: only the round's budget (EXP-009) limits it.
    const rendered = renderLines(item, ranges, Number.POSITIVE_INFINITY) as RenderedItem;
    const ruleId = scanItem({ path, rendered });
    if (ruleId !== undefined) return { rule: `secret-scan:${ruleId}`, blocks: { path, ruleId } };
    items.push({ ...item, rendered });
  }
  return { items, matches: Math.min(found, MAX_MATCHES), capped: found > MAX_MATCHES };
}

/** A glob matches a file directly or through a directory above it (§1.11). */
function matchesThroughDirectory(glob: string, path: string): boolean {
  const segments = path.split("/");
  return segments.some((_, end) => globMatches(glob, segments.slice(0, end + 1).join("/")));
}

// --- What call 2 and the record receive -------------------------------------------------------

const REJECTED_STATUS: Readonly<Record<string, string>> = {
  "EXP-007": "range past end of file",
  "EXP-008": "changed since snapshot",
  "EXP-009": "over budget",
  "EXP-010": "over budget",
};

function statusOf(outcome: RequestOutcome): string {
  if (outcome.outcome === "rejected") {
    if (outcome.rule.startsWith("secret-scan:")) return "rejected: withheld";
    return `rejected: ${REJECTED_STATUS[outcome.rule] ?? "invalid request"}`;
  }
  if (outcome.kind === "search" && outcome.matches === 0) return "no matches";
  const n = outcome.items.length;
  return `executed: ${n} ${n === 1 ? "item" : "items"}`;
}

/**
 * One status line per request, in response order, framed (IMPL §1.8). Call 2 receives it before
 * the `E` items. It holds no path, literal or content.
 */
export function renderExpansionStatus(round: ExpansionRound): string {
  const lines = round.requests.map(
    (outcome) => `expansionRequests/${outcome.index} ${statusOf(outcome)}\n`,
  );
  return `<<<EXPANSION>>>\n${lines.join("")}<<<END EXPANSION>>>\n`;
}

export interface RecordedExpansionItem {
  readonly id: string;
  readonly fileHash: Hash;
  readonly excerpt: boolean;
  readonly includedLines: string;
  readonly totalLines: number;
  readonly bytes: number;
}

export type RecordedRequest =
  | {
      readonly index: number;
      readonly kind: ExpansionRequest["kind"];
      readonly outcome: "rejected";
      readonly rule: string;
    }
  | {
      readonly index: number;
      readonly kind: "read";
      readonly outcome: "executed";
      readonly items: readonly (RecordedExpansionItem & RecordedPath)[];
    }
  | {
      readonly index: number;
      readonly kind: "search";
      readonly outcome: "executed";
      readonly matches: number;
      readonly capped: boolean;
      readonly items: readonly (RecordedExpansionItem & RecordedPath)[];
    };

/** The fields of the `expansion_round` record (IMPL §1.13): paths, hashes and counts only. */
export function expansionRoundFields(round: ExpansionRound): {
  readonly budgetBytes: number;
  readonly usedBytes: number;
  readonly requests: readonly RecordedRequest[];
  readonly blocked: readonly (RecordedPath & { readonly secretRuleId: SecretRuleId })[];
} {
  const recorded = (item: ExpansionItem) => ({
    id: item.id,
    ...recordedPath(item.path),
    fileHash: item.hash,
    excerpt: item.rendered.excerpt,
    includedLines: item.rendered.included
      .map((r) => (r.first === r.last ? `${r.first}` : `${r.first}-${r.last}`))
      .join(","),
    totalLines: item.rendered.totalLines,
    bytes: item.rendered.bytes,
  });
  return {
    budgetBytes: round.budgetBytes,
    usedBytes: round.usedBytes,
    requests: round.requests.map((outcome): RecordedRequest => {
      if (outcome.outcome === "rejected") return outcome;
      if (outcome.kind === "read") return { ...outcome, items: outcome.items.map(recorded) };
      return { ...outcome, items: outcome.items.map(recorded) };
    }),
    blocked: round.blocked.map((file) => ({
      ...recordedPath(file.path),
      secretRuleId: file.ruleId,
    })),
  };
}
