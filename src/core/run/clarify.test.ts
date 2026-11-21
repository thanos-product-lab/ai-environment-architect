import { describe, expect, it } from "vitest";
import { type Answer, type Harness, harness, response } from "../../../test/support/run-harness.js";
import type { ModelRequest } from "../request.js";
import { answerQuestion } from "../session/answers.js";
import type { Revised } from "../session/log.js";
import type { RecordOf } from "../session/records.js";
import { recordInspection, runAnalyse, runExpansionStep } from "./analysis.js";
import { runGenerateQuestions, runRecommend } from "./clarify.js";

// Running calls 3 and 4 through the core API with recorded responses (IMPL §1.2, §3.3.4–§3.3.5).

const NODES = {
  "CLAUDE.md": "# Rules\n\n- Run the tests before pushing.\n",
  "package.json": '{\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
  "src/a.ts": "export const a = 1;\n",
};
const STATEMENT = "The rules ask for the tests to run before pushing.";

const callOne = (h: Harness) => {
  const item = h.context.items.find((i) => i.path === "CLAUDE.md")?.id as string;
  return JSON.stringify({
    findings: [
      {
        key: "f1",
        statement: STATEMENT,
        mode: "descriptive",
        scope: { kind: "repository" },
        citations: [{ item, lines: "3-3", quote: "Run the tests before pushing." }],
      },
    ],
    gaps: [],
    absenceClaims: [],
    conflicts: [],
    expansionRequests: [],
    contentNotices: [],
  });
};

