import { describe, expect, it } from "vitest";
import {
  callDraft,
  completedCall,
  hashOf,
  newLog,
  TEST_SETTINGS,
} from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { proposeArtifact, recordReview } from "./artifacts.js";
import { recoverInterruptedWork } from "./calls.js";
import { currentState } from "./current.js";
import { type ContentReader, type LoadFailure, loadSession } from "./load.js";
import type { SessionLog } from "./log.js";
import {
  REVISION_BOOKKEEPING,
  REVISION_FIELDS,
  recommendationRevisionRecord,
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
} from "./records.js";
import { serialiseSession } from "./serialise.js";
import { contentRefOf } from "./store.js";

// Load checks and schema versions (IMPL §4.9, §4.11).

const SNAP = "snap_0001";
const DESTINATION = new TextEncoder().encode("# Guide\n\nUse pnpm.\n\n- Run the tests.\n");
const DESTINATION_HASH = sha256(DESTINATION);
const DESTINATION_REF = `content/${DESTINATION_HASH.replace(":", "-")}`;

/**
 * A session with every record type the schema accepts so far, in valid shape, except
 * `inputs_purged` and retained exchanges, which retained.test.ts covers, and `secret_withheld`,
 * which the session format 2 tests below add.
 */
function validLog(): SessionLog {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  const parsed = parseGuidanceBlocks(DESTINATION);
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [
        { path: "CLAUDE.md", status: "read", size: DESTINATION.length, hash: DESTINATION_HASH },
        { path: "docs/guide.md", status: "read", size: 10, hash: hashOf("a") },
      ],
      destination: {
        state: "present",
        contentRef: DESTINATION_REF,
        hash: DESTINATION_HASH,
        blocks: parsed.blocks as never,
        lineEndings: parsed.lineEndings,
        roundTrip: parsed.roundTrip,
      },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    },
    { id: SNAP },
  );
  log.start({
    type: "generation_config",
    settings: TEST_SETTINGS,
    settingsHash: hashOf("9"),
    requestedModel: "claude-test",
    effort: "medium",
    budget: { maxCostUsd: 2 },
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    // Off, so the calls below retain nothing; retained exchanges are in retained.test.ts.
    retainModelInputs: false,
  });
  log.revise("generation_config", "generation_config", {
    budget: { maxCostUsd: 4 },
    reason: "budget_raised",
  });
  // call_0001 to call_0003, which the records below name.
  const first = log.start(callDraft());
  log.revise("model_call", first.modelCallId, completedCall());
  log.start(
    callDraft({
      purpose: "generate_questions",
      aliases: { call: "generate_questions", entries: [] },
    }),
  );
  log.start(
    callDraft({
      purpose: "analyse_expansion",
      aliases: { call: "analyse_expansion", entries: [] },
    }),
  );
  const claims = ["The guide asks for pnpm.", "The guide asks for npm."].map((statement) => {
    const ev = log.append({
      type: "evidence",
      snapshotId: SNAP,
      kind: "lines",
      path: "docs/guide.md",
      fileHash: hashOf("a"),
      lineStart: 1,
      lineEnd: 1,
      excerpt: statement,
      basis: "documentation",
    });
    return log.start({
      type: "finding",
      snapshotId: SNAP,
      producedBy: "call_0001",
      status: "active",
      kind: "claim",
      statement,
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["documentation"],
      evidenceIds: [ev.id],
    });
  });
  const check = log.append({
    type: "evidence",
    snapshotId: SNAP,
    kind: "absence_check",
    pathGlob: "**/*.test.ts",
    unenteredDirectories: [],
    basis: "code_observation",
  });
  log.start({
    type: "finding",
    snapshotId: SNAP,
    producedBy: "call_0001",
    status: "active",
    kind: "absence",
    statement: "No file matching **/*.test.ts is in the snapshot.",
    pathGlob: "**/*.test.ts",
    reason: "No tests.",
    basis: ["code_observation"],
    evidenceIds: [check.id],
  });
  const gap = log.start({
    type: "finding",
    snapshotId: SNAP,
    producedBy: "call_0001",
    status: "active",
    kind: "gap",
    statement: "No test command is documented.",
    gapType: "no_command",
    relatedPaths: [],
    evidenceIds: [],
    coverage: { state: "inspected" },
  });
  log.append({
    type: "finding",
    kind: "claim",
    producedBy: "call_0001",
    status: "failed_validation",
    itemKey: "findings/f9",
    rejectedBy: ["CIT-001"],
    proposed: {},
  });
  const conflict = log.start({
    type: "conflict",
    snapshotId: SNAP,
    producedBy: "call_0001",
    findingIds: claims.map((c) => c.findingId),
    description: "pnpm or npm.",
    status: "unresolved",
  });
  const question = log.start({
    type: "question",
    producedBy: "call_0002",
    prompt: "Which package manager?",
    reason: "They disagree.",
    findingIds: [],
    conflictIds: [conflict.conflictId],
    gapIds: [gap.findingId],
    options: [],
    scope: { kind: "repository" },
    status: "open",
  });
  const decision = log.append({
    type: "decision",
    statement: "pnpm.",
    scope: { kind: "repository" },
    exceptions: [],
    questionId: question.questionId,
    conflictId: conflict.conflictId,
    origin: "answered_question",
    actor: "developer",
    decidedAt: "2026-11-01T10:20:00.000Z",
  });
  log.revise("question", question.questionId, { status: "answered" });
  log.revise("conflict", conflict.conflictId, {
    status: "resolved",
    resolvingDecisionId: decision.id,
  });
  log.revise("finding", claims[1]?.findingId as string, {
    status: "withdrawn",
    withdrawnReason: "withdrawn_by_model",
    revisedBy: "call_0003",
  });
  // A retry whose alias table names the revisions it sent.
  const current = log.records.filter((r) => r.type === "finding" && r.status === "active");
  const retry = log.start(
    callDraft({
      purpose: "generate_questions",
      attempt: 2,
      retryOf: "call_0002",
      aliases: {
        call: "generate_questions",
        entries: [
          ...current.map((r, i) => ({
            alias: `F-${i + 1}`,
            kind: "F" as const,
            target: { kind: "record" as const, recordId: r.id },
          })),
          { alias: "C-1", kind: "C", target: { kind: "record", recordId: conflict.id } },
          { alias: "B-1", kind: "B", target: { kind: "block", blockId: "b1", hash: hashOf("b") } },
        ],
      },
    }),
  );
  log.revise("model_call", retry.modelCallId, completedCall({ questionOrder: ["q1"] }));
  const interval = log.start({
    type: "effort_interval",
    state: "open",
    stage: "clarify",
    enteredAt: "2026-11-01T10:20:00.000Z",
  });
  log.revise("effort_interval", interval.effortIntervalId, {
    state: "closed",
    leftAt: { state: "known", value: "2026-11-01T10:21:00.000Z" },
  });
  const correction = log.append({ type: "effort_correction", totalMs: 1, reason: "Too short." });
  log.append({
    type: "effort_correction",
    totalMs: 2,
    reason: "Still short.",
    supersedes: [correction.id],
  });
  log.revise("session_state", "session_state", { stage: "complete", status: "completed" });
  return log;
}

function fileOf(log: SessionLog): SessionFile {
  return {
    format: SESSION_FORMAT,
    schemaVersion: SESSION_SCHEMA_VERSION,
    writtenBy: "0.1.0",
    session: {
      id: "ses_0001",
      createdAt: "2026-11-01T10:15:00.000Z",
      productVersion: "0.1.0",
      adapter: "claude-code",
      outputScope: ["root CLAUDE.md"],
      repository: { name: "kutt", root: "/Users/dev/kutt" },
      targetPath: "CLAUDE.md",
    },
    records: [...log.records],
  };
}

const encode = (text: string) => new TextEncoder().encode(text);

// biome-ignore lint/suspicious/noExplicitAny: tests corrupt the file freely.
type Json = any;

/** The valid session's JSON, changed by `edit`. */
function corrupted(edit: (json: Json) => void): Uint8Array {
  const json = JSON.parse(serialiseSession(fileOf(validLog())));
  edit(json);
  return encode(JSON.stringify(json));
}

/** Renumbers `seq` in file order, after records were moved. */
function renumber(json: Json): void {
  json.records.forEach((record: Json, index: number) => {
    record.seq = index + 1;
  });
}

const byId = (json: Json, id: string): Json => json.records.find((r: Json) => r.id === id);

function memoryContent(
  files: Record<string, Uint8Array> = { [DESTINATION_REF]: DESTINATION },
): ContentReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(ref: string) {
      reads.push(ref);
      return files[ref];
    },
  };
}

async function failure(
  bytes: Uint8Array,
  content = memoryContent(),
  options?: { readerFormat?: number },
): Promise<LoadFailure> {
  const result = await loadSession(bytes, content, options);
  if (result.ok) throw new Error("expected the session to be rejected");
  return result.failure;
}

