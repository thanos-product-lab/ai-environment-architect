import { describe, expect, it } from "vitest";
import {
  fixedClock,
  fixedIds,
  MemoryFs,
  type MemoryNode,
  seededShuffle,
} from "../../../test/support/memory-fs.js";
import { CALL_SCHEMAS } from "../../schemas/index.js";
import { sha256 } from "../hash.js";
import type { ModelRequest } from "../request.js";
import { inputManifest } from "../session/records.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { deterministicGapCoverage } from "../validation/coverage.js";
import { type ContextSelectionSettings, type ReadyContext, selectContext } from "./select.js";
import {
  AGENT_CONFIG_SKIPPED,
  AGENT_CONFIG_TOKEN_LIMIT,
  DEFAULT_CONTEXT_SETTINGS,
} from "./tiers.js";
import {
  type CitedExcerpt,
  checkContextCall,
  checkTokens,
  contextReductions,
  estimateTokens,
  excerptReductions,
  type ModelLimits,
  type Reduction,
  reduceContext,
  scanRequest,
  type TokenCounter,
} from "./token-check.js";
import type { TokenSettings } from "./token-settings.js";

// The token check (IMPL §1.10) and its manifest entry (IMPL §1.13). No live model: the counter
// and the model's limits are fakes.

const join = (...fragments: string[]): string => fragments.join("");
const awsKey = join("AKIA", "IOSFODNN7EXAMPLE");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Small output reserves and no margin, so the limits in a test are easy to read. */
const TOKENS: TokenSettings = {
  reservedOutputTokens: {
    analyse: 100,
    analyse_expansion: 100,
    generate_questions: 100,
    recommend: 100,
    regenerate_recommendations: 100,
  },
  safetyMargin: 0,
};

function request(user: string, overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "claude-test",
    maxTokens: 100,
    effort: "medium",
    system: "System.",
    user,
    schema: CALL_SCHEMAS.analyse.apiSchema,
    ...overrides,
  };
}

/** Counts a request as the bytes of its user content, and records what it was given. */
function byteCounter(fail: (n: number) => boolean = () => false) {
  const counted: ModelRequest[] = [];
  const counter: TokenCounter = {
    async countTokens(req) {
      counted.push(req);
      return fail(counted.length)
        ? { state: "failed", reason: "connection" }
        : { state: "counted", inputTokens: bytes(req.user) };
    },
  };
  return { counter, counted };
}

function limits(maxInputTokens: number | "fail"): ModelLimits & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async modelLimits(model) {
      asked.push(model);
      return maxInputTokens === "fail"
        ? { state: "failed", reason: "connection" }
        : { state: "known", maxInputTokens, maxOutputTokens: 128_000 };
    },
  };
}

const units = (n: number): Reduction[] =>
  Array.from({ length: n }, (_, i) => ({
    step: "tier5" as const,
    id: `T5-00${i + 1}`,
    path: `src/f${i + 1}.ts`,
    bytes: 100,
  }));

/** A plan whose request is 100 bytes of user content per unit still present. */
function plan(n: number, user: (remaining: number) => string = (r) => "x".repeat(100 * r)) {
  return { units: units(n), render: (removed: number) => request(user(n - removed)) };
}

