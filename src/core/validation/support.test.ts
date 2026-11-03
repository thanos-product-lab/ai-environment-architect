import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Basis, Evidence } from "./citations.js";
import {
  type AcceptedItems,
  accept,
  type CallValidator,
  VALIDATOR_VERSION,
  validateResponse,
} from "./pipeline.js";
import {
  anchorablePaths,
  checkSupport,
  DIRECTIVE_WORDS,
  distinctSourcesCheck,
  hasDistinctSources,
  NUMBER_WORDS,
  QUANTITY_WORDS,
  type SupportContext,
  type SupportedFinding,
  supportCheck,
  UNIVERSAL_WORDS,
} from "./support.js";

// Support checks (IMPL §3.2.3): what code can check about whether a finding's accepted citations
// justify its statement. They run after provenance, on the evidence code extracted.

const WITHHELD = "keys/AKIAIOSFODNN7EXAMPLE.txt";

const context: SupportContext = {
  anchorable: anchorablePaths([
    "README.md",
    "apps/web/src/api.ts",
    "packages/ui/package.json",
    WITHHELD,
  ]),
};

function ev(excerpt: string, basis: Basis = "code_observation", path = "src/a.ts"): Evidence {
  return {
    kind: "lines",
    path,
    fileHash: "sha256:1111",
    lineStart: 1,
    lineEnd: 1,
    excerpt,
    basis,
  };
}

function finding(
  statement: string,
  evidence: Evidence[],
  mode: SupportedFinding["mode"] = "descriptive",
): SupportedFinding {
  return { statement, mode, evidence };
}

function rule(f: SupportedFinding): string | null {
  const result = checkSupport(f, context);
  return result.ok ? null : result.rule;
}

describe("anchorable paths (IMPL §1.11)", () => {
  it("holds entries and the directories that contain them, never a withheld path", () => {
    expect([...context.anchorable]).toEqual([
      "README.md",
      "apps",
      "apps/web",
      "apps/web/src",
      "apps/web/src/api.ts",
      "keys",
      "packages",
      "packages/ui",
      "packages/ui/package.json",
    ]);
  });

  it("does not depend on the order entries are given in", () => {
    const shuffled = anchorablePaths([
      WITHHELD,
      "packages/ui/package.json",
      "apps/web/src/api.ts",
      "README.md",
    ]);
    expect([...shuffled]).toEqual([...context.anchorable]);
  });
});

