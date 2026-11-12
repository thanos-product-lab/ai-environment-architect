import { extractKnownFacts, type KnownFact } from "../facts/known-facts.js";
import { KNOWN_FACTS_FRAME_BYTES, renderKnownFacts } from "../facts/render.js";
import { type Hash, sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";
import type { IgnoreRules } from "../snapshot/git.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import { DESTINATION_PATH, type Snapshot, type SnapshotSettings } from "../snapshot/snapshot.js";
import { DECLARATION_PATTERNS_VERSION } from "./declarations.js";
import type { LineRange } from "./item.js";
import {
  applySecretScan,
  type RecordedPath,
  recordedPath,
  SECRET_RULES_VERSION,
  type SecretRuleId,
  scanText,
} from "./secrets.js";
import {
  AGENT_CONFIG_TOKEN_LIMIT,
  ALGORITHM_VERSION,
  type ContextSettings,
  type DestinationStop,
  type SelectedItem,
  type SelectionGap,
  type SkippedFile,
  selectTiers,
  TEST_EXAMPLE_REASON,
  type TierMembership,
  type TierUsage,
} from "./tiers.js";
import type { TokenSettings } from "./token-settings.js";
import { type ContentMark, type RenderedTree, renderTree } from "./tree.js";

// The selection pipeline (IMPL §1.3) and the input manifest (IMPL §1.13).
//
// context = select(snapshot, settings): candidates, tiers 1, 2, 3 and 5, the secret scan (no
// refill), the tree from the full file list with the final markers, then rendering in tier order
// 1, 2, 3, 4, 5. The token check (IMPL §1.10, `token-check.ts`) can only remove items: it
// assembles the context again through `reduceContext`, and `contextHash` covers the final context.

export const MANIFEST_VERSION = 2;

/**
 * The effective settings. Their canonical JSON, with the versions, gives `settingsHash`. `tokens`
 * is among them because it changes what the token check removes (IMPL §1.10, §4.4.1).
 */
export interface ContextSelectionSettings {
  readonly snapshot: SnapshotSettings;
  readonly context: ContextSettings;
  readonly tokens: TokenSettings;
}

export interface RenderedContext {
  readonly text: string;
  readonly bytes: number;
  /** `contextHash`: SHA-256 of the rendered context's UTF-8 bytes. */
  readonly hash: Hash;
}

export type ManifestTier =
  | {
      readonly tier: 1 | 2 | 3 | 5;
      readonly capBytes: number;
      readonly budgetBytes: number;
      readonly usedBytes: number;
      readonly items: number;
      readonly skipped: number;
      readonly testExamples?: number;
    }
  | {
      readonly tier: 4;
      readonly capBytes: number;
      readonly usedBytes: number;
      readonly treeDepth: number;
    };

export interface ManifestItem {
  readonly id: string;
  readonly path: string;
  readonly fileHash: Hash;
  readonly reason: string;
  readonly excerpt: boolean;
  readonly includedLines: string;
  readonly totalLines: number;
  readonly bytes: number;
}

export type ManifestSkipped = RecordedPath & { readonly reason: string };

export type ManifestExcluded =
  | (RecordedPath & { readonly rule: string })
  | (RecordedPath & { readonly reason: `secret-scan:${SecretRuleId}` });

/** Paths, hashes and reasons; never source content or matched text. */
export interface InputManifest {
  readonly manifestVersion: typeof MANIFEST_VERSION;
  readonly algorithmVersion: string;
  readonly secretRulesVersion: string;
  readonly declarationPatternsVersion: string;
  readonly settingsHash: Hash;
  readonly snapshotId: string;
  readonly contextHash: Hash;
  /** Set per model call when inputs are retained (IMPL §1.12). */
  readonly retainedInputRef: null;
  readonly budget: { readonly initialContextBytes: number; readonly usedBytes: number };
  /** The known-facts section (IMPL §3.2.5): facts sent and left out. */
  readonly knownFacts: {
    readonly capBytes: number;
    readonly usedBytes: number;
    readonly facts: number;
    readonly leftOut: number;
  };
  /** Set by the token check (IMPL §1.10) of the call that is sent. */
  readonly tokenCheck: TokenCheckRecord | null;
  readonly tiers: readonly ManifestTier[];
  readonly items: readonly ManifestItem[];
  readonly skipped: readonly ManifestSkipped[];
  readonly excluded: readonly ManifestExcluded[];
  /**
   * Whether the repository's ignore rules were applied (IMPL §1.4). They are read through git,
   * so without it only the default and user exclusions apply, and the reason is recorded.
   */
  readonly ignoreRules: IgnoreRules;
  /**
   * Ignored entries, in path order: files, hashed but never a candidate for any tier or
   * expansion, and wholly ignored directories, which capture doesn't enter.
   */
  readonly ignored: readonly RecordedPath[];
  /** Set when the expansion round runs (IMPL §1.8). */
  readonly expansion: null;
}

/** What the token check (IMPL §1.10) removed, and what it counted (IMPL §1.13). */
export interface TokenCheckRecord {
  readonly model: string;
  readonly method: "provider_count" | "estimate";
  readonly inputTokens: number;
  readonly reservedOutputTokens: number;
  readonly contextLimit: number;
  readonly reductions: readonly Reduction[];
}

export type ReductionStep = "tier5" | "tier2" | "tier1" | "excerpt";

/** One removal, in the order made. A path that matches the secret scan is recorded by hash. */
export type Reduction =
  | (RecordedPath & { readonly step: ReductionStep; readonly id: string; readonly bytes: number })
  | { readonly step: "tree_depth"; readonly treeDepth: number };

/**
 * What the final context is assembled from, kept so that the token check can assemble it again
 * without some items. Nothing in it is read again from the repository.
 */
export interface ContextParts {
  readonly snapshot: Snapshot;
  readonly settings: ContextSelectionSettings;
  readonly factsText: string;
  readonly factsBytes: number;
  readonly factsSent: number;
  readonly factsLeftOut: number;
  /** In rendering order, without the tree. */
  readonly items: readonly SelectedItem[];
  readonly blocked: readonly { readonly path: string; readonly ruleId: SecretRuleId }[];
  readonly tiers: readonly TierUsage[];
  readonly skipped: readonly SkippedFile[];
  readonly reservedTreeBytes: number;
  /** The selection's deterministic gaps. */
  readonly gaps: readonly SelectionGap[];
}

export interface ReadyContext {
  readonly state: "ready";
  readonly context: RenderedContext;
  /** In rendering order, without the tree. */
  readonly items: readonly SelectedItem[];
  readonly tree: RenderedTree;
  /** The selection's deterministic `gap` findings, recorded by the session before call 1. */
  readonly gaps: readonly SelectionGap[];
  /**
   * One gap per reduction that removed agent configuration, in call order, each listing only
   * that reduction's own removals (IMPL §1.10). Each is recorded before its call is sent.
   */
  readonly tokenCheckGaps: readonly SelectionGap[];
  /** For the tier, and so the evidence basis, of any cited file (IMPL §3.2.4). */
  readonly membership: TierMembership;
  /**
   * Every known fact, in order, recorded as a finding whether or not it was sent, with its
   * `F` alias when it was (IMPL §3.2.5).
   */
  readonly knownFacts: readonly { readonly fact: KnownFact; readonly alias: string | null }[];
  readonly manifest: InputManifest;
  /** For `reduceContext`. */
  readonly parts: ContextParts;
  /**
   * The IDs of every item the token check has removed so far, by this call or an earlier one:
   * call 2 starts from call 1's reduced context (IMPL §1.10).
   */
  readonly removed: ReadonlySet<string>;
}

export type ContextResult =
  | ReadyContext
  /** The session stops before any model call (IMPL §1.5, destination rule). */
  | { readonly state: "stopped"; readonly stop: DestinationStop }
  /** A file's content no longer matches the snapshot (IMPL §1.3). */
  | { readonly state: "unstable"; readonly changedPaths: readonly string[] };

export async function selectContext(
  snapshot: Snapshot,
  settings: ContextSelectionSettings,
  fs: RepositoryFs,
): Promise<ContextResult> {
  if (settings.context.knownFactsBytes < KNOWN_FACTS_FRAME_BYTES) {
    throw new Error(
      `knownFactsBytes (${settings.context.knownFactsBytes}) is less than the known-facts frame (${KNOWN_FACTS_FRAME_BYTES} bytes).`,
    );
  }
  const selection = await selectTiers(snapshot, settings.context, fs);
  if (selection.state !== "selected") return selection;
  const scanned = applySecretScan(selection);
  if (scanned.state !== "selected") return scanned;

  // A file whose path matches the scan is blocked even when no tier selected it (IMPL §1.7).
  const blocked: { readonly path: string; readonly ruleId: SecretRuleId }[] = [...scanned.blocked];
  const blockedPaths = new Set(blocked.map((b) => b.path));
  for (const file of snapshot.files) {
    // Files only: an ignored directory, like an excluded one, has no content to block.
    if (file.status !== "read" && file.status !== "listed_only" && file.status !== "ignored") {
      continue;
    }
    if (file.status === "ignored" && file.kind === "directory") continue;
    const ruleId = blockedPaths.has(file.path) ? undefined : scanText(file.path);
    if (ruleId !== undefined) blocked.push({ path: file.path, ruleId });
  }
  const extracted = await extractKnownFacts(snapshot, scanned, fs);
  if (extracted.state !== "extracted") return extracted;
  const facts = renderKnownFacts(extracted.facts, settings.context.knownFactsBytes);

  const parts: ContextParts = {
    snapshot,
    settings,
    factsText: facts.text,
    factsBytes: facts.bytes,
    factsSent: extracted.facts.length - facts.leftOut,
    factsLeftOut: facts.leftOut,
    items: scanned.items,
    blocked,
    tiers: scanned.tiers,
    skipped: scanned.skipped,
    reservedTreeBytes: scanned.reservedTreeBytes,
    gaps: [...scanned.gaps, ...extracted.gaps, ...(facts.gap === undefined ? [] : [facts.gap])],
  };
  const removed = new Set<string>();
  return {
    state: "ready",
    ...assemble(parts, removed),
    gaps: parts.gaps,
    tokenCheckGaps: [],
    membership: scanned.membership,
    knownFacts: extracted.facts.map((fact, index) => ({
      fact,
      alias: facts.aliases[index] ?? null,
    })),
    parts,
    removed,
  };
}

/**
 * The context again without the items whose IDs are in `removed`, as well as those already
 * removed from it (IMPL §1.3 step 7, §1.10): the others keep their IDs, the tree marks the
 * removed ones `[-]`, and the manifest lists them in `skipped` with `token-check:<tier>` and
 * counts them out of their tier. Removed agent configuration gets the §1.5 gap, with the token
 * check as its cause. `tokenCheck` is left for the check to set.
 */
export function reduceContext(context: ReadyContext, removed: ReadonlySet<string>): ReadyContext {
  const all = new Set([...context.removed, ...removed]);
  // Agent configuration this reduction removed is as unread as configuration the budget
  // skipped (IMPL §1.5), so it gets the same gap with its own cause, listing only its own
  // removals in rendering order. Never the destination.
  const config = context.parts.items.filter(
    (item) =>
      item.tier === 1 &&
      item.path !== DESTINATION_PATH &&
      removed.has(item.id) &&
      !context.removed.has(item.id),
  );
  const gap: SelectionGap = {
    gapType: "other",
    statement: AGENT_CONFIG_TOKEN_LIMIT,
    relatedPaths: config.map((item) => item.path),
  };
  return {
    ...context,
    ...assemble(context.parts, all),
    removed: all,
    tokenCheckGaps: config.length === 0 ? context.tokenCheckGaps : [...context.tokenCheckGaps, gap],
  };
}

function assemble(
  parts: ContextParts,
  removed: ReadonlySet<string>,
): Pick<ReadyContext, "context" | "items" | "tree" | "manifest"> {
  const { snapshot, settings, blocked } = parts;
  const kept = parts.items.filter((item) => !removed.has(item.id));
  const dropped = parts.items.filter((item) => removed.has(item.id));

  const marks = new Map<string, ContentMark>();
  for (const item of kept) marks.set(item.path, item.rendered.excerpt ? "E" : "R");
  for (const entry of blocked) marks.set(entry.path, "S");
  const tree = renderTree(snapshot.files, marks, settings.context, parts.reservedTreeBytes);

  const before = kept.filter((item) => item.tier < 4);
  const after = kept.filter((item) => item.tier > 4);
  const text = [
    parts.factsText,
    ...before.map(renderedText),
    tree.text,
    ...after.map(renderedText),
  ].join("");
  const context: RenderedContext = {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: sha256(new TextEncoder().encode(text)),
  };

  const tiers: ManifestTier[] = [];
  for (const usage of parts.tiers) {
    if (usage.tier === 5) {
      tiers.push({
        tier: 4,
        capBytes: parts.reservedTreeBytes,
        usedBytes: tree.bytes,
        treeDepth: tree.depth,
      });
    }
    const out = dropped.filter((item) => item.tier === usage.tier);
    const examples = out.filter((item) => item.reason === TEST_EXAMPLE_REASON).length;
    tiers.push({
      ...usage,
      usedBytes: usage.usedBytes - out.reduce((n, item) => n + item.rendered.bytes, 0),
      items: usage.items - out.length,
      skipped: usage.skipped + out.length,
      ...(usage.testExamples === undefined ? {} : { testExamples: usage.testExamples - examples }),
    });
  }

  const excluded: ManifestExcluded[] = [
    ...snapshot.files.flatMap((file) =>
      file.status === "excluded" ? [{ ...recordedPath(file.path), rule: file.rule }] : [],
    ),
    ...[...blocked]
      .sort((a, b) => comparePaths(a.path, b.path))
      .map((entry) => ({
        ...recordedPath(entry.path),
        reason: `secret-scan:${entry.ruleId}` as const,
      })),
  ];

  const manifest: InputManifest = {
    manifestVersion: MANIFEST_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    secretRulesVersion: SECRET_RULES_VERSION,
    declarationPatternsVersion: DECLARATION_PATTERNS_VERSION,
    settingsHash: settingsHash(settings),
    snapshotId: snapshot.id,
    contextHash: context.hash,
    retainedInputRef: null,
    budget: { initialContextBytes: settings.context.initialContextBytes, usedBytes: context.bytes },
    knownFacts: {
      capBytes: settings.context.knownFactsBytes,
      usedBytes: parts.factsBytes,
      facts: parts.factsSent,
      leftOut: parts.factsLeftOut,
    },
    tokenCheck: null,
    tiers,
    items: [...before, ...after].map((item) => ({
      id: item.id,
      path: item.path,
      fileHash: item.hash,
      reason: item.reason,
      excerpt: item.rendered.excerpt,
      includedLines: formatRanges(item.rendered.included),
      totalLines: item.rendered.totalLines,
      bytes: item.rendered.bytes,
    })),
    skipped: [
      ...parts.skipped.map((file) => ({ ...recordedPath(file.path), reason: file.reason })),
      ...dropped.map((item) => ({
        ...recordedPath(item.path),
        reason: `token-check:tier${item.tier}`,
      })),
    ],
    excluded,
    ignoreRules: snapshot.ignoreRules,
    ignored: snapshot.files.flatMap((file) =>
      file.status === "ignored" ? [recordedPath(file.path)] : [],
    ),
    expansion: null,
  };

  return { context, items: [...before, ...after], tree, manifest };
}

function renderedText(item: SelectedItem): string {
  return item.rendered.text;
}

function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map((r) => (r.first === r.last ? `${r.first}` : `${r.first}-${r.last}`)).join(",");
}

/** SHA-256 of the canonical JSON of the effective settings and the three versions. */
export function settingsHash(settings: ContextSelectionSettings): Hash {
  const canonical = canonicalJson({
    settings,
    algorithmVersion: ALGORITHM_VERSION,
    secretRulesVersion: SECRET_RULES_VERSION,
    declarationPatternsVersion: DECLARATION_PATTERNS_VERSION,
  });
  return sha256(new TextEncoder().encode(canonical));
}

/**
 * JSON with object keys in bytewise order at every level, no whitespace, and undefined
 * properties dropped. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`no canonical JSON for ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("no canonical JSON for an object that is not a plain object");
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => comparePaths(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`no canonical JSON for a ${typeof value}`);
}
