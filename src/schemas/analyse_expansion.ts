import { z } from "zod";
import {
  absenceClaim,
  alias,
  conflict,
  contentNotice,
  finding,
  gap,
  FIELD_LIMITS as L,
  LIMITED,
  type Limits,
  SHAPE,
} from "./common.js";

// `analyse_expansion` (IMPL §3.3.3). There is no `expansionRequests`: one round only.

export const ANALYSE_EXPANSION_SCHEMA_VERSION = "analyse_expansion/1.0.0";

export const ANALYSE_EXPANSION_COLLECTION_LIMITS = {
  findings: 20,
  gaps: 10,
  absenceClaims: 10,
  conflicts: 10,
  revisions: 20,
  contentNotices: 10,
} as const;

/** A withdrawal, or a replacement by a new finding or conflict in the same response. */
export const revision = (l: Limits) =>
  z.union([
    z.strictObject({ target: alias(l), action: z.literal("withdraw"), reason: l.text(L.reason) }),
    z.strictObject({
      target: alias(l),
      action: z.literal("replace"),
      replacement: alias(l),
      reason: l.text(L.reason),
    }),
  ]);

const items = (l: Limits) => ({
  findings: finding(l),
  gaps: gap(l),
  absenceClaims: absenceClaim(l),
  conflicts: conflict(l),
  revisions: revision(l),
  contentNotices: contentNotice(l),
});

const response = (l: Limits) => {
  const item = items(l);
  const max = ANALYSE_EXPANSION_COLLECTION_LIMITS;
  return z.strictObject({
    findings: z.array(item.findings).max(max.findings),
    gaps: z.array(item.gaps).max(max.gaps),
    absenceClaims: z.array(item.absenceClaims).max(max.absenceClaims),
    conflicts: z.array(item.conflicts).max(max.conflicts),
    revisions: z.array(item.revisions).max(max.revisions),
    contentNotices: z.array(item.contentNotices).max(max.contentNotices),
  });
};

export const analyseExpansion = {
  version: ANALYSE_EXPANSION_SCHEMA_VERSION,
  response: response(SHAPE),
  limited: response(LIMITED),
  items: items(LIMITED),
};
