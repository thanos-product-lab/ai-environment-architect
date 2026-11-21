import { CALL_SCHEMAS } from "../../schemas/index.js";
import type { ExpansionInputRequest, ExpansionRound } from "../context/expansion.js";
import { renderExpansionStatus, runExpansion } from "../context/expansion.js";
import type { ReadyContext } from "../context/select.js";
import { withBlockedFiles } from "../context/select.js";
import type { SelectionGap } from "../context/tiers.js";
import {
  type ContextCallResult,
  checkContextCall,
  type ModelLimits,
  type TokenCounter,
} from "../context/token-check.js";
import type { ModelRequest } from "../request.js";
import {
  type CallModel,
  callAliasTable,
  expansionManifest,
  expansionUser,
  modelRequest,
} from "../requests/build.js";
import {
  numberRecords,
  type RecordNumbering,
  renderCallOneResults,
  renderKnownFactsAgain,
  withholdForCall,
} from "../requests/records.js";
import { recordAnalyse, recordAnalyseExpansion, recordKnownFacts } from "../session/analysis.js";
import { skipExpansion } from "../session/calls.js";
import { recordExpansionRound, withholdBlockedFiles } from "../session/expansion.js";
import type { RecordOf, SessionRecord } from "../session/records.js";
import { type CallOutcome, runCall, type SendDeps, type StartedFields } from "../session/send.js";
import { recordSnapshot } from "../session/snapshot.js";
import type { HeldSession } from "../session/store.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import type { CallPurpose } from "../validation/aliases.js";
import {
  type AnalyseContext,
  type AnalyseValidation,
  validateAnalyse,
} from "../validation/analyse.js";
import {
  type AnalyseExpansionValidation,
  validateAnalyseExpansion,
} from "../validation/analyse-expansion.js";
import { VALIDATOR_VERSION } from "../validation/pipeline.js";
import { DETECTOR_VERSION } from "../validation/references.js";
import {
  analyseExpansionValidationContext,
  analyseValidationContext,
  citableItems,
  contextItems,
  type SentItem,
} from "./contexts.js";
import type { PromptSet } from "./prompts.js";

// Running calls 1 and 2 (IMPL §1.2, §1.8, §1.10, §3.3.2–§3.3.3). Each call is checked for tokens
// before it is sent, and a gap its check reports is recorded before the send. Between the calls,
// the expansion round runs and is recorded whether or not call 2 is sent; call 2 is sent only
// when the round returned an item.

/** Everything the core needs to run calls: the send policy's ports, and the token check's. */
export interface RunDeps extends SendDeps {
  readonly counter: TokenCounter;
  readonly models: ModelLimits;
  readonly fs: RepositoryFs;
  readonly prompts: PromptSet;
  /** The `anthropic-version` the adapter sends (ADR 0003), which every call records. */
  readonly apiVersion: string;
  /** Only test harnesses set it: a test-only prompt set is refused otherwise (IMPL §3.7). */
  readonly allowTestPrompts?: true;
}

type Config = RecordOf<"generation_config">;

/** The session's generation settings: its latest `generation_config` revision. */
export function activeConfig(records: readonly SessionRecord[]): Config {
  const config = records.filter((r): r is Config => r.type === "generation_config").at(-1);
  if (config === undefined) throw new Error("the session has no generation_config");
  return config;
}

export function callModel(config: Config, call: CallPurpose): CallModel {
  return {
    model: config.requestedModel,
    effort: config.effort,
    reservedOutputTokens: config.settings.tokens.reservedOutputTokens[call],
  };
}

/** The fields every call's `started` revision takes from its request and table. */
export function startedFields(
  call: CallPurpose,
  deps: RunDeps,
  manifest: StartedFields["inputManifest"],
  aliases: StartedFields["aliases"],
): StartedFields {
  if (deps.prompts.testOnly && deps.allowTestPrompts !== true)
    throw new Error("a test-only prompt set can't be sent: load the released prompts");
  const prompt = deps.prompts.prompt(call);
  return {
    apiVersion: deps.apiVersion,
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    schemaVersion: CALL_SCHEMAS[call].version,
    schemaHash: CALL_SCHEMAS[call].schemaHash,
    validatorVersion: VALIDATOR_VERSION,
    detectorVersion: DETECTOR_VERSION,
    inputManifest: manifest,
    aliases,
  };
}

