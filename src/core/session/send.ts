import { scanRequest } from "../context/token-check.js";
import type { Clock } from "../ports.js";
import type { ModelRequest, ReadMessage, SendResult } from "../request.js";
import type { CallPurpose } from "../validation/aliases.js";
import type { SchemaIssue, ValidationEvent, ValidationResult } from "../validation/pipeline.js";
import type { BudgetCheck } from "./calls.js";
import { callCost, checkBeforeSend, type PriceTable } from "./cost.js";
import type { Changes, LineageStart } from "./log.js";
import type { Known, RecordOf } from "./records.js";
import { retainedExchange, retainedFile, retainsModelInputs } from "./retained.js";
import type { HeldSession } from "./store.js";

// The retry and failure policy (IMPL §3.6), and the recording of every send (§4.6, §4.8).
//
// - Every send is its own model call: checked against the budget by `checkBeforeSend`, then a
//   `started` revision saved with the retained request, then the send, then the end saved with
//   the retained response. A send the budget stops is never started.
// - The stop reason is checked before the response is parsed.
// - Transport failures get 3 retries per distinct request, so the schema retry, whose request
//   differs, has its own 3. A refusal retry and a schema retry are each allowed once per step.
// - Waits go through the injected `sleep`, and times come from the injected clock.
// - What the call produced is the caller's to persist, with the `modelCallId` returned.

/** The waits before the first, second and third transport retry (provisional, §3.9). */
export const BACKOFF_MS = [1000, 2000, 4000] as const;
/** The longest `retry-after` wait; a longer one fails the call (provisional, §3.9). */
export const MAX_RETRY_AFTER_MS = 300_000;

export type ErrorKind =
  | "connection"
  | "timeout"
  | "server"
  | "rate_limit"
  | "request"
  | "truncated"
  | "refusal"
  | "unexpected_stop"
  | "schema";

export interface CallError {
  readonly kind: ErrorKind;
  /** Code-generated, never source content or the model's text. */
  readonly message: string;
}

/** One send of a request, through the adapter (ADR 0003). */
export interface ModelSender {
  /** The exact body bytes `send` will post, retained before it is sent (§4.8). */
  requestBytes(request: ModelRequest): Uint8Array;
  send(request: ModelRequest): Promise<SendResult>;
}

export interface SendDeps {
  readonly sender: ModelSender;
  readonly prices: PriceTable;
  readonly clock: Clock;
  /** Waits before a retry; tests advance a fake clock instead. */
  sleep(ms: number): Promise<void>;
}

/** The fields of a call's `started` revision that its caller assembled with the request. */
export type StartedFields = Omit<
  LineageStart<"model_call">,
  | "type"
  | "state"
  | "purpose"
  | "attempt"
  | "retryOf"
  | "requestedModel"
  | "priceTable"
  | "retainedInputRef"
  | "budget"
  | "estimatedCost"
  | "estimatedTokens"
  | "startedAt"
>;

type Ended = Extract<RecordOf<"model_call">, { readonly revision: 2 }>;

/** What the call's validator adds to the record beyond events and counts. */
export interface CallExtras {
  readonly correctedCitationRate?: Ended["correctedCitationRate"];
  readonly citationsProposed?: Ended["citationsProposed"];
  readonly questionOrder?: readonly string[];
}

export interface CallPlan<V> {
  readonly purpose: CallPurpose;
  /** The complete request, scanned and checked for tokens (§1.10). */
  readonly request: ModelRequest;
  /** The token check's input tokens for `request` (§1.10). */
  readonly inputTokens: number;
  readonly started: StartedFields;
  /** The call's validator over the response's one text block (§3.5). */
  validate(text: string): V;
  resultOf(validation: V): ValidationResult<unknown, unknown>;
  extrasOf?(validation: V): CallExtras;
}

export type CallOutcome<V> =
  | {
      readonly kind: "completed";
      readonly modelCallId: string;
      readonly validation: V;
      /** Items were proposed and none was accepted: the CLI offers `freshRetry` (§2.12). */
      readonly allRejected: boolean;
    }
  | { readonly kind: "failed"; readonly modelCallId: string; readonly error: CallError }
  | {
      /** The budget stopped the send (§3.6); a `budget_reached` session state was appended. */
      readonly kind: "not_sent";
      readonly check: Exclude<BudgetCheck, { result: "send" }>;
      /** The send this one would have retried, if any. */
      readonly retryOf?: string;
    };

