import { toJSONSchema, type z } from "zod";
import { comparePaths } from "../paths.js";

// The validation pipeline (IMPL §3.5). Every response passes schema → items → cross-item, and
// every rejection, correction or relabelling becomes a ValidationEvent with a stable rule ID.
// Transport (§3.6) comes before this, and persistence (DM §15) after it.

/**
 * Increases with any change to what is accepted, thresholds and word lists included, and with a
 * runtime whose Unicode version changes CIT-007's or SUP-002's character classes.
 */
export const VALIDATOR_VERSION = "validate/0.12.0";

/** The rule IDs this version applies. A test pins this list to `VALIDATOR_VERSION`. */
export const RULE_IDS = [
  "SCHEMA",
  "ALIAS-001",
  "ALIAS-002",
  "ALIAS-003",
  "LIMIT-001",
  "CIT-001",
  "CIT-002",
  "CIT-003",
  "CIT-004",
  "CIT-005",
  "CIT-006",
  "CIT-007",
  "CIT-008",
  "CIT-R01",
  "CIT-009",
  "CIT-010",
  "SUP-001",
  "SUP-002",
  "SUP-003",
  "SUP-004",
  "SUP-005",
  "SCOPE-001",
  "GAP-001",
  "GAP-002",
  "ABS-001",
  "ABS-002",
  "ABS-003",
  "LIMIT-002",
  "EXP-001",
  "EXP-002",
  "EXP-003",
  "EXP-004",
  "EXP-005",
  "CONF-001",
  "DUP-001",
  "DUP-002",
  "DUP-003",
  "REV-001",
  "REV-002",
  "REV-003",
  "Q-001",
  "EXP-006",
] as const;

export type ValidationStage = "schema" | "item" | "cross_item";
export type ValidationOutcome = "rejected" | "corrected" | "relabelled";

export interface ValidationEvent {
  /** A response-local key or alias; `$response` at the schema stage; `f1/citations/2`. */
  readonly itemKey: string;
  readonly stage: ValidationStage;
  readonly rule: string;
  readonly outcome: ValidationOutcome;
  /** Code-generated, with no source content and no value copied from the response. */
  readonly detail: string;
  readonly original?: unknown;
}

/** A schema issue as the retry message may report it: path and code, never the value (§3.6). */
export interface SchemaIssue {
  /**
   * Field names and indices joined with `.`; "" for the whole response. A segment that is not a
   * field name the schema defines is written `<key>`, because the model chose it.
   */
  readonly path: string;
  readonly code: string;
}

/** An event a check reports. `subKey` names a sub-item, such as `citations/2`. */
export interface CheckEvent {
  readonly rule: string;
  readonly outcome: ValidationOutcome;
  /** Code-generated. Never text from the response or the repository. */
  readonly detail: string;
  /** Code-derived values only, such as `originalLines` for CIT-R01. */
  readonly original?: unknown;
  readonly subKey?: string;
}

export type CheckResult<V> =
  | { readonly kind: "accept"; readonly value: V; readonly events: readonly CheckEvent[] }
  | {
      readonly kind: "reject";
      readonly rule: string;
      readonly detail: string;
      /** Sub-item events recorded before the item is rejected, such as each failed citation. */
      readonly events: readonly CheckEvent[];
    };

/** The item passes this check, possibly changed, with any corrections or sub-item events. */
export function accept<V>(value: V, ...events: CheckEvent[]): CheckResult<V> {
  return { kind: "accept", value, events };
}

export function reject<V>(rule: string, detail: string, ...events: CheckEvent[]): CheckResult<V> {
  return { kind: "reject", rule, detail, events };
}

/** What every check can see about the response as a whole. */
export interface ResponseScope {
  /** Every local key the response defines, including ones whose items are rejected. */
  readonly localKeys: ReadonlySet<string>;
}

/**
 * `position` is the item's index in its collection, as the response wrote it. The pipeline always
 * passes it; checks that don't need it, and tests that call them directly, leave it out.
 */
