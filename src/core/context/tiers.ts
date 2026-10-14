import { type Hash, sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import {
  DESTINATION_PATH,
  type DestinationUnavailableReason,
  type Snapshot,
} from "../snapshot/snapshot.js";
import { cutLabel, DECLARATION_FAMILIES } from "./declarations.js";
import { findImports, resolveImport } from "./imports.js";
import { blockRanges, type ExcerptStrategy, type RenderedItem, renderItem } from "./item.js";
import { matchWorkspaceMembers, packageOf, workspacePatterns } from "./packages.js";
import { importWithheld, type SecretRuleId, scanItem, scanText } from "./secrets.js";

// Tiers 1, 2, 3 and 5, including the test reserve (IMPL §1.5).
//
// Each file belongs to the first tier that matches it. Tiers fill in order 1, 2, 3, 5; within a
// tier every item is tried in the tier's order, excerpted to fit where the tier allows it, and
// recorded as skipped if not even one line fits. Each rendering is scanned for secrets as it is
// selected (IMPL §1.7): a blocked file uses no bytes, ID or slot, so the next candidate takes its
// place. Unused bytes pass down to the next tier. Tier 4, the directory tree, is only reserved
// here.

/**
 * The selection algorithm's version (IMPL §1.3). The name lists and ranking rules below are part
 * of it: increase it with any change to them, because that changes the context.
 */
export const ALGORITHM_VERSION = "context-select/1.3.0";

export interface ContextSettings {
  /** The five tier caps together may not exceed it. */
  readonly initialContextBytes: number;
  readonly tierCaps: {
    readonly tier1: number;
    readonly tier2: number;
    readonly tier3: number;
    readonly tier4: number;
    readonly tier5: number;
  };
  /** Limits the destination's rendered item. */
  readonly maxDestinationBytes: number;
  readonly perFileCaps: { readonly tier2: number; readonly tier3: number; readonly tier5: number };
  readonly testReserveBytes: number;
  readonly testExampleBytes: number;
  /** Not counting test examples. */
  readonly maxSourceFiles: number;
  /** File name endings, matched ASCII case-insensitively. */
  readonly sourceExtensions: readonly string[];
  /** Tier 4 (IMPL §1.6): the deepest level shown, reduced until the tree fits its cap. */
  readonly treeDepth: number;
  /** Tier 4: directories with more entries show this many, then a count of the rest. */
  readonly treeCollapseThreshold: number;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  initialContextBytes: 240_000,
  tierCaps: { tier1: 40_000, tier2: 60_000, tier3: 40_000, tier4: 20_000, tier5: 80_000 },
  maxDestinationBytes: 40_000,
  perFileCaps: { tier2: 12_000, tier3: 8_000, tier5: 6_000 },
  testReserveBytes: 15_000,
  testExampleBytes: 3_000,
  maxSourceFiles: 24,
  sourceExtensions: [
    ...DECLARATION_FAMILIES.flatMap((family) => family.extensions),
    // Components and templates. No declaration patterns, so they are excerpted by whole lines.
    ...[".vue", ".svelte", ".astro", ".hbs", ".handlebars", ".ejs", ".njk"],
  ],
  treeDepth: 4,
  treeCollapseThreshold: 40,
};

export const AGENT_CONFIG_SKIPPED =
  "Some existing agent configuration was not read because of the analysis budget.";

export type SelectedTier = 1 | 2 | 3 | 5;

export interface SelectedItem {
  /** `T<tier>-<sequence>`. */
  readonly id: string;
  readonly path: string;
  readonly hash: Hash;
  readonly tier: SelectedTier;
  readonly reason: string;
  readonly rendered: RenderedItem;
}

/**
 * A selected file the secret scan removed. The tree marks it `[S]`; the manifest records the
 * rule. The path is kept as is in memory, and the manifest records it with `recordedPath`.
 */
export interface BlockedFile {
  readonly path: string;
  readonly tier: SelectedTier;
  readonly ruleId: SecretRuleId;
}

export interface SkippedFile {
  readonly path: string;
  readonly tier: SelectedTier;
  readonly reason: string;
}

export interface TierUsage {
  readonly tier: SelectedTier;
  readonly capBytes: number;
  /** The cap plus bytes passed down from the tier before. */
  readonly budgetBytes: number;
  /** Can exceed the budget in tier 1 only, when the destination alone does. */
  readonly usedBytes: number;
  readonly items: number;
  readonly skipped: number;
  /** Tier 5 only. */
  readonly testExamples?: number;
}

/** A deterministic `gap` finding (DM §6.3), recorded by the session later. */
export interface SelectionGap {
  readonly gapType: "other";
  readonly statement: string;
  readonly relatedPaths: readonly string[];
  /** Related paths that match the secret scan, recorded by hash instead (IMPL §1.7). */
  readonly relatedPathHashes?: readonly Hash[];
}

export type DestinationStop =
  | { readonly reason: "destination_unavailable"; readonly detail: DestinationUnavailableReason }
  | {
      readonly reason: "destination_too_large";
      readonly renderedBytes: number;
      readonly maxDestinationBytes: number;
    }
  | { readonly reason: "destination_secret"; readonly ruleId: SecretRuleId };

export type TierSelection =
  | {
      readonly state: "selected";
      /** Declared or inferred packages, sorted; files in none belong to the root package "". */
      readonly packages: readonly string[];
      /** In tier order, then inclusion order. */
      readonly items: readonly SelectedItem[];
      /** Files tried and never included, in the order they were first tried. */
      readonly skipped: readonly SkippedFile[];
      /** Files whose rendering matched the secret scan, in the order they were tried. */
      readonly blocked: readonly BlockedFile[];
      readonly tiers: readonly TierUsage[];
      readonly gaps: readonly SelectionGap[];
      readonly reservedTreeBytes: number;
    }
  /** The session stops before any model call (IMPL §1.5, destination rule). */
  | { readonly state: "stopped"; readonly stop: DestinationStop }
  /** A file's content no longer matches the snapshot (IMPL §1.3). */
  | { readonly state: "unstable"; readonly changedPaths: readonly string[] };

class ChangedSinceSnapshot extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} changed since the snapshot`);
    this.path = path;
  }
}

export async function selectTiers(
  snapshot: Snapshot,
  settings: ContextSettings,
  fs: RepositoryFs,
): Promise<TierSelection> {
  const caps = settings.tierCaps;
  const capTotal = caps.tier1 + caps.tier2 + caps.tier3 + caps.tier4 + caps.tier5;
  if (capTotal > settings.initialContextBytes) {
    throw new Error(
      `The tier caps add up to ${capTotal} bytes, more than initialContextBytes (${settings.initialContextBytes}).`,
    );
  }

  const destination = snapshot.destination;
  if (destination.state === "unavailable") {
    return {
      state: "stopped",
      stop: { reason: "destination_unavailable", detail: destination.reason },
    };
  }
  let destinationItem: SelectedItem | undefined;
  if (destination.state === "present") {
    const input = {
      id: itemId(1, 1),
      path: DESTINATION_PATH,
      hash: destination.hash,
      tier: 1,
      reason: "tier1:destination",
      content: destination.bytes,
      blocks: blockRanges(destination.bytes, destination.blocks),
    };
    const rendered = renderItem(input, "none", settings.maxDestinationBytes);
    const secret = rendered === undefined ? undefined : scanItem({ ...input, tier: 1, rendered });
    if (secret !== undefined) {
      return { state: "stopped", stop: { reason: "destination_secret", ruleId: secret } };
    }
    if (rendered === undefined) {
      const full = renderItem(input, "none", Number.POSITIVE_INFINITY);
      return {
        state: "stopped",
        stop: {
          reason: "destination_too_large",
          renderedBytes: full?.bytes ?? 0,
          maxDestinationBytes: settings.maxDestinationBytes,
        },
      };
    }
    destinationItem = { ...input, tier: 1, rendered };
  }

  try {
    return await new Selector(snapshot, settings, fs).run(destinationItem);
  } catch (error) {
    if (error instanceof ChangedSinceSnapshot) {
      return { state: "unstable", changedPaths: [error.path] };
    }
    throw error;
  }
}

function itemId(tier: number, sequence: number): string {
  return `T${tier}-${`${sequence}`.padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// Names. Tier 1 matches exactly, because agents load these files by exact name. Tiers 2, 3 and 5
// compare ASCII letters case-insensitively.

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Directory names above the file, lower-cased. */
function directorySegments(path: string): string[] {
  return asciiLower(path).split("/").slice(0, -1);
}

function depthOf(path: string): number {
  return path.split("/").length - 1;
}

function isTier1(path: string): boolean {
  const name = baseName(path);
  return (
    name === "CLAUDE.md" ||
    name === "AGENTS.md" ||
    path.startsWith(".claude/") ||
    path === ".cursorrules" ||
    path.startsWith(".cursor/rules/") ||
    path === ".github/copilot-instructions.md"
  );
}

const MARKDOWN = [".md", ".markdown", ".mdx"];

function isMarkdown(path: string): boolean {
  const name = asciiLower(baseName(path));
  return MARKDOWN.some((ext) => name.length > ext.length && name.endsWith(ext));
}

const ROOT_DOCS = ["readme", "contributing", "architecture", "development"];
const DECISION_DIRECTORIES = ["adr", "adrs", "decisions", "architecture"];
const NOT_DOCUMENTATION = [
  "changelog",
  "changes",
  "history",
  "license",
  "licence",
  "copying",
  "notice",
];
const GENERATED_API_DIRECTORIES = ["api-reference", "api-docs", "apidocs", "typedoc", "javadoc"];

type Tier2Group = 1 | 2 | 3 | 4;

/** Groups 1–3 of tier 2; group 4 needs the packages. */
function tier2Group(path: string): Tier2Group | undefined {
  const name = asciiLower(baseName(path));
  const directories = directorySegments(path);
  if (NOT_DOCUMENTATION.some((prefix) => name.startsWith(prefix))) return undefined;
  if (directories.some((segment) => GENERATED_API_DIRECTORIES.includes(segment))) return undefined;
  if (directories.length === 0 && ROOT_DOCS.some((prefix) => name.startsWith(prefix))) return 1;
  if (!isMarkdown(path)) return undefined;
  if (directories.some((segment) => DECISION_DIRECTORIES.includes(segment))) return 2;
  if (directories[0] === "docs") return 3;
  return undefined;
}

function isPackageReadme(path: string, packages: ReadonlySet<string>): boolean {
  const directory = directoryOf(path);
  return (
    directory !== "" &&
    packages.has(directory) &&
    asciiLower(baseName(path)).startsWith("readme") &&
    !directorySegments(path).some((segment) => GENERATED_API_DIRECTORIES.includes(segment))
  );
}

const WORKSPACE_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "pyproject.toml",
  "cargo.toml",
  "go.work",
  "go.mod",
];
const TASK_RUNNERS = ["makefile", "justfile", "taskfile.yml", "procfile"];
const PACKAGE_MANIFESTS = ["package.json", "pyproject.toml", "cargo.toml"];
const TOOLING_EXACT = [
  "biome.json",
  "biome.jsonc",
  "ruff.toml",
  ".ruff.toml",
  "mypy.ini",
  ".mypy.ini",
  "pytest.ini",
  "compose.yml",
  "compose.yaml",
];
const TOOLING_PREFIXES = [
  "eslint.config.",
  ".eslintrc",
  ".prettierrc",
  "prettier.config.",
  "vitest.config.",
  "vitest.workspace.",
  "jest.config.",
  "playwright.config.",
  "dockerfile",
];

