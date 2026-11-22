import { describe, expect, it } from "vitest";
import {
  appendRates,
  callTwoShare,
  callTwoStatus,
  renderRates,
  runRates,
  sends,
} from "../scripts/live/rates.js";
import type { SessionFile, SessionRecord } from "../src/core/session/records.js";
import { callDraft, completedCall } from "./support/session.js";

// The rates script (M6 live-run protocol, steps 6 and 7) over synthetic records: the counts come
// from the session file, and unknown is never shown as zero.

let seq = 0;
function started(overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    ...callDraft(),
    type: "model_call",
    id: `callr_${seq}`,
    seq,
    createdAt: "2026-11-22T10:00:00.000Z",
    revision: 1,
    modelCallId: `call_${seq}`,
    ...overrides,
  };
}
function ended(start: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    ...start,
    ...completedCall(),
    id: `callr_${seq}`,
    seq,
    revision: 2,
    supersedes: [start["id"]],
    ...overrides,
  };
}
const state = (reason: string, unsentPurpose: string) => ({
  type: "session_state",
  id: `st_${++seq}`,
  seq,
  reason,
  unsentPurpose,
});

function fileOf(records: readonly unknown[]): SessionFile {
  return {
    format: "ai-environment-architect/session",
    schemaVersion: 2,
    writtenBy: "0.1.0",
    session: {
      id: "ses_rates",
      createdAt: "2026-11-22T09:00:00.000Z",
      productVersion: "0.1.0",
      adapter: "claude-code",
      outputScope: ["root CLAUDE.md"],
      repository: { name: "ofetch", root: "ofetch" },
      targetPath: "CLAUDE.md",
    },
    records: records as SessionRecord[],
  } as SessionFile;
}

const events = [
  { itemKey: "f1/citations/0", stage: "item", rule: "CIT-R01", outcome: "corrected", detail: "x" },
  { itemKey: "f2", stage: "item", rule: "CIT-004", outcome: "rejected", detail: "x" },
  { itemKey: "g1", stage: "item", rule: "GAP-002", outcome: "relabelled", detail: "x" },
];

describe("counts per send", () => {
  it("takes proposed, accepted, corrected and relabelled from the call, and rejected as the rest", () => {
    const s = started();
    const [send] = sends([
      s,
      ended(s, {
        validationEvents: events,
        counts: {
          proposed: { state: "known", value: 4 },
          accepted: 3,
          corrected: 1,
          relabelled: 1,
          rejectedByRule: { "CIT-004": 1 },
        },
      }),
    ] as SessionRecord[]);
    expect(send).toMatchObject({
      proposed: { state: "known", value: 4 },
      accepted: 3,
      corrected: 1,
      relabelled: 1,
      rejected: { state: "known", value: 1 },
    });
    expect(send?.rules).toEqual([
      { rule: "CIT-004", outcome: "rejected", count: 1 },
      { rule: "CIT-R01", outcome: "corrected", count: 1 },
      { rule: "GAP-002", outcome: "relabelled", count: 1 },
    ]);
  });

  it("keeps an unknown proposed count unknown, with its reason, and the rejected count with it", () => {
    const s = started();
    const [send] = sends([
      s,
      ended(s, {
        state: "failed",
        error: { kind: "truncated", message: "reservedOutputTokens 16000" },
        counts: {
          proposed: { state: "unknown", reason: "truncated" },
          accepted: 0,
          corrected: 0,
          relabelled: 0,
          rejectedByRule: {},
        },
      }),
    ] as SessionRecord[]);
    expect(send?.proposed).toEqual({ state: "unknown", reason: "truncated" });
    expect(send?.rejected).toEqual({ state: "unknown", reason: "truncated" });
  });

  it("shows a send with no end recorded as started, with everything unknown, never zero", () => {
    const [send] = sends([started()] as SessionRecord[]);
    expect(send).toMatchObject({
      state: "started",
      cost: { state: "unknown", reason: "no_end_recorded" },
      usage: { input: { state: "unknown" } },
    });
  });
});

