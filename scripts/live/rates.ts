import { comparePaths } from "../../src/core/paths.js";
import type {
  Known,
  RecordOf,
  SessionFile,
  SessionRecord,
} from "../../src/core/session/records.js";
import type { CallPurpose } from "../../src/core/validation/aliases.js";

// The rates of a live run (M6 live-run protocol, steps 6 and 7), read from its session file and
// never counted by hand. Unknown is never zero: an unknown count, token figure or cost is shown
// as unknown with its reason, and a sum says how many parts it is missing.

type ModelCall = RecordOf<"model_call">;
type Ended = Exclude<ModelCall, { state: "started" }>;

const PURPOSES: readonly CallPurpose[] = [
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
];

/** Whether call 2 ran, and if not, why (IMPL §1.8, §1.10, §3.9). */
export type CallTwo =
  | "sent"
  | "skipped_did_not_fit"
  | "stopped_by_budget"
  | "round_returned_no_item"
  | "no_expansion_request"
  /** Call 1 completed, and the session stopped before anything shows whether a round ran. */
  | "stopped_after_call_1"
  | "call_1_not_completed";

export function callTwoStatus(records: readonly SessionRecord[]): CallTwo {
  const calls = records.filter((r): r is ModelCall => r.type === "model_call");
  if (calls.some((c) => c.purpose === "analyse_expansion")) return "sent";
  const states = records.filter((r) => r.type === "session_state");
  const unsent = (reason: string) =>
    states.some(
      (s) =>
        s.type === "session_state" &&
        s.reason === reason &&
        s.unsentPurpose === "analyse_expansion",
    );
  if (unsent("stage_skipped")) return "skipped_did_not_fit";
  if (unsent("budget_reached")) return "stopped_by_budget";
  if (records.some((r) => r.type === "expansion_round")) return "round_returned_no_item";
  if (!calls.some((c) => c.purpose === "analyse" && c.state === "completed"))
    return "call_1_not_completed";
  // The round step always comes before call 3, so a call 3–5, sent or stopped by the budget,
  // shows that it ran and found no request.
  const LATER = new Set(["generate_questions", "recommend", "regenerate_recommendations"]);
  const later =
    calls.some((c) => LATER.has(c.purpose)) ||
    states.some(
      (s) =>
        s.type === "session_state" &&
        s.reason === "budget_reached" &&
        s.unsentPurpose !== undefined &&
        LATER.has(s.unsentPurpose),
    );
  return later ? "no_expansion_request" : "stopped_after_call_1";
}

/**
 * Of the sessions where it is known whether call 2 was needed, how many sent it: those whose
 * call 1 completed, less those that stopped before the round could show it.
 */
export function callTwoShare(files: readonly SessionFile[]): { ran: number; of: number } {
  const statuses = files.map((f) => callTwoStatus(f.records));
  return {
    ran: statuses.filter((s) => s === "sent").length,
    of: statuses.filter((s) => s !== "call_1_not_completed" && s !== "stopped_after_call_1").length,
  };
}

export interface Send {
  readonly seq: number;
  readonly purpose: CallPurpose;
  readonly attempt: number;
  /** `started` when the session holds no end for it, as for an interrupted process. */
  readonly state: ModelCall["state"];
  readonly error?: string;
  readonly proposed: Known<number>;
  readonly accepted?: number;
  readonly corrected?: number;
  readonly relabelled?: number;
  /** Items proposed and not accepted; unknown with the proposed count. */
  readonly rejected: Known<number>;
  readonly usage: Record<"input" | "output" | "cacheRead" | "cacheWrite", Known<number>>;
  readonly cost: Known<number>;
  readonly estimatedCost: Known<number>;
  readonly correctedCitations?: Ended["correctedCitationRate"];
  /** By rule: rejections from `rejectedByRule`, corrections and relabellings from the events. */
  readonly rules: readonly {
    rule: string;
    outcome: "rejected" | "corrected" | "relabelled";
    count: number;
  }[];
}

const unknown = (reason: string) => ({ state: "unknown", reason }) as const;

