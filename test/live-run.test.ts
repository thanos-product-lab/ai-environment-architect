import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type AnswersFile, answersTemplate, parseAnswers } from "../scripts/live/answers.js";
import { exportedReader, exportRun, forbiddenIn } from "../scripts/live/export.js";
import {
  type AnalyseSettings,
  analysePhase,
  type PhaseDeps,
  prepareAnalyse,
  recommendPhase,
  regeneratePhase,
} from "../scripts/live/phases.js";
import { rebuildRun } from "../scripts/live/rebuild.js";
import { phaseSetup, withPhase } from "../scripts/live/setup.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../src/core/context/tiers.js";
import { DEFAULT_TOKEN_SETTINGS } from "../src/core/context/token-settings.js";
import { comparePaths } from "../src/core/paths.js";
import type { ModelRequest } from "../src/core/request.js";
import { loadSession } from "../src/core/session/load.js";
import type { LogPorts } from "../src/core/session/log.js";
import type { RecordOf, SessionFile } from "../src/core/session/records.js";
import { type GitReader, gitBlobId } from "../src/core/snapshot/git.js";
import { DEFAULT_SNAPSHOT_SETTINGS } from "../src/core/snapshot/snapshot.js";
import type { CallPurpose } from "../src/core/validation/aliases.js";
import { MemoryFs } from "./support/memory-fs.js";
import { MemorySession } from "./support/memory-store.js";
import { type Answer, PRICES, scriptedRunDeps } from "./support/run-harness.js";
import { countingIds, tickingClock } from "./support/session.js";

// The live-run phases (M6 live-run protocol) on the synthetic end-to-end fixture, with recorded
// responses: each phase reopens the saved session as a new process would. No live model is
// called; the run script's own wiring of the real adapters is in `scripts/live-run.ts`.

const ROOT = fileURLToPath(new URL("./fixtures/repos/end-to-end/", import.meta.url));
const PIN = "1".repeat(40);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const NODES: Record<string, string> = Object.fromEntries(
  files(ROOT).map((path) => [relative(ROOT, path), readFileSync(path, "utf8")]),
);

const recorded = (call: CallPurpose) =>
  readFileSync(
    new URL(`./fixtures/responses/${call}/sessions/end-to-end.json`, import.meta.url),
    "utf8",
  );

/** A git that reports `nodes` committed at `commit`, as git would. */
function gitOf(nodes: Record<string, string>, commit = PIN): GitReader {
  return {
    readIgnored: async () => ({ ok: true, paths: [] }),
    readHead: async () => ({
      ok: true,
      objectFormat: "sha1",
      commit,
      tree: Object.entries(nodes)
        .sort(([a], [b]) => comparePaths(a, b))
        .map(([path, text]) => {
          const bytes = Buffer.from(text, "utf8");
          return { path, mode: "100644", objectId: gitBlobId(bytes, "sha1"), size: bytes.length };
        }),
    }),
  };
}

const SETTINGS: AnalyseSettings = {
  selection: {
    snapshot: DEFAULT_SNAPSHOT_SETTINGS,
    context: DEFAULT_CONTEXT_SETTINGS,
    tokens: DEFAULT_TOKEN_SETTINGS,
  },
  model: "claude-test",
  effort: "medium",
  maxCostUsd: 50,
  maxExpansionRequests: 5,
  expansionBytes: 50_000,
  expansionEntryBytes: 20_000,
  questionBudget: 5,
};

