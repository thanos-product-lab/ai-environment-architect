import { describe, expect, it } from "vitest";
import { newLog } from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import type { KnownFact } from "../facts/known-facts.js";
import { renderKnownFacts } from "../facts/render.js";
import { sha256 } from "../hash.js";
import { recordKnownFacts } from "../session/analysis.js";
import type { SessionLog } from "../session/log.js";
import {
  citedExcerpts,
  locateSpans,
  numberRecords,
  overlappedTargets,
  type RecordNumbering,
  renderCallOneResults,
  renderChanges,
  renderKnownFactsAgain,
  renderLimits,
  renderRecordSections,
  section,
  spannedCallOneResults,
  spannedRecordSections,
  withholdForCall,
  withholdMatch,
} from "./records.js";

// Rendering validated records for calls 2–5 (IMPL §3.2.6), with no model involved (§3.8).

const encode = (text: string) => new TextEncoder().encode(text);
const GUIDE = "# Guide\n\nUse pnpm.\n";

interface Session {
  readonly log: SessionLog;
  readonly snapshotId: string;
  readonly bytes: Uint8Array;
}

function session(text = GUIDE): Session {
  const log = newLog();
  const bytes = encode(text);
  const parsed = parseGuidanceBlocks(bytes);
  const snapshot = log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: [{ path: "CLAUDE.md", status: "read", size: bytes.length, hash: sha256(bytes) }],
    destination: {
      state: "present",
      contentRef: `content/${sha256(bytes).replace(":", "-")}`,
      hash: sha256(bytes),
      blocks: parsed.blocks as never,
      lineEndings: parsed.lineEndings,
      roundTrip: parsed.roundTrip,
    },
    readFailures: [],
    stability: { state: "stable" },
    git: { state: "unknown", reason: "not_inspected" },
    ignoreRules: { state: "applied" },
  } as never) as unknown as { id: string };
  return { log, snapshotId: snapshot.id, bytes };
}

function lines(s: Session, path: string, excerpt: string, start = 1) {
  return s.log.append({
    type: "evidence",
    snapshotId: s.snapshotId,
    kind: "lines",
    path,
    fileHash: sha256(encode(path)),
    lineStart: start,
    lineEnd: start + excerpt.split("\n").length - 1,
    excerpt,
    basis: path.endsWith(".md") ? "documentation" : "code_observation",
  });
}

function claim(
  s: Session,
  statement: string,
  evidenceIds: string[],
  extra: Record<string, unknown> = {},
) {
  return s.log.start({
    type: "finding",
    snapshotId: s.snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement,
    mode: "descriptive",
    scope: { kind: "repository" },
    basis: ["code_observation"],
    evidenceIds,
    ...extra,
  } as never) as { findingId: string; id: string };
}

/** A known fact: deterministic, with its detail (IMPL §3.2.5). */
function fact(s: Session, statement: string, evidenceIds: string[]) {
  return claim(s, statement, evidenceIds, {
    producedBy: "deterministic",
    fact: { type: "agent_configuration", path: "CLAUDE.md" },
  });
}

function gap(s: Session, statement: string, extra: Record<string, unknown> = {}) {
  return s.log.start({
    type: "finding",
    snapshotId: s.snapshotId,
    producedBy: "deterministic",
    status: "active",
    kind: "gap",
    statement,
    gapType: "no_command",
    relatedPaths: ["scripts/", "Makefile"],
    coverage: { state: "inspected" },
    evidenceIds: [],
    ...extra,
  } as never) as { findingId: string };
}

function conflict(s: Session, findingIds: string[], extra: Record<string, unknown> = {}) {
  return s.log.start({
    type: "conflict",
    snapshotId: s.snapshotId,
    producedBy: "call_0001",
    findingIds,
    description: "The guide and the code disagree.",
    status: "unresolved",
    ...extra,
  } as never) as { conflictId: string; id: string };
}

function question(s: Session, findingIds: string[], conflictIds: string[] = [], status = "open") {
  return s.log.start({
    type: "question",
    producedBy: "call_0002",
    prompt: "Which command runs the tests?",
    reason: "Unclear.",
    findingIds,
    conflictIds,
    gapIds: [],
    options: [{ label: "pnpm test" }],
    scope: { kind: "repository" },
    status,
  } as never) as { questionId: string; id: string };
}

function decision(s: Session, fields: Record<string, unknown>) {
  return s.log.append({
    type: "decision",
    statement: "Run the tests with `pnpm test`.",
    scope: { kind: "repository" },
    exceptions: [],
    origin: "answered_question",
    actor: "developer",
    decidedAt: "2026-11-01T10:20:00.000Z",
    ...fields,
  } as never) as { id: string };
}

const numbering = (
  call: RecordNumbering["call"],
  knownFactsSent: string[] = [],
  recommendations?: string[],
): RecordNumbering => ({
  call,
  knownFactsSent,
  ...(recommendations === undefined ? {} : { recommendations }),
});

function rendered(s: Session, n: RecordNumbering, options: Partial<RenderOptions> = {}) {
  const numbered = numberRecords(s.log.records, n);
  return renderRecordSections(numbered, {
    records: s.log.records,
    destination: s.bytes,
    withheldExcerpts: options.withheldExcerpts ?? new Set(),
    removedExcerpts: options.removedExcerpts ?? new Set(),
  });
}

interface RenderOptions {
  withheldExcerpts: ReadonlySet<string>;
  removedExcerpts: ReadonlySet<string>;
}