export function sends(records: readonly SessionRecord[]): Send[] {
  const lineages = new Map<string, ModelCall[]>();
  for (const r of records)
    if (r.type === "model_call")
      lineages.set(r.modelCallId, [...(lineages.get(r.modelCallId) ?? []), r]);
  return [...lineages.values()].map((revisions) => {
    const started = revisions[0] as ModelCall;
    const last = revisions.at(-1) as ModelCall;
    const base = {
      seq: started.seq,
      purpose: started.purpose,
      attempt: started.attempt,
      estimatedCost: started.estimatedCost,
    };
    if (last.state === "started") {
      const why = unknown("no_end_recorded");
      return {
        ...base,
        state: last.state,
        proposed: why,
        rejected: why,
        usage: { input: why, output: why, cacheRead: why, cacheWrite: why },
        cost: why,
        rules: [],
      };
    }
    const { counts } = last;
    const rules: {
      rule: string;
      outcome: "rejected" | "corrected" | "relabelled";
      count: number;
    }[] = Object.entries(counts.rejectedByRule).map(([rule, count]) => ({
      rule,
      outcome: "rejected",
      count,
    }));
    for (const outcome of ["corrected", "relabelled"] as const) {
      const byRule = new Map<string, number>();
      for (const e of last.validationEvents)
        if (e.outcome === outcome) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
      for (const [rule, count] of byRule) rules.push({ rule, outcome, count });
    }
    rules.sort((a, b) => comparePaths(a.rule, b.rule) || comparePaths(a.outcome, b.outcome));
    return {
      ...base,
      state: last.state,
      ...(last.error === undefined ? {} : { error: `${last.error.kind}: ${last.error.message}` }),
      proposed: counts.proposed,
      accepted: counts.accepted,
      corrected: counts.corrected,
      relabelled: counts.relabelled,
      rejected:
        counts.proposed.state === "known"
          ? { state: "known", value: counts.proposed.value - counts.accepted }
          : counts.proposed,
      usage: last.usage,
      cost:
        last.cost.state === "known" ? { state: "known", value: last.cost.value.amount } : last.cost,
      ...(last.correctedCitationRate === undefined
        ? {}
        : { correctedCitations: last.correctedCitationRate }),
      rules,
    };
  });
}

export interface PerCall {
  readonly purpose: CallPurpose;
  readonly sends: number;
  /** Sends with no end recorded: the counts below are known only for the rest. */
  readonly notEnded: number;
  readonly retries: number;
  readonly schemaFailures: number;
  readonly refusals: number;
  readonly truncated: number;
  /** Truncated sends over sends that ended; unknown when none ended. */
  readonly truncationRate: Known<number>;
  /** Corrected over checked citations, of the sends where both are known. */
  readonly correctedCitations?: { corrected: number; checked: number; unknownSends: number };
}

export function perCall(all: readonly Send[]): PerCall[] {
  return PURPOSES.flatMap((purpose) => {
    const of = all.filter((s) => s.purpose === purpose);
    if (of.length === 0) return [];
    const ended = of.filter((s) => s.state !== "started");
    const kind = (k: string) => of.filter((s) => s.error?.startsWith(`${k}:`)).length;
    const truncated = kind("truncated");
    const cited = of.filter((s) => s.correctedCitations !== undefined);
    const known = cited.flatMap((s) =>
      s.correctedCitations?.state === "known" ? [s.correctedCitations] : [],
    );
    return [
      {
        purpose,
        sends: of.length,
        notEnded: of.length - ended.length,
        retries: of.filter((s) => s.attempt > 1).length,
        schemaFailures: of.filter((s) => s.rules.some((r) => r.rule === "SCHEMA")).length,
        refusals: kind("refusal"),
        truncated,
        truncationRate:
          ended.length === 0
            ? unknown("no_send_ended")
            : { state: "known", value: truncated / ended.length },
        ...(cited.length === 0
          ? {}
          : {
              correctedCitations: {
                corrected: known.reduce((n, r) => n + r.corrected, 0),
                checked: known.reduce((n, r) => n + r.checked, 0),
                unknownSends: cited.length - known.length,
              },
            }),
      },
    ];
  });
}

/** A sum of parts any of which may be unknown. */
export interface Sum {
  readonly known: number;
  readonly unknownParts: number;
}

export function sum(values: readonly Known<number>[]): Sum {
  return {
    known: values.reduce((n, v) => n + (v.state === "known" ? v.value : 0), 0),
    unknownParts: values.filter((v) => v.state === "unknown").length,
  };
}

