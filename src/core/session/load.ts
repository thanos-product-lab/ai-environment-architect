import { type AssemblyDestination, assemble } from "../assembly/assemble.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";
import { assemblyRevisionsOf, decisionIdsOf } from "./artifact-input.js";
import { isFailed, LINEAGE_FIELDS, lineageOf, type Revised, SELF_SUPERSEDING } from "./log.js";
import {
  CURRENT_STATUSES,
  INVALIDATION_FIELDS,
  RECORD_KINDS,
  REVISION_BOOKKEEPING,
  REVISION_FIELDS,
  type RecordKind,
  type RecordOf,
  type RecordTypeName,
  type RevisableType,
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionRecord,
  sessionFile,
} from "./records.js";
import { pretty } from "./serialise.js";

// Load checks and schema versions (IMPL §4.9). The checks run in order; the first failure
// rejects the session, naming the check and the record. Load only reads: it never repairs and
// never writes, so a rejected file is left untouched.
//
// Some branches are safeguards that no file can reach, because ID prefixes, the schema or an
// earlier check stop the input first: a lineage ID used as a record ID (no record prefix is a
// lineage prefix), a record reference of the wrong type (record IDs carry their type's prefix),
// superseding a failed record (check 4 refuses the reference) and superseding an immutable one
// (only decisions and effort corrections have `supersedes`). A lineage whose revisions all
// failed is reachable through recommendations, and tested. The CLI words the messages
// (`src/cli`).

/** Reads a content-addressed file of the session directory (IMPL §4.2), or undefined if absent. */
export interface ContentReader {
  read(ref: string): Promise<Uint8Array | undefined>;
}

export const LOAD_CHECKS = {
  1: "format",
  2: "schema",
  3: "envelope",
  4: "references",
  5: "superseding",
  6: "evidence",
  7: "content",
  8: "state",
  9: "assembly",
} as const;

export type LoadCheck = keyof typeof LOAD_CHECKS;

export interface VersionMismatch {
  readonly direction: "older" | "newer";
  readonly sessionFormat: number;
  /** The product version that last wrote the file, if the file says. */
  readonly writtenBy: string | undefined;
  readonly readerFormat: number;
}

export interface LoadFailure {
  readonly check: LoadCheck;
  readonly name: (typeof LOAD_CHECKS)[LoadCheck];
  readonly recordId?: string;
  readonly seq?: number;
  /** Code-written, with no source content. */
  readonly detail: string;
  /** Check 1, when the format is readable but not this version's. */
  readonly version?: VersionMismatch;
}

export type LoadResult =
  | { readonly ok: true; readonly file: SessionFile }
  | { readonly ok: false; readonly failure: LoadFailure };

export interface LoadOptions {
  /** The format this reader reads. Tests set it to show the older-format refusal. */
  readonly readerFormat?: number;
}