describe("a valid session (IMPL §4.9)", () => {
  it("loads as the typed records it was written from", async () => {
    const log = validLog();
    const content = memoryContent();
    const result = await loadSession(encode(serialiseSession(fileOf(log))), content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toEqual(JSON.parse(JSON.stringify(fileOf(log))));
    expect(content.reads).toEqual([DESTINATION_REF]);
  });

  it("accepts a decision that supersedes a decision", async () => {
    const log = validLog();
    const first = log.records.find((r) => r.type === "decision");
    log.append({
      type: "decision",
      statement: "npm after all.",
      scope: { kind: "repository" },
      exceptions: [],
      origin: "developer_correction",
      actor: "developer",
      decidedAt: "2026-11-01T10:21:00.000Z",
      supersedes: [first?.id as string],
    });
    const result = await loadSession(encode(serialiseSession(fileOf(log))), memoryContent());
    expect(result.ok).toBe(true);
  });
});

/** The valid session with a completed `recommend` call and the records it creates (§3.3.5). */
function recommendLog(): SessionLog {
  const log = validLog();
  const finding = log.records.find((r) => r.type === "finding" && r.kind === "claim") as {
    findingId: string;
    evidenceIds: string[];
  };
  const question = log.records.find((r) => r.type === "question") as { questionId: string };
  const call = log.start(callDraft({ purpose: "recommend" }));
  log.revise("model_call", call.modelCallId, completedCall());
  log.start({
    type: "recommendation_revision",
    kind: "fact",
    operation: "add",
    target: { kind: "newSection", heading: "Notes" },
    content: "See `docs/guide.md`.",
    rationale: "Documented.",
    support: [{ kind: "finding", findingId: finding.findingId }],
    references: [
      {
        kind: "path",
        value: "docs/guide.md",
        supportingFindingId: finding.findingId,
        evidenceId: finding.evidenceIds[0] as string,
        verification: "exists_in_snapshot",
      },
    ],
    scope: { kind: "repository" },
    producedBy: call.modelCallId,
    status: "valid",
  });
  log.append({
    type: "held_back",
    topic: "Which client to use",
    blockedBy: [question.questionId],
    modelCallId: call.modelCallId,
  });
  log.append({
    type: "failed_item",
    collection: "noChangeReason",
    status: "failed_validation",
    producedBy: call.modelCallId,
    itemKey: "noChangeReason",
    rejectedBy: ["REC-009"],
    proposed: "Nothing to change.",
  });
  return log;
}

describe("recommend records (IMPL §3.3.5, §4.4.1)", () => {
  it("loads a recommendation revision, a held-back entry and a failed no-change reason", async () => {
    const result = await loadSession(
      encode(serialiseSession(fileOf(recommendLog()))),
      memoryContent(),
    );
    expect(result.ok).toBe(true);
  });

  it("check 4 rejects a held-back blocker that names no question or conflict", async () => {
    const edit = (blocker: (json: Json) => string) => {
      const json = JSON.parse(serialiseSession(fileOf(recommendLog())));
      json.records.find((r: Json) => r.type === "held_back").blockedBy = [blocker(json)];
      return encode(JSON.stringify(json));
    };
    for (const missing of ["q_9999", "conf_9999"])
      expect(await failure(edit(() => missing)), missing).toMatchObject({ check: 4 });
    // A finding's lineage ID isn't a question's or a conflict's, so the schema refuses it.
    const finding = (json: Json) =>
      json.records.find((r: Json) => r.type === "finding" && r.findingId).findingId;
    expect(await failure(edit(finding))).toMatchObject({ check: 2 });
  });

  it("accepts a held-back entry blocked by a conflict", async () => {
    const log = recommendLog();
    const conflict = log.records.find((r) => r.type === "conflict") as
      | { conflictId: string }
      | undefined;
    if (conflict === undefined) throw new Error("the valid session has a conflict");
    const call = log.records.find((r) => r.type === "model_call" && r.purpose === "recommend") as {
      modelCallId: string;
    };
    log.append({
      type: "held_back",
      topic: "Contested",
      blockedBy: [conflict.conflictId],
      modelCallId: call.modelCallId,
    });
    const result = await loadSession(encode(serialiseSession(fileOf(log))), memoryContent());
    expect(result.ok).toBe(true);
  });

  it("check 4 rejects an invalidation whose revisedBy names no model call", async () => {
    const log = recommendLog();
    const revision = log.records.find((r) => r.type === "recommendation_revision") as {
      recommendationId: string;
    };
    const call = log.records.find((r) => r.type === "model_call" && r.purpose === "recommend") as {
      modelCallId: string;
    };
    log.revise("recommendation_revision", revision.recommendationId, {
      status: "invalidated",
      invalidatedReason: "dropped_by_model",
      revisedBy: call.modelCallId,
    });
    expect((await loadSession(encode(serialiseSession(fileOf(log))), memoryContent())).ok).toBe(
      true,
    );
    const json = JSON.parse(serialiseSession(fileOf(log)));
    json.records.find((r: Json) => r.type === "recommendation_revision" && r.revisedBy).revisedBy =
      "call_9999";
    expect(await failure(encode(JSON.stringify(json)))).toMatchObject({ check: 4 });
  });

  it("check 3 rejects an invalidation that changes more than its status and reason", async () => {
    const log = recommendLog();
    const revision = log.records.find((r) => r.type === "recommendation_revision") as {
      recommendationId: string;
    };
    log.revise("recommendation_revision", revision.recommendationId, {
      status: "invalidated",
      invalidatedReason: "target_changed",
    });
    const json = JSON.parse(serialiseSession(fileOf(log)));
    const invalidated = json.records.find(
      (r: Json) => r.type === "recommendation_revision" && r.status === "invalidated",
    );
    invalidated.rationale = "Changed on invalidation.";
    expect(await failure(encode(JSON.stringify(json)))).toMatchObject({ check: 3 });
  });

  it("check 4 rejects a held-back entry whose model call doesn't exist", async () => {
    const json = JSON.parse(serialiseSession(fileOf(recommendLog())));
    const entry = json.records.find((r: Json) => r.type === "held_back");
    entry.modelCallId = "call_9999";
    expect(await failure(encode(JSON.stringify(json)))).toMatchObject({ check: 4 });
  });
});

/** The recommend session with a second recommendation and an accepted selection (DM §9.2). */
function selectionLog(): SessionLog {
  const log = recommendLog();
  const first = log.records.find((r) => r.type === "recommendation_revision") as {
    id: string;
    recommendationId: string;
  };
  const {
    id: _id,
    seq: _seq,
    createdAt: _c,
    recommendationId: _r,
    revision: _v,
    ...draft
  } = first as unknown as Record<string, unknown>;
  log.start(draft as never);
  log.append({
    type: "selection",
    recommendationId: first.recommendationId,
    revisionId: first.id,
    state: "accepted",
    actor: "developer",
    selectedAt: "2026-11-01T10:30:00.000Z",
  });
  return log;
}

describe("selection references (IMPL §4.4.1, §4.9 check 4)", () => {
  const selectionOf = (json: Json) => json.records.find((r: Json) => r.type === "selection");
  const revisions = (json: Json) =>
    json.records.filter((r: Json) => r.type === "recommendation_revision");

  it("loads an accepted selection", async () => {
    const result = await loadSession(
      encode(serialiseSession(fileOf(selectionLog()))),
      memoryContent(),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a selection whose recommendation or revision isn't in the session", async () => {
    for (const [field, value] of [
      ["recommendationId", "rec_9999"],
      ["revisionId", "rrev_9999"],
    ] as const) {
      const json = JSON.parse(serialiseSession(fileOf(selectionLog())));
      selectionOf(json)[field] = value;
      expect(await failure(encode(JSON.stringify(json))), field).toMatchObject({ check: 4 });
    }
  });

  it("rejects a selection whose revision belongs to another recommendation", async () => {
    const json = JSON.parse(serialiseSession(fileOf(selectionLog())));
    selectionOf(json).revisionId = revisions(json)[1].id;
    const rejected = await failure(encode(JSON.stringify(json)));
    expect(rejected).toMatchObject({ check: 4 });
    expect(rejected.detail).toMatch(/another recommendation/);
  });

  it("rejects a selection that names a later revision", async () => {
    const json = JSON.parse(serialiseSession(fileOf(selectionLog())));
    const selection = selectionOf(json);
    json.records.splice(json.records.indexOf(selection), 1);
    json.records.splice(json.records.indexOf(revisions(json)[0]), 0, selection);
    renumber(json);
    expect(await failure(encode(JSON.stringify(json)))).toMatchObject({ check: 4 });
  });

  it("rejects a selection of a revision that failed validation", async () => {
    const log = recommendLog();
    const failed = log.append({
      type: "recommendation_revision",
      recommendationId: "rec_0009",
      revision: 1,
      status: "failed_validation",
      producedBy: "developer_edit",
      itemKey: "$edit",
      rejectedBy: ["REF-002"],
      proposed: {},
    });
    log.append({
      type: "selection",
      recommendationId: "rec_0009",
      revisionId: failed.id,
      state: "accepted",
      actor: "developer",
      selectedAt: "2026-11-01T10:30:00.000Z",
    });
    const found = await failure(encode(serialiseSession(fileOf(log))));
    expect(found).toMatchObject({ check: 4 });
    // The recommendation's only revision failed, so the lineage reference fails first.
    expect(found.detail).toMatch(/rec_0009, which only failed validation/);
  });
});

describe("clashing selections load (DM §9.2, IMPL §4.4.2)", () => {
  it("two accepted revisions of one block load, and current state reports the clash", async () => {
    const log = recommendLog();
    const base = log.records.find((r) => r.type === "recommendation_revision") as unknown as Record<
      string,
      unknown
    >;
    const { id: _i, seq: _s, createdAt: _c, recommendationId: _r, revision: _v, ...draft } = base;
    const paragraph = parseGuidanceBlocks(DESTINATION).blocks.find(
      (b) => b.blockId === "Guide/paragraph-1",
    );
    if (paragraph === undefined) throw new Error("no paragraph");
    const target = { kind: "block", blockId: paragraph.blockId, blockHash: paragraph.hash };
    const ids = [1, 2].map((n) => {
      const revision = log.start({
        ...draft,
        operation: "revise",
        target,
        content: `Use pnpm ${n}.`,
        references: [],
      } as never) as unknown as { id: string; recommendationId: string };
      log.append({
        type: "selection",
        recommendationId: revision.recommendationId,
        revisionId: revision.id,
        state: "accepted",
        actor: "developer",
        selectedAt: "2026-11-01T10:30:00.000Z",
      });
      return revision.recommendationId;
    });
    const result = await loadSession(encode(serialiseSession(fileOf(log))), memoryContent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentState(result.file.records, { destination: DESTINATION }).clashes).toEqual([
      { recommendationIds: ids, reason: "same_block" },
    ]);
  });
});

describe("check 1: format and schema version (IMPL §4.9)", () => {
  it("rejects truncated JSON", async () => {
    const text = serialiseSession(fileOf(validLog()));
    expect(await failure(encode(text.slice(0, text.length / 2)))).toMatchObject({
      check: 1,
      name: "format",
    });
  });

  it("rejects bytes that aren't UTF-8", async () => {
    expect(await failure(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({ check: 1 });
  });

  it("rejects another format, or a schemaVersion that isn't an integer", async () => {
    expect(
      await failure(
        corrupted((j) => {
          j.format = "something/else";
        }),
      ),
    ).toMatchObject({ check: 1 });
    expect(
      await failure(
        corrupted((j) => {
          j.schemaVersion = "1";
        }),
      ),
    ).toMatchObject({ check: 1 });
    expect(await failure(encode("[]"))).toMatchObject({ check: 1 });
  });

  it("refuses an older format with its message, before v0.1.0", async () => {
    const bytes = corrupted((j) => {
      j.schemaVersion = 1;
      j.writtenBy = "0.0.3";
    });
    const found = await failure(bytes);
    expect(found).toMatchObject({
      check: 1,
      version: { direction: "older", sessionFormat: 1, writtenBy: "0.0.3", readerFormat: 2 },
    });
  });

  it("refuses a newer format with its message, whatever else the file holds", async () => {
    const bytes = corrupted((j) => {
      j.schemaVersion = 3;
      j.writtenBy = "0.3.0";
      j.somethingNew = true;
    });
    const content = memoryContent();
    const found = await failure(bytes, content);
    expect(found).toMatchObject({
      check: 1,
      version: { direction: "newer", sessionFormat: 3, writtenBy: "0.3.0", readerFormat: 2 },
    });
    expect(content.reads).toEqual([]);
  });
});

describe("check 2: the file schema (IMPL §4.9)", () => {
  it("rejects an unknown field, naming the record", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "ev_0001").note = "extra";
      }),
    );
    expect(found).toMatchObject({ check: 2, name: "schema", recordId: "ev_0001", seq: 9 });
  });

  it("rejects a claim or absence finding without evidence", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "fndr_0001").evidenceIds = [];
      }),
    );
    expect(found).toMatchObject({ check: 2, recordId: "fndr_0001" });
  });
});

