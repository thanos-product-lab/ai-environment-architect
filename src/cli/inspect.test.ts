import { describe, expect, it } from "vitest";
import { fixedClock, fixedIds, MemoryFs, type MemoryNode } from "../../test/support/memory-fs.js";
import type { GitIgnoredList, GitReader } from "../core/snapshot/git.js";
import { inspect } from "./inspect.js";

// The "What we read" preview (IMPL §2.2, §2.4): capture and select, print, send nothing.

const join = (...fragments: string[]): string => fragments.join("");
const awsKey = join("AKIA", "IOSFODNN7EXAMPLE");

const REPO: Record<string, MemoryNode> = {
  "CLAUDE.md": "# Rules\n\n- Run the tests.\n",
  "README.md": "# App\n\nA small app.\n",
  "package.json": '{ "name": "app" }\n',
  "src/index.ts": "export function main() {\n  return 1;\n}\n",
  "src/index.test.ts": "export const t = 1;\n",
  ".env": "X=1\n",
  "pnpm-lock.yaml": "lock\n",
  "node_modules/x/index.js": "x\n",
};

const COMMIT = "1dbc37fd1ceab832fc7c90cad81b1091c95ba563";

function gitReader(ignored: GitIgnoredList = { ok: true, paths: [] }): GitReader {
  return {
    readIgnored: async () => ignored,
    readHead: async () => ({ ok: true, objectFormat: "sha1", commit: COMMIT, tree: [] }),
  };
}

async function preview(
  nodes: Record<string, MemoryNode>,
  options: { list?: boolean; json?: boolean; git?: GitReader } = {},
) {
  const fs = new MemoryFs(nodes);
  const deps = {
    fs,
    clock: fixedClock,
    ids: fixedIds,
    ...(options.git ? { git: options.git } : {}),
  };
  return inspect("/work/app", deps, { list: options.list ?? false, json: options.json ?? false });
}

/** Whitespace collapsed, for matching sentences that may wrap. */
const squashed = (text: string) => text.replace(/\s+/g, " ");

