import type { PriceTable } from "../../core/session/cost.js";

// The versioned price table (IMPL §3.6, §4.6), in USD per million tokens, for the standard
// Messages API: global routing, no batch, no fast mode, no data-residency multiplier.
//
// - Source: https://platform.claude.com/docs/en/about-claude/pricing, checked on `date`.
// - Thinking is billed as output ("Tokens Claude uses while thinking (billed as output tokens)",
//   https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost), so
//   `output` prices `reservedOutputTokens` and the reported output, thinking included.
// - `cacheWrite` is the price for the default 5-minute cache lifetime. Requests never set a
//   lifetime, or a breakpoint, which a test of the adapter checks.
// - Only the models the product may use. Claude Haiku 5.5 is left out, because its price depends
//   on the prompt's length, cache reads and writes included; a model missing here has an unknown
//   cost that the developer must confirm (§4.6).
//
// Changing anything here, the date included, needs a new version and an entry in the history in
// `prices.test.ts`.

export const PRICE_TABLE: PriceTable = {
  version: "prices/1.0.0",
  date: "2026-11-15",
  models: {
    "claude-fable-5-2": { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
    "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  },
};