describe("check 3: the envelope (IMPL §4.9)", () => {
  it("rejects a duplicate record ID", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "ev_0002").id = "ev_0001";
      }),
    );
    expect(found).toMatchObject({ check: 3, name: "envelope", recordId: "ev_0001" });
  });

  it("rejects a gap in seq, and seq out of file order", async () => {
    expect(
      await failure(
        corrupted((j) => {
          j.records[3].seq = 99;
        }),
      ),
    ).toMatchObject({ check: 3 });
    expect(
      await failure(
        corrupted((j) => {
          [j.records[2].seq, j.records[3].seq] = [j.records[3].seq, j.records[2].seq];
        }),
      ),
    ).toMatchObject({ check: 3 });
  });

  it("rejects a lineage whose revisions aren't numbered 1, 2, 3…", async () => {
    const found = await failure(
      corrupted((j) => {
        const second = j.records.find((r: Json) => r.type === "question" && r.revision === 2);
        second.revision = 3;
      }),
    );
    expect(found).toMatchObject({ check: 3 });
  });

  it("rejects a revision that doesn't supersede the one before", async () => {
    expect(
      await failure(
        corrupted((j) => {
          const second = j.records.find((r: Json) => r.type === "question" && r.revision === 2);
          delete second.supersedes;
        }),
      ),
    ).toMatchObject({ check: 3 });
    expect(
      await failure(
        corrupted((j) => {
          const last = j.records.filter((r: Json) => r.type === "session_state").at(-1);
          last.supersedes = ["fndr_0001"];
        }),
      ),
    ).toMatchObject({ check: 3 });
  });
});

describe("check 4: references (IMPL §4.9)", () => {
  it("rejects a dangling record reference", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "fndr_0001").evidenceIds = ["ev_9999"];
      }),
    );
    expect(found).toMatchObject({ check: 4, name: "references", recordId: "fndr_0001" });
  });

  it("rejects a dangling lineage reference", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "confr_0001").findingIds = ["fnd_0001", "fnd_9999"];
      }),
    );
    expect(found).toMatchObject({ check: 4, recordId: "confr_0001" });
  });

  it("rejects a reference to a later record", async () => {
    const found = await failure(
      corrupted((j) => {
        // Move the first claim's evidence after the claim.
        const index = j.records.findIndex((r: Json) => r.id === "ev_0001");
        const [ev] = j.records.splice(index, 1);
        j.records.splice(index + 1, 0, ev);
        renumber(j);
      }),
    );
    expect(found).toMatchObject({ check: 4, recordId: "fndr_0001" });
  });

  it("rejects a reference to a lineage that starts later", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "qr_0001").gapIds = ["fnd_0004"];
        // A gap lineage that only starts after the question.
        const gap = { ...byId(j, "fndr_0004"), id: "fndr_0099", findingId: "fnd_0004" };
        byId(j, "fndr_0004").findingId = "fnd_0098";
        j.records.push(gap);
        renumber(j);
      }),
    );
    expect(found).toMatchObject({ check: 4, recordId: "qr_0001" });
  });

  it("rejects a record that refers to a failed record", async () => {
    const found = await failure(
      corrupted((j) => {
        // A replacement claim that supersedes the failed finding.
        const replacement = { ...byId(j, "fndr_0001"), id: "fndr_0099", findingId: "fnd_0099" };
        replacement.supersedes = ["fndr_0005"];
        j.records.push(replacement);
        renumber(j);
      }),
    );
    expect(found).toMatchObject({ check: 4, recordId: "fndr_0099" });
  });
});

describe("check 5: superseding (IMPL §4.9)", () => {
  /** Adds a replacement claim lineage that supersedes `targets`. */
  const replacing = (j: Json, id: string, targets: string[]) => {
    const replacement = {
      ...byId(j, "fndr_0001"),
      id,
      findingId: `fnd_${id.slice(5)}`,
      supersedes: targets,
    };
    j.records.push(replacement);
    renumber(j);
  };

  it("rejects a record superseded twice", async () => {
    const found = await failure(
      corrupted((j) => {
        replacing(j, "fndr_0098", ["fndr_0001"]);
        replacing(j, "fndr_0099", ["fndr_0001"]);
      }),
    );
    expect(found).toMatchObject({ check: 5, name: "superseding", recordId: "fndr_0099" });
  });

  it("rejects superseding a record of another type", async () => {
    const found = await failure(
      corrupted((j) => {
        replacing(j, "fndr_0099", ["confr_0001"]);
      }),
    );
    expect(found).toMatchObject({ check: 5, recordId: "fndr_0099" });
  });

  it("rejects superseding a revision whose status isn't current", async () => {
    const found = await failure(
      corrupted((j) => {
        const withdrawn = j.records.find(
          (r: Json) => r.type === "finding" && r.status === "withdrawn",
        );
        replacing(j, "fndr_0099", [withdrawn.id]);
      }),
    );
    expect(found).toMatchObject({ check: 5, recordId: "fndr_0099" });
  });
});

describe("check 6: evidence (IMPL §4.9)", () => {
  it("rejects a claim whose evidence is an absence check", async () => {
    const log = validLog();
    const check = log.records.find((r) => r.type === "evidence" && r.kind === "absence_check");
    const claim = log.start({
      type: "finding",
      snapshotId: SNAP,
      producedBy: "call_0001",
      status: "active",
      kind: "claim",
      statement: "No tests.",
      mode: "descriptive",
      scope: { kind: "repository" },
      basis: ["code_observation"],
      evidenceIds: [check?.id as string],
    });
    const found = await failure(encode(serialiseSession(fileOf(log))));
    expect(found).toMatchObject({ check: 6, name: "evidence", recordId: claim.id });
  });

  it("rejects an absence finding whose evidence isn't an absence check", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "fndr_0003").evidenceIds = ["ev_0001"];
      }),
    );
    expect(found).toMatchObject({ check: 6, recordId: "fndr_0003" });
  });
});

describe("check 7: content (IMPL §4.9)", () => {
  it("rejects a missing content file", async () => {
    const found = await failure(encode(serialiseSession(fileOf(validLog()))), memoryContent({}));
    expect(found).toMatchObject({ check: 7, name: "content", recordId: SNAP });
  });

  it("rejects a content file whose bytes don't hash to its name", async () => {
    const altered = Uint8Array.from(DESTINATION);
    altered[2] = 0x67;
    const found = await failure(
      encode(serialiseSession(fileOf(validLog()))),
      memoryContent({ [DESTINATION_REF]: altered }),
    );
    expect(found).toMatchObject({ check: 7, recordId: SNAP });
  });

  it("rejects a destination hash that doesn't match its bytes", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, SNAP).destination.hash = hashOf("e");
      }),
    );
    expect(found).toMatchObject({ check: 7, recordId: SNAP });
  });

  it("rejects a Guidance Block hash that doesn't match its bytes", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, SNAP).destination.blocks[1].hash = hashOf("e");
      }),
    );
    expect(found).toMatchObject({ check: 7, recordId: SNAP });
  });

  it("rejects a Guidance Block whose span runs past the content", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, SNAP).destination.blocks.at(-1).sourceSpan.end = DESTINATION.length + 5;
      }),
    );
    expect(found).toMatchObject({ check: 7, recordId: SNAP });
  });
});