/** One run: a session directory and the record ports every phase shares, as random IDs would. */
function liveRun(nodes = NODES) {
  const store = new MemorySession("ses_live");
  const ports: LogPorts = { clock: tickingClock(), ids: countingIds() };
  const sent: ModelRequest[] = [];
  /** A phase, as its own process: a new file system, git and sender over the same run. */
  const phase = (
    script: readonly Answer[],
    over = nodes,
    git = gitOf(over),
    options: Parameters<typeof scriptedRunDeps>[2] = {},
  ): PhaseDeps => {
    const fs = new MemoryFs(over);
    const { deps, sent: phaseSent } = scriptedRunDeps(fs, script, options);
    const run = {
      ...deps,
      sender: {
        ...deps.sender,
        send: async (request: ModelRequest) => {
          sent.push(request);
          return deps.sender.send(request);
        },
      },
    };
    void phaseSent;
    return {
      writer: store,
      repository: {
        name: "fixture",
        url: "https://example.invalid/fixture",
        commit: PIN,
        root: "/r/fixture",
      },
      snapshot: { fs, git },
      ports,
      run,
      productVersion: "0.1.0",
    };
  };
  return { store, ports, sent, phase };
}

/** `analyse` as the script runs it: the snapshot is prepared and checked first. */
async function analyse(deps: PhaseDeps, settings: AnalyseSettings) {
  const ready = await prepareAnalyse(deps, settings);
  return ready.ok ? analysePhase(deps, settings, ready.prepared) : ready;
}

async function savedFile(store: MemorySession): Promise<SessionFile> {
  const loaded = await loadSession(store.sessionFile as Uint8Array, store);
  if (!loaded.ok) throw new Error(loaded.failure.detail);
  return loaded.file;
}

const ANSWER = {
  statement: "The tests run in CI too.",
  scope: { kind: "repository" as const },
  exceptions: [],
};

function answered(answers: AnswersFile): AnswersFile {
  const [first, ...rest] = answers.questions;
  if (first === undefined) throw new Error("no question to answer");
  return { ...answers, questions: [{ ...first, answer: ANSWER }, ...rest] };
}

const ANALYSE_SCRIPT = [
  recorded("analyse"),
  recorded("analyse_expansion"),
  recorded("generate_questions"),
];

async function throughRecommend() {
  const r = liveRun();
  const one = await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
  if (!one.ok || one.answers === undefined) throw new Error("analyse failed");
  const answers = answered(one.answers);
  const two = await recommendPhase(r.phase([recorded("recommend")]), answers);
  return { r, one, answers, two };
}

const kinds = (records: readonly { type: string }[]) => new Set(records.map((r) => r.type));

describe("analyse (M6 live-run protocol)", () => {
  it("runs calls 1–3 and returns the open questions, each with an empty answer", async () => {
    const r = liveRun();
    const result = await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
    expect(result).toMatchObject({
      ok: true,
      steps: [
        { step: "analyse", kind: "completed" },
        { step: "expansion_round", kind: "completed" },
        { step: "generate_questions", kind: "completed" },
      ],
    });
    if (!result.ok || result.answers === undefined) throw new Error("no answers");
    expect(result.answers.runId).toBe("ses_live");
    expect(result.answers.questions.length).toBeGreaterThan(0);
    for (const q of result.answers.questions) expect(q.answer).toBeNull();
    expect(result.answers.correction).toBeNull();
    // The template round-trips through the file's parser.
    expect(parseAnswers(JSON.stringify(result.answers))).toEqual(result.answers);
  });

  it("records retainModelInputs on, the budget given, and the released model settings", async () => {
    const r = liveRun();
    await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
    const file = await savedFile(r.store);
    const config = file.records.find(
      (x) => x.type === "generation_config",
    ) as RecordOf<"generation_config">;
    expect(config).toMatchObject({
      retainModelInputs: true,
      budget: { maxCostUsd: 50 },
      requestedModel: "claude-test",
      effort: "medium",
    });
    expect(file.session.repository).toEqual({ name: "fixture", root: "/r/fixture" });
  });

  it("refuses a snapshot that isn't at the pinned commit, before any session is saved", async () => {
    const r = liveRun();
    const result = await analyse(
      r.phase(ANALYSE_SCRIPT, NODES, gitOf(NODES, "2".repeat(40))),
      SETTINGS,
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/not 1{40}/) });
    expect(r.store.sessionFile).toBeUndefined();
    expect(r.sent).toEqual([]);
  });

  it("refuses a snapshot with uncommitted changes", async () => {
    const r = liveRun();
    const changed = { ...NODES, "src/new.ts": "export const b = 2;\n" };
    const result = await analyse(r.phase(ANALYSE_SCRIPT, changed, gitOf(NODES)), SETTINGS);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/aren't committed/) });
    expect(r.store.sessionFile).toBeUndefined();
  });

  it("stops at the budget, records it, and sends nothing", async () => {
    const r = liveRun();
    const result = await analyse(r.phase(ANALYSE_SCRIPT), { ...SETTINGS, maxCostUsd: 0.0001 });
    expect(result).toMatchObject({ ok: true, steps: [{ step: "analyse", kind: "not_sent" }] });
    expect(r.sent).toEqual([]);
    const file = await savedFile(r.store);
    expect(
      file.records.some((x) => x.type === "session_state" && x.reason === "budget_reached"),
    ).toBe(true);
  });
});

