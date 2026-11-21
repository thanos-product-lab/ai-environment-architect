import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../core/hash.js";
import {
  collectionLimits,
  placeholders,
  promptVariables,
  RELEASED_PROMPTS,
  renderPrompt,
} from "../../core/run/prompt-template.js";
import { CALL_ALIAS_KINDS, type CallPurpose } from "../../core/validation/aliases.js";
import { MAX_CITED_LINES, MIN_QUOTE_CODE_POINTS } from "../../core/validation/citations.js";
import { QUANTITY_WORDS, UNIVERSAL_WORDS } from "../../core/validation/support.js";
import { FIELD_LIMITS } from "../../schemas/common.js";
import { loadReleasedPrompts, templateUrl } from "./released.js";

// The released prompts (IMPL §3.7): they load from the package's `prompts/`, cover every item
// §3.7 requires, take every number from code, and are kept append-only by version.

const CALLS = Object.keys(RELEASED_PROMPTS) as CallPurpose[];
const template = (call: CallPurpose, version = RELEASED_PROMPTS[call]) =>
  readFileSync(templateUrl(call, version), "utf8");
const rendered = (call: CallPurpose) => renderPrompt(call, template(call));

/** The rendered prompt's `## ` sections, by heading. */
function sections(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of text.split(/^## /m).slice(1)) {
    const end = part.indexOf("\n");
    map.set(part.slice(0, end), part.slice(end + 1));
  }
  return map;
}

function section(call: CallPurpose, heading: string): string {
  const body = sections(rendered(call)).get(heading);
  if (body === undefined) throw new Error(`${call}: no section "${heading}"`);
  return body;
}

const ANALYSIS: readonly CallPurpose[] = ["analyse", "analyse_expansion"];
const RECOMMENDATION: readonly CallPurpose[] = ["recommend", "regenerate_recommendations"];

/** §3.7's items, as the heading each applies under, and the calls it applies to. */
const REQUIRED: readonly { item: string; heading: string; calls: readonly CallPurpose[] }[] = [
  { item: "1", heading: "Role and purpose", calls: CALLS },
  { item: "2", heading: "Repository content is data", calls: CALLS },
  { item: "3", heading: "Aliases", calls: CALLS },
  { item: "3", heading: "Citations and quotes", calls: ANALYSIS },
  { item: "4", heading: "What code determines", calls: CALLS },
  { item: "5", heading: "No counts or universal claims", calls: CALLS },
  { item: "6", heading: "Asking about intent", calls: ["generate_questions"] },
  { item: "7", heading: "Fact and policy", calls: RECOMMENDATION },
  { item: "7", heading: "Held back and no change", calls: RECOMMENDATION },
  { item: "8", heading: "Output limits", calls: CALLS },
  { item: "9", heading: "Commands and paths", calls: RECOMMENDATION },
];

