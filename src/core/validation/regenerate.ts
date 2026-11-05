import type { z } from "zod";
import { regenerateRecommendations } from "../../schemas/regenerate_recommendations.js";
import type { AssemblyTarget } from "../assembly/assemble.js";
import { resolveReference } from "./aliases.js";
import { limitCheck } from "./limits.js";
import {
  type AcceptedItems,
  accept,
  type CallValidator,
  type CrossItemCheck,
  type CrossItemNote,
  type CrossItemRejection,
  type ItemCheck,
  reject,
  type ValidationResult,
  validateResponse,
} from "./pipeline.js";
import {
  blockedByCheck,
  type HeldBack,
  heldBackCheck,
  RECOMMENDATION_CHECKS,
  type Recommendation,
  type RecommendationItem,
  type RecommendContext,
  recommendationIdentity,
} from "./recommend.js";

// `regenerate_recommendations` (IMPL §3.3.6). The affected recommendations are sent as `R`
// aliases; the model keeps, revises or drops each one exactly once, and may add new ones.
//
// - Each action's target is an `R` alias. A `revise` keeps its recommendation's operation
//   (REGEN-002). Its revision, and each addition, are validated as `recommend` ones (§3.3.5).
// - A `keep` is accepted, and code revalidates the stored revision it names. A failure records
//   one event named by the `R` alias; the effect is `revalidation_failed`.
// - Cross-item: REGEN-001 for actions sharing a target (all rejected), DUP-004 against the
//   unaffected recommendations and passing keeps, HELD-001, then REGEN-001 for every affected
//   recommendation left without an accepted action, which rejects no item.

type Response = z.infer<typeof regenerateRecommendations.response>;
export type Action = Response["actions"][number];
/** A recommendation without its local key: a `revise`'s revision, or a stored one. */
export type RecommendationBody = Omit<Recommendation, "key">;

/** What a `keep` found when it revalidated the stored revision. */
export type KeptRevision =
  | { readonly ok: true; readonly item: RecommendationItem }
  | { readonly ok: false; readonly rule: string };

export type ActionItem = Action & {
  /** A `revise`'s revision as the checks pass it on, with what code resolves. */
  readonly checked?: RecommendationItem;
  readonly kept?: KeptRevision;
};

/** An affected recommendation as sent. */
export interface AffectedRecommendation {
  /** Its current revision's operation, which a `revise` keeps (REGEN-002). */
  readonly operation: Recommendation["operation"];
  /**
   * Its current revision in this call's aliases; undefined when some of its support has no alias
   * here, being no longer current, so a `keep` fails REC-001.
   */
  readonly revision: RecommendationBody | undefined;
}

/** A current valid recommendation not sent, for DUP-004, its target resolved in the snapshot. */
export interface ExistingRecommendation {
  readonly operation: Recommendation["operation"];
  readonly target: AssemblyTarget;
  readonly content?: string | undefined;
}

export interface RegenerateContext extends RecommendContext {
  /** By `R` alias, in alias order: every one this call was sent. */
  readonly affected: ReadonlyMap<string, AffectedRecommendation>;
  readonly unaffected: readonly ExistingRecommendation[];
}

type Items = {
  actions: ActionItem;
  additions: RecommendationItem;
  heldBack: HeldBack;
};

type ActionCheck = ItemCheck<ActionItem, RegenerateContext>;

/** The action's target names an affected recommendation (ALIAS-001, ALIAS-003). */
const targetCheck: ActionCheck = (value, context, response) => {
  const resolved = resolveReference(context.aliases, response.localKeys, value.target, {
    aliases: ["R"],
  });
  if (!resolved.ok) return reject(resolved.rule, resolved.detail);
  if (!context.affected.has(value.target))
    throw new Error(`${value.target} is in the table but wasn't sent as affected`);
  return accept(value);
};

/** REGEN-002: a `revise` keeps its recommendation's operation; its target may change. */
const operationKeptCheck: ActionCheck = (value, context) => {
  if (value.action !== "revise") return accept(value);
  const affected = context.affected.get(value.target);
  if (affected === undefined) throw new Error(`revise of ${value.target} before its target check`);
  if (value.revision.operation === affected.operation) return accept(value);
  return reject(
    "REGEN-002",
    `${value.target} is ${article(affected.operation)}; a different operation is a drop and an addition`,
  );
};

const article = (operation: string) => `${operation === "add" ? "an" : "a"} ${operation}`;

/** Runs a recommendation check on a `revise`'s revision; other actions pass. */
function onRevision(check: ItemCheck<RecommendationItem, RecommendContext>): ActionCheck {
  return (value, context, response, position) => {
    if (value.action !== "revise") return accept(value);
    const current: RecommendationItem = value.checked ?? { key: "", ...value.revision };
    const result = check(current, context, response, position);
    if (result.kind === "reject") return reject(result.rule, result.detail, ...result.events);
    return accept({ ...value, checked: result.value }, ...result.events);
  };
}

