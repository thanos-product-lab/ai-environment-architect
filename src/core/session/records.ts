import { z } from "zod";
import { ANALYSE_COLLECTION_LIMITS } from "../../schemas/analyse.js";
import type { Hash } from "../hash.js";

// Session records (IMPL §4.3–§4.5; DM §5–§8). The session file is a header and an append-only
// list of immutable records. Every record shares an envelope: `type`, `id`, `seq`, `createdAt`.
// A record that can change has a lineage ID as well, shared by its revisions, and a `revision`.
//
// This step defines the records §4.4–§4.5 produce. The other types in the §4.4.1 table have
// their prefixes here, and get their fields with their own steps: model calls and effort (IMPL
// §4.6), purges (§4.8), and recommendations, selections, artifacts, reviews and apply (M5).
// Until then the file schema doesn't accept them.

export const SESSION_FORMAT = "ai-environment-architect/session";
export const SESSION_SCHEMA_VERSION = 1;

/** One row of the §4.4.1 table: the record ID prefix, and the lineage field and prefix if any. */
export interface RecordKind {
  readonly record: string;
  readonly lineage?: { readonly field: string; readonly prefix: string };
  /**
   * Numbered and chained within the session, with no lineage field: `session_state` and
   * `generation_config`.
   */
  readonly sessionLineage?: true;
}

export const RECORD_KINDS = {
  session_state: { record: "st", sessionLineage: true },
  generation_config: { record: "gc", sessionLineage: true },
  snapshot: { record: "snap" },
  content_notice: { record: "cn" },
  evidence: { record: "ev" },
  finding: { record: "fndr", lineage: { field: "findingId", prefix: "fnd" } },
  conflict: { record: "confr", lineage: { field: "conflictId", prefix: "conf" } },
  question: { record: "qr", lineage: { field: "questionId", prefix: "q" } },
  decision: { record: "dec" },
  recommendation_revision: {
    record: "rrev",
    lineage: { field: "recommendationId", prefix: "rec" },
  },
  held_back: { record: "hb" },
  no_change_reason: { record: "ncr" },
  selection: { record: "sel" },
  artifact_revision: { record: "art" },
  review: { record: "revw" },
  apply_attempt: { record: "applyr", lineage: { field: "applyAttemptId", prefix: "apply" } },
  model_call: { record: "callr", lineage: { field: "modelCallId", prefix: "call" } },
  effort_interval: { record: "effr", lineage: { field: "effortIntervalId", prefix: "eff" } },
  effort_correction: { record: "effc" },
  failed_item: { record: "fail" },
  inputs_purged: { record: "pur" },
} as const satisfies Record<string, RecordKind>;

export type RecordTypeName = keyof typeof RECORD_KINDS;

// --- Building blocks -------------------------------------------------------------------------

const HASH = /^sha256:[0-9a-f]{64}$/;
export const hash = z.custom<Hash>((value) => typeof value === "string" && HASH.test(value), {
  message: "a sha256:<64 hex> hash",
});

