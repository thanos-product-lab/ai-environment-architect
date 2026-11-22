import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
} from "../../../test/support/memory-fs.js";
import { newLog } from "../../../test/support/session.js";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import { pathHash } from "../context/secrets.js";
import type { TokenCheckRecord } from "../context/select.js";
import {
  type ContextSelectionSettings,
  type ReadyContext,
  selectContext,
  withBlockedFiles,
} from "../context/select.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../context/tiers.js";
import { DEFAULT_TOKEN_SETTINGS } from "../context/token-settings.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import type { SessionLog } from "../session/log.js";
import { recordSnapshot } from "../session/snapshot.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import {
  type CallModel,
  type CallPrompt,
  callAliasTable,
  callLimits,
  expansionManifest,
  expansionUser,
  modelRequest,
  type RecordCall,
  recordCallPlan,
} from "./build.js";
import { numberRecords, withholdForCall } from "./records.js";

// Building each call's request (IMPL §1.10, §1.13, §3.2.6, §3.7), with no model involved.

const SETTINGS: ContextSelectionSettings = {
  snapshot: DEFAULT_SNAPSHOT_SETTINGS,
  context: DEFAULT_CONTEXT_SETTINGS,
  tokens: DEFAULT_TOKEN_SETTINGS,
};
const PROMPT: CallPrompt = { version: "0.0.0-test", hash: sha256(new Uint8Array()), text: "Test." };
const MODEL: CallModel = { model: "claude-test", effort: "medium", reservedOutputTokens: 16_000 };
const GUIDE = "# Rules\n\n- Run the tests.\n";
const NODES: Record<string, MemoryNode> = {
  "CLAUDE.md": GUIDE,
  "README.md": "# App\n\nA small app.\n",
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 2;\n",
};
const SECRET = "AKIAIOSFODNN7EXAMPLE";

interface Session {
  readonly log: SessionLog;
  readonly context: ReadyContext;
  readonly snapshotId: string;
  readonly destination: Uint8Array;
}

async function session(): Promise<Session> {
  const fs = new MemoryFs(NODES);
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    SETTINGS.snapshot,
  );
  const context = await selectContext(snapshot, SETTINGS, fs);
  if (context.state !== "ready") throw new Error(context.state);
  const log = newLog();
  const { record } = recordSnapshot(log, snapshot);
  return { log, context, snapshotId: record.id, destination: new TextEncoder().encode(GUIDE) };
}

function claim(s: Session, path: string, excerpt: string, also: string[] = []) {
  const ev = s.log.append({
    type: "evidence",
    snapshotId: s.snapshotId,
    kind: "lines",
    path,
    fileHash: sha256(new TextEncoder().encode(path)),
    lineStart: 1,
    lineEnd: 1,
    excerpt,
    basis: "code_observation",
  });
  const finding = s.log.start({
    type: "finding",
    snapshotId: s.snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement: `Seen in ${path}.`,
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["code_observation"],
    evidenceIds: [ev.id, ...also],
  } as never) as { findingId: string };
  return { evidenceId: ev.id, findingId: finding.findingId };
}

function plan(s: Session, call: RecordCall) {
  const numbering = { call, knownFactsSent: [] };
  const { withheldExcerpts, excerptRules } = withholdForCall(s.log, numbering);
  const numbered = numberRecords(s.log.records, numbering);
  return recordCallPlan(
    {
      call,
      numbered,
      render: { records: s.log.records, destination: s.destination, withheldExcerpts },
      excerptRules,
      base: s.context,
      limits: callLimits(call, 5),
      knownFacts: { sentInCallOne: 0, leftOutOfCallOne: 0 },
    },
    PROMPT,
    MODEL,
  );
}

const frames = (text: string) =>
  [...text.matchAll(/^<<<(?!END)([A-Z0-9 ]+?)(?:>>>| )/gm)].map((m) => m[1]);

