import type { z } from "zod";
import { analyseExpansion } from "../../schemas/analyse_expansion.js";
import {
  type AbsenceClaim,
  type CitationsProposed,
  type Conflict,
  type ContentNotice,
  type CorrectedCitationRate,
  citationsProposed,
  conflictMembers,
  correctedCitationRate,
  duplicateChecks,
  type Finding,
  findingChecks,
  type Gap,
  memberAliasCheck,
} from "./analyse.js";
import type { CitationContext } from "./citations.js";
import { type AliasedFinding, conflictChecks, type FindingSources } from "./conflicts.js";
import { absenceClaimCheck, type CoverageContext, gapCheck } from "./coverage.js";
import {
  claimIdentity,
  findingIdentity,
  gapIdentity,
  type PriorIdentity,
  type Scope,
} from "./duplicates.js";
import type { GapType } from "./generate-questions.js";
import { limitCheck } from "./limits.js";
import { noticeCheck } from "./notices.js";
import {
  accept,
  type CallValidator,
  type ItemCheck,
  reject,
  type ValidationResult,
  validateResponse,
} from "./pipeline.js";
import {
  type ConflictOutcome,
  carryThroughRevisions,
  type PriorConflict,
  priorConflictOutcomes,
  type Revision,
  type RevisionContext,
  repeatedTargetCheck,
  replacementCheck,
  revisionCheck,
} from "./revisions.js";
import type { SupportContext } from "./support.js";

// `analyse_expansion` (IMPL §3.3.3): validation as for `analyse`, with citations of expansion
// items, conflicts that may name call-1 claims, and revisions of call-1 records. The call-1
// records are a required input, so the duplicate and revision rules never depend on what a
// caller chose to pass. The cross-item order is DUP-002, DUP-001, REV-003, CONF-001, SUP-005,
// REV-001: a replacement conflict has to pass the conflict rules before REV-001 can tell whether
// it passed validation.

type Response = z.infer<typeof analyseExpansion.response>;

/** One `F` record of call 1's output, or a known fact, as the call-1 validation accepted it. */
export type CallOneFinding =
  | {
      readonly alias: string;
      readonly kind: "claim";
      readonly producedBy: "deterministic" | "model";
      readonly statement: string;
      readonly scope: Scope;
      /** The paths of its validated evidence, the sources SUP-005 compares. */
      readonly paths: readonly string[];
    }
  | {
      readonly alias: string;
      readonly kind: "gap";
      readonly producedBy: "deterministic" | "model";
      readonly statement: string;
      readonly gapType: GapType;
      readonly relatedPaths: readonly string[];
    }
  | {
      readonly alias: string;
      readonly kind: "absenceClaim";
      readonly producedBy: "model";
      readonly pathGlob: string;
    };

/** Every call-1 record the call refers to, in alias order (§3.2.1). */
export interface CallOneRecords {
  readonly findings: readonly CallOneFinding[];
  readonly conflicts: readonly PriorConflict[];
}

export interface AnalyseExpansionContext extends CitationContext, SupportContext, CoverageContext {
  readonly callOne: CallOneRecords;
}

/** What the shared checks read, derived once from the call-1 records. */
interface DerivedContext extends AnalyseExpansionContext, FindingSources, RevisionContext {
  readonly claims: ReadonlySet<string>;
}

/**
 * The call-1 records must be exactly the `F` and `C` aliases of the table: a record the table
 * lacks can't be named, and an alias without its record would escape REV-002 or misjudge a
 * member's kind. A mismatch is a bug in the caller, not in the response.
 */
function checkRecords(context: AnalyseExpansionContext): void {
  const table = context.aliases.entries.filter((e) => e.kind === "F" || e.kind === "C");
  const records = [...context.callOne.findings, ...context.callOne.conflicts];
  const named = new Set(records.map((record) => record.alias));
  const listed = new Set(table.map((entry) => entry.alias));
  for (const entry of table)
    if (!named.has(entry.alias)) throw new Error(`no call-1 record for ${entry.alias}`);
  for (const record of records)
    if (!listed.has(record.alias)) throw new Error(`${record.alias} is not in the alias table`);
}

function derive(context: AnalyseExpansionContext): DerivedContext {
  checkRecords(context);
  const claims = context.callOne.findings.flatMap((f) => (f.kind === "claim" ? [f] : []));
  const aliased = (f: (typeof claims)[number]): AliasedFinding => ({
    alias: f.alias,
    statement: f.statement,
    scope: f.scope,
    paths: f.paths,
  });
  return {
    ...context,
    knownFacts: claims.filter((f) => f.producedBy === "deterministic").map(aliased),
    priorFindings: claims.filter((f) => f.producedBy === "model").map(aliased),
    deterministic: new Set(
      context.callOne.findings.filter((f) => f.producedBy === "deterministic").map((f) => f.alias),
    ),
    claims: new Set(claims.map((f) => f.alias)),
  };
}

