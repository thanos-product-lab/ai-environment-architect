import { beforeEach, describe, expect, it } from "vitest";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { createAliasTable } from "./aliases.js";
import { coverageIndex } from "./coverage.js";
import {
  type QuestionContext,
  type QuestionInput,
  validateGenerateQuestions,
} from "./generate-questions.js";

// `generate_questions` item validation and ranking (IMPL §3.3.4).

const files: SnapshotFile[] = [
  { path: "src/a.ts", status: "read", size: 1, hash: "sha256:1" },
  { path: "docs/guide.md", status: "read", size: 1, hash: "sha256:2" },
];

const input: QuestionInput = {
  findings: new Map([
    ["F-1", { kind: "claim", basis: ["documentation"] }],
    ["F-2", { kind: "claim", basis: ["code_observation"] }],
    ["F-3", { kind: "gap", basis: [], gapType: "no_command" }],
    ["F-4", { kind: "gap", basis: [], gapType: "undetermined_convention" }],
    ["F-5", { kind: "claim", basis: ["documentation", "code_observation"] }],
    ["F-6", { kind: "claim", basis: ["documentation"] }],
    ["F-7", { kind: "gap", basis: [], gapType: "undetermined_ownership" }],
  ]),
  conflicts: new Map([
    ["C-1", { members: ["F-6", "F-2"], status: "unresolved" }],
    ["C-2", { members: ["F-1", "F-5"], status: "resolved" }],
  ]),
  budget: 2,
};

const context = (budget = 2): QuestionContext => ({
  aliases: createAliasTable("generate_questions", {
    findings: ["id1", "id2", "id3", "id4", "id5", "id6", "id7"],
    conflicts: ["c1", "c2"],
    blocks: [{ blockId: "Intro/paragraph-1", hash: "sha256:b" }],
  }),
  coverage: coverageIndex({ files, exclusions: [], ignoreRules: { state: "applied" } }, []),
  questions: { ...input, budget },
});

let n = 0;
const q = (resolves: string[], extra: Record<string, unknown> = {}) => ({
  key: `q${++n}`,
  prompt: "How should this work?",
  reason: "The evidence does not say.",
  resolves,
  scope: { kind: "repository" },
  options: [],
  ...extra,
});

beforeEach(() => {
  n = 0;
});

const run = (questions: unknown[], budget = 2) => {
  const outcome = validateGenerateQuestions(JSON.stringify({ questions }), context(budget));
  if (outcome.result.status !== "validated") throw new Error("schema failed");
  return {
    events: outcome.result.events.map((e) => [e.itemKey, e.rule]),
    presented: outcome.presented.map((item) => item.key),
    unreached: outcome.unreached.map((item) => item.key),
  };
};

describe("aliases (IMPL §3.3.4 step 1)", () => {
  it("ALIAS-003 rejects a B alias in resolves, and ALIAS-001 an unknown alias", () => {
    const result = run([q(["F-2", "B-1"]), q(["F-9"])]);
    expect(result.events).toEqual([
      ["q1", "ALIAS-003"],
      ["q2", "ALIAS-001"],
    ]);
  });
});

describe("Q-001 (IMPL §3.3.4 step 2)", () => {
  it("Q-001 rejects a question tied only to documented, uncontested findings", () => {
    expect(run([q(["F-1"]), q(["F-1", "F-5"])]).events).toEqual([
      ["q1", "Q-001"],
      ["q2", "Q-001"],
    ]);
  });

  it("Q-001 rejects a question tied only to a resolved conflict", () => {
    expect(run([q(["C-2"])]).events).toEqual([["q1", "Q-001"]]);
  });

  it("Q-001 accepts an unresolved conflict, a gap, an undocumented finding or a contested one", () => {
    const result = run([q(["C-1"]), q(["F-1", "F-3"]), q(["F-2"]), q(["F-6"])], 5);
    expect(result.events).toEqual([]);
  });
});

describe("SCOPE-001 (IMPL §3.3.4 step 3)", () => {
  it("SCOPE-001 rejects an unlisted scope path", () => {
    const result = run([
      q(["F-2"], { scope: { kind: "paths", paths: ["lib"] } }),
      q(["F-3"], { scope: { kind: "paths", paths: ["./src/"] } }),
    ]);
    expect(result.events).toEqual([["q1", "SCOPE-001"]]);
  });
});

describe("DUP-003 (IMPL §3.3.4 step 4)", () => {
  it("DUP-003 keeps the first of two questions with the same resolves set in another order", () => {
    const result = run([q(["F-2", "F-3"]), q(["F-3", "F-2", "F-3"]), q(["F-3"])], 5);
    expect(result.events).toEqual([["q2", "DUP-003"]]);
  });
});

describe("ranking (IMPL §3.3.4)", () => {
  it("ranks conflicts, then command and ownership gaps, then other gaps, then the rest", () => {
    const result = run([q(["F-2"]), q(["F-4"]), q(["F-7"]), q(["C-1"]), q(["F-3"])], 10);
    expect(result.presented).toEqual(["q4", "q3", "q5", "q2", "q1"]);
    expect(result.unreached).toEqual([]);
  });

  it("keeps the model's order within a class, and places a question in its first class", () => {
    const result = run([q(["F-4"]), q(["F-2", "C-1"]), q(["F-3", "F-4"]), q(["C-1", "F-3"])], 10);
    expect(result.presented).toEqual(["q2", "q4", "q3", "q1"]);
  });

  it("presents the budget, keeps the rest up to twice it unreached, and rejects beyond that", () => {
    const result = run([q(["F-2"]), q(["F-4"]), q(["F-7"]), q(["C-1"]), q(["F-3"])], 2);
    expect(result.presented).toEqual(["q4", "q3"]);
    expect(result.unreached).toEqual(["q5", "q2"]);
    expect(result.events).toEqual([["q1", "LIMIT-002"]]);
  });

  it("LIMIT-002 trims after validation, so rejected questions don't use up the limit", () => {
    const result = run([q(["F-1"]), q(["F-1"]), q(["F-2"]), q(["F-3"]), q(["F-4"])], 1);
    expect(result.events).toEqual([
      ["q1", "Q-001"],
      ["q2", "Q-001"],
      ["q3", "LIMIT-002"],
    ]);
    expect(result.presented).toEqual(["q4"]);
    expect(result.unreached).toEqual(["q5"]);
  });

  it("does not depend on the order of the input maps", () => {
    const reversed: QuestionContext = {
      ...context(10),
      questions: {
        findings: new Map([...input.findings].reverse()),
        conflicts: new Map([...input.conflicts].reverse()),
        budget: 10,
      },
    };
    const questions = [q(["F-2"]), q(["F-4"]), q(["C-1"])];
    const a = validateGenerateQuestions(JSON.stringify({ questions }), context(10));
    const b = validateGenerateQuestions(JSON.stringify({ questions }), reversed);
    expect(b.presented).toEqual(a.presented);
  });
});