describe("check 8: state (IMPL §4.9)", () => {
  it("rejects two session states with an outcome", async () => {
    const found = await failure(
      corrupted((j) => {
        const states = j.records.filter((r: Json) => r.type === "session_state");
        for (const state of states) state.outcome = "no_change";
      }),
    );
    expect(found).toMatchObject({ check: 8, name: "state", recordId: "st_0001" });
  });

  it("rejects an outcome that isn't on the last session state", async () => {
    const found = await failure(
      corrupted((j) => {
        j.records[0].outcome = "no_change";
      }),
    );
    expect(found).toMatchObject({ check: 8, recordId: "st_0001" });
  });

  it("accepts an outcome on the last session state, with later records of other types", async () => {
    const log = validLog();
    log.revise("session_state", "session_state", { outcome: "no_change" });
    log.append({
      type: "evidence",
      snapshotId: SNAP,
      kind: "entry",
      path: "docs/guide.md",
      fileHash: hashOf("a"),
      basis: "code_observation",
    });
    const result = await loadSession(encode(serialiseSession(fileOf(log))), memoryContent());
    expect(result.ok).toBe(true);
  });
});

describe("check order and reporting (IMPL §4.9)", () => {
  it("reports only the first check that fails", async () => {
    const found = await failure(
      corrupted((j) => {
        byId(j, "fndr_0001").evidenceIds = ["ev_9999"];
        j.records[0].outcome = "no_change";
      }),
      memoryContent({}),
    );
    expect(found.check).toBe(4);
  });

  it("leaves writtenBy unknown when the file doesn't say", async () => {
    const found = await failure(
      corrupted((j) => {
        j.schemaVersion = 3;
        delete j.writtenBy;
      }),
    );
    expect(found.version).toEqual({
      direction: "newer",
      sessionFormat: 3,
      writtenBy: undefined,
      readerFormat: 2,
    });
  });
});

describe("check 4: model-call references (IMPL §4.6, §4.9)", () => {
  /** Both revisions of the retry, so check 3 sees them repeat each other. */
  const retries = (json: Json): Json[] =>
    json.records.filter((r: Json) => r.type === "model_call" && r.retryOf !== undefined);
  const retry = (json: Json): Json => retries(json)[0];
  const everyRetry = (json: Json, edit: (record: Json) => void) => {
    for (const record of retries(json)) edit(record);
  };

  it("rejects a model call before the session's first generation_config", async () => {
    const bytes = corrupted((json) => {
      // Move both generation_config revisions to the end, after every call.
      const configs = json.records.filter((r: Json) => r.type === "generation_config");
      json.records = [
        ...json.records.filter((r: Json) => r.type !== "generation_config"),
        ...configs,
      ];
      renumber(json);
    });
    const firstCall = JSON.parse(serialiseSession(fileOf(validLog()))).records.find(
      (r: Json) => r.type === "model_call",
    );
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      recordId: firstCall.id,
      detail: expect.stringMatching(/comes before the session's first generation_config/),
    });
  });

  it("rejects a model call in a session with no generation_config", async () => {
    const bytes = corrupted((json) => {
      json.records = json.records.filter((r: Json) => r.type !== "generation_config");
      renumber(json);
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/no generation_config/),
    });
  });

  it("rejects producedBy naming a model call that isn't in the session", async () => {
    const bytes = corrupted((json) => {
      json.records.find((r: Json) => r.type === "finding").producedBy = "call_9999";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/producedBy/),
    });
  });

  it("rejects producedBy naming a model call that starts later", async () => {
    const bytes = corrupted((json) => {
      json.records.find((r: Json) => r.type === "finding").producedBy = retry(json).modelCallId;
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/starts later/),
    });
  });

  it("rejects a dangling revisedBy", async () => {
    const bytes = corrupted((json) => {
      json.records.find((r: Json) => r.revisedBy !== undefined).revisedBy = "call_9999";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/revisedBy/),
    });
  });

  it("rejects a content notice whose modelCallId is dangling", async () => {
    const log = validLog();
    log.append({
      type: "content_notice",
      snapshotId: SNAP,
      modelCallId: "call_9999",
      item: "T2-001",
      path: "docs/guide.md",
      fileHash: hashOf("a"),
      lineStart: 1,
      lineEnd: 1,
      description: "Looks like an instruction.",
    });
    expect(await failure(encode(serialiseSession(fileOf(log))))).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/modelCallId/),
    });
  });

  it("rejects a dangling retryOf, on both revisions", async () => {
    const bytes = corrupted((json) => {
      for (const r of json.records) if (r.retryOf !== undefined) r.retryOf = "call_9999";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/retryOf/),
    });
  });

  it("rejects an alias target that isn't in the session", async () => {
    const bytes = corrupted((json) => {
      everyRetry(json, (r) => {
        r.aliases.entries[0].target.recordId = "fndr_9999";
      });
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/aliases/),
    });
  });

  it("rejects an alias target of the wrong type for its kind", async () => {
    const bytes = corrupted((json) => {
      everyRetry(json, (r) => {
        const entries = r.aliases.entries;
        entries[0].target.recordId = entries.find((e: Json) => e.kind === "C").target.recordId;
      });
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/a conflict/),
    });
  });

  it("rejects an alias target written after the call", async () => {
    const bytes = corrupted((json) => {
      const later = json.records.filter((r: Json) => r.type === "finding").at(-1);
      later.findingId = "fnd_0099";
      everyRetry(json, (r) => {
        r.aliases.entries[0].target.recordId = later.id;
      });
      // Move the withdrawal to the end, after the retry, keeping its supersedes valid.
      json.records = [...json.records.filter((r: Json) => r !== later), later];
      later.revision = 1;
      delete later.supersedes;
      delete later.revisedBy;
      later.status = "active";
      delete later.withdrawnReason;
      renumber(json);
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/later/),
    });
  });

  it("rejects an alias target that failed validation", async () => {
    const bytes = corrupted((json) => {
      const failed = json.records.find((r: Json) => r.status === "failed_validation");
      everyRetry(json, (r) => {
        r.aliases.entries[0].target.recordId = failed.id;
      });
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/failed validation/),
    });
  });

  it("rejects, at the schema, an alias whose target isn't of its kind", async () => {
    const bytes = corrupted((json) => {
      everyRetry(json, (r) => {
        r.aliases.entries[0].target = { kind: "item", itemId: "T2-001" };
      });
    });
    expect(await failure(bytes)).toMatchObject({ check: 2 });
  });

  it("rejects an input manifest naming a snapshot that isn't in the session", async () => {
    const bytes = corrupted((json) => {
      everyRetry(json, (r) => {
        r.inputManifest.snapshotId = "snap_9999";
      });
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/inputManifest.snapshotId/),
    });
  });

  it("round-trips interrupted and failed calls and an interval closed on resume", async () => {
    const log = validLog();
    const failed = log.start(callDraft());
    log.revise(
      "model_call",
      failed.modelCallId,
      completedCall({ state: "failed", error: { kind: "transport", message: "Timed out." } }),
    );
    log.start(callDraft());
    log.start({
      type: "effort_interval",
      state: "open",
      stage: "review",
      enteredAt: "2026-11-01T10:40:00.000Z",
    });
    recoverInterruptedWork(log);
    const file = fileOf(log);
    const bytes = encode(serialiseSession(file));
    const result = await loadSession(bytes, memoryContent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serialiseSession(result.file)).toBe(serialiseSession(file));
  });

  it("accepts deterministic findings, which name no model call", async () => {
    const bytes = corrupted((json) => {
      const gap = json.records.find((r: Json) => r.kind === "gap");
      gap.producedBy = "deterministic";
    });
    expect((await loadSession(bytes, memoryContent())).ok).toBe(true);
  });
});

describe("check 3: a revision repeats what its type doesn't change (IMPL §4.9)", () => {
  const revisionOf = (json: Json, type: string, revision = 2): Json =>
    json.records.find((r: Json) => r.type === type && r.revision === revision);

  it("rejects an ended model call whose estimatedCost differs from its started revision", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "model_call").estimatedCost = { state: "known", value: 0.01 };
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/estimatedCost/),
    });
  });

  it("rejects a withdrawn finding whose statement changed", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "finding").statement = "Something else.";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/statement/),
    });
  });

  it("rejects a revision that adds a field its type doesn't change", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "finding").uncertainty = "Added later.";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/uncertainty/),
    });
  });

  it("rejects a revision that drops a field its type doesn't change", async () => {
    const bytes = corrupted((json) => {
      const withdrawn = revisionOf(json, "finding");
      const first = json.records.find(
        (r: Json) => r.findingId === withdrawn.findingId && r.revision === 1,
      );
      first.uncertainty = "Only one guide says so.";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/uncertainty/),
    });
  });

  it("rejects a resolved conflict whose description changed", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "conflict").description = "Rewritten.";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/description/),
    });
  });

  it("rejects an answered question whose prompt changed", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "question").prompt = "Rewritten?";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/prompt/),
    });
  });

  it("rejects a closed effort interval whose stage changed", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "effort_interval").stage = "review";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/stage/),
    });
  });

  it("rejects a generation_config revision that changes more than the budget", async () => {
    const bytes = corrupted((json) => {
      revisionOf(json, "generation_config").questionBudget = 9;
    });
    expect(await failure(bytes)).toMatchObject({
      check: 3,
      detail: expect.stringMatching(/questionBudget/),
    });
  });

  it("accepts a session_state revision that changes productVersion, which its type allows", async () => {
    const bytes = corrupted((json) => {
      json.records.filter((r: Json) => r.type === "session_state").at(-1).productVersion = "0.2.0";
    });
    expect((await loadSession(bytes, memoryContent())).ok).toBe(true);
  });

  it("compares by value, not by key order", async () => {
    const bytes = corrupted((json) => {
      const ended = revisionOf(json, "model_call");
      const { budget } = ended;
      ended.budget = Object.fromEntries(Object.entries(budget).reverse());
    });
    expect((await loadSession(bytes, memoryContent())).ok).toBe(true);
  });
});

