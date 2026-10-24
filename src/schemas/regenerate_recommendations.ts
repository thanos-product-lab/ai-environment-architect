import { z } from "zod";
import {
  alias,
  heldBack,
  FIELD_LIMITS as L,
  LIMITED,
  type Limits,
  recommendation,
  recommendationBody,
  SHAPE,
} from "./common.js";

// `regenerate_recommendations` (IMPL §3.3.6). An affected set larger than the `actions` ceiling
// is split into several calls by code.

export const REGENERATE_SCHEMA_VERSION = "regenerate_recommendations/1.0.0";

export const REGENERATE_COLLECTION_LIMITS = { actions: 30, additions: 5, heldBack: 10 } as const;

/** Keep or drop, or revise with the new revision. */
export const action = (l: Limits) =>
  z.union([
    z.strictObject({
      target: alias(l),
      action: z.enum(["keep", "drop"]),
      reason: l.text(L.reason),
    }),
    z.strictObject({
      target: alias(l),
      action: z.literal("revise"),
      reason: l.text(L.reason),
      revision: recommendationBody(l),
    }),
  ]);

const items = (l: Limits) => ({
  actions: action(l),
  additions: recommendation(l),
  heldBack: heldBack(l),
});

const response = (l: Limits) => {
  const item = items(l);
  const max = REGENERATE_COLLECTION_LIMITS;
  return z.strictObject({
    actions: z.array(item.actions).max(max.actions),
    additions: z.array(item.additions).max(max.additions),
    heldBack: z.array(item.heldBack).max(max.heldBack),
  });
};

export const regenerateRecommendations = {
  version: REGENERATE_SCHEMA_VERSION,
  response: response(SHAPE),
  limited: response(LIMITED),
  items: items(LIMITED),
};