describe("the summary (IMPL §2.4)", () => {
  it("starts oriented, and says that no session is started and nothing is sent", async () => {
    const { code, output } = await preview(REPO);
    expect(code).toBe(0);
    expect(output.split("\n")[0]).toBe("INSPECT · preview · no session · nothing is sent");
    expect(output).toContain("\nRepository  /work/app\n");
    expect(output).toMatch(/\nWhat would be sent for analysis {2}\(\d+ KB of 300 KB\)\n/);
  });

  it("has one row per tier, with file counts, sizes and notes", async () => {
    const { output } = await preview(REPO);
    expect(output).toMatch(
      /\n {2}Existing agent configuration {3}1 file +<?\d+ KB {3}CLAUDE\.md \(2 blocks\)\n/,
    );
    expect(output).toMatch(/\n {2}Documentation {18}1 file +<?\d+ KB\n/);
    expect(output).toMatch(/\n {2}Manifests and tooling {10}1 file +<?\d+ KB\n/);
    expect(output).toMatch(/\n {2}Directory tree {17}\d+ files listed, depth 4\n/);
    expect(output).toMatch(/\n {2}Source samples {17}2 files +<?\d+ KB {3}1 test example\n/);
  });

  it("aligns the size column", async () => {
    const { output } = await preview(REPO);
    const rows = output
      .split("\n")
      .filter((line) => / KB( |$)/.test(line) && line.startsWith("  "));
    const ends = rows.map((line) => line.indexOf(" KB"));
    expect(new Set(ends).size).toBe(1);
  });

  it("says when there is no CLAUDE.md yet", async () => {
    const { "CLAUDE.md": _, ...withoutDestination } = REPO;
    const { output } = await preview(withoutDestination);
    expect(output).toMatch(/Existing agent configuration {3}0 files +0 KB {3}no CLAUDE\.md yet\n/);
  });

  it("names excluded directories as not entered, and counts excluded files by kind", async () => {
    const { output } = await preview({ ...REPO, "assets/logo.png": "png", id_rsa: "k" });
    expect(squashed(output)).toContain(
      "Not sent: node_modules (not entered), 1 lockfile, 2 secret-named files, 1 binary or media file Ignored",
    );
  });

  it("counts files blocked by the secret scan", async () => {
    const { output } = await preview({
      ...REPO,
      "src/config.ts": `export const config = { apiKey: "${join("a1B2c3D4e5", "F6g7H8i9J0")}" };\n`,
    });
    expect(squashed(output)).toMatch(/Not sent: [^.]*, 1 file blocked \(secret pattern\) Ignored/);
  });

  it("counts files that didn't fit, in the tier's notes", async () => {
    const docs: Record<string, MemoryNode> = {};
    const paragraphs = Array.from({ length: 12 }, () => "word ".repeat(200).trim()).join("\n\n");
    for (let i = 0; i < 12; i++) docs[`docs/d${i}.md`] = `# D${i}\n\n${paragraphs}\n`;
    const { output } = await preview({ ...REPO, ...docs });
    expect(squashed(output)).toMatch(
      / Documentation \d+ files \d+ KB \d+ excerpted, \d+ not read \(budget\) Manifests/,
    );
  });

  it("says that ignored files couldn't be identified without git", async () => {
    const { output } = await preview(REPO);
    expect(squashed(output)).toContain(
      "Ignored files couldn't be identified (git not used): only the default exclusions were used.",
    );
  });

  it("gives the reason when git couldn't list ignored files", async () => {
    const git = gitReader({ ok: false, reason: "git_too_old" });
    const { output } = await preview(REPO, { git });
    expect(squashed(output)).toContain(
      "Ignored files couldn't be identified (git is too old, or a partial clone needs git 2.44 or later): only the default exclusions were used.",
    );
  });

  it("lists ignored entries, directories as not entered", async () => {
    const git = gitReader({ ok: true, paths: ["logs/", "x.log"] });
    const { output } = await preview({ ...REPO, "logs/a.log": "a", "x.log": "x" }, { git });
    expect(output).toContain("\n  Ignored by .gitignore: 2 entries   logs/ (not entered), x.log\n");
  });

  it("shortens a long ignored list, pointing to --list", async () => {
    const nodes: Record<string, MemoryNode> = { ...REPO };
    const paths: string[] = [];
    for (let i = 0; i < 30; i++) {
      nodes[`cache-${i}/x`] = "x";
      paths.push(`cache-${i}/`);
    }
    const { output } = await preview(nodes, { git: gitReader({ ok: true, paths }) });
    expect(squashed(output)).toMatch(
      /Ignored by \.gitignore: 30 entries cache-0\/ \(not entered\), .*… \(--list shows all\)/,
    );
  });

  it("reports the commit and whether there are uncommitted changes", async () => {
    const { output } = await preview(REPO, { git: gitReader() });
    expect(output).toContain("\nGit         commit 1dbc37f, uncommitted changes\n");
    const { output: noGit } = await preview(REPO);
    expect(noGit).toContain("\nGit         not used\n");
  });

  it("keeps every line within 80 columns", async () => {
    const nodes: Record<string, MemoryNode> = { ...REPO };
    for (let i = 0; i < 20; i++)
      nodes[`packages/package-with-a-long-name-${i}/node_modules/x.js`] = "x";
    const paths = Array.from({ length: 20 }, (_, i) => `a-rather-long-ignored-path-${i}.log`);
    for (const path of paths) nodes[path] = "x";
    const { output } = await preview(nodes, { git: gitReader({ ok: true, paths }) });
    for (const line of output.split("\n")) expect([...line].length).toBeLessThanOrEqual(80);
  });

  it("never shows a path that matches the secret scan", async () => {
    const git = gitReader({ ok: true, paths: [`keys-${awsKey}/`] });
    const { output } = await preview({ ...REPO, [`keys-${awsKey}/a`]: "a" }, { git });
    expect(output).not.toContain(awsKey);
    expect(output).toContain("<withheld>/ (not entered)");
  });

  it("points to --list for the full file list", async () => {
    const { output } = await preview(REPO);
    expect(output.trimEnd().split("\n").at(-1)).toBe(
      "  Run with --list to see every file and the reason for each.",
    );
  });
});

describe("when nothing can be sent", () => {
  it("explains a destination that can't be captured, and what to do", async () => {
    const { code, output } = await preview({
      ...REPO,
      "CLAUDE.md": { kind: "symlink", target: "x" },
    });
    expect(code).toBe(1);
    expect(squashed(output)).toContain("CLAUDE.md is a symbolic link");
    expect(output).toContain("Nothing was sent.");
    expect(output).not.toContain("What would be sent");
  });

  it("explains a destination that matches the secret scan, without the matched text", async () => {
    const { code, output } = await preview({ ...REPO, "CLAUDE.md": `# Keys\n\n${awsKey}\n` });
    expect(code).toBe(1);
    expect(squashed(output)).toContain("CLAUDE.md matches the secret scan (aws-access-key-id)");
    expect(output).not.toContain(awsKey);
  });

  it("explains a destination too large to send whole", async () => {
    const { code, output } = await preview({
      ...REPO,
      "CLAUDE.md": `# Big\n\n${"word ".repeat(9_000)}\n`,
    });
    expect(code).toBe(1);
    expect(squashed(output)).toMatch(/more than maxDestinationBytes \(40,000\)/);
  });

  it("explains a file that changed while it was being read", async () => {
    const { code, output } = await preview({
      ...REPO,
      "README.md": {
        kind: "file",
        content: (count) => Buffer.from(count <= 2 ? "# Old\n" : "# New\n"),
      },
    });
    expect(code).toBe(1);
    expect(squashed(output)).toContain("README.md changed while it was being read");
  });
});