describe("checkTokens (IMPL §1.10)", () => {
  it("sends with no reductions when the request fits, counted by the provider", async () => {
    const { counter, counted } = byteCounter();
    const result = await checkTokens("analyse", plan(3), {
      counter,
      models: limits(400),
      tokens: TOKENS,
    });
    expect(result).toMatchObject({
      state: "fits",
      removed: 0,
      tokenCheck: {
        model: "claude-test",
        method: "provider_count",
        inputTokens: 300,
        reservedOutputTokens: 100,
        contextLimit: 400,
        reductions: [],
      },
    });
    expect(counted).toHaveLength(1);
  });

  it("removes one item at a time, re-counting after each, and stops as soon as it fits", async () => {
    const { counter, counted } = byteCounter();
    const result = await checkTokens("analyse", plan(5), {
      counter,
      models: limits(400),
      tokens: TOKENS,
    });
    // 500 + 100 > 400, 400 + 100 > 400, 300 + 100 = 400 fits.
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    expect(result.removed).toBe(2);
    expect(result.tokenCheck.reductions).toEqual(units(5).slice(0, 2));
    expect(result.tokenCheck.inputTokens).toBe(300);
    expect(counted.map((r) => bytes(r.user))).toEqual([500, 400, 300]);
    expect(result.request.user).toBe("x".repeat(300));
  });

  it("requires inputTokens + reservedOutputTokens + safetyMargin ≤ the limit, the margin rounded up", async () => {
    // A margin of 5% of 1001 is 50.05, so 51 tokens: 850 + 100 + 51 = 1001 fits, 851 doesn't.
    const tokens = { ...TOKENS, safetyMargin: 0.05 };
    const at = (user: number) =>
      checkTokens(
        "analyse",
        { units: [], render: () => request("x".repeat(user)) },
        {
          counter: byteCounter().counter,
          models: limits(1001),
          tokens,
        },
      );
    expect((await at(850)).state).toBe("fits");
    expect((await at(851)).state).toBe("does_not_fit");
  });

  it("uses the call's reservedOutputTokens, and refuses a request whose max_tokens differs", async () => {
    const tokens = {
      ...TOKENS,
      reservedOutputTokens: { ...TOKENS.reservedOutputTokens, analyse_expansion: 50 },
    };
    const fits = await checkTokens(
      "analyse_expansion",
      { units: [], render: () => request("x".repeat(350), { maxTokens: 50 }) },
      { counter: byteCounter().counter, models: limits(400), tokens },
    );
    expect(fits).toMatchObject({ state: "fits", tokenCheck: { reservedOutputTokens: 50 } });
    await expect(
      checkTokens("analyse_expansion", plan(1), {
        counter: byteCounter().counter,
        models: limits(400),
        tokens,
      }),
    ).rejects.toThrow(/max_tokens/);
  });

  it("is not sent, with every item removed, when it still doesn't fit", async () => {
    const result = await checkTokens(
      "analyse",
      plan(2, (r) => "x".repeat(500 + 100 * r)),
      { counter: byteCounter().counter, models: limits(400), tokens: TOKENS },
    );
    expect(result).toMatchObject({
      state: "does_not_fit",
      removed: 2,
      tokenCheck: { inputTokens: 500, reductions: units(2) },
    });
  });

  it("scans the complete request before counting it, and counts nothing on a match", async () => {
    const { counter, counted } = byteCounter();
    const result = await checkTokens(
      "analyse",
      { units: units(1), render: () => request(`id = ${awsKey}\n`) },
      { counter, models: limits(400), tokens: TOKENS },
    );
    expect(result).toMatchObject({
      state: "secret_match",
      ruleId: "aws-access-key-id",
      removed: 0,
      match: { part: "user", start: 5, end: 5 + awsKey.length },
    });
    expect(counted).toHaveLength(0);
  });

  it("scans the system prompt too", async () => {
    const { counter, counted } = byteCounter();
    const result = await checkTokens(
      "analyse",
      { units: [], render: () => request("x", { system: `key ${awsKey}` }) },
      { counter, models: limits(400), tokens: TOKENS },
    );
    expect(result).toMatchObject({ state: "secret_match", match: { part: "system", start: 4 } });
    expect(counted).toHaveLength(0);
  });

  it("scans again after a reduction renders the request again", async () => {
    const { counter, counted } = byteCounter();
    const result = await checkTokens(
      "analyse",
      plan(3, (r) => (r === 2 ? `${awsKey}\n` : "x".repeat(100 * r))),
      { counter, models: limits(250), tokens: TOKENS },
    );
    expect(result).toMatchObject({
      state: "secret_match",
      ruleId: "aws-access-key-id",
      removed: 1,
    });
    // The request returned is the one that matched, so the runner can map the match to records.
    expect(result.state === "secret_match" && result.request.user).toBe(`${awsKey}\n`);
    expect(counted).toHaveLength(1);
  });

  it("sends nothing and counts nothing when the input-limit lookup fails", async () => {
    const { counter, counted } = byteCounter();
    const models = limits("fail");
    const result = await checkTokens("analyse", plan(1), { counter, models, tokens: TOKENS });
    expect(result).toEqual({ state: "limit_unavailable", reason: "connection" });
    expect(models.asked).toEqual(["claude-test"]);
    expect(counted).toHaveLength(0);
  });

  it("uses 1 token per 3 bytes, rounded up, when a count fails, for the rest of the check", async () => {
    // Only the first count fails; the estimate is still used after it.
    const { counter, counted } = byteCounter((n) => n === 1);
    // By the estimate, it fits with 200 bytes of user content left: 3 of the 5 units removed.
    const limit = estimateTokens(request("x".repeat(200))) + TOKENS.reservedOutputTokens.analyse;
    const result = await checkTokens("analyse", plan(5), {
      counter,
      models: limits(limit),
      tokens: TOKENS,
    });
    expect(counted).toHaveLength(1);
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    expect(result.removed).toBe(3);
    expect(result.tokenCheck.method).toBe("estimate");
    expect(result.tokenCheck.inputTokens).toBe(estimateTokens(result.request));
  });

  it("scans a schema retry's message with the rest of the request", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    expect(scanRequest(request("x"))).toBeUndefined();
    expect(scanRequest({ ...request("x"), retryMessage: secret })).toBe("aws-access-key-id");
  });

  it("estimates a schema retry's message with the user content", () => {
    const req = { ...request("x"), retryMessage: "- (root): invalid_type" };
    const total =
      bytes(req.system) +
      bytes(req.user) +
      bytes(req.retryMessage) +
      bytes(JSON.stringify(req.schema));
    expect(estimateTokens(req)).toBe(Math.ceil(total / 3));
  });

  it("estimates over the system prompt, the user content and the schema's JSON", () => {
    const req = request("é".repeat(10));
    const total = bytes(req.system) + bytes(req.user) + bytes(JSON.stringify(req.schema));
    expect(estimateTokens(req)).toBe(Math.ceil(total / 3));
  });
});

