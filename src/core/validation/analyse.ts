import type { z } from "zod";
import { analyse } from "../../schemas/analyse.js";
import { type AliasKind, resolveReference } from "./aliases.js";
import { basisDerivation } from "./basis.js";
import { type Basis, type CitationContext, citationCheck, type Evidence } from "./citations.js";
import {
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
import {
  claimIdentity,
  duplicateCheck,
  findingIdentity,
  gapIdentity,
  type PriorIdentity,
} from "./duplicates.js";
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

/** Records outside the response that new items may restate, by identity (§3.3.3). */
export interface PriorDuplicates {
  readonly findings: readonly PriorIdentity[];
  readonly gaps: readonly PriorIdentity[];
  readonly absenceClaims: readonly PriorIdentity[];
}

/**
 * DUP-002, then DUP-001 for findings, gaps and absence claims (step 7). `prior` gives the call-1
 * records new items may restate, in `analyse_expansion`.
 */
export function duplicateChecks<A extends DuplicateItems, C extends FindingSources>(
  prior?: (context: C, surviving: AcceptedItems<A>) => PriorDuplicates,
): CrossItemCheck<A, C>[] {
  const ofFinding = (finding: Finding) => findingIdentity(finding.statement, finding.scope);
  const priorOf =
    (collection: keyof PriorDuplicates) => (context: C, surviving: AcceptedItems<A>) =>
      prior === undefined ? [] : prior(context, surviving)[collection];
  return [
    duplicateCheck<A, C, "findings">({
      collection: "findings",
      rule: "DUP-002",
      identity: ofFinding,
      prior: (context) =>
        context.knownFacts.map((fact) => ({
          alias: fact.alias,
          identity: findingIdentity(fact.statement, fact.scope),
        })),
      withinResponse: false,
    }),
    duplicateCheck<A, C, "findings">({
      collection: "findings",
      rule: "DUP-001",
      identity: ofFinding,
      prior: priorOf("findings"),
    }),
    duplicateCheck<A, C, "gaps">({
      collection: "gaps",
      rule: "DUP-001",
      identity: (gap) => gapIdentity(gap.statement, gap.gapType, gap.relatedPaths),
      prior: priorOf("gaps"),
    }),
    duplicateCheck<A, C, "absenceClaims">({
      collection: "absenceClaims",
      rule: "DUP-001",
      identity: (claim) => claimIdentity(claim.pathGlob),
      prior: priorOf("absenceClaims"),
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
 * `CIT-R01` events over the citations that reached the citation check, across all the call's
 * findings (§3.2.2). Unknown is never zero: a schema failure, or a call where no citation reached
 * the check, has no rate.
 */
export type CorrectedCitationRate =
  | {
      readonly state: "known";
      readonly corrected: number;
      readonly checked: number;
      readonly rate: number;
    }
  | { readonly state: "unknown"; readonly reason: "schema_failed" | "no_citations" };

/** The citations proposed in the call, across all its findings, recorded apart from the rate. */
export type CitationsProposed =
  | { readonly state: "known"; readonly count: number }
  | { readonly state: "unknown"; readonly reason: "schema_failed" };

type CitedResponse = {
  readonly findings: readonly { readonly key: string; readonly citations: unknown[] }[];
};

/** The rules that reject a finding before its citations are checked (§3.5 item stage). */
const BEFORE_CITATIONS: ReadonlySet<string> = new Set(["ALIAS-002", "LIMIT-001"]);

export function correctedCitationRate(
  result: ValidationResult<unknown, CitedResponse>,
): CorrectedCitationRate {
  if (result.status !== "validated") return { state: "unknown", reason: "schema_failed" };
  // A finding key always matches its pattern after the schema stage, so events name it by key.
  const stopped = new Set(
    result.events
      .filter((event) => event.stage === "item" && BEFORE_CITATIONS.has(event.rule))
      .map((event) => event.itemKey),
  );
  const checked = result.response.findings
    .filter((finding) => !stopped.has(finding.key))
    .reduce((sum, finding) => sum + finding.citations.length, 0);
  if (checked === 0) return { state: "unknown", reason: "no_citations" };
  const corrected = result.events.filter((event) => event.rule === "CIT-R01").length;
  return { state: "known", corrected, checked, rate: corrected / checked };
}

export function citationsProposed(
  result: ValidationResult<unknown, CitedResponse>,
): CitationsProposed {
  if (result.status !== "validated") return { state: "unknown", reason: "schema_failed" };
  const count = result.response.findings.reduce((sum, f) => sum + f.citations.length, 0);
  return { state: "known", count };
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
  readonly citationsProposed: CitationsProposed;
  readonly conflictMembers: ReadonlyMap<string, readonly string[]>;
}

export function validateAnalyse(text: string, context: AnalyseContext): AnalyseValidation {
  const result = validateResponse(analyseValidator, text, context);
  return {
    result,
    correctedCitationRate: correctedCitationRate(result),
    citationsProposed: citationsProposed(result),
    conflictMembers:
      result.status === "validated"
        ? conflictMembers(result.accepted, result.redirects, context)
        : new Map(),
  };
}
