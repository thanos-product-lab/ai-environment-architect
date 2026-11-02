import type { Clock, IdSource } from "../ports.js";
import {
  CURRENT_STATUSES,
  RECORD_KINDS,
  REVISION_FIELDS,
  type RecordKind,
  type RecordOf,
  type RevisableType,
  type SessionRecord,
  sessionRecord,
} from "./records.js";

// The append-only record log (IMPL §4.4.1). Code assigns every ID, `seq` and `createdAt`; the
// model never does. Records are frozen once appended: a change is a new record.
//
// - A revision repeats every field of the one before, changes what changed, and supersedes it.
// - A replacement starts a new lineage whose `supersedes` lists the current revision of every
//   lineage it replaces.
// - A `failed_validation` record supersedes nothing and is never superseded.

type Type = SessionRecord["type"];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Inputs may be read-only: domain values are, and the log copies what it stores. */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export const LINEAGE_FIELDS = [
  "findingId",
  "conflictId",
  "questionId",
  "recommendationId",
  "applyAttemptId",
  "modelCallId",
  "effortIntervalId",
] as const;

// Immutable records that a later one of their own type may supersede (IMPL §4.9 check 5).
export const SELF_SUPERSEDING: ReadonlySet<string> = new Set(["decision", "effort_correction"]);

type Envelope = "type" | "id" | "seq" | "createdAt";

/** A record without the fields code assigns when it is appended. */
export type Draft<T extends Type> = DeepReadonly<
  DistributiveOmit<RecordOf<T>, Exclude<Envelope, "type">>
>;

/** The first revision of a lineage, without its lineage ID and revision number. */
export type LineageStart<T extends Type> = DeepReadonly<
  DistributiveOmit<
    RecordOf<T>,
    Exclude<Envelope, "type"> | "revision" | (typeof LINEAGE_FIELDS)[number]
  >
>;

/** The only types a model call revises, so the only ones with `revisedBy` (§4.4.1). */
const REVISED_BY_TYPES: ReadonlySet<string> = new Set(["finding", "conflict"]);

/** Fields every revision repeats unchanged: what the lineage is, and what created it. */
const FIXED_ON_REVISION = ["producedBy", "kind", "snapshotId"] as const;

/** What a revision changes. A field set to `undefined` is removed. */
export type Changes<T extends Type> = Partial<
  DeepReadonly<
    DistributiveOmit<
      RecordOf<T>,
      | Envelope
      | "revision"
      | "supersedes"
      | (typeof LINEAGE_FIELDS)[number]
      | (typeof FIXED_ON_REVISION)[number]
    >
  >
>;

/** A record of a lineage that isn't `failed_validation`, so it has its lineage ID. */
export type Revised<T extends Type> = Exclude<
  Extract<RecordOf<T>, { revision: number }>,
  { status: "failed_validation" }
>;

export interface LogPorts {
  readonly clock: Clock;
  readonly ids: IdSource;
}

export function isFailed(record: SessionRecord): boolean {
  return "status" in record && record.status === "failed_validation";
}

/**
 * The lineage a record belongs to: its lineage ID, the type itself for `session_state` and
 * `generation_config`, whose lineage is the session, or undefined for an immutable record.
 */
export function lineageOf(record: SessionRecord): string | undefined {
  const kind: RecordKind = RECORD_KINDS[record.type];
  if (kind.sessionLineage) return record.type;
  if (kind.lineage === undefined) return undefined;
  const value = (record as unknown as Record<string, unknown>)[kind.lineage.field];
  return typeof value === "string" ? value : undefined;
}

export class SessionLog {
  readonly #records: SessionRecord[] = [];
  readonly #byId = new Map<string, SessionRecord>();
  readonly #superseded = new Set<string>();
  readonly #ports: LogPorts;

  /** `records` are a loaded session's, already checked (IMPL §4.9). */
  constructor(ports: LogPorts, records: readonly SessionRecord[] = []) {
    this.#ports = ports;
    for (const record of records) this.#index(record);
  }

  get records(): readonly SessionRecord[] {
    return this.#records;
  }

  get(id: string): SessionRecord | undefined {
    return this.#byId.get(id);
  }

  /** The record with this ID, which must be of this type. A miss is a bug in the caller. */
  require<T extends Type>(type: T, id: string): RecordOf<T> {
    const record = this.#byId.get(id);
    if (record?.type !== type) throw new Error(`no ${type} record ${id}`);
    return record as RecordOf<T>;
  }

