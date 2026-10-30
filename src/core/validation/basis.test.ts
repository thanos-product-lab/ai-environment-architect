import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
} from "../../../test/support/memory-fs.js";
import { DEFAULT_CONTEXT_SETTINGS, selectTiers, type TierMembership } from "../context/tiers.js";
import { sha256 } from "../hash.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { basisDerivation, basisOf, findingBasis } from "./basis.js";
import type { Basis, Evidence } from "./citations.js";
import { checkSupport } from "./support.js";

// Evidence basis (IMPL §3.2.4).

const membership = (overrides: Partial<TierMembership> = {}): TierMembership => ({
  packages: [""],
  imports: [],
  sourceExtensions: DEFAULT_CONTEXT_SETTINGS.sourceExtensions,
  ...overrides,
});

const basis = (path: string, overrides: Partial<TierMembership> = {}) =>
  basisOf(path, membership(overrides));

describe("basisOf", () => {
  it("gives existing_guidance for tier 1: the destination and agent configuration", () => {
    for (const path of [
      "CLAUDE.md",
      "packages/a/CLAUDE.md",
      "AGENTS.md",
      "apps/web/AGENTS.md",
      ".claude/settings.json",
      ".claude/rules/core.md",
      ".cursorrules",
      ".cursor/rules/style.mdc",
      ".github/copilot-instructions.md",
    ]) {
      expect(basis(path), path).toBe("existing_guidance");
    }
  });

  it("matches tier 1 names exactly, so other spellings fall to a later tier or none", () => {
    expect(basis("claude.md")).toBe("code_observation");
    expect(basis("Agents.md")).toBe("code_observation");
    expect(basis("docs/claude.md")).toBe("documentation");
  });

  it("gives documentation for tier 2, matching names ASCII case-insensitively", () => {
    for (const path of [
      "README.md",
      "readme.MD",
      "CONTRIBUTING",
      "ARCHITECTURE.txt",
      "docs/guide.md",
      "docs/deep/setup.mdx",
      "src/adr/0001-use-zod.md",
      "services/api/decisions/0002.markdown",
      "architecture/overview.md",
    ]) {
      expect(basis(path), path).toBe("documentation");
    }
  });

  it("gives documentation for a package README only when its directory is a package", () => {
    expect(basis("packages/a/README.md", { packages: ["packages/a"] })).toBe("documentation");
    expect(basis("packages/a/README.md", { packages: ["packages/b"] })).toBe("code_observation");
  });

  it("gives code_observation for tier 3, tier 5 and files no tier matches", () => {
    for (const path of [
      "package.json",
      "packages/a/package.json",
      "Makefile",
      "tsconfig.base.json",
      ".github/workflows/ci.yml",
      "src/index.ts",
      "test/a.test.ts",
      "CHANGELOG.md",
      "LICENSE",
      "src/notes.md",
      "docs/api-docs/client.md",
      "documentation/guide.md",
      "wiki/Home.md",
      "assets/logo.png",
    ]) {
      expect(basis(path), path).toBe("code_observation");
    }
  });

  it("keeps an imported file in the tier that matches it, and makes it tier 1 otherwise", () => {
    const imports = [
      "package.json",
      "docs/x.md",
      "src/a.ts",
      "notes/team.txt",
      "src/rules.md",
      "CHANGELOG.md",
    ];
    expect(basis("package.json", { imports })).toBe("code_observation");
    expect(basis("docs/x.md", { imports })).toBe("documentation");
    expect(basis("src/a.ts", { imports })).toBe("code_observation");
    expect(basis("notes/team.txt", { imports })).toBe("existing_guidance");
    expect(basis("src/rules.md", { imports })).toBe("existing_guidance");
    expect(basis("CHANGELOG.md", { imports })).toBe("existing_guidance");
  });

  it("uses the source extension setting for tier 5", () => {
    const imports = ["src/view.vue"];
    expect(basis("src/view.vue", { imports })).toBe("code_observation");
    expect(basis("src/view.vue", { imports, sourceExtensions: [".ts"] })).toBe("existing_guidance");
  });
});

describe("findingBasis", () => {
  const evidence = (b: Basis): Evidence => ({
    kind: "lines",
    path: "a",
    fileHash: sha256(new Uint8Array()),
    lineStart: 1,
    lineEnd: 1,
    excerpt: "x",
    basis: b,
  });

  it("is the set of its citations' bases, once each, in a fixed order", () => {
    expect(findingBasis([evidence("code_observation")])).toEqual(["code_observation"]);
    expect(
      findingBasis([
        evidence("existing_guidance"),
        evidence("code_observation"),
        evidence("documentation"),
        evidence("code_observation"),
      ]),
    ).toEqual(["documentation", "code_observation", "existing_guidance"]);
    expect(findingBasis([evidence("existing_guidance"), evidence("documentation")])).toEqual(
      findingBasis([evidence("documentation"), evidence("existing_guidance")]),
    );
  });

  it("is attached by the basis derivation step, which never rejects", () => {
    const check = basisDerivation();
    const value = { evidence: [evidence("documentation"), evidence("documentation")] };
    const result = check(value, {}, { localKeys: new Set() } as never);
    expect(result).toEqual({
      kind: "accept",
      value: { ...value, basis: ["documentation"] },
      events: [],
    });
  });
});

