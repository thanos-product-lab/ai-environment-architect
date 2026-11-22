import {
  type ContextSelectionSettings,
  type ReadyContext,
  selectContext,
  settingsHash,
} from "../../src/core/context/select.js";
import type { Effort } from "../../src/core/request.js";
import {
  type RunDeps,
  recordInspection,
  runAnalyse,
  runExpansionStep,
} from "../../src/core/run/analysis.js";
import {
  type RecordCallRun,
  runGenerateQuestions,
  runRecommend,
} from "../../src/core/run/clarify.js";
import { runRegeneration } from "../../src/core/run/regenerate.js";
import { answerQuestion, correctDecision } from "../../src/core/session/answers.js";
import { proposeArtifact } from "../../src/core/session/artifacts.js";
import { currentState } from "../../src/core/session/current.js";
import { type LogPorts, SessionLog } from "../../src/core/session/log.js";
import {
  type RecordOf,
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionRecord,
} from "../../src/core/session/records.js";
import { select } from "../../src/core/session/selections.js";
import { HeldSession, openSession, type SessionWriter } from "../../src/core/session/store.js";
import {
  captureSnapshot,
  type Snapshot,
  type SnapshotDeps,
} from "../../src/core/snapshot/snapshot.js";
import type { CallPurpose } from "../../src/core/validation/aliases.js";
import { type AnswersFile, answersTemplate } from "./answers.js";
import { rebuildRun } from "./rebuild.js";
import { type DevelopmentRepository, snapshotProblem } from "./targets.js";

// The three phases of a live run (M6 live-run protocol), each its own process, through the core
// API. `analyse` runs calls 1–3 and returns the answers file to fill in; `recommend` records the
// answers and runs call 4; `regenerate` applies a correction and runs call 5. The last two check
// that the accepted recommendations assemble, on a copy of the log that is never saved.
//
// Nothing here can write to the repository: it is read through `RepositoryFs` and `GitReader`,
// which have no write operations. Selection, review and apply are never recorded.

const ACTOR = "developer";

export interface PhaseDeps {
  /** The session directory, held under the lock. */
  readonly writer: SessionWriter;
  readonly repository: DevelopmentRepository & { readonly root: string };
  /** The repository, read-only: its file system and git. */
  readonly snapshot: Omit<SnapshotDeps, "clock" | "ids">;
  /** The clock and IDs of the session's records. */
  readonly ports: LogPorts;
  readonly run: RunDeps;
  readonly productVersion: string;
}

export interface AnalyseSettings {
  readonly selection: ContextSelectionSettings;
  readonly model: string;
  readonly effort: Effort;
  readonly maxCostUsd: number;
  readonly maxExpansionRequests: number;
  readonly expansionBytes: number;
  readonly expansionEntryBytes: number;
  readonly questionBudget: number;
}

/** What one step of a phase ended as: a call's outcome kind, or the round's. */
export interface Step {
  readonly step: CallPurpose | "expansion_round";
  readonly kind: string;
}

export interface Assembly {
  /** Current recommendations, by whether accepting them was refused. */
  readonly accepted: number;
  readonly refused: readonly string[];
  /** `proposeArtifact`'s outcome, with the content's hash and size when it assembled. */
  readonly outcome: string;
  readonly contentHash?: string;
  readonly bytes?: number;
}

export type PhaseResult =
  | {
      readonly ok: true;
      readonly steps: readonly Step[];
      readonly assembly?: Assembly;
      /** `analyse` only. */
      readonly answers?: AnswersFile;
    }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): PhaseResult => ({ ok: false, reason });

function calls(records: readonly SessionRecord[], purpose: CallPurpose) {
  return records.filter(
    (r): r is RecordOf<"model_call"> => r.type === "model_call" && r.purpose === purpose,
  );
}

const completed = (records: readonly SessionRecord[], purpose: CallPurpose) =>
  calls(records, purpose).some((c) => c.state === "completed");

// --- analyse ---------------------------------------------------------------------------------

/** The snapshot and context `analyse` sends, captured and checked before the session exists. */
export interface Prepared {
  readonly snapshot: Snapshot;
  readonly context: ReadyContext;
}