class Rejected extends Error {
  readonly failure: LoadFailure;
  constructor(failure: LoadFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

function reject(
  check: LoadCheck,
  detail: string,
  record?: { readonly id: string; readonly seq: number },
): never {
  throw new Rejected({
    check,
    name: LOAD_CHECKS[check],
    detail,
    ...(record === undefined ? {} : { recordId: record.id, seq: record.seq }),
  });
}

export async function loadSession(
  bytes: Uint8Array,
  content: ContentReader,
  options: LoadOptions = {},
): Promise<LoadResult> {
  try {
    const raw = checkFormat(bytes, options.readerFormat ?? SESSION_SCHEMA_VERSION);
    const file = checkSchema(raw);
    checkEnvelope(file.records);
    checkReferences(file.records);
    checkSuperseding(file.records);
    checkEvidence(file.records);
    await checkContent(file.records, content);
    checkState(file.records);
    await checkAssembly(file.records, content);
    return { ok: true, file };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, failure: error.failure };
    throw error;
  }
}

// --- Check 1: the file is JSON, with a readable and supported format --------------------------

function checkFormat(bytes: Uint8Array, readerFormat: number): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reject(1, "the file isn't UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject(1, "the file isn't complete JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return reject(1, "the file isn't a JSON object");
  const json = raw as Record<string, unknown>;
  if (json["format"] !== SESSION_FORMAT) return reject(1, `the format isn't ${SESSION_FORMAT}`);
  const version = json["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version))
    return reject(1, "schemaVersion isn't an integer");
  if (version !== readerFormat) {
    const direction = version < readerFormat ? "older" : "newer";
    throw new Rejected({
      check: 1,
      name: LOAD_CHECKS[1],
      detail: `session format ${version} is ${direction} than format ${readerFormat}`,
      version: {
        direction,
        sessionFormat: version,
        writtenBy: typeof json["writtenBy"] === "string" ? json["writtenBy"] : undefined,
        readerFormat,
      },
    });
  }
  return json;
}

// --- Check 2: the Zod schema for the whole file -----------------------------------------------

function checkSchema(raw: Record<string, unknown>): SessionFile {
  const parsed = sessionFile.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path ?? [];
  const detail = `${path.join(".") || "the file"}: ${issue?.message ?? "invalid"}`;
  if (path[0] === "records" && typeof path[1] === "number") {
    const record = (raw["records"] as unknown[])[path[1]] as { id?: unknown; seq?: unknown };
    if (typeof record?.id === "string" && typeof record.seq === "number")
      return reject(2, detail, { id: record.id, seq: record.seq });
  }
  return reject(2, detail);
}

// --- Check 3: the envelope --------------------------------------------------------------------

const supersedesOf = (record: SessionRecord): readonly string[] =>
  (record as { supersedes?: readonly string[] }).supersedes ?? [];
const revisionOf = (record: SessionRecord): number | undefined =>
  (record as { revision?: number }).revision;

function checkEnvelope(records: readonly SessionRecord[]): void {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    if (ids.has(record.id)) reject(3, `record ID ${record.id} is used twice`, record);
    ids.add(record.id);
    if (record.seq !== index + 1)
      reject(3, `seq is ${record.seq} where ${index + 1} comes next`, record);
  });
  for (const record of records)
    for (const field of LINEAGE_FIELDS) {
      const value = (record as Record<string, unknown>)[field];
      if (typeof value === "string" && ids.has(value) && lineageOf(record) === value)
        reject(3, `lineage ID ${value} is also a record ID`, record);
    }

  // Artifact revisions are immutable, and numbered 1, 2, 3… in `seq` order (DM §9.4).
  let artifacts = 0;
  for (const record of records)
    if (record.type === "artifact_revision" && record.revision !== ++artifacts)
      reject(3, `artifact revision ${artifacts} is numbered ${record.revision}`, record);

  const lineages = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const lineage = lineageOf(record);
    if (lineage === undefined) continue;
    const key = `${record.type}\u0000${lineage}`;
    const earlier = lineages.get(key) ?? [];
    const expected = earlier.length + 1;
    if (revisionOf(record) !== expected)
      reject(3, `${lineage} needs revision ${expected}, not ${revisionOf(record)}`, record);
    if (isFailed(record)) {
      if (supersedesOf(record).length > 0)
        reject(3, "a revision that failed validation supersedes nothing", record);
    } else if (earlier.length > 0) {
      const base = earlier.filter((r) => !isFailed(r)).at(-1);
      const wanted = base === undefined ? [] : [base.id];
      if (supersedesOf(record).join() !== wanted.join())
        reject(3, `revision ${expected} must supersede ${wanted.join() || "nothing"}`, record);
      if (base !== undefined) checkRepeats(base, record);
    }
    earlier.push(record);
    lineages.set(key, earlier);
  }
}

/**
 * A revision repeats every field of `base` that its type doesn't change (§4.4.1); an invalidated
 * recommendation revision changes only its status and reason.
 */
function checkRepeats(base: SessionRecord, revision: SessionRecord): void {
  const changeable = new Set(
    revision.type === "recommendation_revision" && revision.status === "invalidated"
      ? INVALIDATION_FIELDS
      : REVISION_FIELDS[revision.type as RevisableType],
  );
  const before = base as Record<string, unknown>;
  const after = revision as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(comparePaths);
  for (const field of fields) {
    if (REVISION_BOOKKEEPING.has(field) || changeable.has(field)) continue;
    // Canonical JSON, so key order doesn't matter.
    const a = before[field] === undefined ? undefined : pretty(before[field], "");
    const b = after[field] === undefined ? undefined : pretty(after[field], "");
    if (a !== b) reject(3, `a ${revision.type} revision can't change ${field}`, revision);
  }
}