// --- Calls 1 and 2: the initial context --------------------------------------------------------

const REPO: Record<string, MemoryNode> = {
  "CLAUDE.md": "# Rules\n\n- Run the tests.\n",
  "AGENTS.md": "# Agents\n\nBe brief.\n",
  ".claude/rules/style.md": "# Style\n\nShort lines.\n",
  "README.md": "# App\n\nA small app.\n",
  "docs/guide.md": "# Guide\n\nHow to use it.\n",
  "package.json": '{ "name": "app", "scripts": { "test": "vitest" } }\n',
  "src/index.ts": "export function main() {\n  return 1;\n}\n",
  "src/index.test.ts": 'import { main } from "./index";\n',
  "src/util.ts": "export const util = 1;\n",
  "src/extra.ts": "export const extra = 2;\n",
};

const SETTINGS: ContextSelectionSettings = {
  snapshot: DEFAULT_SNAPSHOT_SETTINGS,
  context: DEFAULT_CONTEXT_SETTINGS,
  tokens: TOKENS,
};

async function ready(
  nodes: Record<string, MemoryNode> = REPO,
  order?: (names: string[]) => string[],
): Promise<ReadyContext> {
  const fs = new MemoryFs(nodes, order === undefined ? {} : { order });
  const snapshot = await captureSnapshot(
    { fs, clock: fixedClock, ids: fixedIds },
    SETTINGS.snapshot,
  );
  const result = await selectContext(snapshot, SETTINGS, fs);
  if (result.state !== "ready") throw new Error(`expected a context, got ${result.state}`);
  return result;
}

/** The call's request: the context is the user content, nothing else. */
const build = (context: ReadyContext) => request(context.context.text);

const pathsOf = (reductions: readonly Reduction[]) =>
  reductions.map((r) => ("path" in r ? r.path : r.step));

