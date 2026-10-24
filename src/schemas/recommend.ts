import { z } from "zod";
import {
  heldBack,
  FIELD_LIMITS as L,
  LIMITED,
  type Limits,
  recommendation,
  SHAPE,
} from "./common.js";

// `recommend` (IMPL §3.3.5). Operation, target and content combinations are checked by REC-002,
// not the schema.

export const RECOMMEND_SCHEMA_VERSION = "recommend/1.0.0";

export const RECOMMEND_COLLECTION_LIMITS = { recommendations: 15, heldBack: 10 } as const;

const items = (l: Limits) => ({ recommendations: recommendation(l), heldBack: heldBack(l) });

const response = (l: Limits) => {
  const item = items(l);
  const max = RECOMMEND_COLLECTION_LIMITS;
  return z.strictObject({
    recommendations: z.array(item.recommendations).max(max.recommendations),
    heldBack: z.array(item.heldBack).max(max.heldBack),
    // Not part of any item, so its limit applies at the schema stage.
    noChangeReason: LIMITED.text(L.noChangeReason).optional(),
  });
};

export const recommend = {
  version: RECOMMEND_SCHEMA_VERSION,
  response: response(SHAPE),
  limited: response(LIMITED),
  items: items(LIMITED),
};