export interface RunRates {
  readonly runId: string;
  readonly date: string;
  readonly repository: string;
  readonly commit: string | null;
  readonly model: string;
  readonly effort: string;
  readonly callTwo: CallTwo;
  /** The calls a `budget_reached` left unsent. */
  readonly budgetStops: readonly CallPurpose[];
  readonly expansion?: {
    readonly requests: number;
    readonly executed: number;
    readonly rejectedByRule: readonly { rule: string; count: number }[];
  };
  readonly sends: readonly Send[];
  readonly perCall: readonly PerCall[];
  readonly estimatedCost: Sum;
  readonly cost: Sum;
  readonly tokens: Sum;
}

export function runRates(file: SessionFile): RunRates {
  const { records } = file;
  const all = sends(records);
  const snapshot = records.find((r) => r.type === "snapshot");
  const config = records.filter((r) => r.type === "generation_config").at(-1);
  const round = records.find((r) => r.type === "expansion_round");
  const expansion =
    round?.type === "expansion_round"
      ? (() => {
          const byRule = new Map<string, number>();
          for (const r of round.requests)
            if (r.outcome === "rejected") byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
          return {
            requests: round.requests.length,
            executed: round.requests.filter((r) => r.outcome === "executed").length,
            rejectedByRule: [...byRule]
              .map(([rule, count]) => ({ rule, count }))
              .sort((a, b) => comparePaths(a.rule, b.rule)),
          };
        })()
      : undefined;
  return {
    runId: file.session.id,
    date: file.session.createdAt.slice(0, 10),
    repository: file.session.repository.name,
    commit:
      snapshot?.type === "snapshot" && snapshot.git.state === "known" ? snapshot.git.commit : null,
    model: config?.type === "generation_config" ? config.requestedModel : "unknown",
    effort: config?.type === "generation_config" ? config.effort : "unknown",
    callTwo: callTwoStatus(records),
    budgetStops: records.flatMap((r) =>
      r.type === "session_state" && r.reason === "budget_reached" && r.unsentPurpose !== undefined
        ? [r.unsentPurpose]
        : [],
    ),
    ...(expansion === undefined ? {} : { expansion }),
    sends: all,
    perCall: perCall(all),
    estimatedCost: sum(all.map((s) => s.estimatedCost)),
    cost: sum(all.map((s) => s.cost)),
    tokens: sum(all.flatMap((s) => Object.values(s.usage))),
  };
}

// --- Markdown ----------------------------------------------------------------------------------

const known = (k: Known<number>, format: (n: number) => string = (n) => String(n)) =>
  k.state === "known" ? format(k.value) : `unknown (${k.reason})`;
const usd = (n: number) => `$${n.toFixed(4)}`;
const total = (s: Sum, format: (n: number) => string = (n) => String(n)) =>
  s.unknownParts === 0 ? format(s.known) : `${format(s.known)} + ${s.unknownParts} unknown`;
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;

const CALL_TWO: Record<CallTwo, string> = {
  sent: "sent",
  skipped_did_not_fit: "skipped: it didn't fit (stage_skipped)",
  stopped_by_budget: "not sent: the budget stopped it",
  round_returned_no_item: "not needed: the expansion round returned no item",
  no_expansion_request: "not needed: call 1 asked for no expansion",
  stopped_after_call_1: "unknown: the session stopped after call 1, before the round",
  call_1_not_completed: "not reached: call 1 didn't complete",
};

