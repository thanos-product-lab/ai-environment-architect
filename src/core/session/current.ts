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
// Records with status `failed_validation`, and `failed_item` records, are never current.

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
  /** By `recommendationId`. */
  readonly recommendations: ReadonlyMap<string, Revised<"recommendation_revision">>;
  /** Those of the active snapshot. */
  readonly contentNotices: readonly RecordOf<"content_notice">[];
}

/** `records` must be in `seq` order, as `SessionLog.records` and a loaded file give them. */
export function currentState(records: readonly SessionRecord[]): CurrentState {
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

  const decisions = new Map<string, Decision>();
  const corrections = new Map<string, Decision>();
  for (const decision of ofType("decision").filter(live)) {
    decisions.set(decision.id, decision);
    // Any current correction makes the finding corrected; the latest is the one shown.
    if (decision.findingId !== undefined) corrections.set(decision.findingId, decision);
  }

  const findings = new Map<string, Revised<"finding">>();
  const correctedFindings = new Map<string, CorrectedFinding>();
  for (const record of ofType("finding").filter(live)) {
    const finding = record as Revised<"finding">;
    if (finding.snapshotId !== activeSnapshotId) continue;
    const decision = corrections.get(finding.findingId);
    if (decision === undefined) findings.set(finding.findingId, finding);
    else correctedFindings.set(finding.findingId, { finding, decision });
  }

  const conflicts = new Map<string, Revised<"conflict">>();
  for (const record of ofType("conflict").filter(live)) {
    const conflict = record as Revised<"conflict">;
    if (conflict.snapshotId !== activeSnapshotId) continue;
    if (conflict.findingIds.every((id) => findings.has(id)))
      conflicts.set(conflict.conflictId, conflict);
  }

  const questions = new Map<string, Revised<"question">>();
  for (const record of ofType("question").filter(live)) {
    const question = record as Revised<"question">;
    const resolvesCurrent =
      question.findingIds.some((id) => findings.has(id)) ||
      question.gapIds.some((id) => findings.has(id)) ||
      question.conflictIds.some((id) => conflicts.has(id));
    if (resolvesCurrent) questions.set(question.questionId, question);
  }

  const recommendations = new Map<string, Revised<"recommendation_revision">>();
  // Only the failed form exists until M5, so none is current yet; the rule is already general.
  for (const record of ofType("recommendation_revision").filter(live))
    recommendations.set(
      lineageOf(record) as string,
      record as unknown as Revised<"recommendation_revision">,
    );

  return {
    activeSnapshotId,
    findings,
    correctedFindings,
    conflicts,
    questions,
    decisions,
    recommendations,
    contentNotices: ofType("content_notice").filter((n) => n.snapshotId === activeSnapshotId),
  };
}
