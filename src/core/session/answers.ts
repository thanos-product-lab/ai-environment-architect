import type { Revised, SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// Answering a question (DM §8, IMPL §4.4.1 "question", §3.3.6).
//
// The decision is appended first, then the question's `answered` revision, in one change, so
// one save writes both. Regeneration judges whether a decision unblocks a held-back entry by the
// records before the decision, where the question is still open or skipped (§3.3.6).

type Decision = RecordOf<"decision">;

export interface AnswerRequest {
  readonly questionId: string;
  readonly statement: string;
  readonly scope: Decision["scope"];
  readonly exceptions: readonly string[];
  readonly actor: string;
  readonly decidedAt: string;
}

export interface Answer {
  readonly decision: Decision;
  readonly question: Revised<"question">;
}

/**
 * Appends the decision that answers an open or skipped question, then the question's `answered`
 * revision. Call it inside one `HeldSession.change`. Answering a question in any other state, or
 * one that doesn't exist, is a bug in the caller.
 */
export function answerQuestion(log: SessionLog, request: AnswerRequest): Answer {
  const current = log
    .revisions("question", request.questionId)
    .filter((r) => r.status !== "failed_validation" && !log.isSuperseded(r.id))
    .at(-1);
  if (current === undefined) throw new Error(`no current question ${request.questionId}`);
  if (current.status !== "open" && current.status !== "skipped")
    throw new Error(`${request.questionId} is ${current.status}, so it can't be answered`);
  const decision = log.append({
    type: "decision",
    statement: request.statement,
    scope: request.scope,
    exceptions: request.exceptions,
    questionId: request.questionId,
    origin: "answered_question",
    actor: request.actor,
    decidedAt: request.decidedAt,
  });
  const question = log.revise("question", request.questionId, { status: "answered" });
  return { decision, question };
}

export interface CorrectionRequest {
  /** The decision being corrected, by record ID. */
  readonly supersedes: string;
  readonly statement: string;
  readonly scope: Decision["scope"];
  readonly exceptions: readonly string[];
  readonly actor: string;
  readonly decidedAt: string;
}

/**
 * Appends a correction of a decision (DM §8.2): a new decision that names the one it supersedes,
 * and answers what it answered, with its question, conflict, finding and origin. Decisions have
 * no lineage, so the new one is a record of its own (IMPL §4.4.1). A withheld decision may be
 * corrected, as the developer is asked to (IMPL §2.12); a decision already superseded may not,
 * nor anything that isn't a decision. Call it inside one `HeldSession.change`.
 */
export function correctDecision(log: SessionLog, request: CorrectionRequest): Decision {
  const old = log.get(request.supersedes);
  if (old === undefined) throw new Error(`no decision ${request.supersedes}`);
  if (old.type !== "decision") throw new Error(`${request.supersedes} isn't a decision`);
  if (log.isSuperseded(old.id)) throw new Error(`${old.id} is already superseded`);
  return log.append({
    type: "decision",
    statement: request.statement,
    scope: request.scope,
    exceptions: request.exceptions,
    ...(old.questionId === undefined ? {} : { questionId: old.questionId }),
    ...(old.conflictId === undefined ? {} : { conflictId: old.conflictId }),
    ...(old.findingId === undefined ? {} : { findingId: old.findingId }),
    origin: old.origin,
    actor: request.actor,
    decidedAt: request.decidedAt,
    supersedes: [old.id],
  });
}
