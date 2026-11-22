import type { ModelRequest } from "../../src/core/request.js";
import { recordInspection, runAnalyse } from "../../src/core/run/analysis.js";
import {
  type RecordCallRun,
  runGenerateQuestions,
  runRecommend,
} from "../../src/core/run/clarify.js";
import { answerQuestion } from "../../src/core/session/answers.js";
import { type Answer, type Harness, harness, response } from "./run-harness.js";

// Recorded responses for a small synthetic repository, and a session run through calls 1, 3 and
// 4 with them, for the tests of later steps. The responses are invented for the fixture.

export const NODES = {
  "CLAUDE.md": "# Rules\n\n- Run the tests before pushing.\n",
  "package.json": '{\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
  "src/a.ts": "export const a = 1;\n",
  "notes/extra.txt": "Deploys go through the release script.\n",
};

export const STATEMENT = "The rules ask for the tests to run before pushing.";

export const EMPTY_ANALYSE = {
  findings: [],
  gaps: [],
  absenceClaims: [],
  conflicts: [],
  expansionRequests: [],
  contentNotices: [],
};

export function callOne(h: Harness, expansionRequests: unknown[] = []): string {
  const item = h.context.items.find((i) => i.path === "CLAUDE.md")?.id as string;
  return JSON.stringify({
    ...EMPTY_ANALYSE,
    findings: [
      {
        key: "f1",
        statement: STATEMENT,
        mode: "descriptive",
        scope: { kind: "repository" },
        citations: [{ item, lines: "3-3", quote: "Run the tests before pushing." }],
      },
    ],
    expansionRequests,
  });
}

/** The alias a later call gave the call-1 finding, read from the request it was sent. */
export function findingAlias(request: ModelRequest): string {
  const match = request.user.match(/^(F-\d+) {2}\[[^\n]*\n {5}The rules ask/m);
  if (match?.[1] === undefined) throw new Error("the finding wasn't sent");
  return match[1];
}

export const questions: Answer = (request) =>
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

export const RECOMMENDED = "Run the tests in CI as well as before pushing.";

export const RATIONALE = "The developer decided where the tests run.";

export const recommendation =
  (content = RECOMMENDED, rationale = RATIONALE): Answer =>
  (request) =>
    response(
      request,
      JSON.stringify({
        recommendations: [
          {
            key: "r1",
            kind: "policy",
            operation: "add",
            target: { kind: "newSection", heading: "Testing" },
            rationale,
            support: ["D-1"],
            references: [],
            scope: { kind: "repository" },
            content,
          },
        ],
        heldBack: [],
      }),
    );

export interface ThroughRecommend {
  readonly h: Harness;
  readonly run: RecordCallRun;
  readonly questionId: string;
  readonly decisionId: string;
}

/** Runs calls 1, 3 and 4, answering the one question in between, then the rest of `later`. */
export async function throughRecommend(
  later: Answer[],
  content = RECOMMENDED,
  options: Parameters<typeof harness>[2] = {},
  rationale = RATIONALE,
): Promise<ThroughRecommend> {
  const answers: Answer[] = [];
  const h = await harness(NODES, answers, options);
  answers.push(callOne(h), questions, recommendation(content, rationale), ...later);
  const inspection = await recordInspection(h.session, h.context);
  const one = await runAnalyse(h.session, h.deps, {
    context: h.context,
    inspection,
    destination: h.destination,
  });
  if (one.kind !== "completed") throw new Error(`call 1: ${one.kind}`);
  const run = { sent: one.sent, inspection, destination: h.destination };
  const three = await runGenerateQuestions(h.session, h.deps, run);
  if (three.kind !== "completed") throw new Error(`call 3: ${three.kind}`);
  const question = h.session.records.find((r) => r.type === "question") as { questionId: string };
  const { decision } = await h.session.change((log) =>
    answerQuestion(log, {
      questionId: question.questionId,
      statement: "The tests run in CI too.",
      scope: { kind: "repository" },
      exceptions: [],
      actor: "developer",
      decidedAt: "2026-11-01T10:20:00.000Z",
    }),
  );
  const four = await runRecommend(h.session, h.deps, run);
  if (four.kind !== "completed") throw new Error(`call 4: ${four.kind}`);
  return { h, run, questionId: question.questionId, decisionId: decision.id };
}
