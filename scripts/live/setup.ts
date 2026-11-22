import type { PromptSet } from "../../src/core/run/prompts.js";
import type { PriceTable } from "../../src/core/session/cost.js";
import type { RecordOf, SessionRecord } from "../../src/core/session/records.js";
import type { CallPurpose } from "../../src/core/validation/aliases.js";
import { VALIDATOR_VERSION } from "../../src/core/validation/pipeline.js";
import { DETECTOR_VERSION } from "../../src/core/validation/references.js";
import { CALL_SCHEMAS } from "../../src/schemas/index.js";

// The run's setup (M6 live-run protocol, step 3), in `setup.json`: one entry per phase, since a
// phase may run with another product commit. The API key is never part of it.

/** The environment variable the key is read from, and the only one. */
export const LIVE_KEY_VARIABLE = "AI_ENVIRONMENT_ARCHITECT_LIVE_API_KEY";

export function readApiKey(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; key: string } | { ok: false; reason: string } {
  const key = env[LIVE_KEY_VARIABLE];
  if (key === undefined || key.trim() === "")
    return { ok: false, reason: `set ${LIVE_KEY_VARIABLE} to the live-run workspace's API key` };
  return { ok: true, key };
}

const PURPOSES: readonly CallPurpose[] = [
  "analyse",
  "analyse_expansion",
  "generate_questions",
  "recommend",
  "regenerate_recommendations",
];

export interface PhaseSetup {
  readonly phase: "analyse" | "recommend" | "regenerate";
  readonly startedAt: string;
  readonly productCommit: string | null;
  /** Whether the product's tree was clean, besides the live fixtures and the run log. */
  readonly productTreeClean: boolean;
  readonly prompts: Record<string, { version: string; hash: string }>;
  readonly schemas: Record<string, { version: string; hash: string }>;
  readonly validatorVersion: string;
  readonly detectorVersion: string;
  readonly model: string;
  readonly effort: string;
  readonly apiVersion: string;
  readonly priceTable: { version: string; date: string };
  readonly retainModelInputs: boolean;
  readonly budget: RecordOf<"generation_config">["budget"];
}

export interface PhaseSetupInput {
  readonly phase: PhaseSetup["phase"];
  readonly startedAt: string;
  readonly productCommit: string | null;
  readonly productTreeClean: boolean;
  readonly prompts: PromptSet;
  readonly prices: PriceTable;
  readonly apiVersion: string;
  readonly records: readonly SessionRecord[];
}

export function phaseSetup(input: PhaseSetupInput): PhaseSetup {
  const config = input.records
    .filter((r): r is RecordOf<"generation_config"> => r.type === "generation_config")
    .at(-1);
  if (config === undefined) throw new Error("the session has no generation_config");
  const entries = <T>(f: (call: CallPurpose) => T) =>
    Object.fromEntries(PURPOSES.map((call) => [call, f(call)]));
  return {
    phase: input.phase,
    startedAt: input.startedAt,
    productCommit: input.productCommit,
    productTreeClean: input.productTreeClean,
    prompts: entries((call) => {
      const p = input.prompts.prompt(call);
      return { version: p.version, hash: p.hash };
    }),
    schemas: entries((call) => ({
      version: CALL_SCHEMAS[call].version,
      hash: CALL_SCHEMAS[call].schemaHash,
    })),
    validatorVersion: VALIDATOR_VERSION,
    detectorVersion: DETECTOR_VERSION,
    model: config.requestedModel,
    effort: config.effort,
    apiVersion: input.apiVersion,
    priceTable: { version: input.prices.version, date: input.prices.date },
    retainModelInputs: config.retainModelInputs,
    budget: config.budget,
  };
}

/** `setup.json` with this phase's entry added after any earlier ones. */
export function withPhase(existing: string | undefined, entry: PhaseSetup): string {
  const before =
    existing === undefined ? [] : (JSON.parse(existing) as { phases: PhaseSetup[] }).phases;
  return `${JSON.stringify({ phases: [...before, entry] }, null, 2)}\n`;
}
