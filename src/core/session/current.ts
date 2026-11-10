import { comparePaths } from "../paths.js";
import { activeDestination, type ExclusionReason, exclusionBetween } from "./exclusion.js";
import { isFailed, lineageOf, type Revised } from "./log.js";
import { CURRENT_STATUSES, type RecordOf, type SessionRecord } from "./records.js";

// Derived current state (IMPL §4.4.1 "Current", §4.4.2, §4.5). Pure functions over the records:
// nothing here is stored, so it can't drift from the records.
//
// A revision is current when no record supersedes it and its status is a current one. On top of
// that, following §4.4.2 and §4.5:
// - a finding must be of the active snapshot and not corrected by a current decision;
// - a conflict must be of the active snapshot, with every member finding current;
// - a question needs at least one finding, gap or conflict it resolves to be current.
// Records with status `failed_validation`, and `failed_item` records, are never current, and nor
// is any revision of an item a `secret_withheld` record names (§4.4.2), though it stays in the
// developer's own view.

type Decision = RecordOf<"decision">;

/** A finding that would be current, but that a current `developer_correction` names (§4.5). */
export interface CorrectedFinding {
  readonly finding: Revised<"finding">;
  readonly decision: Decision;
}

export interface CurrentState {
  /** The latest snapshot, if any. */
  readonly activeSnapshotId: string | undefined;
  /**
   * By `findingId`, in the log order of each current revision, not of the lineage's start.
   * Every map below is ordered the same way. Gaps and absence claims included.
   */
  readonly findings: ReadonlyMap<string, Revised<"finding">>;
  /** By `findingId`: shown as "corrected by you", never aliased, sent or used as support. */
  readonly correctedFindings: ReadonlyMap<string, CorrectedFinding>;
  /** By `conflictId`. */
  readonly conflicts: ReadonlyMap<string, Revised<"conflict">>;
  /** By `questionId`. */
  readonly questions: ReadonlyMap<string, Revised<"question">>;
  /** By record ID: decisions have no lineage (§4.4.1). */
  readonly decisions: ReadonlyMap<string, Decision>;
  /**
   * By the item's lineage ID, or a decision's record ID: items whose text matched the secret
   * scan (§1.7). Every revision is left out of the sets above, never aliased or sent; the
   * developer's own view still shows them.
   */
  readonly withheld: ReadonlyMap<string, RecordOf<"secret_withheld">>;
  /** By `recommendationId`. */
  readonly recommendations: ReadonlyMap<string, Revised<"recommendation_revision">>;
  /** Those of the active snapshot. */
  readonly contentNotices: readonly RecordOf<"content_notice">[];
  /**
   * Held-back entries of the latest completed `recommend` call and every later completed
   * regeneration, while a blocker still blocks; one per topic and `blockedBy` set, the earliest.
   */
  readonly heldBack: readonly RecordOf<"held_back">[];
  /** The latest completed `recommend` call's, while no recommendation has a current revision. */
  readonly noChangeReason: RecordOf<"no_change_reason"> | undefined;
  /**
   * By `recommendationId`: the latest selection, while the revision it names is the current one
   * (DM §9.2). A recommendation missing here is pending, and nothing is written to make it so.
   */
  readonly selections: ReadonlyMap<string, RecordOf<"selection">>;
  /**
   * Pairs of current accepted selections that can't both be accepted (DM §9.1–§9.2), as a
   * refresh's re-anchoring or a hand-edited file can leave them, in recommendation order.
   * Final review is blocked while there is one. Derived only when the destination is given.
   */
  readonly clashes: readonly Clash[] | undefined;
  /**
   * The latest artifact revision, while its snapshot is the active one, its selected revisions
   * are exactly those of the current accepted selections and its decisions are all current.
   * Otherwise none, and the proposal is out of date (DM §12).
   */
  readonly activeArtifact: RecordOf<"artifact_revision"> | undefined;
  /**
   * The latest review of the active artifact revision, if it approves the revision's exact
   * `proposedHash` (DM §10). Freshness (DM §11.1) is checked at apply, not here.
   */
  readonly usableApproval: RecordOf<"review"> | undefined;
}

/** Two accepted recommendations, in recommendation order, and why they can't both be. */
export type Clash = { readonly recommendationIds: readonly [string, string] } & ExclusionReason;

export interface CurrentStateOptions {
  /**
   * The bytes the caller read for the active snapshot's destination, checked against its hash,
   * or undefined when it isn't present. Given, `clashes` is derived; heading levels need them.
   */
  readonly destination: Uint8Array | undefined;
}

