import { describe, expect, it } from "vitest";
import type { AssemblyDestination } from "../assembly/assemble.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import { buildExclusionRules } from "../snapshot/exclusions.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { createAliasTable } from "./aliases.js";
import { coverageIndex } from "./coverage.js";
import type { Accepted } from "./pipeline.js";
import {
  IMPERATIVE_VERBS,
  type RecommendationItem,
  type RecommendContext,
  type RecommendDecision,
  type RecommendFinding,
  type RecommendQuestion,
  validateRecommend,
} from "./recommend.js";
import { anchorablePaths } from "./support.js";

// `recommend` item validation (IMPL §3.3.5): REC-001 to REC-010, SCOPE-001, DUP-004, HELD-001.

const DESTINATION = [
  "# Project", // B-1
  "",
  "Intro paragraph.", // B-2
  "",
  "## Commands", // B-3
  "",
  "- Run tests with care.", // B-4
  "- Build it.", // B-5
  "",
  "## Layout", // B-6
  "",
  "Source in src.", // B-7
  "",
].join("\n");

const WITHHELD = "src/secret-AKIAIOSFODNN7EXAMPLE.ts";
const PATHS = [
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "package.json",
  "scripts/build.sh",
  "src/a.ts",
  "src/b.ts",
  WITHHELD,
];

const claim = (
  mode: "descriptive" | "prescriptive",
  basis: RecommendFinding["basis"],
  excerpt: string,
  path = "src/a.ts",
  extra: Partial<RecommendFinding> = {},
): RecommendFinding => ({
  kind: "claim",
  mode,
  basis,
  current: true,
  evidence: [{ id: `ev_${path}`, kind: "lines", path, excerpt }],
  ...extra,
});

const FINDINGS: Record<string, RecommendFinding> = {
  "F-1": claim("descriptive", ["code_observation"], "export const a = 1;"),
  "F-2": claim(
    "prescriptive",
    ["documentation"],
    "You must run pnpm lint before committing.",
    "CONTRIBUTING.md",
  ),
  "F-3": claim("descriptive", ["existing_guidance"], "Tests live next to code.", "CLAUDE.md"),
  "F-4": { kind: "gap", basis: [], current: true, evidence: [] },
  "F-5": {
    kind: "absence",
    basis: ["code_observation"],
    current: true,
    evidence: [{ id: "ev_abs", kind: "absence_check" }],
  },
  "F-6": claim("descriptive", ["code_observation"], '"test": "vitest run",', "package.json", {
    command: { file: "package.json", name: "test" },
  }),
  "F-7": claim("descriptive", ["code_observation"], "export const b = 2;", "src/b.ts", {
    current: false,
  }),
  "F-8": claim(
    "prescriptive",
    ["documentation"],
    "Always use the fetch wrapper.",
    "CONTRIBUTING.md",
  ),
  "F-9": claim("descriptive", ["code_observation"], "await fetch(url)", "src/b.ts"),
  "F-10": claim("descriptive", ["code_observation"], "export const c = 3;", "src/b.ts"),
  "F-11": {
    kind: "claim",
    mode: "descriptive",
    basis: ["code_observation"],
    current: true,
    evidence: [{ id: "ev_build", kind: "entry", path: "scripts/build.sh" }],
  },
  "F-12": claim(
    "descriptive",
    ["documentation"],
    "Run `cargo fmt --check` before pushing.",
    "CONTRIBUTING.md",
  ),
  "F-13": claim("descriptive", ["code_observation"], "all:\n\tgo build ./...", "Makefile", {
    command: { file: "Makefile", name: "all" },
  }),
};

const DECISIONS: Record<string, RecommendDecision> = {
  "D-1": { current: true, statement: "Use pnpm for every script.", exceptions: [] },
  "D-2": { current: false, statement: "Use npm.", exceptions: [] },
  "D-3": { current: true, statement: "Keep the old client.", exceptions: ["legacyClient stays."] },
};

const CONFLICTS = {
  "C-1": { members: ["F-8", "F-9"], status: "unresolved" as const },
  "C-2": { members: ["F-2", "F-1"], status: "resolved" as const },
};

