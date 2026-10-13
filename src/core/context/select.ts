import { type Hash, sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import type { Snapshot, SnapshotSettings } from "../snapshot/snapshot.js";
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
  ALGORITHM_VERSION,
  type ContextSettings,
  type DestinationStop,
  type SelectedItem,
  type SelectionGap,
  selectTiers,
} from "./tiers.js";
import { type ContentMark, type RenderedTree, renderTree } from "./tree.js";

// The selection pipeline (IMPL §1.3) and the input manifest (IMPL §1.13).
//
// context = select(snapshot, settings): candidates, tiers 1, 2, 3 and 5, the secret scan (no
// refill), the tree from the full file list with the final markers, then rendering in tier order
// 1, 2, 3, 4, 5. The token check (IMPL §1.10) arrives with the model adapter; until then
// `tokenCheck` is null and `contextHash` covers the byte selection.

export const MANIFEST_VERSION = 1;

/** The effective settings. Their canonical JSON, with the versions, gives `settingsHash`. */
export interface ContextSelectionSettings {
  readonly snapshot: SnapshotSettings;
  readonly context: ContextSettings;
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
  /** Set by the token check (IMPL §1.10), which arrives with the model adapter. */
  readonly tokenCheck: null;
  readonly tiers: readonly ManifestTier[];
  readonly items: readonly ManifestItem[];
  readonly skipped: readonly ManifestSkipped[];
  readonly excluded: readonly ManifestExcluded[];
  /**
   * Whether the repository's ignore rules were applied (IMPL §1.4). They are read through git,
   * so without it only the default and user exclusions apply.
   */
  readonly ignoreRules: "applied" | "not_applied";
  /** Ignored files, in path order. Hashed, but never a candidate for any tier or expansion. */
  readonly ignored: readonly RecordedPath[];
  /** Set when the expansion round runs (IMPL §1.8). */
  readonly expansion: null;
}

export type ContextResult =
  | {
      readonly state: "ready";
      readonly context: RenderedContext;
      /** In rendering order, without the tree. */
      readonly items: readonly SelectedItem[];
      readonly tree: RenderedTree;
      /** Deterministic `gap` findings, recorded by the session. */
      readonly gaps: readonly SelectionGap[];
      readonly manifest: InputManifest;
    }
  /** The session stops before any model call (IMPL §1.5, destination rule). */
  | { readonly state: "stopped"; readonly stop: DestinationStop }
  /** A file's content no longer matches the snapshot (IMPL §1.3). */
  | { readonly state: "unstable"; readonly changedPaths: readonly string[] };

export async function selectContext(
  snapshot: Snapshot,
  settings: ContextSelectionSettings,
  fs: RepositoryFs,
): Promise<ContextResult> {
  const selection = await selectTiers(snapshot, settings.context, fs);
  if (selection.state !== "selected") return selection;
  const scanned = applySecretScan(selection);
  if (scanned.state !== "selected") return scanned;

  // A file whose path matches the scan is blocked even when no tier selected it (IMPL §1.7).
  const blocked: { readonly path: string; readonly ruleId: SecretRuleId }[] = [...scanned.blocked];
  const blockedPaths = new Set(blocked.map((b) => b.path));
  for (const file of snapshot.files) {
    if (file.status !== "read" && file.status !== "listed_only") continue;
    const ruleId = blockedPaths.has(file.path) ? undefined : scanText(file.path);
    if (ruleId !== undefined) blocked.push({ path: file.path, ruleId });
  }
  const marks = new Map<string, ContentMark>();
  for (const item of scanned.items) marks.set(item.path, item.rendered.excerpt ? "E" : "R");
  for (const entry of blocked) marks.set(entry.path, "S");
  const tree = renderTree(snapshot.files, marks, settings.context, scanned.reservedTreeBytes);

  const before = scanned.items.filter((item) => item.tier < 4);
  const after = scanned.items.filter((item) => item.tier > 4);
  const text = [...before.map(renderedText), tree.text, ...after.map(renderedText)].join("");
  const context: RenderedContext = {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: sha256(new TextEncoder().encode(text)),
  };

  const tiers: ManifestTier[] = [];
  for (const usage of scanned.tiers) {
    if (usage.tier === 5) {
      tiers.push({
        tier: 4,
        capBytes: scanned.reservedTreeBytes,
        usedBytes: tree.bytes,
        treeDepth: tree.depth,
      });
    }
    tiers.push({ ...usage });
  }

  const excluded: ManifestExcluded[] = [
    ...snapshot.files.flatMap((file) =>
      file.status === "excluded" ? [{ ...recordedPath(file.path), rule: file.rule }] : [],
    ),
    ...blocked
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
    skipped: scanned.skipped.map((file) => ({ ...recordedPath(file.path), reason: file.reason })),
    excluded,
    ignoreRules: snapshot.git.state === "known" ? "applied" : "not_applied",
    ignored: snapshot.files.flatMap((file) =>
      file.status === "ignored" ? [recordedPath(file.path)] : [],
    ),
    expansion: null,
  };

  return {
    state: "ready",
    context,
    items: [...before, ...after],
    tree,
    gaps: scanned.gaps,
    manifest,
  };
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