describe("recommend and regenerate (M6 live-run protocol)", () => {
  it("records the answers as decisions, runs call 4 and checks the recommendations assemble", async () => {
    const { r, answers, two } = await throughRecommend();
    expect(two).toMatchObject({
      ok: true,
      steps: [{ step: "recommend", kind: "completed" }],
      assembly: { outcome: "created", accepted: 1, refused: [] },
    });
    const file = await savedFile(r.store);
    const decisions = file.records.filter((x) => x.type === "decision");
    expect(decisions).toMatchObject([
      {
        statement: ANSWER.statement,
        questionId: answers.questions[0]?.questionId,
        origin: "answered_question",
      },
    ]);
  });

  it("applies the correction, runs call 5 and checks the revised recommendations assemble", async () => {
    const { r, answers } = await throughRecommend();
    const corrected: AnswersFile = {
      ...answers,
      correction: {
        questionId: answers.questions[0]?.questionId as string,
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
      },
    };
    const three = await regeneratePhase(
      r.phase([recorded("regenerate_recommendations")]),
      corrected,
    );
    expect(three).toMatchObject({
      ok: true,
      steps: [{ step: "regenerate_recommendations", kind: "completed" }],
      assembly: { outcome: "created", accepted: 1 },
    });
    const file = await savedFile(r.store);
    const last = file.records.filter((x) => x.type === "decision").at(-1);
    expect(last).toMatchObject({
      statement: "The tests run in CI only.",
      supersedes: [expect.any(String)],
    });
  });

  it("never records a selection, artifact, review or apply attempt in the saved session", async () => {
    const { r, answers } = await throughRecommend();
    await regeneratePhase(r.phase([recorded("regenerate_recommendations")]), {
      ...answers,
      correction: {
        questionId: answers.questions[0]?.questionId as string,
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
      },
    });
    const types = kinds((await savedFile(r.store)).records);
    for (const type of ["selection", "artifact_revision", "review", "apply_attempt"])
      expect(types.has(type), type).toBe(false);
  });

  it("sends the same five purposes, in order, as the single-process session", async () => {
    const { r, answers } = await throughRecommend();
    await regeneratePhase(r.phase([recorded("regenerate_recommendations")]), {
      ...answers,
      correction: {
        questionId: answers.questions[0]?.questionId as string,
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
      },
    });
    const file = await savedFile(r.store);
    const ended = file.records.filter(
      (x): x is RecordOf<"model_call"> => x.type === "model_call" && x.state !== "started",
    );
    expect(ended.map((c) => [c.purpose, c.state])).toEqual([
      ["analyse", "completed"],
      ["analyse_expansion", "completed"],
      ["generate_questions", "completed"],
      ["recommend", "completed"],
      ["regenerate_recommendations", "completed"],
    ]);
  });

  it("refuses recommend before call 3 has completed", async () => {
    const r = liveRun();
    const one = await analyse(r.phase(ANALYSE_SCRIPT), { ...SETTINGS, maxCostUsd: 0.0001 });
    if (!one.ok || one.answers === undefined) throw new Error("analyse failed");
    const result = await recommendPhase(r.phase([recorded("recommend")]), one.answers);
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses to run recommend twice", async () => {
    const { r, answers } = await throughRecommend();
    const again = await recommendPhase(r.phase([recorded("recommend")]), answers);
    expect(again).toMatchObject({ ok: false, reason: "call 4 has already run" });
  });

  it("refuses an answer to a question the run doesn't have, and records nothing", async () => {
    const r = liveRun();
    const one = await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
    if (!one.ok || one.answers === undefined) throw new Error("analyse failed");
    const before = r.store.sessionFile;
    const answers: AnswersFile = {
      ...one.answers,
      questions: [{ questionId: "q_9999", prompt: "", reason: "", options: [], answer: ANSWER }],
    };
    const result = await recommendPhase(r.phase([recorded("recommend")]), answers);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/q_9999/) });
    expect(r.store.sessionFile).toEqual(before);
  });

  it("refuses to run regenerate twice, so a correction isn't recorded or paid for again", async () => {
    const { r, answers } = await throughRecommend();
    const corrected: AnswersFile = {
      ...answers,
      correction: {
        questionId: answers.questions[0]?.questionId as string,
        statement: "The tests run in CI only.",
        scope: { kind: "repository" },
        exceptions: [],
      },
    };
    await regeneratePhase(r.phase([recorded("regenerate_recommendations")]), corrected);
    const before = r.store.sessionFile;
    expect(await regeneratePhase(r.phase([]), corrected)).toMatchObject({
      ok: false,
      reason: "call 5 has already run",
    });
    expect(r.store.sessionFile).toEqual(before);
  });

  it("refuses regenerate without a correction", async () => {
    const { r, answers } = await throughRecommend();
    expect(await regeneratePhase(r.phase([]), answers)).toMatchObject({
      ok: false,
      reason: "answers.json has no correction",
    });
  });

  it("refuses a later phase when the repository no longer matches the snapshot", async () => {
    const r = liveRun();
    const one = await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
    if (!one.ok || one.answers === undefined) throw new Error("analyse failed");
    const changed = { ...NODES, "src/a.ts": "export const a = 2;\n" };
    const result = await recommendPhase(
      r.phase([recorded("recommend")], changed),
      answered(one.answers),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/differs from the snapshot/),
    });
  });
});