const QUESTIONS: Record<string, RecommendQuestion> = {
  "Q-1": { status: "skipped", resolves: ["F-10"] },
  "Q-2": { status: "answered", resolves: ["F-4"] },
  "Q-3": { status: "unreached", resolves: ["C-1"] },
};

function presentDestination(text: string): AssemblyDestination {
  const bytes = new TextEncoder().encode(text);
  return { state: "present", bytes, parsed: parseGuidanceBlocks(bytes) };
}

function context(destination: AssemblyDestination = presentDestination(DESTINATION)) {
  const blocks = destination.state === "present" ? destination.parsed.blocks : [];
  const files = PATHS.map(
    (path) => ({ path, status: "read", size: 1, hash: sha256(new Uint8Array()) }) as SnapshotFile,
  );
  const value: RecommendContext = {
    aliases: createAliasTable("recommend", {
      findings: Object.keys(FINDINGS).map((alias) => `record:${alias}`),
      conflicts: Object.keys(CONFLICTS).map((alias) => `record:${alias}`),
      questions: Object.keys(QUESTIONS).map((alias) => `record:${alias}`),
      decisions: Object.keys(DECISIONS).map((alias) => `record:${alias}`),
      blocks: blocks.map((b) => ({ blockId: b.blockId, hash: b.hash })),
    }),
    coverage: coverageIndex(
      {
        files,
        exclusions: buildExclusionRules({ userExclusions: [] }),
        ignoreRules: { state: "applied" } as never,
      },
      [],
    ),
    anchorable: anchorablePaths(PATHS),
    destination,
    input: {
      findings: new Map(Object.entries(FINDINGS)),
      decisions: new Map(Object.entries(DECISIONS)),
      conflicts: new Map(Object.entries(CONFLICTS)),
      questions: new Map(Object.entries(QUESTIONS)),
    },
  };
  return value;
}

type Rec = Record<string, unknown>;

const base = (extra: Rec = {}): Rec => ({
  key: "r1",
  kind: "fact",
  operation: "add",
  target: { kind: "after", block: "B-2" },
  content: "Source files are TypeScript.",
  rationale: "Observed in the source.",
  support: ["F-1"],
  references: [],
  scope: { kind: "repository" },
  ...extra,
});

function run(
  recommendations: Rec[],
  rest: { heldBack?: Rec[]; noChangeReason?: string } = {},
  ctx: RecommendContext = context(),
) {
  const response = { recommendations, heldBack: rest.heldBack ?? [], ...rest };
  return validateRecommend(JSON.stringify(response), ctx);
}

/** The rules of the events, `itemKey:rule`, in order. */
function events(result: ReturnType<typeof run>): string[] {
  return result.result.events.map((e) => `${e.itemKey}:${e.rule}`);
}

function accepted(outcome: ReturnType<typeof run>): readonly Accepted<RecommendationItem>[] {
  if (outcome.result.status !== "validated") throw new Error("schema failed");
  return outcome.result.accepted.recommendations;
}

function one(rec: Rec, ctx?: RecommendContext): string[] {
  return events(run([rec], {}, ctx));
}

