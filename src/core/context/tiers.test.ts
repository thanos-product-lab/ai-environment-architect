import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
  seededShuffle,
} from "../../../test/support/memory-fs.js";
import { sha256 } from "../hash.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { renderItem } from "./item.js";
import {
  AGENT_CONFIG_SKIPPED,
  type ContextSettings,
  DEFAULT_CONTEXT_SETTINGS,
  selectTiers,
  type TierSelection,
} from "./tiers.js";

// Tiers, including the test reserve (IMPL §1.5).

type Selected = Extract<TierSelection, { state: "selected" }>;

async function select(
  nodes: Record<string, MemoryNode>,
  settings: Partial<ContextSettings> = {},
  order?: (names: string[]) => string[],
): Promise<TierSelection> {
  const fs = new MemoryFs(nodes, order === undefined ? {} : { order });
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    DEFAULT_SNAPSHOT_SETTINGS,
  );
  return selectTiers(snapshot, { ...DEFAULT_CONTEXT_SETTINGS, ...settings }, fs);
}

async function selected(
  nodes: Record<string, MemoryNode>,
  settings: Partial<ContextSettings> = {},
): Promise<Selected> {
  const result = await select(nodes, settings);
  if (result.state !== "selected") throw new Error(`expected a selection, got ${result.state}`);
  return result;
}

const pathsIn = (result: Selected, tier: number) =>
  result.items.filter((item) => item.tier === tier).map((item) => item.path);
const itemOf = (result: Selected, path: string) => result.items.find((i) => i.path === path);
const usage = (result: Selected, tier: number) => result.tiers.find((t) => t.tier === tier);

/** A Markdown file of about `bytes` bytes. */
const doc = (bytes: number, title = "Doc") =>
  `# ${title}\n\n${"word ".repeat(Math.ceil(bytes / 5)).trimEnd()}\n`;
/** Lines of about `bytes` bytes. */
const lines = (bytes: number) => "x = 1\n".repeat(Math.ceil(bytes / 6));
/** A source file of about `bytes` bytes, with a declaration every 300 or so. */
const code = (bytes: number) => {
  let text = 'import { a } from "./a";\n\n';
  for (let i = 0; text.length < bytes; i++) {
    text += `export function f${i}() {\n${"  const value = 1;\n".repeat(14)}}\n\n`;
  }
  return text;
};

const SMALL_CAPS: Partial<ContextSettings> = {
  tierCaps: { tier1: 2_000, tier2: 2_000, tier3: 2_000, tier4: 2_000, tier5: 2_000 },
};

describe("settings (IMPL §1.14)", () => {
  it("has the default values in the spec", () => {
    expect(DEFAULT_CONTEXT_SETTINGS).toMatchObject({
      initialContextBytes: 300_000,
      tierCaps: { tier1: 40_000, tier2: 70_000, tier3: 40_000, tier4: 20_000, tier5: 130_000 },
      maxDestinationBytes: 40_000,
      perFileCaps: { tier2: 12_000, tier3: 8_000, tier5: 12_000 },
      testReserveBytes: 15_000,
      testExampleBytes: 3_000,
      maxSourceFiles: 32,
    });
  });

  it("includes template and component files in its source extensions", () => {
    for (const extension of [".vue", ".svelte", ".astro", ".hbs", ".handlebars", ".ejs", ".njk"]) {
      expect(DEFAULT_CONTEXT_SETTINGS.sourceExtensions).toContain(extension);
    }
  });

  it("covers the declaration families and the listed languages in its source extensions", () => {
    for (const extension of [".ts", ".tsx", ".js", ".py", ".go", ".rs", ".java", ".kt", ".cs"]) {
      expect(DEFAULT_CONTEXT_SETTINGS.sourceExtensions).toContain(extension);
    }
    for (const extension of [".rb", ".php", ".swift"]) {
      expect(DEFAULT_CONTEXT_SETTINGS.sourceExtensions).toContain(extension);
    }
  });

  it("rejects tier caps that add up to more than initialContextBytes", async () => {
    await expect(select({}, { initialContextBytes: 9_999, ...SMALL_CAPS })).rejects.toThrow(
      /initialContextBytes/,
    );
  });
});