export type AnalyseExpansionItems = {
  findings: Finding;
  gaps: Gap;
  absenceClaims: AbsenceClaim;
  conflicts: Conflict;
  revisions: Revision;
  contentNotices: ContentNotice;
};

type C = DerivedContext;
const items = analyseExpansion.items;

/** ALIAS-003: an `F` member must be a claim; a gap or absence claim has no evidence to compare. */
const memberKindCheck: ItemCheck<Conflict, C> = (value, context) => {
  const other = value.findings.find(
    (member) => member.startsWith("F-") && !context.claims.has(member),
  );
  return other === undefined
    ? accept(value)
    : reject("ALIAS-003", `${other} is not a claim; conflict members are claims`);
};

/**
 * The call-1 records no revision that survived the item stage withdraws or replaces. Records code
 * produced can't be revised (REV-002), so they are always passed forward. Known facts are left to
 * DUP-002, which runs first.
 */
function passedForward(context: C, revised: ReadonlySet<string>) {
  const kept = context.callOne.findings.filter(
    (f) => !revised.has(f.alias) && !(f.kind === "claim" && f.producedBy === "deterministic"),
  );
  const of = (identity: (f: CallOneFinding) => string | undefined): PriorIdentity[] =>
    kept.flatMap((f) => {
      const value = identity(f);
      return value === undefined ? [] : [{ alias: f.alias, identity: value }];
    });
  return {
    findings: of((f) => (f.kind === "claim" ? findingIdentity(f.statement, f.scope) : undefined)),
    gaps: of((f) =>
      f.kind === "gap" ? gapIdentity(f.statement, f.gapType, f.relatedPaths) : undefined,
    ),
    absenceClaims: of((f) => (f.kind === "absenceClaim" ? claimIdentity(f.pathGlob) : undefined)),
  };
}

export const analyseExpansionValidator: CallValidator<Response, C, AnalyseExpansionItems> = {
  schema: analyseExpansion.response,
  order: ["findings", "gaps", "absenceClaims", "conflicts", "revisions", "contentNotices"],
  collections: {
    findings: {
      items: (response) => response.findings,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: findingChecks<C>(),
    },
    gaps: {
      items: (response) => response.gaps,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(items.gaps), gapCheck()],
    },
    absenceClaims: {
      items: (response) => response.absenceClaims,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(items.absenceClaims), absenceClaimCheck()],
    },
    conflicts: {
      items: (response) => response.conflicts,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(items.conflicts), memberAliasCheck(["F"]), memberKindCheck],
    },
    revisions: {
      items: (response) => response.revisions,
      // Two revisions may name one target, so a revision is named by its position.
      key: () => ({ kind: "position" }),
      checks: [limitCheck(items.revisions), revisionCheck()],
    },
    contentNotices: {
      items: (response) => response.contentNotices,
      key: () => ({ kind: "position" }),
      checks: [limitCheck(items.contentNotices), noticeCheck()],
    },
  },
  crossItem: [
    ...duplicateChecks<AnalyseExpansionItems, C>((context, surviving) =>
      passedForward(context, new Set(surviving.revisions.map((item) => item.value.target))),
    ),
    repeatedTargetCheck(),
    ...conflictChecks<AnalyseExpansionItems, C>((surviving, _context, redirects) =>
      carryThroughRevisions(surviving, redirects),
    ),
    replacementCheck(),
  ],
};

export interface AnalyseExpansionValidation {
  readonly result: ValidationResult<AnalyseExpansionItems, Response>;
  readonly correctedCitationRate: CorrectedCitationRate;
  readonly citationsProposed: CitationsProposed;
  /** Each accepted new conflict's members, after redirection and revisions. */
  readonly conflictMembers: ReadonlyMap<string, readonly string[]>;
  /** What the accepted revisions do to the call-1 conflicts they don't target. */
  readonly conflictOutcomes: readonly ConflictOutcome[];
}

export function validateAnalyseExpansion(
  text: string,
  input: AnalyseExpansionContext,
): AnalyseExpansionValidation {
  const context = derive(input);
  const result = validateResponse(analyseExpansionValidator, text, context);
  const rates = {
    correctedCitationRate: correctedCitationRate(result),
    citationsProposed: citationsProposed(result),
  };
  if (result.status !== "validated")
    return { result, ...rates, conflictMembers: new Map(), conflictOutcomes: [] };
  const { accepted, redirects } = result;
  return {
    result,
    ...rates,
    conflictMembers: conflictMembers(
      accepted,
      redirects,
      context,
      carryThroughRevisions(accepted, redirects),
    ),
    conflictOutcomes: priorConflictOutcomes(
      context.callOne.conflicts,
      accepted,
      redirects,
      context,
    ),
  };
}