/**
 * Captures the repository and selects the context, refusing a snapshot that isn't clean at the
 * pin. The script runs it before it takes the lock, so a refusal creates no session directory.
 */
export async function prepareAnalyse(
  deps: Pick<PhaseDeps, "snapshot" | "ports" | "repository">,
  settings: AnalyseSettings,
): Promise<{ ok: true; prepared: Prepared } | { ok: false; reason: string }> {
  const snapshot = await captureSnapshot(
    { ...deps.snapshot, ...deps.ports },
    settings.selection.snapshot,
  );
  const problem = snapshotProblem(snapshot, deps.repository.commit);
  if (problem !== undefined) return { ok: false, reason: problem };
  const context = await selectContext(snapshot, settings.selection, deps.snapshot.fs);
  if (context.state !== "ready")
    return { ok: false, reason: `the context can't be sent: ${context.state}` };
  return { ok: true, prepared: { snapshot, context } };
}

export async function analysePhase(
  deps: PhaseDeps,
  settings: AnalyseSettings,
  { snapshot, context }: Prepared,
): Promise<PhaseResult> {
  const log = new SessionLog(deps.ports);
  log.start({
    type: "session_state",
    productVersion: deps.productVersion,
    stage: "inspect",
    status: "running",
  });
  log.start({
    type: "generation_config",
    settings: settings.selection,
    settingsHash: settingsHash(settings.selection),
    requestedModel: settings.model,
    effort: settings.effort,
    budget: { maxCostUsd: settings.maxCostUsd },
    expansion: {
      maxExpansionRequests: settings.maxExpansionRequests,
      expansionBytes: settings.expansionBytes,
      expansionEntryBytes: settings.expansionEntryBytes,
    },
    questionBudget: settings.questionBudget,
    retainModelInputs: true,
  });
  const header: Omit<SessionFile, "records"> = {
    format: SESSION_FORMAT,
    schemaVersion: SESSION_SCHEMA_VERSION,
    writtenBy: deps.productVersion,
    session: {
      id: deps.writer.sessionId,
      createdAt: deps.ports.clock.now().toISOString(),
      productVersion: deps.productVersion,
      adapter: "claude-code",
      outputScope: ["root CLAUDE.md"],
      repository: { name: deps.repository.name, root: deps.repository.root },
      targetPath: "CLAUDE.md",
    },
  };
  const session = new HeldSession(deps.writer, header, log);
  await session.save();

  const steps: Step[] = [];
  const destination =
    snapshot.destination.state === "present" ? snapshot.destination.bytes : undefined;
  const inspection = await recordInspection(session, context);
  const one = await runAnalyse(session, deps.run, { context, inspection, destination });
  steps.push({ step: "analyse", kind: one.kind });
  if (one.kind === "completed") {
    const two = await runExpansionStep(session, deps.run, {
      callOne: one,
      inspection,
      destination,
    });
    steps.push({ step: "expansion_round", kind: two.kind });
    // A call 2 that failed, or that the budget or token check stopped, ends the phase.
    if (["no_round", "no_items", "skipped", "completed"].includes(two.kind)) {
      const three = await runGenerateQuestions(session, deps.run, {
        sent: one.sent,
        inspection,
        destination,
      });
      steps.push({ step: "generate_questions", kind: three.kind });
    }
  }
  return { ok: true, steps, answers: answersTemplate(deps.writer.sessionId, session.records) };
}

// --- recommend and regenerate ----------------------------------------------------------------

async function reopen(
  deps: PhaseDeps,
): Promise<{ ok: true; session: HeldSession; run: RecordCallRun } | { ok: false; reason: string }> {
  const loaded = await openSession(deps.writer);
  if (!loaded.ok)
    return {
      ok: false,
      reason:
        "missing" in loaded
          ? "the run has no session file"
          : `the session doesn't load: ${loaded.failure.detail}`,
    };
  const { records, ...header } = loaded.file;
  if (header.session.repository.name !== deps.repository.name)
    return { ok: false, reason: `the run is of ${header.session.repository.name}` };
  const rebuilt = await rebuildRun(records, deps.snapshot);
  if (!rebuilt.ok) return rebuilt;
  const session = new HeldSession(deps.writer, header, new SessionLog(deps.ports, records));
  return { ok: true, session, run: rebuilt.run };
}