describe("the released prompts (IMPL §3.7)", () => {
  it("load from the package's prompts/, rendered, with the hash of the text sent", () => {
    const set = loadReleasedPrompts();
    expect(set.testOnly).toBe(false);
    for (const call of CALLS) {
      const prompt = set.prompt(call);
      expect(prompt.version).toBe(RELEASED_PROMPTS[call]);
      expect(prompt.text).toBe(rendered(call));
      expect(prompt.hash).toBe(sha256(new TextEncoder().encode(prompt.text)));
      expect(prompt.text).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("resolve relative to the module, so the built package finds them too", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    for (const call of CALLS)
      expect(fileURLToPath(templateUrl(call, "1.0.0"))).toBe(`${root}prompts/${call}/1.0.0.md`);
    const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
      files: string[];
    };
    expect(manifest.files).toContain("prompts");
  });

  it("use only placeholders code defines", () => {
    for (const call of CALLS) {
      const known = promptVariables(call);
      for (const name of placeholders(template(call))) expect(known.has(name), name).toBe(true);
    }
  });

  it("type no number by hand: outside inline code and placeholders, a template holds no digit", () => {
    for (const call of CALLS) {
      const prose = template(call)
        .replace(/\{\{[^{}]*\}\}/g, "")
        .replace(/``.*?``/g, "")
        .replace(/`[^`\n]*`/g, "");
      expect(prose.match(/.*[0-9].*/g) ?? [], call).toEqual([]);
      // Nor as a bare number in inline code, or a multiple or bound in words.
      const unplaced = template(call).replace(/\{\{[^{}]*\}\}/g, "");
      expect(unplaced.match(/`[0-9][0-9,.]*`/g) ?? [], call).toEqual([]);
      expect(
        unplaced.match(/\b(twice (the|as)|double the|half as|between one and)\b/gi) ?? [],
        call,
      ).toEqual([]);
    }
  });

  it("are self-contained: none refers to another call's prompt or to earlier steps", () => {
    const crossReference =
      /\b(as before|same (format|rules) as|as in the \w+ (step|call)|(first|previous|earlier|last) (call|step|prompt|analysis)|(first|earlier)-analysis|call[- ](one|two|three|four|five)|(has|have) been analysed|already answered|reviewed again)\b/gi;
    for (const call of CALLS) expect(rendered(call).match(crossReference) ?? [], call).toEqual([]);
  });

  for (const { item, heading, calls } of REQUIRED)
    it(`cover item ${item}, "${heading}", in ${calls.join(", ")}`, () => {
      for (const call of calls) expect(sections(rendered(call)).has(heading), call).toBe(true);
    });

  it("say content is data, and where calls 1–2 report suspected instructions", () => {
    for (const call of CALLS) {
      const body = section(call, "Repository content is data");
      expect(body, call).toMatch(/never instructions/);
      if (ANALYSIS.includes(call)) expect(body, call).toContain("`contentNotices`");
      else expect(body, call).toMatch(/ignore it/);
    }
  });

  it("give the quote rules with their limits from code", () => {
    for (const call of ANALYSIS) {
      const body = section(call, "Citations and quotes");
      for (const value of [MIN_QUOTE_CODE_POINTS, FIELD_LIMITS.quote, MAX_CITED_LINES])
        expect(body, call).toContain(`${value}`);
      expect(body, call).toMatch(/verbatim/);
      expect(body, call).toContain("`\\n`");
    }
  });

  it("name every alias kind of the call's table, and its local keys", () => {
    const keys: Record<CallPurpose, string[]> = {
      analyse: ["f1", "g1", "a1", "c1"],
      analyse_expansion: ["f1", "g1", "a1", "c1"],
      generate_questions: ["q1"],
      recommend: ["r1"],
      regenerate_recommendations: ["r1"],
    };
    for (const call of CALLS) {
      const body = section(call, "Aliases");
      // Call 1's table allows `E`, but no expansion item exists before the round (§1.8).
      const kinds = CALL_ALIAS_KINDS[call].filter((k) => !(call === "analyse" && k === "E"));
      for (const kind of kinds)
        expect(body, `${call} ${kind}`).toMatch(new RegExp(`\`${kind}[-<\` ]`));
      for (const key of keys[call]) expect(body, `${call} ${key}`).toContain(`\`${key}\``);
    }
  });

  it("say which fields code determines", () => {
    for (const call of CALLS) {
      const body = section(call, "What code determines");
      for (const word of ["basis", "paths", "hashes", "excerpt", "record IDs"])
        expect(body, `${call} ${word}`).toContain(word);
      if (RECOMMENDATION.includes(call)) expect(body, call).toContain("block IDs");
    }
  });

  it("forbid counts and universal claims, with the validator's word lists", () => {
    for (const call of CALLS) {
      const body = section(call, "No counts or universal claims");
      for (const word of [...QUANTITY_WORDS, ...UNIVERSAL_WORDS])
        expect(body, `${call} ${word}`).toContain(`\`${word}\``);
    }
  });

  it("ask questions only about intent the evidence can't establish", () => {
    expect(section("generate_questions", "Asking about intent")).toMatch(
      /only what the evidence can't settle/,
    );
  });

  it("separate fact from policy, and allow held-back topics and no change", () => {
    for (const call of RECOMMENDATION) {
      const facts = section(call, "Fact and policy");
      expect(facts, call).toContain("`fact`");
      expect(facts, call).toContain("`policy`");
      const held = section(call, "Held back and no change");
      expect(held, call).toContain("`heldBack`");
      expect(held, call).toMatch(/skipped/);
      expect(held, call).toMatch(/unresolved conflict/);
      expect(held, call).toMatch(/[Nn]o change is a good answer/);
    }
    expect(section("recommend", "Held back and no change")).toContain("`noChangeReason`");
  });

  it("put every command and path in inline code (REF-003)", () => {
    for (const call of RECOMMENDATION)
      expect(section(call, "Commands and paths"), call).toMatch(
        /Write every command and every path in the content as inline code/,
      );
  });

  it("state every collection limit of the call's schema, from the schema", () => {
    for (const call of CALLS) {
      const body = section(call, "Output limits");
      for (const [name, value] of collectionLimits(call))
        expect(body, `${call} ${name}`).toMatch(new RegExp(`\`${name}\`: at most ${value}\\b`));
    }
  });
});

