import { describe, expect, it } from "vitest";
import { priceTableHash } from "../../core/session/cost.js";
import { PRICE_TABLE } from "./prices.js";

// The price table is pinned to its version (IMPL §4.6), as schemas are (§3.7): a call records
// only the table's version and date, so a price changed without a new version would make two
// calls with the same version priced differently.

describe("the price table (IMPL §4.6)", () => {
  it("is a recorded version", () => {
    expect(HISTORY).toContainEqual({
      version: PRICE_TABLE.version,
      date: PRICE_TABLE.date,
      hash: priceTableHash(PRICE_TABLE),
    });
  });

  it("records no version with two contents", () => {
    const versions = HISTORY.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("has a non-negative price of each kind for every model, and the default model", () => {
    expect(Object.keys(PRICE_TABLE.models)).toContain("claude-opus-5-5");
    for (const [model, prices] of Object.entries(PRICE_TABLE.models))
      for (const kind of ["input", "output", "cacheWrite", "cacheRead"] as const)
        expect(prices[kind], `${model} ${kind}`).toBeGreaterThanOrEqual(0);
  });
});

// Every released price table, append-only. Changing a price, adding or removing a model, or
// rechecking the prices on a new date changes the hash: add an entry with a new version, never
// edit an old one. As with the schema history (§3.7), the test can't tell an edited entry from a
// new one; review keeps the history append-only.
const HISTORY: readonly { version: string; date: string; hash: string }[] = [
  {
    version: "prices/1.0.0",
    date: "2026-11-15",
    hash: "sha256:cecc2344fffd8a5cdcb533f23921cb3884ce15be67e24c74fb3997d85bf2a87e",
  },
];