describe("rebuilding call 1's context in a later process", () => {
  it("gives the context call 1 sent, which its request holds", async () => {
    const r = liveRun();
    await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
    const file = await savedFile(r.store);
    const rebuilt = await rebuildRun(file.records, { fs: new MemoryFs(NODES), git: gitOf(NODES) });
    if (!rebuilt.ok) throw new Error(rebuilt.reason);
    expect(r.sent[0]?.user).toContain(rebuilt.run.sent.context.text);
    const callOne = file.records.find((x) => x.type === "model_call") as RecordOf<"model_call">;
    expect(rebuilt.run.inspection.snapshotId).toBe(callOne.inputManifest.snapshotId);
  });

  it("removes again what call 1's token check removed, and the later phases still run", async () => {
    // A limit that fits call 1 only once its token check removes the source sample (tier 5).
    const first = liveRun();
    await analyse(first.phase(ANALYSE_SCRIPT), SETTINGS);
    const full = (await savedFile(first.store)).records.find(
      (x): x is RecordOf<"model_call"> => x.type === "model_call",
    )?.inputManifest.tokenCheck;
    if (full == null) throw new Error("no token check");
    const fits = full.inputTokens + full.reservedOutputTokens;
    const maxInputTokens = Math.ceil((fits - 5) / (1 - DEFAULT_TOKEN_SETTINGS.safetyMargin));

    const r = liveRun();
    const options = { maxInputTokens };
    await analyse(r.phase(ANALYSE_SCRIPT, NODES, gitOf(NODES), options), SETTINGS);
    const file = await savedFile(r.store);
    const callOne = file.records.find(
      (x): x is RecordOf<"model_call"> => x.type === "model_call" && x.state === "completed",
    );
    expect(callOne?.inputManifest.tokenCheck?.reductions.length).toBeGreaterThan(0);
    const rebuilt = await rebuildRun(file.records, { fs: new MemoryFs(NODES), git: gitOf(NODES) });
    expect(rebuilt).toMatchObject({ ok: true });
  });

  it("refuses a context that isn't the one call 1's manifest records", async () => {
    const r = liveRun();
    await analyse(r.phase(ANALYSE_SCRIPT), SETTINGS);
    const file = await savedFile(r.store);
    const altered = file.records.map((x) =>
      x.type === "model_call" && x.purpose === "analyse"
        ? { ...x, inputManifest: { ...x.inputManifest, contextHash: `sha256:${"0".repeat(64)}` } }
        : x,
    ) as typeof file.records;
    expect(await rebuildRun(altered, { fs: new MemoryFs(NODES), git: gitOf(NODES) })).toEqual({
      ok: false,
      reason: "the context selected again isn't the one call 1 sent",
    });
  });

  it("refuses when call 1 hasn't completed", async () => {
    const r = liveRun();
    await analyse(r.phase(ANALYSE_SCRIPT), { ...SETTINGS, maxCostUsd: 0.0001 });
    const file = await savedFile(r.store);
    expect(await rebuildRun(file.records, { fs: new MemoryFs(NODES), git: gitOf(NODES) })).toEqual({
      ok: false,
      reason: "call 1 hasn't completed",
    });
  });
});

