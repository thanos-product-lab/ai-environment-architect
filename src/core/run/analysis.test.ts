import { describe, expect, it } from "vitest";
import { TEST_PROMPT_VERSION } from "../../../test/support/prompts.js";
import { type Harness, harness } from "../../../test/support/run-harness.js";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import { AGENT_CONFIG_TOKEN_LIMIT, DEFAULT_CONTEXT_SETTINGS } from "../context/tiers.js";
import type { RecordOf } from "../session/records.js";
import { recordInspection, runAnalyse, runExpansionStep } from "./analysis.js";

// Running calls 1 and 2 through the core API with recorded responses (IMPL §1.2, §1.8, §1.10).

const join = (...parts: string[]) => parts.join("");
const AWS_KEY = join("AKIA", "IOSFODNN7EXAMPLE");

const NODES = {
  "CLAUDE.md": "# Rules\n\n- Run the tests before pushing.\n",
  "package.json": '{\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
  "src/a.ts": "export const a = 1;\n",
  "notes/extra.txt": "Deploys go through the release script.\n",
};

const EMPTY_ONE = {
  findings: [],
  gaps: [],
  absenceClaims: [],
  conflicts: [],
  expansionRequests: [],
  contentNotices: [],
};
const EMPTY_TWO = {
  findings: [],
  gaps: [],
  absenceClaims: [],
  conflicts: [],
  revisions: [],
  contentNotices: [],
};

function itemId(h: Harness, path: string): string {
  const item = h.context.items.find((i) => i.path === path);
  if (item === undefined) throw new Error(`${path} wasn't sent`);
  return item.id;
}

const guideFinding = (item: string) => ({
  key: "f1",
  statement: "The rules ask for the tests to run before pushing.",
  mode: "descriptive",
  scope: { kind: "repository" },
  citations: [{ item, lines: "3-3", quote: "Run the tests before pushing." }],
});

const read = (path: string, lines?: string) => ({
  kind: "read",
  entries: [lines === undefined ? { path } : { path, lines }],
  reason: "Read it.",
});

const callOne = (h: Harness, expansionRequests: unknown[] = []) =>
  JSON.stringify({
    ...EMPTY_ONE,
    findings: [guideFinding(itemId(h, "CLAUDE.md"))],
    expansionRequests,
  });

const notesFinding = JSON.stringify({
  ...EMPTY_TWO,
  findings: [
    {
      key: "f1",
      statement: "Deploys go through the release script.",
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [{ item: "E-1", lines: "1-1", quote: "Deploys go through the release script." }],
    },
  ],
});

/** Builds the harness first, so a script can name the items it sends. */
async function run(
  nodes: Record<string, string>,
  script: (h: Harness) => string[],
  options: Parameters<typeof harness>[2] = {},
) {
  const answers: string[] = [];
  const h = await harness(nodes, answers, options);
  answers.push(...script(h));
  const inspection = await recordInspection(h.session, h.context);
  const one = await runAnalyse(h.session, h.deps, {
    context: h.context,
    inspection,
    destination: h.destination,
  });
  return { h, inspection, one };
}

const ofType = <T extends RecordOf<"model_call">["type"] | string>(h: Harness, type: T) =>
  h.session.records.filter((r) => r.type === type);

describe("inspection (IMPL §3.2.5)", () => {
  it("records the snapshot, every known fact and the context's gaps before call 1", async () => {
    const h = await harness(NODES, []);
    const inspection = await recordInspection(h.session, h.context);
    expect(ofType(h, "snapshot")).toHaveLength(1);
    const facts = h.session.records.filter(
      (r) => r.type === "finding" && r.kind === "claim" && r.producedBy === "deterministic",
    );
    expect(facts).toHaveLength(h.context.knownFacts.length);
    expect(inspection.knownFactsSent).toHaveLength(
      h.context.knownFacts.filter((f) => f.alias !== null).length,
    );
  });
});

