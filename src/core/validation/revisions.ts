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
// finding or conflict. Known facts are code's, so the model can't revise them. Withdrawn and
// replaced records are kept for history, and are no longer passed forward.

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
  readonly knownFacts: FindingSources["knownFacts"];
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
    if (context.knownFacts.some((fact) => fact.alias === value.target))
      return reject("REV-002", `${value.target} is a known fact`);
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

export type ConflictOutcome =
  | {
      readonly alias: string;
      readonly status: "withdrawn";
      readonly reason: "member withdrawn" | "sources not distinct";
    }
  /** Kept, with its members changed: one withdrawn, or one standing for its replacement. */
  | { readonly alias: string; readonly status: "kept"; readonly members: readonly string[] };

/**
 * What the accepted revisions do to the call-1 conflicts no revision targets (§3.3.3), in the
 * order given. Conflicts the revisions leave unchanged are not listed. These are outcomes for
 * call-1 records, not rejections of the response, so they produce no validation events.
 */
export function priorConflictOutcomes<A extends RevisionItems>(
  conflicts: readonly PriorConflict[],
  surviving: AcceptedItems<A>,
  redirects: ReadonlyMap<string, string>,
  sources: FindingSources,
): ConflictOutcome[] {
  const targeted = new Set(surviving.revisions.map((item) => item.value.target));
  const carry = carryThroughRevisions(surviving, redirects);
  const findings = findingPaths(surviving);
  const aliases = aliasPaths(sources);
  return conflicts.flatMap((conflict): ConflictOutcome[] => {
    if (targeted.has(conflict.alias)) return [];
    if (!conflict.members.some((member) => carry.has(member))) return [];
    const resolved = resolveMembers(conflict.members, findings, aliases, new Map(), carry);
    if (resolved.length < 2)
      return [{ alias: conflict.alias, status: "withdrawn", reason: "member withdrawn" }];
    // SUP-005 is checked again when a replacement inherits a member (§3.3.3).
    const replaced = conflict.members.some((member) => typeof carry.get(member) === "string");
    if (replaced && !hasDistinctSources(resolved.map((member) => member.paths)))
      return [{ alias: conflict.alias, status: "withdrawn", reason: "sources not distinct" }];
    return [{ alias: conflict.alias, status: "kept", members: resolved.map((m) => m.member) }];
  });
}
