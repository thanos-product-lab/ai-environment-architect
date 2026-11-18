import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ExpansionInputRequest,
  expansionRoundFields,
  renderExpansionStatus,
  runExpansion,
} from "../src/core/context/expansion.js";
import { lineTexts } from "../src/core/context/item.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../src/core/context/tiers.js";
import { splitLines } from "../src/core/destination/guidance-blocks.js";
import { sha256 } from "../src/core/hash.js";
import type { SnapshotFile } from "../src/core/snapshot/snapshot.js";
import {
  checkExpansionRequest,
  DEFAULT_EXPANSION_SETTINGS,
  type ExpansionRequest,
  expansionIndex,
} from "../src/core/validation/expansion.js";
import { analyse } from "../src/schemas/analyse.js";
import { MemoryFs, type MemoryNode, seededShuffle } from "./support/memory-fs.js";

// Expansion execution cases (IMPL §1.8), written from the spec by the fixture-adversary agent
// without seeing the implementation. Each case is a tiny repository, what call 1 sent, and call
// 1's expansion requests; the runner applies the static checks, then executes the round, and
// compares every request's outcome and the status lines. README: `expansion/`.

const DIR = join(import.meta.dirname, "fixtures", "expansion");
const PLACEHOLDER = "{{aws-access-key-id}}";
const EXAMPLE_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");

type Content = string | { readonly base64: string };

interface FixtureFile {
  readonly path: string;
  readonly status: "read" | "listed_only" | "ignored" | "excluded" | "symlink";
  readonly reason?: "too_large" | "contains_nul" | "not_utf8";
  readonly rule?: string;
  readonly target?: string;
  readonly content?: Content;
}

interface ExpectedItem {
  readonly id: string;
  readonly path: string;
  readonly includedLines: string;
  readonly excerpt?: boolean;
  readonly totalLines?: number;
  /** Whether the item has an OUTLINE section. */
  readonly outline?: boolean;
  readonly reason?: string;
}

interface ExpectedRequest {
  readonly index: number;
  readonly outcome: "executed" | "rejected";
  readonly rule?: string;
  readonly matches?: number;
  readonly capped?: boolean;
  readonly items?: readonly ExpectedItem[];
}

interface Case {
  readonly description: string;
  readonly section: string;
  readonly rule: string | null;
  readonly nearMissOf?: string;
  readonly settings?: Partial<typeof DEFAULT_EXPANSION_SETTINGS>;
  readonly files: readonly FixtureFile[];
  readonly changed?: Readonly<Record<string, Content | null>>;
  readonly sent?: Readonly<Record<string, string>>;
  readonly requests: readonly ExpansionRequest[];
  readonly expect: {
    readonly requests: readonly ExpectedRequest[];
    readonly status: readonly string[];
    /** Text the round's record and status lines must not hold, placeholder replaced. */
    readonly recordExcludes?: readonly string[];
    /** Text no item's content lines may hold, for the delimiter escape. */
    readonly itemContentExcludes?: readonly string[];
  };
}

const unplace = (text: string) => text.split(PLACEHOLDER).join(EXAMPLE_KEY);

function bytesOf(content: Content): Uint8Array {
  return typeof content === "string"
    ? Buffer.from(unplace(content), "utf8")
    : Buffer.from(content.base64, "base64");
}

function snapshotFile(file: FixtureFile): SnapshotFile {
  const path = unplace(file.path);
  switch (file.status) {
    case "excluded":
      return { path, status: "excluded", kind: "file", rule: file.rule ?? "excluded" };
    case "symlink":
      return { path, status: "symlink", target: file.target ?? "elsewhere" };
    default: {
      const bytes = bytesOf(file.content ?? "");
      const common = { path, size: bytes.length, hash: sha256(bytes) };
      if (file.status === "listed_only")
        return { ...common, status: "listed_only", reason: file.reason ?? "too_large" };
      if (file.status === "ignored") return { ...common, status: "ignored", kind: "file" };
      return { ...common, status: "read" };
    }
  }
}

function ranges(text: string): { first: number; last: number }[] {
  return text.split(",").map((range) => {
    const [first, last] = range.split("-").map(Number) as [number, number?];
    return { first, last: last ?? first };
  });
}

const cases = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => [name, JSON.parse(readFileSync(join(DIR, name), "utf8")) as Case] as const);