export function renderRates(rates: RunRates, share: { ran: number; of: number }): string {
  const lines = [
    `## ${rates.runId} · ${rates.date} · ${rates.repository}`,
    "",
    `- Commit: ${rates.commit === null ? "unknown" : `\`${rates.commit}\``}`,
    `- Model: \`${rates.model}\`, effort \`${rates.effort}\``,
    `- Call 2: ${CALL_TWO[rates.callTwo]}`,
    `- Budget: ${
      rates.budgetStops.length === 0
        ? "not reached"
        : `reached; left unsent: ${rates.budgetStops.join(", ")}`
    }`,
    `- Expansion round: ${
      rates.expansion === undefined
        ? "none"
        : `${rates.expansion.requests} requests, ${rates.expansion.executed} executed${
            rates.expansion.rejectedByRule.length === 0
              ? ""
              : `; rejected: ${rates.expansion.rejectedByRule.map((r) => `${r.rule} ×${r.count}`).join(", ")}`
          }`
    }`,
    "",
    "### Sends",
    "",
    "| Seq | Call | Attempt | State | Error | Proposed | Accepted | Corrected | Relabelled | Rejected | Input | Output | Cache read | Cache write | Cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rates.sends
      .map((s) =>
        [
          s.seq,
          s.purpose,
          s.attempt,
          s.state,
          s.error ?? "",
          known(s.proposed),
          s.accepted ?? "",
          s.corrected ?? "",
          s.relabelled ?? "",
          known(s.rejected),
          known(s.usage.input),
          known(s.usage.output),
          known(s.usage.cacheRead),
          known(s.usage.cacheWrite),
          known(s.cost, usd),
        ].join(" | "),
      )
      .map((row) => `| ${row} |`),
    "",
    "### By call",
    "",
    "| Call | Sends | Retries | Schema failures | Refusals | Truncated | Truncation rate | Corrected citations |",
    "|---|---|---|---|---|---|---|---|",
    ...rates.perCall.map((c) => {
      const cited =
        c.correctedCitations === undefined
          ? ""
          : `${c.correctedCitations.corrected} of ${c.correctedCitations.checked}${
              c.correctedCitations.unknownSends === 0
                ? ""
                : ` + ${c.correctedCitations.unknownSends} sends unknown`
            }`;
      // A send with no end recorded may have failed in any of these ways: never counted as not.
      const ofEnded = (n: number) => (c.notEnded === 0 ? `${n}` : `${n} + ${c.notEnded} unknown`);
      return `| ${[c.purpose, c.sends, c.retries, ofEnded(c.schemaFailures), ofEnded(c.refusals), ofEnded(c.truncated), known(c.truncationRate, percent), cited].join(" | ")} |`;
    }),
    "",
    "### Rejections and corrections by rule",
    "",
    "| Call | Rule | Rejected | Corrected | Relabelled |",
    "|---|---|---|---|---|",
    ...byRule(rates.sends),
    "",
    "### Cost",
    "",
    `- Estimated before each send, summed: ${total(rates.estimatedCost, usd)}`,
    `- Priced from reported usage, summed: ${total(rates.cost, usd)}`,
    `- Tokens reported, summed: ${total(rates.tokens)}`,
    "- Console spend limit: ____ USD, set on ____",
    "- Console spend for this run: ____ USD",
    "",
    "### Across saved runs",
    "",
    `- Call 2 ran in ${share.ran} of ${share.of} saved sessions where it is known whether it was needed.`,
    "",
  ];
  return `${lines.join("\n")}`;
}

function byRule(all: readonly Send[]): string[] {
  const rows = new Map<
    string,
    { purpose: string; rule: string; rejected: number; corrected: number; relabelled: number }
  >();
  for (const s of all)
    for (const r of s.rules) {
      const key = `${s.purpose}\0${r.rule}`;
      const row = rows.get(key) ?? {
        purpose: s.purpose,
        rule: r.rule,
        rejected: 0,
        corrected: 0,
        relabelled: 0,
      };
      row[r.outcome] += r.count;
      rows.set(key, row);
    }
  const order = (p: string) => PURPOSES.indexOf(p as CallPurpose);
  const sorted = [...rows.values()].sort(
    (a, b) => order(a.purpose) - order(b.purpose) || comparePaths(a.rule, b.rule),
  );
  return sorted.length === 0
    ? ["| — | none | 0 | 0 | 0 |"]
    : sorted.map(
        (r) => `| ${r.purpose} | ${r.rule} | ${r.rejected} | ${r.corrected} | ${r.relabelled} |`,
      );
}

const HEADER = `# Live runs

The rates of each manual live run (M6 live-run protocol in \`docs/MILESTONES.md\`), appended by
\`pnpm live-rates\` from the run's saved session. The numbers are never edited by hand: fill in
only the Console fields.
`;

/** The run log with this run's section appended; a run already in it is refused. */
export function appendRates(existing: string | undefined, runId: string, section: string): string {
  if (existing === undefined) return `${HEADER}\n${section}`;
  if (existing.split("\n").some((line) => line.startsWith(`## ${runId} `)))
    throw new Error(`docs/LIVE_RUNS.md already has ${runId}`);
  return `${existing.trimEnd()}\n\n${section}`;
}