describe("the reduction order for calls 1 and 2 (IMPL §1.10)", () => {
  it("removes tier 5 last selected first with test examples last, then tier 2, then other tier 1", async () => {
    const context = await ready();
    const reductions = contextReductions(context);
    const tier5 = context.items.filter((i) => i.tier === 5);
    const ordinary = tier5.filter((i) => i.reason !== "tier5:test-example").map((i) => i.path);
    expect(pathsOf(reductions)).toEqual([
      ...ordinary.reverse(),
      "src/index.test.ts",
      "docs/guide.md",
      "README.md",
      ".claude/rules/style.md",
      "AGENTS.md",
    ]);
    expect(reductions.map((r) => r.step)).toEqual([
      "tier5",
      "tier5",
      "tier5",
      "tier5",
      "tier2",
      "tier2",
      "tier1",
      "tier1",
    ]);
  });

  it("never removes the destination, tier 3 manifests or the known facts", async () => {
    const context = await ready();
    const paths = pathsOf(contextReductions(context));
    expect(paths).not.toContain("CLAUDE.md");
    expect(paths).not.toContain("package.json");
    const result = await checkContextCall("analyse_expansion", context, build, {
      counter: byteCounter().counter,
      models: limits(10),
      tokens: TOKENS,
    });
    expect(result.state).toBe("skipped");
    if (result.state !== "skipped") return;
    const text = result.lastRequest.user;
    expect(text.startsWith("<<<KNOWN FACTS>>>")).toBe(true);
    expect(text).toContain('path="CLAUDE.md"');
    expect(text).toContain('path="package.json"');
    expect(text).not.toContain('path="src/util.ts"');
  });
});

describe("reduceContext (IMPL §1.3 step 7, §1.13)", () => {
  it("leaves the removed items out, marks them [-] in the tree and hashes the final context", async () => {
    const context = await ready();
    const removed = context.items.find((i) => i.path === "src/util.ts");
    if (removed === undefined) throw new Error("src/util.ts not selected");
    const reduced = reduceContext(context, new Set([removed.id]));
    expect(reduced.items.map((i) => i.id)).not.toContain(removed.id);
    expect(reduced.context.text).not.toContain(`id=${removed.id} `);
    expect(reduced.tree.text).toContain("[-] util.ts\n");
    expect(context.tree.text).not.toContain("[-] util.ts\n");
    expect(reduced.context.hash).toBe(sha256(new TextEncoder().encode(reduced.context.text)));
    expect(reduced.manifest.contextHash).toBe(reduced.context.hash);
    expect(reduced.manifest.budget.usedBytes).toBe(reduced.context.bytes);
  });

  it("keeps the other items' IDs, lists the removed item in skipped and updates its tier", async () => {
    const context = await ready();
    const removed = context.items.find((i) => i.path === "src/util.ts");
    if (removed === undefined) throw new Error("src/util.ts not selected");
    const reduced = reduceContext(context, new Set([removed.id]));
    expect(reduced.items.map((i) => i.id)).toEqual(
      context.items.filter((i) => i.id !== removed.id).map((i) => i.id),
    );
    expect(reduced.manifest.items.map((i) => i.id)).not.toContain(removed.id);
    expect(reduced.manifest.skipped).toContainEqual({
      path: "src/util.ts",
      reason: "token-check:tier5",
    });
    const before = context.manifest.tiers.find((t) => t.tier === 5);
    const after = reduced.manifest.tiers.find((t) => t.tier === 5);
    expect(after).toMatchObject({
      items: (before && "items" in before ? before.items : 0) - 1,
      skipped: (before && "skipped" in before ? before.skipped : 0) + 1,
      usedBytes: (before?.usedBytes ?? 0) - removed.rendered.bytes,
    });
  });

  it("gives the same context for the same snapshot, settings and limit, whatever the enumeration order", async () => {
    // A limit between the full context and the fully reduced one.
    const full = await ready();
    const target = full.context.bytes - 200 + TOKENS.reservedOutputTokens.analyse;
    const at = async (order?: (names: string[]) => string[]) => {
      const result = await checkContextCall("analyse", await ready(REPO, order), build, {
        counter: byteCounter().counter,
        models: limits(target),
        tokens: TOKENS,
      });
      if (result.state !== "fits") throw new Error(`expected fits, got ${result.state}`);
      return result.context.manifest.contextHash;
    };
    const hashes = await Promise.all([at(), at(seededShuffle(1)), at(seededShuffle(7))]);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).not.toBe(full.context.hash);
  });
});