type Tier3Group = 1 | 2 | 3 | 4 | 5;

/**
 * Groups 1, 2, 4 and 5 of tier 3; group 3, package manifests, needs the packages. CI comes last:
 * workflows are often large, and would otherwise crowd out small, convention-rich tooling files.
 */
function tier3Group(path: string): Tier3Group | undefined {
  const lower = asciiLower(path);
  const name = baseName(lower);
  const root = !lower.includes("/");
  if (root && WORKSPACE_FILES.includes(name)) return 1;
  if (root && TASK_RUNNERS.includes(name)) return 2;
  if (
    lower === ".gitlab-ci.yml" ||
    lower === ".circleci/config.yml" ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(lower)
  ) {
    return 5;
  }
  if (
    TOOLING_EXACT.includes(name) ||
    TOOLING_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (name.startsWith("tsconfig") && name.endsWith(".json")) ||
    /^docker-compose.*\.ya?ml$/.test(name)
  ) {
    return 4;
  }
  return undefined;
}

function isPackageManifest(path: string): boolean {
  return path.includes("/") && PACKAGE_MANIFESTS.includes(asciiLower(baseName(path)));
}

function isTestFile(path: string): boolean {
  const name = asciiLower(baseName(path));
  return (
    name.includes(".test.") ||
    name.includes(".spec.") ||
    /^test_.*\.py$/.test(name) ||
    /_test\.(?:py|go)$/.test(name) ||
    directorySegments(path).some((s) => s === "tests" || s === "test" || s === "__tests__")
  );
}