const TOKEN_CHECK: TokenCheckRecord = {
  model: "claude-test",
  method: "estimate",
  inputTokens: 100,
  reservedOutputTokens: 16_000,
  contextLimit: 200_000,
  reductions: [],
};

describe("the request (IMPL §3.7, §1.2)", () => {
  it("holds the model, limit, effort, prompt, content and the call's committed schema, and nothing about caching", () => {
    const request = modelRequest("recommend", PROMPT, MODEL, "content");
    expect(Object.keys(request).sort()).toEqual(
      ["effort", "maxTokens", "model", "schema", "system", "user"].sort(),
    );
    expect(request).toMatchObject({
      model: "claude-test",
      maxTokens: 16_000,
      effort: "medium",
      system: "Test.",
      user: "content",
    });
    expect(request.schema).toBe(CALL_SCHEMAS.recommend.apiSchema);
    expect(JSON.stringify(request)).not.toMatch(/cache/i);
  });
});

describe("the limits each call sends (IMPL §3.2.6)", () => {
  it("sends the question budget first in call 3, then each call's collection limits in schema order", () => {
    expect(callLimits("generate_questions", 5)).toEqual([
      ["questionBudget", 5],
      ["questions", 20],
    ]);
    expect(callLimits("recommend", 5)).toEqual([
      ["recommendations", 15],
      ["heldBack", 10],
    ]);
    expect(callLimits("regenerate_recommendations", 5)).toEqual([
      ["actions", 30],
      ["additions", 5],
      ["heldBack", 10],
    ]);
  });
});

