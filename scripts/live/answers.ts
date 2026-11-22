import { z } from "zod";
import { currentState } from "../../src/core/session/current.js";
import { type SessionRecord, scope } from "../../src/core/session/records.js";

// The answers file (`answers.json` in the run directory): `analyse` writes the open questions
// with empty answers; the developer fills in some, and `correction` before `regenerate`.

const answer = z.strictObject({
  statement: z.string().min(1),
  scope,
  exceptions: z.array(z.string()),
});

export type AnswerFields = z.infer<typeof answer>;

const answersFile = z.strictObject({
  runId: z.string(),
  /** Leave `answer` null to leave a question unanswered. */
  questions: z.array(
    z.strictObject({
      questionId: z.string(),
      prompt: z.string(),
      reason: z.string(),
      options: z.array(z.string()),
      answer: answer.nullable(),
    }),
  ),
  /** Before `regenerate`: a new answer to a question answered in `recommend`. */
  correction: z.strictObject({ questionId: z.string(), ...answer.shape }).nullable(),
});

export type AnswersFile = z.infer<typeof answersFile>;

/** The current open questions, in the order recorded, each with an empty answer. */
export function answersTemplate(runId: string, records: readonly SessionRecord[]): AnswersFile {
  const questions = [...currentState(records).questions.values()]
    .filter((q) => q.status === "open")
    .map((q) => ({
      questionId: q.questionId,
      prompt: q.prompt,
      reason: q.reason,
      options: q.options.map((o) => o.label),
      answer: null,
    }));
  return { runId, questions, correction: null };
}

export function parseAnswers(text: string): AnswersFile {
  const parsed = answersFile.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      `answers.json: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

export function serialiseAnswers(file: AnswersFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
