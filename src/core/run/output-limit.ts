import { type ContextSelectionSettings, settingsHash } from "../context/select.js";
import type { RecordOf } from "../session/records.js";
import type { HeldSession } from "../session/store.js";
import type { CallPurpose } from "../validation/aliases.js";
import { activeConfig, type RunDeps, type RunOptions } from "./analysis.js";

// Raising the output limit after a truncation (IMPL §3.6, §4.6). It is the developer's choice,
// never automatic. Before anything is appended, code refuses a value that isn't higher than the
// current one, that is above the model's output maximum, or that would make the truncated call
// fail its token check. Then one `generation_config` revision with the reason
// `output_limit_raised` changes only `reservedOutputTokens` and `settingsHash`, and the
// truncated call is sent again as a new model call whose `retryOf` names it.

export type RaiseOutcome<O> =
  | { readonly kind: "refused"; readonly reason: string }
  /** The runner stopped for another reason before anything was appended. */
  | { readonly kind: "not_sent"; readonly outcome: O }
  | {
      readonly kind: "resent";
      readonly revision: RecordOf<"generation_config">;
      readonly outcome: O;
    };

export interface RaiseRequest<O> {
  /** The truncated call: the session's last send, failed with `truncated`. */
  readonly truncated: string;
  /** The new `reservedOutputTokens`, for the truncated call's purpose and any others. */
  readonly limits: Partial<Readonly<Record<CallPurpose, number>>>;
  /**
   * Runs the truncated call's runner again with `options`: the same runner, input and part that
   * sent it, so the request is built again under the new limit.
   */
  resend(options: RunOptions): Promise<O>;
}

export async function raiseOutputLimit<O>(
  session: HeldSession,
  deps: RunDeps,
  request: RaiseRequest<O>,
): Promise<RaiseOutcome<O>> {
  const calls = session.records.filter((r): r is RecordOf<"model_call"> => r.type === "model_call");
  const truncated = calls.filter((c) => c.modelCallId === request.truncated).at(-1);
  if (truncated === undefined) throw new Error(`no model call ${request.truncated}`);
  if (calls.at(-1)?.modelCallId !== request.truncated)
    throw new Error(`${request.truncated} isn't the last send`);
  if (truncated.state !== "failed" || truncated.error?.kind !== "truncated")
    throw new Error(`${request.truncated} wasn't truncated`);

  const config = activeConfig(session.records);
  const current = config.settings.tokens.reservedOutputTokens;
  if (request.limits[truncated.purpose] === undefined)
    return { kind: "refused", reason: `the limit of ${truncated.purpose} isn't raised` };
  const limits = Object.entries(request.limits) as [CallPurpose, number][];
  for (const [call] of limits)
    if (!Object.hasOwn(current, call)) return { kind: "refused", reason: `${call} isn't a call` };
  for (const [call, value] of limits)
    if (!Number.isInteger(value) || value <= current[call])
      return { kind: "refused", reason: `${call}: ${value} isn't higher than ${current[call]}` };
  const model = await deps.models.modelLimits(config.requestedModel);
  // Without a published maximum the value can't be checked, so the raise is refused (§4.6).
  if (model.state !== "known" || model.maxOutputTokens === null)
    return { kind: "refused", reason: "the model's output maximum is unavailable" };
  for (const [call, value] of limits)
    if (value > model.maxOutputTokens)
      return {
        kind: "refused",
        reason: `${call}: ${value} is above the model's output maximum, ${model.maxOutputTokens}`,
      };

  const tokens = {
    ...config.settings.tokens,
    reservedOutputTokens: { ...current, ...request.limits },
  };
  const settings = { ...config.settings, tokens };
  let revision: RecordOf<"generation_config"> | undefined;
  const outcome = await request.resend({
    tokens,
    resend: {
      retryOf: request.truncated,
      async beforeSend() {
        revision = await session.change(
          (log) =>
            log.revise("generation_config", "generation_config", {
              reason: "output_limit_raised",
              settings,
              // The record holds the effective settings selection hashed (§1.3), as parsed.
              settingsHash: settingsHash(settings as ContextSelectionSettings),
            }) as RecordOf<"generation_config">,
        );
      },
    },
  });
  if (revision !== undefined) return { kind: "resent", revision, outcome };
  // Nothing was appended. Only a call that doesn't fit refuses the value; any other stop, such
  // as a failed input-limit lookup or a secret match, is the runner's to report (§1.10).
  return doesNotFit(outcome)
    ? { kind: "refused", reason: "the call wouldn't fit its token check with that limit" }
    : { kind: "not_sent", outcome };
}

/** Whether a runner's stop means the request doesn't fit the input limit (§1.10). */
function doesNotFit(outcome: unknown): boolean {
  const o = outcome as { kind?: string; check?: { state?: string }; stop?: { state?: string } };
  if (o.kind === "skipped") return true;
  const state = o.check?.state ?? o.stop?.state;
  return (
    o.kind === "stopped" &&
    (state === "does_not_fit" || state === "context_exceeds_input_limit" || state === "stopped")
  );
}