export type ItemCheck<V, C> = (
  item: V,
  context: C,
  response: ResponseScope,
  position?: number,
) => CheckResult<V>;

export interface CollectionSpec<R, V, C> {
  readonly items: (response: R) => readonly V[];
  /** How events name the item. */
  readonly key: (item: V) => ItemKey;
  /** Run in order; the item is dropped at the first rejection. */
  readonly checks: readonly ItemCheck<V, C>[];
}

/**
 * A local key the item defines (`f1`), an alias it acts on, or its position
 * (`contentNotices/0`, `revisions/2`) for an item with no key of its own. A local key or alias that isn't well formed came from the model
 * unchecked, so the item is named by position instead, and a bad key defines nothing.
 */
export type ItemKey =
  | { readonly kind: "local"; readonly key: string }
  | { readonly kind: "alias"; readonly key: string }
  | { readonly kind: "position" };

const LOCAL_KEY = /^[a-z]{1,2}[1-9][0-9]{0,3}$/;
const ALIAS_KEY = /^(?:T[1235]-[0-9]{3,}|[EFCQDRB]-[1-9][0-9]*)$/;

export interface Accepted<V> {
  readonly key: string;
  /** Position in the response's collection. */
  readonly index: number;
  readonly value: V;
  readonly corrected: boolean;
  readonly relabelled: boolean;
}

export type AcceptedItems<A> = { readonly [N in keyof A]: readonly Accepted<A[N]>[] };

export interface CrossItemRejection<A> {
  readonly collection: keyof A & string;
  readonly index: number;
  readonly rule: string;
  readonly detail: string;
  /**
   * For a duplicate: the key or alias of the item kept. Later checks see references to the
   * dropped item redirected to it (IMPL §3.3.2 step 7).
   */
  readonly mergedInto?: string;
}

/**
 * Sees only items that are still accepted, and returns the ones to reject. `redirects` maps the
 * key of each duplicate dropped so far to the key or alias of the item kept.
 */
export type CrossItemCheck<A, C> = (
  surviving: AcceptedItems<A>,
  context: C,
  redirects?: ReadonlyMap<string, string>,
) => readonly CrossItemRejection<A>[];

export interface CallValidator<R, C, A> {
  readonly schema: z.ZodType<R>;
  /** Collections in schema order; events follow it. */
  readonly order: readonly (keyof A & string)[];
  readonly collections: { readonly [N in keyof A]: CollectionSpec<R, A[N], C> };
  readonly crossItem: readonly CrossItemCheck<A, C>[];
}

export interface ValidationCounts {
  /** Unknown when the schema fails: the response's items can't be counted. Never zero then. */
  readonly proposed:
    | { readonly state: "known"; readonly count: number }
    | { readonly state: "unknown"; readonly reason: "schema_failed" };
  readonly accepted: number;
  /** Accepted items with at least one correction. */
  readonly corrected: number;
  /** Accepted items with at least one relabelling. */
  readonly relabelled: number;
  /** Rejected events by rule, items and sub-items alike, in bytewise rule order. */
  readonly rejectionsByRule: readonly { readonly rule: string; readonly count: number }[];
}

/** An item the item or cross-item stage rejected, for its failed record (IMPL §4.4.3). */
export interface RejectedItem {
  readonly collection: string;
  /** Position in the response's collection; the response holds the item as written. */
  readonly index: number;
  /** As its validation events name it. */
  readonly key: string;
  readonly stage: "item" | "cross_item";
  /** The rule that rejected it. An item stops at its first rejection, so there is one. */
  readonly rule: string;
}