describe("SUP-001 anchoring", () => {
  it("SUP-001 accepts inline code that appears in a cited excerpt", () => {
    expect(rule(finding("Requests go through `fetchJson`.", [ev("return fetchJson(url);")]))).toBe(
      null,
    );
  });

  it("SUP-001 rejects inline code in no cited excerpt and no listed path", () => {
    expect(rule(finding("Requests go through `httpGet`.", [ev("return fetchJson(url);")]))).toBe(
      "SUP-001",
    );
  });

  it("SUP-001 matches exactly, with case", () => {
    expect(rule(finding("Requests go through `FetchJson`.", [ev("return fetchJson(url);")]))).toBe(
      "SUP-001",
    );
  });

  it("SUP-001 accepts a listed path, file or directory, with one trailing slash", () => {
    const evidence = [ev("export const api = 1;")];
    expect(rule(finding("The client lives in `apps/web/src/api.ts`.", evidence))).toBe(null);
    expect(rule(finding("The web app is under `apps/web/`.", evidence))).toBe(null);
    expect(rule(finding("The web app is under `apps/web//`.", evidence))).toBe("SUP-001");
  });

  it("SUP-001 accepts a bare path-like token that is listed, with trailing punctuation", () => {
    const evidence = [ev("export const api = 1;")];
    expect(rule(finding("See apps/web/src/api.ts.", evidence))).toBe(null);
    expect(rule(finding("UI config (packages/ui/package.json) is separate.", evidence))).toBe(null);
  });

  it("SUP-001 rejects a bare path-like token that is neither cited nor listed", () => {
    expect(rule(finding("See apps/web/src/client.ts for details.", [ev("const x = 1;")]))).toBe(
      "SUP-001",
    );
  });

  it("SUP-001 leaves bare text that is not path-like alone", () => {
    const evidence = [ev("const x = 1;")];
    expect(rule(finding("Reads and/or writes the README.md file.", evidence))).toBe(null);
    expect(rule(finding("Handles TCP/IP settings in apps/web.", evidence))).toBe(null);
  });

  it("SUP-001 removes one leading ./ before matching the file list", () => {
    const evidence = [ev("const x = 1;")];
    expect(rule(finding("The client is `./apps/web/src/api.ts`.", evidence))).toBe(null);
    expect(rule(finding("See ./apps/web/src/api.ts.", evidence))).toBe(null);
    expect(rule(finding("The web app is under `./apps/web/`.", evidence))).toBe(null);
    expect(rule(finding("The client is `././apps/web/src/api.ts`.", evidence))).toBe("SUP-001");
  });

  it("SUP-001 never resolves ../", () => {
    const evidence = [ev("const x = 1;")];
    expect(rule(finding("See `apps/web/../web/src/api.ts`.", evidence))).toBe("SUP-001");
    expect(rule(finding("See ../README.md.", evidence))).toBe("SUP-001");
  });

  it("SUP-001 matches excerpts with the token as written", () => {
    expect(rule(finding("Formats in `./format.ts`.", [ev("import dateformat.ts")]))).toBe(
      "SUP-001",
    );
    expect(rule(finding("Formats in `./format.ts`.", [ev("import './format.ts'")]))).toBe(null);
  });

  it("SUP-001 never accepts a withheld path as listed", () => {
    expect(rule(finding(`A key file sits at \`${WITHHELD}\`.`, [ev("const x = 1;")]))).toBe(
      "SUP-001",
    );
  });

  it("SUP-001 treats an unpaired backtick as plain text", () => {
    expect(rule(finding("A stray ` backtick here.", [ev("const x = 1;")]))).toBe(null);
  });

  it("SUP-001 pairs backticks from the left, empty pairs included", () => {
    expect(rule(finding("Uses `` and `x` here.", [ev("x")]))).toBe(null);
    expect(rule(finding("Use `` most `` files.", [ev("x")]))).toBe("SUP-002");
  });

  it("SUP-001 gives a detail without the token", () => {
    const result = checkSupport(finding("Uses `secretThing`.", [ev("const x = 1;")]), context);
    expect(result).toEqual({
      ok: false,
      rule: "SUP-001",
      detail: "inline code not in a cited excerpt or the file list",
    });
  });
});