function tokenDeps(deps: RunDeps, records: readonly SessionRecord[]) {
  return {
    counter: deps.counter,
    models: deps.models,
    tokens: activeConfig(records).settings.tokens,
  };
}

/** A token check's gap (IMPL §1.10), recorded as a deterministic finding before the call. */
async function recordGap(session: HeldSession, snapshotId: string, gap: SelectionGap | undefined) {
  if (gap === undefined) return;
  await session.change((log) => {
    recordKnownFacts(log, snapshotId, [], [gap]);
  });
}

/** The count the token check settled on: unknown is never zero (§4.6). */
export function checkedTokens(context: ReadyContext): number {
  const check = context.manifest.tokenCheck;
  if (check === null) throw new Error("the token check hasn't run on this context");
  return check.inputTokens;
}

// --- Inspection ------------------------------------------------------------------------------

export interface Inspection {
  readonly snapshotId: string;
  /** The `findingId` of each known fact call 1 sends, in alias order (IMPL §3.2.6). */
  readonly knownFactsSent: readonly string[];
}

/**
 * Records the snapshot, every known fact, sent or not, and the context's deterministic gaps
 * (IMPL §3.2.5), before call 1.
 */
export async function recordInspection(
  session: HeldSession,
  context: ReadyContext,
): Promise<Inspection> {
  return session.change((log, files) => {
    const { record, content } = recordSnapshot(log, context.parts.snapshot);
    if (content !== undefined) files.contents.push(content.bytes);
    const ids = recordKnownFacts(
      log,
      record.id,
      context.knownFacts.map((f) => f.fact),
      context.gaps,
    );
    const byId = new Map(log.records.map((r) => [r.id, r]));
    const knownFactsSent = context.knownFacts.flatMap(({ alias }, i) => {
      const finding = byId.get(ids[i] as string);
      return alias !== null && finding?.type === "finding" && "findingId" in finding
        ? [finding.findingId]
        : [];
    });
    return { snapshotId: record.id, knownFactsSent };
  });
}

// --- Call 1 ----------------------------------------------------------------------------------

type Stop = Exclude<ContextCallResult, { state: "fits" | "skipped" }>;

export type AnalyseOutcome =
  | (Extract<CallOutcome<AnalyseValidation>, { kind: "completed" }> & {
      /** The context sent, as its token check left it: call 2 and calls 3–5 start from it. */
      readonly sent: ReadyContext;
      readonly validationContext: AnalyseContext;
    })
  | Exclude<CallOutcome<AnalyseValidation>, { kind: "completed" }>
  /** The token check stopped the call before it was sent (§1.10, §2.12). */
  | { readonly kind: "stopped"; readonly stop: Stop };

export interface AnalyseInput {
  readonly context: ReadyContext;
  readonly inspection: Inspection;
  readonly destination: Uint8Array | undefined;
}