describe("record lines (IMPL §3.2.6)", () => {
  it("renders a known fact exactly as the known-facts section does, and a prescriptive claim with its mode", () => {
    const s = session();
    const known = fact(s, "`CLAUDE.md` is existing agent configuration.", [
      s.log.append({
        type: "evidence",
        snapshotId: s.snapshotId,
        kind: "entry",
        path: "CLAUDE.md",
        fileHash: sha256(encode("CLAUDE.md")),
        basis: "code_observation",
      }).id,
    ]);
    const ev = lines(s, "docs/setup.md", "Always use pnpm.\nNever npm.", 3);
    claim(s, "Use pnpm for every install.", [ev.id], {
      mode: "prescriptive",
      basis: ["documentation"],
      uncertainty: "The guide may predate the lockfile.",
    });
    expect(rendered(s, numbering("generate_questions", [known.findingId])).findings).toBe(
      [
        "<<<FINDINGS>>>",
        "F-1  [observed · code_observation]  scope: repository",
        "     `CLAUDE.md` is existing agent configuration.",
        "     evidence: CLAUDE.md (file)",
        "F-2  [documented · documentation]  scope: repository  mode: prescriptive",
        "     Use pnpm for every install.",
        "     uncertainty: The guide may predate the lockfile.",
        "     evidence: docs/setup.md:3-4",
        "       | Always use pnpm.",
        "       | Never npm.",
        "<<<END FINDINGS>>>",
        "",
      ].join("\n"),
    );
  });

  it("joins several bases as label words and values, each with ', '", () => {
    const s = session();
    const a = lines(s, "docs/a.md", "Prefer the shared client.");
    const b = lines(s, "src/a.ts", "import { client } from './client';");
    claim(s, "The shared client is preferred.", [a.id, b.id], {
      basis: ["documentation", "code_observation"],
    });
    expect(rendered(s, numbering("generate_questions")).findings).toContain(
      "F-1  [documented, observed · documentation, code_observation]  scope: repository\n",
    );
  });

  it("renders gaps with their coverage and shown paths, and absence claims with code's wording", () => {
    const s = session();
    gap(s, "No test command is declared.");
    gap(s, "Ownership is unclear.", {
      gapType: "undetermined_ownership",
      relatedPaths: [],
      coverage: { state: "not_inspected", entries: [], directories: [{ path: "vendor" }] },
    });
    s.log.start({
      type: "finding",
      snapshotId: s.snapshotId,
      producedBy: "call_0001",
      status: "active",
      kind: "absence",
      statement: "No files matched `docs/**/*.md` within the inspected scope.",
      pathGlob: "docs/**/*.md",
      reason: "Looked for docs.",
      basis: ["code_observation"],
      evidenceIds: [
        s.log.append({
          type: "evidence",
          snapshotId: s.snapshotId,
          kind: "absence_check",
          pathGlob: "docs/**/*.md",
          unenteredDirectories: [],
          basis: "code_observation",
        }).id,
      ],
    } as never);
    expect(rendered(s, numbering("generate_questions")).findings).toBe(
      [
        "<<<FINDINGS>>>",
        "F-1  [gap · no_command]  related: scripts/, Makefile",
        "     No test command is declared.",
        "F-2  [gap · undetermined_ownership · not inspected]",
        "     Ownership is unclear.",
        "F-3  [absence]  glob: docs/**/*.md",
        "     No files matched `docs/**/*.md` within the inspected scope.",
        "<<<END FINDINGS>>>",
        "",
      ].join("\n"),
    );
  });

  it("renders conflicts, questions and decisions with their statuses and aliases", () => {
    const s = session();
    const a = claim(s, "Some files use fetch.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const b = claim(s, "The guide prefers the client.", [
      lines(s, "docs/a.md", "Prefer the shared client.").id,
    ]);
    const c = conflict(s, [a.findingId, b.findingId]);
    const q = question(s, [a.findingId], [c.conflictId], "answered");
    const d = decision(s, {
      questionId: q.questionId,
      conflictId: c.conflictId,
      exceptions: ["Integration tests run in CI only."],
    });
    s.log.revise("conflict", c.conflictId, {
      status: "resolved",
      resolvingDecisionId: d.id,
    } as never);
    question(s, [b.findingId], [], "skipped");
    const out = rendered(s, numbering("recommend"));
    expect(out.conflicts).toBe(
      [
        "<<<CONFLICTS>>>",
        "C-1  [resolved · D-1]  members: F-1, F-2",
        "     The guide and the code disagree.",
        "<<<END CONFLICTS>>>",
        "",
      ].join("\n"),
    );
    expect(out.questions).toBe(
      [
        "<<<QUESTIONS>>>",
        "Q-1  [answered · D-1]  resolves: F-1, C-1  scope: repository",
        "     Which command runs the tests?",
        "Q-2  [skipped]  resolves: F-2  scope: repository",
        "     Which command runs the tests?",
        "<<<END QUESTIONS>>>",
        "",
      ].join("\n"),
    );
    expect(out.decisions).toBe(
      [
        "<<<DECISIONS>>>",
        "D-1  [answered]  question: Q-1  conflict: C-1  scope: repository",
        "     Run the tests with `pnpm test`.",
        "     except: Integration tests run in CI only.",
        "<<<END DECISIONS>>>",
        "",
      ].join("\n"),
    );
  });

  it("names a corrected conflict's current decision, and writes [resolved] and [answered] without one", () => {
    const s = session();
    const a = claim(s, "Some files use fetch.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const b = claim(s, "The guide prefers the client.", [lines(s, "docs/a.md", "Prefer it.").id]);
    const c = conflict(s, [a.findingId, b.findingId]);
    const q = question(s, [a.findingId], [c.conflictId], "answered");
    const first = decision(s, { questionId: q.questionId, conflictId: c.conflictId });
    s.log.revise("conflict", c.conflictId, {
      status: "resolved",
      resolvingDecisionId: first.id,
    } as never);
    decision(s, {
      questionId: q.questionId,
      conflictId: c.conflictId,
      supersedes: [first.id],
    });
    const call4 = rendered(s, numbering("recommend"));
    expect(call4.conflicts).toContain("C-1  [resolved · D-1]  members: F-1, F-2\n");
    expect(call4.decisions).toContain("D-1  [answered]  question: Q-1  conflict: C-1");
    // Call 3 numbers no decisions, so the status names none.
    expect(rendered(s, numbering("generate_questions")).conflicts).toContain(
      "C-1  [resolved]  members: F-1, F-2\n",
    );
  });

  it("writes [answered] when the question's decision is withheld", () => {
    const s = session();
    const a = claim(s, "Some files use fetch.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const q = question(s, [a.findingId], [], "answered");
    const d = decision(s, { questionId: q.questionId });
    s.log.append({
      type: "secret_withheld",
      itemId: d.id,
      secretRuleId: "aws-access-key-id",
    } as never);
    const out = rendered(s, numbering("recommend"));
    expect(out.questions).toContain("Q-1  [answered]  resolves: F-1  scope: repository\n");
    expect(out.decisions).toBe("<<<DECISIONS>>>\n<<<END DECISIONS>>>\n");
  });

  it("leaves out members: and resolves: when none of their records has an alias", () => {
    const s = session();
    const a = claim(s, "A.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const b = claim(s, "B.", [lines(s, "src/b.ts", "await fetch(other);").id]);
    const c = conflict(s, [a.findingId, b.findingId]);
    question(s, [a.findingId], [c.conflictId]);
    const numbered = numberRecords(s.log.records, numbering("recommend"));
    const out = renderRecordSections(
      { ...numbered, aliasOf: (id) => (id.startsWith("fnd") ? undefined : numbered.aliasOf(id)) },
      {
        records: s.log.records,
        destination: s.bytes,
        withheldExcerpts: new Set(),
        removedExcerpts: new Set(),
      },
    );
    expect(out.conflicts).toContain("C-1  [unresolved]\n");
    expect(out.questions).toContain("Q-1  [open]  resolves: C-1  scope: repository\n");
    const onlyFindings = renderRecordSections(
      { ...numbered, aliasOf: (id) => (id.startsWith("q_") ? numbered.aliasOf(id) : undefined) },
      {
        records: s.log.records,
        destination: s.bytes,
        withheldExcerpts: new Set(),
        removedExcerpts: new Set(),
      },
    );
    expect(onlyFindings.questions).toContain("Q-1  [open]  scope: repository\n");
  });

  it("renders a developer correction, and leaves out a label whose aliases are all missing", () => {
    const s = session();
    const a = claim(s, "Some files use fetch.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    decision(s, { origin: "developer_correction", findingId: a.findingId });
    expect(rendered(s, numbering("recommend")).decisions).toBe(
      [
        "<<<DECISIONS>>>",
        "D-1  [correction]  scope: repository",
        "     Run the tests with `pnpm test`.",
        "<<<END DECISIONS>>>",
        "",
      ].join("\n"),
    );
  });

  it("renders each target form, references with and without a supporting alias, a decision's command, and a remove without content", () => {
    const s = session();
    const blocks = parseGuidanceBlocks(s.bytes).blocks;
    const ref = (i: number) => ({
      blockId: blocks[i]?.blockId as string,
      blockHash: blocks[i]?.hash as string,
    });
    const ev = lines(s, "package.json", '"test": "vitest run",', 5);
    const f = claim(s, "`package.json` defines the script `test`.", [ev.id]);
    const gone = claim(s, "Gone.", [lines(s, "src/b.ts", "export const b = 2;").id]);
    s.log.revise("finding", gone.findingId, {
      status: "withdrawn",
      withdrawnReason: "withdrawn_by_model",
    } as never);
    const recs: string[] = [];
    const rec = (fields: Record<string, unknown>) => {
      const r = s.log.start({
        type: "recommendation_revision",
        kind: "fact",
        operation: "add",
        target: { kind: "after", ...ref(1) },
        content: "The scripts are defined in `package.json`.",
        rationale: "Where the scripts live isn't documented.",
        support: [{ kind: "finding", findingId: f.findingId }],
        references: [
          {
            kind: "path",
            value: "package.json",
            supportingFindingId: f.findingId,
            evidenceId: ev.id,
            verification: "exists_in_snapshot",
          },
        ],
        scope: { kind: "repository" },
        producedBy: "call_0003",
        status: "valid",
        ...fields,
      } as never) as { recommendationId: string };
      recs.push(r.recommendationId);
    };
    rec({});
    rec({
      operation: "remove",
      target: { kind: "block", ...ref(1) },
      content: undefined,
      support: [{ kind: "finding", findingId: gone.findingId }],
      references: [
        {
          kind: "command",
          value: "npm test",
          supportingFindingId: gone.findingId,
          evidenceId: ev.id,
          verification: "found_not_run",
        },
      ],
    });
    rec({ target: { kind: "section", ...ref(0) }, content: "Line one.\nLine two." });
    const stated = decision(s, { statement: "Type-check with `pnpm tsc --noEmit`." });
    rec({
      kind: "policy",
      content: "Type-check with `pnpm tsc --noEmit`.",
      support: [{ kind: "decision", decisionId: stated.id }],
      references: [
        {
          kind: "command",
          value: "pnpm tsc --noEmit",
          supportingDecisionId: stated.id,
          verification: "stated_by_developer",
        },
      ],
    });
    rec({ target: { kind: "newSection", heading: "Testing", after: ref(0) } });
    rec({ target: { kind: "newSection", heading: "Notes" } });
    const out = rendered(s, numbering("regenerate_recommendations", [], recs)).recommendations;
    expect(out).toBe(
      [
        "<<<RECOMMENDATIONS>>>",
        "R-1  [add · fact]  target: after B-2  scope: repository",
        "     support: F-1",
        '     reference: path "package.json" (F-1)',
        "     rationale: Where the scripts live isn't documented.",
        "       | The scripts are defined in `package.json`.",
        "R-2  [remove · fact]  target: block B-2  scope: repository",
        '     reference: command "npm test"',
        "     rationale: Where the scripts live isn't documented.",
        "R-3  [add · fact]  target: section B-1  scope: repository",
        "     support: F-1",
        '     reference: path "package.json" (F-1)',
        "     rationale: Where the scripts live isn't documented.",
        "       | Line one.",
        "       | Line two.",
        "R-4  [add · policy]  target: after B-2  scope: repository",
        "     support: D-1",
        '     reference: command "pnpm tsc --noEmit" (D-1)',
        "     rationale: Where the scripts live isn't documented.",
        "       | Type-check with `pnpm tsc --noEmit`.",
        'R-5  [add · fact]  target: new section "Testing" after B-1  scope: repository',
        "     support: F-1",
        '     reference: path "package.json" (F-1)',
        "     rationale: Where the scripts live isn't documented.",
        "       | The scripts are defined in `package.json`.",
        'R-6  [add · fact]  target: new section "Notes"  scope: repository',
        "     support: F-1",
        '     reference: path "package.json" (F-1)',
        "     rationale: Where the scripts live isn't documented.",
        "       | The scripts are defined in `package.json`.",
        "<<<END RECOMMENDATIONS>>>",
        "",
      ].join("\n"),
    );
  });

  it("writes a text field with a line break, a control character or a leading quote as a JSON string", () => {
    const s = session();
    const ev = lines(s, "src/a.ts", "await fetch(url);");
    claim(s, "X.\nF-9  [documented · documentation]  scope: repository", [ev.id]);
    claim(s, "Bell\u0007 and sep\u2028here.", [ev.id]);
    claim(s, '"Quoted" at the start.', [ev.id]);
    claim(s, "Paths too.", [ev.id], { scope: { kind: "paths", paths: ["a\nb/c.ts"] } });
    const out = rendered(s, numbering("generate_questions")).findings;
    expect(out).toContain('     "X.\\nF-9  [documented · documentation]  scope: repository"\n');
    expect(out).toContain('     "Bell\\u0007 and sep\\u2028here."\n');
    expect(out).toContain('     "\\"Quoted\\" at the start."\n');
    expect(out).toContain('scope: "a\\nb/c.ts"\n');
    // No line of model text starts at column 0: every line is a frame, a header or indented.
    for (const line of out.split("\n").slice(1, -2)) expect(line).toMatch(/^(F-\d+ {2}| {5})/);
  });

  it("applies the delimiter escape once to record text, excerpts included", () => {
    const s = session();
    const ev = lines(s, "src/a.ts", "const t = '<<<';");
    claim(s, "A <<<marker>>> appears.", [ev.id]);
    const out = rendered(s, numbering("generate_questions")).findings;
    expect(out).toContain("     A <<\\<marker>>\\> appears.\n");
    expect(out).toContain("       | const t = '<<\\<';\n");
  });
});

describe("excerpts (IMPL §3.2.6)", () => {
  it("marks a removed excerpt as not sent and a withheld one as withheld, with no excerpt lines", () => {
    const s = session();
    const a = lines(s, "src/a.ts", "await fetch(url);", 4);
    const b = lines(s, "src/b.ts", "await fetch(other);", 9);
    claim(s, "Some files call fetch.", [a.id, b.id]);
    const out = rendered(s, numbering("generate_questions"), {
      removedExcerpts: new Set([a.id]),
      withheldExcerpts: new Set([b.id]),
    }).findings;
    expect(out).toContain(
      "     evidence: src/a.ts:4-4 (excerpt not sent)\n     evidence: src/b.ts:9-9 (excerpt withheld)\n",
    );
    expect(out).not.toContain("fetch(url)");
  });

  it("lists cited excerpts in rendering order with the aliases citing them", () => {
    const s = session();
    const a = lines(s, "src/a.ts", "await fetch(url);");
    const b = lines(s, "src/b.ts", "await fetch(other);");
    claim(s, "One.", [a.id]);
    claim(s, "Two.", [b.id]);
    const numbered = numberRecords(s.log.records, numbering("generate_questions"));
    const cited = citedExcerpts(numbered, {
      records: s.log.records,
      destination: s.bytes,
      withheldExcerpts: new Set([b.id]),
      removedExcerpts: new Set(),
    });
    expect(cited).toEqual([
      {
        id: a.id,
        path: "src/a.ts",
        bytes: Buffer.byteLength("       | await fetch(url);\n"),
        findings: ["F-1"],
      },
    ]);
  });
});

describe("withholding before aliases (IMPL §3.2.6, §1.7)", () => {
  const SECRET = "AKIAIOSFODNN7EXAMPLE";

  it("withholds a matching record, numbers the rest without a gap, and records no matched text", () => {
    const s = session();
    const ev = lines(s, "src/a.ts", "await fetch(url);");
    claim(s, "First.", [ev.id]);
    const leaky = claim(s, `The key ${SECRET} is used.`, [ev.id]);
    claim(s, "Third.", [ev.id]);
    const { withheld } = withholdForCall(s.log, numbering("generate_questions"));
    expect(withheld.map((w) => w.itemId)).toEqual([leaky.findingId]);
    expect(JSON.stringify(withheld)).not.toContain(SECRET);
    const out = rendered(s, numbering("generate_questions")).findings;
    expect(out).toContain("F-1  [observed");
    expect(out).toContain("     First.\n");
    expect(out).toContain("F-2  [observed · code_observation]  scope: repository\n     Third.\n");
    expect(out).not.toContain("F-3");
  });

  it("withholds a matching excerpt, keeps a finding with another excerpt, and withholds one left with none", () => {
    const s = session();
    const clean = lines(s, "src/a.ts", "await fetch(url);");
    const dirty = lines(s, "src/b.ts", `const key = "${SECRET}";`);
    const kept = claim(s, "Kept.", [clean.id, dirty.id]);
    const lost = claim(s, "Lost.", [dirty.id]);
    const { withheld, withheldExcerpts } = withholdForCall(s.log, numbering("generate_questions"));
    expect([...withheldExcerpts]).toEqual([dirty.id]);
    expect(withheld.map((w) => w.itemId)).toEqual([lost.findingId]);
    const numbered = numberRecords(s.log.records, numbering("generate_questions"));
    expect(numbered.aliasOf(kept.findingId)).toBe("F-1");
    expect(numbered.aliasOf(lost.findingId)).toBeUndefined();
  });

  it("withholds the excerpts of files the expansion round blocked", () => {
    const s = session();
    const ev = lines(s, "src/a.ts", "await fetch(url);");
    const other = lines(s, "src/b.ts", "await fetch(other);");
    claim(s, "Kept.", [ev.id, other.id]);
    s.log.append({
      type: "expansion_round",
      snapshotId: s.snapshotId,
      modelCallId: "call_0001",
      budgetBytes: 100,
      usedBytes: 0,
      requests: [
        { index: 0, kind: "read", outcome: "rejected", rule: "secret-scan:aws-access-key-id" },
      ],
      blocked: [{ path: "src/b.ts", secretRuleId: "aws-access-key-id" }],
    } as never);
    const { withheldExcerpts } = withholdForCall(s.log, numbering("generate_questions"));
    expect([...withheldExcerpts]).toEqual([other.id]);
  });

  it("running it again appends nothing", () => {
    const s = session();
    const ev = lines(s, "src/a.ts", "await fetch(url);");
    claim(s, `The key ${SECRET} is used.`, [ev.id]);
    withholdForCall(s.log, numbering("generate_questions"));
    expect(withholdForCall(s.log, numbering("generate_questions")).withheld).toEqual([]);
  });
});

describe("alias order (IMPL §3.2.6, §3.2.1)", () => {
  it("keeps the known facts' call-1 aliases, leaves a withheld fact's alias unused, and never sends a fact left out of call 1", () => {
    const s = session();
    const entry = (path: string) =>
      s.log.append({
        type: "evidence",
        snapshotId: s.snapshotId,
        kind: "entry",
        path,
        fileHash: sha256(encode(path)),
        basis: "code_observation",
      }).id;
    const f1 = fact(s, "`CLAUDE.md` is existing agent configuration.", [entry("CLAUDE.md")]);
    const f2 = fact(s, "`.claude/a.md` is existing agent configuration.", [entry(".claude/a.md")]);
    const f3 = fact(s, "`.claude/b.md` is existing agent configuration.", [entry(".claude/b.md")]);
    const leftOut = fact(s, "`.claude/c.md` is existing agent configuration.", [
      entry(".claude/c.md"),
    ]);
    const model = claim(s, "Some files call fetch.", [lines(s, "src/a.ts", "fetch(u);").id]);
    s.log.append({
      type: "secret_withheld",
      itemId: f2.findingId,
      secretRuleId: "aws-access-key-id",
    } as never);
    const numbered = numberRecords(
      s.log.records,
      numbering("generate_questions", [f1.findingId, f2.findingId, f3.findingId]),
    );
    expect(numbered.aliasOf(f1.findingId)).toBe("F-1");
    expect(numbered.aliasOf(f2.findingId)).toBeUndefined();
    expect(numbered.aliasOf(f3.findingId)).toBe("F-3");
    expect(numbered.aliasOf(leftOut.findingId)).toBeUndefined();
    expect(numbered.aliasOf(model.findingId)).toBe("F-4");
    expect(numbered.sources.findings).toEqual([f1.id, null, f3.id, model.id]);
  });

  it("numbers other records by the seq of their first revision, not of their current one", () => {
    const s = session();
    const ev = lines(s, "src/a.ts", "await fetch(url);");
    const a = claim(s, "A.", [ev.id]);
    const b = claim(s, "B.", [ev.id]);
    const c = claim(s, "C.", [ev.id]);
    const first = conflict(s, [a.findingId, b.findingId]);
    const second = conflict(s, [b.findingId, c.findingId]);
    s.log.revise("conflict", first.conflictId, {
      findingIds: [a.findingId, c.findingId],
    } as never);
    const numbered = numberRecords(s.log.records, numbering("generate_questions"));
    expect(numbered.aliasOf(first.conflictId)).toBe("C-1");
    expect(numbered.aliasOf(second.conflictId)).toBe("C-2");
  });

  it("numbers R by recommendation order whatever order the caller gives", () => {
    const s = session();
    const f = claim(s, "A.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const blocks = parseGuidanceBlocks(s.bytes).blocks;
    const rec = () =>
      (
        s.log.start({
          type: "recommendation_revision",
          kind: "fact",
          operation: "add",
          target: { kind: "after", blockId: blocks[0]?.blockId, blockHash: blocks[0]?.hash },
          content: "Text.",
          rationale: "Why.",
          support: [{ kind: "finding", findingId: f.findingId }],
          references: [],
          scope: { kind: "repository" },
          producedBy: "call_0003",
          status: "valid",
        } as never) as { recommendationId: string }
      ).recommendationId;
    const first = rec();
    const second = rec();
    const numbered = numberRecords(
      s.log.records,
      numbering("regenerate_recommendations", [], [second, first]),
    );
    expect(numbered.aliasOf(first)).toBe("R-1");
    expect(numbered.aliasOf(second)).toBe("R-2");
  });

  it("holds only the kinds each call accepts", () => {
    const s = session();
    const a = claim(s, "A.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const q = question(s, [a.findingId], [], "answered");
    decision(s, { questionId: q.questionId });
    expect(numberRecords(s.log.records, numbering("generate_questions")).sources).toMatchObject({
      questions: [],
      decisions: [],
    });
    expect(numberRecords(s.log.records, numbering("recommend")).sources.questions).toHaveLength(1);
  });

  it("gives the same numbering and bytes for the same records", () => {
    const build = () => {
      const s = session();
      const a = claim(s, "A.", [lines(s, "src/a.ts", "await fetch(url);").id]);
      question(s, [a.findingId]);
      return rendered(s, numbering("recommend"));
    };
    expect(build()).toEqual(build());
  });
});

describe("sections (IMPL §3.2.6)", () => {
  it("renders every section's frame even when it is empty", () => {
    const s = session();
    const out = rendered(s, numbering("regenerate_recommendations", [], []));
    expect(out.findings).toBe("<<<FINDINGS>>>\n<<<END FINDINGS>>>\n");
    expect(out.conflicts).toBe("<<<CONFLICTS>>>\n<<<END CONFLICTS>>>\n");
    expect(out.questions).toBe("<<<QUESTIONS>>>\n<<<END QUESTIONS>>>\n");
    expect(out.decisions).toBe("<<<DECISIONS>>>\n<<<END DECISIONS>>>\n");
    expect(out.recommendations).toBe("<<<RECOMMENDATIONS>>>\n<<<END RECOMMENDATIONS>>>\n");
    expect(section("CHANGES", "")).toBe("<<<CHANGES>>>\n<<<END CHANGES>>>\n");
  });

  it("renders the change summary's lines in order, with singular forms", () => {
    expect(
      renderChanges({
        decisions: [
          { alias: "D-2", replaces: true },
          { alias: "D-3", replaces: false },
        ],
        staleFindings: 2,
        targetChanged: 1,
      }),
    ).toBe(
      [
        "<<<CHANGES>>>",
        "- D-2 replaces an earlier decision, which is no longer sent.",
        "- D-3 is new.",
        "- 2 findings that the recommendations below cite are no longer current.",
        "- 1 recommendation was withdrawn because its target changed.",
        "<<<END CHANGES>>>",
        "",
      ].join("\n"),
    );
    expect(renderChanges({ decisions: [], staleFindings: 1, targetChanged: 3 })).toBe(
      [
        "<<<CHANGES>>>",
        "- 1 finding that the recommendations below cite is no longer current.",
        "- 3 recommendations were withdrawn because their target changed.",
        "<<<END CHANGES>>>",
        "",
      ].join("\n"),
    );
    expect(renderChanges({ decisions: [], staleFindings: 0, targetChanged: 0 })).toBe(
      "<<<CHANGES>>>\n<<<END CHANGES>>>\n",
    );
  });

  it("renders limits as name: value lines", () => {
    expect(
      renderLimits([
        ["questionBudget", 5],
        ["questions", 20],
      ]),
    ).toBe("<<<LIMITS>>>\nquestionBudget: 5\nquestions: 20\n<<<END LIMITS>>>\n");
  });
});

describe("call 2 (IMPL §3.2.6)", () => {
  const facts: KnownFact[] = [
    {
      kind: "claim",
      mode: "descriptive",
      producedBy: "deterministic",
      statement: "`CLAUDE.md` is existing agent configuration.",
      scope: { kind: "repository" },
      evidence: [
        {
          kind: "entry",
          path: "CLAUDE.md",
          fileHash: sha256(encode("c")),
          basis: "code_observation",
        },
      ],
      basis: ["code_observation"],
      fact: { type: "agent_configuration", path: "CLAUDE.md" },
    },
    {
      kind: "claim",
      mode: "descriptive",
      producedBy: "deterministic",
      statement: "`package.json` defines the script `test`.",
      scope: { kind: "repository" },
      evidence: [
        {
          kind: "lines",
          path: "package.json",
          fileHash: sha256(encode("p")),
          lineStart: 5,
          lineEnd: 5,
          excerpt: '"test": "vitest <<<run",',
          basis: "code_observation",
        },
      ],
      basis: ["code_observation"],
      fact: {
        type: "command",
        file: "package.json",
        kind: "script",
        name: "test",
        status: "found_not_run",
      },
    },
  ];

  function withFacts() {
    const s = session();
    recordKnownFacts(s.log, s.snapshotId, facts, [
      { gapType: "other", statement: "A selection gap.", relatedPaths: [] },
    ]);
    const sent = s.log.records.flatMap((r) =>
      r.type === "finding" && r.kind === "claim" && "findingId" in r ? [r.findingId] : [],
    );
    return { s, sent };
  }

  it("renders the known facts again byte for byte as call 1 sent them", () => {
    const { s, sent } = withFacts();
    const numbered = numberRecords(s.log.records, numbering("analyse_expansion", sent));
    const again = renderKnownFactsAgain(numbered, {
      records: s.log.records,
      destination: s.bytes,
      withheldExcerpts: new Set(),
      removedExcerpts: new Set(),
    });
    const call1 = renderKnownFacts(facts, 10_000);
    expect(again.text).toBe(call1.text);
    expect(again.bytes).toBe(call1.bytes);
    expect(again.facts).toBe(2);
  });

  it("leaves out a withheld fact and keeps the others' call-1 aliases", () => {
    const { s, sent } = withFacts();
    s.log.append({
      type: "secret_withheld",
      itemId: sent[0] as string,
      secretRuleId: "aws-access-key-id",
    } as never);
    const numbered = numberRecords(s.log.records, numbering("analyse_expansion", sent));
    const again = renderKnownFactsAgain(numbered, {
      records: s.log.records,
      destination: s.bytes,
      withheldExcerpts: new Set(),
      removedExcerpts: new Set(),
    });
    expect(again.text).not.toContain("F-1");
    expect(again.text).toContain("F-2  [observed · code_observation]  scope: repository\n");
    expect(again.facts).toBe(1);
  });

  it("puts the other findings, deterministic gaps included, then the conflicts in the call-1 results", () => {
    const { s, sent } = withFacts();
    const a = claim(s, "Some files use fetch.", [lines(s, "src/a.ts", "await fetch(url);").id]);
    const b = claim(s, "The guide prefers the client.", [
      lines(s, "docs/a.md", "Prefer the shared client.").id,
    ]);
    conflict(s, [a.findingId, b.findingId]);
    const numbered = numberRecords(s.log.records, numbering("analyse_expansion", sent));
    const out = renderCallOneResults(numbered, {
      records: s.log.records,
      destination: s.bytes,
      withheldExcerpts: new Set(),
      removedExcerpts: new Set(),
    });
    expect(out).toMatch(
      /^<<<CALL 1 RESULTS>>>\nF-3 {2}\[gap · other · not inspected\]\n {5}A selection gap\.\n/,
    );
    expect(out).toContain("F-4  [observed");
    expect(out).toContain("F-5  [observed");
    expect(out).toContain("C-1  [unresolved]  members: F-4, F-5\n");
    expect(out.endsWith("<<<END CALL 1 RESULTS>>>\n")).toBe(true);
    expect(out).not.toContain("is existing agent configuration");
  });
});

describe("record spans and the complete-request scan (IMPL §1.7)", () => {
  /** A connection string whose raw form holds a line break, so it matches only as JSON. */
  const hidden = ["postgres://admin:", "s3cret\nx@db.internal"].join("");

  function everyKind() {
    const s = session();
    const block = parseGuidanceBlocks(s.bytes).blocks[0];
    const f = claim(s, "Seen in the code.", [lines(s, "src/a.ts", "export const a = 1;").id]);
    const g = claim(s, "Seen elsewhere.", [lines(s, "src/b.ts", "export const b = 2;").id]);
    const c = conflict(s, [f.findingId, g.findingId]);
    const q = question(s, [f.findingId]);
    const d = decision(s, { questionId: q.questionId });
    const r = s.log.start({
      type: "recommendation_revision",
      kind: "fact",
      operation: "add",
      target: { kind: "after", blockId: block?.blockId, blockHash: block?.hash },
      content: "Use pnpm.",
      rationale: "It's documented.",
      support: [{ kind: "finding", findingId: f.findingId }],
      references: [],
      scope: { kind: "repository" },
      producedBy: "call_0003",
      status: "valid",
    } as never) as { recommendationId: string };
    return { s, f, g, c, q, d, r };
  }

  function spansOf(s: Session, recommendations: string[]) {
    const numbered = numberRecords(
      s.log.records,
      numbering("regenerate_recommendations", [], recommendations),
    );
    const sections = spannedRecordSections(numbered, {
      records: s.log.records,
      destination: s.bytes,
      withheldExcerpts: new Set(),
      removedExcerpts: new Set(),
    });
    const all = [
      sections.findings,
      sections.conflicts,
      sections.questions,
      sections.decisions,
      sections.recommendations,
    ];
    const user = `fixed text\n${all.map((x) => x.text).join("")}more fixed text\n`;
    return { user, spans: locateSpans(user, all), sections };
  }

  it("names every kind of record by the ID a secret_withheld or invalidation takes", () => {
    const { s, f, g, c, q, d, r } = everyKind();
    const { user, spans } = spansOf(s, [r.recommendationId]);
    expect(spans.map((span) => span.target)).toEqual([
      { kind: "item", itemId: f.findingId },
      { kind: "item", itemId: g.findingId },
      { kind: "item", itemId: c.conflictId },
      { kind: "item", itemId: q.questionId },
      { kind: "item", itemId: d.id },
      { kind: "recommendation", recommendationId: r.recommendationId },
    ]);
    for (const [span, alias] of spans.map((x, i) => [
      x,
      ["F-1", "F-2", "C-1", "Q-1", "D-1", "R-1"][i],
    ]))
      expect(user.slice((span as { start: number }).start)).toMatch(new RegExp(`^${alias} {2}\\[`));
  });

  it("gives call 2's results section the spans of its findings, then its conflicts", () => {
    const { s, f, g, c } = everyKind();
    const numbered = numberRecords(s.log.records, numbering("analyse_expansion"));
    const results = spannedCallOneResults(numbered, {
      records: s.log.records,
      destination: s.bytes,
      withheldExcerpts: new Set(),
      removedExcerpts: new Set(),
    });
    expect(results.spans.map((span) => span.target)).toEqual([
      { kind: "item", itemId: f.findingId },
      { kind: "item", itemId: g.findingId },
      { kind: "item", itemId: c.conflictId },
    ]);
    expect(results.text).toBe(
      renderCallOneResults(numbered, {
        records: s.log.records,
        destination: s.bytes,
        withheldExcerpts: new Set(),
        removedExcerpts: new Set(),
      }),
    );
  });

  it("refuses a section that isn't in the request exactly once", () => {
    const { s } = everyKind();
    const { sections } = spansOf(s, []);
    expect(() => locateSpans("nothing here", [sections.findings])).toThrow(/exactly once/);
    const twice = sections.findings.text + sections.findings.text;
    expect(() => locateSpans(twice, [sections.findings])).toThrow(/exactly once/);
  });

  it("finds the records a match overlaps, end exclusive, each once", () => {
    const a = { kind: "item" as const, itemId: "fnd_a" };
    const b = { kind: "item" as const, itemId: "fnd_b" };
    const spans = [
      { target: a, start: 10, end: 20 },
      { target: b, start: 20, end: 30 },
    ];
    expect(overlappedTargets(spans, 0, 10)).toEqual([]);
    expect(overlappedTargets(spans, 19, 21)).toEqual([a, b]);
    expect(overlappedTargets(spans, 20, 25)).toEqual([b]);
    expect(overlappedTargets(spans, 30, 40)).toEqual([]);
    expect(overlappedTargets([...spans, { target: a, start: 40, end: 50 }], 0, 60)).toEqual([a, b]);
  });

  it("withholds an overlapped item and invalidates an overlapped recommendation, naming only the rule", () => {
    const { s, f, g, d, r } = everyKind();
    const { spans } = spansOf(s, [r.recommendationId]);
    const at = (target: string) =>
      spans.find((x) =>
        x.target.kind === "item"
          ? x.target.itemId === target
          : x.target.recommendationId === target,
      ) as { start: number; end: number };
    const match = {
      ruleId: "connection-string",
      start: at(d.id).start,
      end: at(r.recommendationId).start + 1,
    };
    // The match runs from the decision across the recommendation's first line.
    const done = withholdMatch(s.log, match, spans);
    expect(done.withheld.map((w) => [w.itemId, w.secretRuleId])).toEqual([
      [d.id, "connection-string"],
    ]);
    expect(done.invalidated).toHaveLength(1);
    expect(done.invalidated[0]).toMatchObject({
      recommendationId: r.recommendationId,
      status: "invalidated",
      invalidatedReason: "secret_match",
      secretRuleId: "connection-string",
    });
    expect(done.invalidated[0]).not.toHaveProperty("revisedBy");
    // What is left is current state without them; the finding stays.
    const again = numberRecords(s.log.records, numbering("recommend"));
    expect(again.decisions).toHaveLength(0);
    expect(again.findings.map((x) => x.record.findingId)).toEqual([f.findingId, g.findingId]);
  });

  it("fails as an internal error, appending nothing, when the match overlaps no record", () => {
    const { s, r } = everyKind();
    const { spans } = spansOf(s, [r.recommendationId]);
    const before = s.log.records.length;
    expect(() =>
      withholdMatch(s.log, { ruleId: "aws-access-key-id", start: 0, end: 5 }, spans),
    ).toThrow(/internal error: .*aws-access-key-id/);
    expect(s.log.records).toHaveLength(before);
  });

  it("a text field that matches only once rendered as JSON is caught by its span, not by withholdForCall", () => {
    const s = session();
    const f = claim(s, hidden, [lines(s, "src/a.ts", "export const a = 1;").id]);
    // The raw text holds a line break, so the per-record scan finds nothing.
    expect(withholdForCall(s.log, numbering("generate_questions")).withheld).toEqual([]);
    const { user, spans } = spansOf(s, []);
    expect(user).toContain("postgres://admin:");
    const start = user.indexOf("postgres://");
    expect(overlappedTargets(spans, start, start + 10)).toEqual([
      { kind: "item", itemId: f.findingId },
    ]);
  });
});
