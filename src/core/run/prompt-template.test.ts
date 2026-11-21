import { describe, expect, it } from "vitest";
import { ANALYSE_COLLECTION_LIMITS } from "../../schemas/analyse.js";
import { FIELD_LIMITS } from "../../schemas/common.js";
import { RECOMMEND_COLLECTION_LIMITS } from "../../schemas/recommend.js";
import { sha256 } from "../hash.js";
import { MAX_CITED_LINES, MIN_QUOTE_CODE_POINTS } from "../validation/citations.js";
import {
  buildPrompt,
  placeholders,
  promptVariables,
  RELEASED_PROMPTS,
  releasedPromptSet,
  renderPrompt,
} from "./prompt-template.js";

// Prompt templates (IMPL §3.7): placeholders filled from the schema and validator constants.

describe("renderPrompt (IMPL §3.7)", () => {
  it("fills limits from the schema and the validator's constants", () => {
    const text = renderPrompt(
      "analyse",
      "{{max.findings}} {{len.statement}} {{min.quote}} {{max.citedLines}} {{max.citations}}",
    );
    expect(text).toBe(
      [
        ANALYSE_COLLECTION_LIMITS.findings,
        FIELD_LIMITS.statement,
        MIN_QUOTE_CODE_POINTS,
        MAX_CITED_LINES,
        FIELD_LIMITS.citations.max,
      ].join(" "),
    );
  });

  it("takes `max.<collection>` from the call's own schema", () => {
    expect(promptVariables("recommend").get("max.recommendations")).toBe(
      String(RECOMMEND_COLLECTION_LIMITS.recommendations),
    );
    expect(promptVariables("analyse").has("max.recommendations")).toBe(false);
  });

  it("renders word lists as inline code", () => {
    expect(renderPrompt("analyse", "{{words.universal}}")).toBe(
      "`all`, `every`, `always`, `never`, `none`, `only`",
    );
  });

  it("fails on a placeholder code doesn't define, or an unpaired brace", () => {
    expect(() => renderPrompt("analyse", "at most {{max.findngs}}")).toThrow(/unknown placeholder/);
    expect(() => renderPrompt("analyse", "at most {{max.findings}")).toThrow(/unpaired/);
    expect(() => renderPrompt("analyse", "}} stray")).toThrow(/unpaired/);
  });

  it("lists the placeholders a template uses, once each", () => {
    expect(placeholders("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("hashes the rendered text, the system prompt as sent", () => {
    const prompt = buildPrompt("analyse", "1.0.0", "At most {{max.findings}}.");
    expect(prompt.text).toBe(`At most ${ANALYSE_COLLECTION_LIMITS.findings}.`);
    expect(prompt.hash).toBe(sha256(new TextEncoder().encode(prompt.text)));
  });

  it("builds the released set eagerly, so a broken template fails before any call", () => {
    expect(() => releasedPromptSet((call) => (call === "recommend" ? "{{nope}}" : "fine"))).toThrow(
      /recommend: unknown placeholder/,
    );
    const set = releasedPromptSet(() => "fine");
    expect(set.testOnly).toBe(false);
    expect(set.prompt("analyse").version).toBe(RELEASED_PROMPTS.analyse);
  });
});