export async function runAnalyse(
  session: HeldSession,
  deps: RunDeps,
  input: AnalyseInput,
): Promise<AnalyseOutcome> {
  const config = activeConfig(session.records);
  const prompt = deps.prompts.prompt("analyse");
  const model = callModel(config, "analyse");
  const build = (context: ReadyContext): ModelRequest =>
    modelRequest("analyse", prompt, model, context.context.text);
  const fits = await checkContextCall(
    "analyse",
    input.context,
    build,
    tokenDeps(deps, session.records),
  );
  if (fits.state !== "fits") return { kind: "stopped", stop: fits as Stop };
  await recordGap(session, input.inspection.snapshotId, fits.gap);

  const sent = fits.context;
  const facts = new Map(
    sent.knownFacts.flatMap(({ fact, alias }) => (alias === null ? [] : [[alias, fact] as const])),
  );
  const factRecords = input.inspection.knownFactsSent.map((findingId) => {
    const record = session.records.find(
      (r) => r.type === "finding" && "findingId" in r && r.findingId === findingId,
    );
    if (record === undefined) throw new Error(`no known fact ${findingId}`);
    return record.id;
  });
  const aliases = callAliasTable(
    "analyse",
    undefined,
    { records: session.records, destination: input.destination },
    sent.items.map((item) => item.id),
  );
  const table = {
    ...aliases,
    entries: [
      ...aliases.entries.filter((e) => e.kind === "T"),
      ...factRecords.map((recordId, i) => ({
        alias: `F-${i + 1}`,
        kind: "F" as const,
        target: { kind: "record" as const, recordId },
      })),
      ...aliases.entries.filter((e) => e.kind === "B"),
    ],
  };
  const citable = await citableItems(contextItems(sent), sent.membership, deps.fs);
  const validationContext = analyseValidationContext(
    sent,
    table,
    citable,
    config.expansion.maxExpansionRequests,
    (alias) => (facts.get(alias)?.evidence ?? []).map((e) => e.path),
  );
  const outcome = await runCall(session, deps, {
    purpose: "analyse",
    request: fits.request,
    inputTokens: checkedTokens(sent),
    started: startedFields("analyse", deps, sent.manifest, table),
    validate: (text) => validateAnalyse(text, validationContext),
    resultOf: (validation) => validation.result,
    extrasOf: (validation) => ({
      correctedCitationRate: validation.correctedCitationRate,
      citationsProposed: validation.citationsProposed,
    }),
  });
  if (outcome.kind !== "completed") return outcome;
  await session.change((log) => {
    recordAnalyse(
      {
        log,
        snapshotId: input.inspection.snapshotId,
        modelCallId: outcome.modelCallId,
        context: validationContext,
      },
      outcome.validation,
    );
  });
  return { ...outcome, sent, validationContext };
}

// --- The expansion round and call 2 ------------------------------------------------------------

export type ExpansionOutcome =
  /** Call 1 asked for nothing, or its response failed the schema: no round, no call 2. */
  | { readonly kind: "no_round" }
  /** The round returned no item: recorded, and no call 2 is sent or skipped (§1.8). */
  | { readonly kind: "no_items"; readonly round: RecordOf<"expansion_round"> }
  /** Call 2 didn't fit and was recorded `stage_skipped` (§1.10). */
  | { readonly kind: "skipped"; readonly round: RecordOf<"expansion_round"> }
  | { readonly kind: "stopped"; readonly round: RecordOf<"expansion_round">; readonly stop: Stop }
  | (CallOutcome<AnalyseExpansionValidation> & { readonly round: RecordOf<"expansion_round"> });

export interface ExpansionStepInput {
  readonly callOne: Extract<AnalyseOutcome, { kind: "completed" }>;
  readonly inspection: Inspection;
  readonly destination: Uint8Array | undefined;
}

/** The requests of call 1's response, in response order, each accepted or with its rule. */
function roundRequests(validation: AnalyseValidation): ExpansionInputRequest[] {
  const { result } = validation;
  if (result.status !== "validated") return [];
  const rejected = new Map(
    result.rejected
      .filter((item) => item.collection === "expansionRequests")
      .map((item) => [item.index, item.rule]),
  );
  return result.response.expansionRequests.map((request, index) => {
    const rule = rejected.get(index);
    return rule === undefined ? { request } : { kind: request.kind, rejectedBy: rule };
  });
}

