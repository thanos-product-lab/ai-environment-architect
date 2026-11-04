import { z } from "zod";
import { ANALYSE_COLLECTION_LIMITS } from "../../schemas/analyse.js";
import type { Hash } from "../hash.js";

// Session records (IMPL §4.3–§4.5; DM §5–§8). The session file is a header and an append-only
// list of immutable records. Every record shares an envelope: `type`, `id`, `seq`, `createdAt`.
// A record that can change has a lineage ID as well, shared by its revisions, and a `revision`.
//
// This defines the records §4.4–§4.6 and §4.8 produce, those of `recommend` (§3.3.5),
// selections (DM §9.2), artifact revisions (DM §9.4) and reviews (DM §10). `apply_attempt` has
// its prefix here and gets its fields with apply (DM §11.2); until then the file schema doesn't
// accept it.

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

/**
 * The statuses a revision may have and still be current (§4.4.1, the table's last column). A
 * type not listed has no status that rules it out.
 */
export const CURRENT_STATUSES: Partial<Record<RecordTypeName, ReadonlySet<string>>> = {
  finding: new Set(["active"]),
  conflict: new Set(["unresolved", "resolved"]),
  question: new Set(["open", "answered", "skipped", "unreached"]),
  recommendation_revision: new Set(["valid"]),
};

/** The types whose records form revisions: a lineage, or the session's own (§4.4.1). */
export type RevisableType =
  | "session_state"
  | "generation_config"
  | "finding"
  | "conflict"
  | "question"
  | "recommendation_revision"
  | "apply_attempt"
  | "model_call"
  | "effort_interval";

/**
 * The fields a revision may change (IMPL §4.9 check 3). Every other field repeats the revision
 * it supersedes exactly, besides the envelope, `revision`, `supersedes` and `revisedBy`, which
 * names who appended that revision and is never repeated. A field may appear or disappear only
 * if it is listed.
 */
export const REVISION_FIELDS: Readonly<Record<RevisableType, readonly string[]>> = {
  session_state: ["productVersion", "stage", "status", "outcome", "reason", "unsentPurpose"],
  // Raising or confirming the budget (§2.12, §4.6).
  generation_config: ["budget", "reason"],
  finding: ["status", "withdrawnReason"],
  conflict: ["findingIds", "status", "withdrawnReason", "resolvingDecisionId"],
  question: ["status", "unreachedReason"],
  recommendation_revision: [
    "kind",
    "operation",
    "target",
    "content",
    "rationale",
    "support",
    "references",
    "scope",
    "producedBy",
    "validationEvents",
    "status",
    "invalidatedReason",
  ],
  apply_attempt: [],
  // What the end adds to the `started` revision (§4.6).
  model_call: [
    "state",
    "returnedModel",
    "retainedResponseRef",
    "usage",
    "cost",
    "validationEvents",
    "counts",
    "correctedCitationRate",
    "citationsProposed",
    "questionOrder",
    "error",
    "endedAt",
    "durationMs",
  ],
  effort_interval: ["state", "leftAt"],
};

/** What an invalidation of a recommendation revision changes (§4.4.1, §4.9 check 3). */
export const INVALIDATION_FIELDS: readonly string[] = ["status", "invalidatedReason"];

/** Never compared between revisions: the envelope, and what says how one follows another. */
export const REVISION_BOOKKEEPING: ReadonlySet<string> = new Set([
  "type",
  "id",
  "seq",
  "createdAt",
  "revision",
  "supersedes",
  "revisedBy",
]);

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
  /** The one rule that rejected it: an item stops at its first rejection (§3.5). */
  rejectedBy: z.tuple([nonEmpty]),
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

