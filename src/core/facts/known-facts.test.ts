import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
  seededShuffle,
} from "../../../test/support/memory-fs.js";
import { DEFAULT_CONTEXT_SETTINGS, selectTiers } from "../context/tiers.js";
import { sha256 } from "../hash.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { extractKnownFacts, type KnownFactsResult, MANIFEST_UNREADABLE } from "./known-facts.js";

// Known facts (IMPL §3.2.5).

const join = (...fragments: string[]): string => fragments.join("");
const awsKey = join("AKIA", "IOSFODNN7EXAMPLE");

async function extract(
  nodes: Record<string, MemoryNode>,
  order?: (names: string[]) => string[],
): Promise<KnownFactsResult> {
  const fs = new MemoryFs(nodes, order === undefined ? {} : { order });
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    DEFAULT_SNAPSHOT_SETTINGS,
  );
  const selection = await selectTiers(snapshot, DEFAULT_CONTEXT_SETTINGS, fs);
  if (selection.state !== "selected") throw new Error(selection.state);
  return extractKnownFacts(snapshot, selection, fs);
}

async function extracted(nodes: Record<string, MemoryNode>) {
  const result = await extract(nodes);
  if (result.state !== "extracted") throw new Error(result.state);
  return result;
}

const statements = (result: { facts: readonly { statement: string }[] }) =>
  result.facts.map((fact) => fact.statement);

const REPOSITORY: Record<string, MemoryNode> = {
  "CLAUDE.md": "# Rules\n\nSee @notes/team.txt and @package.json\n",
  "notes/team.txt": "Team notes.\n",
  ".claude/settings.json": "{}\n",
  "packages/b/AGENTS.md": "b\n",
  "package.json": [
    "{",
    '  "workspaces": ["packages/a"],',
    '  "scripts": {',
    '    "build": "tsc -b",',
    '    "test": "vitest run"',
    "  }",
    "}",
    "",
  ].join("\n"),
  "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
  "packages/a/package.json": '{ "scripts": { "dev": "vite" } }\n',
  "packages/b/package.json": "{}\n",
  "packages/b/pyproject.toml": '[project.scripts]\nserve = "b:main"\n',
  "tools/package.json": '{ "scripts": { "ignored": "x" } }\n',
  Makefile: "lint:\n\tbiome ci .\nlint: more\n",
  justfile: "fmt:\n  biome format\n",
  "Taskfile.yml": "tasks:\n  ci:\n    cmds: [x]\n",
  "pyproject.toml": '[tool.poetry.scripts]\napp = "app:run"\n',
};

