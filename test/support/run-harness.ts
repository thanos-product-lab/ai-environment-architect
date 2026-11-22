import {
  type ContextSelectionSettings,
  type ReadyContext,
  selectContext,
  settingsHash,
} from "../../src/core/context/select.js";
import { type ContextSettings, DEFAULT_CONTEXT_SETTINGS } from "../../src/core/context/tiers.js";
import {
  estimateTokens,
  type LimitLookup,
  type TokenCount,
} from "../../src/core/context/token-check.js";
import { DEFAULT_TOKEN_SETTINGS } from "../../src/core/context/token-settings.js";
import type { ModelRequest, SendResult } from "../../src/core/request.js";
import type { RunDeps } from "../../src/core/run/analysis.js";
import type { PromptSet } from "../../src/core/run/prompts.js";
import type { PriceTable } from "../../src/core/session/cost.js";
import {
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
} from "../../src/core/session/records.js";
import { HeldSession } from "../../src/core/session/store.js";
import type { RepositoryFs } from "../../src/core/snapshot/repository-fs.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../../src/core/snapshot/snapshot.js";
import { fixedClock, fixedIds, MemoryFs, type MemoryNode } from "./memory-fs.js";
import { MemorySession } from "./memory-store.js";
import { testPromptSet } from "./prompts.js";
import { newLog } from "./session.js";

// A session to run calls in, for core tests: an in-memory repository, store and session, a
// sender that answers each send from a script of recorded responses, and token-count and
// model-limit ports that answer at once. No live model is ever called.

export const PRICES: PriceTable = {
  version: "prices/test",
  date: "2026-11-15",
  models: { "claude-test": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.5 } },
};

const HEADER: Omit<SessionFile, "records"> = {
  format: SESSION_FORMAT,
  schemaVersion: SESSION_SCHEMA_VERSION,
  writtenBy: "0.1.0",
  session: {
    id: "ses_0001",
    createdAt: "2026-11-01T10:15:00.000Z",
    productVersion: "0.1.0",
    adapter: "claude-code",
    outputScope: ["root CLAUDE.md"],
    repository: { name: "fixture", root: "/r/fixture" },
    targetPath: "CLAUDE.md",
  },
};

/** One scripted answer: a response's text, or a function of the request. */
export type Answer = string | ((request: ModelRequest) => SendResult);

const encode = (text: string) => new TextEncoder().encode(text);

export function response(request: ModelRequest, text: string): SendResult {
  return {
    kind: "response",
    requestBytes: encode(JSON.stringify(request)),
    responseBytes: encode(JSON.stringify({ text })),
    message: {
      returnedModel: "claude-test",
      stopReason: "end_turn",
      textBlocks: [text],
      otherBlocks: [],
      usage: {
        input: { state: "known", value: estimateTokens(request) },
        output: { state: "known", value: 400 },
        cacheRead: { state: "known", value: 0 },
        cacheWrite: { state: "known", value: 0 },
      },
    },
  };
}

export interface HarnessOptions {
  readonly context?: Partial<ContextSettings>;
  /** The token count of each request; by default its byte estimate. */
  readonly count?: (request: ModelRequest) => number;
  readonly maxInputTokens?: number;
  /** The session's `maxExpansionRequests`; the schema's ceiling, 5, by default. */
  readonly maxExpansionRequests?: number;
  readonly questionBudget?: number;
  /** The generation budget (§4.6); none by default. */
  readonly budget?: { readonly maxTokens?: number; readonly maxCostUsd?: number };
  /** The model's `max_tokens` in the Models API; 64,000 by default. */
  readonly maxOutputTokens?: number | null;
  /** The prompt set; the test-only placeholders by default. */
  readonly prompts?: PromptSet;
}

export interface Harness {
  readonly session: HeldSession;
  /** Where the session is saved, to load it again. */
  readonly store: MemorySession;
  readonly deps: RunDeps;
  readonly fs: MemoryFs;
  readonly context: ReadyContext;
  readonly destination: Uint8Array | undefined;
  /** Every request sent, in order. */
  readonly sent: ModelRequest[];
}

export async function harness(
  nodes: Record<string, MemoryNode>,
  script: readonly Answer[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const settings: ContextSelectionSettings = {
    snapshot: DEFAULT_SNAPSHOT_SETTINGS,
    context: { ...DEFAULT_CONTEXT_SETTINGS, ...options.context },
    tokens: DEFAULT_TOKEN_SETTINGS,
  };
  const fs = new MemoryFs(nodes);
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    settings.snapshot,
  );
  const context = await selectContext(snapshot, settings, fs);
  if (context.state !== "ready") throw new Error(`expected a context, got ${context.state}`);

  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  log.start({
    type: "generation_config",
    settings,
    settingsHash: settingsHash(settings),
    requestedModel: "claude-test",
    effort: "medium",
    budget: { ...options.budget },
    expansion: {
      maxExpansionRequests: options.maxExpansionRequests ?? 5,
      expansionBytes: 50_000,
      expansionEntryBytes: 20_000,
    },
    questionBudget: options.questionBudget ?? 5,
    retainModelInputs: true,
  });
  const store = new MemorySession();
  const session = new HeldSession(store, HEADER, log);
  await session.save();

  const { deps, sent } = scriptedRunDeps(fs, script, options);
  const destination =
    snapshot.destination.state === "present" ? snapshot.destination.bytes : undefined;
  return { session, store, deps, fs, context, destination, sent };
}

/**
 * The ports a run needs, with a sender that answers each send from `script`, in order, and a
 * clock that ticks one second per reading. `sent` collects every request sent.
 */
export function scriptedRunDeps(
  fs: RepositoryFs,
  script: readonly Answer[],
  options: Pick<HarnessOptions, "count" | "maxInputTokens" | "maxOutputTokens" | "prompts"> = {},
): { readonly deps: RunDeps; readonly sent: ModelRequest[] } {
  const sent: ModelRequest[] = [];
  let now = Date.UTC(2026, 10, 1, 11, 0, 0);
  const deps: RunDeps = {
    sender: {
      requestBytes: (request) => encode(JSON.stringify(request)),
      async send(request) {
        sent.push(request);
        const answer = script[sent.length - 1];
        if (answer === undefined) throw new Error(`no scripted answer for send ${sent.length}`);
        return typeof answer === "function" ? answer(request) : response(request, answer);
      },
    },
    prices: PRICES,
    clock: {
      now() {
        const date = new Date(now);
        now += 1000;
        return date;
      },
    },
    async sleep(ms) {
      now += ms;
    },
    counter: {
      async countTokens(request): Promise<TokenCount> {
        return { state: "counted", inputTokens: (options.count ?? estimateTokens)(request) };
      },
    },
    models: {
      async modelLimits(): Promise<LimitLookup> {
        return {
          state: "known",
          maxInputTokens: options.maxInputTokens ?? 200_000,
          maxOutputTokens: options.maxOutputTokens === undefined ? 64_000 : options.maxOutputTokens,
        };
      },
    },
    fs,
    prompts: options.prompts ?? testPromptSet(),
    apiVersion: "2026-10-21",
    allowTestPrompts: true,
  };
  return { deps, sent };
}