describe("call 1 (IMPL §3.3.2)", () => {
  it("sends the placeholder prompt with the context and records the call and its findings", async () => {
    const { h, one } = await run(NODES, (h) => [callOne(h)]);
    expect(one.kind).toBe("completed");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.system).toContain("Placeholder system prompt for the analyse call.");
    expect(h.sent[0]?.user).toBe(h.context.context.text);
    const call = ofType(h, "model_call").at(-1) as RecordOf<"model_call">;
    expect(call).toMatchObject({
      purpose: "analyse",
      state: "completed",
      promptVersion: TEST_PROMPT_VERSION,
      schemaVersion: CALL_SCHEMAS.analyse.version,
      schemaHash: CALL_SCHEMAS.analyse.schemaHash,
    });
    expect(call.inputManifest.tokenCheck).not.toBeNull();
    expect(call.aliases.entries.filter((e) => e.kind === "F")).toHaveLength(
      h.context.knownFacts.filter((f) => f.alias !== null).length,
    );
    const modelFindings = h.session.records.filter(
      (r) => r.type === "finding" && r.producedBy === call.modelCallId,
    );
    expect(modelFindings).toHaveLength(1);
  });
});

describe("the expansion round and call 2 (IMPL §1.8, §3.3.3)", () => {
  it("records the round, then sends call 2 with the call-1 results, the status and the E items", async () => {
    const { h, inspection, one } = await run(NODES, (h) => [
      callOne(h, [read("notes/extra.txt")]),
      notesFinding,
    ]);
    if (one.kind !== "completed") throw new Error(one.kind);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("completed");
    const round = ofType(h, "expansion_round")[0];
    expect(round).toBeDefined();
    const user = h.sent[1]?.user ?? "";
    expect(user.startsWith(h.context.context.text.slice(0, 30))).toBe(true);
    expect(user).toContain("<<<CALL 1 RESULTS>>>");
    expect(user.indexOf("<<<CALL 1 RESULTS>>>")).toBeLessThan(user.indexOf("<<<EXPANSION>>>"));
    expect(user.indexOf("<<<EXPANSION>>>")).toBeLessThan(user.indexOf("id=E-1"));
    const call = ofType(h, "model_call").at(-1) as RecordOf<"model_call">;
    expect(call.purpose).toBe("analyse_expansion");
    expect(call.inputManifest.expansion).toEqual({ expansionRoundId: round?.id });
    expect(call.inputManifest.items.map((i) => i.id)).not.toContain("E-1");
    // The round comes after call 1's records and before call 2's call.
    const seqOf = (id: string | undefined) => h.session.records.find((r) => r.id === id)?.seq ?? 0;
    expect(seqOf(round?.id)).toBeLessThan(seqOf(call.id));
    const evidence = h.session.records.filter(
      (r) => r.type === "evidence" && "path" in r && r.path === "notes/extra.txt",
    );
    expect(evidence).toHaveLength(1);
  });

  it("records a round that returned no item, and sends no call 2 and skips nothing", async () => {
    const { h, inspection, one } = await run(NODES, (h) => [callOne(h, [read("missing.txt")])]);
    if (one.kind !== "completed") throw new Error(one.kind);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("no_items");
    expect(ofType(h, "expansion_round")).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.session.records.some((r) => "reason" in r && r.reason === "stage_skipped")).toBe(
      false,
    );
  });

  it("records the round and stage_skipped when call 2 doesn't fit, and sends nothing", async () => {
    const { h, inspection, one } = await run(
      NODES,
      (h) => [callOne(h, [read("notes/extra.txt")])],
      { count: (request) => (request.user.includes("<<<EXPANSION>>>") ? 10_000_000 : 1_000) },
    );
    if (one.kind !== "completed") throw new Error(one.kind);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("skipped");
    expect(ofType(h, "expansion_round")).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.session.records.at(-1)).toMatchObject({
      type: "session_state",
      reason: "stage_skipped",
      unsentPurpose: "analyse_expansion",
    });
  });

  it("leaves a file the round blocked out of call 2, marked [S] and excluded with its rule", async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the notes.`).join("\n");
    const readme = `# App\n\nA small app.\n\n## Keys\n\n${filler}\naws = "${AWS_KEY}"\n`;
    const secretLine = readme.split("\n").findIndex((line) => line.includes(AWS_KEY)) + 1;
    const nodes = { ...NODES, "README.md": readme };
    const { h, inspection, one } = await run(
      nodes,
      (h) => [
        callOne(h, [read("README.md", `${secretLine}-${secretLine}`), read("notes/extra.txt")]),
        notesFinding,
      ],
      { context: { perFileCaps: { ...DEFAULT_CONTEXT_SETTINGS.perFileCaps, tier2: 400 } } },
    );
    expect(h.context.items.find((i) => i.path === "README.md")?.rendered.excerpt).toBe(true);
    if (one.kind !== "completed") throw new Error(one.kind);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("completed");
    const user = h.sent[1]?.user ?? "";
    expect(user).not.toContain('path="README.md"');
    expect(user).toContain("[S] README.md");
    expect(user).not.toContain(AWS_KEY);
    const call = ofType(h, "model_call").at(-1) as RecordOf<"model_call">;
    expect(call.inputManifest.excluded).toContainEqual({
      path: "README.md",
      reason: "secret-scan:aws-access-key-id",
    });
  });
});

