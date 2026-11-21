import { ANALYSE_COLLECTION_LIMITS } from "../../schemas/analyse.js";
import { ANALYSE_EXPANSION_COLLECTION_LIMITS } from "../../schemas/analyse_expansion.js";
import { FIELD_LIMITS } from "../../schemas/common.js";
import { GENERATE_QUESTIONS_COLLECTION_LIMITS } from "../../schemas/generate_questions.js";
import { RECOMMEND_COLLECTION_LIMITS } from "../../schemas/recommend.js";
import { REGENERATE_COLLECTION_LIMITS } from "../../schemas/regenerate_recommendations.js";
import { CONTEXT_LINES, MAX_MATCHES } from "../context/expansion.js";
import { type Hash, sha256 } from "../hash.js";
import type { CallPrompt } from "../requests/build.js";
import type { CallPurpose } from "../validation/aliases.js";
import { MAX_CITED_LINES, MIN_QUOTE_CODE_POINTS } from "../validation/citations.js";
import { MIN_LITERAL_CODE_POINTS } from "../validation/expansion.js";
import { QUESTION_BUDGET_FACTOR } from "../validation/generate-questions.js";
import { IMPERATIVE_VERBS, MAX_ADDED_BLOCKS } from "../validation/recommend.js";
import { PROSE_RUNNERS } from "../validation/references.js";
import {
  DIRECTIVE_WORDS,
  NUMBER_WORDS,
  QUANTITY_WORDS,
  UNIVERSAL_WORDS,
  USE_INSTEAD_PHRASE,
} from "../validation/support.js";
import type { PromptSet } from "./prompts.js";

// Prompt templates (IMPL §3.7). A prompt file is Markdown with `{{name}}` placeholders, and every
// limit, count and word list in its prose is one: code fills it here from the schema's limits and
// the validator's constants, so no number is typed by hand and none can drift from what is
// checked. The rendered text is what is sent and what `promptHash` covers.

/** The prompt version each call is sent with: `prompts/<call>/<version>.md`. */
export const RELEASED_PROMPTS: Readonly<Record<CallPurpose, string>> = {
  analyse: "1.0.0",
  analyse_expansion: "1.0.0",
  generate_questions: "1.0.0",
  recommend: "1.0.0",
  regenerate_recommendations: "1.0.0",
};

const COLLECTION_LIMITS: Readonly<Record<CallPurpose, Readonly<Record<string, number>>>> = {
  analyse: ANALYSE_COLLECTION_LIMITS,
  analyse_expansion: ANALYSE_EXPANSION_COLLECTION_LIMITS,
  generate_questions: GENERATE_QUESTIONS_COLLECTION_LIMITS,
  recommend: RECOMMEND_COLLECTION_LIMITS,
  regenerate_recommendations: REGENERATE_COLLECTION_LIMITS,
};

/** Each collection of the call's schema with its size limit, in schema order. */
export function collectionLimits(call: CallPurpose): readonly (readonly [string, number])[] {
  return Object.entries(COLLECTION_LIMITS[call]);
}

/** A word list as inline code spans, joined with `, `. */
function words(list: readonly string[]): string {
  return list.map((word) => `\`${word}\``).join(", ");
}

/**
 * The values a template may name. Shared limits come first; `max.<collection>` is the call's own
 * collection limit, so each call's prompt quotes its own schema.
 */
export function promptVariables(call: CallPurpose): ReadonlyMap<string, string> {
  const L = FIELD_LIMITS;
  const values = new Map<string, string>();
  const set = (name: string, value: number | string) => {
    if (values.has(name)) throw new Error(`prompt ${call}: two values named {{${name}}}`);
    values.set(name, String(value));
  };

  for (const [name, value] of Object.entries(L)) {
    if (typeof value === "number") set(`len.${name}`, value);
    else {
      set(`min.${name}`, value.min);
      set(`max.${name}`, value.max);
    }
  }
  for (const [name, value] of collectionLimits(call)) set(`max.${name}`, value);

  set("min.quote", MIN_QUOTE_CODE_POINTS);
  set("max.citedLines", MAX_CITED_LINES);
  set("min.literal", MIN_LITERAL_CODE_POINTS);
  set("max.searchMatches", MAX_MATCHES);
  set("searchContextLines", CONTEXT_LINES);
  set("max.addedBlocks", MAX_ADDED_BLOCKS);
  set("questionBudgetFactor", QUESTION_BUDGET_FACTOR);

  set("words.quantity", words(QUANTITY_WORDS));
  set("words.universal", words(UNIVERSAL_WORDS));
  set("words.number", words(NUMBER_WORDS));
  set("words.directive", words([...DIRECTIVE_WORDS, USE_INSTEAD_PHRASE]));
  set("words.imperative", words(IMPERATIVE_VERBS));
  set("words.proseRunners", words(PROSE_RUNNERS));
  return values;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The placeholder names a template uses, in order of first use. */
export function placeholders(template: string): readonly string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""))];
}

/** Fills every placeholder; one code doesn't define, or a stray brace pair, fails the load. */
export function renderPrompt(call: CallPurpose, template: string): string {
  const values = promptVariables(call);
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`prompt ${call}: unknown placeholder {{${name}}}`);
    return value;
  });
  if (rendered.includes("{{") || rendered.includes("}}"))
    throw new Error(`prompt ${call}: an unpaired placeholder brace`);
  return rendered;
}

/** One call's prompt, rendered, with the hash of the text as sent. */
export function buildPrompt(call: CallPurpose, version: string, template: string): CallPrompt {
  const text = renderPrompt(call, template);
  return { version, hash: textHash(text), text };
}

export function textHash(text: string): Hash {
  return sha256(new TextEncoder().encode(text));
}

/**
 * The released prompt set, from each call's template text as read by an adapter. Every prompt
 * is rendered at once, so a template that fails to render fails before any call is sent.
 */
export function releasedPromptSet(template: (call: CallPurpose, version: string) => string) {
  const calls = Object.keys(RELEASED_PROMPTS) as CallPurpose[];
  const built = new Map(
    calls.map((call) => {
      const version = RELEASED_PROMPTS[call];
      return [call, buildPrompt(call, version, template(call, version))] as const;
    }),
  );
  const set: PromptSet = {
    testOnly: false,
    prompt(call) {
      const prompt = built.get(call);
      if (prompt === undefined) throw new Error(`no released prompt for ${call}`);
      return prompt;
    },
  };
  return set;
}