export async function recommendPhase(deps: PhaseDeps, answers: AnswersFile): Promise<PhaseResult> {
  const opened = await reopen(deps);
  if (!opened.ok) return refuse(opened.reason);
  const { session, run } = opened;
  if (!completed(session.records, "generate_questions")) return refuse("call 3 hasn't completed");
  if (calls(session.records, "recommend").length > 0) return refuse("call 4 has already run");

  const open = currentState(session.records).questions;
  const filled = answers.questions.flatMap((q) =>
    q.answer === null ? [] : [{ ...q.answer, questionId: q.questionId }],
  );
  for (const answer of filled) {
    const question = open.get(answer.questionId);
    if (question === undefined || (question.status !== "open" && question.status !== "skipped"))
      return refuse(`${answer.questionId} isn't an open question of this run`);
  }
  if (filled.length > 0)
    await session.change((log) => {
      for (const answer of filled)
        answerQuestion(log, {
          ...answer,
          actor: ACTOR,
          decidedAt: deps.ports.clock.now().toISOString(),
        });
    });

  const four = await runRecommend(session, deps.run, run);
  const steps: Step[] = [{ step: "recommend", kind: four.kind }];
  return { ok: true, steps, assembly: assemble(session.records, run.destination, deps.ports) };
}

export async function regeneratePhase(deps: PhaseDeps, answers: AnswersFile): Promise<PhaseResult> {
  const correction = answers.correction;
  if (correction === null) return refuse("answers.json has no correction");
  const opened = await reopen(deps);
  if (!opened.ok) return refuse(opened.reason);
  const { session, run } = opened;
  if (!completed(session.records, "recommend")) return refuse("call 4 hasn't completed");
  if (calls(session.records, "regenerate_recommendations").length > 0)
    return refuse("call 5 has already run");

  const decision = [...currentState(session.records).decisions.values()].find(
    (d) => d.questionId === correction.questionId,
  );
  if (decision === undefined)
    return refuse(`${correction.questionId} has no current decision to correct`);
  const { questionId: _questionId, ...fields } = correction;
  const corrected = await session.change((log) =>
    correctDecision(log, {
      ...fields,
      supersedes: decision.id,
      actor: ACTOR,
      decidedAt: deps.ports.clock.now().toISOString(),
    }),
  );
  const five = await runRegeneration(session, deps.run, run, {
    kind: "decision",
    decisionId: corrected.id,
  });
  const steps: Step[] =
    five.kind === "no_call"
      ? [{ step: "regenerate_recommendations", kind: "no_call" }]
      : five.calls.map((c) => ({ step: "regenerate_recommendations", kind: c.kind }));
  return { ok: true, steps, assembly: assemble(session.records, run.destination, deps.ports) };
}

/**
 * Whether the current recommendations, all accepted, assemble (DM §9.3): on a fork of the log
 * that is never saved, so no selection or artifact is recorded.
 */
export function assemble(
  records: readonly SessionRecord[],
  destination: Uint8Array | undefined,
  ports: LogPorts,
): Assembly {
  const log = new SessionLog(ports, records);
  const refused: string[] = [];
  let accepted = 0;
  for (const revision of currentState(log.records).recommendations.values()) {
    const outcome = select(log, destination, {
      recommendationId: revision.recommendationId,
      revisionId: revision.id,
      state: "accepted",
      actor: ACTOR,
      selectedAt: ports.clock.now().toISOString(),
    });
    if (outcome.selected) accepted++;
    else refused.push(revision.recommendationId);
  }
  const proposed = proposeArtifact(log, destination);
  return proposed.kind === "created"
    ? {
        accepted,
        refused,
        outcome: proposed.kind,
        contentHash: proposed.artifact.proposedHash,
        bytes: proposed.content.length,
      }
    : { accepted, refused, outcome: proposed.kind };
}