/** Sends the call, applying §3.6, and returns the outcome of its last send. */
export function runCall<V>(
  session: HeldSession,
  deps: SendDeps,
  plan: CallPlan<V>,
): Promise<CallOutcome<V>> {
  return sendStep(session, deps, plan, { attempt: 1 });
}

/**
 * The one fresh retry of the identical request after a call completed with every item rejected
 * (§3.6, §2.12). Refuses any other call, and a second fresh retry in the same step.
 */
export async function freshRetry<V>(
  session: HeldSession,
  deps: SendDeps,
  plan: CallPlan<V>,
  modelCallId: string,
): Promise<CallOutcome<V>> {
  const latest = latestCalls(session);
  const previous = latest.get(modelCallId);
  if (previous === undefined) throw new Error(`no model call ${modelCallId}`);
  if ([...latest.keys()].at(-1) !== modelCallId)
    throw new Error(`${modelCallId} isn't the last send, so it can't be retried`);
  if (!isAllRejected(previous))
    throw new Error(`${modelCallId} didn't complete with every item rejected`);
  if (plan.purpose !== previous.purpose)
    throw new Error(`${modelCallId} is ${previous.purpose}, not ${plan.purpose}`);
  // The step's sends, last first. A send that retries a completed call is a fresh retry, and a
  // step has one. Every earlier failed send in it was retried, which uses the step's refusal or
  // schema retry.
  const step: RecordOf<"model_call">[] = [previous];
  for (let call = previous; call.retryOf !== undefined; ) {
    const before = latest.get(call.retryOf);
    if (before === undefined) throw new Error(`no model call ${call.retryOf}`);
    if (before.state === "completed")
      throw new Error("this step has already had its one fresh retry");
    step.push(before);
    call = before;
  }
  const first = step.at(-1) as RecordOf<"model_call">;
  if (
    first.retainedInputRef !== null &&
    retainedFile("inputs", deps.sender.requestBytes(plan.request)).ref !== first.retainedInputRef
  )
    throw new Error(`the request isn't identical to the one ${first.modelCallId} sent`);
  const used = (kind: ErrorKind) =>
    step.some((call) => call.state === "failed" && call.error?.kind === kind);
  return sendStep(session, deps, plan, {
    attempt: previous.attempt + 1,
    retryOf: modelCallId,
    refusalRetried: used("refusal"),
    schemaRetried: used("schema"),
  });
}

/**
 * The resend of a truncated call after the developer raised its output limit (§4.6): a new model
 * call whose `retryOf` names the truncated one, with the request built again under the new
 * limit. Refuses any call but the session's last send, a call that wasn't truncated, and another
 * purpose. The step's refusal and schema retries stay used.
 */
export async function resendTruncated<V>(
  session: HeldSession,
  deps: SendDeps,
  plan: CallPlan<V>,
  modelCallId: string,
): Promise<CallOutcome<V>> {
  const latest = latestCalls(session);
  const previous = latest.get(modelCallId);
  if (previous === undefined) throw new Error(`no model call ${modelCallId}`);
  if ([...latest.keys()].at(-1) !== modelCallId)
    throw new Error(`${modelCallId} isn't the last send, so it can't be resent`);
  if (previous.state !== "failed" || previous.error?.kind !== "truncated")
    throw new Error(`${modelCallId} wasn't truncated`);
  if (plan.purpose !== previous.purpose)
    throw new Error(`${modelCallId} is ${previous.purpose}, not ${plan.purpose}`);
  const step: RecordOf<"model_call">[] = [previous];
  for (let call: RecordOf<"model_call"> = previous; call.retryOf !== undefined; ) {
    const before = latest.get(call.retryOf);
    if (before === undefined) throw new Error(`no model call ${call.retryOf}`);
    step.push(before);
    call = before;
  }
  const used = (kind: ErrorKind) =>
    step.some((call) => call.state === "failed" && call.error?.kind === kind);
  return sendStep(session, deps, plan, {
    attempt: previous.attempt + 1,
    retryOf: modelCallId,
    refusalRetried: used("refusal"),
    schemaRetried: used("schema"),
  });
}

/** The schema retry's message: each issue's path and code, never a value (§3.6, §3.5). */
export function schemaRetryMessage(issues: readonly SchemaIssue[]): string {
  const lines = issues.map(
    (issue) => `- ${issue.path === "" ? "(root)" : issue.path}: ${issue.code}\n`,
  );
  return (
    "Your previous response didn't match the output schema. The issues, as path: code:\n" +
    lines.join("") +
    "Write the whole response again, matching the schema."
  );
}