describe("--list", () => {
  it("lists each item with its reason and lines, and every path not sent with its reason", async () => {
    const { output } = await preview(
      { ...REPO, "assets/logo.png": "png", "logs/a.log": "a" },
      { list: true, git: gitReader({ ok: true, paths: ["logs/"] }) },
    );
    expect(output).toMatch(/\nSent\n/);
    expect(output).toMatch(
      /\n {2}T1-001 {2}CLAUDE\.md\n {10}tier1:destination · lines 1-3 · [\d,]+ bytes\n/,
    );
    expect(output).toMatch(/\n {2}T5-001 {2}src\/index\.test\.ts\n {10}tier5:test-example · /);
    expect(output).toContain("\nNot sent\n");
    expect(output).toContain("\n  node_modules/  excluded (node_modules/)\n");
    expect(output).toContain("\n  .env  excluded (.env)\n");
    expect(output).toContain("\n  assets/logo.png  excluded (*.png)\n");
    expect(output).toContain("\n  logs/  ignored (not entered)\n");
    expect(output).not.toContain("What would be sent");
  });

  it("shows excerpts with the lines sent, skipped files and blocked files", async () => {
    const big = `# Big\n\n${Array.from({ length: 40 }, (_, i) => `## S${i}\n\n${"word ".repeat(80)}\n`).join("\n")}`;
    const { output } = await preview(
      {
        ...REPO,
        "docs/big.md": big,
        "src/config.ts": `const password = "${join("a1B2c3D4e5", "F6g7H8i9J0")}";\n`,
      },
      { list: true },
    );
    expect(output).toMatch(
      /docs\/big\.md\n {10}tier2:group3:docs · excerpt, lines [\d,-]+ of \d+ · [\d,]+ bytes\n/,
    );
    expect(output).toContain("\n  src/config.ts  blocked (secret pattern: generic-assignment)\n");
  });

  it("withholds a path that matches the secret scan, giving its hash", async () => {
    const { output } = await preview({ ...REPO, [`docs/${awsKey}.md`]: "# x\n" }, { list: true });
    expect(output).not.toContain(awsKey);
    expect(output).toMatch(
      /\n {2}<withheld> sha256:[0-9a-f]{12}… {2}blocked \(secret pattern: aws-access-key-id\)\n/,
    );
  });
});

describe("--json", () => {
  it("prints the input manifest: paths, hashes and reasons, never content", async () => {
    const { code, output } = await preview(REPO, { json: true });
    expect(code).toBe(0);
    const manifest = JSON.parse(output);
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      budget: { initialContextBytes: 300_000 },
    });
    expect(manifest.contextHash).toMatch(/^sha256:/);
    expect(output).not.toContain("Run the tests.");
  });

  it("prints the stop reason as JSON when nothing can be sent", async () => {
    const { code, output } = await preview(
      { ...REPO, "CLAUDE.md": { kind: "symlink", target: "x" } },
      { json: true },
    );
    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({
      state: "stopped",
      stop: { reason: "destination_unavailable", detail: "symlink" },
    });
  });
});