describe("check 4: retryOf (IMPL §4.6, §4.9)", () => {
  const retries = (json: Json): Json[] => json.records.filter((r: Json) => r.retryOf !== undefined);

  it("rejects a retry of a call with another purpose", async () => {
    const bytes = corrupted((json) => {
      for (const r of retries(json)) r.retryOf = "call_0003";
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/retryOf.*purpose/),
    });
  });

  it("rejects a retry whose attempt isn't one more than the call it retries", async () => {
    const bytes = corrupted((json) => {
      for (const r of retries(json)) r.attempt = 3;
    });
    expect(await failure(bytes)).toMatchObject({
      check: 4,
      detail: expect.stringMatching(/retryOf.*attempt/),
    });
  });
});

describe("check 5: one current effort correction (IMPL §4.6, §4.9)", () => {
  it("rejects a second correction that doesn't supersede the current one", async () => {
    const bytes = corrupted((json) => {
      delete json.records.filter((r: Json) => r.type === "effort_correction").at(-1).supersedes;
    });
    expect(await failure(bytes)).toMatchObject({
      check: 5,
      detail: expect.stringMatching(/effort_correction/),
    });
  });

  it("rejects a third correction that supersedes the first, already superseded, one", async () => {
    const log = validLog();
    const [first] = log.records.filter((r) => r.type === "effort_correction");
    const file = fileOf(log);
    const third = {
      type: "effort_correction",
      id: "effc_0099",
      seq: file.records.length + 1,
      createdAt: "2026-11-01T11:00:00.000Z",
      totalMs: 3,
      reason: "Again.",
      supersedes: [first?.id],
    };
    const bytes = encode(serialiseSession({ ...file, records: [...file.records, third] } as never));
    expect(await failure(bytes)).toMatchObject({
      check: 5,
      recordId: "effc_0099",
      detail: expect.stringMatching(/current one/),
    });
  });

  it("accepts one correction that supersedes nothing", async () => {
    const bytes = corrupted((json) => {
      const corrections = json.records.filter((r: Json) => r.type === "effort_correction");
      json.records = json.records.filter((r: Json) => r !== corrections[1]);
      renumber(json);
    });
    expect((await loadSession(bytes, memoryContent())).ok).toBe(true);
  });
});

// --- Artifact revisions, reviews and target blocks (DM §9.4, §10; IMPL §4.9 checks 3, 4, 7) ---

/** A refresh in a load-test log: a new active snapshot of `text`, and its content file. */
function appendRefresh(log: SessionLog, text: string): Record<string, Uint8Array> {
  const bytes = encode(text);
  const parsed = parseGuidanceBlocks(bytes);
  const ref = contentRefOf(bytes);
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T11:00:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [{ path: "CLAUDE.md", status: "read", size: bytes.length, hash: sha256(bytes) }],
      destination: {
        state: "present",
        contentRef: ref,
        hash: sha256(bytes),
        blocks: parsed.blocks as never,
        lineEndings: parsed.lineEndings,
        roundTrip: parsed.roundTrip,
      },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    },
    { id: "snap_0002" },
  );
  return { [ref]: bytes };
}

/**
 * The target session with both recommendations accepted, a third left unselected, and an
 * artifact revision of the two, approved.
 */
function artifactLog(): { log: SessionLog; files: Record<string, Uint8Array> } {
  const { log } = targetLog();
  const revisions = log.records.filter((r) => r.type === "recommendation_revision") as unknown as {
    id: string;
    recommendationId: string;
  }[];
  const {
    id: _i,
    seq: _s,
    createdAt: _c,
    recommendationId: _r,
    revision: _v,
    ...draft
  } = revisions[0] as unknown as Record<string, unknown>;
  log.start({ ...draft, target: { kind: "newSection", heading: "Extra" } } as never);
  for (const revision of revisions)
    log.append({
      type: "selection",
      recommendationId: revision.recommendationId,
      revisionId: revision.id,
      state: "accepted",
      actor: "developer",
      selectedAt: "2026-11-01T10:30:00.000Z",
    });
  const outcome = proposeArtifact(log, DESTINATION);
  if (outcome.kind !== "created") throw new Error(outcome.kind);
  recordReview(log, {
    artifactRevisionId: outcome.artifact.id,
    contentHash: outcome.artifact.proposedHash,
    outcome: "approved",
    actor: "developer",
    reviewedAt: "2026-11-01T10:40:00.000Z",
  });
  return {
    log,
    files: { [DESTINATION_REF]: DESTINATION, [contentRefOf(outcome.content)]: outcome.content },
  };
}

/** The recommendation the artifact leaves out. */
const unselectedRevision = (json: Json) =>
  json.records.filter((r: Json) => r.type === "recommendation_revision").at(-1);

const artifactOf = (json: Json) => json.records.find((r: Json) => r.type === "artifact_revision");

async function artifactFailure(edit: (json: Json) => void): Promise<LoadFailure> {
  const { log, files } = artifactLog();
  const json = JSON.parse(serialiseSession(fileOf(log)));
  edit(json);
  return failure(encode(JSON.stringify(json)), memoryContent(files));
}

