import { z } from "zod";
import {
  alias,
  FIELD_LIMITS as L,
  LIMITED,
  type Limits,
  localKey,
  SHAPE,
  scope,
} from "./common.js";

// `generate_questions` (IMPL §3.3.4). The schema's ceiling is fixed; the per-call check trims to
// twice the session's question budget, which a schema can't depend on.

export const GENERATE_QUESTIONS_SCHEMA_VERSION = "generate_questions/1.0.0";

export const GENERATE_QUESTIONS_COLLECTION_LIMITS = { questions: 20 } as const;

export const question = (l: Limits) =>
  z.strictObject({
    key: localKey("q"),
    prompt: l.text(L.prompt),
    reason: l.text(L.questionReason),
    resolves: l.list(alias(l), L.aliasList),
    scope: scope(l),
    options: l.list(z.strictObject({ label: l.text(L.optionLabel) }), L.options),
  });

const items = (l: Limits) => ({ questions: question(l) });

const response = (l: Limits) =>
  z.strictObject({
    questions: z.array(items(l).questions).max(GENERATE_QUESTIONS_COLLECTION_LIMITS.questions),
  });

export const generateQuestions = {
  version: GENERATE_QUESTIONS_SCHEMA_VERSION,
  response: response(SHAPE),
  limited: response(LIMITED),
  items: items(LIMITED),
};
