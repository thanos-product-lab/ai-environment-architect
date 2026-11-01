import type { z } from "zod";
import { analyse } from "../../schemas/analyse.js";
import { type AliasKind, resolveReference } from "./aliases.js";
import { basisDerivation } from "./basis.js";
import { type Basis, type CitationContext, citationCheck, type Evidence } from "./citations.js";
import {
  type AliasedFinding,
  aliasPaths,
  type Carry,
  conflictChecks,
  type FindingSources,
  findingPaths,
  resolveMembers,
} from "./conflicts.js";
import {
  absenceClaimCheck,
  type CoverageContext,
  type GapCoverage,
  gapCheck,
  scopeCheck,
} from "./coverage.js";
import { claimIdentity, duplicateCheck, findingIdentity, gapIdentity } from "./duplicates.js";
import {
  type ExpansionContext,
  type ExpansionRequest,
  expansionLimitCheck,
  expansionRequestCheck,
} from "./expansion.js";
import { limitCheck } from "./limits.js";
import { noticeCheck } from "./notices.js";
import {
  type AcceptedItems,
  accept,
  type CallValidator,
  type CrossItemCheck,
  type ItemCheck,
  reject,
  type ValidationResult,
  validateResponse,
} from "./pipeline.js";
import { type SupportContext, supportCheck } from "./support.js";

// `analyse` (IMPL §3.3.2): the item checks of steps 1–6, 9 and 10, then the cross-item stage,
// duplicates (step 7) before conflicts (step 8), so a conflict with a duplicate of its own member
// has one member. `analyse_expansion` (§3.3.3) builds on the same parts.

type Response = z.infer<typeof analyse.response>;

/** A finding as validation leaves it: its citations' evidence, dropped count and basis. */
export type Finding = Response["findings"][number] & {
  readonly evidence?: readonly Evidence[];
  readonly droppedCitations?: number;
  readonly basis?: readonly Basis[];
};
export type Gap = Response["gaps"][number] & { readonly coverage?: GapCoverage };
/** An absence claim, with the statement code wrote (§1.11). */
export type AbsenceClaim = Response["absenceClaims"][number] & { readonly statement?: string };
export type Conflict = Response["conflicts"][number];
export type ContentNotice = Response["contentNotices"][number];

export interface AnalyseContext
  extends CitationContext,
    SupportContext,
    CoverageContext,
    ExpansionContext,
    FindingSources {}

export type AnalyseItems = {
  findings: Finding;
  gaps: Gap;
  absenceClaims: AbsenceClaim;
  conflicts: Conflict;
  expansionRequests: ExpansionRequest;
  contentNotices: ContentNotice;
};

/** ALIAS-001 and ALIAS-003 on each conflict member. */
export function memberAliasCheck<C extends CitationContext>(
  aliases: readonly AliasKind[],
): ItemCheck<Conflict, C> {
  return (value, context, response) => {
    for (const member of value.findings) {
      const resolved = resolveReference(context.aliases, response.localKeys, member, {
        aliases,
        localKeys: ["f"],
      });
      if (!resolved.ok) return reject(resolved.rule, resolved.detail);
    }
    return accept(value);
  };
}

type DuplicateItems = { findings: Finding; gaps: Gap; absenceClaims: AbsenceClaim };

/**
 * DUP-002, then DUP-001 for findings, gaps and absence claims (step 7). `prior` gives the call-1
 * findings a new finding may restate, in `analyse_expansion`.
 */
export function duplicateChecks<A extends DuplicateItems, C extends FindingSources>(
  prior?: (context: C, surviving: AcceptedItems<A>) => readonly AliasedFinding[],
): CrossItemCheck<A, C>[] {
  const ofFinding = (finding: Finding) => findingIdentity(finding.statement, finding.scope);
  const asPrior = (findings: readonly AliasedFinding[]) =>
    findings.map((f) => ({ alias: f.alias, identity: findingIdentity(f.statement, f.scope) }));
  return [
    duplicateCheck<A, C, "findings">({
      collection: "findings",
      rule: "DUP-002",
      identity: ofFinding,
      prior: (context) => asPrior(context.knownFacts),
      withinResponse: false,
    }),
    duplicateCheck<A, C, "findings">({
      collection: "findings",
      rule: "DUP-001",
      identity: ofFinding,
      ...(prior === undefined
        ? {}
        : {
            prior: (context: C, surviving: AcceptedItems<A>) => asPrior(prior(context, surviving)),
          }),
    }),
    duplicateCheck<A, C, "gaps">({
      collection: "gaps",
      rule: "DUP-001",
      identity: (gap) => gapIdentity(gap.statement, gap.gapType, gap.relatedPaths),
    }),
    duplicateCheck<A, C, "absenceClaims">({
      collection: "absenceClaims",
      rule: "DUP-001",
      identity: (claim) => claimIdentity(claim.pathGlob),
    }),
  ];
}

