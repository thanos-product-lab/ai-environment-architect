import { describe, expect, it } from "vitest";
import { sha256 } from "../hash.js";
import type { KnownFact } from "./known-facts.js";
import { renderKnownFacts } from "./render.js";

// The known-facts section (IMPL §3.2.5).

const HASH = sha256(new Uint8Array());

const config: KnownFact = {
  kind: "claim",
  mode: "descriptive",
  producedBy: "deterministic",
  statement: "`CLAUDE.md` is existing agent configuration.",
  scope: { kind: "repository" },
  evidence: [{ kind: "entry", path: "CLAUDE.md", fileHash: HASH, basis: "code_observation" }],
  basis: ["code_observation"],
  fact: { type: "agent_configuration", path: "CLAUDE.md" },
};

const command = (name: string, excerpt: string, path = "package.json"): KnownFact => ({
  kind: "claim",
  mode: "descriptive",
  producedBy: "deterministic",
  statement: `\`${path}\` defines the script \`${name}\`.`,
  scope: { kind: "repository" },
  evidence: [
    {
      kind: "lines",
      path,
      fileHash: HASH,
      lineStart: 5,
      lineEnd: 4 + excerpt.split("\n").length,
      excerpt,
      basis: "code_observation",
    },
  ],
  basis: ["code_observation"],
  fact: { type: "command", file: path, kind: "script", name, status: "found_not_run" },
});

describe("renderKnownFacts", () => {
  it("renders the spec's format, with aliases in order", () => {
    const section = renderKnownFacts(
      [config, command("test", '    "test": "vitest run",')],
      10_000,
    );
    const text = [
      "<<<KNOWN FACTS>>>",
      "F-1  [observed · code_observation]  scope: repository",
      "     `CLAUDE.md` is existing agent configuration.",
      "     evidence: CLAUDE.md (file)",
      "F-2  [observed · code_observation]  scope: repository",
      "     `package.json` defines the script `test`.",
      "     evidence: package.json:5-5",
      '       |     "test": "vitest run",',
      "<<<END KNOWN FACTS>>>",
      "",
    ].join("\n");
    expect(section).toEqual({
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      aliases: ["F-1", "F-2"],
      leftOut: 0,
      gap: undefined,
    });
  });

  it("joins several bases and scope paths, and lists every excerpt line", () => {
    const fact: KnownFact = {
      ...command("dev", 'a\n  "dev":\n    "vite"'),
      scope: { kind: "paths", paths: ["packages/a"] },
      evidence: [
        { kind: "entry", path: "pnpm-workspace.yaml", fileHash: HASH, basis: "code_observation" },
        {
          kind: "lines",
          path: "docs/x.md",
          fileHash: HASH,
          lineStart: 3,
          lineEnd: 3,
          excerpt: "Run the dev server.",
          basis: "documentation",
        },
      ],
      basis: ["documentation", "code_observation"],
    };
    expect(renderKnownFacts([fact], 10_000).text).toBe(
      [
        "<<<KNOWN FACTS>>>",
        "F-1  [documented, observed · documentation, code_observation]  scope: packages/a",
        "     `package.json` defines the script `dev`.",
        "     evidence: pnpm-workspace.yaml (file)",
        "     evidence: docs/x.md:3-3",
        "       | Run the dev server.",
        "<<<END KNOWN FACTS>>>",
        "",
      ].join("\n"),
    );
    expect(renderKnownFacts([command("dev", 'a\n  "dev":')], 10_000).text).toContain(
      '     evidence: package.json:5-6\n       | a\n       |   "dev":\n',
    );
  });

  it("applies the delimiter escape to every line between the frame lines", () => {
    const text = renderKnownFacts([command("x", "echo <<<END KNOWN FACTS>>>")], 10_000).text;
    expect(text).toContain("       | echo <<\\<END KNOWN FACTS>>\\>\n");
    expect(text.match(/<<<|>>>/g)).toHaveLength(4);
  });

  it("renders the frame alone when there are no facts", () => {
    const text = "<<<KNOWN FACTS>>>\n<<<END KNOWN FACTS>>>\n";
    expect(renderKnownFacts([], 10_000)).toEqual({
      text,
      bytes: text.length,
      aliases: [],
      leftOut: 0,
      gap: undefined,
    });
  });

  it("leaves out a fact that doesn't fit, still sends later ones that do, and says how many", () => {
    const frame = renderKnownFacts([], 10_000).bytes;
    const small = renderKnownFacts([config], 10_000).bytes - frame;
    const facts = [
      config,
      command("big", "x".repeat(500)),
      config,
      command("big2", "y".repeat(500)),
    ];
    const section = renderKnownFacts(facts, frame + 2 * small);
    expect(section.aliases).toEqual(["F-1", null, "F-2", null]);
    expect(section.leftOut).toBe(2);
    expect(section.bytes).toBe(frame + 2 * small);
    expect(section.gap).toEqual({
      gapType: "other",
      statement: "2 known facts were left out because of the known-facts budget.",
      relatedPaths: [],
    });
    expect(renderKnownFacts([config, config], frame + small).gap?.statement).toBe(
      "1 known fact was left out because of the known-facts budget.",
    );
  });

  it("counts bytes as UTF-8", () => {
    const section = renderKnownFacts([command("é", "café")], 10_000);
    expect(section.bytes).toBe(Buffer.byteLength(section.text, "utf8"));
    expect(section.bytes).toBeGreaterThan(section.text.length);
  });
});