export const generationConfigRecord = z
  .strictObject({
    ...envelope("generation_config"),
    ...revisioned,
    /** Why a revision after the first was appended: raising or confirming the budget (§4.6). */
    reason: z.enum(["budget_raised", "budget_confirmed"]).optional(),
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
  })
  .refine((r) => r.revision === 1 || r.reason !== undefined, {
    message: "a revision after the first gives its reason",
    path: ["reason"],
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
  })
  .refine((r) => r.resolvingDecisionId === undefined || r.revisedBy === undefined, {
    message: "a revision the developer causes names its decision, not revisedBy",
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
  })
  // As the model output's `resolves` (1–10, IMPL §3.3.4): a question is about something.
  .refine((r) => r.findingIds.length + r.conflictIds.length + r.gapIds.length > 0, {
    message: "a question resolves at least one finding, gap or conflict",
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

// --- Recommendations (DM §9.1, IMPL §4.4.1) --------------------------------------------------

const recommendationId = lineageId(RECORD_KINDS.recommendation_revision.lineage.prefix);
const recommendationProducedBy = z.union([modelCallId, z.literal("developer_edit")]);

/** A captured block, by ID and hash in the snapshot active when the revision was created. */
const blockRef = z.strictObject({ blockId: nonEmpty, blockHash: hash });

export const recommendationTarget = z.union([
  z.strictObject({ kind: z.literal("block"), ...blockRef.shape }),
  z.strictObject({ kind: z.literal("after"), ...blockRef.shape }),
  z.strictObject({ kind: z.literal("section"), ...blockRef.shape }),
  z.strictObject({
    kind: z.literal("newSection"),
    heading: z.string(),
    after: blockRef.optional(),
  }),
]);

/** Typed: a finding by lineage ID, so REC-001 sees its current state; a decision by record ID. */
export const recommendationSupport = z.union([
  z.strictObject({ kind: z.literal("finding"), findingId }),
  z.strictObject({ kind: z.literal("decision"), decisionId: recordId("decision") }),
]);

export const structuredReference = z.union([
  z.strictObject({
    kind: z.literal("path"),
    value: z.string(),
    supportingFindingId: findingId,
    evidenceId: recordId("evidence"),
    verification: z.literal("exists_in_snapshot"),
  }),
  z.strictObject({
    kind: z.literal("command"),
    value: z.string(),
    supportingFindingId: findingId,
    evidenceId: recordId("evidence"),
    verification: z.literal("found_not_run"),
  }),
]);

export const invalidatedReason = z.enum([
  "revalidation_failed",
  "not_reconsidered",
  "dropped_by_model",
  "target_changed",
]);

/** A model-produced revision's events are on its model call (DM §9.1). */
function onlyEditsHoldEvents(r: { validationEvents?: unknown; producedBy: string }): boolean {
  return r.validationEvents === undefined || r.producedBy === "developer_edit";
}
const eventsMessage = { message: "only a developer_edit revision holds its own validationEvents" };

const recommendationRevision = z
  .strictObject({
    ...envelope("recommendation_revision"),
    recommendationId,
    ...revisioned,
    kind: z.enum(["fact", "policy"]),
    operation: z.enum(["add", "revise", "remove"]),
    target: recommendationTarget,
    content: z.string().optional(),
    rationale: z.string(),
    support: z.array(recommendationSupport).min(1),
    references: z.array(structuredReference),
    scope,
    producedBy: recommendationProducedBy,
    /** Set only by an invalidation a model call causes (§4.4.1). */
    revisedBy,
    /** A `developer_edit` revision's own events; a model's are on its call (DM §9.1). */
    validationEvents: z.array(z.lazy(() => validationEvent)).optional(),
    status: z.enum(["valid", "invalidated"]),
    invalidatedReason: invalidatedReason.optional(),
  })
  .refine((r) => (r.status === "invalidated") === (r.invalidatedReason !== undefined), {
    message: "invalidatedReason is set exactly when invalidated",
  })
  .refine((r) => r.revisedBy === undefined || r.status === "invalidated", {
    message: "only an invalidation sets revisedBy",
  })
  .refine((r) => (r.operation === "remove") === (r.content === undefined), {
    message: "content is set exactly for add and revise",
  })
  .refine(onlyEditsHoldEvents, eventsMessage);

/**
 * A recommendation revision that failed validation keeps its lineage, so one recommendation's
 * history stays together, and supersedes nothing (§4.4.3).
 */
const failedRecommendationRevision = z.strictObject({
  ...envelope("recommendation_revision"),
  recommendationId,
  revision: z.int().min(1),
  ...failedFields,
  producedBy: recommendationProducedBy,
  /** A failed `developer_edit` keeps its events, since no model call holds them. */
  validationEvents: z.array(z.lazy(() => validationEvent)).optional(),
});

export const recommendationRevisionRecord = z.union([
  recommendationRevision,
  failedRecommendationRevision.refine(onlyEditsHoldEvents, eventsMessage),
]);

/** One accepted `heldBack` entry (§3.3.5): blocked by questions and conflicts, by lineage ID. */
export const heldBackRecord = z.strictObject({
  ...envelope("held_back"),
  topic: z.string(),
  blockedBy: z.array(z.union([questionId, conflictId])).min(1),
  modelCallId,
});

/** An accepted `noChangeReason` (REC-009). */
export const noChangeReasonRecord = z.strictObject({
  ...envelope("no_change_reason"),
  reason: z.string(),
  modelCallId,
});

/**
 * Immutable (DM §9.2): the developer's choice for one exact revision. The latest per
 * `recommendationId` is current, and counts only while its revision is (§4.4.2).
 */
export const selectionRecord = z.strictObject({
  ...envelope("selection"),
  recommendationId,
  revisionId: recordId("recommendation_revision"),
  state: z.enum(["pending", "accepted", "rejected"]),
  actor: nonEmpty,
  selectedAt: timestamp,
});

// --- Artifact revisions and reviews (DM §9.4, §10) -------------------------------------------

/**
 * One change in the proposed file (DM §9.4), in file order: a `revise` or `remove` names its
 * original block, by block ID in the artifact's snapshot; new content its bytes in the proposal.
 */
export const attributionEntry = z
  .strictObject({
    revisionId: recordId("recommendation_revision"),
    operation: z.enum(["add", "revise", "remove"]),
    originalBlockId: nonEmpty.optional(),
    proposedSpan: z.strictObject({ start: count, end: count }).optional(),
  })
  .refine((e) => (e.operation === "add") === (e.originalBlockId === undefined), {
    message: "a revise or remove names its original block, and an add doesn't",
  })
  .refine((e) => (e.operation === "remove") === (e.proposedSpan === undefined), {
    message: "new content has a proposed span, and a removal doesn't",
  });

/**
 * Immutable (DM §9.4): an assembled proposal. `revision` numbers the session's artifact revisions
 * from 1. The content is in a content-addressed file (§4.2).
 */
export const artifactRevisionRecord = z.strictObject({
  ...envelope("artifact_revision"),
  revision: z.int().min(1),
  snapshotId,
  targetPath: z.literal("CLAUDE.md"),
  /** `absent`, or the hash of the snapshot's destination, whose bytes are in the snapshot. */
  original: z.union([z.literal("absent"), hash]),
  proposedContent: contentRef,
  proposedHash: hash,
  /** The accepted recommendation revisions used, in the order of their recommendations. */
  selectedRevisionIds: z.array(recordId("recommendation_revision")).min(1),
  /** The current decision versions those revisions depend on. */
  decisionIds: z.array(recordId("decision")),
  attribution: z.array(attributionEntry).min(1),
});

/** Immutable (DM §10). An approval of the exact content hash the developer was shown. */
export const reviewRecord = z.strictObject({
  ...envelope("review"),
  artifactRevisionId: recordId("artifact_revision"),
  contentHash: hash,
  outcome: z.enum(["approved", "rejected"]),
  actor: nonEmpty,
  reviewedAt: timestamp,
  comment: z.string().optional(),
});

/** Collections with no record type of their own. Regeneration adds `actions` (M5). */
export const failedItemCollection = z.enum([
  "revisions",
  "expansionRequests",
  "contentNotices",
  "heldBack",
  "noChangeReason",
]);

export const failedItemRecord = z.strictObject({
  ...envelope("failed_item"),
  ...failedFields,
  collection: failedItemCollection,
  producedBy: modelCallId,
});

// --- Model calls (§4.6, DM §13.1) ------------------------------------------------------------

/** A measurement that can be missing (§4.1): unknown is never zero. */
export const known = <T extends z.ZodType>(value: T) =>
  z.union([
    z.strictObject({ state: z.literal("known"), value }),
    z.strictObject({ state: z.literal("unknown"), reason: nonEmpty }),
  ]);

/** A total of parts, any of which may be unknown (§4.10 "Totals and unknowns"). */
export const total = z.union([
  z.strictObject({ state: z.literal("known"), value: z.number().min(0) }),
  z.strictObject({
    state: z.literal("unknown"),
    reason: nonEmpty,
    knownPartsSum: z.number().min(0),
  }),
]);

const aliasKind = z.enum(["T", "E", "F", "C", "Q", "D", "R", "B"]);

/** IMPL §3.2.1. `F`, `C`, `Q`, `D` and `R` targets are record IDs: the exact revisions sent. */
const ALIAS_TARGET_KINDS: Readonly<Record<z.infer<typeof aliasKind>, string>> = {
  T: "item",
  E: "item",
  F: "record",
  C: "record",
  Q: "record",
  D: "record",
  R: "record",
  B: "block",
};

export const aliasTable = z.strictObject({
  call: callPurpose,
  entries: z.array(
    z
      .strictObject({
        alias: nonEmpty,
        kind: aliasKind,
        target: z.union([
          z.strictObject({ kind: z.literal("item"), itemId: nonEmpty }),
          z.strictObject({ kind: z.literal("record"), recordId: anyRecordId }),
          z.strictObject({ kind: z.literal("block"), blockId: z.string(), hash }),
        ]),
      })
      .refine((e) => ALIAS_TARGET_KINDS[e.kind] === e.target.kind, {
        message: "an alias's target is of its kind: T and E items, B blocks, others records",
      }),
  ),
});

/** IMPL §3.5. No text from the response. */
export const validationEvent = z.strictObject({
  itemKey: nonEmpty,
  stage: z.enum(["schema", "item", "cross_item"]),
  rule: nonEmpty,
  outcome: z.enum(["rejected", "corrected", "relabelled"]),
  detail: z.string(),
  // JSON, as the file is; `unknown` so the pipeline's events can be stored as they are.
  original: z.unknown().optional(),
});

const inputsRef = z.string().regex(/^inputs\/sha256-[0-9a-f]{64}\.json$/);
const responsesRef = z.string().regex(/^responses\/sha256-[0-9a-f]{64}\.json$/);

const manifestTier = z.union([
  z.strictObject({
    tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]),
    capBytes: count,
    budgetBytes: count,
    usedBytes: count,
    items: count,
    skipped: count,
    testExamples: count.optional(),
  }),
  z.strictObject({ tier: z.literal(4), capBytes: count, usedBytes: count, treeDepth: count }),
]);