describe("recommend validation (IMPL §3.3.5)", () => {
  it("accepts a valid fact addition", () => {
    const outcome = run([base()]);
    expect(events(outcome)).toEqual([]);
    expect(outcome.result.status).toBe("validated");
  });

  describe("step 1: aliases and REC-001", () => {
    it("rejects support of the wrong kind or unknown (ALIAS-003, ALIAS-001)", () => {
      expect(one(base({ support: ["C-1"] }))).toEqual(["r1:ALIAS-003"]);
      expect(one(base({ support: ["Q-1"] }))).toEqual(["r1:ALIAS-003"]);
      expect(one(base({ support: ["F-99"] }))).toEqual(["r1:ALIAS-001"]);
      expect(one(base({ target: { kind: "after", block: "B-99" } }))).toEqual(["r1:ALIAS-001"]);
    });

    it("accepts only F aliases as a reference's support (ALIAS-003)", () => {
      expect(
        one(
          base({
            support: ["F-1", "D-1"],
            references: [{ kind: "path", value: "src/a.ts", support: "D-1" }],
          }),
        ),
      ).toEqual(["r1:ALIAS-003"]);
    });

    it("rejects support that is no longer current (REC-001)", () => {
      expect(one(base({ support: ["F-7"] }))).toEqual(["r1:REC-001"]);
      expect(one(base({ support: ["F-1", "D-2"] }))).toEqual(["r1:REC-001"]);
    });

    it("rejects a reference supported by a finding that is no longer current (REC-001)", () => {
      expect(
        one(
          base({
            support: ["F-1"],
            references: [{ kind: "path", value: "src/b.ts", support: "F-7" }],
          }),
        ),
      ).toEqual(["r1:REC-001"]);
    });
  });

  describe("step 2: operation and target (REC-002)", () => {
    it("rejects an operation that doesn't fit its target or content", () => {
      expect(one(base({ operation: "revise" }))).toEqual(["r1:REC-002"]);
      expect(one(base({ target: { kind: "block", block: "B-2" } }))).toEqual(["r1:REC-002"]);
      expect(one(base({ operation: "remove", target: { kind: "block", block: "B-2" } }))).toEqual([
        "r1:REC-002",
      ]);
      const { content: _content, ...noContent } = base();
      expect(one(noContent)).toEqual(["r1:REC-002"]);
    });

    it("rejects a section target or newSection after that isn't a heading", () => {
      expect(one(base({ target: { kind: "section", heading: "B-2" } }))).toEqual(["r1:REC-002"]);
      expect(one(base({ target: { kind: "newSection", heading: "X", after: "B-2" } }))).toEqual([
        "r1:REC-002",
      ]);
    });

    it("accepts heading targets for section and newSection", () => {
      expect(one(base({ target: { kind: "section", heading: "B-3" } }))).toEqual([]);
      expect(one(base({ target: { kind: "newSection", heading: "X", after: "B-3" } }))).toEqual([]);
    });

    it("allows only a newSection without after when the destination is absent", () => {
      const absent = context({ state: "absent" });
      expect(one(base({ target: { kind: "newSection", heading: "X", after: "B-1" } }), absent))
        // An absent destination has no blocks, so the alias is unknown.
        .toEqual(["r1:ALIAS-001"]);
      expect(one(base({ target: { kind: "newSection", heading: "Notes" } }), absent)).toEqual([]);
    });

    it("allows only a newSection without after when the round trip failed", () => {
      const bytes = new TextEncoder().encode("# Broken\n\ntext\n");
      const failed = context({
        state: "present",
        bytes,
        parsed: {
          blocks: [
            {
              blockId: "other-1",
              type: "other",
              headingPath: [],
              sourceSpan: { start: 0, end: bytes.length - 1 },
              hash: sha256(bytes.subarray(0, bytes.length - 1)),
            },
          ],
          lineEndings: { style: "lf", counts: { lf: 3, crlf: 0, cr: 0 } },
          roundTrip: { state: "failed", reason: "rebuild_mismatch" },
        },
      });
      expect(one(base({ target: { kind: "after", block: "B-1" } }), failed)).toEqual([
        "r1:REC-002",
      ]);
      expect(one(base({ target: { kind: "newSection", heading: "Notes" } }), failed)).toEqual([]);
    });
  });

  describe("step 3: content shape (REC-003)", () => {
    const revise = (block: string, content: string) =>
      base({ operation: "revise", target: { kind: "block", block }, content });
    const addAfter = (block: string, content: string) =>
      base({ target: { kind: "after", block }, content });

    it("revises a heading only as one ATX line of the same level", () => {
      expect(one(revise("B-3", "### Commands"))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-3", "## Commands\n\nMore text."))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-3", "Commands\n--------"))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-3", "## Build commands"))).toEqual([]);
    });

    it("revises a list item only with the same marker and indentation", () => {
      expect(one(revise("B-4", "* Run tests with care."))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-4", "  - Run tests with care."))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-4", "Tests run with care."))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-4", "- Tests run with care."))).toEqual([]);
    });

    it("revises another block with exactly one block of its type", () => {
      expect(one(revise("B-2", "One.\n\nTwo."))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-2", "- A list item."))).toEqual(["r1:REC-003"]);
      expect(one(revise("B-2", "\n\nAn intro paragraph.\n\n"))).toEqual([]);
    });

    it("adds one to five paragraphs, list items or code blocks, no headings", () => {
      expect(one(addAfter("B-2", "## Heading\n\nText."))).toEqual(["r1:REC-003"]);
      expect(one(addAfter("B-2", ["A.", "B.", "C.", "D.", "E.", "F."].join("\n\n")))).toEqual([
        "r1:REC-003",
      ]);
      expect(one(addAfter("B-2", ["A.", "B.", "C.", "D.", "E."].join("\n\n")))).toEqual([]);
    });

    it("places a list item after a list item only with its indentation and bullet", () => {
      expect(one(addAfter("B-5", "* Another step."))).toEqual(["r1:REC-003"]);
      expect(one(addAfter("B-5", "1. Another step."))).toEqual(["r1:REC-003"]);
      expect(one(addAfter("B-5", "- Another step."))).toEqual([]);
    });

    it("rejects an indented code block after a list item through assembly", () => {
      expect(one(addAfter("B-5", "    code here"))).toEqual(["r1:REC-003"]);
    });

    it("needs a one-line, non-empty heading for a new section", () => {
      expect(one(base({ target: { kind: "newSection", heading: " \t" } }))).toEqual(["r1:REC-003"]);
      expect(one(base({ target: { kind: "newSection", heading: "A\nB" } }))).toEqual([
        "r1:REC-003",
      ]);
    });

    it("accepts a remove of a heading as one recommendation for its section", () => {
      const { content: _content, ...rest } = base();
      expect(
        one({ ...rest, operation: "remove", target: { kind: "block", block: "B-3" } }),
      ).toEqual([]);
    });
  });

  describe("step 4: evidence rules", () => {
    it("rejects support from existing guidance alone, for every operation (REC-004)", () => {
      expect(one(base({ support: ["F-3"] }))).toEqual(["r1:REC-004"]);
      expect(
        one(
          base({
            operation: "revise",
            target: { kind: "block", block: "B-2" },
            content: "Intro text.",
            support: ["F-3"],
          }),
        ),
      ).toEqual(["r1:REC-004"]);
      expect(one(base({ support: ["F-3", "F-1"] }))).toEqual([]);
    });

    it("needs a decision or uncontested documented prescriptive support for policy (REC-005)", () => {
      const policy = (support: string[]) =>
        base({ kind: "policy", content: "Lint before committing.", support });
      expect(one(policy(["F-1"]))).toEqual(["r1:REC-005"]);
      expect(one(policy(["F-8"]))).toEqual(["r1:REC-005"]);
      expect(one(policy(["F-2"]))).toEqual([]);
      expect(one(policy(["D-1"]))).toEqual([]);
    });

    it("lets a fact cite only descriptive findings and decisions, never a gap (REC-006)", () => {
      expect(one(base({ support: ["F-2"] }))).toEqual(["r1:REC-006"]);
      expect(one(base({ support: ["F-4"] }))).toEqual(["r1:REC-006"]);
      expect(
        one(base({ kind: "policy", content: "Lint first.", support: ["D-1", "F-4"] })),
      ).toEqual(["r1:REC-006"]);
      expect(one(base({ support: ["D-1"] }))).toEqual([]);
    });

    it("rejects an absence claim as support (REC-010)", () => {
      expect(one(base({ support: ["F-5"] }))).toEqual(["r1:REC-010"]);
      expect(one(base({ support: ["F-1", "F-5"] }))).toEqual(["r1:REC-010"]);
      expect(
        one(base({ kind: "policy", content: "Lint first.", support: ["D-1", "F-5"] })),
      ).toEqual(["r1:REC-010"]);
    });
  });

  describe("step 5: directive-language guard (REC-007)", () => {
    const fact = (content: string) => base({ content });

    it("pins the imperative verbs", () => {
      expect(IMPERATIVE_VERBS).toEqual([
        "use",
        "prefer",
        "avoid",
        "always",
        "never",
        "run",
        "do not",
      ]);
    });

    it("rejects directive words anywhere in a fact's prose", () => {
      expect(one(fact("Contributors must lint."))).toEqual(["r1:REC-007"]);
      expect(one(fact("Code here should be typed."))).toEqual(["r1:REC-007"]);
      expect(one(fact("Tests don’t hit the network."))).toEqual(["r1:REC-007"]);
    });

    it("rejects an imperative verb at each kind of sentence start", () => {
      expect(one(fact("Use pnpm."))).toEqual(["r1:REC-007"]);
      expect(one(fact("- Run the tests."))).toEqual(["r1:REC-007"]);
      expect(one(fact("Tests are fast. Avoid flaky ones."))).toEqual(["r1:REC-007"]);
      expect(one(fact("Is it fast? Run it."))).toEqual(["r1:REC-007"]);
      expect(one(fact("Done! Use it."))).toEqual(["r1:REC-007"]);
      expect(one(fact("**Use** pnpm."))).toEqual(["r1:REC-007"]);
      expect(
        one(
          base({
            operation: "revise",
            target: { kind: "block", block: "B-3" },
            content: "## Run commands",
          }),
        ),
      ).toEqual(["r1:REC-007"]);
    });

    it("leaves inline code, code blocks and inflections unchecked", () => {
      // D-1's statement holds `Use`, so REF-005 finds the identifier.
      expect(one(base({ content: "`Use` is a function name.", support: ["F-1", "D-1"] }))).toEqual(
        [],
      );
      expect(one(fact("The build uses esbuild."))).toEqual([]);
      expect(one(fact("```\nUse this\n```"))).toEqual([]);
      expect(one(fact("The runner is fast.Use it"))).toEqual([]);
    });

    it("doesn't check policy content", () => {
      expect(one(base({ kind: "policy", content: "Use pnpm.", support: ["D-1"] }))).toEqual([]);
    });
  });

  describe("step 6: unresolved dependencies (REC-008)", () => {
    it("rejects support in an unresolved conflict", () => {
      expect(
        one(base({ kind: "policy", content: "Wrap fetch.", support: ["F-8", "D-1"] })),
      ).toEqual(["r1:REC-008"]);
      expect(one(base({ support: ["F-9"] }))).toEqual(["r1:REC-008"]);
    });

    it("rejects support resolved only by a skipped or unreached question", () => {
      expect(one(base({ support: ["F-10"] }))).toEqual(["r1:REC-008"]);
      expect(one(base({ support: ["F-10", "F-1"] }))).toEqual([]);
      expect(one(base({ support: ["F-10", "D-1"] }))).toEqual([]);
    });
  });

  it("checks scope paths (SCOPE-001)", () => {
    expect(one(base({ scope: { kind: "paths", paths: ["nowhere/"] } }))).toEqual(["r1:SCOPE-001"]);
    expect(one(base({ scope: { kind: "paths", paths: ["src/"] } }))).toEqual([]);
  });

  describe("cross-item", () => {
    it("keeps the first of two identical recommendations (DUP-004)", () => {
      const outcome = run([base(), base({ key: "r2", rationale: "Other words." })]);
      expect(events(outcome)).toEqual(["r2:DUP-004"]);
      expect(accepted(outcome).map((r) => r.key)).toEqual(["r1"]);
    });

    it("compares content after line-ending conversion, and targets after resolution", () => {
      const a = base({ content: "One.\n\nTwo." });
      const b = base({ key: "r2", content: "One.\r\n\r\nTwo." });
      expect(events(run([a, b]))).toEqual(["r2:DUP-004"]);
      const c = base({ key: "r2", target: { kind: "after", block: "B-7" } });
      expect(events(run([base(), c]))).toEqual([]);
    });

    it("drops held-back entries not blocked by a skipped or unreached question or an unresolved conflict (HELD-001)", () => {
      const outcome = run([], {
        heldBack: [
          { topic: "a", blockedBy: ["Q-1", "C-1"] },
          { topic: "b", blockedBy: ["Q-2"] },
          { topic: "c", blockedBy: ["C-2"] },
          { topic: "d", blockedBy: ["Q-3", "Q-2"] },
          { topic: "e", blockedBy: ["F-1"] },
        ],
      });
      expect(events(outcome)).toEqual([
        "heldBack/4:ALIAS-003",
        "heldBack/1:HELD-001",
        "heldBack/2:HELD-001",
        "heldBack/3:HELD-001",
      ]);
    });

    it("accepts noChangeReason only when no recommendation was proposed (REC-009)", () => {
      expect(events(run([], { noChangeReason: "Nothing to change." }))).toEqual([]);
      expect(events(run([base()], { noChangeReason: "Nothing." }))).toEqual([
        "noChangeReason:REC-009",
      ]);
      // As proposed, before validation: a rejected recommendation still counts.
      expect(events(run([base({ support: ["F-99"] })], { noChangeReason: "Nothing." }))).toEqual([
        "r1:ALIAS-001",
        "noChangeReason:REC-009",
      ]);
    });

    it("runs DUP-004, then HELD-001, then REC-009", () => {
      const outcome = run([base(), base({ key: "r2" })], {
        heldBack: [{ topic: "b", blockedBy: ["Q-2"] }],
        noChangeReason: "Nothing.",
      });
      expect(events(outcome)).toEqual([
        "r2:DUP-004",
        "heldBack/0:HELD-001",
        "noChangeReason:REC-009",
      ]);
    });
  });

  describe("step 7: references", () => {
    const path = (value: string, support = "F-1") => ({ kind: "path", value, support });
    const command = (value: string, support = "F-6") => ({ kind: "command", value, support });
    const withRefs = (content: string, references: Rec[], support = ["F-1", "F-6"]) =>
      base({ content, references, support });

    it("REF-001 rejects an undeclared reference and a declared one missing from the content", () => {
      expect(one(withRefs("Code is in `src/a.ts`.", []))).toEqual(["r1:REF-001"]);
      expect(one(withRefs("Code is in TypeScript.", [path("src/a.ts")]))).toEqual(["r1:REF-001"]);
      expect(one(withRefs("Code is in `src/a.ts`.", [path("src/a.ts")]))).toEqual([]);
    });

    it("REF-001 compares the declared kind: ./scripts/build.sh is a path, with flags a command", () => {
      const support = ["F-11"];
      expect(
        one(
          withRefs(
            "`./scripts/build.sh` builds it.",
            [path("./scripts/build.sh", "F-11")],
            support,
          ),
        ),
      ).toEqual([]);
      expect(
        one(
          withRefs(
            "`./scripts/build.sh` builds it.",
            [command("./scripts/build.sh", "F-11")],
            support,
          ),
        ),
      ).toEqual(["r1:REF-001"]);
    });

    it("REF-002 rejects an unlisted, `..` or withheld path, and accepts normalised forms", () => {
      expect(one(withRefs("See `src/nope.ts`.", [path("src/nope.ts")]))).toEqual(["r1:REF-002"]);
      expect(one(withRefs("See `src/../src/a.ts`.", [path("src/../src/a.ts")]))).toEqual([
        "r1:REF-002",
      ]);
      expect(one(withRefs(`See \`${WITHHELD}\`.`, [path(WITHHELD)]))).toEqual(["r1:REF-002"]);
      expect(one(withRefs("See `./src/a.ts`.", [path("./src/a.ts")]))).toEqual([]);
      expect(one(withRefs("Code is under `src/`.", [path("src/")]))).toEqual([]);
    });

    it("REF-003 accepts a known command in each form, with arguments only from code", () => {
      for (const form of [
        "npm run test",
        "npm test",
        "pnpm test",
        "pnpm run test",
        "yarn test",
        "yarn run test",
        "bun run test",
        "pnpm test --watch",
      ])
        expect(one(withRefs(`The suite runs with \`${form}\`.`, [command(form)])), form).toEqual(
          [],
        );
      expect(
        one(withRefs("The default target is `make all`.", [command("make all", "F-13")], ["F-13"])),
      ).toEqual([]);
      expect(one(withRefs("The suite runs with pnpm test.", [command("pnpm test")]))).toEqual([]);
    });

    it("REF-003 rejects an unknown command, and a plain-text command with words after it", () => {
      expect(one(withRefs("It starts with `npm start`.", [command("npm start")]))).toEqual([
        "r1:REF-003",
      ]);
      expect(one(withRefs("Lint with `pnpm lint`.", [command("pnpm lint")]))).toEqual([
        "r1:REF-003",
      ]);
      expect(
        one(withRefs("The suite is pnpm test --watch here.", [command("pnpm test --watch here")])),
      ).toEqual(["r1:REF-003"]);
      expect(one(withRefs("It is `pnpm testing`.", [command("pnpm testing")]))).toEqual([
        "r1:REF-003",
      ]);
    });

    it("REF-003 accepts a command found as written in an excerpt of its finding", () => {
      expect(
        one(
          withRefs(
            "Formatting is checked by `cargo fmt --check`.",
            [command("cargo fmt --check", "F-12")],
            ["F-12"],
          ),
        ),
      ).toEqual([]);
    });

    it("REF-004 needs the reference's finding in support, with evidence holding the value", () => {
      expect(one(withRefs("Code is in `src/a.ts`.", [path("src/a.ts", "F-6")], ["F-1"]))).toEqual([
        "r1:REF-004",
      ]);
      expect(one(withRefs("Code is in `src/b.ts`.", [path("src/b.ts")], ["F-1"]))).toEqual([
        "r1:REF-004",
      ]);
    });

    it("REF-004 records the first evidence that holds the value, and verification", () => {
      const outcome = run([
        withRefs("Code is in `src/a.ts`; run `pnpm test`.", [
          path("src/a.ts"),
          command("pnpm test"),
        ]),
      ]);
      expect(events(outcome)).toEqual([]);
      expect(accepted(outcome)[0]?.value.resolvedReferences).toEqual([
        {
          kind: "path",
          value: "src/a.ts",
          support: "F-1",
          evidenceId: "ev_src/a.ts",
          verification: "exists_in_snapshot",
        },
        {
          kind: "command",
          value: "pnpm test",
          support: "F-6",
          evidenceId: "ev_package.json",
          verification: "found_not_run",
        },
      ]);
    });

    it("REF-005 needs an identifier in a supporting excerpt or decision", () => {
      expect(one(withRefs("The `fetchWidget` helper wraps HTTP.", []))).toEqual(["r1:REF-005"]);
      expect(one(withRefs("Docs are at `https://example.com/docs.md`.", []))).toEqual([
        "r1:REF-005",
      ]);
      expect(one(withRefs("The `legacyClient` is kept.", [], ["F-1", "D-3"]))).toEqual([]);
      expect(one(withRefs("The constant `a` is exported.", []))).toEqual([]);
    });

    it("runs the REF rules after REC-008 and before SCOPE-001", () => {
      expect(
        one(
          base({
            content: "Code is in `src/nope.ts`.",
            support: ["F-9"],
            scope: { kind: "paths", paths: ["nowhere"] },
          }),
        ),
      ).toEqual(["r1:REC-008"]);
      expect(
        one(
          base({
            content: "Code is in `src/nope.ts`.",
            scope: { kind: "paths", paths: ["nowhere"] },
          }),
        ),
      ).toEqual(["r1:REF-001"]);
    });
  });

  it("resolves an accepted recommendation's target to its block", () => {
    const outcome = run([base()]);
    const first = accepted(outcome)[0];
    const ctx = context();
    const b2 = ctx.aliases.entries.find((e) => e.alias === "B-2")?.target as {
      blockId: string;
      hash: string;
    };
    expect(first?.value.resolvedTarget).toEqual({
      kind: "after",
      blockId: b2.blockId,
      blockHash: b2.hash,
    });
  });
});