/** `records` must be in `seq` order, as `SessionLog.records` and a loaded file give them. */
export function currentState(
  records: readonly SessionRecord[],
  options?: CurrentStateOptions,
): CurrentState {
  const superseded = new Set<string>();
  for (const record of records)
    for (const id of (record as { supersedes?: readonly string[] }).supersedes ?? [])
      superseded.add(id);

  /** Not failed, not superseded, and a status its type allows to be current. */
  const live = (record: SessionRecord): boolean => {
    if (isFailed(record) || superseded.has(record.id)) return false;
    const statuses = CURRENT_STATUSES[record.type];
    const status = (record as { status?: string }).status;
    if (statuses === undefined) return true;
    return status !== undefined && statuses.has(status);
  };
  const ofType = <T extends SessionRecord["type"]>(type: T) =>
    records.filter((record): record is RecordOf<T> => record.type === type);

  const activeSnapshotId = ofType("snapshot").at(-1)?.id;

  const withheld = new Map<string, RecordOf<"secret_withheld">>();
  for (const record of ofType("secret_withheld"))
    if (!withheld.has(record.itemId)) withheld.set(record.itemId, record);
  /** Named by a `secret_withheld`, by lineage ID or, for a decision, record ID. */
  const isWithheld = (record: SessionRecord): boolean =>
    withheld.has(lineageOf(record) ?? record.id);

  const decisions = new Map<string, Decision>();
  const corrections = new Map<string, Decision>();
  for (const decision of ofType("decision").filter(live)) {
    // A withheld correction still corrects its finding: the finding is then never sent either.
    if (decision.findingId !== undefined) corrections.set(decision.findingId, decision);
    if (!isWithheld(decision)) decisions.set(decision.id, decision);
  }

  const findings = new Map<string, Revised<"finding">>();
  const correctedFindings = new Map<string, CorrectedFinding>();
  for (const record of ofType("finding").filter(live)) {
    const finding = record as Revised<"finding">;
    if (finding.snapshotId !== activeSnapshotId) continue;
    const decision = corrections.get(finding.findingId);
    // Still shown as corrected when withheld too: both are the developer's own view.
    if (decision !== undefined) correctedFindings.set(finding.findingId, { finding, decision });
    else if (!isWithheld(finding)) findings.set(finding.findingId, finding);
  }

  const conflicts = new Map<string, Revised<"conflict">>();
  for (const record of ofType("conflict").filter(live)) {
    const conflict = record as Revised<"conflict">;
    if (conflict.snapshotId !== activeSnapshotId || isWithheld(conflict)) continue;
    if (conflict.findingIds.every((id) => findings.has(id)))
      conflicts.set(conflict.conflictId, conflict);
  }

  const questions = new Map<string, Revised<"question">>();
  for (const record of ofType("question").filter(live)) {
    const question = record as Revised<"question">;
    if (isWithheld(question)) continue;
    const resolvesCurrent =
      question.findingIds.some((id) => findings.has(id)) ||
      question.gapIds.some((id) => findings.has(id)) ||
      question.conflictIds.some((id) => conflicts.has(id));
    if (resolvesCurrent) questions.set(question.questionId, question);
  }

  const recommendations = new Map<string, Revised<"recommendation_revision">>();
  for (const record of ofType("recommendation_revision").filter(live))
    recommendations.set(
      lineageOf(record) as string,
      record as unknown as Revised<"recommendation_revision">,
    );

  // Completed calls by lineage, in the order they started.
  const completed = new Map<string, RecordOf<"model_call">["purpose"]>();
  const ended = new Set(
    ofType("model_call")
      .filter((call) => call.state === "completed")
      .map((call) => call.modelCallId),
  );
  for (const call of ofType("model_call"))
    if (call.revision === 1 && ended.has(call.modelCallId))
      completed.set(call.modelCallId, call.purpose);
  const calls = [...completed.entries()];
  const latestRecommend = calls.findLastIndex(([, purpose]) => purpose === "recommend");
  const sources = new Set(
    latestRecommend < 0
      ? []
      : calls
          .slice(latestRecommend)
          .filter(([, purpose], i) => i === 0 || purpose === "regenerate_recommendations")
          .map(([id]) => id),
  );

  const stillBlocks = (id: string): boolean => {
    const question = questions.get(id);
    if (question !== undefined)
      return question.status === "skipped" || question.status === "unreached";
    return conflicts.get(id)?.status === "unresolved";
  };
  const seen = new Set<string>();
  const heldBack = ofType("held_back").filter((entry) => {
    if (!sources.has(entry.modelCallId) || !entry.blockedBy.some(stillBlocks)) return false;
    const identity = JSON.stringify([
      entry.topic,
      [...new Set(entry.blockedBy)].sort(comparePaths),
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  const recommendCall = calls[latestRecommend]?.[0];
  const noChangeReason =
    recommendations.size > 0 || recommendCall === undefined
      ? undefined
      : ofType("no_change_reason").find((r) => r.modelCallId === recommendCall);

  const latestSelections = new Map<string, RecordOf<"selection">>();
  for (const selection of ofType("selection"))
    latestSelections.set(selection.recommendationId, selection);
  const selections = new Map<string, RecordOf<"selection">>();
  for (const [id, selection] of latestSelections)
    if (recommendations.get(id)?.id === selection.revisionId) selections.set(id, selection);

  let clashes: Clash[] | undefined;
  if (options !== undefined) {
    const destination = activeDestination(records, options.destination);
    const accepted = [...recommendations.values()].filter(
      (r) => selections.get(r.recommendationId)?.state === "accepted",
    );
    clashes = [];
    for (const [i, a] of accepted.entries())
      for (const b of accepted.slice(i + 1)) {
        const reason = exclusionBetween(a, b, destination);
        if (reason !== undefined)
          clashes.push({ recommendationIds: [a.recommendationId, b.recommendationId], ...reason });
      }
  }

  const acceptedRevisionIds = new Set(
    [...selections.values()].filter((s) => s.state === "accepted").map((s) => s.revisionId),
  );
  const latestArtifact = ofType("artifact_revision").at(-1);
  const activeArtifact =
    latestArtifact !== undefined &&
    latestArtifact.snapshotId === activeSnapshotId &&
    sameSet(latestArtifact.selectedRevisionIds, acceptedRevisionIds) &&
    latestArtifact.decisionIds.every((id) => decisions.has(id))
      ? latestArtifact
      : undefined;
  const latestReview =
    activeArtifact === undefined
      ? undefined
      : ofType("review")
          .filter((r) => r.artifactRevisionId === activeArtifact.id)
          .at(-1);
  const usableApproval =
    latestReview?.outcome === "approved" &&
    latestReview.contentHash === activeArtifact?.proposedHash
      ? latestReview
      : undefined;

  return {
    activeSnapshotId,
    findings,
    correctedFindings,
    conflicts,
    questions,
    decisions,
    withheld,
    recommendations,
    contentNotices: ofType("content_notice").filter((n) => n.snapshotId === activeSnapshotId),
    heldBack,
    noChangeReason,
    selections,
    clashes,
    activeArtifact,
    usableApproval,
  };
}

/** Set equality, so a repeated ID can't stand in for a missing one. */
function sameSet(ids: readonly string[], set: ReadonlySet<string>): boolean {
  const own = new Set(ids);
  return own.size === set.size && [...own].every((id) => set.has(id));
}

// --- Stage, status, outcome and completeness (§4.4.2) ----------------------------------------

type SessionState = RecordOf<"session_state">;

export interface SessionProgress {
  readonly stage: SessionState["stage"];
  readonly status: SessionState["status"];
  /** Unset while the session is in progress (DM §5). */
  readonly outcome?: NonNullable<SessionState["outcome"]>;
}

/** The latest `session_state`, or undefined before the first. */
export function sessionProgress(records: readonly SessionRecord[]): SessionProgress | undefined {
  const latest = records.filter((r): r is SessionState => r.type === "session_state").at(-1);
  if (latest === undefined) return undefined;
  const { stage, status, outcome } = latest;
  return outcome === undefined ? { stage, status } : { stage, status, outcome };
}

export type IncompleteReason = "budget_reached" | "stage_skipped" | "questions_unreached";

/** `incomplete` lists every reason that holds, in this order: budget, skipped stage, unreached questions. */
export type Completeness =
  | { readonly state: "complete" }
  | { readonly state: "incomplete"; readonly reasons: readonly IncompleteReason[] };

/**
 * Separate from the outcome: an `applied` session can be incomplete. Derived, never stored, and
 * computable at any point.
 */
export function completeness(records: readonly SessionRecord[]): Completeness {
  const states = records.filter((r): r is SessionState => r.type === "session_state");
  const reasons: IncompleteReason[] = [];

  // The generation budget stopped a call that is still unsent: no call with the purpose it
  // names started after the last state that says so.
  const stopped = states.filter((s) => s.reason === "budget_reached").at(-1);
  if (
    stopped !== undefined &&
    !records.some(
      (r) =>
        r.type === "model_call" &&
        r.state === "started" &&
        r.seq > stopped.seq &&
        r.purpose === stopped.unsentPurpose,
    )
  )
    reasons.push("budget_reached");

  if (states.some((s) => s.reason === "stage_skipped")) reasons.push("stage_skipped");

  const { questions } = currentState(records);
  if ([...questions.values()].some((q) => q.status === "unreached"))
    reasons.push("questions_unreached");

  return reasons.length === 0 ? { state: "complete" } : { state: "incomplete", reasons };
}