/**
 * IMPL §1.13: paths, hashes and reasons, never source content. `tokenCheck` and `expansion` are
 * null until the token check (§1.10) and the expansion round (§1.8) record theirs, in M6.
 */
export const inputManifest = z.strictObject({
  manifestVersion: z.literal(2),
  algorithmVersion: nonEmpty,
  secretRulesVersion: nonEmpty,
  declarationPatternsVersion: nonEmpty,
  settingsHash: hash,
  snapshotId,
  contextHash: hash,
  retainedInputRef: inputsRef.nullable(),
  budget: z.strictObject({ initialContextBytes: count, usedBytes: count }),
  knownFacts: z.strictObject({
    capBytes: count,
    usedBytes: count,
    facts: count,
    leftOut: count,
  }),
  tokenCheck: z.null(),
  tiers: z.array(manifestTier),
  items: z.array(
    z.strictObject({
      id: nonEmpty,
      path: z.string(),
      fileHash: hash,
      reason: nonEmpty,
      excerpt: z.boolean(),
      includedLines: z.string(),
      totalLines: count,
      bytes: count,
    }),
  ),
  skipped: z.array(
    z.union([
      z.strictObject({ path: z.string(), reason: nonEmpty }),
      z.strictObject({ pathHash: hash, reason: nonEmpty }),
    ]),
  ),
  excluded: z.array(
    z.union([
      z.strictObject({ path: z.string(), rule: z.string() }),
      z.strictObject({ pathHash: hash, rule: z.string() }),
      z.strictObject({ path: z.string(), reason: z.string().regex(/^secret-scan:/) }),
      z.strictObject({ pathHash: hash, reason: z.string().regex(/^secret-scan:/) }),
    ]),
  ),
  ignoreRules,
  ignored: z.array(recordedPath),
  expansion: z.null(),
});