describe("budgets", () => {
  it("passes unused bytes from tiers 1, 2 and 3 down to the next tier", async () => {
    const result = await selected({ "README.md": doc(300) }, SMALL_CAPS);
    const tier2Used = usage(result, 2)?.usedBytes ?? 0;
    expect(usage(result, 1)).toMatchObject({ capBytes: 2_000, budgetBytes: 2_000, usedBytes: 0 });
    expect(usage(result, 2)).toMatchObject({ capBytes: 2_000, budgetBytes: 4_000 });
    expect(usage(result, 3)?.budgetBytes).toBe(4_000 - tier2Used + 2_000);
    expect(usage(result, 5)?.budgetBytes).toBe(4_000 - tier2Used + 2_000 + 2_000);
  });

  it("reserves tier 4's cap and never gives it to another tier", async () => {
    const result = await selected({}, SMALL_CAPS);
    expect(result.reservedTreeBytes).toBe(2_000);
    expect(usage(result, 5)?.budgetBytes).toBe(8_000);
  });

  it("keeps each tier within its budget and each item within its per-file cap", async () => {
    const nodes: Record<string, MemoryNode> = { "package.json": lines(3_000) };
    for (let i = 0; i < 6; i++) {
      nodes[`docs/d${i}.md`] = doc(900, `D${i}`);
      nodes[`src/f${i}.ts`] = code(900);
    }
    const settings: Partial<ContextSettings> = {
      ...SMALL_CAPS,
      perFileCaps: { tier2: 700, tier3: 800, tier5: 600 },
      testReserveBytes: 0,
    };
    const result = await selected(nodes, settings);
    for (const tier of result.tiers) {
      expect(tier.usedBytes).toBeLessThanOrEqual(tier.budgetBytes);
    }
    for (const item of result.items) {
      const cap = item.tier === 2 ? 700 : item.tier === 3 ? 800 : 600;
      expect(item.rendered.bytes).toBeLessThanOrEqual(cap);
    }
    expect(result.items.some((item) => item.rendered.excerpt)).toBe(true);
  });

  it("keeps trying later items after one does not fit", async () => {
    const result = await selected(
      { "docs/a.md": doc(5_000), "docs/b.md": doc(100) },
      { ...SMALL_CAPS, perFileCaps: { tier2: 12_000, tier3: 8_000, tier5: 6_000 } },
    );
    expect(itemOf(result, "docs/a.md")?.rendered.excerpt).toBe(true);
    const tiny = await selected(
      { ".claude/a.md": doc(5_000), ".claude/b.md": doc(100) },
      SMALL_CAPS,
    );
    expect(pathsIn(tiny, 1)).toEqual([".claude/b.md"]);
    expect(tiny.skipped).toContainEqual({
      path: ".claude/a.md",
      tier: 1,
      reason: "tier1:cap-reached",
    });
  });

  it("numbers items per tier in inclusion order", async () => {
    const result = await selected({
      "CLAUDE.md": "# Guide\n",
      "AGENTS.md": "# Agents\n",
      "README.md": "# Readme\n",
      "src/index.ts": "export const a = 1;\n",
      "src/main.ts": "export const b = 1;\n",
    });
    expect(result.items.map((item) => [item.id, item.path])).toEqual([
      ["T1-001", "CLAUDE.md"],
      ["T1-002", "AGENTS.md"],
      ["T2-001", "README.md"],
      ["T5-001", "src/index.ts"],
      ["T5-002", "src/main.ts"],
    ]);
    expect(itemOf(result, "README.md")?.rendered.text).toContain("<<<ITEM id=T2-001 ");
  });

  it("does not read a file whose smallest rendering cannot fit the remaining budget", async () => {
    const fs = new MemoryFs({ "src/a.ts": code(4_000), "src/b.ts": code(4_000) });
    const snapshot = await captureSnapshot(
      { fs, clock: fixedClock, ids: fixedIds },
      DEFAULT_SNAPSHOT_SETTINGS,
    );
    fs.reads.length = 0;
    await selectTiers(
      snapshot,
      {
        ...DEFAULT_CONTEXT_SETTINGS,
        tierCaps: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 50 },
        testReserveBytes: 0,
      },
      fs,
    );
    expect(fs.reads).toEqual([]);
  });
});

describe("content verification (IMPL §1.3)", () => {
  it("reports the snapshot as unstable when a file changed after capture", async () => {
    const result = await select({
      "README.md": {
        kind: "file",
        // Capture observes the file twice; selection reads it a third time.
        content: (count) => Buffer.from(count <= 2 ? "# Old\n" : "# New\n"),
      },
    });
    expect(result).toEqual({ state: "unstable", changedPaths: ["README.md"] });
  });
});

