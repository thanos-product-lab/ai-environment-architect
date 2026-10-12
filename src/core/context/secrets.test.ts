import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
  seededShuffle,
} from "../../../test/support/memory-fs.js";
import { SECRET_FIXTURES } from "../../../test/support/secret-fixtures.js";
import { sha256 } from "../hash.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import {
  applySecretScan,
  GAP_WITHHELD,
  importWithheld,
  type ScannedSelection,
  SECRET_RULES,
  SECRET_RULES_VERSION,
  scanText,
} from "./secrets.js";
import { type ContextSettings, DEFAULT_CONTEXT_SETTINGS, selectTiers } from "./tiers.js";

// The secret scan (IMPL §1.7).

const join = (...fragments: string[]): string => fragments.join("");
const body20 = join("a1B2c3D4e5", "F6g7H8i9J0");
const awsKey = "AKIAIOSFODNN7EXAMPLE";
const stripeKey = join("sk", "_live_", body20);

describe("secret rules version", () => {
  it("pins the rule set to its version", () => {
    // If this fails, the rules changed. Increase SECRET_RULES_VERSION and record the new
    // fingerprint here (IMPL §1.7).
    const canonical = JSON.stringify(
      SECRET_RULES.map((rule) => [rule.id, rule.pattern.source, rule.pattern.flags]),
    );
    expect({
      version: SECRET_RULES_VERSION,
      fingerprint: sha256(new TextEncoder().encode(canonical)),
    }).toEqual({
      version: "secret-scan/1.0.0",
      fingerprint: "sha256:9ae458275333092b7032960378b4e3ac420d40943a13b8510dc9a3c2bdddfd50",
    });
  });

  it("has one set of fixtures per rule, in rule order", () => {
    expect(SECRET_FIXTURES.map((fixture) => fixture.rule)).toEqual(
      SECRET_RULES.map((rule) => rule.id),
    );
  });

  it("uses no global or sticky flags, so matching keeps no state", () => {
    for (const rule of SECRET_RULES) expect(rule.pattern.flags).not.toMatch(/[gy]/);
  });
});

