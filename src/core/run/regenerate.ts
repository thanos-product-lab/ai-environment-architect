import { type ChangeLines, type NumberedRecords, withholdForCall } from "../requests/records.js";
import type { SessionRecord } from "../session/records.js";
import {
  affectedRecommendations,
  type ChangeSummary,
  changeSummary,
  invalidateChangedTargets,
  planRegeneration,
  type RegenerationTrigger,
  recordRegenerate,
  regenerationInput,
  scanAffectedRecommendations,
} from "../session/regeneration.js";
import type { HeldSession } from "../session/store.js";
import { type RegenerateValidation, validateRegenerate } from "../validation/regenerate.js";
import type { RunDeps, RunOptions } from "./analysis.js";
import { type RecordCallOutcome, type RecordCallRun, runRecordCall } from "./clarify.js";
import { recommendValidationContext } from "./contexts.js";

// Running `regenerate_recommendations` (IMPL §1.2, §3.3.6, §1.7). Before any call, code
// invalidates recommendations whose target changed, and scans what the affected set would
// resend: a match is invalidated as `secret_match` and leaves the set before it is split. Then
// each part of at most 30 is sent and recorded in turn, with the change summary of §3.2.6.

export type RegenerationOutcome =
  /** No call is made (§3.3.6): nothing is affected, and no held-back entry is unblocked. */
  | { readonly kind: "no_call" }
  /** Each part's outcome, in order; a part that doesn't complete ends the run. */
  | { readonly kind: "ran"; readonly calls: readonly RecordCallOutcome<RegenerateValidation>[] };

/** The change summary's lines (§3.2.6) for the records this call numbered. */
export function changeLines(
  numbered: NumberedRecords,
  summary: ChangeSummary,
  records: readonly SessionRecord[],
): ChangeLines {
  const byId = new Map(records.map((r) => [r.id, r]));
  const decisions = summary.changedDecisionIds
    .flatMap((id) => {
      const alias = numbered.aliasOf(id);
      const decision = byId.get(id);
      return alias === undefined || decision?.type !== "decision"
        ? []
        : [{ alias, replaces: decision.supersedes !== undefined }];
    })
    .sort((a, b) => Number(a.alias.slice(2)) - Number(b.alias.slice(2)));
  const stale = new Set<string>();
  for (const { record } of numbered.recommendations)
    for (const entry of record.support)
      if (entry.kind === "finding" && numbered.aliasOf(entry.findingId) === undefined)
        stale.add(entry.findingId);
  return { decisions, staleFindings: stale.size, targetChanged: summary.targetChanged.length };
}

export async function runRegeneration(
  session: HeldSession,
  deps: RunDeps,
  run: RecordCallRun,
  trigger: RegenerationTrigger,
): Promise<RegenerationOutcome> {
  // In one save: targets first, then the records' scan, so a record it withholds makes what
  // cites it affected (§3.3.6), then the affected set's own scan, before the set is split.
  await session.change((log) => {
    invalidateChangedTargets(log, run.destination);
    withholdForCall(log, {
      call: "regenerate_recommendations",
      knownFactsSent: run.inspection.knownFactsSent,
      recommendations: [],
    });
    const decisions = trigger.kind === "decision" ? [trigger.decisionId] : [];
    scanAffectedRecommendations(log, affectedRecommendations(log.records, decisions));
  });
  const plan = planRegeneration(session.records, trigger);
  if (plan.calls.length === 0) return { kind: "no_call" };
  const affectedSet = plan.calls.flat();

  const calls: RecordCallOutcome<RegenerateValidation>[] = [];
  for (const part of plan.calls) {
    const outcome = await runRegenerationPart(session, deps, run, trigger, part, affectedSet);
    calls.push(outcome);
    // The later parts are left as they are: still affected, so the next run sends them again.
    if (outcome.kind !== "completed") break;
  }
  return { kind: "ran", calls };
}

/**
 * One part of a regeneration (§3.3.6): its recommendations, sent and recorded. `affectedSet` is
 * the whole set, split or not, which DUP-004's unaffected recommendations leave out. A resend
 * after a raised output limit runs the truncated part again with `options`.
 */
export async function runRegenerationPart(
  session: HeldSession,
  deps: RunDeps,
  run: RecordCallRun,
  trigger: RegenerationTrigger,
  part: readonly string[],
  affectedSet: readonly string[],
  options?: RunOptions,
): Promise<RecordCallOutcome<RegenerateValidation>> {
  const { outcome, prepared } = await runRecordCall<RegenerateValidation>(
    session,
    deps,
    "regenerate_recommendations",
    run,
    ({ numbered, aliases, records }) => {
      const { affected, unaffected } = regenerationInput(
        records,
        run.destination,
        aliases,
        affectedSet,
      );
      const context = {
        ...recommendValidationContext(
          run.sent.parts.snapshot,
          aliases,
          numbered,
          records,
          run.destination,
        ),
        affected,
        unaffected,
      };
      return {
        validate: (text) => validateRegenerate(text, context),
        resultOf: (validation) => validation.result,
      };
    },
    {
      recommendations: part,
      changes: (numbered, records) =>
        changeLines(numbered, changeSummary(records, trigger), records),
    },
    options,
  );
  if (outcome.kind === "completed" && prepared !== undefined)
    await session.change((log) => {
      recordRegenerate(
        { log, modelCallId: outcome.modelCallId, aliases: prepared.aliases },
        outcome.validation,
      );
    });
  return outcome;
}