// --- Check 4: references ----------------------------------------------------------------------

type Reference =
  | { readonly field: string; readonly names: "record"; readonly type: RecordTypeName }
  | {
      readonly field: string;
      readonly names: "lineage";
      readonly type: RecordTypeName;
      /** Other types the lineage may be of, as `blockedBy` names questions or conflicts. */
      readonly or?: readonly RecordTypeName[];
    };

const record = (field: string, type: RecordTypeName): Reference => ({
  field,
  names: "record",
  type,
});
const lineage = (field: string, type: RecordTypeName, ...or: RecordTypeName[]): Reference => ({
  field,
  names: "lineage",
  type,
  ...(or.length === 0 ? {} : { or }),
});

/**
 * The references table of IMPL §4.4.1.
 * `supersedes` is checked for every record; its type is check 5's.
 */
const producedBy = lineage("producedBy", "model_call");
const revisedBy = lineage("revisedBy", "model_call");

const REFERENCES: Partial<Record<RecordTypeName, readonly Reference[]>> = {
  content_notice: [record("snapshotId", "snapshot"), lineage("modelCallId", "model_call")],
  evidence: [record("snapshotId", "snapshot")],
  finding: [
    record("snapshotId", "snapshot"),
    record("evidenceIds", "evidence"),
    producedBy,
    revisedBy,
  ],
  conflict: [
    record("snapshotId", "snapshot"),
    lineage("findingIds", "finding"),
    record("resolvingDecisionId", "decision"),
    producedBy,
    revisedBy,
  ],
  question: [
    lineage("findingIds", "finding"),
    lineage("gapIds", "finding"),
    lineage("conflictIds", "conflict"),
    producedBy,
  ],
  recommendation_revision: [producedBy, revisedBy],
  held_back: [lineage("blockedBy", "question", "conflict"), lineage("modelCallId", "model_call")],
  no_change_reason: [lineage("modelCallId", "model_call")],
  selection: [
    lineage("recommendationId", "recommendation_revision"),
    record("revisionId", "recommendation_revision"),
  ],
  artifact_revision: [
    record("snapshotId", "snapshot"),
    record("selectedRevisionIds", "recommendation_revision"),
    record("decisionIds", "decision"),
  ],
  review: [record("artifactRevisionId", "artifact_revision")],
  apply_attempt: [record("artifactRevisionId", "artifact_revision"), record("reviewId", "review")],
  failed_item: [producedBy],
  model_call: [lineage("retryOf", "model_call")],
  decision: [
    lineage("questionId", "question"),
    lineage("conflictId", "conflict"),
    lineage("findingId", "finding"),
  ],
};

/** The record type each alias kind's target must be (IMPL §3.2.1, §4.4.1). */
const ALIAS_TARGET_TYPES: Readonly<Record<string, RecordTypeName>> = {
  F: "finding",
  C: "conflict",
  Q: "question",
  D: "decision",
  R: "recommendation_revision",
};

/** Not IDs: a finding code made, or a developer's edit. */
const NOT_A_CALL: ReadonlySet<string> = new Set(["deterministic", "developer_edit"]);

/**
 * The references a record makes, with the type each one names. A model call's input manifest
 * names its snapshot, and its alias table the exact revisions sent, by record ID; items and
 * blocks aren't records.
 */
function referencesOf(r: SessionRecord): { reference: Reference; id: string }[] {
  const found: { reference: Reference; id: string }[] = [];
  for (const reference of [...(REFERENCES[r.type] ?? []), record("supersedes", r.type)])
    for (const id of valuesOf(r, reference.field))
      if (reference.field !== "producedBy" || !NOT_A_CALL.has(id)) found.push({ reference, id });
  // An artifact's attribution names recommendation revisions by record ID (§4.4.1).
  if (r.type === "artifact_revision")
    for (const entry of r.attribution)
      found.push({
        reference: record("attribution", "recommendation_revision"),
        id: entry.revisionId,
      });
  if (r.type === "model_call") {
    found.push({
      reference: record("inputManifest.snapshotId", "snapshot"),
      id: r.inputManifest.snapshotId,
    });
    for (const entry of r.aliases.entries) {
      const type = ALIAS_TARGET_TYPES[entry.kind];
      if (entry.target.kind === "record" && type !== undefined)
        found.push({ reference: record("aliases", type), id: entry.target.recordId });
    }
  }
  return found;
}

