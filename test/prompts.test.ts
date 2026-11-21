import { afterEach, describe, expect, it } from "vitest";
import { TEST_PROMPT_VERSION, testPromptSet } from "./support/prompts.js";

// The placeholder prompt set (IMPL §3.7): test-only, versioned, hashed by its bytes.

describe("the placeholder prompt set", () => {
  const vitest = process.env["VITEST"];
  afterEach(() => {
    process.env["VITEST"] = vitest;
  });

  it("is marked test-only and gives each call a versioned, hashed prompt", () => {
    const set = testPromptSet();
    expect(set.testOnly).toBe(true);
    const prompt = set.prompt("recommend");
    expect(prompt.version).toBe(TEST_PROMPT_VERSION);
    expect(prompt.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prompt.text).toContain("test-only placeholder");
  });

  it("refuses to load outside tests", () => {
    delete process.env["VITEST"];
    expect(() => testPromptSet()).toThrow(/tests only/);
  });
});
