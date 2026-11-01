import { type AliasTable, resolveReference } from "./aliases.js";
import {
  aliasPaths,
  type Carry,
  type ConflictItems,
  type FindingSources,
  findingPaths,
  resolveMembers,
} from "./conflicts.js";
import {
  type AcceptedItems,
  accept,
  type CrossItemCheck,
  type CrossItemRejection,
  type ItemCheck,
  reject,
} from "./pipeline.js";
import { hasDistinctSources } from "./support.js";

// Revisions in `analyse_expansion` (IMPL §3.3.3): the model withdraws or replaces a call-1
// finding or conflict. Records code produced, known facts and deterministic gaps, are code's, so
// the model can't revise them. Withdrawn and replaced records are kept for history, and are no
// longer passed forward.

export type Revision =
  | { readonly target: string; readonly action: "withdraw"; readonly reason: string }
  | {
      readonly target: string;
      readonly action: "replace";
      readonly replacement: string;
      readonly reason: string;
    };

export interface RevisionContext {
  readonly aliases: AliasTable;
  /** The `F` aliases of records produced by code (`producedBy: deterministic`). */
  readonly deterministic: ReadonlySet<string>;
}

/** ALIAS-001 and ALIAS-003 on the target and the replacement, then REV-002. */
export function revisionCheck<C extends RevisionContext>(): ItemCheck<Revision, C> {
  return (value, context, response) => {
    const target = resolveReference(context.aliases, response.localKeys, value.target, {
      aliases: ["F", "C"],
    });
    if (!target.ok) return reject(target.rule, target.detail);
    if (value.action === "replace") {
      // An F is replaced only by a finding, a C only by a conflict.
      const prefix = value.target.startsWith("F-") ? "f" : "c";
      const replacement = resolveReference(context.aliases, response.localKeys, value.replacement, {
        aliases: [],
        localKeys: [prefix],
      });
      if (!replacement.ok) return reject(replacement.rule, replacement.detail);
    }
    if (context.deterministic.has(value.target))
      return reject("REV-002", `${value.target} was produced by code`);
    return accept(value);
  };
}

type RevisionItems = ConflictItems & { revisions: Revision };

/** REV-003: the first revision of a target is kept. */
export function repeatedTargetCheck<A extends RevisionItems, C>(): CrossItemCheck<A, C> {
  return (surviving) => {
    const seen = new Set<string>();
    return surviving.revisions.flatMap((item): CrossItemRejection<A>[] => {
      if (!seen.has(item.value.target)) {
        seen.add(item.value.target);
        return [];
      }
      return [
        {
          collection: "revisions",
          index: item.index,
          rule: "REV-003",
          detail: `${item.value.target} is already revised in this response`,
        },
      ];
    });
  };
}

/** The surviving item a replacement stands for, after redirection; undefined if none. */
function replacementOf<A extends RevisionItems>(
  revision: Revision & { action: "replace" },
  surviving: AcceptedItems<A>,
  redirects: ReadonlyMap<string, string>,
): string | undefined {
  const key = redirects.get(revision.replacement) ?? revision.replacement;
  const pool = revision.target.startsWith("F-") ? surviving.findings : surviving.conflicts;
  return pool.some((item) => item.key === key) ? key : undefined;
}

/**
 * How the surviving revisions carry conflict members: a withdrawn finding is lost, and a
 * replaced one stands for its replacement while that replacement survives. A replacement that
 * didn't survive carries nothing, because REV-001 keeps the original.
 */
export function carryThroughRevisions<A extends RevisionItems>(
  surviving: AcceptedItems<A>,
  redirects: ReadonlyMap<string, string>,
): Carry {
  const carry = new Map<string, string | null>();
  for (const { value } of surviving.revisions) {
    if (!value.target.startsWith("F-")) continue;
    if (value.action === "withdraw") carry.set(value.target, null);
    else {
      const replacement = replacementOf(value, surviving, redirects);
      if (replacement !== undefined) carry.set(value.target, replacement);
    }
  }
  return carry;
}

/** REV-001: a replacement must pass validation; otherwise the original is kept. Run last. */
export function replacementCheck<A extends RevisionItems, C>(): CrossItemCheck<A, C> {
  return (surviving, _context, redirects = new Map()) =>
    surviving.revisions.flatMap((item): CrossItemRejection<A>[] =>
      item.value.action === "replace" &&
      replacementOf(item.value, surviving, redirects) === undefined
        ? [
            {
              collection: "revisions",
              index: item.index,
              rule: "REV-001",
              detail: `the replacement for ${item.value.target} did not pass validation`,
            },
          ]
        : [],
    );
}

/** A call-1 conflict, by alias, with its members as `F` aliases. */
export interface PriorConflict {
  readonly alias: string;
  readonly members: readonly string[];
}

export type WithdrawnReason =
  | "withdrawn_by_model"
  | "member_withdrawn"
  | "members_merged"
  | "sources_not_distinct";

/** What this call does to one call-1 conflict (§3.3.3, DM §6.5). */
export type ConflictOutcome =
  | { readonly alias: string; readonly status: "kept" }
  /** A new conflict revision with these members supersedes the old one. */
  | { readonly alias: string; readonly status: "revised"; readonly members: readonly string[] }
  /** A new conflict, the response's conflict with this key, supersedes the old one. */
  | { readonly alias: string; readonly status: "replaced"; readonly replacement: string }
  | {
      readonly alias: string;
      readonly status: "withdrawn";
      readonly withdrawnReason: WithdrawnReason;
    };

/**
 * One outcome for every call-1 conflict, in the order given. A conflict an accepted revision
 * targets is withdrawn or replaced by it. Otherwise any change to its members, one lost or one
 * standing for its replacement, runs CONF-001 and then SUP-005 on the new set (§3.3.3). These
 * are outcomes for call-1 records, not rejections of the response, so they produce no events.
 */
export function priorConflictOutcomes<A extends RevisionItems>(
  conflicts: readonly PriorConflict[],
  surviving: AcceptedItems<A>,
  redirects: ReadonlyMap<string, string>,
  sources: FindingSources,
): ConflictOutcome[] {
  const revisions = new Map(surviving.revisions.map((item) => [item.value.target, item.value]));
  const carry = carryThroughRevisions(surviving, redirects);
  const findings = findingPaths(surviving);
  const aliases = aliasPaths(sources);
  return conflicts.map((conflict): ConflictOutcome => {
    const { alias } = conflict;
    const revision = revisions.get(alias);
    if (revision?.action === "withdraw")
      return { alias, status: "withdrawn", withdrawnReason: "withdrawn_by_model" };
    if (revision?.action === "replace")
      return {
        alias,
        status: "replaced",
        replacement: redirects.get(revision.replacement) ?? revision.replacement,
      };
    if (!conflict.members.some((member) => carry.has(member))) return { alias, status: "kept" };
    const resolved = resolveMembers(conflict.members, findings, aliases, new Map(), carry);
    if (resolved.length < 2) {
      // Fewer than two members with none withdrawn means replacements made them one finding.
      const lost = conflict.members.some((member) => carry.get(member) === null);
      return {
        alias,
        status: "withdrawn",
        withdrawnReason: lost ? "member_withdrawn" : "members_merged",
      };
    }
    if (!hasDistinctSources(resolved.map((member) => member.paths)))
      return { alias, status: "withdrawn", withdrawnReason: "sources_not_distinct" };
    return { alias, status: "revised", members: resolved.map((member) => member.member) };
  });
}