/** The alias call 3 or 4 gave the call-1 finding, read from the request it was sent. */
function findingAlias(request: ModelRequest): string {
  const match = request.user.match(/^(F-\d+) {2}\[[^\n]*\n {5}The rules ask/m);
  if (match?.[1] === undefined) throw new Error("the finding wasn't sent");
  return match[1];
}

const questions: Answer = (request) =>
  response(
    request,
    JSON.stringify({
      questions: [
        {
          key: "q1",
          prompt: "Do the tests also run in CI?",
          reason: "The rules don't say.",
          resolves: [findingAlias(request)],
          scope: { kind: "repository" },
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    }),
  );

const recommendation: Answer = (request) =>
  response(
    request,
    JSON.stringify({
      recommendations: [
        {
          key: "r1",
          kind: "policy",
          operation: "add",
          target: { kind: "newSection", heading: "Testing" },
          rationale: "The developer decided where the tests run.",
          support: ["D-1"],
          references: [],
          scope: { kind: "repository" },
          content: "Run the tests in CI as well as before pushing.",
        },
      ],
      heldBack: [],
    }),
  );

async function throughCallOne(
  script: Answer[],
  options: Parameters<typeof harness>[2] = {},
  first = callOne,
) {
  const answers: Answer[] = [];
  const h = await harness(NODES, answers, options);
  answers.push(first(h), ...script);
  const inspection = await recordInspection(h.session, h.context);
  const one = await runAnalyse(h.session, h.deps, {
    context: h.context,
    inspection,
    destination: h.destination,
  });
  if (one.kind !== "completed") throw new Error(one.kind);
  return { h, run: { sent: one.sent, inspection, destination: h.destination } };
}

const calls = (h: Harness) =>
  h.session.records.filter((r): r is RecordOf<"model_call"> => r.type === "model_call");

describe("call 3 (IMPL §3.3.4)", () => {
  it("sends the records and records the ranked questions, with the model's order", async () => {
    const { h, run } = await throughCallOne([questions]);
    const outcome = await runGenerateQuestions(h.session, h.deps, run);
    expect(outcome.kind).toBe("completed");
    const user = h.sent[1]?.user ?? "";
    expect(user.startsWith('<<<DESTINATION path="CLAUDE.md"')).toBe(true);
    expect(user).toContain("<<<LIMITS>>>\nquestionBudget: 5\nquestions: 20\n<<<END LIMITS>>>");
    expect(user).not.toContain("<<<ITEM");
    const call = calls(h).at(-1) as RecordOf<"model_call">;
    expect(call).toMatchObject({ purpose: "generate_questions", questionOrder: ["q1"] });
    expect(call.inputManifest.items).toEqual([]);
    expect(call.inputManifest.tiers.map((t) => t.tier)).toEqual([4]);
    const question = h.session.records.find((r) => r.type === "question");
    expect(question).toMatchObject({
      status: "open",
      prompt: "Do the tests also run in CI?",
      options: [{ label: "Yes" }, { label: "No" }],
      producedBy: call.modelCallId,
    });
    const finding = h.session.records.find(
      (r) => r.type === "finding" && "statement" in r && r.statement === STATEMENT,
    );
    expect((question as { findingIds: string[] }).findingIds).toEqual([
      (finding as { findingId: string }).findingId,
    ]);
  });

  it("records questions beyond the budget unreached, and a gap among gapIds", async () => {
    const withGap = (h: Harness) => {
      const one = JSON.parse(callOne(h));
      one.gaps = [
        {
          key: "g1",
          statement: "No command runs the linter.",
          gapType: "no_command",
          relatedPaths: ["package.json"],
        },
      ];
      return JSON.stringify(one);
    };
    const twoQuestions: Answer = (request) => {
      const gap = request.user.match(/^(F-\d+) {2}\[gap · no_command\]/m)?.[1] as string;
      const question = (key: string, resolves: string) => ({
        key,
        prompt: `Question ${key}?`,
        reason: "Unclear.",
        resolves: [resolves],
        scope: { kind: "repository" },
        options: [],
      });
      return response(
        request,
        JSON.stringify({
          questions: [question("q1", findingAlias(request)), question("q2", gap)],
        }),
      );
    };
    const { h, run } = await throughCallOne([twoQuestions], { questionBudget: 1 }, withGap);
    await runGenerateQuestions(h.session, h.deps, run);
    const recorded = h.session.records.filter(
      (r): r is Revised<"question"> => r.type === "question" && "prompt" in r,
    );
    // The gap question ranks first (class 2), so it is presented and the other is unreached.
    expect(recorded.map((q) => [q.prompt, q.status])).toEqual([
      ["Question q2?", "open"],
      ["Question q1?", "unreached"],
    ]);
    expect(recorded[0]).toMatchObject({ findingIds: [], conflictIds: [] });
    expect((recorded[0] as { gapIds: string[] }).gapIds).toHaveLength(1);
    expect(recorded[1]).toMatchObject({ unreachedReason: "budget" });
    expect(calls(h).at(-1)).toMatchObject({ questionOrder: ["q1", "q2"] });
  });
});

describe("call 4 (IMPL §3.3.5)", () => {
  it("sends the questions and decisions, and records the accepted recommendation", async () => {
    const { h, run } = await throughCallOne([questions, recommendation]);
    await runGenerateQuestions(h.session, h.deps, run);
    const question = h.session.records.find((r) => r.type === "question") as {
      questionId: string;
    };
    await h.session.change((log) => {
      answerQuestion(log, {
        questionId: question.questionId,
        statement: "The tests run in CI too.",
        scope: { kind: "repository" },
        exceptions: [],
        actor: "developer",
        decidedAt: "2026-11-01T10:20:00.000Z",
      });
    });
    const outcome = await runRecommend(h.session, h.deps, run);
    expect(outcome.kind).toBe("completed");
    const user = h.sent[2]?.user ?? "";
    expect(user).toContain("Q-1  [answered · D-1]");
    expect(user).toContain(
      "D-1  [answered]  question: Q-1  scope: repository\n     The tests run in CI too.\n",
    );
    const call = calls(h).at(-1) as RecordOf<"model_call">;
    expect(call.purpose).toBe("recommend");
    const revisions = h.session.records.filter((r) => r.type === "recommendation_revision");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      kind: "policy",
      operation: "add",
      status: "valid",
      content: "Run the tests in CI as well as before pushing.",
      producedBy: call.modelCallId,
    });
  });
});

describe("calls 3–4 edges (IMPL §1.8, §1.10, §3.2.6)", () => {
  it("stores a repeated resolves alias once", async () => {
    const repeated: Answer = (request) => {
      const alias = findingAlias(request);
      return response(
        request,
        JSON.stringify({
          questions: [
            {
              key: "q1",
              prompt: "Do the tests also run in CI?",
              reason: "Unclear.",
              resolves: [alias, alias],
              scope: { kind: "repository" },
              options: [],
            },
          ],
        }),
      );
    };
    const { h, run } = await throughCallOne([repeated]);
    await runGenerateQuestions(h.session, h.deps, run);
    const question = h.session.records.find((r) => r.type === "question") as {
      findingIds: string[];
    };
    expect(question.findingIds).toHaveLength(1);
  });

  it("records the excerpts the token check removed in the call's manifest", async () => {
    const { h, run } = await throughCallOne([questions], {
      count: (request) =>
        request.user.includes("<<<FINDINGS>>>") && request.user.includes("       | - Run the tests")
          ? 10_000_000
          : 1_000,
    });
    const outcome = await runGenerateQuestions(h.session, h.deps, run);
    expect(outcome.kind).toBe("completed");
    const call = calls(h).at(-1) as RecordOf<"model_call">;
    expect(call.inputManifest.skipped).toContainEqual({
      path: "CLAUDE.md",
      reason: "token-check:excerpt",
    });
    expect(call.inputManifest.tokenCheck?.reductions.map((r) => r.step)).toContain("excerpt");
    expect(h.sent[1]?.user).toContain("evidence: CLAUDE.md:3-3 (excerpt not sent)");
  });

  it("leaves out a file the round blocked when call 2 wasn't sent", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const answers: Answer[] = [];
    const nodes = { ...NODES, "notes/keys.txt": `aws = "${key}"\n` };
    const h = await harness(nodes, answers);
    const one = JSON.parse(callOne(h));
    one.expansionRequests = [
      { kind: "read", entries: [{ path: "notes/keys.txt" }], reason: "Read it." },
    ];
    answers.push(JSON.stringify(one), questions);
    const inspection = await recordInspection(h.session, h.context);
    const first = await runAnalyse(h.session, h.deps, {
      context: h.context,
      inspection,
      destination: h.destination,
    });
    if (first.kind !== "completed") throw new Error(first.kind);
    const two = await runExpansionStep(h.session, h.deps, {
      callOne: first,
      inspection,
      destination: h.destination,
    });
    expect(two.kind).toBe("no_items");
    await runGenerateQuestions(h.session, h.deps, {
      sent: first.sent,
      inspection,
      destination: h.destination,
    });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.user).toContain("[S] keys.txt");
    expect(h.sent[1]?.user).not.toContain(key);
    expect((calls(h).at(-1) as RecordOf<"model_call">).inputManifest.excluded).toContainEqual({
      path: "notes/keys.txt",
      reason: "secret-scan:aws-access-key-id",
    });
  });
});