describe("artifact revisions and reviews load (DM §9.4, §10, IMPL §4.9)", () => {
  it("loads an artifact revision and its review, and derives the usable approval", async () => {
    const { log, files } = artifactLog();
    const content = memoryContent(files);
    const result = await loadSession(encode(serialiseSession(fileOf(log))), content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = currentState(result.file.records);
    expect(state.activeArtifact?.type).toBe("artifact_revision");
    expect(state.usableApproval?.outcome).toBe("approved");
  });

  it("check 3 rejects artifact revisions not numbered 1, 2, 3…", async () => {
    const found = await artifactFailure((json) => {
      artifactOf(json).revision = 2;
    });
    expect(found).toMatchObject({ check: 3, name: "envelope" });
  });

  it("check 4 rejects a dangling snapshot, selected revision, decision or attributed revision", async () => {
    const edits: Record<string, (json: Json) => void> = {
      snapshotId: (json) => {
        artifactOf(json).snapshotId = "snap_9999";
      },
      selectedRevisionIds: (json) => {
        artifactOf(json).selectedRevisionIds = ["rrev_9999"];
      },
      decisionIds: (json) => {
        artifactOf(json).decisionIds = ["dec_9999"];
      },
      attribution: (json) => {
        artifactOf(json).attribution[0].revisionId = "rrev_9999";
      },
    };
    for (const [field, edit] of Object.entries(edits))
      expect(await artifactFailure(edit), field).toMatchObject({ check: 4 });
  });

  it("check 4 rejects an artifact that selects a revision that failed validation", async () => {
    const found = await artifactFailure((json) => {
      const artifact = artifactOf(json);
      json.records.splice(json.records.indexOf(artifact), 0, {
        type: "recommendation_revision",
        id: "rrev_9998",
        seq: 0,
        createdAt: "2026-11-01T10:30:00.000Z",
        recommendationId: "rec_9998",
        revision: 1,
        status: "failed_validation",
        producedBy: "developer_edit",
        itemKey: "$edit",
        rejectedBy: ["REF-002"],
        proposed: {},
      });
      renumber(json);
      artifact.selectedRevisionIds = [...artifact.selectedRevisionIds, "rrev_9998"];
    });
    expect(found).toMatchObject({ check: 4 });
    expect(found.detail).toMatch(/failed validation/);
  });

  it("check 4 rejects repeated selected revisions or decisions", async () => {
    const selected = await artifactFailure((json) => {
      const artifact = artifactOf(json);
      artifact.selectedRevisionIds = [
        ...artifact.selectedRevisionIds,
        artifact.selectedRevisionIds[0],
      ];
    });
    expect(selected).toMatchObject({ check: 4 });
    expect(selected.detail).toMatch(/twice/);
    const decisions = await artifactFailure((json) => {
      const artifact = artifactOf(json);
      artifact.decisionIds = [...artifact.decisionIds, artifact.decisionIds[0]];
    });
    expect(decisions).toMatchObject({ check: 4 });
    expect(decisions.detail).toMatch(/twice/);
  });

  it("check 4 rejects decisionIds other than the selected revisions' decision support", async () => {
    const { log } = artifactLog();
    const json = JSON.parse(serialiseSession(fileOf(log)));
    expect(artifactOf(json).decisionIds).toHaveLength(1);
    const missing = await artifactFailure((json) => {
      artifactOf(json).decisionIds = [];
    });
    expect(missing).toMatchObject({ check: 4 });
    expect(missing.detail).toMatch(/decisionIds/);
    const other = await artifactFailure((json) => {
      // A second, unrelated decision, written before the artifact and listed by it.
      const artifact = artifactOf(json);
      const decision = json.records.find((r: Json) => r.type === "decision");
      const { questionId: _q, conflictId: _c, ...unrelated } = decision;
      json.records.splice(json.records.indexOf(artifact), 0, { ...unrelated, id: "dec_9997" });
      renumber(json);
      artifact.decisionIds = [...artifact.decisionIds, "dec_9997"];
    });
    expect(other).toMatchObject({ check: 4 });
  });

  it("check 9 rejects a selected revision the attribution and content leave out", async () => {
    const found = await artifactFailure((json) => {
      const artifact = artifactOf(json);
      artifact.selectedRevisionIds = [...artifact.selectedRevisionIds, unselectedRevision(json).id];
    });
    expect(found).toMatchObject({ check: 9, name: "assembly" });
  });

  it("check 9 rejects attribution that isn't the one assembly gives", async () => {
    const edits: Record<string, (json: Json) => void> = {
      revisionId: (json) => {
        const [first, second] = artifactOf(json).attribution;
        [first.revisionId, second.revisionId] = [second.revisionId, first.revisionId];
      },
      originalBlockId: (json) => {
        const revise = artifactOf(json).attribution.find((e: Json) => e.originalBlockId);
        revise.originalBlockId = "Guide/list-item-1";
      },
      proposedSpan: (json) => {
        artifactOf(json).attribution[0].proposedSpan.end += 1;
      },
      order: (json) => {
        artifactOf(json).attribution.reverse();
      },
    };
    for (const [name, edit] of Object.entries(edits))
      expect(await artifactFailure(edit), name).toMatchObject({ check: 9 });
  });

  it("check 9 rejects content that isn't the one assembly gives, even with a matching hash", async () => {
    const { log, files } = artifactLog();
    const other = encode("# Something else\n");
    const json = JSON.parse(serialiseSession(fileOf(log)));
    artifactOf(json).proposedContent = contentRefOf(other);
    artifactOf(json).proposedHash = sha256(other);
    const found = await failure(
      encode(JSON.stringify(json)),
      memoryContent({ ...files, [contentRefOf(other)]: other }),
    );
    expect(found).toMatchObject({ check: 9 });
  });

  it("check 4 rejects an original that isn't the artifact snapshot's destination", async () => {
    for (const original of ["absent", hashOf("e")]) {
      const found = await artifactFailure((json) => {
        artifactOf(json).original = original;
      });
      expect(found, original).toMatchObject({ check: 4 });
    }
  });

  it("check 4 rejects a review of an artifact revision that isn't in the session, or comes later", async () => {
    const dangling = await artifactFailure((json) => {
      json.records.find((r: Json) => r.type === "review").artifactRevisionId = "art_9999";
    });
    expect(dangling).toMatchObject({ check: 4 });
    const later = await artifactFailure((json) => {
      const review = json.records.find((r: Json) => r.type === "review");
      const artifact = artifactOf(json);
      json.records.splice(json.records.indexOf(review), 1);
      json.records.splice(json.records.indexOf(artifact), 0, review);
      renumber(json);
    });
    expect(later).toMatchObject({ check: 4 });
  });

  it("check 7 rejects missing or altered artifact content, and a proposedHash that doesn't match", async () => {
    const { log, files } = artifactLog();
    const bytes = encode(serialiseSession(fileOf(log)));
    const artifactRef = Object.keys(files).find((ref) => ref !== DESTINATION_REF) as string;
    const missing = await failure(bytes, memoryContent({ [DESTINATION_REF]: DESTINATION }));
    expect(missing).toMatchObject({ check: 7 });
    const altered = Uint8Array.from(files[artifactRef] as Uint8Array);
    altered[0] = 0x21;
    expect(await failure(bytes, memoryContent({ ...files, [artifactRef]: altered }))).toMatchObject(
      { check: 7 },
    );
    const wrongHash = await artifactFailure((json) => {
      artifactOf(json).proposedHash = hashOf("f");
    });
    expect(wrongHash).toMatchObject({ check: 7 });
  });
});

/** The recommend session with a `revise` of the paragraph `Use pnpm.` in the first snapshot. */
function targetLog(): { log: SessionLog; recommendationId: string } {
  const log = recommendLog();
  const base = log.records.find((r) => r.type === "recommendation_revision") as unknown as Record<
    string,
    unknown
  >;
  const { id: _i, seq: _s, createdAt: _c, recommendationId: _r, revision: _v, ...draft } = base;
  const paragraph = parseGuidanceBlocks(DESTINATION).blocks.find(
    (b) => b.blockId === "Guide/paragraph-1",
  );
  if (paragraph === undefined) throw new Error("no paragraph");
  const revision = log.start({
    ...draft,
    operation: "revise",
    target: { kind: "block", blockId: paragraph.blockId, blockHash: paragraph.hash },
    content: "Use pnpm 9.",
    references: [],
    // The answered question's decision, so the artifact records it.
    support: [
      ...(draft["support"] as unknown[]),
      { kind: "decision", decisionId: log.records.find((r) => r.type === "decision")?.id },
    ],
  } as never) as unknown as { recommendationId: string };
  return { log, recommendationId: revision.recommendationId };
}

describe("check 4: target blocks (IMPL §4.9, §4.11)", () => {
  it("rejects a first revision whose target isn't in its snapshot", async () => {
    for (const edit of [
      (target: Json) => {
        target.blockId = "Guide/paragraph-9";
      },
      (target: Json) => {
        target.blockHash = hashOf("c");
      },
    ]) {
      const json = JSON.parse(serialiseSession(fileOf(targetLog().log)));
      edit(json.records.filter((r: Json) => r.type === "recommendation_revision").at(-1).target);
      expect(await failure(encode(JSON.stringify(json)))).toMatchObject({ check: 4 });
    }
  });

  it("rejects a newSection whose heading isn't in its snapshot, and accepts one without", async () => {
    const json = JSON.parse(serialiseSession(fileOf(targetLog().log)));
    const revision = json.records.find((r: Json) => r.type === "recommendation_revision");
    expect((await loadSession(encode(JSON.stringify(json)), memoryContent())).ok).toBe(true);
    revision.target.after = { blockId: "Guide", blockHash: hashOf("d") };
    expect(await failure(encode(JSON.stringify(json)))).toMatchObject({ check: 4 });
  });

  it("accepts a target_changed invalidation after a refresh removed the target", async () => {
    const { log, recommendationId } = targetLog();
    const files = appendRefresh(log, "# Guide\n\n- Run the tests.\n");
    log.revise("recommendation_revision", recommendationId, {
      status: "invalidated",
      invalidatedReason: "target_changed",
    });
    const result = await loadSession(
      encode(serialiseSession(fileOf(log))),
      memoryContent({ [DESTINATION_REF]: DESTINATION, ...files }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an invalidation of a re-anchored target, checked against the first snapshot", async () => {
    const { log, recommendationId } = targetLog();
    const files = appendRefresh(log, "# Guide\n\n## Moved\n\nUse pnpm.\n");
    log.revise("recommendation_revision", recommendationId, {
      status: "invalidated",
      invalidatedReason: "revalidation_failed",
    });
    const result = await loadSession(
      encode(serialiseSession(fileOf(log))),
      memoryContent({ [DESTINATION_REF]: DESTINATION, ...files }),
    );
    expect(result.ok).toBe(true);
  });

  it("checks a revision that sets a new target against the snapshot active when it was made", async () => {
    const build = (blockId: string) => {
      const { log, recommendationId } = targetLog();
      const text = "# Guide\n\nUse pnpm.\n\n## New\n\nNew text.\n";
      const files = appendRefresh(log, text);
      const blocks = parseGuidanceBlocks(encode(text)).blocks;
      const block = blocks.find((b) => b.blockId === blockId) ?? blocks[0];
      if (block === undefined) throw new Error("no blocks");
      log.revise("recommendation_revision", recommendationId, {
        target: { kind: "block", blockId, blockHash: block.hash },
        content: "Changed.",
      });
      return { log, files };
    };
    const inNew = build("Guide/New/paragraph-1");
    expect(
      (
        await loadSession(
          encode(serialiseSession(fileOf(inNew.log))),
          memoryContent({ [DESTINATION_REF]: DESTINATION, ...inNew.files }),
        )
      ).ok,
    ).toBe(true);
    // Only the first snapshot has this ID with that hash.
    const json = JSON.parse(serialiseSession(fileOf(inNew.log)));
    json.records.filter((r: Json) => r.type === "recommendation_revision").at(-1).target.blockId =
      "Guide/paragraph-7";
    expect(
      await failure(
        encode(JSON.stringify(json)),
        memoryContent({ [DESTINATION_REF]: DESTINATION, ...inNew.files }),
      ),
    ).toMatchObject({ check: 4 });
  });
});

describe("the recommendation revision field list (IMPL §4.4.1)", () => {
  it("names every field of a recommendation revision but the envelope, lineage and bookkeeping", () => {
    const schema = recommendationRevisionRecord.options[0] as unknown as {
      shape: Record<string, unknown>;
    };
    const fields = Object.keys(schema.shape).filter(
      (field) => !REVISION_BOOKKEEPING.has(field) && field !== "recommendationId",
    );
    expect([...REVISION_FIELDS.recommendation_revision].sort()).toEqual(fields.sort());
  });

  it("check 3 accepts a revision that changes every listed field", async () => {
    const { log, recommendationId } = targetLog();
    const call = log.start(callDraft({ purpose: "regenerate_recommendations" }));
    log.revise("model_call", call.modelCallId, completedCall());
    const json = JSON.parse(serialiseSession(fileOf(log)));
    const finding = json.records.find((r: Json) => r.type === "finding" && r.kind === "claim");
    log.revise("recommendation_revision", recommendationId, {
      kind: "policy",
      operation: "add",
      target: { kind: "newSection", heading: "Other" },
      content: "Other.",
      rationale: "Other.",
      support: [{ kind: "finding", findingId: finding.findingId }],
      references: [],
      scope: { kind: "paths", paths: ["docs/guide.md"] },
      // `kind` is fixed by the log's types for other records; a recommendation may change it.
    } as never);
    expect((await loadSession(encode(serialiseSession(fileOf(log))), memoryContent())).ok).toBe(
      true,
    );
  });
});

// --- Apply attempts (DM §11.2; IMPL §4.4.1, §4.9 checks 3, 4 and 8, §4.11) ----------------------

/** The artifact session with an apply attempt that started and succeeded. */
function applyLog(): { log: SessionLog; files: Record<string, Uint8Array> } {
  const { log, files } = artifactLog();
  const artifact = log.records.find((r) => r.type === "artifact_revision") as {
    id: string;
    proposedHash: `sha256:${string}`;
  };
  const review = log.records.find((r) => r.type === "review") as { id: string };
  const started = log.start({
    type: "apply_attempt",
    artifactRevisionId: artifact.id,
    reviewId: review.id,
    expectedOriginal: DESTINATION_HASH,
    intendedHash: artifact.proposedHash,
    freshness: { state: "acknowledged", changedPaths: ["src/app.ts"] },
    state: "started",
    startedAt: "2026-11-01T10:50:00.000Z",
  });
  log.revise("apply_attempt", started.applyAttemptId, {
    state: "succeeded",
    resultHash: artifact.proposedHash,
    endedAt: { state: "known", value: "2026-11-01T10:50:01.000Z" },
  });
  return { log, files };
}

const attemptsOf = (json: Json) => json.records.filter((r: Json) => r.type === "apply_attempt");
const reviewOf = (json: Json) => json.records.find((r: Json) => r.type === "review");

async function applyFailure(edit: (json: Json) => void): Promise<LoadFailure> {
  const { log, files } = applyLog();
  const json = JSON.parse(serialiseSession(fileOf(log)));
  edit(json);
  return failure(encode(JSON.stringify(json)), memoryContent(files));
}

describe("apply attempts load (DM §11.2, IMPL §4.9)", () => {
  it("loads a started and a succeeded revision, and a blocked attempt", async () => {
    const { log, files } = applyLog();
    const artifact = log.records.find((r) => r.type === "artifact_revision") as {
      id: string;
      proposedHash: `sha256:${string}`;
    };
    const review = log.records.find((r) => r.type === "review") as { id: string };
    log.start({
      type: "apply_attempt",
      artifactRevisionId: artifact.id,
      reviewId: review.id,
      expectedOriginal: DESTINATION_HASH,
      intendedHash: artifact.proposedHash,
      freshness: {
        state: "blocked",
        blockers: [{ rule: "destination", from: DESTINATION_HASH, to: "absent" }],
        changedPaths: [],
      },
      state: "blocked",
      startedAt: "2026-11-01T10:51:00.000Z",
      endedAt: { state: "known", value: "2026-11-01T10:51:00.000Z" },
    });
    const result = await loadSession(encode(serialiseSession(fileOf(log))), memoryContent(files));
    expect(result.ok).toBe(true);
  });

  it("check 2 rejects a succeeded attempt without a resultHash, and a failed one without an error", async () => {
    const missingResult = await applyFailure((json) => {
      delete attemptsOf(json)[1].resultHash;
    });
    expect(missingResult).toMatchObject({ check: 2 });
    const missingError = await applyFailure((json) => {
      const ended = attemptsOf(json)[1];
      ended.state = "failed";
      delete ended.resultHash;
    });
    expect(missingError).toMatchObject({ check: 2 });
  });

  it("check 2 rejects a started attempt recorded with an unacknowledged warning", async () => {
    const found = await applyFailure((json) => {
      attemptsOf(json)[0].freshness = { state: "warn", changedPaths: ["src/app.ts"] };
    });
    expect(found).toMatchObject({ check: 2 });
  });

  it("check 3 rejects a revision that changes what an apply attempt fixes", async () => {
    const found = await applyFailure((json) => {
      attemptsOf(json)[1].freshness = { state: "fresh" };
    });
    expect(found).toMatchObject({ check: 3, name: "envelope" });
  });

  it("check 4 rejects a dangling or later artifact revision or review", async () => {
    const dangling = await applyFailure((json) => {
      for (const attempt of attemptsOf(json)) attempt.artifactRevisionId = "art_9999";
    });
    expect(dangling).toMatchObject({ check: 4, name: "references" });
    const missingReview = await applyFailure((json) => {
      for (const attempt of attemptsOf(json)) attempt.reviewId = "revw_9999";
    });
    expect(missingReview).toMatchObject({ check: 4, name: "references" });
    const later = await applyFailure((json) => {
      const review = reviewOf(json);
      json.records.splice(json.records.indexOf(review), 1);
      json.records.push(review);
      renumber(json);
    });
    expect(later).toMatchObject({ check: 4, name: "references" });
    expect(later.detail).toMatch(/later/);
  });

  it("check 4 rejects a review of another artifact revision", async () => {
    const found = await applyFailure((json) => {
      const artifact = artifactOf(json);
      const review = reviewOf(json);
      const copy = { ...artifact, id: "art_9000", revision: 2 };
      json.records.splice(json.records.indexOf(review) + 1, 0, copy);
      renumber(json);
      for (const attempt of attemptsOf(json)) attempt.artifactRevisionId = copy.id;
    });
    expect(found).toMatchObject({ check: 4, name: "references" });
    expect(found.detail).toMatch(/review of another artifact revision/);
  });

  it("check 8 rejects an apply attempt without a matching approved review (IMPL §4.11)", async () => {
    const rejected = await applyFailure((json) => {
      reviewOf(json).outcome = "rejected";
    });
    expect(rejected).toMatchObject({ check: 8, name: "state" });
    const otherHash = await applyFailure((json) => {
      reviewOf(json).contentHash = hashOf("e");
    });
    expect(otherHash).toMatchObject({ check: 8, name: "state" });
  });

  it("check 8 rejects an expectedOriginal, intendedHash or resultHash that isn't the artifact's", async () => {
    const edits: Record<string, (json: Json) => void> = {
      expectedOriginal: (json) => {
        for (const attempt of attemptsOf(json)) attempt.expectedOriginal = "absent";
      },
      intendedHash: (json) => {
        for (const attempt of attemptsOf(json)) attempt.intendedHash = hashOf("e");
      },
      resultHash: (json) => {
        attemptsOf(json)[1].resultHash = hashOf("e");
      },
    };
    for (const [field, edit] of Object.entries(edits)) {
      const found = await applyFailure(edit);
      expect(found, field).toMatchObject({ check: 8, name: "state" });
      expect(found.detail, field).toMatch(field);
    }
  });
});

describe("the apply-attempt field list (IMPL §4.4.1)", () => {
  it("lets a revision change only state, error, resultHash and endedAt", () => {
    expect([...REVISION_FIELDS.apply_attempt].sort()).toEqual(
      ["endedAt", "error", "resultHash", "state"].sort(),
    );
  });
});

describe("session format 2 (IMPL §4.4.1, §4.6, §4.9, §4.11)", () => {
  const loads = async (log: SessionLog) =>
    (await loadSession(encode(serialiseSession(fileOf(log))), memoryContent())).ok;
  const edited = (log: SessionLog, edit: (json: Json) => void) => {
    const json = JSON.parse(serialiseSession(fileOf(log)));
    edit(json);
    return encode(JSON.stringify(json));
  };
  const call = (json: Json) => json.records.find((r: Json) => r.type === "model_call");
  const ended = (json: Json) =>
    json.records.find((r: Json) => r.type === "model_call" && r.state === "completed");

  it("a model call records apiVersion and its price table, and a known cost is only estimated", async () => {
    expect(await loads(validLog())).toBe(true);
    for (const edit of [
      (j: Json) => delete call(j).apiVersion,
      (j: Json) => delete call(j).priceTable,
      (j: Json) => {
        call(j).priceTable.date = "9 November 2026";
      },
      (j: Json) => {
        ended(j).cost.value.basis = "reported";
      },
    ])
      expect(await failure(corrupted(edit))).toMatchObject({ check: 2 });
  });

  it("generation_config records effort, outside settingsHash", async () => {
    for (const edit of [
      (j: Json) => delete byId(j, "gc_0001").effort,
      (j: Json) => {
        byId(j, "gc_0001").effort = "extreme";
      },
    ])
      expect(await failure(corrupted(edit))).toMatchObject({ check: 2 });
  });

  it("generation_config holds reservedOutputTokens and safetyMargin in the settings settingsHash covers", async () => {
    for (const edit of [
      (j: Json) => delete byId(j, "gc_0001").settings.tokens,
      (j: Json) => delete byId(j, "gc_0001").settings.tokens.reservedOutputTokens.analyse,
      (j: Json) => {
        byId(j, "gc_0001").settings.tokens.safetyMargin = 1;
      },
    ])
      expect(await failure(corrupted(edit))).toMatchObject({ check: 2 });
  });

  it("unsentPurpose is refused on any stage_skipped except the skipped call 2", async () => {
    const log = validLog();
    log.revise("session_state", "session_state", {
      status: "running",
      reason: "stage_skipped",
      unsentPurpose: "analyse_expansion",
    });
    expect(await loads(log)).toBe(true);
    expect(() =>
      validLog().revise("session_state", "session_state", {
        reason: "stage_skipped",
        unsentPurpose: "recommend",
      }),
    ).toThrow(/unsentPurpose/);
    expect(() =>
      validLog().revise("session_state", "session_state", {
        reason: "interrupted",
        unsentPurpose: "analyse_expansion",
      }),
    ).toThrow(/unsentPurpose/);
    // A stage the developer skipped names no purpose.
    const skipped = validLog();
    skipped.revise("session_state", "session_state", { reason: "stage_skipped" });
    expect(await loads(skipped)).toBe(true);
    const bytes = edited(log, (j) => {
      j.records.findLast((r: Json) => r.type === "session_state").unsentPurpose = "recommend";
    });
    expect(await failure(bytes)).toMatchObject({ check: 2 });
  });

  /** The valid session with the output limit of `analyse` raised to `to`. */
  function raised(to = 20_000): SessionLog {
    const log = validLog();
    const tokens = TEST_SETTINGS.tokens;
    log.revise("generation_config", "generation_config", {
      reason: "output_limit_raised",
      settings: {
        ...TEST_SETTINGS,
        tokens: {
          ...tokens,
          reservedOutputTokens: { ...tokens.reservedOutputTokens, analyse: to },
        },
      },
      settingsHash: hashOf("8"),
    });
    return log;
  }
  const raise = (json: Json) => json.records.findLast((r: Json) => r.type === "generation_config");

  it("loads an output_limit_raised revision that raises a limit and changes only the limits and settingsHash", async () => {
    expect(await loads(raised())).toBe(true);
  });

  it("check 3 refuses an output_limit_raised revision that changes anything else, or lowers a limit", async () => {
    const cases: [string, (json: Json) => void][] = [
      [
        "the budget",
        (j) => {
          raise(j).budget = { maxCostUsd: 9 };
        },
      ],
      [
        "another setting",
        (j) => {
          raise(j).settings.context.treeDepth = 7;
        },
      ],
      [
        "the safety margin",
        (j) => {
          raise(j).settings.tokens.safetyMargin = 0.1;
        },
      ],
      [
        "a lowered limit",
        (j) => {
          raise(j).settings.tokens.reservedOutputTokens.recommend = 8_000;
        },
      ],
      [
        "the model",
        (j) => {
          raise(j).requestedModel = "claude-other";
        },
      ],
    ];
    for (const [what, edit] of cases)
      expect(await failure(edited(raised(), edit)), what).toMatchObject({ check: 3 });
    // Raising nothing isn't a raise. The log refuses to append one, so the file is edited.
    expect(() => raised(16_000)).toThrow(/raises one/);
    const unchanged = edited(raised(), (j) => {
      raise(j).settings.tokens.reservedOutputTokens.analyse = 16_000;
    });
    expect(await failure(unchanged)).toMatchObject({ check: 3 });
  });

  it("a raise changes settingsHash, which covers the limits", async () => {
    expect(() =>
      validLog().revise("generation_config", "generation_config", {
        reason: "output_limit_raised",
        settings: {
          ...TEST_SETTINGS,
          tokens: {
            ...TEST_SETTINGS.tokens,
            reservedOutputTokens: { ...TEST_SETTINGS.tokens.reservedOutputTokens, analyse: 20_000 },
          },
        },
      }),
    ).toThrow(/changes settingsHash/);
    const bytes = edited(raised(), (j) => {
      raise(j).settingsHash = byId(j, "gc_0001").settingsHash;
    });
    expect(await failure(bytes)).toMatchObject({ check: 3 });
  });

  it("round-trips a session with a secret_withheld and a secret_match invalidation, byte for byte", async () => {
    const log = invalidated("secret_match", "aws-access-key-id");
    log.append({ type: "secret_withheld", itemId: "fnd_0001", secretRuleId: "github-token" });
    const bytes = encode(serialiseSession(fileOf(log)));
    const result = await loadSession(bytes, memoryContent());
    if (!result.ok) throw new Error(result.failure.detail);
    expect(encode(serialiseSession(result.file))).toEqual(bytes);
  });

  it("check 3 refuses a budget revision that changes the settings", async () => {
    const bytes = corrupted((j) => {
      byId(j, "gc_0002").settings.tokens.reservedOutputTokens.analyse = 20_000;
      byId(j, "gc_0002").settingsHash = hashOf("8");
    });
    expect(await failure(bytes)).toMatchObject({ check: 3 });
  });

  it("the log refuses a generation_config revision that changes what its reason doesn't allow", () => {
    expect(() =>
      validLog().revise("generation_config", "generation_config", {
        reason: "budget_raised",
        settingsHash: hashOf("8"),
      }),
    ).toThrow(/can't change settingsHash/);
    expect(() =>
      validLog().revise("generation_config", "generation_config", {
        reason: "output_limit_raised",
        budget: { maxCostUsd: 9 },
      }),
    ).toThrow(/can't change budget/);
  });

  function invalidated(reason: "secret_match" | "dropped_by_model", secretRuleId?: string) {
    const log = recommendLog();
    const revision = log.records.find((r) => r.type === "recommendation_revision") as {
      recommendationId: string;
    };
    log.revise("recommendation_revision", revision.recommendationId, {
      status: "invalidated",
      invalidatedReason: reason,
      ...(secretRuleId === undefined ? {} : { secretRuleId }),
    });
    return log;
  }

  it("a secret_match invalidation records the rule in secretRuleId, and only it does", async () => {
    expect(await loads(invalidated("secret_match", "aws-access-key-id"))).toBe(true);
    expect(() => invalidated("secret_match")).toThrow(/secretRuleId/);
    expect(() => invalidated("dropped_by_model", "aws-access-key-id")).toThrow(/secretRuleId/);
    const bytes = edited(invalidated("secret_match", "aws-access-key-id"), (j) => {
      const r = j.records.findLast((x: Json) => x.type === "recommendation_revision");
      delete r.secretRuleId;
    });
    expect(await failure(bytes)).toMatchObject({ check: 2 });
  });

  it("check 3 refuses secretRuleId on a revision that isn't its invalidation", async () => {
    const bytes = edited(invalidated("secret_match", "aws-access-key-id"), (j) => {
      const r = j.records.findLast((x: Json) => x.type === "recommendation_revision");
      r.rationale = "Changed on invalidation.";
    });
    expect(await failure(bytes)).toMatchObject({ check: 3 });
  });

  const withheld = (itemId: string) => {
    const log = validLog();
    log.append({ type: "secret_withheld", itemId, secretRuleId: "github-token" });
    return log;
  };

  it("loads a secret_withheld naming a finding, a conflict, a question or a decision", async () => {
    for (const itemId of ["fnd_0001", "conf_0001", "q_0001", "dec_0001"])
      expect(await loads(withheld(itemId)), itemId).toBe(true);
  });

  it("check 4 rejects a secret_withheld naming anything else", async () => {
    for (const itemId of ["fnd_9999", "conf_9999", "q_9999", "dec_9999"])
      expect(
        await failure(
          edited(withheld("fnd_0001"), (j) => {
            j.records.at(-1).itemId = itemId;
          }),
        ),
        itemId,
      ).toMatchObject({ check: 4 });
    // A finding's record ID, or a recommendation, isn't an item it can name.
    for (const itemId of ["fndr_0001", "rec_0001", "call_0001"])
      expect(
        await failure(
          edited(withheld("fnd_0001"), (j) => {
            j.records.at(-1).itemId = itemId;
          }),
        ),
        itemId,
      ).toMatchObject({ check: 2 });
  });

  it("check 4 rejects a secret_withheld before the item it names", async () => {
    const bytes = edited(withheld("dec_0001"), (j) => {
      const sw = j.records.pop();
      j.records.splice(1, 0, sw);
      renumber(j);
    });
    expect(await failure(bytes)).toMatchObject({ check: 4 });
  });

  it("a secret_withheld is never superseded", async () => {
    const bytes = edited(withheld("fnd_0001"), (j) => {
      const sw = j.records.at(-1);
      j.records.push({ ...sw, id: "sw_0002", seq: sw.seq + 1, supersedes: [sw.id] });
    });
    expect(await failure(bytes)).toMatchObject({ check: 2 });
  });

  it("citation counts may be unknown because no response was parsed", async () => {
    for (const reason of ["truncated", "refusal", "unexpected_stop", "no_response"]) {
      const log = validLog();
      const started = log.start(callDraft());
      log.revise(
        "model_call",
        started.modelCallId,
        completedCall({
          state: "failed",
          citationsProposed: { state: "unknown", reason },
          correctedCitationRate: { state: "unknown", reason },
          counts: {
            proposed: { state: "unknown", reason },
            accepted: 0,
            corrected: 0,
            relabelled: 0,
            rejectedByRule: {},
          },
        } as never),
      );
      expect(await loads(log), reason).toBe(true);
    }
    expect(() => {
      const log = validLog();
      const started = log.start(callDraft());
      log.revise(
        "model_call",
        started.modelCallId,
        completedCall({ citationsProposed: { state: "unknown", reason: "bored" } } as never),
      );
    }).toThrow(/invalid model_call/);
    expect(() => {
      const log = validLog();
      const started = log.start(callDraft());
      log.revise(
        "model_call",
        started.modelCallId,
        completedCall({
          counts: {
            proposed: { state: "unknown", reason: "bored" },
            accepted: 0,
            corrected: 0,
            relabelled: 0,
            rejectedByRule: {},
          },
        } as never),
      );
    }).toThrow(/invalid model_call/);
  });
});
