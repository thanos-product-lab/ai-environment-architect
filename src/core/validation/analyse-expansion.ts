import type { z } from "zod";
import { analyseExpansion } from "../../schemas/analyse_expansion.js";
import {
  type AbsenceClaim,
  type AnalyseContext,
  type Conflict,
  type ContentNotice,
  type CorrectedCitationRate,
  conflictMembers,
  correctedCitationRate,
  duplicateChecks,
  type Finding,
  findingChecks,
  type Gap,
  memberAliasCheck,
} from "./analyse.js";
import { conflictChecks } from "./conflicts.js";
import { absenceClaimCheck, gapCheck } from "./coverage.js";
import { limitCheck } from "./limits.js";
import { noticeCheck } from "./notices.js";
import { type CallValidator, type ValidationResult, validateResponse } from "./pipeline.js";
import {
  type ConflictOutcome,
  carryThroughRevisions,
  type PriorConflict,
  priorConflictOutcomes,
  type Revision,
  repeatedTargetCheck,
  replacementCheck,
  revisionCheck,
} from "./revisions.js";

// `analyse_expansion` (IMPL §3.3.3): validation as for `analyse`, with citations of expansion
// items, conflicts that may name call-1 findings, and revisions of call-1 records. The cross-item
// order is DUP-002, DUP-001, REV-003, CONF-001, SUP-005, REV-001: a replacement conflict has to
// pass the conflict rules before REV-001 can tell whether it passed validation.

type Response = z.infer<typeof analyseExpansion.response>;

export interface AnalyseExpansionContext extends Omit<AnalyseContext, "expansion"> {
  /** The call-1 findings passed forward, as `F` aliases after the known facts' (§3.2.1). */
  readonly priorFindings: NonNullable<AnalyseContext["priorFindings"]>;
  readonly priorConflicts: readonly PriorConflict[];
}

export type AnalyseExpansionItems = {
  findings: Finding;
  gaps: Gap;
  absenceClaims: AbsenceClaim;
  conflicts: Conflict;
  revisions: Revision;
  contentNotices: ContentNotice;
};

type C = AnalyseExpansionContext;
const items = analyseExpansion.items;

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
      checks: [limitCheck(items.conflicts), memberAliasCheck(["F"])],
    },
    revisions: {
      items: (response) => response.revisions,
      key: (item) => ({ kind: "alias", key: item.target }),
      checks: [limitCheck(items.revisions), revisionCheck()],
    },
    contentNotices: {
      items: (response) => response.contentNotices,
      key: () => ({ kind: "position" }),
      checks: [limitCheck(items.contentNotices), noticeCheck()],
    },
  },
  crossItem: [
    // The call-1 findings still passed forward: those no revision that survived the item stage
    // withdraws or replaces.
    ...duplicateChecks<AnalyseExpansionItems, C>((context, surviving) => {
      const revised = new Set(surviving.revisions.map((item) => item.value.target));
      return context.priorFindings.filter((finding) => !revised.has(finding.alias));
    }),
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
  /** Each accepted new conflict's members, after redirection and revisions. */
  readonly conflictMembers: ReadonlyMap<string, readonly string[]>;
  /** What the accepted revisions do to the call-1 conflicts they don't target. */
  readonly conflictOutcomes: readonly ConflictOutcome[];
}

export function validateAnalyseExpansion(text: string, context: C): AnalyseExpansionValidation {
  const result = validateResponse(analyseExpansionValidator, text, context);
  if (result.status !== "validated")
    return {
      result,
      correctedCitationRate: correctedCitationRate(result),
      conflictMembers: new Map(),
      conflictOutcomes: [],
    };
  const { accepted, redirects } = result;
  return {
    result,
    correctedCitationRate: correctedCitationRate(result),
    conflictMembers: conflictMembers(
      accepted,
      redirects,
      context,
      carryThroughRevisions(accepted, redirects),
    ),
    conflictOutcomes: priorConflictOutcomes(context.priorConflicts, accepted, redirects, context),
  };
}