describe("the call runners' edges (IMPL §1.7, §1.8, §1.10, §3.7)", () => {
  it("refuses a test-only prompt set unless a test harness allows it", async () => {
    const h = await harness(NODES, []);
    const inspection = await recordInspection(h.session, h.context);
    const { allowTestPrompts: _, ...live } = h.deps;
    await expect(
      runAnalyse(h.session, live, { context: h.context, inspection, destination: h.destination }),
    ).rejects.toThrow(/test-only prompt set/);
    expect(h.sent).toHaveLength(0);
  });

  it("runs no round when call 1 asked for nothing", async () => {
    const { h, inspection, one } = await run(NODES, (h) => [callOne(h)]);
    if (one.kind !== "completed") throw new Error(one.kind);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("no_round");
    expect(ofType(h, "expansion_round")).toHaveLength(0);
  });

  it("lists every request in response order, each rejected one with its rule", async () => {
    const requests = [
      read("missing.txt"),
      read("notes/extra.txt"),
      ...Array.from({ length: 3 }, () => read("missing.txt")),
    ];
    const { h, inspection, one } = await run(NODES, (h) => [callOne(h, requests), notesFinding], {
      maxExpansionRequests: 4,
    });
    if (one.kind !== "completed") throw new Error(one.kind);
    await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    const round = ofType(h, "expansion_round")[0] as RecordOf<"expansion_round">;
    expect(round.requests.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(round.requests[0]).toMatchObject({ outcome: "rejected", rule: "EXP-001" });
    expect(round.requests[1]).toMatchObject({ outcome: "executed" });
    expect(round.requests[4]).toMatchObject({ outcome: "rejected", rule: "LIMIT-002" });
  });

  it("records call 1's token-check gap before the call is sent", async () => {
    const nodes = { ...NODES, ".claude/extra.md": "# Extra\n\nMore rules.\n" };
    const { h, one } = await run(nodes, (h) => [callOne(h)], {
      count: (request) => (request.user.includes('path=".claude/extra.md"') ? 10_000_000 : 1_000),
    });
    expect(one.kind).toBe("completed");
    const gap = h.session.records.find(
      (r) => r.type === "finding" && "statement" in r && r.statement === AGENT_CONFIG_TOKEN_LIMIT,
    );
    const call = ofType(h, "model_call")[0];
    expect(gap).toBeDefined();
    expect(gap?.seq ?? 0).toBeLessThan(call?.seq ?? 0);
    expect(h.sent[0]?.user).not.toContain('.claude/extra.md" hash');
  });

  it("withholds a call-1 finding whose statement matches the scan, so call 2 gives it no alias", async () => {
    const key = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const { h, inspection, one } = await run(NODES, (h) => [
      JSON.stringify({
        ...EMPTY_ONE,
        findings: [
          guideFinding(itemId(h, "CLAUDE.md")),
          {
            ...guideFinding(itemId(h, "CLAUDE.md")),
            key: "f2",
            statement: `The key ${key} appears.`,
          },
        ],
        expansionRequests: [read("notes/extra.txt")],
      }),
      notesFinding,
    ]);
    if (one.kind !== "completed") throw new Error(one.kind);
    await runExpansionStep(h.session, h.deps, {
      callOne: one,
      inspection,
      destination: h.destination,
    });
    expect(ofType(h, "secret_withheld")).toHaveLength(1);
    expect(h.sent[1]?.user).not.toContain(key);
    const call = ofType(h, "model_call").at(-1) as RecordOf<"model_call">;
    const withheld = ofType(h, "secret_withheld")[0] as RecordOf<"secret_withheld">;
    const named = call.aliases.entries.some(
      (e) =>
        e.target.kind === "record" &&
        h.session.records.find(
          (r) =>
            r.id === (e.target as { recordId: string }).recordId &&
            "findingId" in r &&
            r.findingId === withheld.itemId,
        ) !== undefined,
    );
    expect(named).toBe(false);
  });
});