/** The limits in force when the call was sent, and the spend the §3.6 check counted (§4.6). */
export const callBudget = z.strictObject({
  maxTokens: z.int().min(1).optional(),
  maxCostUsd: z.number().positive().optional(),
  spentCostUsd: total,
  spentTokens: total,
});

const modelCallStartedFields = {
  ...envelope("model_call"),
  modelCallId,
  purpose: callPurpose,
  /** The sends for one step, from 1. */
  attempt: z.int().min(1),
  /** The previous attempt's `modelCallId`. */
  retryOf: modelCallId.optional(),
  requestedModel: nonEmpty,
  promptVersion: nonEmpty,
  promptHash: hash,
  schemaVersion: nonEmpty,
  schemaHash: hash,
  validatorVersion: nonEmpty,
  detectorVersion: nonEmpty,
  inputManifest,
  retainedInputRef: inputsRef.nullable(),
  aliases: aliasTable,
  budget: callBudget,
  /** The §3.6 estimate in USD: for the budget only, never reported as the call's cost. */
  estimatedCost: known(z.number().min(0)),
  startedAt: timestamp,
};

const correctedCitationRate = z.union([
  z.strictObject({
    state: z.literal("known"),
    corrected: count,
    checked: z.int().min(1),
    rate: z.number().min(0).max(1),
  }),
  z.strictObject({
    state: z.literal("unknown"),
    reason: z.enum(["schema_failed", "no_citations"]),
  }),
]);