/** ISO 8601 UTC with milliseconds, as the injected clock gives it (§4.3). */
export const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** An ID from the injected `IdSource`: the prefix, `_`, and an opaque suffix (§4.4.1). */
export const idWith = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-Za-z-]+$`));

const recordId = (type: RecordTypeName) => idWith(RECORD_KINDS[type].record);
const lineageId = (prefix: string) => idWith(prefix);
const anyRecordId = z.string().regex(/^[a-z]+_[0-9A-Za-z-]+$/);

/** Content-addressed file in the session directory (§4.2). */
export const contentRef = z.string().regex(/^content\/sha256-[0-9a-f]{64}$/);

const count = z.int().min(0);
const lineNumber = z.int().min(1);
const nonEmpty = z.string().min(1);

/** A path, or its hash when the secret scan withholds the name (IMPL §1.7). */
export const recordedPath = z.union([
  z.strictObject({ path: z.string() }),
  z.strictObject({ pathHash: hash }),
]);

export const scope = z.union([
  z.strictObject({ kind: z.literal("repository") }),
  z.strictObject({ kind: z.literal("paths"), paths: z.array(z.string()).min(1) }),
]);

export const basis = z.enum(["documentation", "code_observation", "existing_guidance"]);

export const callPurpose = z.enum([
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
]);

/** `producedBy` for a model call: the call's lineage ID (§4.4.1). */
const modelCallId = lineageId(RECORD_KINDS.model_call.lineage.prefix);
/**
 * The model call that appended a revision after the first, when one did: `producedBy` stays the
 * call that created the lineage (§4.4.1). Never repeated from the revision before.
 */
const revisedBy = modelCallId.optional();
const findingId = lineageId(RECORD_KINDS.finding.lineage.prefix);
const conflictId = lineageId(RECORD_KINDS.conflict.lineage.prefix);
const questionId = lineageId(RECORD_KINDS.question.lineage.prefix);

const envelope = <T extends RecordTypeName>(type: T) => ({
  type: z.literal(type),
  id: recordId(type),
  seq: z.int().min(1),
  createdAt: timestamp,
});

/** Revision fields. `supersedes` is absent on a first revision that replaces nothing. */
const revisioned = {
  revision: z.int().min(1),
  supersedes: z.array(anyRecordId).min(1).optional(),
};

/**
 * An item that failed validation (§4.4.3): the envelope, and only these fields. `proposed` is
 * the item exactly as written after the schema stage, its aliases and local keys unresolved.
 */
const failedFields = {
  status: z.literal("failed_validation"),
  itemKey: nonEmpty,
  rejectedBy: z.array(nonEmpty).min(1),
  proposed: z.json(),
};

// --- Session state and configuration (§4.4.1, DM §5) -----------------------------------------

export const stage = z.enum(["inspect", "clarify", "recommend", "review", "apply", "complete"]);
export const status = z.enum([
  "ready",
  "running",
  "awaiting_user",
  "blocked",
  "failed",
  "completed",
  "cancelled",
]);
export const outcome = z.enum(["applied", "no_change", "failed", "cancelled"]);

export const sessionStateRecord = z
  .strictObject({
    ...envelope("session_state"),
    ...revisioned,
    productVersion: nonEmpty,
    stage,
    status,
    outcome: outcome.optional(),
    /** Set when the change isn't a normal step. */
    reason: z.enum(["interrupted", "budget_reached", "stage_skipped"]).optional(),
    /** With `budget_reached`: the purpose of the call the budget left unsent. */
    unsentPurpose: callPurpose.optional(),
  })
  .refine((r) => (r.reason === "budget_reached") === (r.unsentPurpose !== undefined), {
    message: "unsentPurpose is set exactly when the reason is budget_reached",
    path: ["unsentPurpose"],
  });

const snapshotSettings = z.strictObject({
  maxReadableFileBytes: z.int().min(1),
  userExclusions: z.array(z.string()),
  sessionStoragePath: z.string().optional(),
  includeIgnored: z.array(z.string()),
});

const contextSettings = z.strictObject({
  initialContextBytes: count,
  knownFactsBytes: count,
  tierCaps: z.strictObject({
    tier1: count,
    tier2: count,
    tier3: count,
    tier4: count,
    tier5: count,
  }),
  maxDestinationBytes: count,
  perFileCaps: z.strictObject({ tier2: count, tier3: count, tier5: count }),
  testReserveBytes: count,
  testExampleBytes: count,
  maxSourceFiles: count,
  sourceExtensions: z.array(z.string()),
  treeDepth: count,
  treeCollapseThreshold: count,
});

/** The effective selection settings, whose canonical JSON gives `settingsHash` (IMPL §1.3). */
export const selectionSettings = z.strictObject({
  snapshot: snapshotSettings,
  context: contextSettings,
});

export const generationConfigRecord = z.strictObject({
  ...envelope("generation_config"),
  ...revisioned,
  /** Why a revision after the first was appended, such as raising the budget (§2.12). */
  reason: nonEmpty.optional(),
  settings: selectionSettings,
  settingsHash: hash,
  requestedModel: nonEmpty,
  /** The generation budget: a token ceiling, a cost ceiling in USD, both or neither. */
  budget: z.strictObject({
    maxTokens: z.int().min(1).optional(),
    maxCostUsd: z.number().positive().optional(),
  }),
  /** IMPL §1.8. Not part of `settingsHash`, which covers the initial context only. */
  expansion: z.strictObject({
    maxExpansionRequests: z.int().min(0).max(ANALYSE_COLLECTION_LIMITS.expansionRequests),
    expansionBytes: count,
    expansionEntryBytes: count,
  }),
  questionBudget: count,
  retainModelInputs: z.boolean(),
});

// --- Snapshot (DM §6.1, §7) ------------------------------------------------------------------

const entryKind = z.enum(["file", "directory", "symlink", "other"]);
const failureReason = z.enum(["not_found", "permission_denied", "not_regular_file", "io_error"]);
const readFailureReason = z.union([failureReason, z.literal("path_not_utf8")]);
const listedOnlyReason = z.enum(["too_large", "contains_nul", "not_utf8"]);
const gitUnknownReason = z.enum([
  "not_inspected",
  "git_missing",
  "git_too_old",
  "not_a_repository",
  "unsafe_repository",
  "git_error",
]);

export const snapshotFile = z.union([
  z.strictObject({ path: z.string(), status: z.literal("read"), size: count, hash }),
  z.strictObject({
    path: z.string(),
    status: z.literal("listed_only"),
    size: count,
    hash,
    reason: listedOnlyReason,
  }),
  z.strictObject({
    path: z.string(),
    status: z.literal("ignored"),
    kind: z.literal("file"),
    size: count,
    hash,
  }),
  z.strictObject({ path: z.string(), status: z.literal("ignored"), kind: z.literal("directory") }),
  z.strictObject({
    path: z.string(),
    status: z.literal("excluded"),
    kind: entryKind,
    rule: z.string(),
  }),
  z.strictObject({ path: z.string(), status: z.literal("symlink"), target: z.string() }),
  z.strictObject({
    path: z.string(),
    status: z.literal("unreadable"),
    kind: entryKind,
    reason: readFailureReason,
  }),
]);

export const exclusionRule = z.strictObject({
  pattern: z.string(),
  source: z.enum(["default", "user", "session_storage"]),
  group: z.enum([
    "version_control",
    "dependencies",
    "build_output",
    "lockfiles",
    "secret_names",
    "personal_agent_config",
    "binary_and_media",
    "user",
    "session_storage",
  ]),
  except: z.array(z.string()).optional(),
  ignoreCase: z.boolean(),
});

const blockFields = {
  blockId: z.string(),
  headingPath: z.array(z.string()),
  sourceSpan: z.strictObject({ start: count, end: count }),
  hash,
};

export const guidanceBlock = z.union([
  z.strictObject({
    ...blockFields,
    type: z.enum(["heading", "paragraph", "code_block", "other"]),
  }),
  z.strictObject({
    ...blockFields,
    type: z.literal("list_item"),
    listMarker: z.strictObject({ indent: z.string(), marker: z.string() }),
  }),
]);

const destination = z.union([
  z.strictObject({ state: z.literal("absent") }),
  /** The bytes are in `content/`; never inlined (§4.3). */
  z.strictObject({
    state: z.literal("present"),
    contentRef,
    hash,
    blocks: z.array(guidanceBlock),
    lineEndings: z.strictObject({
      style: z.enum(["lf", "crlf", "cr", "mixed", "none"]),
      counts: z.strictObject({ lf: count, crlf: count, cr: count }),
    }),
    roundTrip: z.union([
      z.strictObject({ state: z.literal("verified") }),
      z.strictObject({
        state: z.literal("failed"),
        reason: z.enum([
          "parser_error",
          "span_order",
          "content_outside_blocks",
          "hash_mismatch",
          "duplicate_block_id",
          "rebuild_mismatch",
        ]),
      }),
    ]),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.union([
      z.literal("symlink"),
      listedOnlyReason,
      z.literal("case_variant"),
      failureReason,
    ]),
  }),
]);

export const gitMetadata = z.union([
  z.strictObject({ state: z.literal("unknown"), reason: gitUnknownReason }),
  z.strictObject({
    state: z.literal("known"),
    objectFormat: z.enum(["sha1", "sha256"]),
    commit: z.string().nullable(),
    workingTreeDirty: z.union([z.boolean(), z.literal("unknown")]),
    modifiedPaths: z.array(z.string()),
    deletedPaths: z.array(z.string()),
    untrackedCount: count,
    uncomparedPaths: z.array(z.string()),
    submodules: z.array(z.string()),
  }),
]);

export const ignoreRules = z.union([
  z.strictObject({ state: z.literal("applied") }),
  z.strictObject({ state: z.literal("not_applied"), reason: gitUnknownReason }),
]);

/** Immutable. A refresh appends a new snapshot (DM §6.1); the latest is active (§4.4.2). */
export const snapshotRecord = z.strictObject({
  ...envelope("snapshot"),
  capturedAt: timestamp,
  scope: z.strictObject({ roots: z.array(z.string()) }),
  exclusions: z.array(exclusionRule),
  files: z.array(snapshotFile),
  destination,
  readFailures: z.array(z.strictObject({ path: z.string(), reason: readFailureReason })),
  stability: z.union([
    z.strictObject({ state: z.literal("stable") }),
    z.strictObject({ state: z.literal("unstable"), changedPaths: z.array(z.string()) }),
  ]),
  git: gitMetadata,
  ignoreRules,
});

// --- Evidence and content notices (DM §6.2, IMPL §3.3.2 step 10, §4.5) -----------------------

const snapshotId = recordId("snapshot");
const lineRangeText = z.string().regex(/^[1-9][0-9]*-[1-9][0-9]*$/);

export const evidenceRecord = z.union([
  z.strictObject({
    ...envelope("evidence"),
    snapshotId,
    kind: z.literal("lines"),
    path: z.string(),
    fileHash: hash,
    lineStart: lineNumber,
    lineEnd: lineNumber,
    excerpt: z.string(),
    basis,
    /** A `CIT-R01` correction records both ranges (DM §6.2). */
    correction: z
      .strictObject({ originalLines: lineRangeText, correctedLines: lineRangeText })
      .optional(),
  }),
  z.strictObject({
    ...envelope("evidence"),
    snapshotId,
    kind: z.literal("entry"),
    path: z.string(),
    fileHash: hash,
    basis: z.literal("code_observation"),
  }),
  /** The file-list check behind an accepted absence claim. No path, hash, lines or excerpt. */
  z.strictObject({
    ...envelope("evidence"),
    snapshotId,
    kind: z.literal("absence_check"),
    /** After the path normalisation of IMPL §1.11. */
    pathGlob: z.string(),
    /** In path order; a withheld one by hash. */
    unenteredDirectories: z.array(recordedPath),
    basis: z.literal("code_observation"),
  }),
]);

/** Immutable. Refers to the snapshot, which stays immutable. Never changes behaviour. */
export const contentNoticeRecord = z.strictObject({
  ...envelope("content_notice"),
  snapshotId,
  modelCallId,
  /** The `T` or `E` alias the notice named, resolved by code to the path and hash below. */
  item: z.string(),
  path: z.string(),
  fileHash: hash,
  lineStart: lineNumber,
  lineEnd: lineNumber,
  description: z.string(),
});

// --- Findings (DM §6.3, IMPL §4.4.3, §4.5) ---------------------------------------------------

const findingProducedBy = z.union([modelCallId, z.literal("deterministic")]);
const findingStatus = z.enum(["active", "withdrawn"]);
const findingWithdrawnReason = z.enum(["withdrawn_by_model"]);

const findingRevision = {
  ...envelope("finding"),
  findingId,
  ...revisioned,
  snapshotId,
  producedBy: findingProducedBy,
  status: findingStatus,
  withdrawnReason: findingWithdrawnReason.optional(),
  revisedBy,
  evidenceIds: z.array(recordId("evidence")),
};

/** A citation as proposed that failed, or was merged into an earlier one (`CIT-009`). */
export const failedCitation = z.strictObject({
  item: z.string(),
  lines: z.string(),
  quote: z.string(),
  rejectedBy: z.array(nonEmpty).min(1),
});

const commandKind = z.enum(["script", "target", "recipe", "task"]);

/** What a known fact records about its source (IMPL §3.2.5). */
export const knownFactDetail = z.union([
  z.strictObject({
    type: z.literal("agent_configuration"),
    path: z.string(),
    importedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("workspace_package"),
    path: z.string(),
    declaredIn: z.string(),
  }),
  z.strictObject({
    type: z.literal("command"),
    file: z.string(),
    kind: commandKind,
    name: z.string(),
    status: z.literal("found_not_run"),
  }),
]);

export const gapCoverage = z.union([
  z.strictObject({ state: z.literal("inspected") }),
  z.strictObject({
    state: z.literal("not_inspected"),
    entries: z.array(recordedPath),
    directories: z.array(recordedPath),
  }),
]);

const gapType = z.enum([
  "no_command",
  "no_documentation",
  "undetermined_ownership",
  "undetermined_convention",
  "other",
]);

const claimFinding = z.strictObject({
  ...findingRevision,
  kind: z.literal("claim"),
  statement: z.string(),
  mode: z.enum(["descriptive", "prescriptive"]),
  scope,
  /** Derived from the evidence: the set of its bases (IMPL §3.2.4). */
  basis: z.array(basis).min(1),
  evidenceIds: z.array(recordId("evidence")).min(1),
  uncertainty: z.string().optional(),
  /** Model-produced findings only (DM §6.3). */
  droppedCitations: count.optional(),
  failedCitations: z.array(failedCitation).optional(),
  /** Known facts only. */
  fact: knownFactDetail.optional(),
});

const gapFinding = z.strictObject({
  ...findingRevision,
  kind: z.literal("gap"),
  statement: z.string(),
  gapType,
  /** Shown names; withheld ones are in `relatedPathHashes` (IMPL §1.7). */
  relatedPaths: z.array(z.string()),
  relatedPathHashes: z.array(hash).optional(),
  coverage: gapCoverage,
});

const absenceFinding = z.strictObject({
  ...findingRevision,
  kind: z.literal("absence"),
  /** Written by code, never by the model (IMPL §1.11). */
  statement: z.string(),
  /** The glob as the model wrote it, as the statement quotes it. */
  pathGlob: z.string(),
  /** The model's reason, not shown as the claim. */
  reason: z.string(),
  basis: z.tuple([z.literal("code_observation")]),
  evidenceIds: z.tuple([recordId("evidence")]),
});

const failedFinding = z.strictObject({
  ...envelope("finding"),
  ...failedFields,
  kind: z.enum(["claim", "gap", "absence"]),
  producedBy: modelCallId,
});

const withdrawnHasReason = (r: { status: string; withdrawnReason?: string | undefined }) =>
  (r.status === "withdrawn") === (r.withdrawnReason !== undefined);
const withdrawnMessage = { message: "withdrawnReason is set exactly when withdrawn" };
const revisedLater = (r: { revision: number; revisedBy?: string | undefined }) =>
  r.revisedBy === undefined || r.revision > 1;
const revisedMessage = { message: "revisedBy is set only on a revision after the first" };

export const findingRecord = z.union([
  claimFinding.refine(withdrawnHasReason, withdrawnMessage).refine(revisedLater, revisedMessage),
  gapFinding.refine(withdrawnHasReason, withdrawnMessage).refine(revisedLater, revisedMessage),
  absenceFinding.refine(withdrawnHasReason, withdrawnMessage).refine(revisedLater, revisedMessage),
  failedFinding,
]);

// --- Conflicts (DM §6.5, IMPL §4.5) ----------------------------------------------------------

export const conflictWithdrawnReason = z.enum([
  "withdrawn_by_model",
  "member_withdrawn",
  "members_merged",
  "sources_not_distinct",
]);

const conflictRevision = z
  .strictObject({
    ...envelope("conflict"),
    conflictId,
    ...revisioned,
    snapshotId,
    producedBy: modelCallId,
    revisedBy,
    findingIds: z.array(findingId).min(2),
    description: z.string(),
    status: z.enum(["unresolved", "resolved", "withdrawn"]),
    withdrawnReason: conflictWithdrawnReason.optional(),
    resolvingDecisionId: recordId("decision").optional(),
  })
  .refine(withdrawnHasReason, withdrawnMessage)
  .refine(revisedLater, revisedMessage)
  .refine((r) => (r.status === "resolved") === (r.resolvingDecisionId !== undefined), {
    message: "resolvingDecisionId is set exactly when resolved",
  });

const failedConflict = z.strictObject({
  ...envelope("conflict"),
  ...failedFields,
  producedBy: modelCallId,
});

export const conflictRecord = z.union([conflictRevision, failedConflict]);

// --- Questions and decisions (DM §8) ---------------------------------------------------------

const questionRevision = z
  .strictObject({
    ...envelope("question"),
    questionId,
    ...revisioned,
    producedBy: modelCallId,
    prompt: z.string(),
    reason: z.string(),
    findingIds: z.array(findingId),
    conflictIds: z.array(conflictId),
    gapIds: z.array(findingId),
    /** Suggested answers; always presented as suggestions. */
    options: z.array(z.strictObject({ label: z.string() })),
    scope,
    status: z.enum(["open", "answered", "skipped", "unreached"]),
    unreachedReason: z.enum(["session_ended", "budget"]).optional(),
  })
  .refine((r) => (r.status === "unreached") === (r.unreachedReason !== undefined), {
    message: "unreachedReason is set exactly when unreached",
  });

const failedQuestion = z.strictObject({
  ...envelope("question"),
  ...failedFields,
  producedBy: modelCallId,
});

export const questionRecord = z.union([questionRevision, failedQuestion]);

/** No lineage: a correction is a new decision whose `supersedes` names the old one (DM §8.2). */
export const decisionRecord = z
  .strictObject({
    ...envelope("decision"),
    statement: z.string(),
    scope,
    exceptions: z.array(z.string()),
    questionId: questionId.optional(),
    conflictId: conflictId.optional(),
    /** Set on a `developer_correction` of a finding, which is then corrected (IMPL §4.5). */
    findingId: findingId.optional(),
    origin: z.enum(["answered_question", "developer_correction"]),
    actor: nonEmpty,
    decidedAt: timestamp,
    supersedes: z.tuple([recordId("decision")]).optional(),
  })
  .refine((r) => r.findingId === undefined || r.origin === "developer_correction", {
    message: "only a developer_correction names a finding",
  });

// --- Items that failed validation (§4.4.3) ---------------------------------------------------

/**
 * Only the failed form for now: the valid and invalidated forms come with recommendations (M5).
 * A failed revision keeps its lineage, so one recommendation's history stays together.
 */
export const recommendationRevisionRecord = z.strictObject({
  ...envelope("recommendation_revision"),
  recommendationId: lineageId(RECORD_KINDS.recommendation_revision.lineage.prefix),
  revision: z.int().min(1),
  ...failedFields,
  producedBy: z.union([modelCallId, z.literal("developer_edit")]),
});

/** Collections with no record type of their own. M5 adds held-back entries and regeneration. */
export const failedItemCollection = z.enum(["revisions", "expansionRequests", "contentNotices"]);

export const failedItemRecord = z.strictObject({
  ...envelope("failed_item"),
  ...failedFields,
  collection: failedItemCollection,
  producedBy: modelCallId,
});

// --- The file (§4.3) -------------------------------------------------------------------------

// A plain union: the finding, conflict, question and evidence variants are unions themselves.
export const sessionRecord = z.union([
  sessionStateRecord,
  generationConfigRecord,
  snapshotRecord,
  contentNoticeRecord,
  evidenceRecord,
  findingRecord,
  conflictRecord,
  questionRecord,
  decisionRecord,
  recommendationRevisionRecord,
  failedItemRecord,
]);

export const sessionHeader = z.strictObject({
  id: idWith("ses"),
  createdAt: timestamp,
  productVersion: nonEmpty,
  adapter: z.literal("claude-code"),
  outputScope: z.tuple([z.literal("root CLAUDE.md")]),
  /** `root` is the real path of the resolved root: the session's repository identity. */
  repository: z.strictObject({ name: z.string(), root: z.string() }),
  targetPath: z.literal("CLAUDE.md"),
});

export const sessionFile = z.strictObject({
  format: z.literal(SESSION_FORMAT),
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  /** The product version that last wrote the file. */
  writtenBy: nonEmpty,
  session: sessionHeader,
  records: z.array(sessionRecord),
});

export type SessionRecord = z.infer<typeof sessionRecord>;
export type SessionFile = z.infer<typeof sessionFile>;
export type SessionHeader = z.infer<typeof sessionHeader>;
export type RecordOf<T extends SessionRecord["type"]> = Extract<SessionRecord, { type: T }>;
export type FindingRecord = RecordOf<"finding">;
export type ConflictRecord = RecordOf<"conflict">;
export type EvidenceRecord = RecordOf<"evidence">;
