import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_SETTINGS, selectTiers } from "../src/core/context/tiers.js";
import { extractKnownFacts } from "../src/core/facts/known-facts.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../src/core/snapshot/snapshot.js";
import { fixedClock, fixedIds, MemoryFs, type MemoryNode } from "./support/memory-fs.js";

// Adversarial known-facts fixtures (IMPL §3.2.5), written from the spec without the code. Each
// case is a small repository and the facts and gaps it must give, in order. Two cases hold bytes
// a committed fixture can't: their repo/NOTES.md says what to build here.

const ROOT = join(import.meta.dirname, "fixtures/known-facts");
const encode = (text: string) => new TextEncoder().encode(text);

function load(directory: string, prefix = ""): Record<string, MemoryNode> {
  const nodes: Record<string, MemoryNode> = {};
  for (const name of readdirSync(directory)) {
    const path = `${prefix}${name}`;
    const full = join(directory, name);
    if (path === "NOTES.md") continue;
    if (statSync(full).isDirectory()) Object.assign(nodes, load(full, `${path}/`));
    else nodes[path] = new Uint8Array(readFileSync(full));
  }
  return nodes;
}

const awsKey = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
const connection = ["postgres", "://app:", "s3cr3tpass", "@db.internal/app"].join("");

/** Builds what the NOTES.md of a case describes. */
const BUILD: Record<string, (nodes: Record<string, MemoryNode>) => void> = {
  "secret-scan-withheld": (nodes) => {
    let substituted = 0;
    for (const [path, node] of Object.entries(nodes)) {
      const text = new TextDecoder().decode(node as Uint8Array);
      const replaced = text
        .replaceAll("__AWS_KEY_ID__", awsKey)
        .replaceAll("__CONN_STRING__", connection);
      if (replaced !== text) substituted++;
      nodes[path] = encode(replaced);
    }
    expect(substituted).toBeGreaterThan(0);
    nodes[`.claude/${awsKey}.md`] = new Uint8Array();
  },
  "listed-only-manifests": (nodes) => {
    nodes["package.json"] = encode('{\0"scripts":{"build":"tsc"}}');
    nodes["Makefile"] = new Uint8Array([...encode("build:\n\techo caf"), 0xe9, 0x0a]);
    let justfile = "build:\n    echo build\n";
    while (justfile.length <= 262_144) justfile += "# pad\n";
    nodes["justfile"] = encode(justfile);
    nodes[".claude/notes.md"] = encode("Agent notes\0\n");
    nodes["docs/blob.txt"] = encode("data\0\n");
  },
};

interface Expected {
  readonly facts: readonly {
    readonly statement: string;
    readonly scope: string;
    readonly evidence: readonly (
      | { readonly kind: "entry"; readonly path: string }
      | { readonly kind: "lines"; readonly path: string; lineStart: number; lineEnd: number }
    )[];
  }[];
  readonly gaps: readonly {
    readonly statement: string;
    readonly relatedPaths: readonly string[];
  }[];
}

describe("known-facts fixtures (IMPL §3.2.5)", () => {
  for (const name of readdirSync(ROOT).sort()) {
    it(name, async () => {
      const nodes = load(join(ROOT, name, "repo"));
      BUILD[name]?.(nodes);
      const expected = JSON.parse(
        readFileSync(join(ROOT, name, "expected.json"), "utf8"),
      ) as Expected;

      const fs = new MemoryFs(nodes);
      const snapshot = await captureSnapshot(
        { fs, clock: fixedClock, ids: fixedIds },
        DEFAULT_SNAPSHOT_SETTINGS,
      );
      const selection = await selectTiers(snapshot, DEFAULT_CONTEXT_SETTINGS, fs);
      if (selection.state !== "selected") throw new Error(selection.state);
      const result = await extractKnownFacts(snapshot, selection, fs);
      if (result.state !== "extracted") throw new Error(result.state);

      expect({
        facts: result.facts.map((fact) => ({
          statement: fact.statement,
          scope: fact.scope.kind === "repository" ? "repository" : fact.scope.paths[0],
          evidence: fact.evidence.map((e) =>
            e.kind === "entry"
              ? { kind: e.kind, path: e.path }
              : { kind: e.kind, path: e.path, lineStart: e.lineStart, lineEnd: e.lineEnd },
          ),
        })),
        gaps: result.gaps.map((gap) => ({
          statement: gap.statement,
          relatedPaths: gap.relatedPaths,
        })),
      }).toEqual(expected);
    });
  }
});
