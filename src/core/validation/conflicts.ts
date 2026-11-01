import type { Scope } from "./duplicates.js";
import type { AcceptedItems, CrossItemCheck, CrossItemRejection } from "./pipeline.js";
import { hasDistinctSources } from "./support.js";

// Conflicts (IMPL §3.3.2 step 8, §3.3.3). A conflict's members are resolved before they are
// counted: a dropped duplicate stands for the item kept, a call-1 finding withdrawn in this
// response is lost, and one replaced stands for its replacement. Each member then counts once.

/** A finding outside the response, by alias: a known fact, or a call-1 finding (§3.3.3). */
export interface AliasedFinding {
  readonly alias: string;
  readonly statement: string;
  readonly scope: Scope;
  /** The paths of its validated evidence, the sources SUP-005 compares. */
  readonly paths: readonly string[];
}

export interface FindingSources {
  readonly knownFacts: readonly AliasedFinding[];
  /** Call-1 findings, in `analyse_expansion` only. */
  readonly priorFindings?: readonly AliasedFinding[];
}

/** How revisions carry members (§3.3.3): an alias mapped to null is withdrawn, to a key replaced. */
export type Carry = ReadonlyMap<string, string | null>;

export interface ResolvedMember {
  readonly member: string;
  readonly paths: readonly string[];
}

interface FindingLike {
  readonly evidence?: readonly { readonly path: string }[];
}

interface ConflictLike {
  readonly findings: readonly string[];
}

export type ConflictItems = { findings: FindingLike; conflicts: ConflictLike };

export function aliasPaths(sources: FindingSources): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...sources.knownFacts, ...(sources.priorFindings ?? [])].map((f) => [f.alias, f.paths]),
  );
}

/** Each member after redirection and revisions, once each, in the order first written. */
export function resolveMembers(
  members: readonly string[],
  findings: ReadonlyMap<string, readonly string[]>,
  aliases: ReadonlyMap<string, readonly string[]>,
  redirects: ReadonlyMap<string, string>,
  carry: Carry,
): ResolvedMember[] {
  const resolved = new Map<string, readonly string[]>();
  for (const written of members) {
    let member = redirects.get(written) ?? written;
    const carried = carry.get(member);
    if (carried === null) continue;
    if (carried !== undefined) member = carried;
    const paths = findings.get(member) ?? aliases.get(member);
    if (paths !== undefined && !resolved.has(member)) resolved.set(member, paths);
  }
  return [...resolved].map(([member, paths]) => ({ member, paths }));
}

/** The evidence paths of each surviving finding, by key. */
export function findingPaths<A extends ConflictItems>(
  surviving: AcceptedItems<A>,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    surviving.findings.map((item) => [
      item.key,
      (item.value.evidence ?? []).map((evidence) => evidence.path),
    ]),
  );
}

export type CarryOf<A, C> = (
  surviving: AcceptedItems<A>,
  context: C,
  redirects: ReadonlyMap<string, string>,
) => Carry;

const NO_CARRY: Carry = new Map();

/** CONF-001, then SUP-005, as cross-item checks (§3.3.2 step 8). */
export function conflictChecks<A extends ConflictItems, C extends FindingSources>(
  carryOf: CarryOf<A, C> = () => NO_CARRY,
): CrossItemCheck<A, C>[] {
  const members = (
    conflict: ConflictLike,
    surviving: AcceptedItems<A>,
    context: C,
    redirects: ReadonlyMap<string, string>,
  ) =>
    resolveMembers(
      conflict.findings,
      findingPaths(surviving),
      aliasPaths(context),
      redirects,
      carryOf(surviving, context, redirects),
    );
  const check =
    (rule: string, detail: string, fails: (resolved: ResolvedMember[]) => boolean) =>
    (
      surviving: AcceptedItems<A>,
      context: C,
      redirects: ReadonlyMap<string, string> = new Map(),
    ): CrossItemRejection<A>[] =>
      surviving.conflicts.flatMap((conflict): CrossItemRejection<A>[] =>
        fails(members(conflict.value, surviving, context, redirects))
          ? [{ collection: "conflicts", index: conflict.index, rule, detail }]
          : [],
      );
  return [
    check("CONF-001", "fewer than two member findings survived", (resolved) => resolved.length < 2),
    check(
      "SUP-005",
      "a member finding cites no file that not every other member cites",
      (resolved) => !hasDistinctSources(resolved.map((member) => member.paths)),
    ),
  ];
}