// --- The loop ---------------------------------------------------------------------------------

type Next =
  | { readonly retry: "transport"; readonly waitMs: number | "too_long" }
  | { readonly retry: "refusal" }
  | { readonly retry: "schema"; readonly issues: readonly SchemaIssue[] }
  | { readonly retry: "none" };

interface Classified<V> {
  readonly end: Changes<"model_call">;
  readonly next: Next;
  readonly error?: CallError;
  readonly validation?: V;
}

async function sendStep<V>(
  session: HeldSession,
  deps: SendDeps,
  plan: CallPlan<V>,
  first: {
    readonly attempt: number;
    readonly retryOf?: string;
    readonly refusalRetried?: boolean;
    readonly schemaRetried?: boolean;
  },
): Promise<CallOutcome<V>> {
  let request = plan.request;
  let inputTokens = plan.inputTokens;
  let attempt = first.attempt;
  let retryOf = first.retryOf;
  let transportRetries = 0;
  // Once per step, a fresh retry included (§3.6 "Counting retries").
  let refusalRetried = first.refusalRetried ?? false;
  let schemaRetried = first.schemaRetried ?? false;
  /** The failure of the send this one retries, which ends the step if this one can't go. */
  let lastFailure: CallOutcome<V> | undefined;

  for (;;) {
    // Text that leaves the machine is scanned immediately before it is sent (§1.7). The caller
    // scanned the request and handled any match; only the schema retry's request is new here.
    const secret = scanRequest(request);
    if (secret !== undefined) {
      if (lastFailure === undefined || request === plan.request)
        throw new Error(`the request matches the secret rule ${secret}, so it can't be sent`);
      return lastFailure;
    }
    const before = checkBeforeSend(session.records, deps.prices, {
      model: request.model,
      inputTokens,
      reservedOutputTokens: request.maxTokens,
      cachesInput: false,
    });
    if (before.check.result !== "send") {
      await session.change((log) =>
        log.revise("session_state", "session_state", {
          reason: "budget_reached",
          unsentPurpose: plan.purpose,
        }),
      );
      return {
        kind: "not_sent",
        check: before.check,
        ...(retryOf === undefined ? {} : { retryOf }),
      };
    }

    const bytes = deps.sender.requestBytes(request);
    const startedAt = deps.clock.now();
    const started = await session.change((log, files) => {
      const input = retainedExchange(retainsModelInputs(log.records), "inputs", bytes);
      if (input.file !== undefined) files.retained.push(input.file);
      return log.start({
        ...plan.started,
        type: "model_call",
        state: "started",
        purpose: plan.purpose,
        attempt,
        ...(retryOf === undefined ? {} : { retryOf }),
        requestedModel: request.model,
        inputManifest: { ...plan.started.inputManifest, retainedInputRef: input.ref },
        retainedInputRef: input.ref,
        ...before.started,
        startedAt: startedAt.toISOString(),
      } satisfies LineageStart<"model_call">);
    });

    const result = await deps.sender.send(request);
    if (!sameBytes(result.requestBytes, bytes))
      throw new Error("the sender sent other bytes than it retained");
    const endedAt = deps.clock.now();
    const classified = classify(result, request, plan, deps, started.priceTable);

    await session.change((log, files) => {
      const response =
        "responseBytes" in result
          ? retainedExchange(retainsModelInputs(log.records), "responses", result.responseBytes)
          : { ref: null };
      if (response.file !== undefined) files.retained.push(response.file);
      return log.revise("model_call", started.modelCallId, {
        ...classified.end,
        retainedResponseRef: response.ref,
        ...(classified.error === undefined ? {} : { error: classified.error }),
        endedAt: { state: "known", value: endedAt.toISOString() },
        durationMs: { state: "known", value: Math.max(0, endedAt.getTime() - startedAt.getTime()) },
      } satisfies Changes<"model_call">);
    });

    const failed = (error: CallError): CallOutcome<V> => ({
      kind: "failed",
      modelCallId: started.modelCallId,
      error,
    });
    const { next } = classified;
    if (next.retry === "none") {
      if (classified.error !== undefined) return failed(classified.error);
      const latest = latestCalls(session).get(started.modelCallId);
      return {
        kind: "completed",
        modelCallId: started.modelCallId,
        validation: classified.validation as V,
        allRejected: latest !== undefined && isAllRejected(latest),
      };
    }
    const error = classified.error as CallError;
    lastFailure = failed(error);
    if (next.retry === "transport") {
      if (transportRetries >= BACKOFF_MS.length || next.waitMs === "too_long") return failed(error);
      transportRetries += 1;
      await deps.sleep(next.waitMs);
    } else if (next.retry === "refusal") {
      if (refusalRetried) return failed(error);
      refusalRetried = true;
    } else {
      if (schemaRetried) return failed(error);
      schemaRetried = true;
      const message = schemaRetryMessage(next.issues);
      request = { ...plan.request, retryMessage: message };
      inputTokens = plan.inputTokens + Math.ceil(new TextEncoder().encode(message).length / 3);
      // A new request: its own transport retries.
      transportRetries = 0;
    }
    attempt += 1;
    retryOf = started.modelCallId;
  }

  function classify(
    result: SendResult,
    sent: ModelRequest,
    plan_: CallPlan<V>,
    deps_: SendDeps,
    priceTable: { readonly version: string; readonly date: string },
  ): Classified<V> {
    const backoff = (): number =>
      BACKOFF_MS[Math.min(transportRetries, BACKOFF_MS.length - 1)] ?? 0;
    const noResponse = (
      kind: ErrorKind,
      message: string,
      waitMs: number | "too_long" = backoff(),
    ) =>
      ({
        end: unparsed(
          plan_.purpose,
          "no_response",
          unknownUsage("no_response"),
          { state: "unknown", reason: "no_response" },
          // Unknown, never zero, with the reason the price table's rules give (§4.6).
          callCost(
            deps_.prices,
            priceTable,
            { state: "unknown", reason: "no_response" },
            unknownUsage("no_response"),
          ),
        ),
        next: { retry: "transport", waitMs },
        error: { kind, message },
      }) as Classified<V>;

    switch (result.kind) {
      case "connection":
      case "timeout":
        return noResponse(result.kind, result.kind);
      case "http_error": {
        const message = `http_${result.status}`;
        if (result.status === 429)
          return noResponse(
            "rate_limit",
            message,
            rateLimitWait(result.retryAfter, deps_.clock) ?? backoff(),
          );
        if (result.status === 408 || result.status === 409 || result.status >= 500)
          return noResponse("server", message);
        return { ...noResponse("request", message), next: { retry: "none" } };
      }
      case "response":
        break;
    }
    const read = result.message;
    if (read === undefined) return noResponse("server", "unreadable_response");

    const returnedModel: Known<string> = { state: "known", value: read.returnedModel };
    const billed = {
      returnedModel,
      usage: read.usage,
      cost: callCost(deps_.prices, priceTable, returnedModel, read.usage),
    };
    const stop = (
      reason: "truncated" | "refusal" | "unexpected_stop",
      message: string,
      next: Next,
    ): Classified<V> => ({
      end: unparsed(plan_.purpose, reason, read.usage, returnedModel, billed.cost),
      next,
      error: { kind: reason, message },
    });
    // The stop reason comes before parsing (§3.6).
    if (read.stopReason === "max_tokens")
      return stop("truncated", `reservedOutputTokens ${sent.maxTokens}`, { retry: "none" });
    if (read.stopReason === "refusal")
      return stop("refusal", nonEmptyOr(read.refusalCategory, "uncategorised"), {
        retry: "refusal",
      });
    if (read.stopReason !== "end_turn")
      return stop("unexpected_stop", nonEmptyOr(read.stopReason, "none"), { retry: "none" });

    const text = oneTextBlock(read);
    if (text === undefined) {
      const issues = [{ path: "content", code: "not_one_text_block" }];
      return schemaFailed(billed, issues, schemaEvents(issues), {});
    }
    const validation = plan_.validate(text);
    const checked = plan_.resultOf(validation);
    const extras = plan_.extrasOf?.(validation) ?? {};
    if (checked.status === "schema_failed")
      return { ...schemaFailed(billed, checked.issues, checked.events, extras), validation };
    return {
      end: {
        state: "completed",
        ...billed,
        validationEvents: [...checked.events],
        counts: recordCounts(checked.counts),
        ...withExtras(extras),
      } satisfies Changes<"model_call">,
      next: { retry: "none" },
      validation,
    };

    function schemaFailed(
      billed_: typeof billed,
      issues: readonly SchemaIssue[],
      events: readonly ValidationEvent[],
      extras_: CallExtras,
    ): Classified<V> {
      return {
        end: {
          state: "failed",
          ...billed_,
          validationEvents: [...events],
          counts: {
            proposed: { state: "unknown", reason: "schema_failed" },
            accepted: 0,
            corrected: 0,
            relabelled: 0,
            rejectedByRule: { SCHEMA: events.length },
          },
          ...citationUnknowns(plan_.purpose, "schema_failed"),
          ...withExtras(extras_),
        } satisfies Changes<"model_call">,
        next: { retry: "schema", issues },
        error: {
          kind: "schema",
          message: `${issues.length} schema issue${issues.length === 1 ? "" : "s"}`,
        },
      };
    }
  }
}

