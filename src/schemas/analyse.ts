import { z } from "zod";
import {
  absenceClaim,
  conflict,
  contentNotice,
  finding,
  gap,
  FIELD_LIMITS as L,
  LIMITED,
  type Limits,
  lineRanges,
  path,
  SHAPE,
} from "./common.js";

// `analyse` (IMPL §3.3.2).

export const ANALYSE_SCHEMA_VERSION = "analyse/1.0.0";

/**
 * `expansionRequests` is the ceiling for the `maxExpansionRequests` setting (IMPL §1.8): a
 * setting can lower it, and requests beyond the setting are rejected in response order, but
 * raising it needs a new schema version.
 */
export const ANALYSE_COLLECTION_LIMITS = {
  findings: 40,
  gaps: 15,
  absenceClaims: 10,
  conflicts: 10,
  expansionRequests: 5,
  contentNotices: 10,
} as const;

/** A `read` or `search` expansion request (IMPL §1.8). */
export const expansionRequest = (l: Limits) =>
  z.union([
    z.strictObject({
      kind: z.literal("read"),
      entries: l.list(
        z.strictObject({ path: path(l), lines: lineRanges(l).optional() }),
        L.readEntries,
      ),
      reason: l.text(L.reason),
    }),
    z.strictObject({
      kind: z.literal("search"),
      literal: l.text(L.literal),
      glob: path(l).optional(),
      reason: l.text(L.reason),
    }),
  ]);

const items = (l: Limits) => ({
  findings: finding(l),
  gaps: gap(l),
  absenceClaims: absenceClaim(l),
  conflicts: conflict(l),
  expansionRequests: expansionRequest(l),
  contentNotices: contentNotice(l),
});

const response = (l: Limits) => {
  const item = items(l);
  const max = ANALYSE_COLLECTION_LIMITS;
  return z.strictObject({
    findings: z.array(item.findings).max(max.findings),
    gaps: z.array(item.gaps).max(max.gaps),
    absenceClaims: z.array(item.absenceClaims).max(max.absenceClaims),
    conflicts: z.array(item.conflicts).max(max.conflicts),
    expansionRequests: z.array(item.expansionRequests).max(max.expansionRequests),
    contentNotices: z.array(item.contentNotices).max(max.contentNotices),
  });
};

export const analyse = {
  version: ANALYSE_SCHEMA_VERSION,
  response: response(SHAPE),
  limited: response(LIMITED),
  items: items(LIMITED),
};