describe("tier 1: existing agent configuration", () => {
  it("matches the listed agent configuration paths", async () => {
    const result = await selected({
      "pkg/CLAUDE.md": "a\n",
      "pkg/AGENTS.md": "a\n",
      "AGENTS.md": "a\n",
      ".claude/settings.json": "{}\n",
      ".claude/agents/x.md": "a\n",
      ".cursorrules": "a\n",
      ".cursor/rules/x.mdc": "a\n",
      ".github/copilot-instructions.md": "a\n",
    });
    expect(pathsIn(result, 1).sort()).toEqual(
      [
        "pkg/CLAUDE.md",
        "pkg/AGENTS.md",
        "AGENTS.md",
        ".claude/settings.json",
        ".claude/agents/x.md",
        ".cursorrules",
        ".cursor/rules/x.mdc",
        ".github/copilot-instructions.md",
      ].sort(),
    );
    for (const item of result.items) expect(item.reason).toBe("tier1:agent-config");
  });

  it("never selects personal agent configuration, which is excluded", async () => {
    const result = await selected({
      "CLAUDE.local.md": "a\n",
      "pkg/CLAUDE.local.md": "a\n",
      ".claude/settings.local.json": "{}\n",
      ".claude/settings.json": "{}\n",
    });
    expect(pathsIn(result, 1)).toEqual([".claude/settings.json"]);
  });

  it("matches names exactly and `.claude/`, `.cursor/rules/` only at the root", async () => {
    const result = await selected({
      "pkg/claude.md": "a\n",
      "pkg/agents.md": "a\n",
      "pkg/.claude/x.md": "a\n",
      "pkg/.cursor/rules/x.mdc": "a\n",
      "pkg/.cursorrules": "a\n",
    });
    expect(pathsIn(result, 1)).toEqual([]);
  });

  it("includes the destination first and in full, and the rest by depth then path", async () => {
    const result = await selected({
      "CLAUDE.md": doc(500, "Guide"),
      "b/AGENTS.md": "a\n",
      "a/b/CLAUDE.md": "a\n",
      "AGENTS.md": "a\n",
      ".claude/x.md": "a\n",
    });
    expect(pathsIn(result, 1)).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      ".claude/x.md",
      "b/AGENTS.md",
      "a/b/CLAUDE.md",
    ]);
    const destination = itemOf(result, "CLAUDE.md");
    expect(destination).toMatchObject({ id: "T1-001", reason: "tier1:destination" });
    expect(destination?.rendered.excerpt).toBe(false);
  });

  it("stops when the destination is unavailable", async () => {
    const result = await select({ "CLAUDE.md": { kind: "symlink", target: "docs/x.md" } });
    expect(result).toEqual({
      state: "stopped",
      stop: { reason: "destination_unavailable", detail: "symlink" },
    });
  });

  it("stops when the destination's rendered item is larger than maxDestinationBytes", async () => {
    const content = doc(2_000);
    const full = renderItem(
      {
        id: "T1-001",
        path: "CLAUDE.md",
        hash: sha256(Buffer.from(content)),
        tier: 1,
        reason: "tier1:destination",
        content: Buffer.from(content),
        // The block list counts against the limit too.
        blocks: [
          { first: 1, last: 1, id: "Doc/heading" },
          { first: 3, last: 3, id: "Doc/paragraph-1" },
        ],
      },
      "none",
      Number.POSITIVE_INFINITY,
    );
    const renderedBytes = full?.bytes ?? 0;
    expect(
      await select({ "CLAUDE.md": content }, { maxDestinationBytes: renderedBytes }),
    ).toMatchObject({
      state: "selected",
    });
    expect(
      await select({ "CLAUDE.md": content }, { maxDestinationBytes: renderedBytes - 1 }),
    ).toEqual({
      state: "stopped",
      stop: {
        reason: "destination_too_large",
        renderedBytes,
        maxDestinationBytes: renderedBytes - 1,
      },
    });
  });

  it("includes a destination larger than the tier 1 cap, leaving nothing to pass down", async () => {
    const result = await selected(
      { "CLAUDE.md": doc(3_000), "AGENTS.md": "a\n" },
      { ...SMALL_CAPS, maxDestinationBytes: 10_000 },
    );
    expect(pathsIn(result, 1)).toEqual(["CLAUDE.md"]);
    expect(usage(result, 1)?.usedBytes).toBeGreaterThan(2_000);
    expect(usage(result, 2)?.budgetBytes).toBe(2_000);
  });

  it("never excerpts other agent configuration, and records one gap for what it skipped", async () => {
    const result = await selected(
      { "AGENTS.md": doc(1_500), ".claude/a.md": doc(1_500), ".claude/b.md": doc(1_500) },
      SMALL_CAPS,
    );
    expect(pathsIn(result, 1)).toEqual(["AGENTS.md"]);
    expect(result.items.every((item) => !item.rendered.excerpt)).toBe(true);
    expect(result.gaps).toEqual([
      {
        gapType: "other",
        statement: AGENT_CONFIG_SKIPPED,
        relatedPaths: [".claude/a.md", ".claude/b.md"],
      },
    ]);
    expect(AGENT_CONFIG_SKIPPED).toBe(
      "Some existing agent configuration was not read because of the analysis budget.",
    );
  });

  it("does not include agent configuration that is not a candidate", async () => {
    const result = await selected({ "AGENTS.md": new Uint8Array([0x61, 0, 0x62]) });
    expect(pathsIn(result, 1)).toEqual([]);
    expect(result.gaps).toEqual([]);
  });
});

describe("tier 1: @path imports", () => {
  it("follows imports relative to the importer, recursively, and adds them as imports", async () => {
    const result = await selected({
      "CLAUDE.md": "See @guides/style.md\n",
      "guides/style.md": "Also @more/naming.md\n",
      "guides/more/naming.md": "Names.\n",
    });
    expect(pathsIn(result, 1)).toEqual(["CLAUDE.md", "guides/style.md", "guides/more/naming.md"]);
    expect(itemOf(result, "guides/style.md")?.reason).toBe("tier1:import");
    expect(itemOf(result, "guides/more/naming.md")?.reason).toBe("tier1:import");
  });

  it("is safe through cycles and never adds a file twice", async () => {
    const result = await selected({
      "CLAUDE.md": "@notes/a.md @AGENTS.md @CLAUDE.md\n",
      "AGENTS.md": "@CLAUDE.md\n",
      "notes/a.md": "@b.md @a.md\n",
      "notes/b.md": "@a.md\n",
    });
    expect(pathsIn(result, 1)).toEqual(["CLAUDE.md", "AGENTS.md", "notes/a.md", "notes/b.md"]);
    expect(itemOf(result, "AGENTS.md")?.reason).toBe("tier1:agent-config");
  });

  it("ignores imports in code blocks and code spans", async () => {
    const result = await selected({
      "CLAUDE.md": "```\n@a.md\n```\n\n`@b.md`\n",
      "a.md": "a\n",
      "b.md": "b\n",
    });
    expect(pathsIn(result, 1)).toEqual(["CLAUDE.md"]);
  });

  it("scans only Markdown tier 1 files", async () => {
    const result = await selected({
      ".claude/settings.json": '{ "x": "@notes.md" }\n',
      ".cursorrules": "@notes.md\n",
      "notes.md": "a\n",
    });
    expect(pathsIn(result, 1)).toEqual([".cursorrules", ".claude/settings.json"]);
  });

  it("leaves an imported file in its own tier when a later tier matches it, still following its imports", async () => {
    const result = await selected({
      "CLAUDE.md": "@package.json and @README.md and @src/index.ts\n",
      "package.json": "{}\n",
      "README.md": "@notes/extra.md\n",
      "notes/extra.md": "a\n",
      "src/index.ts": "export const a = 1;\n",
    });
    expect(pathsIn(result, 1)).toEqual(["CLAUDE.md", "notes/extra.md"]);
    expect(pathsIn(result, 2)).toEqual(["README.md"]);
    expect(pathsIn(result, 3)).toEqual(["package.json"]);
    expect(pathsIn(result, 5)).toEqual(["src/index.ts"]);
  });

  it("does not read excluded, listed-only, symbolic-link or missing imports, and records no gap", async () => {
    const result = await selected({
      "CLAUDE.md": "@.env @big.md @link.md @missing.md @dir\n",
      ".env": "SECRET=1\n",
      "big.md": new Uint8Array([0x61, 0]),
      "link.md": { kind: "symlink", target: "x.md" },
      "dir/x.md": "a\n",
    });
    expect(pathsIn(result, 1)).toEqual(["CLAUDE.md"]);
    expect(result.gaps).toEqual([]);
  });

  it("cuts a long outside import in the gap statement", async () => {
    const result = await selected({ "CLAUDE.md": `@~/${"x".repeat(500)}\n` });
    expect(result.gaps[0]?.statement).toBe(
      `\`CLAUDE.md\` imports \`~/${"x".repeat(77)}…\`, which is outside the repository and was not read.`,
    );
  });

  it("records a gap for each import outside the repository, naming the importer and the import", async () => {
    const result = await selected({
      "CLAUDE.md": "@~/.claude/mine.md @/etc/x.md @../up.md @~/.claude/mine.md\n",
      "pkg/AGENTS.md": "@../../far.md\n",
    });
    expect(result.gaps).toEqual([
      {
        gapType: "other",
        statement:
          "`CLAUDE.md` imports `~/.claude/mine.md`, which is outside the repository and was not read.",
        relatedPaths: ["CLAUDE.md"],
      },
      {
        gapType: "other",
        statement:
          "`CLAUDE.md` imports `/etc/x.md`, which is outside the repository and was not read.",
        relatedPaths: ["CLAUDE.md"],
      },
      {
        gapType: "other",
        statement:
          "`CLAUDE.md` imports `../up.md`, which is outside the repository and was not read.",
        relatedPaths: ["CLAUDE.md"],
      },
      {
        gapType: "other",
        statement:
          "`pkg/AGENTS.md` imports `../../far.md`, which is outside the repository and was not read.",
        relatedPaths: ["pkg/AGENTS.md"],
      },
    ]);
  });
});

