import { GENERATE_QUESTIONS_COLLECTION_LIMITS } from "../../schemas/generate_questions.js";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import { RECOMMEND_COLLECTION_LIMITS } from "../../schemas/recommend.js";
import { REGENERATE_COLLECTION_LIMITS } from "../../schemas/regenerate_recommendations.js";
import { blockRanges, renderDestinationSection } from "../context/item.js";
import { recordedPath } from "../context/secrets.js";
import type {
  InputManifest,
  ReadyContext,
  Reduction,
  TokenCheckRecord,
} from "../context/select.js";
import { treeAt } from "../context/select.js";
import {
  type CitedExcerpt,
  excerptReductions,
  type ReductionPlan,
} from "../context/token-check.js";
import { type Hash, sha256 } from "../hash.js";
import type { Effort, ModelRequest } from "../request.js";
import { currentState } from "../session/current.js";
import { activeDestination } from "../session/exclusion.js";
import { DESTINATION_PATH } from "../snapshot/snapshot.js";
import { type AliasTable, type CallPurpose, createAliasTable } from "../validation/aliases.js";
import {
  type ChangeLines,
  citedExcerpts,
  type NumberedRecords,
  type RenderContext,
  renderChanges,
  renderLimits,
  renderRecordSections,
} from "./records.js";

// Building each call's complete request (IMPL §1.10, §1.13, §3.2.6, §3.7). Code assembles the
// system prompt, the user content and the schema; the token check counts and reduces what this
// builds, and the retry policy sends it. Requests set no cache breakpoint (§1.2, §4.6).

/** One call's prompt from the prompt set: its version, the hash of its bytes, and its text. */
export interface CallPrompt {
  readonly version: string;
  readonly hash: Hash;
  readonly text: string;
}

/** The generation settings a call is sent with (IMPL §3.7, §1.10). */
export interface CallModel {
  readonly model: string;
  readonly effort: Effort;
  readonly reservedOutputTokens: number;
}

export function modelRequest(
  call: CallPurpose,
  prompt: CallPrompt,
  model: CallModel,
  user: string,
): ModelRequest {
  return {
    model: model.model,
    maxTokens: model.reservedOutputTokens,
    effort: model.effort,
    system: prompt.text,
    user,
    schema: CALL_SCHEMAS[call].apiSchema,
  };
}

// --- Call 2 ----------------------------------------------------------------------------------

/** What call 2 adds after the context (IMPL §3.2.6): never removed by the token check. */
export interface ExpansionParts {
  /** `renderCallOneResults`. */
  readonly results: string;
  /** `renderExpansionStatus`. */
  readonly status: string;
  /** The rendered `E` items, in order. */
  readonly items: readonly string[];
}

/** Call 2's user content around a context, for `checkContextCall`'s `build`. */
export function expansionUser(context: ReadyContext, parts: ExpansionParts): string {
  return context.context.text + parts.results + parts.status + parts.items.join("");
}

/**
 * Call 2's manifest (IMPL §1.13): its own context's, which the token check set, naming the
 * expansion round. The `E` items are listed only in the round's record.
 */
export function expansionManifest(context: ReadyContext, expansionRoundId: string): InputManifest {
  return { ...context.manifest, expansion: { expansionRoundId } };
}

// --- Calls 3–5 -------------------------------------------------------------------------------

export type RecordCall = "generate_questions" | "recommend" | "regenerate_recommendations";

export interface RecordCallInput {
  readonly call: RecordCall;
  readonly numbered: NumberedRecords;
  /** The withheld excerpts come from `withholdForCall`; the token check sets the removed ones. */
  readonly render: Omit<RenderContext, "removedExcerpts">;
  /** Each withheld excerpt's rule, by evidence ID, for the manifest's `skipped`. */
  readonly excerptRules: ReadonlyMap<string, string>;
  /** Call 1's context as sent, with files blocked since left out (`withBlockedFiles`). */
  readonly base: ReadyContext;
  readonly limits: readonly (readonly [string, number])[];
  /** Call 5 only. */
  readonly changes?: ChangeLines;
  readonly knownFacts: {
    /** How many known facts call 1 sent: `F-1` to `F-k`. */
    readonly sentInCallOne: number;
    readonly leftOutOfCallOne: number;
  };
}