/** A `keep`: the stored revision against the current state, from REC-001 on (§3.3.6). */
const keepCheck: ActionCheck = (value, context) => {
  if (value.action !== "keep") return accept(value);
  const affected = context.affected.get(value.target);
  if (affected === undefined) throw new Error(`keep of ${value.target} before its target check`);
  const failed = (rule: string, detail: string) =>
    accept<ActionItem>(
      { ...value, kept: { ok: false, rule } },
      {
        rule,
        outcome: "rejected",
        detail: `the kept revision fails: ${detail}`,
        itemKey: value.target,
      },
    );
  if (affected.revision === undefined) return failed("REC-001", "its support is no longer current");
  // The stored revision defines no local keys; only this call's aliases resolve.
  const scope = { localKeys: new Set<string>() };
  let item: RecommendationItem = { key: value.target, ...affected.revision };
  for (const check of RECOMMENDATION_CHECKS) {
    const result = check(item, context, scope);
    if (result.kind === "reject") return failed(result.rule, result.detail);
    item = result.value;
  }
  return accept({ ...value, kept: { ok: true, item } });
};

// --- Cross-item -------------------------------------------------------------------------------

/** REGEN-001: two or more actions on one target are all rejected. */
const sharedTargetCheck: CrossItemCheck<Items, RegenerateContext> = (surviving) => {
  const counts = new Map<string, number>();
  for (const { value } of surviving.actions)
    counts.set(value.target, (counts.get(value.target) ?? 0) + 1);
  return surviving.actions
    .filter(({ value }) => (counts.get(value.target) ?? 0) > 1)
    .map(({ index, value }) => ({
      collection: "actions" as const,
      index,
      rule: "REGEN-001",
      detail: `another action names ${value.target}`,
    }));
};

/**
 * DUP-004: revisions and additions against the unaffected recommendations and passing keeps,
 * which are kept, then against each other, the earlier kept.
 */
const duplicateCheck: CrossItemCheck<Items, RegenerateContext> = (surviving, context) => {
  const kept = new Map<string, string>();
  for (const existing of context.unaffected) {
    const identity = recommendationIdentity({ ...existing, resolvedTarget: existing.target });
    if (!kept.has(identity)) kept.set(identity, "an existing recommendation");
  }
  for (const { value } of surviving.actions)
    if (value.kept?.ok === true) {
      const identity = recommendationIdentity(value.kept.item);
      if (!kept.has(identity)) kept.set(identity, value.target);
    }
  const rejections: CrossItemRejection<Items>[] = [];
  const compare = (
    collection: "actions" | "additions",
    index: number,
    key: string,
    item: RecommendationItem,
  ) => {
    const identity = recommendationIdentity(item);
    const earlier = kept.get(identity);
    if (earlier === undefined) kept.set(identity, key);
    else rejections.push({ collection, index, rule: "DUP-004", detail: `duplicate of ${earlier}` });
  };
  for (const { index, key, value } of surviving.actions)
    if (value.checked !== undefined) compare("actions", index, key, value.checked);
  for (const { index, key, value } of surviving.additions) compare("additions", index, key, value);
  return rejections;
};

/** REGEN-001, last: every affected recommendation no accepted action covers. */
const coverageCheck: CrossItemCheck<Items, RegenerateContext> = (surviving, context) => {
  const covered = new Set(surviving.actions.map(({ value }) => value.target));
  return [...context.affected.keys()]
    .filter((alias) => !covered.has(alias))
    .map(
      (alias): CrossItemNote => ({
        kind: "note",
        itemKey: alias,
        rule: "REGEN-001",
        detail: "no accepted action reconsiders it",
      }),
    );
};

const heldBack = (surviving: AcceptedItems<Items>, context: RegenerateContext) =>
  heldBackCheck<Items, RegenerateContext>(surviving, context);

export const regenerateValidator: CallValidator<Response, RegenerateContext, Items> = {
  schema: regenerateRecommendations.response,
  order: ["actions", "additions", "heldBack"],
  collections: {
    actions: {
      items: (response) => response.actions,
      key: () => ({ kind: "position" }),
      checks: [
        limitCheck(regenerateRecommendations.items.actions),
        targetCheck,
        operationKeptCheck,
        ...RECOMMENDATION_CHECKS.map(onRevision),
        keepCheck,
      ],
    },
    additions: {
      items: (response) => response.additions,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [limitCheck(regenerateRecommendations.items.additions), ...RECOMMENDATION_CHECKS],
    },
    heldBack: {
      items: (response) => response.heldBack,
      key: () => ({ kind: "position" }),
      checks: [limitCheck(regenerateRecommendations.items.heldBack), blockedByCheck],
    },
  },
  crossItem: [sharedTargetCheck, duplicateCheck, heldBack, coverageCheck],
};

export type RegenerateItems = Items;

export interface RegenerateValidation {
  readonly result: ValidationResult<Items, Response>;
}

export function validateRegenerate(text: string, context: RegenerateContext): RegenerateValidation {
  return { result: validateResponse(regenerateValidator, text, context) };
}