describe("calls 3–5 (IMPL §3.2.6, §1.10, §1.13)", () => {
  it("sends each call's sections in order, the stable ones first", async () => {
    const s = await session();
    claim(s, "src/a.ts", "export const a = 1;");
    expect(frames(plan(s, "generate_questions").plan.render(0).user)).toEqual([
      "DESTINATION",
      "TREE",
      "LIMITS",
      "FINDINGS",
      "CONFLICTS",
    ]);
    expect(frames(plan(s, "recommend").plan.render(0).user)).toEqual([
      "DESTINATION",
      "TREE",
      "LIMITS",
      "FINDINGS",
      "CONFLICTS",
      "QUESTIONS",
      "DECISIONS",
    ]);
    expect(frames(plan(s, "regenerate_recommendations").plan.render(0).user)).toEqual([
      "DESTINATION",
      "TREE",
      "LIMITS",
      "FINDINGS",
      "CONFLICTS",
      "QUESTIONS",
      "DECISIONS",
      "RECOMMENDATIONS",
      "CHANGES",
    ]);
  });

  it("sends call 1's tree and the destination with its blocks", async () => {
    const s = await session();
    const user = plan(s, "generate_questions").plan.render(0).user;
    expect(user).toContain(s.context.tree.text);
    expect(user).toContain('<<<DESTINATION path="CLAUDE.md" totalLines=3>>>\nBLOCKS\n');
    expect(user).toContain("<<<LIMITS>>>\nquestionBudget: 5\nquestions: 20\n<<<END LIMITS>>>\n");
  });

  it("removes excerpts last rendered first, then the tree depth one level at a time", async () => {
    const s = await session();
    const a = claim(s, "src/a.ts", "export const a = 1;");
    const b = claim(s, "src/b.ts", "export const b = 2;");
    const { plan: p } = plan(s, "generate_questions");
    expect(p.units.slice(0, 2).map((u) => ("id" in u ? u.id : u.step))).toEqual([
      b.evidenceId,
      a.evidenceId,
    ]);
    expect(p.units.slice(2).map((u) => (u.step === "tree_depth" ? u.treeDepth : -1))).toEqual(
      Array.from({ length: s.context.tree.depth }, (_, i) => s.context.tree.depth - 1 - i),
    );
    expect(p.render(1).user).toContain("evidence: src/b.ts:1-1 (excerpt not sent)");
    expect(p.render(1).user).toContain("       | export const a = 1;");
    const lowest = p.render(p.units.length).user;
    expect(lowest).toContain("<<<TREE depth=0 ");
    expect(lowest).toContain("evidence: src/a.ts:1-1 (excerpt not sent)");
  });

  it("keeps the excerpts of a finding an open question references", async () => {
    const s = await session();
    const a = claim(s, "src/a.ts", "export const a = 1;");
    const b = claim(s, "src/b.ts", "export const b = 2;");
    s.log.start({
      type: "question",
      producedBy: "call_0002",
      prompt: "Which?",
      reason: "Unclear.",
      findingIds: [a.findingId],
      conflictIds: [],
      gapIds: [],
      options: [],
      scope: { kind: "repository" },
      status: "open",
    } as never);
    const ids = plan(s, "recommend").plan.units.flatMap((u) => ("id" in u ? [u.id] : []));
    expect(ids).toEqual([b.evidenceId]);
  });

  it("records the calls 3–5 manifest: tier 4 alone, no items, removed and withheld excerpts in skipped", async () => {
    const s = await session();
    claim(s, "src/a.ts", "export const a = 1;");
    // Its other excerpt keeps it sent, with this one `(excerpt withheld)`.
    const clean = claim(s, "src/d.ts", "export const d = 4;");
    const evidence = s.log.records.find(
      (r) => r.type === "finding" && "findingId" in r && r.findingId === clean.findingId,
    );
    claim(s, "src/b.ts", `const key = "${SECRET}";`, [
      ...((evidence as { evidenceIds?: string[] } | undefined)?.evidenceIds ?? []),
    ]);
    claim(s, "src/c.ts", "export const c = 3;");
    const built = plan(s, "generate_questions");
    const manifest = built.manifest(1, TOKEN_CHECK);
    const user = built.plan.render(1).user;
    expect(manifest.items).toEqual([]);
    expect(manifest.tiers).toEqual([
      expect.objectContaining({
        tier: 4,
        usedBytes: s.context.tree.bytes,
        treeDepth: s.context.tree.depth,
      }),
    ]);
    expect(manifest.skipped).toEqual([
      { path: "src/c.ts", reason: "token-check:excerpt" },
      { path: "src/b.ts", reason: "secret-scan:aws-access-key-id" },
    ]);
    expect(manifest.contextHash).toBe(sha256(new TextEncoder().encode(user)));
    expect(manifest.budget.usedBytes).toBe(Buffer.byteLength(user, "utf8"));
    expect(manifest.tokenCheck).toBe(TOKEN_CHECK);
    expect(manifest.expansion).toBeNull();
    expect(manifest.excluded).toEqual(s.context.manifest.excluded);
    expect(user).not.toContain(SECRET);
  });

  it("records a reduced tree depth in tier 4", async () => {
    const s = await session();
    claim(s, "src/a.ts", "export const a = 1;");
    const built = plan(s, "generate_questions");
    const all = built.plan.units.length;
    const manifest = built.manifest(all, TOKEN_CHECK);
    expect(manifest.tiers).toEqual([expect.objectContaining({ tier: 4, treeDepth: 0 })]);
    const user = built.plan.render(all).user;
    const tree = user.slice(user.indexOf("<<<TREE"), user.indexOf("<<<END TREE>>>\n") + 15);
    expect(manifest.tiers[0]).toMatchObject({ usedBytes: Buffer.byteLength(tree, "utf8") });
  });

  it("marks files blocked since [S] and lists them in excluded", async () => {
    const s = await session();
    const base = withBlockedFiles(s.context, [{ path: "src/b.ts", ruleId: "generic-assignment" }], {
      text: s.context.parts.factsText,
      bytes: s.context.parts.factsBytes,
      sent: s.context.parts.factsSent,
      leftOut: s.context.parts.factsLeftOut,
    });
    const numbering = { call: "generate_questions" as const, knownFactsSent: [] };
    const built = recordCallPlan(
      {
        call: "generate_questions",
        numbered: numberRecords(s.log.records, numbering),
        render: { records: s.log.records, destination: s.destination, withheldExcerpts: new Set() },
        excerptRules: new Map(),
        base,
        limits: [],
        knownFacts: { sentInCallOne: 0, leftOutOfCallOne: 0 },
      },
      PROMPT,
      MODEL,
    );
    expect(built.manifest(0, TOKEN_CHECK).excluded).toContainEqual({
      path: "src/b.ts",
      reason: "secret-scan:generic-assignment",
    });
    expect(built.plan.render(0).user).toContain("[S] b.ts");
  });

  it("records a withheld excerpt whose path matches the scan by its hash", async () => {
    const s = await session();
    const path = `config/${SECRET}.ts`;
    const secret = s.log.append({
      type: "evidence",
      snapshotId: s.snapshotId,
      kind: "lines",
      path,
      fileHash: sha256(new TextEncoder().encode(path)),
      lineStart: 1,
      lineEnd: 1,
      excerpt: `const key = "${SECRET}";`,
      basis: "code_observation",
    });
    // Its statement is clean, and its other excerpt keeps it sent.
    claim(s, "src/a.ts", "export const a = 1;", [secret.id]);
    const manifest = plan(s, "generate_questions").manifest(0, TOKEN_CHECK);
    expect(manifest.skipped).toEqual([
      { pathHash: pathHash(path), reason: "secret-scan:aws-access-key-id" },
    ]);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("keeps the excerpts of findings a current recommendation or an open question's conflict references", async () => {
    const s = await session();
    const a = claim(s, "src/a.ts", "export const a = 1;");
    const b = claim(s, "src/b.ts", "export const b = 2;");
    const c = claim(s, "src/c.ts", "export const c = 3;");
    const d = claim(s, "src/d.ts", "export const d = 4;");
    const blocks = parseGuidanceBlocks(s.destination).blocks;
    // A current recommendation that isn't sent in this call still protects its support.
    s.log.start({
      type: "recommendation_revision",
      kind: "fact",
      operation: "add",
      target: { kind: "after", blockId: blocks[0]?.blockId, blockHash: blocks[0]?.hash },
      content: "Text.",
      rationale: "Why.",
      support: [{ kind: "finding", findingId: a.findingId }],
      references: [],
      scope: { kind: "repository" },
      producedBy: "call_0003",
      status: "valid",
    } as never);
    const conflict = s.log.start({
      type: "conflict",
      snapshotId: s.snapshotId,
      producedBy: "call_0001",
      findingIds: [b.findingId, c.findingId],
      description: "They disagree.",
      status: "unresolved",
    } as never) as { conflictId: string };
    s.log.start({
      type: "question",
      producedBy: "call_0002",
      prompt: "Which?",
      reason: "Unclear.",
      findingIds: [],
      conflictIds: [conflict.conflictId],
      gapIds: [],
      options: [],
      scope: { kind: "repository" },
      status: "open",
    } as never);
    const ids = plan(s, "regenerate_recommendations").plan.units.flatMap((u) =>
      "id" in u ? [u.id] : [],
    );
    expect(ids).toEqual([d.evidenceId]);
  });

  it("counts the known facts sent and those left out of call 1 or withheld since", async () => {
    const s = await session();
    const numbering = { call: "generate_questions" as const, knownFactsSent: [] };
    const manifest = recordCallPlan(
      {
        call: "generate_questions",
        numbered: numberRecords(s.log.records, numbering),
        render: { records: s.log.records, destination: s.destination, withheldExcerpts: new Set() },
        excerptRules: new Map(),
        base: s.context,
        limits: [],
        knownFacts: { sentInCallOne: 3, leftOutOfCallOne: 1 },
      },
      PROMPT,
      MODEL,
    ).manifest(0, TOKEN_CHECK);
    // None of the three facts call 1 sent is current here, so all three count as withheld.
    expect(manifest.knownFacts).toEqual({
      capBytes: s.context.manifest.knownFacts.capBytes,
      usedBytes: 0,
      facts: 0,
      leftOut: 4,
    });
  });

  it("renders the same bytes for the same records", async () => {
    const build = async () => {
      const s = await session();
      claim(s, "src/a.ts", "export const a = 1;");
      return plan(s, "recommend").plan.render(0);
    };
    expect(await build()).toEqual(await build());
  });
});

describe("call 2 (IMPL §3.2.6, §1.13)", () => {
  it("sends the context, then the call-1 results, the status block and the E items", async () => {
    const s = await session();
    const user = expansionUser(s.context, {
      results: "<<<CALL 1 RESULTS>>>\n<<<END CALL 1 RESULTS>>>\n",
      status: "<<<EXPANSION>>>\n<<<END EXPANSION>>>\n",
      items: ["<<<ITEM id=E-1>>>\n", "<<<ITEM id=E-2>>>\n"],
    });
    expect(user).toBe(
      `${s.context.context.text}<<<CALL 1 RESULTS>>>\n<<<END CALL 1 RESULTS>>>\n<<<EXPANSION>>>\n<<<END EXPANSION>>>\n<<<ITEM id=E-1>>>\n<<<ITEM id=E-2>>>\n`,
    );
  });

  it("names the expansion round in the manifest and keeps E items out of its items", async () => {
    const s = await session();
    const manifest = expansionManifest(s.context, "exr_0001");
    expect(manifest.expansion).toEqual({ expansionRoundId: "exr_0001" });
    expect(manifest.items).toEqual(s.context.manifest.items);
  });
});

describe("alias tables (IMPL §3.2.1)", () => {
  it("lists items, the numbered records with an unused number kept, and the blocks", async () => {
    const s = await session();
    const a = claim(s, "src/a.ts", "export const a = 1;");
    const numbered = numberRecords(s.log.records, {
      call: "analyse_expansion",
      knownFactsSent: ["fnd_9999"],
    });
    const table = callAliasTable(
      "analyse_expansion",
      numbered,
      { records: s.log.records, destination: s.destination },
      ["T1-001", "E-1"],
    );
    expect(table.entries.map((e) => e.alias)).toEqual(["T1-001", "E-1", "F-2", "B-1", "B-2"]);
    expect(numbered.aliasOf(a.findingId)).toBe("F-2");
  });

  it("numbers B as the DESTINATION section's BLOCKS lines do", async () => {
    const s = await session();
    const table = callAliasTable(
      "generate_questions",
      numberRecords(s.log.records, { call: "generate_questions", knownFactsSent: [] }),
      { records: s.log.records, destination: s.destination },
    );
    const user = plan(s, "generate_questions").plan.render(0).user;
    const blockLines = user
      .slice(user.indexOf("BLOCKS\n") + 7, user.indexOf("CONTENT\n"))
      .trim()
      .split("\n")
      .map((line) => line.trim().split(" ")[1]);
    expect(table.entries.filter((e) => e.kind === "B").map((e) => e.alias)).toEqual(blockLines);
  });
});

describe("record spans for the complete-request scan (IMPL §1.7)", () => {
  it("maps each record to exactly the lines it rendered, after any reduction", async () => {
    const s = await session();
    claim(s, "src/a.ts", "export const a = 1;");
    claim(s, "src/b.ts", "export const b = 2;");
    const built = plan(s, "generate_questions");
    for (let removed = 0; removed <= built.plan.units.length; removed++) {
      const user = built.plan.render(removed).user;
      const spans = built.spans(removed);
      expect(spans.map((span) => span.target.kind)).toEqual(["item", "item"]);
      for (const span of spans) {
        const text = user.slice(span.start, span.end);
        expect(text).toMatch(/^F-\d+ {2}\[/);
        expect(text.endsWith("\n")).toBe(true);
      }
      // Spans are in rendering order and don't overlap.
      expect((spans[0]?.end ?? 0) <= (spans[1]?.start ?? 0)).toBe(true);
    }
  });
});