describe("tier 2: project documentation", () => {
  it("takes the ranked groups in order", async () => {
    const result = await selected({
      "docs/z.md": "# z\n",
      "docs/guide/a.md": "# a\n",
      "src/adr/0001.md": "# adr\n",
      "docs/decisions/0002.md": "# decision\n",
      "architecture/overview.md": "# overview\n",
      "README.md": "# readme\n",
      "CONTRIBUTING.md": "# contributing\n",
      "ARCHITECTURE.md": "# arch\n",
      "DEVELOPMENT.md": "# dev\n",
      "docs/notes.txt": "not markdown\n",
    });
    expect(result.items.filter((i) => i.tier === 2).map((i) => [i.path, i.reason])).toEqual([
      ["ARCHITECTURE.md", "tier2:group1:root-doc"],
      ["CONTRIBUTING.md", "tier2:group1:root-doc"],
      ["DEVELOPMENT.md", "tier2:group1:root-doc"],
      ["README.md", "tier2:group1:root-doc"],
      ["architecture/overview.md", "tier2:group2:decision-doc"],
      ["docs/decisions/0002.md", "tier2:group2:decision-doc"],
      ["src/adr/0001.md", "tier2:group2:decision-doc"],
      ["docs/guide/a.md", "tier2:group3:docs"],
      ["docs/z.md", "tier2:group3:docs"],
    ]);
  });

  it("matches names ASCII case-insensitively, any root README*, and Markdown extensions", async () => {
    const result = await selected({
      "readme.rst": "Readme\n",
      "Docs/a.markdown": "# a\n",
      "docs/b.MDX": "# b\n",
      "ADRs/c.Md": "# c\n",
    });
    expect(pathsIn(result, 2)).toEqual([
      "readme.rst",
      "ADRs/c.Md",
      "Docs/a.markdown",
      "docs/b.MDX",
    ]);
  });

  it("excludes changelogs, licences and generated API reference directories", async () => {
    const result = await selected({
      "README.md": "# r\n",
      "CHANGELOG.md": "# c\n",
      "docs/changes.md": "# c\n",
      "docs/HISTORY.md": "# h\n",
      "LICENSE.md": "# l\n",
      "docs/licence.md": "# l\n",
      "docs/COPYING.md": "# c\n",
      "docs/NOTICE.md": "# n\n",
      "docs/api-reference/x.md": "# x\n",
      "docs/api-docs/x.md": "# x\n",
      "docs/apidocs/x.md": "# x\n",
      "docs/typedoc/x.md": "# x\n",
      "docs/javadoc/x.md": "# x\n",
    });
    expect(pathsIn(result, 2)).toEqual(["README.md"]);
  });

  it("takes package READMEs round-robin across packages", async () => {
    const result = await selected({
      "package.json": '{"workspaces":["packages/*"]}\n',
      "packages/a/package.json": "{}\n",
      "packages/a/README.md": "# a\n",
      "packages/a/README.de.md": "# a de\n",
      "packages/b/package.json": "{}\n",
      "packages/b/README.md": "# b\n",
      "packages/b/src/README.md": "# not package level\n",
    });
    expect(result.items.filter((i) => i.tier === 2).map((i) => [i.path, i.reason])).toEqual([
      ["packages/a/README.de.md", "tier2:group4:package-readme"],
      ["packages/b/README.md", "tier2:group4:package-readme"],
      ["packages/a/README.md", "tier2:group4:package-readme"],
    ]);
  });

  it("excludes a package README under a generated API reference directory", async () => {
    const result = await selected({
      "package.json": '{"workspaces":["packages/*"]}\n',
      "packages/typedoc/package.json": "{}\n",
      "packages/typedoc/README.md": "# generated\n",
    });
    expect(pathsIn(result, 2)).toEqual([]);
  });

  it("excerpts by section to fit the per-file cap", async () => {
    const text = `# A\n\n${"a ".repeat(400)}\n\n# B\n\n${"b ".repeat(400)}\n`;
    const result = await selected(
      { "README.md": text },
      { perFileCaps: { tier2: 1_200, tier3: 8_000, tier5: 6_000 } },
    );
    const item = itemOf(result, "README.md");
    expect(item?.rendered.excerpt).toBe(true);
    expect(item?.rendered.outline.map((e) => [e.label, e.mark])).toEqual([
      ["# A", "included"],
      ["# B", "omitted"],
    ]);
  });

  it("records a file it cannot fit as skipped", async () => {
    const result = await selected(
      { "README.md": doc(100), "docs/a.md": doc(100) },
      { tierCaps: { tier1: 0, tier2: 100, tier3: 0, tier4: 0, tier5: 0 } },
    );
    expect(result.skipped).toContainEqual({
      path: "docs/a.md",
      tier: 2,
      reason: "tier2:cap-reached",
    });
  });
});

