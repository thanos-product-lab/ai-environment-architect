import type { SecretRuleId } from "../context/secrets.js";
import { pathHash } from "../context/secrets.js";
import type { ReadyContext } from "../context/select.js";
import { withBlockedFiles } from "../context/select.js";
import { checkTokens, type TokenCheckResult } from "../context/token-check.js";
import { callAliasTable, callLimits, type RecordCall, recordCallPlan } from "../requests/build.js";
import {
  type ChangeLines,
  type NumberedRecords,
  numberRecords,
  withholdForCall,
} from "../requests/records.js";
import { recordGenerateQuestions } from "../session/questions.js";
import { recordRecommend } from "../session/recommendations.js";
import type { SessionRecord } from "../session/records.js";
import { type CallOutcome, type CallPlan, runCall } from "../session/send.js";
import type { HeldSession } from "../session/store.js";
import type { AliasTable } from "../validation/aliases.js";
import {
  type QuestionsValidation,
  validateGenerateQuestions,
} from "../validation/generate-questions.js";
import { type RecommendValidation, validateRecommend } from "../validation/recommend.js";
import {
  activeConfig,
  callModel,
  type Inspection,
  type RunDeps,
  startedFields,
} from "./analysis.js";
import { questionValidationContext, recommendValidationContext } from "./contexts.js";

// Running calls 3 and 4 (IMPL §1.2, §1.10, §3.2.6, §3.3.4–§3.3.5). They send validated records,
// cited excerpts, the destination and the tree; never the raw context. Each call scans its
// records before numbering them, checks its tokens by removing excerpts and then tree depth, and
// records its response.

/**
 * What calls 3–5 start from (§3.2.6): call 1's context as its token check left it, with every
 * file the expansion round blocked left out and marked `[S]`, whether or not call 2 was sent.
 */
export function recordsBase(sent: ReadyContext, records: readonly SessionRecord[]): ReadyContext {
  const round = records.find((r) => r.type === "expansion_round");
  if (round === undefined || round.type !== "expansion_round" || round.blocked.length === 0)
    return sent;
  const byHash = new Map(sent.parts.snapshot.files.map((f) => [pathHash(f.path), f.path]));
  const blocked = round.blocked.flatMap((entry) => {
    const path = "path" in entry ? entry.path : byHash.get(entry.pathHash);
    return path === undefined ? [] : [{ path, ruleId: entry.secretRuleId as SecretRuleId }];
  });
  return withBlockedFiles(sent, blocked, {
    text: sent.parts.factsText,
    bytes: sent.parts.factsBytes,
    sent: sent.parts.factsSent,
    leftOut: sent.parts.factsLeftOut,
  });
}

export interface RecordCallRun {
  /** Call 1's context as sent (`AnalyseOutcome.sent`). */
  readonly sent: ReadyContext;
  readonly inspection: Inspection;
  readonly destination: Uint8Array | undefined;
}

export type RecordCallOutcome<V> =
  | CallOutcome<V>
  /** The token check stopped the call before it was sent (§1.10, §2.12). */
  | {
      readonly kind: "stopped";
      readonly check: Exclude<TokenCheckResult, { state: "fits" }>;
    };

export interface Prepared {
  readonly numbered: NumberedRecords;
  readonly aliases: AliasTable;
  readonly records: readonly SessionRecord[];
}

/** Call 5's part of a call: the recommendations it is sent, and what changed. */
export interface RegenerationPart {
  /** By `recommendationId`, in recommendation order. */
  readonly recommendations: readonly string[];
  readonly changes: (numbered: NumberedRecords, records: readonly SessionRecord[]) => ChangeLines;
}