describe("withheld paths (IMPL §1.7)", () => {
  it("never prints a listed-only, unreadable or linked path that matches the scan, or a link target", async () => {
    const { output } = await preview(
      {
        ...REPO,
        [`data/${awsKey}.txt`]: Uint8Array.from([0, 1]),
        [`bad-${awsKey}.txt`]: { kind: "unreadable_file", reason: "permission_denied" },
        [`link-${awsKey}`]: { kind: "symlink", target: `t-${awsKey}` },
        "safe-link": { kind: "symlink", target: `t-${awsKey}` },
      },
      { list: true },
    );
    expect(output).not.toContain(awsKey);
    expect(output).toMatch(
      /\n {2}<withheld> sha256:[0-9a-f]{12}… {2}unreadable \(permission denied\)\n/,
    );
    expect(squashed(output)).toMatch(
      / <withheld> sha256:[0-9a-f]{12}… -> <withheld> sha256:[0-9a-f]{12}… symbolic link, not followed /,
    );
    expect(output).toMatch(/\n {2}safe-link -> <withheld> sha256:[0-9a-f]{12}… {2}symbolic link/);
    // The listed-only file is blocked by its path, and listed once.
    expect(output.match(/blocked \(secret pattern: aws-access-key-id\)/g)).toHaveLength(1);
    expect(output).not.toMatch(/<withheld>.* {2}listed only/);
  });

  it("withholds a changed path, in text and in JSON", async () => {
    const changing: MemoryNode = {
      kind: "file",
      content: (count) => Buffer.from(count <= 2 ? "# Old\n" : "# New\n"),
    };
    const path = `docs/${awsKey}.md`;
    const text = await preview({ ...REPO, [path]: changing });
    expect(text.code).toBe(1);
    expect(text.output).not.toContain(awsKey);
    expect(squashed(text.output)).toContain("<withheld> sha256:");
    const json = await preview({ ...REPO, [path]: changing }, { json: true });
    expect(json.output).not.toContain(awsKey);
    expect(JSON.parse(json.output)).toEqual({
      state: "unstable",
      changedPaths: [{ pathHash: expect.stringMatching(/^sha256:/) }],
    });
  });

  it("names a withheld excluded directory without its path", async () => {
    const { output } = await preview({ ...REPO, [`keys-${awsKey}/node_modules/x.js`]: "x" });
    expect(output).not.toContain(awsKey);
    expect(squashed(output)).toContain(
      "Not sent: <withheld> (not entered), node_modules (not entered)",
    );
  });

  it("shows a withheld ignored file as a file and a withheld ignored directory as a directory", async () => {
    const git = gitReader({ ok: true, paths: [`f-${awsKey}.log`, `d-${awsKey}/`] });
    const nodes = { ...REPO, [`f-${awsKey}.log`]: "x", [`d-${awsKey}/a`]: "a" };
    const { output } = await preview(nodes, { git });
    expect(output).not.toContain(awsKey);
    expect(output).toContain(
      "Ignored by .gitignore: 2 entries   <withheld>/ (not entered), <withheld>\n",
    );
    const list = await preview(nodes, { git, list: true });
    expect(list.output).toMatch(
      /\n {2}<withheld> sha256:[0-9a-f]{12}…\/ {2}ignored \(not entered\)\n/,
    );
    expect(list.output).toMatch(/\n {2}<withheld> sha256:[0-9a-f]{12}… {2}ignored\n/);
  });
});

describe("more of the summary and list", () => {
  it("notes items sent as an outline alone", async () => {
    const big = `import { x } from "./x";\nexport function f() {\n${"  x();\n".repeat(3_000)}}\n`;
    const { output } = await preview({ ...REPO, "src/big.ts": big });
    expect(squashed(output)).toMatch(
      /Source samples \d+ files <?\d+ KB [^:]*1 outline only Not sent/,
    );
  });

  it("lists files not read for budget, and the tree's size", async () => {
    const docs: Record<string, MemoryNode> = {};
    const paragraphs = Array.from({ length: 12 }, () => "word ".repeat(200).trim()).join("\n\n");
    for (let i = 0; i < 12; i++) docs[`docs/d${i}.md`] = `# D${i}\n\n${paragraphs}\n`;
    const { output } = await preview({ ...REPO, ...docs }, { list: true });
    expect(output).toMatch(/\nNot read \(budget\)\n\n {2}docs\/d\d+\.md {2}tier2:cap-reached\n/);
    expect(output).toMatch(/\n {2}TREE {4}\d+ files listed, depth 4 · [\d,]+ bytes\n/);
  });

  it("warns when files changed during capture, and says when changes are unknown", async () => {
    const nodes: Record<string, MemoryNode> = {
      ...REPO,
      "notes.txt": { kind: "file", content: (count) => Buffer.from(`${count}`) },
      locked: { kind: "unreadable_file", reason: "permission_denied" },
    };
    const git: GitReader = {
      readIgnored: async () => ({ ok: true, paths: [] }),
      readHead: async () => ({
        ok: true,
        objectFormat: "sha1",
        commit: COMMIT,
        tree: [{ path: "locked", mode: "100644", objectId: "0".repeat(40), size: 1 }],
      }),
    };
    const { output } = await preview(nodes, { git });
    expect(squashed(output)).toContain(
      "Warning 1 file changed while the repository was being read, so this may not match it.",
    );
    expect(output).toContain("uncommitted changes");
  });

  it("keeps --list and the stop screen within 80 columns, except a path longer than the line", async () => {
    const long = `docs/${"a-very-long-directory-name/".repeat(4)}file.md`;
    const outputs = [
      (await preview({ ...REPO, [long]: "# x\n" }, { list: true })).output,
      (await preview({ ...REPO, "CLAUDE.md": { kind: "symlink", target: "x" } })).output,
      (await preview({ ...REPO, "CLAUDE.md": `# Big\n\n${"word ".repeat(9_000)}\n` })).output,
    ];
    for (const output of outputs) {
      for (const line of output.split("\n")) {
        const words = line.trim().split(" ");
        const onlyLongPath = words.length <= 2 && words.some((word) => word.length > 70);
        if (!onlyLongPath) expect([...line].length).toBeLessThanOrEqual(80);
      }
    }
  });
});