describe("extractKnownFacts", () => {
  it("records agent configuration, workspace packages and commands, in the spec's order", async () => {
    const result = await extracted(REPOSITORY);
    expect(statements(result)).toEqual([
      "`CLAUDE.md` is existing agent configuration.",
      "`.claude/settings.json` is existing agent configuration.",
      "`notes/team.txt` is imported by `CLAUDE.md`.",
      "`packages/b/AGENTS.md` is existing agent configuration.",
      "`Makefile` defines the target `lint`.",
      "`Taskfile.yml` defines the task `ci`.",
      "`justfile` defines the recipe `fmt`.",
      "`package.json` defines the script `build`.",
      "`package.json` defines the script `test`.",
      "`pyproject.toml` defines the script `app`.",
      "`packages/a` is a workspace package declared in `package.json`.",
      "`packages/a/package.json` defines the script `dev`.",
      "`packages/b` is a workspace package declared in `pnpm-workspace.yaml`.",
      "`packages/b/pyproject.toml` defines the script `serve`.",
    ]);
    expect(result.gaps).toEqual([]);
  });

  it("marks every fact as a deterministic, descriptive claim with code-made evidence", async () => {
    const result = await extracted(REPOSITORY);
    for (const fact of result.facts) {
      expect(fact).toMatchObject({
        kind: "claim",
        mode: "descriptive",
        producedBy: "deterministic",
      });
      expect(fact.evidence.length).toBeGreaterThan(0);
    }
    const byStatement = (s: string) => result.facts.find((fact) => fact.statement === s);

    // Entry evidence only observes the file list, so it is code_observation whatever the tier
    // (IMPL §3.2.4).
    expect(byStatement("`CLAUDE.md` is existing agent configuration.")).toMatchObject({
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidence: [
        {
          kind: "entry",
          path: "CLAUDE.md",
          fileHash: sha256(new TextEncoder().encode(REPOSITORY["CLAUDE.md"] as string)),
          basis: "code_observation",
        },
      ],
      fact: { type: "agent_configuration", path: "CLAUDE.md" },
    });
    expect(byStatement("`notes/team.txt` is imported by `CLAUDE.md`.")).toMatchObject({
      basis: ["code_observation"],
      fact: { type: "agent_configuration", path: "notes/team.txt", importedBy: "CLAUDE.md" },
    });
    expect(
      byStatement("`packages/b` is a workspace package declared in `pnpm-workspace.yaml`."),
    ).toMatchObject({
      scope: { kind: "paths", paths: ["packages/b"] },
      basis: ["code_observation"],
      evidence: [
        { kind: "entry", path: "pnpm-workspace.yaml", basis: "code_observation" },
        { kind: "entry", path: "packages/b/package.json", basis: "code_observation" },
      ],
      fact: { type: "workspace_package", path: "packages/b", declaredIn: "pnpm-workspace.yaml" },
    });
    expect(byStatement("`package.json` defines the script `test`.")).toEqual({
      kind: "claim",
      mode: "descriptive",
      producedBy: "deterministic",
      statement: "`package.json` defines the script `test`.",
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidence: [
        {
          kind: "lines",
          path: "package.json",
          fileHash: sha256(new TextEncoder().encode(REPOSITORY["package.json"] as string)),
          lineStart: 5,
          lineEnd: 5,
          excerpt: '    "test": "vitest run"',
          basis: "code_observation",
        },
      ],
      fact: {
        type: "command",
        file: "package.json",
        kind: "script",
        name: "test",
        status: "found_not_run",
      },
    });
    expect(byStatement("`packages/a/package.json` defines the script `dev`.")).toMatchObject({
      scope: { kind: "paths", paths: ["packages/a"] },
    });
  });

  it("gives one fact per name per file, at its first definition", async () => {
    const result = await extracted({ Makefile: "a b:\nb:\na:\n" });
    expect(result.facts.map((fact) => fact.evidence[0])).toMatchObject([
      { lineStart: 1, excerpt: "a b:" },
      { lineStart: 1, excerpt: "a b:" },
    ]);
    expect(statements(result)).toEqual([
      "`Makefile` defines the target `a`.",
      "`Makefile` defines the target `b`.",
    ]);
  });

  it("reads package-level manifests only in declared workspace members", async () => {
    const result = await extracted({
      "apps/web/package.json": '{ "scripts": { "dev": "vite" } }\n',
      "apps/web/index.ts": "export const a = 1;\n",
      "apps/web/pyproject.toml": '[project.scripts]\nx = "y"\n',
    });
    expect(result.facts).toEqual([]);
  });

  it("gives a gap for a manifest that is listed only, not UTF-8 or not valid JSON", async () => {
    const result = await extracted({
      "package.json": '{ "scripts": { "a": "x", } }\n',
      Makefile: new Uint8Array([0x61, 0x3a, 0x0a, 0]),
      justfile: new Uint8Array([0x61, 0x3a, 0x0a, 0xff, 0x0a]),
    });
    expect(result.facts).toEqual([]);
    expect(result.gaps).toEqual([
      { gapType: "other", statement: MANIFEST_UNREADABLE("Makefile"), relatedPaths: ["Makefile"] },
      { gapType: "other", statement: MANIFEST_UNREADABLE("justfile"), relatedPaths: ["justfile"] },
      {
        gapType: "other",
        statement: MANIFEST_UNREADABLE("package.json"),
        relatedPaths: ["package.json"],
      },
    ]);
    expect(MANIFEST_UNREADABLE("package.json")).toBe(
      "`package.json` could not be read or parsed, so its commands are not known facts.",
    );
  });

  it("gives no fact for a name holding a backtick or a control character", async () => {
    const result = await extracted({
      "package.json": '{ "scripts": { "a`b": "x", "c\\u0007": "x", "ok": "x" } }\n',
    });
    expect(statements(result)).toEqual(["`package.json` defines the script `ok`."]);
  });

  it("gives no fact for an empty name, or one with whitespace at either end", async () => {
    const result = await extracted({
      "package.json": '{ "scripts": { "": "x", " b": "x", "c ": "x", "d e": "x" } }\n',
      "pyproject.toml": '[project.scripts]\n"" = "y"\n',
    });
    expect(statements(result)).toEqual(["`package.json` defines the script `d e`."]);
  });

  it("gives no fact for a path that can't be inline code", async () => {
    const result = await extracted({ ".claude/a`b.md": "a\n", "CLAUDE.md": "@notes/x`y.txt\n" });
    expect(statements(result)).toEqual(["`CLAUDE.md` is existing agent configuration."]);
  });

  it("names the first importer in resolution order: the destination first, breadth-first", async () => {
    const result = await extracted({
      "CLAUDE.md": "@notes/deep.md @shared.txt\n",
      ".claude/a.md": "@../shared.txt @../late.txt\n",
      "notes/deep.md": "@../late.txt\n",
      "shared.txt": "s\n",
      "late.txt": "l\n",
    });
    expect(statements(result)).toContain("`shared.txt` is imported by `CLAUDE.md`.");
    expect(statements(result)).toContain("`late.txt` is imported by `.claude/a.md`.");
  });

  it("withholds a fact whose excerpt or statement matches the secret scan, with one gap per file", async () => {
    const result = await extracted({
      "package.json": [
        "{",
        '  "scripts": {',
        `    "deploy": "AWS_ACCESS_KEY_ID=${awsKey} deploy",`,
        `    "${awsKey}": "x",`,
        '    "build": "tsc"',
        "  }",
        "}",
      ].join("\n"),
    });
    expect(statements(result)).toEqual(["`package.json` defines the script `build`."]);
    expect(result.gaps).toEqual([
      {
        gapType: "other",
        statement:
          "A known fact from `package.json` was withheld because it matched the secret scan.",
        relatedPaths: ["package.json"],
      },
    ]);
  });

  it("gives no fact and no gap for an entry whose path the secret scan withholds", async () => {
    const result = await extracted({ [`.claude/${awsKey}.md`]: "a\n" });
    expect(result).toEqual({ state: "extracted", facts: [], gaps: [] });
  });

  it("reports the snapshot as unstable when a manifest changed after capture", async () => {
    const result = await extract({
      Makefile: {
        kind: "file",
        // Capture observes the file twice and selection reads it once; extraction reads it last.
        content: (count) => Buffer.from(count <= 3 ? "a:\n" : "b:\n"),
      },
    });
    expect(result).toEqual({ state: "unstable", changedPaths: ["Makefile"] });
  });

  it("reports the snapshot as unstable when a workspace definition changed after capture", async () => {
    const result = await extract({
      "pnpm-workspace.yaml": {
        kind: "file",
        content: (count) => Buffer.from(count <= 3 ? "packages:\n  - a\n" : "packages: []\n"),
      },
      "a/package.json": "{}\n",
    });
    expect(result).toEqual({ state: "unstable", changedPaths: ["pnpm-workspace.yaml"] });
  });

  it("does not depend on filesystem enumeration order", async () => {
    const ordered = await extract(REPOSITORY);
    const shuffled = await extract(REPOSITORY, seededShuffle(11));
    expect(shuffled).toEqual(ordered);
  });
});
