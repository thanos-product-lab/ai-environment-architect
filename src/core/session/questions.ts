import type { AliasTable } from "../validation/aliases.js";
import type { QuestionsValidation } from "../validation/generate-questions.js";
import { recordFailedItems } from "./failed.js";
import { lineageOf, type SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// Recording `generate_questions` (IMPL §3.3.4, §4.4.1, DM §8.1). The ranked questions are
// appended in ranked order: those within the budget `open`, the rest `unreached` with the reason
// `budget`. So the later calls' `Q` aliases, numbered by first revision, follow the ranking.

export interface QuestionsRecording {
  readonly log: SessionLog;
  /** The call's lineage ID: `producedBy` of every question it creates. */
  readonly modelCallId: string;
  /** The call's alias table, as validation saw it. */
  readonly aliases: AliasTable;
}

export function recordGenerateQuestions(
  call: QuestionsRecording,
  validation: QuestionsValidation,
): RecordOf<"question">[] {
  const { result } = validation;
  if (result.status !== "validated") return [];
  const { log, modelCallId, aliases } = call;
  const target = (alias: string) => {
    const entry = aliases.entries.find((e) => e.alias === alias);
    if (entry?.target.kind !== "record") throw new Error(`${alias} names no record`);
    const record = log.get(entry.target.recordId);
    const id = record === undefined ? undefined : lineageOf(record);
    if (record === undefined || id === undefined) throw new Error(`${alias} names no lineage`);
    return { record, id };
  };
  const ranked = [
    ...validation.presented.map((q) => ({ q, unreached: false })),
    ...validation.unreached.map((q) => ({ q, unreached: true })),
  ];
  const questions = ranked.map(({ q, unreached }) => {
    const findingIds: string[] = [];
    const gapIds: string[] = [];
    const conflictIds: string[] = [];
    // `resolves` is a set (DUP-003, DM §8.1): a repeated alias is stored once, at its first place.
    for (const alias of new Set(q.value.resolves)) {
      const { record, id } = target(alias);
      if (record.type === "conflict") conflictIds.push(id);
      else if (record.type === "finding" && record.kind === "gap") gapIds.push(id);
      else findingIds.push(id);
    }
    return log.start({
      type: "question",
      producedBy: modelCallId,
      prompt: q.value.prompt,
      reason: q.value.reason,
      findingIds,
      conflictIds,
      gapIds,
      options: q.value.options.map((option) => ({ label: option.label })),
      scope:
        q.value.scope.kind === "repository"
          ? { kind: "repository" }
          : { kind: "paths", paths: [...q.value.scope.paths] },
      status: unreached ? "unreached" : "open",
      ...(unreached ? { unreachedReason: validation.unreachedReason } : {}),
    }) as RecordOf<"question">;
  });
  recordFailedItems(log, modelCallId, result, { questions: { type: "question" } });
  return questions;
}