export type ValidationResult<A, R = unknown> =
  | {
      readonly status: "schema_failed";
      readonly validatorVersion: string;
      readonly issues: readonly SchemaIssue[];
      readonly events: readonly ValidationEvent[];
      readonly counts: ValidationCounts;
    }
  | {
      readonly status: "validated";
      readonly validatorVersion: string;
      /** The parsed response, for what is computed from it, such as the corrected-citation rate. */
      readonly response: R;
      readonly accepted: AcceptedItems<A>;
      /** Each dropped duplicate's key, mapped to the key or alias of the item kept. */
      readonly redirects: ReadonlyMap<string, string>;
      /** Every rejected item, item stage first, each stage in event order. */
      readonly rejected: readonly RejectedItem[];
      readonly events: readonly ValidationEvent[];
      readonly counts: ValidationCounts;
    };

const RESPONSE_KEY = "$response";

export function validateResponse<R, C, A>(
  call: CallValidator<R, C, A>,
  text: string,
  context: C,
): ValidationResult<A, R> {
  const parsed = parseSchema(call.schema, text);
  if (!parsed.ok) {
    const events = parsed.issues.map(
      (issue): ValidationEvent => ({
        itemKey: RESPONSE_KEY,
        stage: "schema",
        rule: "SCHEMA",
        outcome: "rejected",
        detail: `${issue.path === "" ? "(root)" : issue.path}: ${issue.code}`,
      }),
    );
    return {
      status: "schema_failed",
      validatorVersion: VALIDATOR_VERSION,
      issues: parsed.issues,
      events,
      counts: {
        proposed: { state: "unknown", reason: "schema_failed" },
        accepted: 0,
        corrected: 0,
        relabelled: 0,
        rejectionsByRule: countRejections(events),
      },
    };
  }
  const response = parsed.value;
  const events: ValidationEvent[] = [];

  const proposed = call.order.map((name) => {
    const spec = call.collections[name];
    return {
      name,
      spec,
      items: spec.items(response).map((value, index) => ({
        value,
        index,
        ...itemKey(spec.key(value), `${name}/${index}`),
      })),
    };
  });
  const definitions = new Map<string, number>();
  for (const collection of proposed)
    for (const item of collection.items)
      if (item.defines) definitions.set(item.key, (definitions.get(item.key) ?? 0) + 1);
  const scope: ResponseScope = { localKeys: new Set(definitions.keys()) };

  // Item stage: each item on its own, in response order, ALIAS-002 first.
  const survivors = new Map<string, Accepted<unknown>[]>();
  const rejected: RejectedItem[] = [];
  const recordRejection = (
    collection: string,
    index: number,
    key: string,
    stage: RejectedItem["stage"],
    rule: string,
  ) => {
    rejected.push({ collection, index, key, stage, rule });
  };
  for (const { name, spec, items } of proposed) {
    const kept: Accepted<unknown>[] = [];
    for (const item of items) {
      if (item.defines && (definitions.get(item.key) ?? 0) > 1) {
        events.push(rejection(item.key, "item", "ALIAS-002", "local key defined more than once"));
        recordRejection(name, item.index, item.key, "item", "ALIAS-002");
        continue;
      }
      let value = item.value;
      let corrected = false;
      let relabelled = false;
      let dropped = false;
      for (const check of spec.checks) {
        const result = check(value, context, scope, item.index);
        for (const event of result.events) {
          events.push({
            itemKey: event.subKey === undefined ? item.key : `${item.key}/${event.subKey}`,
            stage: "item",
            rule: event.rule,
            outcome: event.outcome,
            detail: event.detail,
            ...(event.original === undefined ? {} : { original: event.original }),
          });
          // A sub-item rejection, such as one citation, leaves the item itself unchanged.
          if (event.outcome === "corrected") corrected = true;
          if (event.outcome === "relabelled") relabelled = true;
        }
        if (result.kind === "reject") {
          events.push(rejection(item.key, "item", result.rule, result.detail));
          recordRejection(name, item.index, item.key, "item", result.rule);
          dropped = true;
          break;
        }
        value = result.value;
      }
      if (!dropped) kept.push({ key: item.key, index: item.index, value, corrected, relabelled });
    }
    survivors.set(name, kept);
  }

  // Cross-item stage: each check sees what is still accepted, in rule order.
  // Each collection's list holds that collection's value type; the map erases it.
  const current = (): AcceptedItems<A> =>
    Object.fromEntries(
      call.order.map((name) => [name, [...(survivors.get(name) ?? [])]]),
    ) as unknown as AcceptedItems<A>;
  const position = (name: string): number => call.order.indexOf(name as keyof A & string);
  const redirects = new Map<string, string>();
  for (const check of call.crossItem) {
    // Events follow item order whatever order the check returns them in.
    const rejections = [...check(current(), context, redirects)].sort(
      (a, b) => position(a.collection) - position(b.collection) || a.index - b.index,
    );
    for (const { collection, index, rule, detail, mergedInto } of rejections) {
      const list = survivors.get(collection) ?? [];
      const at = list.findIndex((item) => item.index === index);
      const item = list[at];
      if (item === undefined) continue;
      list.splice(at, 1);
      if (mergedInto !== undefined) redirects.set(item.key, mergedInto);
      events.push(rejection(item.key, "cross_item", rule, detail));
      recordRejection(collection, index, item.key, "cross_item", rule);
    }
  }

  const accepted = current();
  const all = call.order.flatMap((name) => accepted[name] as readonly Accepted<unknown>[]);
  return {
    status: "validated",
    validatorVersion: VALIDATOR_VERSION,
    response,
    accepted,
    redirects,
    rejected,
    events,
    counts: {
      proposed: {
        state: "known",
        count: proposed.reduce((sum, collection) => sum + collection.items.length, 0),
      },
      accepted: all.length,
      corrected: all.filter((item) => item.corrected).length,
      relabelled: all.filter((item) => item.relabelled).length,
      rejectionsByRule: countRejections(events),
    },
  };
}