export interface RecordCallPlan {
  /** The removals of §1.10 step 4, and the request after the first `n` of them. */
  readonly plan: ReductionPlan;
  /** The manifest of the request with the first `removed` units made (IMPL §1.13). */
  manifest(removed: number, tokenCheck: TokenCheckRecord): InputManifest;
}

/** The limits each call's `LIMITS` section sends (IMPL §3.2.6), in schema order. */
export function callLimits(call: RecordCall, questionBudget: number): [string, number][] {
  if (call === "generate_questions")
    return [
      ["questionBudget", questionBudget],
      ...Object.entries(GENERATE_QUESTIONS_COLLECTION_LIMITS),
    ];
  if (call === "recommend") return Object.entries(RECOMMEND_COLLECTION_LIMITS);
  return Object.entries(REGENERATE_COLLECTION_LIMITS);
}

export function recordCallPlan(
  input: RecordCallInput,
  prompt: CallPrompt,
  model: CallModel,
): RecordCallPlan {
  const { numbered, base } = input;
  const noneRemoved = { ...input.render, removedExcerpts: new Set<string>() };
  const excerpts = citedExcerpts(numbered, noneRemoved);
  const units = excerptReductions(
    excerpts,
    referencedFindings(numbered, input.render.records),
    base.tree.depth,
  );
  const destination = renderDestinationSection(
    DESTINATION_PATH,
    input.render.destination,
    input.render.destination === undefined
      ? []
      : blockRanges(input.render.destination, destinationBlocks(input.render)),
  );
  const limits = renderLimits(input.limits);

  const removedBy = (n: number) => {
    const made = units.slice(0, n);
    const removedExcerpts = new Set(made.flatMap((u) => (u.step === "excerpt" ? [u.id] : [])));
    const depths = made.flatMap((u) => (u.step === "tree_depth" ? [u.treeDepth] : []));
    return { removedExcerpts, depth: depths.at(-1) ?? base.tree.depth };
  };
  const user = (n: number) => {
    const { removedExcerpts, depth } = removedBy(n);
    const sections = renderRecordSections(numbered, { ...input.render, removedExcerpts });
    const tree = depth === base.tree.depth ? base.tree : treeAt(base, depth);
    const text = [
      destination,
      tree.text,
      limits,
      sections.findings,
      sections.conflicts,
      ...(input.call === "generate_questions" ? [] : [sections.questions, sections.decisions]),
      ...(input.call === "regenerate_recommendations"
        ? [sections.recommendations, renderChanges(input.changes ?? NO_CHANGES)]
        : []),
    ].join("");
    return { text, tree, removedExcerpts };
  };

  return {
    plan: { units, render: (n) => modelRequest(input.call, prompt, model, user(n).text) },
    manifest(removed, tokenCheck) {
      const { text, tree, removedExcerpts } = user(removed);
      const bytes = new TextEncoder().encode(text);
      const factsSent = numbered.findings.filter(
        (f) => Number(f.alias.slice(2)) <= input.knownFacts.sentInCallOne,
      ).length;
      const tier4 = base.manifest.tiers.find((t) => t.tier === 4);
      return {
        ...base.manifest,
        contextHash: sha256(bytes),
        retainedInputRef: null,
        budget: {
          initialContextBytes: base.manifest.budget.initialContextBytes,
          usedBytes: bytes.length,
        },
        knownFacts: {
          capBytes: base.manifest.knownFacts.capBytes,
          usedBytes: 0,
          facts: factsSent,
          leftOut: input.knownFacts.leftOutOfCallOne + (input.knownFacts.sentInCallOne - factsSent),
        },
        tokenCheck,
        tiers: [
          {
            tier: 4,
            capBytes: tier4 === undefined ? 0 : tier4.capBytes,
            usedBytes: tree.bytes,
            treeDepth: tree.depth,
          },
        ],
        items: [],
        skipped: [
          ...excerpts
            .filter((e) => removedExcerpts.has(e.id))
            .map((e) => ({ ...recordedPath(e.path), reason: "token-check:excerpt" })),
          ...withheldInOrder(numbered, input).map(({ path, rule }) => ({
            ...recordedPath(path),
            reason: `secret-scan:${rule}`,
          })),
        ],
        expansion: null,
      };
    },
  };
}

