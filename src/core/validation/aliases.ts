import type { Hash } from "../hash.js";

// Aliases (IMPL §3.2.1). The model refers to records only by short aliases; code maps each one to
// a real ID, and the table is recorded on the model call (DM §13.1). The model never sees or
// returns a record ID, a block ID or a hash.

export type CallPurpose =
  | "analyse"
  | "analyse_expansion"
  | "generate_questions"
  | "recommend"
  | "regenerate_recommendations";

export type AliasKind = "T" | "E" | "F" | "C" | "Q" | "D" | "R" | "B";

/** The kinds each call's input may hold, in the order a table lists them. */
export const CALL_ALIAS_KINDS: Readonly<Record<CallPurpose, readonly AliasKind[]>> = {
  analyse: ["T", "E", "B"],
  analyse_expansion: ["T", "E", "F", "C", "B"],
  generate_questions: ["F", "C", "B"],
  recommend: ["F", "C", "Q", "D", "B"],
  regenerate_recommendations: ["F", "C", "Q", "D", "R", "B"],
};

export type AliasTarget =
  /** A context or expansion item, by its rendered ID (IMPL §1.6, §1.8). */
  | { readonly kind: "item"; readonly itemId: string }
  /** A finding, conflict, question, decision or recommendation. */
  | { readonly kind: "record"; readonly recordId: string }
  /** A destination Guidance Block (DM §7). */
  | { readonly kind: "block"; readonly blockId: string; readonly hash: Hash };

export interface AliasEntry {
  readonly alias: string;
  readonly kind: AliasKind;
  readonly target: AliasTarget;
}

/** What a call's input holds. Each list is in the order the caller fixes (IMPL §3.2.1). */
export interface AliasSources {
  /** Context and expansion item IDs as rendered: `T<tier>-<nnn>` and `E-<n>`. */
  readonly items?: readonly string[];
  readonly findings?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly questions?: readonly string[];
  readonly decisions?: readonly string[];
  readonly recommendations?: readonly string[];
  /** In document order, as the BLOCKS section numbers them (IMPL §1.6). */
  readonly blocks?: readonly { readonly blockId: string; readonly hash: Hash }[];
}

export interface AliasTable {
  readonly call: CallPurpose;
  /** By kind in `CALL_ALIAS_KINDS` order, then by position. */
  readonly entries: readonly AliasEntry[];
}

// At least three digits: the 1000th item in a tier is `T2-1000` (IMPL §1.6).
const ITEM_ID = /^(?:T[1235]-[0-9]{3,}|E-[1-9][0-9]*)$/;

/** The alias of the block at `position`, counting from 1 in document order. */
export function blockAlias(position: number): string {
  return `B-${position}`;
}

export function createAliasTable(call: CallPurpose, sources: AliasSources): AliasTable {
  const allowed = CALL_ALIAS_KINDS[call];
  const byKind = new Map<AliasKind, AliasEntry[]>();
  const add = (kind: AliasKind, alias: string, target: AliasTarget): void => {
    if (!allowed.includes(kind)) throw new Error(`${kind} aliases are not part of ${call} input`);
    const list = byKind.get(kind) ?? [];
    if (list.some((entry) => entry.alias === alias)) throw new Error(`duplicate alias ${alias}`);
    list.push({ alias, kind, target });
    byKind.set(kind, list);
  };
  for (const itemId of sources.items ?? []) {
    if (!ITEM_ID.test(itemId)) throw new Error(`not a rendered item ID: ${itemId}`);
    add(itemId.startsWith("T") ? "T" : "E", itemId, { kind: "item", itemId });
  }
  const records: readonly [AliasKind, readonly string[] | undefined][] = [
    ["F", sources.findings],
    ["C", sources.conflicts],
    ["Q", sources.questions],
    ["D", sources.decisions],
    ["R", sources.recommendations],
  ];
  for (const [kind, ids] of records)
    (ids ?? []).forEach((recordId, index) => {
      add(kind, `${kind}-${index + 1}`, { kind: "record", recordId });
    });
  (sources.blocks ?? []).forEach((block, index) => {
    add("B", blockAlias(index + 1), { kind: "block", blockId: block.blockId, hash: block.hash });
  });
  return { call, entries: allowed.flatMap((kind) => byKind.get(kind) ?? []) };
}

/** What a field accepts: alias kinds, and the prefixes of response-local keys (`f`, `g`, …). */
export interface Accepts {
  readonly aliases: readonly AliasKind[];
  readonly localKeys?: readonly string[];
}

export type Reference =
  | { readonly kind: "alias"; readonly alias: string; readonly target: AliasTarget }
  | { readonly kind: "local"; readonly key: string };

export type Resolution =
  | { readonly ok: true; readonly reference: Reference }
  | { readonly ok: false; readonly rule: "ALIAS-001" | "ALIAS-003"; readonly detail: string };

/**
 * Resolves one reference in a response. It matches exactly: no change of case, trimming or
 * padding. `localKeys` are the keys the response defines, whether or not their items survive;
 * a reference to a rejected item fails the referring item's own rule, not an alias rule.
 *
 * A detail names a table alias, which code made, or a defined local key, which the pipeline has
 * checked is well formed. It never repeats an unknown value, which may be any text.
 */
export function resolveReference(
  table: AliasTable,
  localKeys: ReadonlySet<string>,
  value: string,
  accepts: Accepts,
): Resolution {
  const acceptedText = [...accepts.aliases, ...(accepts.localKeys ?? [])].join(", ");
  const entry = table.entries.find((candidate) => candidate.alias === value);
  if (entry !== undefined) {
    if (!accepts.aliases.includes(entry.kind))
      return {
        ok: false,
        rule: "ALIAS-003",
        detail: `${value} is a ${entry.kind} alias; this field accepts ${acceptedText}`,
      };
    return { ok: true, reference: { kind: "alias", alias: value, target: entry.target } };
  }
  if (localKeys.has(value)) {
    const prefix = keyPrefix(value);
    if (!(accepts.localKeys ?? []).includes(prefix))
      return {
        ok: false,
        rule: "ALIAS-003",
        detail: `${value} is a ${prefix} key; this field accepts ${acceptedText}`,
      };
    return { ok: true, reference: { kind: "local", key: value } };
  }
  const local =
    (accepts.localKeys ?? []).includes(keyPrefix(value)) && /^[a-z]+[0-9]+$/.test(value);
  return {
    ok: false,
    rule: "ALIAS-001",
    detail: local
      ? "a local key not defined in this response"
      : "an alias not in this call's input",
  };
}

function keyPrefix(key: string): string {
  return /^[a-z]*/.exec(key)?.[0] ?? "";
}