export async function runExpansionStep(
  session: HeldSession,
  deps: RunDeps,
  input: ExpansionStepInput,
): Promise<ExpansionOutcome> {
  const { callOne, inspection } = input;
  const requests = roundRequests(callOne.validation);
  if (requests.length === 0) return { kind: "no_round" };

  const config = activeConfig(session.records);
  const { snapshot } = callOne.sent.parts;
  const round: ExpansionRound = await runExpansion(
    {
      requests,
      files: snapshot.files,
      index: callOne.validationContext.expansion,
      membership: callOne.sent.membership,
      settings: config.expansion,
    },
    deps.fs,
  );
  const numbering: RecordNumbering = {
    call: "analyse_expansion",
    knownFactsSent: inspection.knownFactsSent,
  };
  // The round is recorded first, then its blocked files withhold what they hold, then the
  // records to be sent are scanned before they are numbered (§1.8, §3.2.6).
  const { record, withheldExcerpts } = await session.change((log) => {
    const recorded = recordExpansionRound(log, round, {
      snapshotId: inspection.snapshotId,
      modelCallId: callOne.modelCallId,
    });
    withholdBlockedFiles(log);
    return { record: recorded, ...withholdForCall(log, numbering) };
  });
  if (round.items.length === 0) return { kind: "no_items", round: record };

  const records = session.records;
  const numbered = numberRecords(records, numbering);
  const render = {
    records,
    destination: input.destination,
    withheldExcerpts,
    removedExcerpts: new Set<string>(),
  };
  const facts = renderKnownFactsAgain(numbered, render);
  const k = inspection.knownFactsSent.length;
  const base = withBlockedFiles(callOne.sent, round.blocked, {
    text: facts.text,
    bytes: facts.bytes,
    sent: facts.facts,
    leftOut: callOne.sent.parts.factsLeftOut + (k - facts.facts),
  });
  const parts = {
    results: renderCallOneResults(numbered, render),
    status: renderExpansionStatus(round),
    items: round.items.map((item) => item.rendered.text),
  };
  const prompt = deps.prompts.prompt("analyse_expansion");
  const model = callModel(config, "analyse_expansion");
  const fits = await checkContextCall(
    "analyse_expansion",
    base,
    (context) => modelRequest("analyse_expansion", prompt, model, expansionUser(context, parts)),
    tokenDeps(deps, records),
  );
  if (fits.state === "skipped") {
    await session.change((log) => {
      skipExpansion(log);
    });
    return { kind: "skipped", round: record };
  }
  if (fits.state !== "fits") return { kind: "stopped", round: record, stop: fits as Stop };

  const sent = fits.context;
  const expansionItems: SentItem[] = round.items.map((item) => ({
    id: item.id,
    path: item.path,
    hash: item.hash,
    included: item.rendered.included,
    totalLines: item.rendered.totalLines,
  }));
  const aliases = callAliasTable(
    "analyse_expansion",
    numbered,
    { records, destination: input.destination },
    [...sent.items.map((item) => item.id), ...expansionItems.map((item) => item.id)],
  );
  const items = [...contextItems(sent), ...expansionItems];
  const citable = await citableItems(items, sent.membership, deps.fs);
  const validationContext = analyseExpansionValidationContext(
    snapshot,
    aliases,
    citable,
    items,
    numbered,
    records,
  );
  // The table is built, so the gap of call 2's own check comes after it (§3.3.3).
  await recordGap(session, inspection.snapshotId, fits.gap);
  const outcome = await runCall(session, deps, {
    purpose: "analyse_expansion",
    request: fits.request,
    inputTokens: checkedTokens(sent),
    started: startedFields("analyse_expansion", deps, expansionManifest(sent, record.id), aliases),
    validate: (text) => validateAnalyseExpansion(text, validationContext),
    resultOf: (validation) => validation.result,
    extrasOf: (validation) => ({
      correctedCitationRate: validation.correctedCitationRate,
      citationsProposed: validation.citationsProposed,
    }),
  });
  if (outcome.kind === "completed")
    await session.change((log) => {
      recordAnalyseExpansion(
        {
          log,
          snapshotId: inspection.snapshotId,
          modelCallId: outcome.modelCallId,
          context: validationContext,
        },
        outcome.validation,
      );
    });
  return { ...outcome, round: record };
}
