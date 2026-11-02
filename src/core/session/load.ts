import { sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";
import { isFailed, LINEAGE_FIELDS, lineageOf, SELF_SUPERSEDING } from "./log.js";
import {
  CURRENT_STATUSES,
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
// Checks 4, 7 and 8 cover the record types the file schema accepts so far. Artifact content and
// the apply-approval check arrive with their record types (M5).
//
// Some branches can't be reached yet, because ID prefixes and the schema stop the input first:
// a lineage ID used as a record ID, a record reference of the wrong type, a lineage whose
// revisions all failed, and superseding a failed or immutable record. They become reachable
// with the M5 records, whose step tests them. The CLI words the messages (`src/cli`).

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

/** A revision repeats every field of `base` that its type doesn't change (§4.4.1). */
function checkRepeats(base: SessionRecord, revision: SessionRecord): void {
  const changeable = new Set(REVISION_FIELDS[revision.type as RevisableType]);
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
  | { readonly field: string; readonly names: "lineage"; readonly type: RecordTypeName };

const record = (field: string, type: RecordTypeName): Reference => ({
  field,
  names: "record",
  type,
});
const lineage = (field: string, type: RecordTypeName): Reference => ({
  field,
  names: "lineage",
  type,
});

/**
 * The references table of IMPL §4.4.1, for the record types the file schema accepts so far.
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
  recommendation_revision: [producedBy],
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
      } else {
        const revisions = lineages.get(`${reference.type}\u0000${id}`);
        if (revisions === undefined)
          reject(4, `${reference.field} names ${id}, which isn't a ${reference.type}`, r);
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

/**
 * Retained exchanges (§4.8). A call's request reference equals its manifest's; with
 * `retainModelInputs` off both references are null, and with it on the request reference is set.
 * Every reference names a file whose bytes hash to its name.
 */
async function checkRetainedExchanges(records: readonly SessionRecord[], content: ContentReader) {
  let retain: boolean | undefined;
  const verified = new Set<string>();

  async function verify(ref: string, r: SessionRecord): Promise<void> {
    if (verified.has(ref)) return;
    const bytes = await content.read(ref);
    if (bytes === undefined) reject(7, `${ref} is missing`, r);
    const hex = sha256(bytes).slice("sha256:".length);
    if (ref !== `${ref.slice(0, ref.indexOf("/"))}/sha256-${hex}.json`)
      reject(7, `${ref} doesn't hash to its name`, r);
    verified.add(ref);
  }

  for (const r of records) {
    // A call before any generation_config has no setting to check against. The session start
    // writes the config before any call; no load check requires that order yet.
    if (r.type === "generation_config") retain = r.retainModelInputs;
    if (r.type !== "model_call") continue;
    const inputRef = r.retainedInputRef;
    const responseRef = r.state === "started" ? null : r.retainedResponseRef;
    if (inputRef !== r.inputManifest.retainedInputRef)
      reject(7, "the call's retainedInputRef differs from its input manifest's", r);
    if (retain === false && (inputRef !== null || responseRef !== null))
      reject(7, "retainModelInputs is off, so the call retains nothing", r);
    if (retain === true && inputRef === null)
      reject(7, "retainModelInputs is on, so the call's request is retained", r);
    if (inputRef !== null) await verify(inputRef, r);
    if (responseRef !== null) await verify(responseRef, r);
  }
}

// --- Check 8: state ---------------------------------------------------------------------------

function checkState(records: readonly SessionRecord[]): void {
  const states = records.filter((r) => r.type === "session_state");
  const last = states.at(-1);
  for (const state of states)
    if (state.outcome !== undefined && state !== last)
      reject(8, "only the last session_state has an outcome", state);
}
