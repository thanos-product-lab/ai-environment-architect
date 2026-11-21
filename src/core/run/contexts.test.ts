import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
} from "../../../test/support/memory-fs.js";
import { newLog } from "../../../test/support/session.js";
import {
  type ContextSelectionSettings,
  type ReadyContext,
  selectContext,
} from "../context/select.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../context/tiers.js";
import { DEFAULT_TOKEN_SETTINGS } from "../context/token-settings.js";
import { callAliasTable } from "../requests/build.js";
import { numberRecords } from "../requests/records.js";
import { recordKnownFacts } from "../session/analysis.js";
import { recordSnapshot } from "../session/snapshot.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { createAliasTable } from "../validation/aliases.js";
import { validateAnalyse } from "../validation/analyse.js";
import { validateAnalyseExpansion } from "../validation/analyse-expansion.js";
import {
  analyseExpansionValidationContext,
  analyseValidationContext,
  citableItems,
  contextItems,
  questionValidationContext,
  recommendValidationContext,
  sentFiles,
} from "./contexts.js";

// Validation contexts built from what a call sent and from the records (IMPL §3.2.2, §3.3).

const SETTINGS: ContextSelectionSettings = {
  snapshot: DEFAULT_SNAPSHOT_SETTINGS,
  context: DEFAULT_CONTEXT_SETTINGS,
  tokens: DEFAULT_TOKEN_SETTINGS,
};
const GUIDE = "# Rules\n\n- Run the tests before pushing.\n";
const NODES: Record<string, MemoryNode> = {
  "CLAUDE.md": GUIDE,
  "package.json": '{\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
  "src/a.ts": "export const a = 1;\n",
};

async function ready(nodes = NODES): Promise<ReadyContext> {
  const fs = new MemoryFs(nodes);
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    SETTINGS.snapshot,
  );
  const context = await selectContext(snapshot, SETTINGS, fs);
  if (context.state !== "ready") throw new Error(context.state);
  return context;
}

const EMPTY_ANALYSE = {
  findings: [],
  gaps: [],
  absenceClaims: [],
  conflicts: [],
  expansionRequests: [],
  contentNotices: [],
};

describe("citable items (IMPL §3.2.2)", () => {
  it("holds each item's sent lines and the file's current hash", async () => {
    const context = await ready();
    const citable = await citableItems(
      contextItems(context),
      context.membership,
      new MemoryFs(NODES),
    );
    const guide = context.items.find((item) => item.path === "CLAUDE.md");
    const item = citable.get(guide?.id as string);
    expect(item).toMatchObject({
      path: "CLAUDE.md",
      snapshotHash: guide?.hash,
      currentHash: guide?.hash,
      basis: "existing_guidance",
      totalLines: 3,
      sent: [{ first: 1, lines: ["# Rules", "", "- Run the tests before pushing."] }],
    });
  });

  it("gives a changed file its new hash and no sent lines, and an unreadable one no hash", async () => {
    const context = await ready();
    const { "src/a.ts": _, ...withoutA } = NODES;
    const changed = new MemoryFs({ ...withoutA, "CLAUDE.md": "# Changed\n" });
    const citable = await citableItems(contextItems(context), context.membership, changed);
    const guide = citable.get(context.items.find((i) => i.path === "CLAUDE.md")?.id as string);
    expect(guide?.currentHash).not.toBe(guide?.snapshotHash);
    expect(guide?.sent).toEqual([]);
    const a = context.items.find((i) => i.path === "src/a.ts");
    if (a !== undefined) expect(citable.get(a.id)?.currentHash).toBeUndefined();
  });
});

describe("coverage (IMPL §1.11)", () => {
  it("counts the lines an item sent, whatever the file holds now", async () => {
    const context = await ready();
    const guide = contextItems(context).find((item) => item.path === "CLAUDE.md");
    expect(sentFiles(guide === undefined ? [] : [guide])).toEqual([
      { path: "CLAUDE.md", totalLines: 3, sent: [{ first: 1, lines: ["", "", ""] }] },
    ]);
  });
});

