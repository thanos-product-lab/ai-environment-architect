import type { z } from "zod";
import { generateQuestions } from "../../schemas/generate_questions.js";
import { type AliasTable, resolveReference } from "./aliases.js";
import type { Basis } from "./citations.js";
import { type CoverageContext, scopeCheck } from "./coverage.js";
import { duplicateCheck, resolvesIdentity } from "./duplicates.js";
import { limitCheck } from "./limits.js";
import {
  type Accepted,
  type AcceptedItems,
  accept,
  type CallValidator,
  type CrossItemCheck,
  type ItemCheck,
  reject,
  type ValidationResult,
  validateResponse,
} from "./pipeline.js";

// `generate_questions` (IMPL §3.3.4). Questions ask about intent the evidence can't establish.
// Code validates them, ranks every valid one, drops those beyond twice the question budget, and
// presents the budget; the rest are recorded `unreached` with reason `budget`.

type Response = z.infer<typeof generateQuestions.response>;
export type Question = Response["questions"][number];

export type GapType =
  | "no_command"
  | "no_documentation"
  | "undetermined_ownership"
  | "undetermined_convention"
  | "other";

/** What the call's input says about each `F` and `C` alias (§3.2.6). */
export interface QuestionInput {
  readonly findings: ReadonlyMap<
    string,
    { readonly kind: "claim" | "gap"; readonly basis: readonly Basis[]; readonly gapType?: GapType }
  >;
  readonly conflicts: ReadonlyMap<
    string,
    { readonly members: readonly string[]; readonly status: "unresolved" | "resolved" }
  >;
  /** The session's question budget (DM §8.1). */
  readonly budget: number;
}

export interface QuestionContext extends CoverageContext {
  readonly aliases: AliasTable;
  readonly questions: QuestionInput;
}

const resolvesCheck: ItemCheck<Question, QuestionContext> = (value, context, response) => {
  for (const alias of value.resolves) {
    const resolved = resolveReference(context.aliases, response.localKeys, alias, {
      aliases: ["F", "C"],
    });
    if (!resolved.ok) return reject(resolved.rule, resolved.detail);
  }
  return accept(value);
};

/**
 * Q-001: a question resolves an unresolved conflict, a gap, or a finding without documentation
 * basis. A documented finding in an unresolved conflict is contested, so it qualifies too.
 */
const intentCheck: ItemCheck<Question, QuestionContext> = (value, context) => {
  const { findings, conflicts } = context.questions;
  const contested = new Set(
    [...conflicts.values()]
      .filter((conflict) => conflict.status === "unresolved")
      .flatMap((conflict) => conflict.members),
  );
  const asksAboutIntent = value.resolves.some((alias) => {
    const conflict = conflicts.get(alias);
    if (conflict !== undefined) return conflict.status === "unresolved";
    const finding = findings.get(alias);
    if (finding === undefined) return false;
    return (
      finding.kind === "gap" || !finding.basis.includes("documentation") || contested.has(alias)
    );
  });
  return asksAboutIntent
    ? accept(value)
    : reject("Q-001", "resolves only documented, uncontested findings");
};

/**
 * 1: an unresolved conflict; 2: a command or ownership gap; 3: another gap; 4: an observed
 * convention. A resolved conflict holds no open intent, so it doesn't rank a question.
 */
export function questionClass(resolves: readonly string[], input: QuestionInput): 1 | 2 | 3 | 4 {
  if (resolves.some((alias) => input.conflicts.get(alias)?.status === "unresolved")) return 1;
  const gaps = resolves.flatMap((alias) => {
    const finding = input.findings.get(alias);
    return finding?.kind === "gap" ? [finding.gapType] : [];
  });
  if (gaps.some((type) => type === "no_command" || type === "undetermined_ownership")) return 2;
  return gaps.length > 0 ? 3 : 4;
}

/** By class, then in the model's order. */
function rank(
  questions: readonly Accepted<Question>[],
  input: QuestionInput,
): Accepted<Question>[] {
  return [...questions].sort(
    (a, b) =>
      questionClass(a.value.resolves, input) - questionClass(b.value.resolves, input) ||
      a.index - b.index,
  );
}

type Items = { questions: Question };

/** LIMIT-002: valid questions ranked beyond twice the question budget. */
const budgetCheck: CrossItemCheck<Items, QuestionContext> = (surviving, context) => {
  const limit = 2 * context.questions.budget;
  return rank(surviving.questions, context.questions)
    .slice(limit)
    .map((item) => ({
      collection: "questions",
      index: item.index,
      rule: "LIMIT-002",
      detail: `ranked beyond twice the question budget, ${limit}`,
    }));
};

export const generateQuestionsValidator: CallValidator<Response, QuestionContext, Items> = {
  schema: generateQuestions.response,
  order: ["questions"],
  collections: {
    questions: {
      items: (response) => response.questions,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [
        limitCheck(generateQuestions.items.questions),
        resolvesCheck,
        intentCheck,
        scopeCheck(),
      ],
    },
  },
  crossItem: [
    duplicateCheck<Items, QuestionContext, "questions">({
      collection: "questions",
      rule: "DUP-003",
      identity: (value) => resolvesIdentity(value.resolves),
    }),
    budgetCheck,
  ],
};

export interface QuestionsValidation {
  readonly result: ValidationResult<Items, Response>;
  /** The top questions up to the budget, in ranked order. */
  readonly presented: readonly Accepted<Question>[];
  /** The rest, in ranked order: recorded `unreached` with reason `budget` (DM §8.1). */
  readonly unreached: readonly Accepted<Question>[];
  readonly unreachedReason: "budget";
}

export function validateGenerateQuestions(
  text: string,
  context: QuestionContext,
): QuestionsValidation {
  const result = validateResponse(generateQuestionsValidator, text, context);
  if (result.status !== "validated")
    return { result, presented: [], unreached: [], unreachedReason: "budget" };
  const ranked = rank((result.accepted as AcceptedItems<Items>).questions, context.questions);
  const budget = context.questions.budget;
  return {
    result,
    presented: ranked.slice(0, budget),
    unreached: ranked.slice(budget),
    unreachedReason: "budget",
  };
}
