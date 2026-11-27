import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageIndex } from "../src/core/validation/coverage.js";
import { detectReferences } from "../src/core/validation/references.js";

// The first live run's REF-001 rejections (ofetch, ses_dd088742), detected again with the
// snapshot's names (IMPL §3.4, references/1.3.0). Under 1.2.0, r1 and r2 declared `src`, `test`
// and `examples`, which the detector didn't find, and r3 wrote `.ts`, which it found as a path.

const RUN = join(
  import.meta.dirname,
  "fixtures/live/ofetch/ses_dd088742-387c-4d19-9a1b-a905eff40db9",
);

interface Reference {
  readonly kind: "path" | "command";
  readonly value: string;
}

interface Recommendation {
  readonly key: string;
  readonly content?: string;
  readonly references: readonly Reference[];
}

const read = (name: string): unknown => JSON.parse(readFileSync(join(RUN, name), "utf8"));

const response = read("0099-recommend.response.json") as {
  content: { type: string; text?: string }[];
};
const text = response.content.find((block) => block.type === "text")?.text ?? "";
const { recommendations } = JSON.parse(text) as { recommendations: Recommendation[] };

const session = read("session.json") as { records: { type: string }[] };
const snapshot = session.records.find(
  (record) => record.type === "snapshot",
) as unknown as Parameters<typeof coverageIndex>[0];
const names = new Set(coverageIndex(snapshot, []).listed);

/** REF-001's two directions: what is detected is declared, and what is declared is detected. */
function ref001(recommendation: Recommendation, options: { names?: ReadonlySet<string> }) {
  const detected = detectReferences(recommendation.content ?? "", options).references;
  const same = (d: { kind: string; match: string }, r: Reference) =>
    d.kind === r.kind && d.match === r.value;
  return {
    undeclared: detected.filter((d) => !recommendation.references.some((r) => same(d, r))),
    undetected: recommendation.references.filter((r) => !detected.some((d) => same(d, r))),
  };
}

describe("REF-001 on the ofetch run's recommendations (references/1.3.0)", () => {
  it.each(["r1", "r2", "r3"])("REF-001 accepts %s with the snapshot's names", (key) => {
    const recommendation = recommendations.find((r) => r.key === key) as Recommendation;
    expect(ref001(recommendation, { names })).toEqual({ undeclared: [], undetected: [] });
  });

  it.each(["r1", "r2", "r3"])("REF-001 rejected %s without them, as the run recorded", (key) => {
    const recommendation = recommendations.find((r) => r.key === key) as Recommendation;
    const { undeclared, undetected } = ref001(recommendation, {});
    expect(undeclared.length + undetected.length).toBeGreaterThan(0);
  });

  it("finds `.ts` in r3 as an identifier, not a path", () => {
    const r3 = recommendations.find((r) => r.key === "r3") as Recommendation;
    const detection = detectReferences(r3.content ?? "", { names });
    expect(detection.identifiers.map((i) => i.match)).toContain(".ts");
    expect(detection.references.map((r) => r.match)).not.toContain(".ts");
  });
});
