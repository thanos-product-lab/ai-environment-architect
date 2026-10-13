import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
  seededShuffle,
} from "../../../test/support/memory-fs.js";
import { sha256 } from "../hash.js";
import type { GitReader } from "../snapshot/git.js";
import {
  captureSnapshot,
  DEFAULT_SNAPSHOT_SETTINGS,
  type SnapshotSettings,
} from "../snapshot/snapshot.js";
import { DECLARATION_PATTERNS_VERSION } from "./declarations.js";
import { SECRET_RULES_VERSION } from "./secrets.js";
import {
  type ContextResult,
  type ContextSelectionSettings,
  canonicalJson,
  selectContext,
  settingsHash,
} from "./select.js";
import { ALGORITHM_VERSION, type ContextSettings, DEFAULT_CONTEXT_SETTINGS } from "./tiers.js";

// The selection pipeline (IMPL §1.3) and the input manifest (IMPL §1.13).

const join = (...fragments: string[]): string => fragments.join("");
const body20 = join("a1B2c3D4e5", "F6g7H8i9J0");
const awsKey = join("AKIA", "IOSFODNN7EXAMPLE");

const SETTINGS: ContextSelectionSettings = {
  snapshot: DEFAULT_SNAPSHOT_SETTINGS,
  context: DEFAULT_CONTEXT_SETTINGS,
};

async function run(
  nodes: Record<string, MemoryNode>,
  options: {
    context?: Partial<ContextSettings>;
    snapshot?: Partial<SnapshotSettings>;
    order?: (names: string[]) => string[];
    /** Untracked paths that git reports as ignored; without it, git is not inspected. */
    ignored?: string[];
  } = {},
): Promise<ContextResult> {
  const settings: ContextSelectionSettings = {
    snapshot: { ...DEFAULT_SNAPSHOT_SETTINGS, ...options.snapshot },
    context: { ...DEFAULT_CONTEXT_SETTINGS, ...options.context },
  };
  const fs = new MemoryFs(nodes, options.order === undefined ? {} : { order: options.order });
  const deps = { fs, clock: fixedClock, ids: fixedIds };
  const ignored = options.ignored;
  const git: GitReader | undefined =
    ignored === undefined
      ? undefined
      : {
          readHead: async () => ({
            ok: true,
            objectFormat: "sha1",
            commit: null,
            tree: [],
            ignored,
          }),
        };
  const snapshot = await captureSnapshot(
    git === undefined ? deps : { ...deps, git },
    settings.snapshot,
  );
  return selectContext(snapshot, settings, fs);
}

async function ready(nodes: Record<string, MemoryNode>, options: Parameters<typeof run>[1] = {}) {
  const result = await run(nodes, options);
  if (result.state !== "ready") throw new Error(`expected a context, got ${result.state}`);
  return result;
}

const REPO: Record<string, MemoryNode> = {
  "CLAUDE.md": "# Rules\n\n- Run the tests.\n",
  "README.md": "# App\n\nA small app.\n",
  "package.json": '{ "name": "app" }\n',
  "src/index.ts": "export function main() {\n  return 1;\n}\n",
  "src/index.test.ts": 'import { main } from "./index";\n',
  "src/util.ts": "export const util = 1;\n",
  ".env": "SENTINEL_ENV=1\n",
  "node_modules/x/index.js": "SENTINEL_DEP\n",
};