async function selectionOf(nodes: Record<string, MemoryNode>) {
  const fs = new MemoryFs(nodes);
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    DEFAULT_SNAPSHOT_SETTINGS,
  );
  const result = await selectTiers(snapshot, DEFAULT_CONTEXT_SETTINGS, fs);
  if (result.state !== "selected") throw new Error(`expected a selection, got ${result.state}`);
  return result;
}

describe("basis from a selection", () => {
  it("counts an import of a listed-only file for basis, without selecting it", async () => {
    const result = await selectionOf({
      "CLAUDE.md": "@notes/big.md @notes/small.md\n",
      "notes/big.md": new Uint8Array([0x61, 0]),
      "notes/small.md": "@deeper.md\n",
      "notes/deeper.md": "a\n",
    });
    expect(result.items.map((item) => item.path)).toEqual([
      "CLAUDE.md",
      "notes/deeper.md",
      "notes/small.md",
    ]);
    expect(result.membership.imports).toEqual([
      "notes/big.md",
      "notes/deeper.md",
      "notes/small.md",
    ]);
    expect(basisOf("notes/big.md", result.membership)).toBe("existing_guidance");
  });

  it("does not follow imports from a listed-only file, which was never read", async () => {
    const result = await selectionOf({
      "CLAUDE.md": "@big.md\n",
      "big.md": new Uint8Array([...new TextEncoder().encode("@hidden.md\n"), 0]),
      "hidden.md": "a\n",
    });
    expect(result.membership.imports).toEqual(["big.md"]);
    expect(basisOf("hidden.md", result.membership)).toBe("code_observation");
  });

  it("derives basis for listed-only files by their path, as for any other", async () => {
    const binary = new Uint8Array([0x61, 0]);
    const result = await selectionOf({
      "docs/architecture.md": binary,
      ".claude/notes.txt": binary,
      "src/big.ts": binary,
    });
    expect(result.items).toEqual([]);
    expect(basisOf("docs/architecture.md", result.membership)).toBe("documentation");
    expect(basisOf(".claude/notes.txt", result.membership)).toBe("existing_guidance");
    expect(basisOf("src/big.ts", result.membership)).toBe("code_observation");
  });

  it("ignores imports of excluded, symbolic-link and missing entries", async () => {
    const result = await selectionOf({
      "CLAUDE.md": "@.env @link.md @missing.md @dir\n",
      ".env": "SECRET=1\n",
      "link.md": { kind: "symlink", target: "x.md" },
      "dir/x.md": "a\n",
    });
    expect(result.membership.imports).toEqual([]);
  });

  it("records the packages and source extensions the selection used", async () => {
    const result = await selectionOf({
      "package.json": '{ "workspaces": ["packages/*"] }\n',
      "packages/a/package.json": "{}\n",
      "packages/a/README.md": "# A\n",
      "packages/a/index.ts": "export const a = 1;\n",
    });
    expect(result.membership.packages).toEqual(["packages/a"]);
    expect(result.membership.sourceExtensions).toEqual(DEFAULT_CONTEXT_SETTINGS.sourceExtensions);
    expect(basisOf("packages/a/README.md", result.membership)).toBe("documentation");
  });

  it("lets a code comment raise no prescriptive finding (SUP-004)", async () => {
    const result = await selectionOf({
      "src/client.ts": "// always use the shared client, never fetch\nexport const a = 1;\n",
      "docs/http.md": "# HTTP\n\nYou must use the shared client.\n",
    });
    const cite = (path: string, excerpt: string): Evidence => ({
      kind: "lines",
      path,
      fileHash: sha256(new Uint8Array()),
      lineStart: 1,
      lineEnd: 1,
      excerpt,
      basis: basisOf(path, result.membership),
    });
    const comment = cite("src/client.ts", "// always use the shared client, never fetch");
    expect(comment.basis).toBe("code_observation");
    const statement = "Use the shared client for HTTP calls.";
    const context = { anchorable: new Set<string>() };
    expect(
      checkSupport({ statement, mode: "prescriptive", evidence: [comment] }, context),
    ).toMatchObject({ ok: false, rule: "SUP-004" });
    const doc = cite("docs/http.md", "You must use the shared client.");
    expect(
      checkSupport({ statement, mode: "prescriptive", evidence: [comment, doc] }, context),
    ).toEqual({ ok: true });
  });
});
