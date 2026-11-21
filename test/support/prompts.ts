import { readFileSync } from "node:fs";
import { sha256 } from "../../src/core/hash.js";
import type { CallPrompt } from "../../src/core/requests/build.js";
import type { PromptSet } from "../../src/core/run/prompts.js";
import type { CallPurpose } from "../../src/core/validation/aliases.js";

// The placeholder prompt set (IMPL §3.7): `test/fixtures/prompts/<call>/0.0.0-test.md`. It loads
// only under Vitest, so it can never be used for a live run.

export const TEST_PROMPT_VERSION = "0.0.0-test";

export function testPromptSet(): PromptSet {
  if (process.env["VITEST"] === undefined)
    throw new Error("the placeholder prompts are for tests only: load the released prompt set");
  const cache = new Map<CallPurpose, CallPrompt>();
  return {
    testOnly: true,
    prompt(call) {
      const cached = cache.get(call);
      if (cached !== undefined) return cached;
      const url = new URL(`../fixtures/prompts/${call}/${TEST_PROMPT_VERSION}.md`, import.meta.url);
      const bytes = readFileSync(url);
      const prompt = {
        version: TEST_PROMPT_VERSION,
        hash: sha256(new Uint8Array(bytes)),
        text: bytes.toString("utf8"),
      };
      cache.set(call, prompt);
      return prompt;
    },
  };
}