export async function runRecordCall<V>(
  session: HeldSession,
  deps: RunDeps,
  call: RecordCall,
  run: RecordCallRun,
  finish: (prepared: Prepared) => Pick<CallPlan<V>, "validate" | "resultOf" | "extrasOf">,
  part?: RegenerationPart,
): Promise<{ outcome: RecordCallOutcome<V>; prepared?: Prepared }> {
  const numbering = {
    call,
    knownFactsSent: run.inspection.knownFactsSent,
    ...(part === undefined ? {} : { recommendations: part.recommendations }),
  };
  const { withheldExcerpts, excerptRules } = await session.change((log) =>
    withholdForCall(log, numbering),
  );
  const records = session.records;
  const config = activeConfig(records);
  const numbered = numberRecords(records, numbering);
  const base = recordsBase(run.sent, records);
  const plan = recordCallPlan(
    {
      call,
      numbered,
      render: { records, destination: run.destination, withheldExcerpts },
      excerptRules,
      base,
      limits: callLimits(call, config.questionBudget),
      ...(part === undefined ? {} : { changes: part.changes(numbered, records) }),
      knownFacts: {
        sentInCallOne: run.inspection.knownFactsSent.length,
        leftOutOfCallOne: run.sent.parts.factsLeftOut,
      },
    },
    deps.prompts.prompt(call),
    callModel(config, call),
  );
  const checked = await checkTokens(call, plan.plan, {
    counter: deps.counter,
    models: deps.models,
    tokens: config.settings.tokens,
  });
  if (checked.state !== "fits") return { outcome: { kind: "stopped", check: checked } };
  const aliases = callAliasTable(call, numbered, { records, destination: run.destination });
  const prepared = { numbered, aliases, records };
  const outcome = await runCall(session, deps, {
    purpose: call,
    request: checked.request,
    inputTokens: checked.tokenCheck.inputTokens,
    started: startedFields(call, deps, plan.manifest(checked.removed, checked.tokenCheck), aliases),
    ...finish(prepared),
  });
  return { outcome, prepared };
}

/** Call 3: questions, recorded in ranked order (§3.3.4). */
export async function runGenerateQuestions(
  session: HeldSession,
  deps: RunDeps,
  run: RecordCallRun,
): Promise<RecordCallOutcome<QuestionsValidation>> {
  const budget = activeConfig(session.records).questionBudget;
  const { outcome, prepared } = await runRecordCall<QuestionsValidation>(
    session,
    deps,
    "generate_questions",
    run,
    ({ numbered, aliases }) => {
      const context = questionValidationContext(run.sent.parts.snapshot, aliases, numbered, budget);
      return {
        validate: (text) => validateGenerateQuestions(text, context),
        resultOf: (validation) => validation.result,
        extrasOf: (validation) =>
          validation.result.status === "validated"
            ? { questionOrder: validation.result.response.questions.map((q) => q.key) }
            : {},
      };
    },
  );
  if (outcome.kind === "completed" && prepared !== undefined)
    await session.change((log) => {
      recordGenerateQuestions(
        { log, modelCallId: outcome.modelCallId, aliases: prepared.aliases },
        outcome.validation,
      );
    });
  return outcome;
}

/** Call 4: recommendations and held-back topics (§3.3.5). */
export async function runRecommend(
  session: HeldSession,
  deps: RunDeps,
  run: RecordCallRun,
): Promise<RecordCallOutcome<RecommendValidation>> {
  const { outcome, prepared } = await runRecordCall<RecommendValidation>(
    session,
    deps,
    "recommend",
    run,
    ({ numbered, aliases, records }) => {
      const context = recommendValidationContext(
        run.sent.parts.snapshot,
        aliases,
        numbered,
        records,
        run.destination,
      );
      return {
        validate: (text) => validateRecommend(text, context),
        resultOf: (validation) => validation.result,
      };
    },
  );
  if (outcome.kind === "completed" && prepared !== undefined)
    await session.change((log) => {
      recordRecommend(
        { log, modelCallId: outcome.modelCallId, aliases: prepared.aliases },
        outcome.validation,
      );
    });
  return outcome;
}
