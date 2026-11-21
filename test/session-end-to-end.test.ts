import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recordInspection, runAnalyse, runExpansionStep } from "../src/core/run/analysis.js";
import { runGenerateQuestions, runRecommend } from "../src/core/run/clarify.js";
import { runRegeneration } from "../src/core/run/regenerate.js";
import { answerQuestion } from "../src/core/session/answers.js";
import { applyArtifact } from "../src/core/session/apply.js";
import { proposeArtifact, recordReview } from "../src/core/session/artifacts.js";
import { estimateCall } from "../src/core/session/cost.js";
import { currentState } from "../src/core/session/current.js";
import { loadSession } from "../src/core/session/load.js";
import type { RecordOf } from "../src/core/session/records.js";
import { select } from "../src/core/session/selections.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../src/core/snapshot/snapshot.js";
import type { CallPurpose } from "../src/core/validation/aliases.js";
import { MemoryDestination } from "./support/memory-destination.js";
import { fixedClock, fixedIds } from "./support/memory-fs.js";
import { TEST_PROMPT_VERSION } from "./support/prompts.js";
import { harness, PRICES } from "./support/run-harness.js";

// A full session on a synthetic fixture repository, through the core API, with a recorded
// response for each of the five calls (M6, IMPL §1.2): inspect, call 1, the expansion round,
// call 2, questions, an answer, recommend, a corrected answer and regeneration, selection,
// assembly, review and apply. No live model is called.