describe("call 1's context (IMPL §3.3.2)", () => {
  it("accepts a citation of a sent line and rejects one of a line that wasn't sent", async () => {
    const context = await ready();
    const facts = context.knownFacts.filter((f) => f.alias !== null);
    const aliases = createAliasTable("analyse", {
      items: context.items.map((item) => item.id),
      findings: facts.map((_, i) => `fndr_${String(i + 1).padStart(4, "0")}`),
      blocks: [],
    });
    const citable = await citableItems(
      contextItems(context),
      context.membership,
      new MemoryFs(NODES),
    );
    const validationContext = analyseValidationContext(context, aliases, citable, 5, (alias) =>
      (facts.find((f) => f.alias === alias)?.fact.evidence ?? []).map((e) => e.path),
    );
    const guide = context.items.find((item) => item.path === "CLAUDE.md")?.id as string;
    const finding = (key: string, lines: string) => ({
      key,
      statement: "The rules ask for the tests to run before pushing.",
      mode: "descriptive",
      scope: { kind: "repository" },
      citations: [{ item: guide, lines, quote: "Run the tests before pushing." }],
    });
    const validation = validateAnalyse(
      JSON.stringify({ ...EMPTY_ANALYSE, findings: [finding("f1", "3-3"), finding("f2", "9-9")] }),
      validationContext,
    );
    expect(validation.result.status).toBe("validated");
    if (validation.result.status !== "validated") return;
    expect(validation.result.accepted.findings.map((f) => f.key)).toEqual(["f1"]);
    expect(validation.result.events.map((e) => e.rule)).toContain("CIT-003");
  });
});

describe("records-based contexts (IMPL §3.3.3–§3.3.5)", () => {
  async function session() {
    const context = await ready();
    const log = newLog();
    const { record } = recordSnapshot(log, context.parts.snapshot);
    const sentFacts = context.knownFacts.filter((f) => f.alias !== null).map((f) => f.fact);
    recordKnownFacts(log, record.id, sentFacts, [
      { gapType: "other", statement: "No lint command is declared.", relatedPaths: [] },
    ]);
    const factIds = log.records.flatMap((r) =>
      r.type === "finding" && r.kind === "claim" && "findingId" in r ? [r.findingId] : [],
    );
    return { context, log, snapshotId: record.id, factIds };
  }

  it("gives call 2 exactly the table's F and C records, so validation runs", async () => {
    const { context, log, factIds } = await session();
    const numbered = numberRecords(log.records, {
      call: "analyse_expansion",
      knownFactsSent: factIds,
    });
    const aliases = callAliasTable(
      "analyse_expansion",
      numbered,
      { records: log.records, destination: new TextEncoder().encode(GUIDE) },
      context.items.map((item) => item.id),
    );
    const validationContext = analyseExpansionValidationContext(
      context.parts.snapshot,
      aliases,
      new Map(),
      contextItems(context),
      numbered,
      log.records,
    );
    expect(validationContext.callOne.findings.map((f) => f.alias)).toEqual(
      aliases.entries.filter((e) => e.kind === "F").map((e) => e.alias),
    );
    expect(validationContext.callOne.findings.at(-1)).toMatchObject({
      kind: "gap",
      producedBy: "deterministic",
      gapType: "other",
    });
    const empty = {
      findings: [],
      gaps: [],
      absenceClaims: [],
      conflicts: [],
      revisions: [],
      contentNotices: [],
    };
    expect(() => validateAnalyseExpansion(JSON.stringify(empty), validationContext)).not.toThrow();
  });

  it("describes each finding to calls 3 and 4 by kind, basis, gap type, evidence and command", async () => {
    const { context, log, factIds } = await session();
    const destination = new TextEncoder().encode(GUIDE);
    const questions = numberRecords(log.records, {
      call: "generate_questions",
      knownFactsSent: factIds,
    });
    const q = questionValidationContext(
      context.parts.snapshot,
      callAliasTable("generate_questions", questions, { records: log.records, destination }),
      questions,
      5,
    );
    const gapAlias = questions.findings.find((f) => f.record.kind === "gap")?.alias as string;
    expect(q.questions.findings.get(gapAlias)).toEqual({
      kind: "gap",
      basis: [],
      gapType: "other",
    });
    expect(q.questions.budget).toBe(5);

    const recommend = numberRecords(log.records, { call: "recommend", knownFactsSent: factIds });
    const r = recommendValidationContext(
      context.parts.snapshot,
      callAliasTable("recommend", recommend, { records: log.records, destination }),
      recommend,
      log.records,
      destination,
    );
    const command = [...r.input.findings.values()].find((f) => f.command !== undefined);
    expect(command).toMatchObject({
      kind: "claim",
      mode: "descriptive",
      current: true,
      command: { file: "package.json", name: "test" },
    });
    expect(command?.evidence[0]).toMatchObject({ kind: "lines", path: "package.json" });
    expect(r.destination.state).toBe("present");
  });
});