describe("scanText", () => {
  for (const fixture of SECRET_FIXTURES) {
    describe(fixture.rule, () => {
      it.each(fixture.matches.map((line, index) => [index, line]))(
        "matches fixture %i",
        (_, line) => {
          expect(scanText(line)).toBe(fixture.rule);
          expect(scanText(`before\n  12 | ${line}\nafter\n`)).toBe(fixture.rule);
        },
      );

      it.each(fixture.misses.map((line, index) => [index, line]))(
        "no rule matches near miss %i",
        (_, line) => {
          expect(scanText(line)).toBeUndefined();
        },
      );
    });
  }

  it("returns undefined for ordinary text", () => {
    expect(scanText("")).toBeUndefined();
    expect(scanText("export function main() {\n  return 1;\n}\n")).toBeUndefined();
  });

  it("returns the first matching rule in rule order", () => {
    // An access key ID followed by another character is not one, so only the assignment matches.
    expect(scanText(`AWS_ACCESS_TOKEN=${awsKey}1`)).toBe("generic-assignment");
    expect(scanText(`api_key = "${stripeKey}"`)).toBe("stripe-key");
    expect(scanText(`${body20}\npassword = "${body20}"\n${awsKey}`)).toBe("aws-access-key-id");
  });

  it("gives the same answer when called repeatedly", () => {
    const text = `x\n${awsKey}\n`;
    expect([scanText(text), scanText(text), scanText(text)]).toEqual(
      Array(3).fill("aws-access-key-id"),
    );
  });

  it("matches names ASCII case-insensitively in generic-assignment", () => {
    expect(scanText(`Api_Key=${body20}`)).toBe("generic-assignment");
    expect(scanText(`PASSWORD=${body20}`)).toBe("generic-assignment");
  });

  it("requires 20 characters, a digit and a letter for generic-assignment", () => {
    expect(scanText(`token=${body20.slice(0, 19)}`)).toBeUndefined();
    expect(scanText(`token=${body20}`)).toBe("generic-assignment");
    expect(scanText(`token=${"a".repeat(30)}`)).toBeUndefined();
    expect(scanText(`token=${"1".repeat(30)}`)).toBeUndefined();
  });

  it.each([
    ["a run of letters", "a"],
    ["repeated keywords", "token"],
    ["repeated assignments", "token="],
    ["repeated assignments with digits", "token=1a"],
    ["repeated quoted keys", '"token": "'],
    ["keywords between slashes", "a/token"],
    ["a long unterminated value", "password=a1"],
    ["repeated colons", "a:"],
    ["repeated schemes", "x://"],
    ["repeated credentials without a host", "x://b:c"],
    ["repeated dotted names", "a.token="],
    ["repeated JWT prefixes", "token=eyJ."],
    ["repeated padding", "token=a1=="],
    ["repeated key headers", "-----BEGIN A"],
  ])("finishes quickly on %s", (_, unit) => {
    // About a million characters: linear time takes milliseconds, quadratic time takes hours.
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const start = performance.now();
    scanText(text);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Applying the scan to a tier selection (IMPL §1.3 step 3, §1.5 destination rule, §1.7).

async function scanned(
  nodes: Record<string, MemoryNode>,
  settings: Partial<ContextSettings> = {},
  order?: (names: string[]) => string[],
): Promise<ScannedSelection> {
  const fs = new MemoryFs(nodes, order === undefined ? {} : { order });
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    DEFAULT_SNAPSHOT_SETTINGS,
  );
  const selection = await selectTiers(snapshot, { ...DEFAULT_CONTEXT_SETTINGS, ...settings }, fs);
  if (selection.state !== "selected")
    throw new Error(`expected a selection, got ${selection.state}`);
  return applySecretScan(selection);
}

async function selectedAfterScan(
  nodes: Record<string, MemoryNode>,
  settings: Partial<ContextSettings> = {},
) {
  const result = await scanned(nodes, settings);
  if (result.state !== "selected") throw new Error(`expected a selection, got ${result.state}`);
  return result;
}

describe("applySecretScan", () => {
  it("removes each blocked file and records its path, tier and rule", async () => {
    const result = await selectedAfterScan({
      "README.md": "# App\n\nHello.\n",
      "package.json": '{ "name": "app" }\n',
      "src/config.ts": `export const config = {\n  apiKey: "${body20}",\n};\n`,
      "src/index.ts": "export function main() {}\n",
      "AGENTS.md": `# Agents\n\nUse ${awsKey} for nothing.\n`,
    });
    expect(result.items.map((item) => item.path)).toEqual([
      "README.md",
      "package.json",
      "src/index.ts",
    ]);
    expect(result.blocked).toEqual([
      { path: "AGENTS.md", tier: 1, ruleId: "aws-access-key-id" },
      { path: "src/config.ts", tier: 5, ruleId: "generic-assignment" },
    ]);
  });

  it("never records the matched text", async () => {
    const result = await scanned({
      "src/config.ts": `export const config = {\n  apiKey: "${body20}",\n};\n`,
      "src/index.ts": `const url = "${join("postgres://", "app:", "s3cret", "@db/app")}";\n`,
    });
    const recorded = JSON.stringify(result);
    expect(recorded).not.toContain(body20);
    expect(recorded).not.toContain("s3cret");
  });

  it("scans outline labels too", async () => {
    // The section under the heading is omitted, but the outline still carries the heading.
    const heading = `## Rotate ${stripeKey}`;
    const doc = `# Guide\n\nShort.\n\n${heading}\n\n${"word ".repeat(400).trimEnd()}\n`;
    const settings = {
      ...DEFAULT_CONTEXT_SETTINGS,
      perFileCaps: { ...DEFAULT_CONTEXT_SETTINGS.perFileCaps, tier2: 600 },
    };
    const fs = new MemoryFs({ "docs/guide.md": doc });
    const snapshot = await captureSnapshot(
      { fs, clock: fixedClock, ids: fixedIds },
      DEFAULT_SNAPSHOT_SETTINGS,
    );
    const before = await selectTiers(snapshot, settings, fs);
    if (before.state !== "selected") throw new Error("expected a selection");
    const rendered = before.items[0]?.rendered;
    expect(rendered?.outline).toContainEqual({ line: 5, label: heading, mark: "omitted" });
    expect(rendered?.included).toEqual([{ first: 1, last: 4 }]);

    const after = applySecretScan(before);
    expect(after.state === "selected" && after.blocked).toEqual([
      { path: "docs/guide.md", tier: 2, ruleId: "stripe-key" },
    ]);
  });

  it("scans placeholder files like any other file", async () => {
    const result = await selectedAfterScan({ ".claude/env.example": `API_TOKEN=${body20}\n` });
    expect(result.blocked).toEqual([
      { path: ".claude/env.example", tier: 1, ruleId: "generic-assignment" },
    ]);
  });

  it("does not refill budgets or renumber item IDs", async () => {
    const doc = (title: string) => `# ${title}\n\n${"word ".repeat(150).trimEnd()}\n`;
    const caps = { tier1: 2_000, tier2: 2_000, tier3: 2_000, tier4: 2_000, tier5: 2_000 };
    const nodes: Record<string, MemoryNode> = {
      "docs/a.md": doc("A"),
      "docs/b.md": `${doc("B")}\n${awsKey}\n`,
      "docs/c.md": doc("C"),
      "docs/d.md": doc("D"),
      "docs/e.md": doc("E"),
    };
    const fs = new MemoryFs(nodes);
    const snapshot = await captureSnapshot(
      { fs, clock: fixedClock, ids: fixedIds },
      DEFAULT_SNAPSHOT_SETTINGS,
    );
    const settings = { ...DEFAULT_CONTEXT_SETTINGS, tierCaps: caps };
    const before = await selectTiers(snapshot, settings, fs);
    if (before.state !== "selected") throw new Error("expected a selection");
    const after = applySecretScan(before);
    if (after.state !== "selected") throw new Error("expected a selection");

    const blockedItem = before.items.find((item) => item.path === "docs/b.md");
    expect(blockedItem).toBeDefined();
    expect(after.items).toEqual(before.items.filter((item) => item.path !== "docs/b.md"));
    expect(after.skipped).toEqual(before.skipped);
    // The budget was tight, yet nothing was re-rendered larger or added.
    expect(before.items.some((i) => i.rendered.excerpt) || before.skipped.length > 0).toBe(true);

    const tier2Before = before.tiers.find((t) => t.tier === 2);
    const tier2After = after.tiers.find((t) => t.tier === 2);
    expect(tier2After).toEqual({
      ...tier2Before,
      usedBytes: (tier2Before?.usedBytes ?? 0) - (blockedItem?.rendered.bytes ?? 0),
      items: (tier2Before?.items ?? 0) - 1,
    });
    // Later tiers keep the budget they were given.
    expect(after.tiers.find((t) => t.tier === 3)).toEqual(before.tiers.find((t) => t.tier === 3));
    expect(after.reservedTreeBytes).toBe(before.reservedTreeBytes);
  });

  it("recounts test examples in tier 5", async () => {
    const result = await selectedAfterScan({
      "src/index.ts": "export function main() {}\n",
      "src/index.test.ts": `const token = "${body20}";\n`,
    });
    expect(result.blocked).toEqual([
      { path: "src/index.test.ts", tier: 5, ruleId: "generic-assignment" },
    ]);
    const tier5 = result.tiers.find((t) => t.tier === 5);
    expect(tier5?.testExamples).toBe(0);
    expect(tier5?.items).toBe(1);
  });

  it("returns an unchanged selection with no blocked files when nothing matches", async () => {
    const result = await selectedAfterScan({
      "CLAUDE.md": "# Project\n",
      "README.md": "# App\n",
      "src/index.ts": "export function main() {}\n",
    });
    expect(result.blocked).toEqual([]);
    expect(result.items.map((i) => i.id)).toEqual(["T1-001", "T2-001", "T5-001"]);
  });

  it("stops the session when the destination matches", async () => {
    const result = await scanned({
      "CLAUDE.md": `# Project\n\nDeploy with ${join("gh", "p_", body20, "k1L2m3N4o5P6q7R8")}.\n`,
      "README.md": "# App\n",
    });
    expect(result).toEqual({
      state: "stopped",
      stop: { reason: "destination_secret", ruleId: "github-token" },
    });
    expect(JSON.stringify(result)).not.toContain(body20);
  });

  it("produces the same result regardless of item scan order", async () => {
    const nodes: Record<string, MemoryNode> = {
      "AGENTS.md": `${awsKey}\n`,
      "README.md": `password = "${body20}"\n`,
      "src/index.ts": "export function main() {}\n",
    };
    const reference = await scanned(nodes);
    expect(reference.state === "selected" && reference.blocked.length).toBe(2);
    for (const seed of [1, 2, 3]) {
      expect(await scanned(nodes, {}, seededShuffle(seed))).toEqual(reference);
    }
  });
  it.each(SECRET_FIXTURES.map((fixture) => [fixture.rule, fixture.matches[0] ?? ""]))(
    "blocks a %s fixture in a selected file",
    async (rule, line) => {
      const result = await selectedAfterScan({ ".claude/notes.md": `# Notes\n\n${line}\n` });
      expect(result.blocked).toEqual([{ path: ".claude/notes.md", tier: 1, ruleId: rule }]);
      expect(result.items).toEqual([]);
    },
  );

  it("withholds an import gap whose import matches, even from a blocked or skipped file", async () => {
    const token = join("gh", "p_", body20, "k1L2m3N4o5P6q7R8");
    const result = await selectedAfterScan(
      {
        "AGENTS.md": `# Agents\n\nSee @~/.config/gh/${token} for access.\n`,
        ".claude/big.md": `# Big\n\nSee @~/keys/${token}\n\n${"word ".repeat(600)}\n`,
      },
      { tierCaps: { tier1: 1_000, tier2: 2_000, tier3: 2_000, tier4: 2_000, tier5: 2_000 } },
    );
    expect(result.skipped.map((s) => s.path)).toContain(".claude/big.md");
    expect(result.gaps.map((gap) => gap.statement)).toEqual(
      expect.arrayContaining([importWithheld(".claude/big.md"), importWithheld("AGENTS.md")]),
    );
    expect(JSON.stringify(result)).not.toContain(body20);
  });

  it("withholds an import gap when cutting the import would leave part of a secret", async () => {
    // Cut to 80 code points, the import keeps 30 of the token's characters and no rule matches.
    const token = join("gh", "p_", body20, "k1L2m3N4o5P6q7R8");
    const written = `~/${"d".repeat(46)}/${token}`;
    const result = await selectedAfterScan({ "AGENTS.md": `# Agents\n\n@${written}\n` });
    expect(result.gaps.map((gap) => gap.statement)).toEqual([importWithheld("AGENTS.md")]);
  });

  it("withholds any other gap statement that matches", () => {
    const statement = `Found ${awsKey}.`;
    const selection = {
      state: "selected" as const,
      packages: [],
      items: [],
      skipped: [],
      tiers: [],
      gaps: [{ gapType: "other" as const, statement, relatedPaths: ["a.md"] }],
      reservedTreeBytes: 0,
    };
    const result = applySecretScan(selection);
    expect(result.state === "selected" && result.gaps).toEqual([
      { gapType: "other", statement: GAP_WITHHELD, relatedPaths: ["a.md"] },
    ]);
  });
  it("blocks a file whose cut outline label would have hidden part of a secret", async () => {
    // Cut to 80 code points, the heading keeps only part of the token, which no rule matches.
    const token = join("gh", "p_", body20, "k1L2m3N4o5P6q7R8");
    const heading = `## ${"h".repeat(60)} ${token}`;
    const doc = `# Guide\n\nShort.\n\n${heading}\n\n${"word ".repeat(400).trimEnd()}\n`;
    const result = await selectedAfterScan(
      { "docs/guide.md": doc },
      { perFileCaps: { ...DEFAULT_CONTEXT_SETTINGS.perFileCaps, tier2: 600 } },
    );
    expect(result.blocked).toEqual([{ path: "docs/guide.md", tier: 2, ruleId: "github-token" }]);
  });

  it("moves a gap's related path that matches to relatedPathHashes", () => {
    const path = `docs/${awsKey}.md`;
    const selection = {
      state: "selected" as const,
      packages: [],
      items: [],
      skipped: [],
      tiers: [],
      gaps: [{ gapType: "other" as const, statement: "Some text.", relatedPaths: [path, "a.md"] }],
      reservedTreeBytes: 0,
    };
    const result = applySecretScan(selection);
    expect(result.state === "selected" && result.gaps).toEqual([
      {
        gapType: "other",
        statement: "Some text.",
        relatedPaths: ["a.md"],
        relatedPathHashes: [sha256(new TextEncoder().encode(path))],
      },
    ]);
  });
  it("blocks a file whose cut declaration label would have hidden part of a secret", async () => {
    // The cut keeps only the first 79 code points of the label, so the key survives only uncut.
    const key = join("sk", "_live_", body20);
    const source = `export function ${"f".repeat(70)}_${key}() {\n${"  const value = 1;\n".repeat(80)}}\nexport const b = 1;\n`;
    const result = await selectedAfterScan(
      { "src/index.ts": source },
      { perFileCaps: { ...DEFAULT_CONTEXT_SETTINGS.perFileCaps, tier5: 400 } },
    );
    expect(result.blocked).toEqual([{ path: "src/index.ts", tier: 5, ruleId: "stripe-key" }]);
  });

  it("blocks a selected file whose raw path matches, even when JSON encoding hides it", async () => {
    const path = `src/token="${body20}".ts`;
    const result = await selectedAfterScan({ [path]: "export const a = 1;\n" });
    expect(result.blocked).toEqual([{ path, tier: 5, ruleId: "generic-assignment" }]);
    expect(result.items).toEqual([]);
  });
});