const ROOT = fileURLToPath(new URL("./fixtures/repos/end-to-end/", import.meta.url));
const PURPOSES: readonly CallPurpose[] = [
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const recorded = (call: CallPurpose) =>
  readFileSync(
    new URL(`./fixtures/responses/${call}/sessions/end-to-end.json`, import.meta.url),
    "utf8",
  );

async function fullSession() {
  const nodes = Object.fromEntries(
    files(ROOT).map((path) => [relative(ROOT, path), readFileSync(path, "utf8")]),
  );
  const h = await harness(nodes, PURPOSES.map(recorded));
  const { session, deps, destination } = h;

  // Inspect, then call 1, the round and call 2.
  const inspection = await recordInspection(session, h.context);
  const one = await runAnalyse(session, deps, { context: h.context, inspection, destination });
  if (one.kind !== "completed") throw new Error(`call 1: ${one.kind}`);
  const two = await runExpansionStep(session, deps, { callOne: one, inspection, destination });
  const run = { sent: one.sent, inspection, destination };

  // Questions and an answer.
  const three = await runGenerateQuestions(session, deps, run);
  const question = session.records.find((r) => r.type === "question") as { questionId: string };
  const { decision } = await session.change((log) =>
    answerQuestion(log, {
      questionId: question.questionId,
      statement: "The tests run in CI too.",
      scope: { kind: "repository" },
      exceptions: [],
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    }),
  );

  // Recommend, then the developer corrects the answer and the recommendation is regenerated.
  const four = await runRecommend(session, deps, run);
  const correction = await session.change(
    (log) =>
      log.append({
        type: "decision",
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
        questionId: question.questionId,
        origin: "answered_question",
        actor: "developer",
        decidedAt: "2026-11-01T10:40:00.000Z",
        supersedes: [decision.id],
      }) as RecordOf<"decision">,
  );
  const five = await runRegeneration(session, deps, run, {
    kind: "decision",
    decisionId: correction.id,
  });

  // Selection, assembly, review and apply.
  const [revision] = currentState(session.records).recommendations.values();
  if (revision === undefined) throw new Error("no current recommendation");
  await session.change((log) =>
    select(log, destination, {
      recommendationId: revision.recommendationId,
      revisionId: revision.id,
      state: "accepted",
      actor: "developer",
      selectedAt: "2026-11-01T10:45:00.000Z",
    }),
  );
  const proposed = await session.change((log, pending) => {
    const outcome = proposeArtifact(log, destination);
    if (outcome.kind === "created") pending.contents.push(outcome.content);
    return outcome;
  });
  if (proposed.kind !== "created") throw new Error(`propose: ${proposed.kind}`);
  await session.change((log) =>
    recordReview(log, {
      artifactRevisionId: proposed.artifact.id,
      contentHash: proposed.artifact.proposedHash,
      outcome: "approved",
      actor: "developer",
      reviewedAt: "2026-11-01T10:50:00.000Z",
    }),
  );
  const target = new MemoryDestination({ kind: "file", bytes: destination as Uint8Array });
  const applied = await applyArtifact(session, {
    destination: target,
    content: h.store,
    clock: fixedClock,
    async rescan() {
      const again = await captureSnapshot(
        { fs: h.fs, clock: fixedClock, ids: fixedIds },
        DEFAULT_SNAPSHOT_SETTINGS,
      );
      return {
        files: again.files,
        stability: again.stability,
        destination:
          again.destination.state === "present"
            ? { state: "present", hash: again.destination.hash }
            : { state: "absent" },
      };
    },
  });
  return { h, outcomes: { one, two, three, four, five }, applied, target };
}

const calls = (records: readonly { type: string }[]) =>
  records.filter((r): r is RecordOf<"model_call"> => r.type === "model_call");

describe("a full session through the core API (M6, IMPL §1.2)", () => {
  it("runs inspect through apply with a recorded response for each of the five calls", async () => {
    const { h, outcomes, applied, target } = await fullSession();
    expect(outcomes.two.kind).toBe("completed");
    expect(outcomes.three.kind).toBe("completed");
    expect(outcomes.four.kind).toBe("completed");
    expect(outcomes.five).toMatchObject({ kind: "ran", calls: [{ kind: "completed" }] });
    expect(applied.kind).toBe("succeeded");

    // One completed call per purpose, in the order of §1.2, each with the placeholder prompt.
    const ended = calls(h.session.records).filter((c) => c.state !== "started");
    expect(ended.map((c) => [c.purpose, c.state])).toEqual(
      PURPOSES.map((purpose) => [purpose, "completed"]),
    );
    for (const call of ended) expect(call.promptVersion).toBe(TEST_PROMPT_VERSION);

    // The expansion item was cited, the question answered, and the revised content applied.
    expect(
      h.session.records.some(
        (r) => r.type === "evidence" && "path" in r && r.path === "notes/extra.txt",
      ),
    ).toBe(true);
    expect(
      new TextDecoder().decode(target.node.kind === "file" ? target.node.bytes : new Uint8Array()),
    ).toBe("# Rules\n\n- Run the tests before pushing.\n\n## Testing\n\nRun the tests in CI.\n");
  });

  it("sets no cache breakpoint, and every estimate prices its input as uncached (IMPL §4.6, §3.8)", async () => {
    const { h } = await fullSession();
    for (const request of h.sent) expect(JSON.stringify(request)).not.toMatch(/cache/i);
    const config = h.session.records.find(
      (r): r is RecordOf<"generation_config"> => r.type === "generation_config",
    ) as RecordOf<"generation_config">;
    const started = calls(h.session.records).filter((c) => c.state === "started");
    expect(started).toHaveLength(5);
    for (const call of started) {
      if (call.estimatedTokens.state !== "known") throw new Error("unknown estimate");
      const reserved = config.settings.tokens.reservedOutputTokens[call.purpose];
      const inputTokens = call.estimatedTokens.value - reserved;
      const uncached = estimateCall(PRICES, {
        model: call.requestedModel,
        inputTokens,
        reservedOutputTokens: reserved,
        cachesInput: false,
      });
      expect(call.estimatedCost).toEqual(uncached.cost);
      // Priced at the cache-write rate, it would differ, so the check can fail.
      const cached = estimateCall(PRICES, {
        model: call.requestedModel,
        inputTokens,
        reservedOutputTokens: reserved,
        cachesInput: true,
      });
      expect(call.estimatedCost).not.toEqual(cached.cost);
    }
  });

  it("saves a session that loads again with every check passing", async () => {
    const { h } = await fullSession();
    const loaded = await loadSession(h.store.sessionFile as Uint8Array, h.store);
    expect(loaded).toMatchObject({ ok: true });
  });

  it("gives byte-identical session files for the same repository and responses", async () => {
    const first = await fullSession();
    const second = await fullSession();
    expect(second.h.store.sessionFile).toEqual(first.h.store.sessionFile);
    expect(second.h.sent).toEqual(first.h.sent);
  });
});
