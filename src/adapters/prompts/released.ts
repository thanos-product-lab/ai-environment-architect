import { readFileSync } from "node:fs";
import { releasedPromptSet } from "../../core/run/prompt-template.js";
import type { PromptSet } from "../../core/run/prompts.js";
import type { CallPurpose } from "../../core/validation/aliases.js";

// The released prompts (IMPL §3.7), read from the package's own `prompts/`, relative to this
// module, never the working directory. From `src/adapters/prompts/` and from
// `dist/adapters/prompts/`, three levels up is the package root, which ships `prompts/`.

export function templateUrl(call: CallPurpose, version: string): URL {
  return new URL(`../../../prompts/${call}/${version}.md`, import.meta.url);
}

/** Reads and renders every released prompt; a missing file or unknown placeholder throws. */
export function loadReleasedPrompts(): PromptSet {
  return releasedPromptSet((call, version) => readFileSync(templateUrl(call, version), "utf8"));
}