const citationsProposed = z.union([
  z.strictObject({ state: z.literal("known"), count }),
  z.strictObject({ state: z.literal("unknown"), reason: z.literal("schema_failed") }),
]);

const modelCallStarted = z.strictObject({
  ...modelCallStartedFields,
  revision: z.literal(1),
  state: z.literal("started"),
});

const modelCallEnded = z.strictObject({
  ...modelCallStartedFields,
  revision: z.literal(2),
  supersedes: z.tuple([recordId("model_call")]),
  state: z.enum(["completed", "failed", "interrupted"]),
  returnedModel: known(nonEmpty),
  retainedResponseRef: responsesRef.nullable(),
  usage: z.strictObject({
    input: known(count),
    output: known(count),
    cacheRead: known(count),
    cacheWrite: known(count),
  }),
  cost: known(
    z.strictObject({
      amount: z.number().min(0),
      currency: z.literal("USD"),
      basis: z.enum(["reported", "estimated"]),
    }),
  ),
  validationEvents: z.array(validationEvent),
  counts: z.strictObject({
    proposed: known(count),
    accepted: count,
    corrected: count,
    relabelled: count,
    rejectedByRule: z.record(nonEmpty, z.int().min(1)),
  }),
  /** `analyse` and `analyse_expansion` only (§3.2.2). */
  correctedCitationRate: correctedCitationRate.optional(),
  citationsProposed: citationsProposed.optional(),
  /** `generate_questions` only: the model's order, for ranking class 5 (§3.3.4). */
  questionOrder: z.array(nonEmpty).optional(),
  /** Code-generated, with no source content. */
  error: z.strictObject({ kind: nonEmpty, message: nonEmpty }).optional(),
  endedAt: known(timestamp),
  durationMs: known(count),
});