describe("the fixture export (M6 live-run protocol, step 5)", () => {
  it("writes each retained request and response as <seq>-<call>, byte for byte", async () => {
    const { r } = await throughRecommend();
    const file = await savedFile(r.store);
    const out = await exportRun(file, r.store, []);
    const started = file.records.filter(
      (x): x is RecordOf<"model_call"> => x.type === "model_call" && x.state === "started",
    );
    expect(started).toHaveLength(4);
    for (const call of started) {
      const name = `${String(call.seq).padStart(4, "0")}-${call.purpose}`;
      expect(out.get(`${name}.request.json`)).toEqual(
        r.store.files.get(call.retainedInputRef as string),
      );
      const ended = file.records.find(
        (x): x is RecordOf<"model_call"> =>
          x.type === "model_call" && x.modelCallId === call.modelCallId && x.state !== "started",
      );
      expect(out.get(`${name}.response.json`)).toEqual(
        r.store.files.get(ended?.state === "started" ? "" : (ended?.retainedResponseRef as string)),
      );
    }
  });

  it("replaces only the session's root with the repository's name", async () => {
    const { r } = await throughRecommend();
    const file = await savedFile(r.store);
    const out = await exportRun(file, r.store, []);
    const exported = JSON.parse(new TextDecoder().decode(out.get("session.json"))) as SessionFile;
    expect(exported.session.repository).toEqual({ name: "fixture", root: "fixture" });
    expect({ ...exported, session: file.session }).toEqual(file);
  });

  it("gives a run directory whose session loads with every check passing", async () => {
    const { r } = await throughRecommend();
    const out = await exportRun(await savedFile(r.store), r.store, []);
    const loaded = await loadSession(out.get("session.json") as Uint8Array, exportedReader(out));
    expect(loaded).toMatchObject({ ok: true });
  });

  it("writes a manifest with the commit, the versions, and each call's events and counts", async () => {
    const { r } = await throughRecommend();
    const out = await exportRun(await savedFile(r.store), r.store, []);
    const manifest = JSON.parse(new TextDecoder().decode(out.get("manifest.json")));
    expect(manifest).toMatchObject({ repository: "fixture", commit: PIN, sessionId: "ses_live" });
    expect(manifest.calls.map((c: { purpose: string }) => c.purpose)).toEqual([
      "analyse",
      "analyse_expansion",
      "generate_questions",
      "recommend",
    ]);
    for (const call of manifest.calls) {
      expect(call.versions).toMatchObject({
        validator: expect.any(String),
        detector: expect.any(String),
        apiVersion: "2026-10-21",
      });
      expect(call).toHaveProperty("counts");
      expect(call).toHaveProperty("validationEvents");
    }
  });

  it("keeps a send that got no response: its request, and a null response", async () => {
    const r = liveRun();
    const failing: Answer = (request) => ({
      kind: "connection",
      requestBytes: new TextEncoder().encode(JSON.stringify(request)),
    });
    await analyse(r.phase([failing, failing, failing, failing]), SETTINGS);
    const out = await exportRun(await savedFile(r.store), r.store, []);
    const manifest = JSON.parse(new TextDecoder().decode(out.get("manifest.json")));
    expect(manifest.calls).toHaveLength(4);
    for (const call of manifest.calls) {
      expect(call).toMatchObject({
        state: "failed",
        response: null,
        error: { kind: "connection" },
      });
      expect(out.has(call.request)).toBe(true);
    }
  });

  it("refuses to export a file holding the local root, the storage path or the key", async () => {
    const { r } = await throughRecommend();
    const file = await savedFile(r.store);
    // The root is replaced, so no exported file holds it.
    expect((await exportRun(file, r.store, ["/r/fixture"])).size).toBeGreaterThan(0);
    // A value a retained request holds, standing in for a leaked key.
    await expect(exportRun(file, r.store, ["Run the tests before pushing."])).rejects.toThrow(
      /forbidden/,
    );
  });
});

