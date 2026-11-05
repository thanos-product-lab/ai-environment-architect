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