describe("checkContextCall (IMPL §1.10, §1.13)", () => {
  it("looks the limit up once and keeps the estimate for call 1's recount without the destination", async () => {
    const { counter, counted } = byteCounter((n) => n === 1);
    const models = limits(10);
    const result = await checkContextCall("analyse", await ready(), build, {
      counter,
      models,
      tokens: TOKENS,
    });
    expect(result.state).toBe("context_exceeds_input_limit");
    // Only the first count went to the provider; every later one, the recount included, is
    // the estimate.
    expect(counted).toHaveLength(1);
    expect(models.asked).toEqual(["claude-test"]);
  });

  it("scans the recount without the destination too", async () => {
    const leaky = (c: ReadyContext) =>
      request(
        c.items.some((i) => i.path === "CLAUDE.md")
          ? c.context.text
          : `${c.context.text}${awsKey}\n`,
      );
    expect(
      await checkContextCall("analyse", await ready(), leaky, {
        counter: byteCounter().counter,
        models: limits(10),
        tokens: TOKENS,
      }),
    ).toMatchObject({ state: "secret_match", ruleId: "aws-access-key-id" });
  });

  it("keeps call 2's expansion results while removing context items", async () => {
    const withExpansion = (c: ReadyContext) =>
      request(`${c.context.text}<<<ITEM id=E-001 path="src/more.ts">>>\nmore\n<<<END ITEM>>>\n`);
    const result = await checkContextCall("analyse_expansion", await ready(), withExpansion, {
      counter: byteCounter().counter,
      models: limits(10),
      tokens: TOKENS,
    });
    expect(result.state).toBe("skipped");
    if (result.state !== "skipped") return;
    expect(result.lastRequest.user).toContain("id=E-001");
    expect(result.lastRequest.user).not.toContain('path="src/util.ts"');
  });

  it("lists every removed item in skipped with its tier's reason, and counts test examples out", async () => {
    const context = await ready();
    const all = new Set(contextReductions(context).map((r) => ("id" in r ? r.id : "")));
    const reduced = reduceContext(context, all);
    const reasons = reduced.manifest.skipped.map((s) => s.reason);
    for (const reason of ["token-check:tier1", "token-check:tier2", "token-check:tier5"])
      expect(reasons).toContain(reason);
    expect(reduced.manifest.tiers.find((t) => t.tier === 5)).toMatchObject({
      items: 0,
      usedBytes: 0,
      testExamples: 0,
    });
    expect(reduced.items.map((i) => i.path).sort()).toEqual(["CLAUDE.md", "package.json"]);
  });

  it("records the check and each reduction in the manifest of a call that is sent", async () => {
    const context = await ready();
    const first = contextReductions(context)[0];
    if (first === undefined || !("path" in first)) throw new Error("no reduction");
    // Room for everything but the first item to remove.
    const limit = context.context.bytes - first.bytes + TOKENS.reservedOutputTokens.analyse;
    const result = await checkContextCall("analyse", context, build, {
      counter: byteCounter().counter,
      models: limits(limit),
      tokens: TOKENS,
    });
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    expect(result.context.manifest.tokenCheck).toEqual({
      model: "claude-test",
      method: "provider_count",
      inputTokens: result.context.context.bytes,
      reservedOutputTokens: 100,
      contextLimit: limit,
      reductions: [first],
    });
    expect(inputManifest.safeParse(result.context.manifest).success).toBe(true);
    expect(result.request.user).toBe(result.context.context.text);
    expect(result.context.tree.text).toContain(`[-] ${first.path.split("/").at(-1)}\n`);
  });

  it("records an empty reduction list when nothing is removed", async () => {
    const context = await ready();
    const result = await checkContextCall("analyse", context, build, {
      counter: byteCounter().counter,
      models: limits(1_000_000),
      tokens: TOKENS,
    });
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    expect(result.context.context.hash).toBe(context.context.hash);
    expect(result.context.manifest.tokenCheck?.reductions).toEqual([]);
  });

  it("skips call 2 when it still doesn't fit, sending nothing", async () => {
    const result = await checkContextCall("analyse_expansion", await ready(), build, {
      counter: byteCounter().counter,
      models: limits(10),
      tokens: TOKENS,
    });
    expect(result.state).toBe("skipped");
  });

  it("stops call 1 by the destination rule when it would fit without the destination", async () => {
    const big = { ...REPO, "CLAUDE.md": `# Rules\n\n${"- Run the tests.\n".repeat(400)}` };
    const context = await ready(big);
    const destination = context.items.find((i) => i.path === "CLAUDE.md");
    if (destination === undefined) throw new Error("no destination");
    const reducedAll = reduceContext(
      context,
      new Set(contextReductions(context).map((r) => ("id" in r ? r.id : ""))),
    );
    // Fits without the destination, not with it.
    const limit =
      reducedAll.context.bytes - destination.rendered.bytes + TOKENS.reservedOutputTokens.analyse;
    const result = await checkContextCall("analyse", context, build, {
      counter: byteCounter().counter,
      models: limits(limit + 50),
      tokens: TOKENS,
    });
    expect(result).toMatchObject({
      state: "stopped",
      stop: { reason: "destination_exceeds_input_limit", contextLimit: limit + 50 },
    });
  });

  it("stops call 1 as context_exceeds_input_limit when even the request without the destination doesn't fit", async () => {
    const result = await checkContextCall("analyse", await ready(), build, {
      counter: byteCounter().counter,
      models: limits(10),
      tokens: TOKENS,
    });
    expect(result).toMatchObject({ state: "context_exceeds_input_limit", contextLimit: 10 });
  });

  it("passes on a failed limit lookup and a secret match, sending nothing", async () => {
    const context = await ready();
    expect(
      await checkContextCall("analyse", context, build, {
        counter: byteCounter().counter,
        models: limits("fail"),
        tokens: TOKENS,
      }),
    ).toEqual({ state: "limit_unavailable", reason: "connection" });
    const leaky = (c: ReadyContext) => request(`${c.context.text}${awsKey}\n`);
    expect(
      await checkContextCall("analyse", context, leaky, {
        counter: byteCounter().counter,
        models: limits(1_000_000),
        tokens: TOKENS,
      }),
    ).toMatchObject({ state: "secret_match", ruleId: "aws-access-key-id" });
  });
});