describe("tier 3: manifests and tooling configuration", () => {
  it("takes the groups in order, CI last; workspace, task runner and CI files at the root only", async () => {
    const result = await selected({
      "tsconfig.json": "{}\n",
      "apps/web/tsconfig.build.json": "{}\n",
      "apps/web/package.json": "{}\n",
      ".github/workflows/ci.yml": "on: push\n",
      ".github/workflows/release.yaml": "on: push\n",
      ".github/workflows/nested/x.yml": "on: push\n",
      ".gitlab-ci.yml": "a: 1\n",
      ".circleci/config.yml": "a: 1\n",
      Makefile: "all:\n",
      "apps/web/Makefile": "all:\n",
      justfile: "a:\n",
      "Taskfile.yml": "a: 1\n",
      Procfile: "web: x\n",
      "package.json": '{"workspaces":["apps/*"]}\n',
      "pnpm-workspace.yaml": "packages: []\n",
      "turbo.json": "{}\n",
      "nx.json": "{}\n",
      "lerna.json": "{}\n",
      "pyproject.toml": "[x]\n",
      "Cargo.toml": "[x]\n",
      "go.work": "go 1.22\n",
      "go.mod": "module x\n",
      "apps/go.mod": "module y\n",
      "Dockerfile.dev": "FROM x\n",
    });
    expect(result.items.filter((i) => i.tier === 3).map((i) => [i.path, i.reason])).toEqual([
      ["Cargo.toml", "tier3:group1:workspace"],
      ["go.mod", "tier3:group1:workspace"],
      ["go.work", "tier3:group1:workspace"],
      ["lerna.json", "tier3:group1:workspace"],
      ["nx.json", "tier3:group1:workspace"],
      ["package.json", "tier3:group1:workspace"],
      ["pnpm-workspace.yaml", "tier3:group1:workspace"],
      ["pyproject.toml", "tier3:group1:workspace"],
      ["turbo.json", "tier3:group1:workspace"],
      ["Makefile", "tier3:group2:task-runner"],
      ["Procfile", "tier3:group2:task-runner"],
      ["Taskfile.yml", "tier3:group2:task-runner"],
      ["justfile", "tier3:group2:task-runner"],
      ["apps/web/package.json", "tier3:group3:package-manifest"],
      ["Dockerfile.dev", "tier3:group4:tooling"],
      ["apps/web/tsconfig.build.json", "tier3:group4:tooling"],
      ["tsconfig.json", "tier3:group4:tooling"],
      [".circleci/config.yml", "tier3:group5:ci"],
      [".github/workflows/ci.yml", "tier3:group5:ci"],
      [".github/workflows/release.yaml", "tier3:group5:ci"],
      [".gitlab-ci.yml", "tier3:group5:ci"],
    ]);
  });

  it("fills tooling configuration before large CI workflows can use up the tier", async () => {
    const result = await selected(
      {
        ".github/workflows/a.yml": lines(1_500),
        ".github/workflows/b.yml": lines(1_500),
        "tsconfig.json": "{}\n",
        ".prettierrc": "{}\n",
      },
      {
        tierCaps: { tier1: 1_000, tier2: 1_000, tier3: 2_000, tier4: 1_000, tier5: 1_000 },
        initialContextBytes: 6_000,
      },
    );
    expect(pathsIn(result, 3).slice(0, 2)).toEqual([".prettierrc", "tsconfig.json"]);
  });

  it("matches the listed tooling configuration names at any depth", async () => {
    const names = [
      "tsconfig.base.json",
      "eslint.config.mjs",
      ".eslintrc.cjs",
      ".prettierrc",
      "prettier.config.js",
      "biome.json",
      "biome.jsonc",
      "ruff.toml",
      ".ruff.toml",
      "mypy.ini",
      ".mypy.ini",
      "pytest.ini",
      "vitest.config.ts",
      "vitest.workspace.ts",
      "jest.config.js",
      "playwright.config.ts",
      "docker-compose.yml",
      "docker-compose.test.yaml",
      "compose.yml",
      "compose.yaml",
      "Dockerfile",
      "dockerfile",
    ];
    const nodes = Object.fromEntries(names.map((name) => [`tools/${name}`, "a\n"]));
    const result = await selected(nodes);
    expect(pathsIn(result, 3).sort()).toEqual(names.map((name) => `tools/${name}`).sort());
    expect(pathsIn(result, 5)).toEqual([]);
  });

  it("matches root names ASCII case-insensitively", async () => {
    const result = await selected({ MAKEFILE: "all:\n", "Package.JSON": "{}\n" });
    expect(pathsIn(result, 3)).toEqual(["Package.JSON", "MAKEFILE"]);
  });

  it("takes package-level manifests round-robin across packages", async () => {
    const result = await selected({
      "package.json": '{"workspaces":["apps/*"]}\n',
      "apps/a/package.json": "{}\n",
      "apps/a/pyproject.toml": "[x]\n",
      "apps/b/package.json": "{}\n",
      "apps/b/Cargo.toml": "[x]\n",
    });
    expect(pathsIn(result, 3)).toEqual([
      "package.json",
      "apps/a/package.json",
      "apps/b/Cargo.toml",
      "apps/a/pyproject.toml",
      "apps/b/package.json",
    ]);
  });

  it("excerpts by whole lines from the start", async () => {
    const result = await selected(
      { "package.json": lines(3_000) },
      { perFileCaps: { tier2: 12_000, tier3: 1_000, tier5: 6_000 } },
    );
    const item = itemOf(result, "package.json");
    expect(item?.rendered.excerpt).toBe(true);
    expect(item?.rendered.included[0]?.first).toBe(1);
    expect(item?.rendered.outline.map((e) => e.label)[0]).toMatch(/^lines 1-/);
  });
});