const ENTRY_POINTS = ["index", "main", "app", "server", "cli", "mod", "lib", "__main__"];
const BOUNDARIES = [
  "client",
  "api",
  "routes",
  "router",
  "schema",
  "schemas",
  "model",
  "models",
  "service",
  "config",
];
/** Tests, examples, fixtures and type declarations: they show less of the project's own code. */
const SUPPORTING_DIRECTORIES = ["test", "tests", "__tests__", "examples", "fixtures"];
const RANK_REASONS = [
  "tier5:rank1:entry-point",
  "tier5:rank2:boundary-name",
  "tier5:rank3:other",
  "tier5:rank4:supporting",
];
const SUPPORTING_RANK = 3;

function rankOf(path: string): 0 | 1 | 2 | 3 {
  const name = asciiLower(baseName(path));
  if (
    name.endsWith(".d.ts") ||
    directorySegments(path).some((segment) => SUPPORTING_DIRECTORIES.includes(segment))
  ) {
    return SUPPORTING_RANK;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (ENTRY_POINTS.includes(stem)) return 0;
  if (BOUNDARIES.includes(stem)) return 1;
  return 2;
}

/** Shallower first, then path order. */
function byDepthThenPath(a: string, b: string): number {
  return depthOf(a) - depthOf(b) || comparePaths(a, b);
}

/** Groups `paths` by package and takes one from each package in turn, in package order. */
function roundRobin(paths: readonly string[], packages: readonly string[]): string[] {
  const queues = new Map<string, string[]>();
  for (const path of paths) {
    const pkg = packageOf(packages, path);
    queues.set(pkg, [...(queues.get(pkg) ?? []), path]);
  }
  const ordered = [...queues.keys()].sort(comparePaths).map((pkg) => queues.get(pkg) ?? []);
  const result: string[] = [];
  for (let round = 0; ordered.some((queue) => round < queue.length); round++) {
    for (const queue of ordered) {
      const path = queue[round];
      if (path !== undefined) result.push(path);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Selection

interface Fill {
  readonly tier: SelectedTier;
  readonly capBytes: number;
  readonly budgetBytes: number;
  usedBytes: number;
  sequence: number;
  testExamples: number;
}

const utf8 = new TextDecoder("utf-8");

class Selector {
  private readonly hashes = new Map<string, Hash>();
  private readonly contents = new Map<string, Uint8Array>();
  private readonly items: SelectedItem[] = [];
  private readonly skipped = new Map<string, SkippedFile>();
  private readonly blocked: BlockedFile[] = [];
  private readonly fills: Fill[] = [];

  private readonly snapshot: Snapshot;
  private readonly settings: ContextSettings;
  private readonly fs: RepositoryFs;

  constructor(snapshot: Snapshot, settings: ContextSettings, fs: RepositoryFs) {
    this.snapshot = snapshot;
    this.settings = settings;
    this.fs = fs;
    for (const file of snapshot.files) {
      if (file.status === "read") this.hashes.set(file.path, file.hash);
    }
    if (snapshot.destination.state === "present") {
      this.contents.set(DESTINATION_PATH, snapshot.destination.bytes);
    }
  }

  async run(destination: SelectedItem | undefined): Promise<TierSelection> {
    const candidates = [...this.hashes.keys()].sort(comparePaths);
    const claimed = new Set<string>();
    const claim = (paths: readonly string[]) => {
      for (const path of paths) claimed.add(path);
      return paths;
    };

    // Matching that doesn't depend on packages.
    const tier1 = claim(candidates.filter((p) => p !== DESTINATION_PATH && isTier1(p)));
    const tier2 = new Map<string, Tier2Group>();
    const tier3 = new Map<string, Tier3Group>();
    for (const path of candidates) {
      if (claimed.has(path) || path === DESTINATION_PATH) continue;
      const group2 = tier2Group(path);
      const group3 = group2 === undefined ? tier3Group(path) : undefined;
      if (group2 !== undefined) tier2.set(path, group2);
      else if (group3 !== undefined) tier3.set(path, group3);
    }
    claim([...tier2.keys(), ...tier3.keys()]);

    const packages = await this.packages(
      candidates.filter((p) => !claimed.has(p) && p !== DESTINATION_PATH && this.isSource(p)),
    );
    const packageSet = new Set(packages);
    for (const path of candidates) {
      if (claimed.has(path) || path === DESTINATION_PATH) continue;
      if (isPackageReadme(path, packageSet)) tier2.set(path, 4);
      else if (isPackageManifest(path)) tier3.set(path, 3);
    }
    claim([...tier2.keys(), ...tier3.keys()]);
    if (destination !== undefined) claimed.add(DESTINATION_PATH);

    const { imported, gaps } = await this.resolveImports(
      destination === undefined ? tier1 : [DESTINATION_PATH, ...tier1],
    );
    const importedOnly = imported.filter(
      (p) => !claimed.has(p) && !(this.isSource(p) && p !== DESTINATION_PATH),
    );
    claim(importedOnly);
    const sources = candidates.filter((p) => !claimed.has(p) && this.isSource(p));

    // Tier 1.
    const fill1 = this.fill(1, this.settings.tierCaps.tier1, 0);
    if (destination !== undefined) {
      this.items.push(destination);
      fill1.usedBytes += destination.rendered.bytes;
      fill1.sequence = 1;
    }
    const tier1Reasons = new Map<string, string>([
      ...tier1.map((p): [string, string] => [p, "tier1:agent-config"]),
      ...importedOnly.map((p): [string, string] => [p, "tier1:import"]),
    ]);
    const skippedConfig: string[] = [];
    for (const path of [...tier1Reasons.keys()].sort(byDepthThenPath)) {
      const added = await this.add(fill1, path, tier1Reasons.get(path) ?? "", "none", Infinity);
      if (added === "skipped") skippedConfig.push(path);
    }
    if (skippedConfig.length > 0) {
      gaps.push({ gapType: "other", statement: AGENT_CONFIG_SKIPPED, relatedPaths: skippedConfig });
    }

    // Tier 2.
    const fill2 = this.fill(2, this.settings.tierCaps.tier2, remaining(fill1));
    const tier2Reasons = [
      "tier2:group1:root-doc",
      "tier2:group2:decision-doc",
      "tier2:group3:docs",
      "tier2:group4:package-readme",
    ];
    for (const group of [1, 2, 3, 4] as const) {
      const paths = [...tier2].filter(([, g]) => g === group).map(([p]) => p);
      for (const path of group === 4 ? roundRobin(paths, packages) : paths) {
        const reason = tier2Reasons[group - 1] ?? "";
        await this.add(fill2, path, reason, "markdown", this.settings.perFileCaps.tier2);
      }
    }

    // Tier 3.
    const fill3 = this.fill(3, this.settings.tierCaps.tier3, remaining(fill2));
    const tier3Reasons = [
      "tier3:group1:workspace",
      "tier3:group2:task-runner",
      "tier3:group3:package-manifest",
      "tier3:group4:tooling",
      "tier3:group5:ci",
    ];
    for (const group of [1, 2, 3, 4, 5] as const) {
      const paths = [...tier3].filter(([, g]) => g === group).map(([p]) => p);
      for (const path of group === 3 ? roundRobin(paths, packages) : paths) {
        const reason = tier3Reasons[group - 1] ?? "";
        await this.add(fill3, path, reason, "lines", this.settings.perFileCaps.tier3);
      }
    }

    // Tier 5.
    const fill5 = this.fill(5, this.settings.tierCaps.tier5, remaining(fill3));
    await this.fillTier5(fill5, sources, packages);

    return {
      state: "selected",
      packages,
      items: this.items,
      skipped: [...this.skipped.values()],
      blocked: this.blocked,
      tiers: this.fills.map((fill) => ({
        tier: fill.tier,
        capBytes: fill.capBytes,
        budgetBytes: fill.budgetBytes,
        usedBytes: fill.usedBytes,
        items: this.items.filter((item) => item.tier === fill.tier).length,
        skipped: [...this.skipped.values()].filter((s) => s.tier === fill.tier).length,
        ...(fill.tier === 5 ? { testExamples: fill.testExamples } : {}),
      })),
      gaps,
      reservedTreeBytes: this.settings.tierCaps.tier4,
    };
  }

  private async fillTier5(fill: Fill, sources: readonly string[], packages: readonly string[]) {
    const settings = this.settings;
    const byPackage = new Map<string, string[]>();
    for (const path of sources) {
      const pkg = packageOf(packages, path);
      byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), path]);
    }
    const order = [...byPackage.keys()].sort(comparePaths);

    // The test reserve: one example per package, the first test file in path order. If the scan
    // blocks it, the next test file takes its place.
    const reserve = Math.min(settings.testReserveBytes, fill.budgetBytes);
    const tried = new Set<string>();
    for (const pkg of order) {
      for (const test of (byPackage.get(pkg) ?? []).filter(isTestFile)) {
        const limit = Math.min(settings.testExampleBytes, reserve - fill.usedBytes);
        const added = await this.add(fill, test, "tier5:test-example", "code", limit);
        if (added === "blocked") {
          tried.add(test);
          continue;
        }
        if (added === "added") {
          tried.add(test);
          fill.testExamples++;
        }
        break;
      }
    }

    // Ranked round-robin over the rest: first every package's ordinary files, then, in a second
    // pass, the supporting ones. A top-level test/ or examples/ directory is a package of its
    // own, so ranking within packages alone would still give it a turn in every round.
    let count = 0;
    for (const supporting of [false, true]) {
      const queues = order.map((pkg) =>
        (byPackage.get(pkg) ?? [])
          .filter((path) => !tried.has(path) && (rankOf(path) === SUPPORTING_RANK) === supporting)
          .sort((a, b) => rankOf(a) - rankOf(b) || byDepthThenPath(a, b)),
      );
      for (let round = 0; queues.some((queue) => round < queue.length); round++) {
        for (const queue of queues) {
          if (count >= settings.maxSourceFiles) return;
          const path = queue[round];
          if (path === undefined) continue;
          const reason = RANK_REASONS[rankOf(path)] ?? "";
          const added = await this.add(fill, path, reason, "code", settings.perFileCaps.tier5);
          // An outline alone (IMPL §1.6) costs little and shows no code, so it takes no slot.
          if (added === "added" && (this.items.at(-1)?.rendered.included.length ?? 0) > 0) count++;
        }
      }
    }
  }

  private fill(tier: SelectedTier, capBytes: number, passedDown: number): Fill {
    const fill: Fill = {
      tier,
      capBytes,
      budgetBytes: capBytes + passedDown,
      usedBytes: 0,
      sequence: 0,
      testExamples: 0,
    };
    this.fills.push(fill);
    return fill;
  }

  /**
   * Includes `path`, excerpted if allowed, within its per-file limit and the tier's remaining
   * budget, unless its rendering matches the secret scan.
   */
  private async add(
    fill: Fill,
    path: string,
    reason: string,
    strategy: ExcerptStrategy,
    perFileLimit: number,
  ): Promise<"added" | "skipped" | "blocked"> {
    const hash = this.hashes.get(path);
    if (hash === undefined) throw new Error(`${path} is not a candidate`);
    const limit = Math.min(perFileLimit, remaining(fill));
    const input = { id: itemId(fill.tier, fill.sequence + 1), path, hash, tier: fill.tier, reason };
    // The rendering of an empty file is the smallest possible, so a file that can't fit even
    // that is skipped without being read.
    const smallest = renderItem({ ...input, content: new Uint8Array() }, "none", Infinity);
    const rendered =
      smallest !== undefined && smallest.bytes <= limit
        ? renderItem({ ...input, content: await this.content(path) }, strategy, limit)
        : undefined;
    if (rendered === undefined) {
      this.skipped.set(path, { path, tier: fill.tier, reason: `tier${fill.tier}:cap-reached` });
      return "skipped";
    }
    const item: SelectedItem = { ...input, rendered };
    const ruleId = scanItem(item);
    if (ruleId !== undefined) {
      this.skipped.delete(path);
      this.blocked.push({ path, tier: fill.tier, ruleId });
      return "blocked";
    }
    this.skipped.delete(path);
    this.items.push(item);
    fill.sequence++;
    fill.usedBytes += rendered.bytes;
    return "added";
  }

  /** Live content, verified against the snapshot hash. */
  private async content(path: string): Promise<Uint8Array> {
    const cached = this.contents.get(path);
    if (cached !== undefined) return cached;
    const hash = this.hashes.get(path);
    const file = this.snapshot.files.find((f) => f.path === path);
    const size = file !== undefined && "size" in file ? file.size : 0;
    const result = await this.fs.read(path, size);
    if (!result.ok || result.bytes === undefined || sha256(result.bytes) !== hash) {
      throw new ChangedSinceSnapshot(path);
    }
    this.contents.set(path, result.bytes);
    return result.bytes;
  }

  private isSource(path: string): boolean {
    const name = asciiLower(baseName(path));
    return this.settings.sourceExtensions.some((extension) => {
      const ext = asciiLower(extension);
      return name.length > ext.length && name.endsWith(ext);
    });
  }

  /** Workspace members; otherwise top-level directories with source files; otherwise the root. */
  private async packages(sources: readonly string[]): Promise<string[]> {
    const text = async (path: string) =>
      this.hashes.has(path) ? utf8.decode(await this.content(path)) : undefined;
    const patterns = workspacePatterns({
      ...optional("packageJson", await text("package.json")),
      ...optional("lernaJson", await text("lerna.json")),
      ...optional("pnpmWorkspace", await text("pnpm-workspace.yaml")),
    });
    if (patterns.length > 0) {
      // As in npm and pnpm, a member directory has a package.json directly inside it.
      const directories = this.snapshot.files
        .filter(
          (file) =>
            baseName(file.path) === "package.json" &&
            file.path.includes("/") &&
            (file.status === "read" || file.status === "listed_only"),
        )
        .map((file) => directoryOf(file.path));
      const members = matchWorkspaceMembers(patterns, directories);
      if (members.length > 0) return members;
    }
    const topLevel = new Set(
      sources.filter((p) => p.includes("/")).map((p) => p.split("/")[0] ?? ""),
    );
    return topLevel.size > 0 ? [...topLevel].sort(comparePaths) : [""];
  }

  /** Follows `@path` imports from tier 1 Markdown, recursively and each path once. */
  private async resolveImports(
    starts: readonly string[],
  ): Promise<{ imported: string[]; gaps: SelectionGap[] }> {
    const visited = new Set(starts);
    const imported: string[] = [];
    const outside: { importer: string; written: string }[] = [];
    const queue = [...starts];
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      if (!isMarkdown(path)) continue;
      const seen = new Set<string>();
      for (const written of findImports(await this.content(path))) {
        const target = resolveImport(path, written);
        if (!target.inside) {
          if (!seen.has(written)) outside.push({ importer: path, written });
          seen.add(written);
        } else if (this.hashes.has(target.path) && !visited.has(target.path)) {
          visited.add(target.path);
          imported.push(target.path);
          queue.push(target.path);
        }
      }
    }
    // Stable sort: by importer, then order of appearance.
    outside.sort((a, b) => comparePaths(a.importer, b.importer));
    return {
      imported,
      // The import is scanned before it is cut, so a cut can't leave part of a secret behind.
      gaps: outside.map(({ importer, written }) => ({
        gapType: "other",
        statement:
          scanText(written) === undefined
            ? `\`${importer}\` imports \`${cutLabel(written)}\`, which is outside the repository and was not read.`
            : importWithheld(importer),
        relatedPaths: [importer],
      })),
    };
  }
}

function remaining(fill: Fill): number {
  return Math.max(0, fill.budgetBytes - fill.usedBytes);
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}