/** Steps 1, 3 and 4 for a finding: limits, citations, support, basis, scope. */
export const findingChecks = <C extends CitationContext & SupportContext & CoverageContext>() => [
  limitCheck<Finding, C>(analyse.items.findings),
  citationCheck<Finding, C>(),
  supportCheck<Finding, C>(),
  basisDerivation<Finding, C>(),
  scopeCheck<Finding, C>(),
];

export const analyseValidator: CallValidator<Response, AnalyseContext, AnalyseItems> = {
  schema: analyse.response,
  order: ["findings", "gaps", "absenceClaims", "conflicts", "expansionRequests", "contentNotices"],
  collections: {
    findings: {
      items: (response) => response.findings,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: findingChecks<AnalyseContext>(),
    },
    gaps: {
      items: (response) => response.gaps,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(analyse.items.gaps), gapCheck()],
    },
    absenceClaims: {
      items: (response) => response.absenceClaims,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(analyse.items.absenceClaims), absenceClaimCheck()],
    },
    conflicts: {
      items: (response) => response.conflicts,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(analyse.items.conflicts), memberAliasCheck([])],
    },
    expansionRequests: {
      items: (response) => response.expansionRequests,
      key: () => ({ kind: "position" }),
      checks: [
        limitCheck(analyse.items.expansionRequests),
        expansionLimitCheck(),
        expansionRequestCheck(),
      ],
    },
    contentNotices: {
      items: (response) => response.contentNotices,
      key: () => ({ kind: "position" }),
      checks: [limitCheck(analyse.items.contentNotices), noticeCheck()],
    },
  },
  crossItem: [...duplicateChecks<AnalyseItems, AnalyseContext>(), ...conflictChecks()],
};

/**
 * `CIT-R01` events over the citations proposed in the call, across all its findings (§3.2.2).
 * Unknown is never zero: a schema failure or a call without citations has no rate.
 */
export type CorrectedCitationRate =
  | {
      readonly state: "known";
      readonly corrected: number;
      readonly proposed: number;
      readonly rate: number;
    }
  | { readonly state: "unknown"; readonly reason: "schema_failed" | "no_citations" };

export function correctedCitationRate(
  result: ValidationResult<unknown, { readonly findings: readonly { citations: unknown[] }[] }>,
): CorrectedCitationRate {
  if (result.status !== "validated") return { state: "unknown", reason: "schema_failed" };
  const proposed = result.response.findings.reduce((sum, f) => sum + f.citations.length, 0);
  if (proposed === 0) return { state: "unknown", reason: "no_citations" };
  const corrected = result.events.filter((event) => event.rule === "CIT-R01").length;
  return { state: "known", corrected, proposed, rate: corrected / proposed };
}

/** Each accepted conflict's members after redirection and revisions, by conflict key. */
export function conflictMembers<A extends { findings: Finding; conflicts: Conflict }>(
  accepted: AcceptedItems<A>,
  redirects: ReadonlyMap<string, string>,
  sources: FindingSources,
  carry: Carry = new Map(),
): ReadonlyMap<string, readonly string[]> {
  const findings = findingPaths(accepted);
  const aliases = aliasPaths(sources);
  return new Map(
    accepted.conflicts.map((conflict) => [
      conflict.key,
      resolveMembers(conflict.value.findings, findings, aliases, redirects, carry).map(
        (member) => member.member,
      ),
    ]),
  );
}

export interface AnalyseValidation {
  readonly result: ValidationResult<AnalyseItems, Response>;
  readonly correctedCitationRate: CorrectedCitationRate;
  readonly conflictMembers: ReadonlyMap<string, readonly string[]>;
}

export function validateAnalyse(text: string, context: AnalyseContext): AnalyseValidation {
  const result = validateResponse(analyseValidator, text, context);
  return {
    result,
    correctedCitationRate: correctedCitationRate(result),
    conflictMembers:
      result.status === "validated"
        ? conflictMembers(result.accepted, result.redirects, context)
        : new Map(),
  };
}