function itemKey(key: ItemKey, position: string): { key: string; defines: boolean } {
  if (key.kind === "local" && LOCAL_KEY.test(key.key)) return { key: key.key, defines: true };
  if (key.kind === "alias" && ALIAS_KEY.test(key.key)) return { key: key.key, defines: false };
  return { key: position, defines: false };
}

function rejection(
  itemKey: string,
  stage: ValidationStage,
  rule: string,
  detail: string,
): ValidationEvent {
  return { itemKey, stage, rule, outcome: "rejected", detail };
}

function parseSchema<R>(
  schema: z.ZodType<R>,
  text: string,
): { ok: true; value: R } | { ok: false; issues: SchemaIssue[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: "", code: "invalid_json" }] };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  // Only the path and the issue code: the message and the issue's other fields can quote the
  // received value, which may hold source text the model copied. So can a path segment that is
  // a key the model chose, as in a record.
  const names = fieldNames(schema);
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path
        .map((segment) =>
          typeof segment === "number" || (typeof segment === "string" && names.has(segment))
            ? String(segment)
            : "<key>",
        )
        .join("."),
      code: issue.code,
    })),
  };
}

const FIELD_NAMES = new WeakMap<object, ReadonlySet<string>>();

/** Every object property name the schema defines, at any depth. */
function fieldNames(schema: z.ZodType): ReadonlySet<string> {
  const cached = FIELD_NAMES.get(schema);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (typeof node === "object" && node !== null)
      for (const [key, child] of Object.entries(node)) {
        if (key === "properties" && typeof child === "object" && child !== null)
          for (const name of Object.keys(child)) names.add(name);
        visit(child);
      }
  };
  try {
    visit(toJSONSchema(schema));
  } catch {
    // A schema JSON Schema can't express keeps no names, so every string segment is withheld.
  }
  FIELD_NAMES.set(schema, names);
  return names;
}

function countRejections(events: readonly ValidationEvent[]): ValidationCounts["rejectionsByRule"] {
  const counts = new Map<string, number>();
  for (const event of events)
    if (event.outcome === "rejected") counts.set(event.rule, (counts.get(event.rule) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([rule, count]) => ({ rule, count }));
}