// --- Calls 3–5: cited excerpts, then the tree depth -------------------------------------------

describe("the reduction order for calls 3–5 (IMPL §1.10 step 4)", () => {
  const excerpts: CitedExcerpt[] = [
    { id: "X-1", path: "src/a.ts", bytes: 10, findings: ["fnd_a"] },
    { id: "X-2", path: "src/b.ts", bytes: 20, findings: ["fnd_b", "fnd_c"] },
    { id: "X-3", path: "src/c.ts", bytes: 30, findings: ["fnd_c"] },
    { id: "X-4", path: "src/d.ts", bytes: 40, findings: ["fnd_d"] },
  ];

  it("removes excerpts no referenced finding cites, last rendered first, then the tree depth to 0", () => {
    expect(excerptReductions(excerpts, new Set(["fnd_b", "fnd_d"]), 3)).toEqual([
      { step: "excerpt", id: "X-3", path: "src/c.ts", bytes: 30 },
      { step: "excerpt", id: "X-1", path: "src/a.ts", bytes: 10 },
      { step: "tree_depth", treeDepth: 2 },
      { step: "tree_depth", treeDepth: 1 },
      { step: "tree_depth", treeDepth: 0 },
    ]);
  });

  it("in call 3, with nothing referenced yet, every excerpt may be removed", () => {
    expect(pathsOf(excerptReductions(excerpts, new Set(), 0))).toEqual([
      "src/d.ts",
      "src/c.ts",
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("records a path that matches the secret scan by its hash", () => {
    const path = `keys/${awsKey}.txt`;
    const [reduction] = excerptReductions(
      [{ id: "X-1", path, bytes: 5, findings: [] }],
      new Set(),
      0,
    );
    expect(reduction).toEqual({
      step: "excerpt",
      id: "X-1",
      pathHash: sha256(new TextEncoder().encode(path)),
      bytes: 5,
    });
  });
});

// --- Agent configuration the token check removed (IMPL §1.5, §1.10, §1.11) ---------------------

const idsOf = (context: ReadyContext, paths: string[]) =>
  new Set(context.items.filter((i) => paths.includes(i.path)).map((i) => i.id));

/** Room for everything but the first `n` reductions of `context`'s request under `make`. */
function limitAfter(
  context: ReadyContext,
  n: number,
  make: (c: ReadyContext) => ModelRequest = build,
): number {
  const units = contextReductions(context);
  const removed = units.slice(0, n).reduce((sum, u) => sum + ("bytes" in u ? u.bytes : 0), 0);
  return bytes(make(context).user) - removed + TOKENS.reservedOutputTokens.analyse;
}

const tier1Index = (context: ReadyContext, path: string) =>
  contextReductions(context).findIndex((u) => "path" in u && u.path === path);

describe("removed agent configuration (IMPL §1.10)", () => {
  it("adds the §1.5 gap, naming the token check as the cause, for the removed paths only", async () => {
    const context = await ready();
    const reduced = reduceContext(context, idsOf(context, ["AGENTS.md", ".claude/rules/style.md"]));
    expect(reduced.tokenCheckGaps).toEqual([
      {
        gapType: "other",
        statement: AGENT_CONFIG_TOKEN_LIMIT,
        relatedPaths: ["AGENTS.md", ".claude/rules/style.md"],
      },
    ]);
    expect(AGENT_CONFIG_TOKEN_LIMIT).not.toBe(AGENT_CONFIG_SKIPPED);
    expect(AGENT_CONFIG_TOKEN_LIMIT).toMatch(/input limit/);
    // The selection's gaps, recorded before call 1, are unchanged.
    expect(reduced.gaps).toEqual(context.gaps);
  });

  it("lists the paths in rendering order, whatever order the IDs come in", async () => {
    const context = await ready();
    const ids = [...idsOf(context, ["AGENTS.md", ".claude/rules/style.md"])].reverse();
    const reduced = reduceContext(context, new Set(ids));
    expect(reduced.tokenCheckGaps[0]?.relatedPaths).toEqual([
      "AGENTS.md",
      ".claude/rules/style.md",
    ]);
  });

  it("makes the removed files not inspected from the start (IMPL §1.11)", async () => {
    const context = await ready();
    const [gap] = reduceContext(context, idsOf(context, ["AGENTS.md"])).tokenCheckGaps;
    if (gap === undefined) throw new Error("no gap");
    expect(deterministicGapCoverage(gap)).toEqual({
      state: "not_inspected",
      entries: [{ path: "AGENTS.md" }],
      directories: [],
    });
  });

  it("adds no gap when no agent configuration is removed, and never names the destination", async () => {
    const context = await ready();
    expect(
      reduceContext(context, idsOf(context, ["src/util.ts", "README.md"])).tokenCheckGaps,
    ).toEqual([]);
    expect(reduceContext(context, idsOf(context, ["CLAUDE.md"])).tokenCheckGaps).toEqual([]);
  });

  it("gives the call that is sent its gap, to record before it is sent", async () => {
    const context = await ready();
    const n = tier1Index(context, ".claude/rules/style.md") + 1;
    const result = await checkContextCall("analyse", context, build, {
      counter: byteCounter().counter,
      models: limits(limitAfter(context, n)),
      tokens: TOKENS,
    });
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    const gap = {
      gapType: "other",
      statement: AGENT_CONFIG_TOKEN_LIMIT,
      relatedPaths: [".claude/rules/style.md"],
    };
    expect(result.gap).toEqual(gap);
    expect(result.context.tokenCheckGaps).toEqual([gap]);
  });

  it("gives no gap to a call that removes no agent configuration", async () => {
    const context = await ready();
    const result = await checkContextCall("analyse", context, build, {
      counter: byteCounter().counter,
      models: limits(limitAfter(context, 1)),
      tokens: TOKENS,
    });
    expect(result).toMatchObject({ state: "fits" });
    if (result.state !== "fits") return;
    expect(result.gap).toBeUndefined();
    expect(result.context.tokenCheckGaps).toEqual([]);
  });
});

// --- Call 2 starts from call 1's reduced context (IMPL §1.10) ---------------------------------

describe("call 2 after call 1's reductions (IMPL §1.10)", () => {
  const withExpansion = (c: ReadyContext) =>
    request(`${c.context.text}<<<ITEM id=E-001 path="src/more.ts">>>\nmore\n<<<END ITEM>>>\n`);

  async function afterCall1(removeCount: number) {
    const context = await ready();
    const units = contextReductions(context);
    const result = await checkContextCall("analyse", context, build, {
      counter: byteCounter().counter,
      models: limits(limitAfter(context, removeCount)),
      tokens: TOKENS,
    });
    if (result.state !== "fits") throw new Error(`call 1: ${result.state}`);
    expect(result.context.manifest.tokenCheck?.reductions).toHaveLength(removeCount);
    return { units, sent: result.context, gap: result.gap };
  }

  const tokenCheckSkips = (c: ReadyContext) =>
    c.manifest.skipped.filter((s) => s.reason.startsWith("token-check:"));

  it("keeps call 1's removals: a further reduction of call 1's context never brings an item back", async () => {
    const { units, sent } = await afterCall1(2);
    const next = units[2];
    if (next === undefined || !("id" in next)) throw new Error("no third unit");
    const further = reduceContext(sent, new Set([next.id]));
    const ids = further.items.map((i) => i.id);
    for (const u of units.slice(0, 3)) expect(ids).not.toContain("id" in u ? u.id : "");
    expect(tokenCheckSkips(further)).toHaveLength(3);
  });

  it("applies its own reductions from there, recording only its own, with the expansion results kept", async () => {
    const { units, sent } = await afterCall1(2);
    const third = units[2];
    if (third === undefined) throw new Error("no third unit");
    const result = await checkContextCall("analyse_expansion", sent, withExpansion, {
      counter: byteCounter().counter,
      models: limits(limitAfter(sent, 1, withExpansion)),
      tokens: TOKENS,
    });
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    expect(result.context.manifest.tokenCheck?.reductions).toEqual([third]);
    expect(contextReductions(sent)[0]).toEqual(third);
    expect(tokenCheckSkips(result.context)).toHaveLength(3);
    expect(result.request.user).toContain("id=E-001");
    const ids = result.context.items.map((i) => i.id);
    for (const u of units.slice(0, 3)) expect(ids).not.toContain("id" in u ? u.id : "");
  });

  it("gives call 2 a separate gap for only its own removed configuration, keeping call 1's", async () => {
    const context = await ready();
    const call1 = await afterCall1(tier1Index(context, ".claude/rules/style.md") + 1);
    expect(call1.gap?.relatedPaths).toEqual([".claude/rules/style.md"]);
    // Call 2's only remaining removable item is AGENTS.md.
    expect(contextReductions(call1.sent).map((u) => ("path" in u ? u.path : ""))).toEqual([
      "AGENTS.md",
    ]);
    const result = await checkContextCall("analyse_expansion", call1.sent, withExpansion, {
      counter: byteCounter().counter,
      models: limits(limitAfter(call1.sent, 1, withExpansion)),
      tokens: TOKENS,
    });
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    const gap2 = {
      gapType: "other",
      statement: AGENT_CONFIG_TOKEN_LIMIT,
      relatedPaths: ["AGENTS.md"],
    };
    expect(result.gap).toEqual(gap2);
    expect(result.context.tokenCheckGaps).toEqual([call1.gap, gap2]);
    expect(result.context.gaps).toEqual(context.gaps);
  });

  it("sends call 2 unreduced when call 1's context and the expansion fit, keeping call 1's skips", async () => {
    const { sent } = await afterCall1(1);
    const result = await checkContextCall("analyse_expansion", sent, withExpansion, {
      counter: byteCounter().counter,
      models: limits(1_000_000),
      tokens: TOKENS,
    });
    expect(result.state).toBe("fits");
    if (result.state !== "fits") return;
    expect(result.context.context.hash).toBe(sent.context.hash);
    expect(result.context.manifest.tokenCheck?.reductions).toEqual([]);
    expect(tokenCheckSkips(result.context)).toHaveLength(1);
    expect(result.gap).toBeUndefined();
  });
});