async function execute(fixture: Case, order?: (names: string[]) => string[]) {
  const settings = { ...DEFAULT_EXPANSION_SETTINGS, ...fixture.settings };
  const files = fixture.files.map(snapshotFile);
  const sent = Object.entries(fixture.sent ?? {}).map(([rawPath, lines]) => {
    const path = unplace(rawPath);
    const file = fixture.files.find((f) => unplace(f.path) === path);
    const bytes = bytesOf(file?.content ?? "");
    const texts = lineTexts(bytes, splitLines(bytes));
    return {
      path,
      totalLines: texts.length,
      sent: ranges(lines).map((r) => ({ first: r.first, lines: texts.slice(r.first - 1, r.last) })),
    };
  });
  const index = expansionIndex({
    files,
    scopeRoots: ["."],
    sent,
    maxRequests: settings.maxExpansionRequests,
  });
  const requests = fixture.requests.map((raw, position): ExpansionInputRequest => {
    // A request that fails the schema fails the whole response before execution (§3.5).
    const parsed = analyse.items.expansionRequests.safeParse(raw);
    if (!parsed.success)
      throw new Error(`request ${position} fails the schema: ${parsed.error.message}`);
    const request = JSON.parse(unplace(JSON.stringify(raw))) as ExpansionRequest;
    if (position >= settings.maxExpansionRequests)
      return { kind: request.kind, rejectedBy: "LIMIT-002" };
    const check = checkExpansionRequest(request, index);
    return check.ok ? { request } : { kind: request.kind, rejectedBy: check.rule };
  });
  const nodes: Record<string, MemoryNode> = {};
  for (const file of fixture.files)
    if (file.content !== undefined) nodes[unplace(file.path)] = bytesOf(file.content);
  for (const [path, content] of Object.entries(fixture.changed ?? {})) {
    if (content === null) delete nodes[unplace(path)];
    else nodes[unplace(path)] = bytesOf(content);
  }
  return runExpansion(
    {
      requests,
      files,
      index,
      membership: {
        packages: [],
        imports: [],
        sourceExtensions: DEFAULT_CONTEXT_SETTINGS.sourceExtensions,
      },
      settings,
    },
    new MemoryFs(nodes, order === undefined ? {} : { order }),
  );
}

describe("expansion execution fixtures (IMPL §1.8)", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s", async (_name, fixture) => {
    const round = await execute(fixture);
    const byId = new Map(round.items.map((item) => [item.id, item]));
    const recorded = expansionRoundFields(round).requests.map((r) => {
      if (r.outcome === "rejected") return { index: r.index, outcome: r.outcome, rule: r.rule };
      return {
        index: r.index,
        outcome: r.outcome,
        ...(r.kind === "search" ? { matches: r.matches, capped: r.capped } : {}),
        items: r.items.map((item) => ({
          id: item.id,
          path: "path" in item ? item.path : item.pathHash,
          includedLines: item.includedLines,
          excerpt: item.excerpt,
          totalLines: item.totalLines,
          outline: (byId.get(item.id)?.rendered.outline.length ?? 0) > 0,
          reason: byId.get(item.id)?.reason,
        })),
      };
    });
    const expected = fixture.expect.requests.map((r) => ({
      ...r,
      ...(r.items === undefined
        ? {}
        : {
            items: r.items.map((item) =>
              expect.objectContaining({ ...item, path: unplace(item.path) }),
            ),
          }),
    }));
    expect(recorded).toEqual(expected.map((r) => expect.objectContaining(r)));
    expect(recorded).toHaveLength(fixture.expect.requests.length);
    const status = renderExpansionStatus(round).split("\n").slice(1, -2);
    expect(status).toEqual(fixture.expect.status);
    // Nothing the round records or shows the model for its outcome holds the example key.
    expect(JSON.stringify(expansionRoundFields(round))).not.toContain(EXAMPLE_KEY);
    expect(renderExpansionStatus(round)).not.toContain(EXAMPLE_KEY);
    for (const text of fixture.expect.recordExcludes ?? []) {
      expect(JSON.stringify(expansionRoundFields(round))).not.toContain(unplace(text));
      expect(renderExpansionStatus(round)).not.toContain(unplace(text));
    }
    for (const text of fixture.expect.itemContentExcludes ?? [])
      for (const item of round.items) {
        const content = item.rendered.text.split("CONTENT\n")[1]?.split(`<<<END ${item.id}>>>`)[0];
        expect(content).not.toContain(unplace(text));
      }
    // The same round under another directory order.
    const shuffled = await execute(fixture, seededShuffle(11));
    expect(expansionRoundFields(shuffled)).toEqual(expansionRoundFields(round));
  });
});

describe("every execution rule has a rejecting fixture and an accepted near miss (IMPL §1.8)", () => {
  const rules = ["EXP-007", "EXP-008", "EXP-009", "EXP-010", "secret-scan"];
  const rejects = (fixture: Case, rule: string) =>
    fixture.expect.requests.some((r) => r.outcome === "rejected" && r.rule?.startsWith(rule));
  it.each(rules)("%s", (rule) => {
    const rejecting = cases.filter(([, f]) => rejects(f, rule)).map(([name]) => name);
    const nearMisses = cases.filter(
      ([, f]) =>
        f.nearMissOf !== undefined &&
        rejecting.includes(f.nearMissOf) &&
        // Nothing is rejected by the rule under test, and something runs.
        !rejects(f, rule) &&
        f.expect.requests.some((r) => r.outcome === "executed"),
    );
    expect(rejecting.length, "fixtures that reject the rule").toBeGreaterThanOrEqual(2);
    expect(nearMisses, "a near miss of one of those fixtures").not.toEqual([]);
  });
});