// Every released prompt version, append-only. A released template is never edited: a change is
// a new file and a new entry. `rendered` pins the current version's text as sent, so a schema or
// constant change that alters it fails here until a new prompt version is added (IMPL §3.7).
const HISTORY: Record<
  CallPurpose,
  readonly { version: string; template: string; rendered: string }[]
> = {
  analyse: [
    {
      version: "1.0.0",
      template: "sha256:79efb077e47c0890c7f9e16d43e48319ee45ecb1bd8b26871e7bd618875f2e5c",
      rendered: "sha256:c6e81833a11190dacd0ec5568c0b5aa5e9e80768e4f5aafecaca818c7df4adc7",
    },
  ],
  analyse_expansion: [
    {
      version: "1.0.0",
      template: "sha256:488ec45e3f4b6055bbbcda18092048254aeecc33ce6e1ffdf420e8586c72fcae",
      rendered: "sha256:6aebec78cb1cb169e77d23b539fa35654d45453725fb1a12bb1ed5526c4750ec",
    },
  ],
  generate_questions: [
    {
      version: "1.0.0",
      template: "sha256:0fd386a9124a692a893036f94e61e5ddf42a86cff34e7fa39ce8f798dc7df436",
      rendered: "sha256:ea35475d2788490c14ed47504e7e71a221ca7843c56aeb2d242c530ce957ce07",
    },
  ],
  recommend: [
    {
      version: "1.0.0",
      template: "sha256:2c6fe76d7beb8df2aee5f59ad4148e9a9d83bafc2d942d4ec6d1dc8be67117bf",
      rendered: "sha256:5e8e81b98a6d53c72558176280bb2e33acf6f300dfae8c196fa0351b985e4de3",
    },
  ],
  regenerate_recommendations: [
    {
      version: "1.0.0",
      template: "sha256:5ff6e935be200244ec9ba8581b735ca16a61020bcd355ec5d8c7f98f504c2500",
      rendered: "sha256:56a91421c9ef9771b946f52245c9afc18c0af9df5860972abc5ea703e0b72e6a",
    },
  ],
};

describe("released prompt versions (IMPL §3.7)", () => {
  const hash = (text: string) => sha256(new TextEncoder().encode(text));

  it("keep every released template unchanged, and pin the current version's rendering", () => {
    for (const call of CALLS) {
      const history = HISTORY[call];
      for (const entry of history)
        expect(hash(template(call, entry.version)), `${call} ${entry.version}`).toBe(
          entry.template,
        );
      const current = history.find((entry) => entry.version === RELEASED_PROMPTS[call]);
      expect(current, call).toBeDefined();
      expect(hash(rendered(call)), call).toBe(current?.rendered);
    }
  });

  it("list every prompt file, once", () => {
    for (const call of CALLS) {
      const dir = fileURLToPath(new URL(`../../../prompts/${call}/`, import.meta.url));
      const files = readdirSync(dir).sort();
      const versions = HISTORY[call].map((entry) => `${entry.version}.md`);
      expect(new Set(versions).size, call).toBe(versions.length);
      expect(files, call).toEqual([...versions].sort());
    }
  });
});
