import type { CallPrompt } from "../requests/build.js";
import type { CallPurpose } from "../validation/aliases.js";

// The prompt set a session runs with (IMPL §3.7): one prompt per call, each with its version and
// the hash of its bytes, which every model call records. The core API takes the set as an input,
// so it never reads files itself. The released set comes in M6 step h; tests use placeholders.

export interface PromptSet {
  /** A placeholder set, for tests only; never sent to a live model. */
  readonly testOnly: boolean;
  prompt(call: CallPurpose): CallPrompt;
}