describe("the forbidden-value check", () => {
  it("names the first file holding a value, never the value", () => {
    const files = new Map([
      ["setup.json", new TextEncoder().encode('{"a":1}')],
      ["answers.json", new TextEncoder().encode('{"answer":"see /Users/dev/x"}')],
    ]);
    expect(forbiddenIn(files, ["/Users/dev"])).toBe("answers.json");
    expect(forbiddenIn(files, ["", "/nowhere"])).toBeUndefined();
  });
});

describe("the setup record (M6 live-run protocol, step 3)", () => {
  it("records the versions, model, effort, API version, price table and retention, never a key", async () => {
    const r = liveRun();
    const deps = r.phase(ANALYSE_SCRIPT);
    await analyse(deps, SETTINGS);
    const entry = phaseSetup({
      phase: "analyse",
      startedAt: "2026-11-22T10:00:00.000Z",
      productCommit: "c".repeat(40),
      productTreeClean: true,
      prompts: deps.run.prompts,
      prices: PRICES,
      apiVersion: "2026-10-21",
      records: (await savedFile(r.store)).records,
    });
    expect(entry).toMatchObject({
      model: "claude-test",
      effort: "medium",
      apiVersion: "2026-10-21",
      priceTable: { version: "prices/test", date: "2026-11-15" },
      retainModelInputs: true,
      budget: { maxCostUsd: 50 },
      validatorVersion: expect.stringMatching(/^validate\//),
      detectorVersion: expect.any(String),
    });
    expect(Object.keys(entry.prompts)).toHaveLength(5);
    expect(Object.keys(entry.schemas)).toHaveLength(5);
    const both = withPhase(withPhase(undefined, entry), { ...entry, phase: "recommend" });
    expect(JSON.parse(both).phases.map((p: { phase: string }) => p.phase)).toEqual([
      "analyse",
      "recommend",
    ]);
  });
});

describe("the answers file", () => {
  it("lists only open questions", async () => {
    const { r } = await throughRecommend();
    const file = await savedFile(r.store);
    // After recommend, the answered question is no longer open.
    expect(answersTemplate("ses_live", file.records).questions).toHaveLength(0);
  });

  it("refuses an answer without a statement", () => {
    const text = JSON.stringify({
      runId: "ses_live",
      questions: [
        {
          questionId: "q_1",
          prompt: "",
          reason: "",
          options: [],
          answer: { statement: "", scope: { kind: "repository" }, exceptions: [] },
        },
      ],
      correction: null,
    });
    expect(() => parseAnswers(text)).toThrow(/statement/);
  });
});