describe("one tier per file", () => {
  it("leaves a file to the first tier that matches it", async () => {
    const result = await selected({
      "docs/CLAUDE.md": "# a\n",
      "eslint.config.js": "export default [];\n",
      "docs/guide.ts": "export const a = 1;\n",
    });
    expect(pathsIn(result, 1)).toEqual(["docs/CLAUDE.md"]);
    expect(pathsIn(result, 2)).toEqual([]);
    expect(pathsIn(result, 3)).toEqual(["eslint.config.js"]);
    expect(pathsIn(result, 5)).toEqual(["docs/guide.ts"]);
  });
});

describe("tier 5: packages", () => {
  it("uses workspace members from package.json, lerna.json and pnpm-workspace.yaml", async () => {
    const result = await selected({
      "package.json": '{"workspaces":["apps/*"]}\n',
      "lerna.json": '{"packages":["libs/x"]}\n',
      "pnpm-workspace.yaml": "packages:\n  - 'tools/*'\n  - '!tools/skip'\n",
      "apps/web/package.json": "{}\n",
      "apps/web/a.ts": "export const a = 1;\n",
      "libs/x/package.json": "{}\n",
      "libs/x/a.ts": "export const a = 1;\n",
      "tools/cli/package.json": "{}\n",
      "tools/cli/a.ts": "export const a = 1;\n",
      "tools/skip/package.json": "{}\n",
      "tools/skip/a.ts": "export const a = 1;\n",
    });
    expect(result.packages).toEqual(["apps/web", "libs/x", "tools/cli"]);
  });

  it("counts a matched directory as a member only when it has a package.json", async () => {
    const result = await selected({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n  - '!packages/b'\n",
      "packages/a/package.json": "{}\n",
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/a/src/components/x.ts": "export const a = 1;\n",
      "packages/a/src/README.md": "# not a package\n",
      "packages/b/package.json": "{}\n",
      "packages/assets/logo.ts": "export const a = 1;\n",
    });
    expect(result.packages).toEqual(["packages/a"]);
    expect(pathsIn(result, 2)).toEqual([]);
  });

  it("falls back to top-level directories that contain source files", async () => {
    const result = await selected({
      "api/src/main.py": "def main():\n    pass\n",
      "web/index.ts": "export const a = 1;\n",
      "docs/a.md": "# a\n",
      "main.go": "package main\n",
    });
    expect(result.packages).toEqual(["api", "web"]);
  });

  it("falls back to the root as the one package", async () => {
    const result = await selected({ "main.go": "package main\n" });
    expect(result.packages).toEqual([""]);
  });

  it("puts source files outside every package in a root package that comes first", async () => {
    const result = await selected({
      "package.json": '{"workspaces":["apps/*"]}\n',
      "apps/web/package.json": "{}\n",
      "apps/web/z.ts": "export const a = 1;\n",
      "scripts/build.ts": "export const a = 1;\n",
    });
    expect(pathsIn(result, 5)).toEqual(["scripts/build.ts", "apps/web/z.ts"]);
  });
});