// --- Helpers ----------------------------------------------------------------------------------

const CITED: ReadonlySet<CallPurpose> = new Set(["analyse", "analyse_expansion"]);

function citationUnknowns(
  purpose: CallPurpose,
  reason: "schema_failed" | "truncated" | "refusal" | "unexpected_stop" | "no_response",
): CallExtras {
  if (!CITED.has(purpose)) return {};
  const unknown = { state: "unknown", reason } as const;
  return {
    correctedCitationRate: unknown,
    citationsProposed: unknown,
  } satisfies CallExtras;
}

function withExtras(extras: CallExtras): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      ...extras,
      ...(extras.questionOrder === undefined ? {} : { questionOrder: [...extras.questionOrder] }),
    }).filter(([, value]) => value !== undefined),
  );
}

function unknownUsage(reason: string): ReadMessage["usage"] {
  const unknown = { state: "unknown", reason } as const;
  return { input: unknown, output: unknown, cacheRead: unknown, cacheWrite: unknown };
}

/** The end of a failed send whose response wasn't parsed: no events, proposed unknown (§3.5). */
function unparsed(
  purpose: CallPurpose,
  reason: "truncated" | "refusal" | "unexpected_stop" | "no_response",
  usage: ReadMessage["usage"],
  returnedModel: Known<string>,
  cost: Ended["cost"],
): Changes<"model_call"> {
  return {
    state: "failed",
    returnedModel,
    usage,
    cost,
    validationEvents: [],
    counts: {
      proposed: { state: "unknown", reason },
      accepted: 0,
      corrected: 0,
      relabelled: 0,
      rejectedByRule: {},
    },
    ...citationUnknowns(purpose, reason),
  } satisfies Changes<"model_call">;
}