function valuesOf(record: SessionRecord, field: string): readonly string[] {
  const value = (record as Record<string, unknown>)[field];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function checkReferences(records: readonly SessionRecord[]): void {
  const byId = new Map(records.map((r) => [r.id, r]));
  /** By `type` and lineage ID: the lineage's revisions in `seq` order. */
  const lineages = new Map<string, SessionRecord[]>();
  for (const r of records) {
    const id = lineageOf(r);
    if (id === undefined || (RECORD_KINDS[r.type] as RecordKind).sessionLineage) continue;
    const key = `${r.type}\u0000${id}`;
    lineages.set(key, [...(lineages.get(key) ?? []), r]);
  }

  // A model call is sent under the session's settings, so the first generation_config comes
  // before every call.
  const firstConfig = records.find((r) => r.type === "generation_config")?.seq;
  for (const r of records)
    if (r.type === "model_call") {
      if (firstConfig === undefined) reject(4, "the session has no generation_config", r);
      if (firstConfig > r.seq)
        reject(4, "the call comes before the session's first generation_config", r);
    }

  for (const r of records)
    for (const { reference, id } of referencesOf(r)) {
      if (reference.names === "record") {
        const target = byId.get(id);
        if (target === undefined)
          reject(4, `${reference.field} names ${id}, which isn't in the session`, r);
        // `supersedes` names its own type; check 5 says so for another type.
        if (reference.field !== "supersedes" && target.type !== reference.type)
          reject(4, `${reference.field} names ${id}, a ${target.type}`, r);
        if (target.seq >= r.seq) reject(4, `${reference.field} names the later ${id}`, r);
        if (!isFailed(r) && isFailed(target))
          reject(4, `${reference.field} names ${id}, which failed validation`, r);
        if (
          r.type === "selection" &&
          reference.field === "revisionId" &&
          lineageOf(target) !== r.recommendationId
        )
          reject(4, `revisionId names ${id}, a revision of another recommendation`, r);
        if (
          r.type === "apply_attempt" &&
          reference.field === "reviewId" &&
          (target as RecordOf<"review">).artifactRevisionId !== r.artifactRevisionId
        )
          reject(4, `reviewId names ${id}, a review of another artifact revision`, r);
      } else {
        const types = [reference.type, ...(reference.or ?? [])];
        const revisions = types
          .map((type) => lineages.get(`${type}\u0000${id}`))
          .find((found) => found !== undefined);
        if (revisions === undefined)
          reject(4, `${reference.field} names ${id}, which isn't a ${types.join(" or ")}`, r);
        const first = revisions[0] as SessionRecord;
        if (first.seq >= r.seq) reject(4, `${reference.field} names ${id}, which starts later`, r);
        if (!isFailed(r) && revisions.every((rev) => rev.seq >= r.seq || isFailed(rev)))
          reject(4, `${reference.field} names ${id}, which only failed validation`, r);
        if (reference.field === "retryOf" && r.type === "model_call") {
          // Check 3 has made every revision of a call repeat its purpose and attempt.
          const retried = first as RecordOf<"model_call">;
          if (retried.purpose !== r.purpose)
            reject(4, `retryOf names ${id}, a call with another purpose`, r);
          if (retried.attempt !== r.attempt - 1)
            reject(4, `retryOf names ${id}, attempt ${retried.attempt}, not ${r.attempt - 1}`, r);
        }
      }
    }

  checkArtifacts(records, byId);
  checkTargets(records);
}

type Snapshot = RecordOf<"snapshot">;

/**
 * An artifact revision's `original` is its snapshot's destination: `absent`, or its hash. It
 * names each selected revision and decision once, and its decisions are exactly the decision
 * support of its selected revisions (DM §9.4). Its attribution is checked by assembling it again
 * (check 9).
 */
function checkArtifacts(
  records: readonly SessionRecord[],
  byId: ReadonlyMap<string, SessionRecord>,
): void {
  for (const r of records) {
    if (r.type !== "artifact_revision") continue;
    // The reference loop has made sure the snapshot and revisions exist, and didn't fail.
    const { destination } = byId.get(r.snapshotId) as Snapshot;
    const expected = destination.state === "present" ? destination.hash : destination.state;
    if (r.original !== expected)
      reject(4, `original is ${r.original}, but its snapshot's destination is ${expected}`, r);
    for (const field of ["selectedRevisionIds", "decisionIds"] as const) {
      const twice = r[field].find((id, i) => r[field].indexOf(id) !== i);
      if (twice !== undefined) reject(4, `${field} names ${twice} twice`, r);
    }
    const selected = r.selectedRevisionIds.map(
      (id) => byId.get(id) as Revised<"recommendation_revision">,
    );
    const decisions = decisionIdsOf(selected);
    if (decisions.join() !== r.decisionIds.join())
      reject(
        4,
        `decisionIds are ${r.decisionIds.join(", ") || "none"}, but its revisions depend on ${decisions.join(", ") || "none"}`,
        r,
      );
  }
}

type RecommendationTarget = Extract<
  RecordOf<"recommendation_revision">,
  { target: unknown }
>["target"];

/**
 * A recommendation revision's target blocks exist, with their hashes, in the snapshot active when
 * the revision that set the target was created: the earliest revision from which every later one
 * that isn't `failed_validation` repeats the target. So an invalidation is checked against that
 * snapshot, not its own.
 */
function checkTargets(records: readonly SessionRecord[]): void {
  let active: Snapshot | undefined;
  const lastTarget = new Map<string, string>();
  for (const r of records) {
    if (r.type === "snapshot") active = r;
    if (r.type !== "recommendation_revision" || isFailed(r) || !("target" in r)) continue;
    const target = pretty(r.target, "");
    if (lastTarget.get(r.recommendationId) === target) continue;
    lastTarget.set(r.recommendationId, target);
    const blocks =
      active?.destination.state === "present" ? active.destination.blocks : ([] as const);
    for (const ref of blockRefsOf(r.target))
      if (!blocks.some((b) => b.blockId === ref.blockId && b.hash === ref.blockHash))
        reject(
          4,
          `the target ${ref.blockId} isn't in the snapshot active when it was set, with its hash`,
          r,
        );
  }
}

function blockRefsOf(
  target: RecommendationTarget,
): readonly { blockId: string; blockHash: string }[] {
  if (target.kind !== "newSection") return [target];
  return target.after === undefined ? [] : [target.after];
}

// --- Check 5: superseding ---------------------------------------------------------------------

function checkSuperseding(records: readonly SessionRecord[]): void {
  const byId = new Map(records.map((r) => [r.id, r]));
  const superseded = new Set<string>();
  /** At most one effort correction is current: each later one supersedes it (§4.6). */
  let currentCorrection: string | undefined;
  for (const r of records) {
    if (r.type !== "effort_correction") continue;
    if (currentCorrection !== undefined && !supersedesOf(r).includes(currentCorrection))
      reject(5, `an effort_correction must supersede the current one, ${currentCorrection}`, r);
    currentCorrection = r.id;
  }
  for (const r of records)
    for (const id of supersedesOf(r)) {
      // Check 4 has made sure the target exists, is earlier and didn't fail validation.
      const target = byId.get(id) as SessionRecord;
      if (target.type !== r.type)
        reject(5, `a ${r.type} can't supersede the ${target.type} ${id}`, r);
      if (superseded.has(id)) reject(5, `${id} is superseded twice`, r);
      superseded.add(id);
      if (isFailed(target)) reject(5, `${id} failed validation and can't be superseded`, r);
      if (lineageOf(target) === undefined && !SELF_SUPERSEDING.has(r.type))
        reject(5, `${id} is immutable`, r);
      const current = CURRENT_STATUSES[target.type];
      const status = (target as { status?: string }).status;
      if (current !== undefined && status !== undefined && !current.has(status))
        reject(5, `${id} is ${status}, so it isn't current and can't be superseded`, r);
    }
}

// --- Check 6: evidence ------------------------------------------------------------------------

function checkEvidence(records: readonly SessionRecord[]): void {
  const evidence = new Map(
    records.flatMap((r) => (r.type === "evidence" ? [[r.id, r] as const] : [])),
  );
  for (const r of records) {
    if (r.type !== "finding" || isFailed(r) || !("evidenceIds" in r)) continue;
    const kinds = r.evidenceIds.map((id) => evidence.get(id)?.kind);
    if (r.kind === "absence") {
      if (kinds.length !== 1 || kinds[0] !== "absence_check")
        reject(6, "an absence finding's evidence is one absence_check", r);
    } else if (r.kind === "claim") {
      // The schema (check 2) already requires at least one; this checks the kinds.
      if (kinds.some((k) => k !== "lines" && k !== "entry"))
        reject(6, "a claim's evidence is lines or entry evidence", r);
    }
  }
}

// --- Check 7: content -------------------------------------------------------------------------

async function checkContent(records: readonly SessionRecord[], content: ContentReader) {
  await checkDestinations(records, content);
  await checkArtifactContent(records, content);
  await checkRetainedExchanges(records, content);
}

async function checkDestinations(records: readonly SessionRecord[], content: ContentReader) {
  for (const r of records) {
    if (r.type !== "snapshot" || r.destination.state !== "present") continue;
    const { contentRef, hash, blocks } = r.destination;
    const bytes = await content.read(contentRef);
    if (bytes === undefined) reject(7, `${contentRef} is missing`, r);
    const actual = sha256(bytes);
    if (`content/${actual.replace(":", "-")}` !== contentRef)
      reject(7, `${contentRef} doesn't hash to its name`, r);
    if (actual !== hash) reject(7, "the destination's hash doesn't match its content", r);
    for (const block of blocks) {
      const { start, end } = block.sourceSpan;
      if (start > end || end > bytes.length)
        reject(7, `block ${block.blockId} runs outside the destination`, r);
      if (sha256(bytes.subarray(start, end)) !== block.hash)
        reject(7, `block ${block.blockId}'s hash doesn't match its bytes`, r);
    }
  }
}

/** Each artifact revision's content exists, hashes to its name and to its `proposedHash`. */
async function checkArtifactContent(records: readonly SessionRecord[], content: ContentReader) {
  for (const r of records) {
    if (r.type !== "artifact_revision") continue;
    const bytes = await content.read(r.proposedContent);
    if (bytes === undefined) reject(7, `${r.proposedContent} is missing`, r);
    const actual = sha256(bytes);
    if (`content/${actual.replace(":", "-")}` !== r.proposedContent)
      reject(7, `${r.proposedContent} doesn't hash to its name`, r);
    if (actual !== r.proposedHash) reject(7, "the proposedHash doesn't match its content", r);
  }
}

/**
 * Retained exchanges (§4.8). A call's request reference equals its manifest's; with
 * `retainModelInputs` off both references are null, and with it on the request reference is set.
 * Every reference names a file whose bytes hash to its name, unless an `inputs_purged` record
 * comes after the call: after its first revision for the request, after the revision that added
 * it for the response. A file that is still there is checked either way.
 */
async function checkRetainedExchanges(records: readonly SessionRecord[], content: ContentReader) {
  const purges = records.filter((r) => r.type === "inputs_purged").map((r) => r.seq);
  const purgedAfter = (seq: number) => purges.some((purge) => purge > seq);
  const callStart = new Map<string, number>();
  // Check 4 put the first generation_config before every call, so this is set at any call.
  let retain: boolean | undefined;
  const verified = new Set<string>();

  async function verify(ref: string, since: number, r: SessionRecord): Promise<void> {
    if (verified.has(ref) && !purgedAfter(since)) return;
    const bytes = await content.read(ref);
    if (bytes === undefined) {
      if (purgedAfter(since)) return;
      reject(7, `${ref} is missing`, r);
    }
    const hex = sha256(bytes).slice("sha256:".length);
    if (ref !== `${ref.slice(0, ref.indexOf("/"))}/sha256-${hex}.json`)
      reject(7, `${ref} doesn't hash to its name`, r);
    verified.add(ref);
  }

  for (const r of records) {
    if (r.type === "generation_config") retain = r.retainModelInputs;
    if (r.type !== "model_call") continue;
    if (retain === undefined) throw new Error("check 4 puts a generation_config before every call");
    if (!callStart.has(r.modelCallId)) callStart.set(r.modelCallId, r.seq);
    const inputRef = r.retainedInputRef;
    const responseRef = r.state === "started" ? null : r.retainedResponseRef;
    if (inputRef !== r.inputManifest.retainedInputRef)
      reject(7, "the call's retainedInputRef differs from its input manifest's", r);
    if (!retain && (inputRef !== null || responseRef !== null))
      reject(7, "retainModelInputs is off, so the call retains nothing", r);
    if (retain && inputRef === null)
      reject(7, "retainModelInputs is on, so the call's request is retained", r);
    if (inputRef !== null) await verify(inputRef, callStart.get(r.modelCallId) ?? r.seq, r);
    if (responseRef !== null) await verify(responseRef, firstWith(records, r, responseRef), r);
  }
}

/** The `seq` of the call's first revision that carries `ref` as its response. */
function firstWith(
  records: readonly SessionRecord[],
  call: RecordOf<"model_call">,
  ref: string,
): number {
  const first = records.find(
    (r) =>
      r.type === "model_call" &&
      r.modelCallId === call.modelCallId &&
      r.state !== "started" &&
      r.retainedResponseRef === ref,
  );
  return first?.seq ?? call.seq;
}

// --- Check 8: state ---------------------------------------------------------------------------

function checkState(records: readonly SessionRecord[]): void {
  const states = records.filter((r) => r.type === "session_state");
  const last = states.at(-1);
  for (const state of states)
    if (state.outcome !== undefined && state !== last)
      reject(8, "only the last session_state has an outcome", state);
  checkApplyAttempts(records);
}

/**
 * Every apply attempt names an approved review of its artifact revision for the exact proposed
 * content, and records what that revision gives: `expectedOriginal` its `original`,
 * `intendedHash` its `proposedHash`, and a `resultHash` equal to `intendedHash` (DM §11.2).
 * Check 4 has made sure the artifact revision and its review exist.
 */
function checkApplyAttempts(records: readonly SessionRecord[]): void {
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    if (r.type !== "apply_attempt") continue;
    const artifact = byId.get(r.artifactRevisionId) as RecordOf<"artifact_revision">;
    const review = byId.get(r.reviewId) as RecordOf<"review">;
    if (review.outcome !== "approved") reject(8, `${review.id} isn't an approval`, r);
    if (review.contentHash !== artifact.proposedHash)
      reject(8, `${review.id} approved other content than ${artifact.id}'s proposedHash`, r);
    if (r.expectedOriginal !== artifact.original)
      reject(8, `expectedOriginal isn't ${artifact.id}'s original`, r);
    if (r.intendedHash !== artifact.proposedHash)
      reject(8, `intendedHash isn't ${artifact.id}'s proposedHash`, r);
    if ("resultHash" in r && r.resultHash !== r.intendedHash)
      reject(8, "resultHash isn't the intendedHash", r);
  }
}