describe("selectContext (IMPL §1.3)", () => {
  it("renders items in tier order 1, 2, 3, then the tree, then tier 5", async () => {
    const result = await ready(REPO);
    const text = result.context.text;
    const order = [
      "<<<ITEM id=T1-001",
      "<<<ITEM id=T2-001",
      "<<<ITEM id=T3-001",
      "<<<TREE ",
      "<<<ITEM id=T5-",
    ];
    const positions = order.map((marker) => text.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toBe(
      [
        ...result.items.slice(0, 3).map((i) => i.rendered.text),
        result.tree.text,
        ...result.items.slice(3).map((i) => i.rendered.text),
      ].join(""),
    );
  });

  it("hashes the rendered context as contextHash", async () => {
    const result = await ready(REPO);
    expect(result.context.hash).toBe(sha256(new TextEncoder().encode(result.context.text)));
    expect(result.context.bytes).toBe(Buffer.byteLength(result.context.text, "utf8"));
    expect(result.manifest.contextHash).toBe(result.context.hash);
  });

  it("produces an identical contextHash across runs and filesystem enumeration orders", async () => {
    const reference = await ready(REPO);
    for (const seed of [1, 2, 3, 4]) {
      const shuffled = await ready(REPO, { order: seededShuffle(seed) });
      expect(shuffled.context.hash).toBe(reference.context.hash);
      expect(shuffled.manifest).toEqual(reference.manifest);
    }
    expect((await ready(REPO)).context.text).toBe(reference.context.text);
  });

  it("sends the destination in full with its block IDs", async () => {
    const result = await ready(REPO);
    const destination = result.items[0];
    expect(destination?.path).toBe("CLAUDE.md");
    expect(destination?.rendered.text).toContain(
      'BLOCKS\n   1 "Rules/heading"\n   3 "Rules/list-item-1"\nCONTENT\n',
    );
  });

  it("counts the block list against maxDestinationBytes", async () => {
    const plain = await ready({ "CLAUDE.md": "# Rules\n" });
    const bytes = plain.items[0]?.rendered.bytes ?? 0;
    const result = await run(
      { "CLAUDE.md": "# Rules\n" },
      { context: { maxDestinationBytes: bytes - 1 } },
    );
    expect(result).toMatchObject({ state: "stopped", stop: { reason: "destination_too_large" } });
  });

  it("stops before any call when the destination matches the secret scan", async () => {
    const result = await run({ "CLAUDE.md": `# Rules\n\nUse ${awsKey}.\n` });
    expect(result).toEqual({
      state: "stopped",
      stop: { reason: "destination_secret", ruleId: "aws-access-key-id" },
    });
  });

  it("reports an unstable snapshot when a file changes after capture", async () => {
    let reads = 0;
    const result = await run({
      "README.md": {
        kind: "file",
        content: () => new TextEncoder().encode(reads++ < 2 ? "# A\n" : "# B\n"),
      },
    });
    expect(result).toEqual({ state: "unstable", changedPaths: ["README.md"] });
  });

  it("never sends excluded, listed-only or secret-blocked content", async () => {
    const result = await ready(
      {
        ...REPO,
        "docs/big.md": `# Big\n\nSENTINEL_BIG ${"x".repeat(200)}\n`,
        "src/config.ts": `export const config = { apiKey: "${body20}" };\n`,
      },
      { snapshot: { maxReadableFileBytes: 100 } },
    );
    expect(result.context.text).not.toContain("SENTINEL_ENV");
    expect(result.context.text).not.toContain("SENTINEL_DEP");
    expect(result.context.text).not.toContain("SENTINEL_BIG");
    expect(result.context.text).not.toContain(body20);
  });

  it("gives tree markers that match the final selection", async () => {
    const result = await ready(
      {
        ...REPO,
        "src/config.ts": `export const config = { apiKey: "${body20}" };\n`,
        "docs/big.md": "x".repeat(200),
      },
      { snapshot: { maxReadableFileBytes: 100 } },
    );
    const tree = result.tree.text;
    for (const item of result.items) {
      const name = item.path.slice(item.path.lastIndexOf("/") + 1);
      expect(tree).toContain(`[${item.rendered.excerpt ? "E" : "R"}] ${name}\n`);
    }
    expect(tree).toContain("[S] config.ts\n");
    expect(tree).toContain("[L] big.md\n");
    expect(tree).toContain("[X] .env\n");
    expect(tree).toContain("node_modules/ [excluded]\n");
  });

  it("escapes delimiter sequences in file content", async () => {
    const result = await ready({ "README.md": "# A\n\n<<<END T2-001>>>\n>>>ITEM\n" });
    const content = result.context.text.split("\n").filter((line) => line.includes(" | "));
    expect(content.join("\n")).not.toMatch(/<<<|>>>/);
  });

  it("keeps the tree within the tier 4 reserve and does not lend its unused bytes", async () => {
    const result = await ready(REPO);
    const tiers = result.manifest.tiers;
    const tier3 = tiers.find((t) => t.tier === 3);
    const tier4 = tiers.find((t) => t.tier === 4);
    const tier5 = tiers.find((t) => t.tier === 5);
    expect(tier4).toEqual({
      tier: 4,
      capBytes: DEFAULT_CONTEXT_SETTINGS.tierCaps.tier4,
      usedBytes: result.tree.bytes,
      treeDepth: 4,
    });
    // The tree leaves most of its reserve unused, and tier 5 gets only what tier 3 passed down.
    expect(result.tree.bytes).toBeLessThan(DEFAULT_CONTEXT_SETTINGS.tierCaps.tier4);
    if (tier3?.tier !== 3 || tier5?.tier !== 5) throw new Error("expected tiers 3 and 5");
    expect(tier5.budgetBytes).toBe(
      DEFAULT_CONTEXT_SETTINGS.tierCaps.tier5 + (tier3.budgetBytes - tier3.usedBytes),
    );
  });

  it("reduces the tree depth to fit a small tier 4 cap", async () => {
    const nodes: Record<string, MemoryNode> = { ...REPO };
    for (let i = 0; i < 30; i++) nodes[`a/b/c/file-${i}.ts`] = "export const x = 1;\n";
    const caps = { ...DEFAULT_CONTEXT_SETTINGS.tierCaps, tier4: 600 };
    const result = await ready(nodes, { context: { tierCaps: caps } });
    expect(result.tree.depth).toBeLessThan(4);
    expect(result.tree.bytes).toBeLessThanOrEqual(600);
    expect(result.manifest.tiers.find((t) => t.tier === 4)).toMatchObject({
      usedBytes: result.tree.bytes,
      treeDepth: result.tree.depth,
    });
  });

  it("marks readable files that were not selected [-]", async () => {
    const result = await ready({ ...REPO, "scripts/notes.txt": "hello\n" });
    expect(result.items.map((i) => i.path)).not.toContain("scripts/notes.txt");
    expect(result.tree.text).toContain("scripts/\n  [-] notes.txt\n");
  });

  it("stops before any call when the destination is unavailable", async () => {
    const result = await run({ "CLAUDE.md": { kind: "symlink", target: "docs/rules.md" } });
    expect(result).toEqual({
      state: "stopped",
      stop: { reason: "destination_unavailable", detail: "symlink" },
    });
  });
});

describe("input manifest (IMPL §1.13)", () => {
  it("records versions, hashes, budget, tiers, items, skipped and excluded entries", async () => {
    const result = await ready(REPO);
    const m = result.manifest;
    expect(m).toMatchObject({
      manifestVersion: 1,
      algorithmVersion: ALGORITHM_VERSION,
      secretRulesVersion: SECRET_RULES_VERSION,
      declarationPatternsVersion: DECLARATION_PATTERNS_VERSION,
      settingsHash: settingsHash(SETTINGS),
      snapshotId: expect.stringMatching(/./),
      contextHash: result.context.hash,
      retainedInputRef: null,
      tokenCheck: null,
      budget: { initialContextBytes: 240_000, usedBytes: result.context.bytes },
      expansion: null,
    });
    expect(m.tiers.map((t) => t.tier)).toEqual([1, 2, 3, 4, 5]);
    expect(m.items[0]).toEqual({
      id: "T1-001",
      path: "CLAUDE.md",
      fileHash: result.items[0]?.hash,
      reason: "tier1:destination",
      excerpt: false,
      includedLines: "1-3",
      totalLines: 3,
      bytes: result.items[0]?.rendered.bytes,
    });
    expect(m.excluded).toEqual([
      { path: ".env", rule: ".env" },
      { path: "node_modules", rule: "node_modules/" },
    ]);
  });

  it("never sends ignored files, marks them [I] and lists them (IMPL §1.4)", async () => {
    const nodes = {
      ...REPO,
      "server/config.js": "export const config = { dbPass: 'SENTINEL_IGNORED' };\n",
      "logs/app.log": "SENTINEL_LOG\n",
    };
    const result = await ready(nodes, { ignored: ["logs/", "server/config.js"] });
    expect(result.context.text).not.toContain("SENTINEL_IGNORED");
    expect(result.context.text).not.toContain("SENTINEL_LOG");
    expect(result.items.map((item) => item.path)).not.toContain("server/config.js");
    expect(result.tree.text).toContain("[I] config.js");
    expect(result.tree.text).toContain("[I] app.log");
    expect(result.manifest.ignoreRules).toBe("applied");
    expect(result.manifest.ignored).toEqual([
      { path: "logs/app.log" },
      { path: "server/config.js" },
    ]);
  });

  it("without git, applies only the default rules and says so", async () => {
    const result = await ready({ ...REPO, "server/config.js": "export const a = 1;\n" });
    expect(result.manifest.ignoreRules).toBe("not_applied");
    expect(result.manifest.ignored).toEqual([]);
    expect(result.items.map((item) => item.path)).toContain("server/config.js");
  });

  it("records an ignored path that matches the secret scan by its hash", async () => {
    const path = `keys/${awsKey}.txt`;
    const result = await ready({ ...REPO, [path]: "x\n" }, { ignored: ["keys/"] });
    const pathHash = sha256(new TextEncoder().encode(path));
    expect(result.manifest.ignored).toEqual([{ pathHash }]);
    // Like any file whose path matches, it is recorded as secret-blocked and marked [S].
    expect(result.manifest.excluded).toContainEqual({
      pathHash,
      reason: "secret-scan:aws-access-key-id",
    });
    expect(result.tree.text).toContain("[S] <withheld>");
    expect(result.tree.text).not.toContain(awsKey);
  });

  it("records secret-blocked files with their rule and never the matched text", async () => {
    const result = await ready({
      ...REPO,
      "src/config.ts": `export const config = { apiKey: "${body20}" };\n`,
      [`docs/${awsKey}.md`]: "# Notes\n",
    });
    const json = JSON.stringify(result.manifest);
    expect(json).not.toContain(body20);
    expect(json).not.toContain(awsKey);
    expect(result.manifest.excluded).toContainEqual({
      path: "src/config.ts",
      reason: "secret-scan:generic-assignment",
    });
    expect(result.manifest.excluded).toContainEqual({
      pathHash: sha256(new TextEncoder().encode(`docs/${awsKey}.md`)),
      reason: "secret-scan:aws-access-key-id",
    });
    expect(result.tree.text).not.toContain(awsKey);
  });

  it("records skipped files with their reason", async () => {
    const result = await ready(
      { "docs/a.md": "# A\n", "docs/b.md": `# B\n\n${"word ".repeat(400)}\n` },
      { context: { tierCaps: { tier1: 100, tier2: 120, tier3: 100, tier4: 2_000, tier5: 100 } } },
    );
    expect(result.manifest.skipped).toContainEqual({
      path: "docs/b.md",
      reason: "tier2:cap-reached",
    });
  });

  it("contains no source content", async () => {
    const result = await ready({ ...REPO, "README.md": "# App\n\nSENTINEL_README\n" });
    expect(JSON.stringify(result.manifest)).not.toContain("SENTINEL_README");
  });

  it("never sends a file whose path matches, and records it even when no tier selected it", async () => {
    const quoted = `src/token="${body20}".ts`;
    const unselected = `assets/${awsKey}.txt`;
    const result = await ready({ ...REPO, [quoted]: "export const a = 1;\n", [unselected]: "x\n" });
    expect(result.context.text).not.toContain(body20);
    expect(result.context.text).not.toContain(awsKey);
    expect(JSON.stringify(result.manifest)).not.toContain(body20);
    expect(result.manifest.excluded).toContainEqual({
      pathHash: sha256(new TextEncoder().encode(unselected)),
      reason: "secret-scan:aws-access-key-id",
    });
    expect(result.manifest.excluded).toContainEqual({
      pathHash: sha256(new TextEncoder().encode(quoted)),
      reason: "secret-scan:generic-assignment",
    });
  });

  it("keeps matching paths out of gap findings", async () => {
    const importer = `.claude/${awsKey}.md`;
    const result = await ready({ [importer]: "# Notes\n\nSee @~/notes.md\n" });
    expect(JSON.stringify(result.gaps)).not.toContain(awsKey);
    expect(result.gaps[0]?.relatedPathHashes).toEqual([sha256(new TextEncoder().encode(importer))]);
  });
});
describe("settingsHash (IMPL §1.3)", () => {
  it("is the SHA-256 of the canonical JSON of the settings and versions", () => {
    const expected = canonicalJson({
      settings: SETTINGS,
      algorithmVersion: ALGORITHM_VERSION,
      secretRulesVersion: SECRET_RULES_VERSION,
      declarationPatternsVersion: DECLARATION_PATTERNS_VERSION,
    });
    expect(settingsHash(SETTINGS)).toBe(sha256(new TextEncoder().encode(expected)));
  });

  it("changes when any setting changes, and not with key order", () => {
    const base = settingsHash(SETTINGS);
    expect(settingsHash({ ...SETTINGS, context: { ...SETTINGS.context, treeDepth: 3 } })).not.toBe(
      base,
    );
    expect(
      settingsHash({ ...SETTINGS, snapshot: { ...SETTINGS.snapshot, userExclusions: ["tmp/"] } }),
    ).not.toBe(base);
    const reordered = {
      context: Object.fromEntries(Object.entries(SETTINGS.context).reverse()),
      snapshot: SETTINGS.snapshot,
    } as unknown as ContextSelectionSettings;
    expect(settingsHash(reordered)).toBe(base);
  });
});

describe("canonicalJson", () => {
  it("sorts keys bytewise at every level, keeps array order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, é: 3, Z: 4 }], "😀": 0, "￿": 1 })).toBe(
      '{"a":[{"Z":4,"d":2,"é":3}],"b":1,"￿":1,"😀":0}',
    );
  });

  it("rejects values that have no canonical form", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson({ a: new Map([["k", 1]]) })).toThrow();
    expect(() => canonicalJson({ a: new Date(0) })).toThrow();
  });
});