function schemaEvents(issues: readonly SchemaIssue[]): ValidationEvent[] {
  return issues.map((issue) => ({
    itemKey: "$response",
    stage: "schema",
    rule: "SCHEMA",
    outcome: "rejected",
    detail: `${issue.path === "" ? "(root)" : issue.path}: ${issue.code}`,
  }));
}

/** The response's one text block, or undefined unless it has exactly one and nothing else. */
function oneTextBlock(read: ReadMessage): string | undefined {
  return read.textBlocks.length === 1 && read.otherBlocks.length === 0
    ? read.textBlocks[0]
    : undefined;
}

function recordCounts(counts: ValidationResult<unknown, unknown>["counts"]): Ended["counts"] {
  return {
    proposed:
      counts.proposed.state === "known"
        ? { state: "known", value: counts.proposed.count }
        : { state: "unknown", reason: counts.proposed.reason },
    accepted: counts.accepted,
    corrected: counts.corrected,
    relabelled: counts.relabelled,
    rejectedByRule: Object.fromEntries(counts.rejectionsByRule.map((r) => [r.rule, r.count])),
  };
}

/**
 * The wait `retry-after` asks for: whole seconds, or an HTTP date from now. Undefined when it is
 * missing or unreadable, so the backoff applies; `too_long` over the 5-minute limit.
 */
function rateLimitWait(value: string | undefined, clock: Clock): number | "too_long" | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^[0-9]+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    // Only an IMF-fixdate, which is in GMT, so the wait doesn't depend on the time zone.
    if (!IMF_FIXDATE.test(trimmed)) return undefined;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - clock.now().getTime());
  }
  return ms > MAX_RETRY_AFTER_MS ? "too_long" : ms;
}

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/** An API value as a message, or `fallback` when it is missing or empty. */
function nonEmptyOr(value: string | null | undefined, fallback: string): string {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function latestCalls(session: HeldSession): Map<string, RecordOf<"model_call">> {
  const latest = new Map<string, RecordOf<"model_call">>();
  for (const record of session.records)
    if (record.type === "model_call") latest.set(record.modelCallId, record);
  return latest;
}

function isAllRejected(call: RecordOf<"model_call">): boolean {
  return (
    call.state === "completed" &&
    call.counts.proposed.state === "known" &&
    call.counts.proposed.value > 0 &&
    call.counts.accepted === 0
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