// --- Check 9: assembly -----------------------------------------------------------------------

/**
 * Each artifact revision is what assembly gives for its selected revisions in its snapshot's
 * destination: the same content hash and the same attribution (DM §9.3–§9.4). Checks 4 and 7 have
 * made sure the records exist and the destination's bytes match their hash.
 */
async function checkAssembly(records: readonly SessionRecord[], content: ContentReader) {
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    if (r.type !== "artifact_revision") continue;
    const { destination } = byId.get(r.snapshotId) as Snapshot;
    let assembled: AssemblyDestination = { state: "absent" };
    if (destination.state === "present") {
      const bytes = (await content.read(destination.contentRef)) as Uint8Array;
      assembled = { state: "present", bytes, parsed: parseGuidanceBlocks(bytes) };
    }
    const selected = r.selectedRevisionIds.map(
      (id) => byId.get(id) as Revised<"recommendation_revision">,
    );
    const blocks = assembled.state === "present" ? assembled.parsed.blocks : [];
    const input = assemblyRevisionsOf(records, selected, blocks);
    if ("unresolved" in input)
      reject(9, `the target of ${input.unresolved} isn't in the artifact's snapshot`, r);
    const result = assemble(assembled, input.revisions);
    if (!result.ok) reject(9, "its selected revisions don't assemble", r);
    if (result.hash !== r.proposedHash)
      reject(9, "its content isn't what its selected revisions assemble to", r);
    if (pretty(result.attribution, "") !== pretty(r.attribution, ""))
      reject(9, "its attribution isn't the one assembly gives", r);
  }
}