describe("rates per call", () => {
  it("counts retries, schema failures, refusals and the truncation rate", () => {
    const a = started();
    const b = started({ attempt: 2, retryOf: "call_1" });
    const c = started({ attempt: 3, retryOf: "call_2" });
    const rates = runRates(
      fileOf([
        a,
        ended(a, {
          state: "failed",
          error: { kind: "schema", message: "1" },
          validationEvents: [
            {
              itemKey: "$response",
              stage: "schema",
              rule: "SCHEMA",
              outcome: "rejected",
              detail: "x",
            },
          ],
          counts: {
            proposed: { state: "unknown", reason: "schema_failed" },
            accepted: 0,
            corrected: 0,
            relabelled: 0,
            rejectedByRule: { SCHEMA: 1 },
          },
        }),
        b,
        ended(b, { state: "failed", error: { kind: "refusal", message: "uncategorised" } }),
        c,
        ended(c, {
          state: "failed",
          error: { kind: "truncated", message: "reservedOutputTokens 16000" },
        }),
      ]),
    );
    expect(rates.perCall).toEqual([
      {
        purpose: "analyse",
        sends: 3,
        notEnded: 0,
        retries: 2,
        schemaFailures: 1,
        refusals: 1,
        truncated: 1,
        truncationRate: { state: "known", value: 1 / 3 },
      },
    ]);
  });

  it("counts a send with no end recorded as unknown in the failure columns, never as not failed", () => {
    const a = started();
    const b = started({ attempt: 2, retryOf: "call_1" });
    const rates = runRates(
      fileOf([a, ended(a, { state: "failed", error: { kind: "refusal", message: "x" } }), b]),
    );
    expect(rates.perCall[0]).toMatchObject({ sends: 2, notEnded: 1, refusals: 1 });
    expect(renderRates(rates, { ran: 0, of: 0 })).toContain(
      "| analyse | 2 | 1 | 0 + 1 unknown | 1 + 1 unknown | 0 + 1 unknown | 0.0% |",
    );
  });

  it("sums the corrected-citation rate over the sends that know it, and counts those that don't", () => {
    const a = started();
    const b = started({ attempt: 2, retryOf: "call_1" });
    const rates = runRates(
      fileOf([
        a,
        ended(a, {
          correctedCitationRate: { state: "known", corrected: 1, checked: 4, rate: 0.25 },
        }),
        b,
        ended(b, { correctedCitationRate: { state: "unknown", reason: "no_citations" } }),
      ]),
    );
    expect(rates.perCall[0]?.correctedCitations).toEqual({
      corrected: 1,
      checked: 4,
      unknownSends: 1,
    });
  });

  it("sums estimated and priced cost, counting unknown parts instead of zero", () => {
    const a = started({ estimatedCost: { state: "known", value: 0.5 } });
    const b = started({
      attempt: 2,
      retryOf: "call_1",
      estimatedCost: { state: "unknown", reason: "no_price:x" },
    });
    const rates = runRates(
      fileOf([
        a,
        ended(a),
        b,
        ended(b, {
          cost: { state: "unknown", reason: "usage_unknown:input,output,cacheRead,cacheWrite" },
        }),
      ]),
    );
    expect(rates.estimatedCost).toEqual({ known: 0.5, unknownParts: 1 });
    expect(rates.cost).toEqual({ known: 0.25, unknownParts: 1 });
  });
});

describe("call 2 and the expansion round", () => {
  const callOne = () => {
    const s = started();
    return [s, ended(s)];
  };
  const round = (requests: unknown[]) => ({
    type: "expansion_round",
    id: "exr_1",
    seq: ++seq,
    requests,
  });

  it.each([
    ["sent", () => [...callOne(), started({ purpose: "analyse_expansion" })]],
    [
      "skipped_did_not_fit",
      () => [...callOne(), round([]), state("stage_skipped", "analyse_expansion")],
    ],
    [
      "stopped_by_budget",
      () => [...callOne(), round([]), state("budget_reached", "analyse_expansion")],
    ],
    ["round_returned_no_item", () => [...callOne(), round([])]],
    ["no_expansion_request", () => [...callOne(), started({ purpose: "generate_questions" })]],
    ["no_expansion_request", () => [...callOne(), state("budget_reached", "generate_questions")]],
    ["stopped_after_call_1", () => callOne()],
    ["call_1_not_completed", () => [started()]],
  ])("%s", (status, records) => {
    expect(callTwoStatus(records() as SessionRecord[])).toBe(status);
  });

  it("gives the share of sessions in which call 2 ran, of those where its need is known", () => {
    const files = [
      fileOf([...callOne(), started({ purpose: "analyse_expansion" })]),
      fileOf([...callOne(), started({ purpose: "generate_questions" })]),
      fileOf(callOne()),
      fileOf([started()]),
    ];
    expect(callTwoShare(files)).toEqual({ ran: 1, of: 2 });
  });

  it("reports the round's EXP rejections by rule", () => {
    const rates = runRates(
      fileOf([
        ...callOne(),
        round([
          { index: 0, kind: "read", outcome: "rejected", rule: "EXP-002" },
          { index: 1, kind: "read", outcome: "executed", items: [] },
          { index: 2, kind: "search", outcome: "rejected", rule: "EXP-002" },
          { index: 3, kind: "read", outcome: "rejected", rule: "EXP-001" },
        ]),
      ]),
    );
    expect(rates.expansion).toEqual({
      requests: 4,
      executed: 1,
      rejectedByRule: [
        { rule: "EXP-001", count: 1 },
        { rule: "EXP-002", count: 2 },
      ],
    });
  });

  it("records the calls the budget left unsent", () => {
    const rates = runRates(fileOf([...callOne(), state("budget_reached", "generate_questions")]));
    expect(rates.budgetStops).toEqual(["generate_questions"]);
  });
});

describe("the run log", () => {
  const a = started();
  const file = fileOf([a, ended(a, { validationEvents: events })]);
  const section = renderRates(runRates(file), { ran: 0, of: 1 });

  it("is headed by the run ID, the date and the repository, with blank Console fields", () => {
    expect(section.startsWith("## ses_rates · 2026-11-22 · ofetch\n")).toBe(true);
    expect(section).toContain("- Console spend limit: ____ USD, set on ____");
    expect(section).toContain("- Console spend for this run: ____ USD");
    expect(section).toContain(
      "- Call 2 ran in 0 of 1 saved sessions where it is known whether it was needed.",
    );
    expect(section).toContain("| analyse | CIT-R01 | 0 | 1 | 0 |");
  });

  it("creates the log with a header, appends to it, and refuses a run already in it", () => {
    const created = appendRates(undefined, "ses_rates", section);
    expect(created.startsWith("# Live runs\n")).toBe(true);
    expect(() => appendRates(created, "ses_rates", section)).toThrow(/already has ses_rates/);
    const other = section.replace("## ses_rates", "## ses_other");
    expect(appendRates(created, "ses_other", other)).toBe(`${created.trimEnd()}\n\n${other}`);
  });

  it("gives the same section for the same session", () => {
    expect(renderRates(runRates(file), { ran: 0, of: 1 })).toBe(section);
  });
});