const CITED_PURPOSES: ReadonlySet<string> = new Set(["analyse", "analyse_expansion"]);

export const modelCallRecord = z
  .union([modelCallStarted, modelCallEnded])
  .refine((r) => (r.attempt === 1) === (r.retryOf === undefined), {
    message: "retryOf is set exactly when attempt is after the first",
    path: ["retryOf"],
  })
  .refine(
    (r) =>
      r.state === "started" ||
      CITED_PURPOSES.has(r.purpose) ||
      (r.correctedCitationRate === undefined && r.citationsProposed === undefined),
    { message: "only analyse and analyse_expansion record citation counts" },
  )
  .refine(
    (r) =>
      r.state === "started" || r.purpose === "generate_questions" || r.questionOrder === undefined,
    { message: "only generate_questions records questionOrder" },
  )
  // It may have been billed, so its end, usage and cost are never known, let alone zero (§4.6).
  .refine(
    (r) =>
      r.state !== "interrupted" ||
      [
        r.endedAt,
        r.durationMs,
        r.cost,
        r.usage.input,
        r.usage.output,
        r.usage.cacheRead,
        r.usage.cacheWrite,
      ].every((value) => value.state === "unknown"),
    { message: "an interrupted call's end, duration, usage and cost are unknown" },
  );

// --- Effort (§4.6, §2.13, DM §13.2) ----------------------------------------------------------

const effortFields = {
  ...envelope("effort_interval"),
  effortIntervalId: lineageId(RECORD_KINDS.effort_interval.lineage.prefix),
  /** The stage the developer was working on. */
  stage,
  enteredAt: timestamp,
};

export const effortIntervalRecord = z.union([
  z.strictObject({ ...effortFields, revision: z.literal(1), state: z.literal("open") }),
  z
    .strictObject({
      ...effortFields,
      revision: z.literal(2),
      supersedes: z.tuple([recordId("effort_interval")]),
      state: z.literal("closed"),
      /** Unknown, with the reason `interrupted`, for an interval closed on resume. */
      leftAt: known(timestamp),
    })
    .refine((r) => r.leftAt.state === "unknown" || r.leftAt.value >= r.enteredAt, {
      // Both are ISO 8601 UTC with milliseconds, so they compare as strings.
      message: "leftAt is not before enteredAt",
      path: ["leftAt"],
    }),
]);

/** The developer's corrected total, with a reason; a later one supersedes it (§2.13). */
export const effortCorrectionRecord = z.strictObject({
  ...envelope("effort_correction"),
  totalMs: count,
  reason: nonEmpty,
  supersedes: z.tuple([recordId("effort_correction")]).optional(),
});

/**
 * Written by `purge-inputs` (§4.8): the retained exchanges of every call before it may be gone.
 * Its place in `seq` is all it records.
 */
export const inputsPurgedRecord = z.strictObject({ ...envelope("inputs_purged") });

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
  heldBackRecord,
  noChangeReasonRecord,
  selectionRecord,
  artifactRevisionRecord,
  reviewRecord,
  failedItemRecord,
  modelCallRecord,
  effortIntervalRecord,
  effortCorrectionRecord,
  inputsPurgedRecord,
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
export type ModelCallRecord = RecordOf<"model_call">;
export type EffortIntervalRecord = RecordOf<"effort_interval">;
export type Known<T> = { state: "known"; value: T } | { state: "unknown"; reason: string };
export type Total = z.infer<typeof total>;
export type CallBudget = z.infer<typeof callBudget>;