describe("SUP-002 no model counts", () => {
  it("SUP-002 rejects a number that no cited excerpt holds", () => {
    expect(rule(finding("The app has 5 components.", [ev("export function A() {}")]))).toBe(
      "SUP-002",
    );
  });

  it("SUP-002 accepts a number that a cited excerpt holds as a whole number", () => {
    expect(rule(finding("Requests time out after 5000 ms.", [ev("timeoutMs: 5000,")]))).toBe(null);
  });

  it("SUP-002 does not accept a number found only inside a longer one", () => {
    expect(rule(finding("Requests time out after 500 ms.", [ev("timeoutMs: 5000,")]))).toBe(
      "SUP-002",
    );
  });

  it("SUP-002 rejects a quantity word whatever its case", () => {
    expect(rule(finding("Most files export a default.", [ev("export default A;")]))).toBe(
      "SUP-002",
    );
    expect(rule(finding("Handlers usually return JSON.", [ev("return json(body);")]))).toBe(
      "SUP-002",
    );
  });

  it("SUP-002 matches whole words only", () => {
    // "fewer" is not "few", "almost" is not "most", "oftentimes" is not "often".
    expect(rule(finding("Fewer exports than almost oftentimes.", [ev("const x = 1;")]))).toBe(null);
  });

  it("SUP-002 accepts a spelled number that a cited excerpt holds", () => {
    expect(rule(finding("Retries happen three times.", [ev("// retry Three times")]))).toBe(null);
    expect(rule(finding("Retries happen three times.", [ev("retries: 3")]))).toBe("SUP-002");
  });

  it("SUP-002 ignores numbers and words inside anchored tokens", () => {
    expect(
      rule(finding("Version lives in `v2Config` and `most_recent`.", [ev("v2Config most_recent")])),
    ).toBe(null);
  });

  it("SUP-002 treats any Unicode decimal digit as a number, matched as written", () => {
    expect(rule(finding("The router has ٥ handlers.", [ev("const x = 1;")]))).toBe("SUP-002");
    expect(rule(finding("The router has ٥ handlers.", [ev("// ٥ handlers")]))).toBe(null);
    expect(rule(finding("Timeout is ５ seconds.", [ev("timeout = 5")]))).toBe("SUP-002");
    // A run ends at any decimal digit, so ٥ is not found inside ٥0.
    expect(rule(finding("The router has ٥ handlers.", [ev("// ٥0 handlers")]))).toBe("SUP-002");
  });

  it("SUP-002 does not count 'one'", () => {
    expect(rule(finding("The client is one of the entry points.", [ev("const x = 1;")]))).toBe(
      null,
    );
  });

  it("SUP-002 names the list entry, not the statement's text", () => {
    expect(checkSupport(finding("MOST files are small.", [ev("x")]), context)).toEqual({
      ok: false,
      rule: "SUP-002",
      detail: 'counted quantity "most"',
    });
    expect(checkSupport(finding("There are 7 of them.", [ev("x")]), context)).toEqual({
      ok: false,
      rule: "SUP-002",
      detail: "a number not in a cited excerpt",
    });
  });
});

describe("SUP-003 no universal claims from samples", () => {
  it("SUP-003 rejects a universal quantifier on code observations only", () => {
    expect(rule(finding("All handlers return JSON.", [ev("return json(body);")]))).toBe("SUP-003");
    for (const word of ["every", "always", "never", "none", "only"])
      expect(rule(finding(`Handlers ${word} return JSON.`, [ev("return json(body);")]))).toBe(
        "SUP-003",
      );
  });

  it("SUP-003 accepts the claim when some citation is documentation or guidance", () => {
    expect(
      rule(
        finding("All handlers return JSON.", [
          ev("return json(body);"),
          ev("Handlers return JSON.", "documentation", "docs/api.md"),
        ]),
      ),
    ).toBe(null);
  });

  it("SUP-003 does not apply to prescriptive findings", () => {
    expect(
      rule(
        finding(
          "Handlers must always return JSON.",
          [ev("Handlers must return JSON.", "documentation", "docs/api.md")],
          "prescriptive",
        ),
      ),
    ).toBe(null);
  });

  it("SUP-003 matches whole words only, and ignores anchored tokens", () => {
    expect(rule(finding("The install script is overall small.", [ev("x")]))).toBe(null);
    expect(rule(finding("Scripts call `npm run all`.", [ev("npm run all")]))).toBe(null);
  });

  it("SUP-003 runs after SUP-002", () => {
    expect(rule(finding("All 4 handlers return JSON.", [ev("return json(body);")]))).toBe(
      "SUP-002",
    );
  });
});