describe("tier 5: test reserve", () => {
  const monorepo: Record<string, MemoryNode> = {
    "package.json": '{"workspaces":["packages/*"]}\n',
    "packages/a/package.json": "{}\n",
    "packages/b/package.json": "{}\n",
    "packages/c/package.json": "{}\n",
    "packages/a/src/index.ts": "export const a = 1;\n",
    "packages/a/src/z.test.ts": "export const t = 1;\n",
    "packages/a/src/b.spec.ts": "export const t = 1;\n",
    "packages/b/__tests__/x.ts": "export const t = 1;\n",
    "packages/b/src/main.ts": "export const b = 1;\n",
    "packages/c/src/lib.rs": "pub fn c() {}\n",
  };

  it("takes one test example per package, in package order, the first test file in path order", async () => {
    const result = await selected(monorepo);
    const tests = result.items.filter((i) => i.reason === "tier5:test-example").map((i) => i.path);
    expect(tests).toEqual(["packages/a/src/b.spec.ts", "packages/b/__tests__/x.ts"]);
    expect(usage(result, 5)?.testExamples).toBe(2);
    expect(
      result.items
        .filter((i) => i.tier === 5)
        .slice(0, 2)
        .map((i) => i.path),
    ).toEqual(tests);
  });

  it("recognises the listed test patterns, only in source files", async () => {
    const patterns = [
      "a/x.test.ts",
      "b/x.spec.js",
      "c/test_x.py",
      "d/x_test.py",
      "e/x_test.go",
      "f/tests/x.py",
      "g/test/x.rb",
      "h/__tests__/x.tsx",
    ];
    const nodes = Object.fromEntries(patterns.map((path) => [path, "x\n"]));
    nodes["i/test/data.json"] = "{}\n";
    nodes["i/main.ts"] = "export const a = 1;\n";
    const result = await selected(nodes);
    const tests = result.items.filter((i) => i.reason === "tier5:test-example").map((i) => i.path);
    expect(tests).toEqual(patterns);
  });

  it("caps each example at testExampleBytes and excerpts it by declaration", async () => {
    const result = await selected({ "src/a.test.ts": code(3_000) }, { testExampleBytes: 1_000 });
    const item = itemOf(result, "src/a.test.ts");
    expect(item?.reason).toBe("tier5:test-example");
    expect(item?.rendered.excerpt).toBe(true);
    expect(item?.rendered.bytes).toBeLessThanOrEqual(1_000);
    expect(item?.rendered.outline[0]?.label).toBe("imports");
  });

  it("still takes a later package's smaller example after the reserve runs short", async () => {
    const result = await selected(
      {
        "a/x.test.ts": code(3_000),
        "b/y.test.ts": "export const t = 1;\n",
        "a/package.json": "{}\n",
      },
      { testReserveBytes: 400, testExampleBytes: 3_000 },
    );
    const tests = result.items.filter((i) => i.reason === "tier5:test-example").map((i) => i.path);
    expect(tests).toEqual(["b/y.test.ts"]);
  });

  it("passes unused reserve to the main pool", async () => {
    const nodes: Record<string, MemoryNode> = {};
    for (let i = 0; i < 6; i++) nodes[`src/f${i}.ts`] = code(900);
    const settings: Partial<ContextSettings> = {
      tierCaps: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 3_000 },
      testReserveBytes: 2_000,
    };
    const result = await selected(nodes, settings);
    expect(usage(result, 5)?.usedBytes).toBeGreaterThan(1_000);
  });

  it("does not rank a chosen test example again, but ranks one the reserve could not fit", async () => {
    const chosen = await selected(monorepo);
    expect(chosen.items.filter((i) => i.path === "packages/a/src/b.spec.ts")).toHaveLength(1);

    const result = await selected(
      { "src/a.test.ts": "export const t = 1;\n" },
      { testReserveBytes: 10 },
    );
    expect(result.items.map((i) => [i.path, i.reason])).toEqual([
      ["src/a.test.ts", "tier5:rank3:other"],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("records a test example that fit nowhere as skipped", async () => {
    const result = await selected(
      { "src/a.test.ts": code(4_000) },
      { tierCaps: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 100 }, testReserveBytes: 100 },
    );
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([
      { path: "src/a.test.ts", tier: 5, reason: "tier5:cap-reached" },
    ]);
  });
});

describe("tier 5: ranking and round-robin", () => {
  it("ranks entry points, then boundary names, then the rest, by depth then path", async () => {
    const result = await selected({
      "src/zeta.ts": "export const a = 1;\n",
      "src/deep/index.ts": "export const a = 1;\n",
      "src/main.ts": "export const a = 1;\n",
      "src/api.ts": "export const a = 1;\n",
      "src/a/Client.TS": "export const a = 1;\n",
      "src/index.d.ts": "export const a = 1;\n",
      "src/__main__.py": "def a():\n    pass\n",
      "src/alpha.ts": "export const a = 1;\n",
    });
    expect(result.items.map((i) => [i.path, i.reason])).toEqual([
      ["src/__main__.py", "tier5:rank1:entry-point"],
      ["src/main.ts", "tier5:rank1:entry-point"],
      ["src/deep/index.ts", "tier5:rank1:entry-point"],
      ["src/api.ts", "tier5:rank2:boundary-name"],
      ["src/a/Client.TS", "tier5:rank2:boundary-name"],
      ["src/alpha.ts", "tier5:rank3:other"],
      ["src/zeta.ts", "tier5:rank3:other"],
      ["src/index.d.ts", "tier5:rank4:supporting"],
    ]);
  });

  it("samples templates as source, excerpted by whole lines", async () => {
    const result = await selected(
      { "server/views/home.hbs": "<p>{{title}}</p>\n".repeat(400) },
      { perFileCaps: { tier2: 12_000, tier3: 8_000, tier5: 1_000 } },
    );
    const item = itemOf(result, "server/views/home.hbs");
    expect(item?.reason).toBe("tier5:rank3:other");
    expect(item?.rendered.outline[0]?.label).toMatch(/^lines 1-/);
  });

  it("ranks tests, examples, fixtures and .d.ts files after every other source file", async () => {
    const result = await selected(
      {
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const a = 1;\n",
        "src/types.d.ts": "export const a = 1;\n",
        "src/__tests__/helper.ts": "export const a = 1;\n",
        "src/Fixtures/data.ts": "export const a = 1;\n",
        "examples/demo.ts": "export const a = 1;\n",
        "test/helper.ts": "export const a = 1;\n",
        "tests/util.py": "def a():\n    pass\n",
        "lib/index.ts": "export const a = 1;\n",
      },
      { testReserveBytes: 0 },
    );
    // Packages are the top-level directories. Every package's ordinary files come first, then
    // the supporting files, each pass round-robin in package order.
    expect(result.items.map((i) => [i.path, i.reason])).toEqual([
      ["lib/index.ts", "tier5:rank1:entry-point"],
      ["src/a.ts", "tier5:rank3:other"],
      ["src/b.ts", "tier5:rank3:other"],
      ["examples/demo.ts", "tier5:rank4:supporting"],
      ["src/types.d.ts", "tier5:rank4:supporting"],
      ["test/helper.ts", "tier5:rank4:supporting"],
      ["tests/util.py", "tier5:rank4:supporting"],
      ["src/Fixtures/data.ts", "tier5:rank4:supporting"],
      ["src/__tests__/helper.ts", "tier5:rank4:supporting"],
    ]);
  });

  it("takes each package's next file in turn, in package order", async () => {
    const result = await selected({
      "package.json": '{"workspaces":["p/*"]}\n',
      "p/a/package.json": "{}\n",
      "p/b/package.json": "{}\n",
      "p/a/index.ts": "export const a = 1;\n",
      "p/a/other.ts": "export const a = 1;\n",
      "p/a/more.ts": "export const a = 1;\n",
      "p/b/main.ts": "export const a = 1;\n",
    });
    expect(pathsIn(result, 5)).toEqual([
      "p/a/index.ts",
      "p/b/main.ts",
      "p/a/more.ts",
      "p/a/other.ts",
    ]);
  });

  it("skips a file that cannot fit and still includes a later one that can", async () => {
    // The files share one package, so the order is rank then path: a, b, c.
    const result = await selected(
      { "src/a.zig": "a\n", "src/b.zig": `${"b".repeat(2_000)}\n`, "src/c.zig": "c\n" },
      {
        tierCaps: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 600 },
        sourceExtensions: [".zig"],
        testReserveBytes: 0,
      },
    );
    // b.zig is one line longer than the whole budget, so not even one line fits.
    expect(pathsIn(result, 5)).toEqual(["src/a.zig", "src/c.zig"]);
    expect(result.skipped).toEqual([{ path: "src/b.zig", tier: 5, reason: "tier5:cap-reached" }]);
  });

  it("stops at maxSourceFiles, not counting test examples", async () => {
    const nodes: Record<string, MemoryNode> = { "src/a.test.ts": "export const t = 1;\n" };
    for (let i = 0; i < 5; i++) nodes[`src/f${i}.ts`] = "export const a = 1;\n";
    const result = await selected(nodes, { maxSourceFiles: 3 });
    expect(pathsIn(result, 5)).toEqual(["src/a.test.ts", "src/f0.ts", "src/f1.ts", "src/f2.ts"]);
    expect(usage(result, 5)?.items).toBe(4);
  });

  it("doesn't count an outline-only item against maxSourceFiles", async () => {
    const big = `import { x } from "./x";\nexport function f0() {\n${"  x();\n".repeat(300)}}\n`;
    const nodes: Record<string, MemoryNode> = { "src/f0.ts": big };
    for (let i = 1; i < 5; i++) nodes[`src/f${i}.ts`] = "export const a = 1;\n";
    const result = await selected(nodes, {
      maxSourceFiles: 3,
      perFileCaps: { tier2: 12_000, tier3: 8_000, tier5: 1_000 },
    });
    expect(itemOf(result, "src/f0.ts")?.rendered.included).toEqual([]);
    expect(pathsIn(result, 5)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts"]);
  });

  it("excerpts a source file by declaration to fit the per-file cap", async () => {
    const result = await selected(
      { "src/index.ts": code(3_000) },
      { perFileCaps: { tier2: 12_000, tier3: 8_000, tier5: 1_000 } },
    );
    const item = itemOf(result, "src/index.ts");
    expect(item?.rendered.excerpt).toBe(true);
    expect(item?.rendered.bytes).toBeLessThanOrEqual(1_000);
  });

  it("uses the configured source extensions", async () => {
    const result = await selected(
      { "src/a.ts": "a\n", "src/b.zig": "b\n" },
      { sourceExtensions: [".zig"] },
    );
    expect(pathsIn(result, 5)).toEqual(["src/b.zig"]);
  });
});

describe("determinism (IMPL §1.15)", () => {
  it("selects the same items under different filesystem enumeration orders", async () => {
    const nodes: Record<string, MemoryNode> = {
      "CLAUDE.md": "@notes/a.md\n",
      "notes/a.md": "# a\n",
      "AGENTS.md": "a\n",
      "README.md": doc(400),
      "docs/x.md": doc(400),
      "package.json": '{"workspaces":["packages/*"]}\n',
      "packages/a/package.json": "{}\n",
      "packages/a/src/index.ts": code(800),
      "packages/a/src/z.test.ts": code(800),
      "packages/b/src/main.py": "def main():\n    pass\n",
      "packages/b/tests/test_main.py": "def test():\n    pass\n",
    };
    const settings: Partial<ContextSettings> = SMALL_CAPS;
    const baseline = await select(nodes, settings);
    for (const seed of [1, 2, 3]) {
      expect(await select(nodes, settings, seededShuffle(seed))).toEqual(baseline);
    }
    expect(await select(nodes, settings, (names) => [...names].reverse())).toEqual(baseline);
  });
});