const NO_CHANGES: ChangeLines = { decisions: [], staleFindings: 0, targetChanged: 0 };

/**
 * The findings an open question or a sent recommendation references, whose excerpts the token
 * check keeps (IMPL §1.10 step 4). In call 3 there are none.
 */
function referencedFindings(
  numbered: NumberedRecords,
  records: RenderContext["records"],
): Set<string> {
  const aliases = new Set<string>();
  const add = (id: string) => {
    const alias = numbered.aliasOf(id);
    if (alias?.startsWith("F-")) aliases.add(alias);
  };
  if (numbered.call === "generate_questions") return aliases;
  const state = currentState(records);
  for (const { record } of numbered.questions) {
    if (record.status !== "open") continue;
    for (const id of [...record.findingIds, ...record.gapIds]) add(id);
    for (const id of record.conflictIds)
      for (const member of state.conflicts.get(id)?.findingIds ?? []) add(member);
  }
  // Every current valid recommendation is a candidate, sent or not (§1.10 step 4).
  for (const record of state.recommendations.values()) {
    for (const s of record.support) if (s.kind === "finding") add(s.findingId);
    for (const r of record.references) add(r.supportingFindingId);
  }
  return aliases;
}

/** The withheld excerpts, in rendering order, with their paths and rules. */
function withheldInOrder(
  numbered: NumberedRecords,
  input: RecordCallInput,
): { path: string; rule: string }[] {
  const evidence = new Map(
    input.render.records.flatMap((r) => (r.type === "evidence" ? [[r.id, r] as const] : [])),
  );
  const out: { path: string; rule: string }[] = [];
  const seen = new Set<string>();
  for (const { record } of numbered.findings) {
    if (!("evidenceIds" in record)) continue;
    for (const id of record.evidenceIds) {
      const rule = input.excerptRules.get(id);
      const item = evidence.get(id);
      if (rule === undefined || seen.has(id) || item === undefined || !("path" in item)) continue;
      seen.add(id);
      out.push({ path: item.path, rule });
    }
  }
  return out;
}

// --- Alias tables ----------------------------------------------------------------------------

/**
 * A call's alias table (IMPL §3.2.1): the items of calls 1–2, the numbered records, and the
 * active destination's blocks in document order.
 */
export function callAliasTable(
  call: CallPurpose,
  numbered: NumberedRecords | undefined,
  destination: Pick<RenderContext, "records" | "destination">,
  items: readonly string[] = [],
): AliasTable {
  const blocks = destinationBlocks(destination).map((b) => ({ blockId: b.blockId, hash: b.hash }));
  return createAliasTable(call, {
    items,
    ...(numbered === undefined
      ? {}
      : {
          findings: numbered.sources.findings,
          conflicts: numbered.sources.conflicts,
          questions: numbered.sources.questions,
          decisions: numbered.sources.decisions,
          recommendations: numbered.sources.recommendations,
        }),
    blocks,
  });
}

/**
 * The active destination's blocks, in document order: the one list both the alias table and the
 * BLOCKS lines number, so `B-<n>` means the same block in both.
 */
export function destinationBlocks(destination: Pick<RenderContext, "records" | "destination">) {
  return activeDestination(destination.records, destination.destination).blocks;
}

export type { CitedExcerpt, Reduction };