describe("SUP-004 prescriptive needs a prescriptive source", () => {
  const prescriptive = (evidence: Evidence[]) =>
    finding("Handlers return JSON.", evidence, "prescriptive");

  it("SUP-004 rejects a prescriptive finding citing only code", () => {
    expect(rule(prescriptive([ev("// always return JSON")]))).toBe("SUP-004");
  });

  it("SUP-004 rejects documentation without directive language", () => {
    expect(rule(prescriptive([ev("Handlers return JSON.", "documentation", "docs/api.md")]))).toBe(
      "SUP-004",
    );
  });

  it("SUP-004 accepts each directive word in documentation or guidance", () => {
    const sources = [
      "Handlers MUST return JSON.",
      "Handlers should return JSON.",
      "Always return JSON.",
      "Never return HTML.",
      "Do not return HTML.",
      "Don't return HTML.",
      "Don’t return HTML.",
      "JSON is required.",
      "Prefer JSON responses.",
      "Use JSON instead of XML.",
    ];
    for (const excerpt of sources) {
      expect(rule(prescriptive([ev(excerpt, "documentation", "docs/api.md")]))).toBe(null);
      expect(rule(prescriptive([ev(excerpt, "existing_guidance", "CLAUDE.md")]))).toBe(null);
    }
  });

  it("SUP-004 does not count inflections or parts of words", () => {
    for (const excerpt of ["JSON is preferred.", "It requires JSON.", "Mustard.", "unused"])
      expect(rule(prescriptive([ev(excerpt, "documentation", "docs/api.md")]))).toBe("SUP-004");
  });

  it("SUP-004 needs 'use' and 'instead' on the same line, in that order", () => {
    const doc = (excerpt: string) => prescriptive([ev(excerpt, "documentation", "docs/api.md")]);
    expect(rule(doc("Use JSON\ninstead of XML."))).toBe("SUP-004");
    expect(rule(doc("Instead, use JSON."))).toBe("SUP-004");
  });

  it("SUP-004 matches 'do not' only across spaces or tabs", () => {
    const doc = (excerpt: string) => prescriptive([ev(excerpt, "documentation", "docs/api.md")]);
    expect(rule(doc("Do \t not return HTML."))).toBe(null);
    for (const separator of ["\n", "\r", "\u00a0", "\u2028"])
      expect(rule(doc(`Do${separator}not return HTML.`))).toBe("SUP-004");
  });

  it("SUP-004 does not apply to descriptive findings", () => {
    expect(rule(finding("Handlers return JSON.", [ev("return json(body);")]))).toBe(null);
  });
});

describe("support check order (IMPL §3.2.3, §3.5)", () => {
  it("needs the evidence of the finding's accepted citations", () => {
    expect(() =>
      checkSupport({ statement: "Handlers return JSON.", mode: "descriptive" }, context),
    ).toThrow();
  });

  it("reports SUP-001 before any other rule", () => {
    expect(rule(finding("All 5 handlers use `httpGet`.", [ev("x")], "prescriptive"))).toBe(
      "SUP-001",
    );
  });

  it("rejects the item through the pipeline after its citations' events", () => {
    const schema = z.strictObject({
      findings: z.array(
        z.strictObject({
          key: z.string(),
          statement: z.string(),
          mode: z.enum(["descriptive", "prescriptive"]),
          excerpt: z.string(),
        }),
      ),
    });
    type Item = SupportedFinding & { key: string };
    const call: CallValidator<z.infer<typeof schema>, SupportContext, { findings: Item }> = {
      schema,
      order: ["findings"],
      collections: {
        findings: {
          items: (response) =>
            response.findings.map((f) => ({
              key: f.key,
              statement: f.statement,
              mode: f.mode,
              evidence: [ev(f.excerpt)],
            })),
          key: (item) => ({ kind: "local", key: item.key }),
          checks: [(item) => accept(item), supportCheck()],
        },
      },
      crossItem: [],
    };
    const result = validateResponse(
      call,
      JSON.stringify({
        findings: [
          { key: "f1", statement: "Most files are small.", mode: "descriptive", excerpt: "x" },
          { key: "f2", statement: "Files are small.", mode: "descriptive", excerpt: "x" },
        ],
      }),
      context,
    );
    expect(result.events).toEqual([
      {
        itemKey: "f1",
        stage: "item",
        rule: "SUP-002",
        outcome: "rejected",
        detail: 'counted quantity "most"',
      },
    ]);
    expect(result.status === "validated" && result.accepted.findings.map((f) => f.key)).toEqual([
      "f2",
    ]);
  });
});