  /** Every revision of a lineage, in `seq` order. */
  revisions<T extends Type>(type: T, lineage: string): RecordOf<T>[] {
    return this.#records.filter(
      (record): record is RecordOf<T> => record.type === type && lineageOf(record) === lineage,
    );
  }

  isSuperseded(id: string): boolean {
    return this.#superseded.has(id);
  }

  newId(prefix: string): string {
    return this.#ports.ids.next(prefix);
  }

  /**
   * Appends a record as given, with its ID, `seq` and `createdAt`. `id` is for a record whose ID
   * was assigned before it was persisted, such as a snapshot's.
   */
  append<D extends Draft<Type>>(
    draft: D,
    options: { readonly id?: string } = {},
  ): RecordOf<D["type"]> {
    const type: D["type"] = draft.type;
    const candidate = {
      ...withoutUndefined(draft as Record<string, unknown>),
      type,
      id: options.id ?? this.#ports.ids.next(RECORD_KINDS[type].record),
      seq: this.#records.length + 1,
      createdAt: this.#ports.clock.now().toISOString(),
    };
    for (const id of (candidate as { supersedes?: readonly string[] }).supersedes ?? [])
      this.#checkSupersedable(type, id);
    this.#checkLineage(candidate as unknown as SessionRecord);
    const parsed = sessionRecord.safeParse(candidate);
    if (!parsed.success)
      throw new Error(
        `invalid ${type} record: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    return this.#index(parsed.data) as RecordOf<D["type"]>;
  }

  /**
   * Starts a lineage: revision 1, with a new lineage ID, or the session's own lineage for
   * `session_state` and `generation_config`. A replacement passes the records it replaces as
   * `supersedes`.
   */
  start<D extends LineageStart<Type>>(draft: D): Revised<D["type"]> {
    const type: D["type"] = draft.type;
    const kind: RecordKind = RECORD_KINDS[type];
    if (kind.sessionLineage) {
      if (this.revisions(type, type).length > 0)
        throw new Error(`${type} already started; revise it`);
      return this.append({ ...draft, revision: 1 } as unknown as Draft<Type>) as Revised<D["type"]>;
    }
    if (kind.lineage === undefined) throw new Error(`${type} has no lineage`);
    return this.append({
      ...draft,
      [kind.lineage.field]: this.#ports.ids.next(kind.lineage.prefix),
      revision: 1,
    } as unknown as Draft<Type>) as Revised<D["type"]>;
  }

  /**
   * Appends the next revision of a lineage. It repeats every field of the latest revision that
   * isn't `failed_validation`, applies `changes`, and supersedes that revision, which must not
   * already be superseded. For `session_state` and `generation_config` the lineage is the type.
   */
  revise<T extends Type>(type: T, lineage: string, changes: Changes<T>): Revised<T> {
    const all = this.revisions(type, lineage);
    const base = all.filter((record) => !isFailed(record)).at(-1);
    const last = all.at(-1);
    if (base === undefined || last === undefined)
      throw new Error(`no ${type} revision to revise in ${lineage}`);
    for (const field of [...FIXED_ON_REVISION, ...LINEAGE_FIELDS, "type", "revision", "supersedes"])
      if (field in changes) throw new Error(`a revision can't change ${field}`);
    const changeable = REVISION_FIELDS[type as RevisableType];
    for (const field of Object.keys(changes))
      if (!(field === "revisedBy" && REVISED_BY_TYPES.has(type)) && !changeable.includes(field))
        throw new Error(`a ${type} revision can't change ${field}`);
    const {
      id: _id,
      seq: _seq,
      createdAt: _createdAt,
      // Names who appended that revision, so it is never repeated.
      revisedBy: _revisedBy,
      ...fields
    } = base as unknown as Record<string, unknown>;
    return this.append({
      ...fields,
      ...changes,
      revision: (last as { revision: number }).revision + 1,
      supersedes: [base.id],
    } as unknown as Draft<Type>) as Revised<T>;
  }

  #checkSupersedable(type: Type, id: string): void {
    const target = this.#byId.get(id);
    if (target === undefined) throw new Error(`supersedes unknown record ${id}`);
    if (target.type !== type) throw new Error(`a ${type} can't supersede a ${target.type}`);
    if (isFailed(target)) throw new Error(`${id} failed validation and can't be superseded`);
    if (this.#superseded.has(id)) throw new Error(`${id} is already superseded`);
    if (lineageOf(target) === undefined && !SELF_SUPERSEDING.has(type))
      throw new Error(`${id} is immutable`);
    const current = CURRENT_STATUSES[type];
    const status = (target as { status?: string }).status;
    if (current !== undefined && status !== undefined && !current.has(status))
      throw new Error(`${id} is ${status}, so it isn't current and can't be superseded`);
  }

  /**
   * A lineage's revisions are numbered 1, 2, 3… in order, and each one after the first that
   * isn't `failed_validation` supersedes exactly the latest earlier one that isn't (§4.4.1).
   */
  #checkLineage(record: SessionRecord): void {
    const lineage = lineageOf(record);
    if (lineage === undefined) return;
    const earlier = this.revisions(record.type, lineage);
    const revision = (record as { revision?: number }).revision;
    const expected = ((earlier.at(-1) as { revision?: number } | undefined)?.revision ?? 0) + 1;
    if (revision !== expected)
      throw new Error(`${record.type} ${lineage} needs revision ${expected}, not ${revision}`);
    if (earlier.length === 0 || isFailed(record)) return;
    const base = earlier.filter((r) => !isFailed(r)).at(-1);
    const supersedes = (record as { supersedes?: readonly string[] }).supersedes ?? [];
    const wanted = base === undefined ? [] : [base.id];
    if (supersedes.join() !== wanted.join())
      throw new Error(
        `${record.type} ${lineage} revision ${revision} must supersede ${wanted.join() || "nothing"}`,
      );
  }

  #index(record: SessionRecord): SessionRecord {
    const frozen = deepFreeze(record);
    this.#records.push(frozen);
    this.#byId.set(frozen.id, frozen);
    for (const id of (frozen as { supersedes?: readonly string[] }).supersedes ?? [])
      this.#superseded.add(id);
    return frozen;
  }
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