describe("SUP-005 conflicts need distinct sources", () => {
  it("SUP-005 counts distinct file paths, not items", () => {
    expect(hasDistinctSources([["src/a.ts"], ["src/a.ts"]])).toBe(false);
    expect(hasDistinctSources([["src/a.ts", "src/a.ts"], []])).toBe(false);
    expect(hasDistinctSources([["src/a.ts"], ["docs/a.md"]])).toBe(true);
  });

  it("SUP-005 needs every member to cite a file that not every other member cites", () => {
    expect(hasDistinctSources([["src/a.ts", "docs/a.md"], ["src/a.ts"]])).toBe(false);
    expect(
      hasDistinctSources([
        ["src/a.ts", "docs/a.md"],
        ["docs/a.md", "src/a.ts"],
      ]),
    ).toBe(false);
    expect(hasDistinctSources([["src/a.ts", "docs/a.md"], ["src/b.ts"]])).toBe(true);
    expect(hasDistinctSources([["a.md"], ["a.md", "b.md"], ["b.md"]])).toBe(true);
    expect(hasDistinctSources([["a.md"], ["b.md"], []])).toBe(false);
    expect(hasDistinctSources([["a.md", "b.md"]])).toBe(false);
  });

  it("SUP-005 rejects a conflict whose findings cite one file, as a cross-item check", () => {
    type Finding = { key: string; paths: string[] };
    type Conflict = { key: string; findings: string[] };
    type Accepted = { findings: Finding; conflicts: Conflict };
    const check = distinctSourcesCheck<Accepted, SupportContext, "conflicts">({
      collection: "conflicts",
      memberPaths: (conflict, surviving) =>
        conflict.findings.map(
          (key) => surviving.findings.find((f) => f.key === key)?.value.paths ?? [],
        ),
    });
    const surviving: AcceptedItems<Accepted> = {
      findings: [
        {
          key: "f1",
          index: 0,
          value: { key: "f1", paths: ["src/a.ts"] },
          corrected: false,
          relabelled: false,
        },
        {
          key: "f2",
          index: 1,
          value: { key: "f2", paths: ["src/a.ts"] },
          corrected: false,
          relabelled: false,
        },
        {
          key: "f3",
          index: 2,
          value: { key: "f3", paths: ["docs/a.md"] },
          corrected: false,
          relabelled: false,
        },
      ],
      conflicts: [
        {
          key: "c1",
          index: 0,
          value: { key: "c1", findings: ["f1", "f2"] },
          corrected: false,
          relabelled: false,
        },
        {
          key: "c2",
          index: 1,
          value: { key: "c2", findings: ["f1", "f3"] },
          corrected: false,
          relabelled: false,
        },
      ],
    };
    expect(check(surviving, context)).toEqual([
      {
        collection: "conflicts",
        index: 0,
        rule: "SUP-005",
        detail: "a member finding cites no file that not every other member cites",
      },
    ]);
  });
});

describe("word lists (IMPL §3.2.3)", () => {
  // Any change to a list changes what is accepted, so it must increase validatorVersion (§3.5).
  it("pins the versioned lists", () => {
    expect({
      version: VALIDATOR_VERSION,
      directive: DIRECTIVE_WORDS,
      universal: UNIVERSAL_WORDS,
      numbers: NUMBER_WORDS,
      quantities: QUANTITY_WORDS,
    }).toEqual({
      version: "validate/0.16.0",
      directive: ["must", "should", "always", "never", "do not", "don't", "required", "prefer"],
      universal: ["all", "every", "always", "never", "none", "only"],
      numbers: [
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "dozen",
        "dozens",
        "hundred",
        "hundreds",
        "thousand",
        "thousands",
      ],
      quantities: [
        "most",
        "many",
        "several",
        "few",
        "numerous",
        "majority",
        "minority",
        "half",
        "mostly",
        "usually",
        "often",
        "typically",
        "frequently",
        "rarely",
        "seldom",
        "multiple",
      ],
    });
  });
});
