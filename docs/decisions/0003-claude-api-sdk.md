# ADR 0003: Claude API SDK

**AI Environment Architect · AI Product Studio**

**Date:** 9 November 2026  
**Status:** Accepted (9 November 2026)  
**Context:** M6 connects the product to the Claude API. [ADR 0002](0002-toolchain.md) left the SDK to this milestone. This record picks the package and pins it, and says how the adapter uses it, because several of the SDK's defaults would break what the specs promise.

## What the choices are judged on

1. **The schema we hash is the schema we send** (IMPL §3.7).
2. **Every send is recorded.** Each request can cost money, so each is its own model call, written before it is sent (IMPL §4.6).
3. **Exact exchanges can be retained**, byte for byte, for replay (IMPL §1.12, §4.8).
4. **Few dependencies, pinned exactly** (ADR 0002).

Every fact below was checked on 9 November 2026 against the sources at the end, not from memory.

## Decisions

| Choice | Decision | Alternative |
|---|---|---|
| Package | `@anthropic-ai/sdk` 1.4.0, pinned exactly | Raw `fetch`, with no dependency |
| API version | `2026-10-21`, which every 1.x release sends | An override back to `2023-06-01` |
| Structured output | `messages.create` with `output_config.format` set to our committed JSON Schema | `zodOutputFormat`, `jsonSchemaOutputFormat`, `messages.parse` |
| SDK retries | `maxRetries: 0`; the adapter's own loop implements IMPL §3.6 | The SDK's default of 2 retries |
| Transport | Non-streaming, each body read whole by our `fetch` wrapper | `messages.stream().finalMessage()` |
| HTTP agent | `undici` 8.12.3, pinned exactly, with header and body timeouts equal to the send's timeout | Node's built-in `fetch`, which stops waiting at 300 seconds |
| Refusal fallbacks | Off | `fallbacks: "default"` |

### Package: `@anthropic-ai/sdk` 1.4.0

**Decision.** Version 1.4.0, pinned exactly with no `^` or `~`. It is added to `package.json` in the adapter step, not by this record.

**Alternative.** Calling the HTTP API with `fetch`, which adds no dependency.

**Why.** The SDK gives typed requests and responses, typed errors for each status code, and a `fetch` option that lets tests capture what is sent. The version is 1.4.0, published on 2 November 2026, because it is the newest that passes the 7-day `minimumReleaseAge` of ADR 0002. 1.5.0, 1.6.0 and 1.7.0 are too new today. A later version needs the usual deliberate update: the pin, the lockfile and a line in "Changes" below.

**What it brings.** Three runtime dependencies: `standardwebhooks`, `json-schema-to-ts` and `@opentelemetry/api`. Zod is an optional peer (`^3.25.0 || ^4.0.0`), and we already pin Zod 4.

**What to check at install.** The SDK documents Node 20 or later and TypeScript 5.0 or later. We run Node 24, and TypeScript 7 with `skipLibCheck` off (ADR 0002), so the SDK's own type declarations are compiled under our strict flags. The adapter step must show that they pass. If they don't, stop and raise it here instead of turning the check off.

### API version: `2026-10-21`

**Decision.** Use the version the 1.x SDK sends, with no override.

**Why.** It is the current version, and the first SDK major to use it is 1.0.0. It removes `temperature`, `top_p` and `top_k`: a request that sends any of them gets a 400, even at the default value. So IMPL §3.7 no longer asks for a low temperature. Each model call records `apiVersion` (IMPL §4.6), because the version changes what the API accepts.

### Structured output: our schema, unchanged

**Decision.** The adapter calls `messages.create` with `output_config: { format: { type: "json_schema", schema } }`, where `schema` is the content of `src/schemas/json/<call>.json`. It never uses the SDK's schema helpers.

**Why.** The documentation says raw schemas are sent without transformation. The helpers do transform them: `messages.parse` and `zodOutputFormat` remove unsupported constraints, move them into field descriptions, add `additionalProperties: false` and filter string formats, and `jsonSchemaOutputFormat` does the same unless told `{ transform: false }`. Any of those would make the schema sent differ from the one `schemaHash` covers. Our generator (`src/schemas/api-schema.ts`) already does this work in a form we control and hash.

**How this is checked.** A contract test builds the client with an injected `fetch`, captures the request and asserts that `output_config.format.schema` equals the committed file, and that the body's bytes equal the retained input (IMPL §4.8). No live model is involved.

### SDK retries: off

**Decision.** The client is built with `maxRetries: 0`. The adapter's own loop applies IMPL §3.6.

**Why.** By default the SDK retries connection errors, timeouts, 408, 409, 429 and 5xx twice, without telling the caller. Those sends would have no `started` revision and no `modelCallId`, so the session would under-record what may have been billed (IMPL §4.6). The documentation doesn't say how the SDK treats `retry-after`, so the adapter reads the header from the error itself.

### Transport: non-streaming, with the exact bytes

**Decision.** Requests are non-streaming. A `fetch` wrapper reads each body whole, as bytes, under the SDK's abort signal, and the adapter parses it itself; `.asResponse()` only waits for the SDK to finish.

**Alternative.** `messages.stream().finalMessage()`, which the SDK recommends for long requests.

**Why.** The retained response has to be the exact response body (IMPL §4.8). A stream has no such body, and `.withResponse()` consumes it. Non-streaming is allowed at our sizes: the SDK's timeout for a non-streaming request is the larger of 10 minutes and `3600 × max_tokens / 128000` seconds, which for the largest reservation of 16,000 tokens is 450 seconds, so the 10-minute floor applies. A limit the developer raises later (IMPL §4.6) can pass it, and the SDK throws when a non-streaming request is expected to take over about 10 minutes, unless `timeout` is set. So the adapter always passes `timeout` itself, using the same formula.

### HTTP agent: `undici` 8.12.3, timeouts matching the send

**Decision.** By default the adapter sends through undici's own `fetch`, with one `Agent` per send whose `headersTimeout` and `bodyTimeout` are that send's timeout (the formula above). Version 8.12.3, pinned exactly, published on 19 October 2026: the newest that passes the 7-day rule. 8.12.4 and 7.30.2 were too new on 10 November. It has no dependencies of its own, needs Node 22.19 or later, and is MIT licensed.

**Alternative.** Node's built-in `fetch`, with no dependency, and accept a 5-minute limit.

**Why.** Node's built-in `fetch` is undici too, with a header timeout and a body timeout of 300 seconds each, whatever `timeout` the SDK is given. A non-streaming call answers with its headers only when the response is ready, so a call that thinks and writes for longer than 5 minutes would fail as a timeout, and a raised output limit (IMPL §4.6), whose timeout can be 30 minutes, would be cut short at 5. The SDK's timer stays the one limit that applies. Node's bundled undici (7.29.1 in Node 24.21) can't be given an `Agent` from another undici version, so the adapter uses the package's `fetch` and `Agent` together.

**How this is checked.** `client.timeouts.test.ts` gives the `Agent` an in-memory fake server, so no port is opened, and answers on fake time:

- headers after 301 seconds arrive, and so do headers after 1,000 seconds with a 64,000-token limit; without the matching timeouts, both of these tests fail;
- a control shows undici's defaults failing at 301 seconds;
- at the send's deadline the SDK's abort closes the socket, before undici's own timer could; without the signal, that test fails;
- the request on the wire carries our headers, with the key once and nothing from `ANTHROPIC_CUSTOM_HEADERS`.

Fake time stays on for that whole file, because undici keeps one shared timer for every connection.

### Refusal fallbacks: off

**Decision.** The server-side `fallbacks` parameter is not sent.

**Alternative.** `fallbacks: "default"`, which reruns a declined request on another model inside the same call.

**Why.** The first slice uses one model for all calls (IMPL §3.7), and a call's records are tied to the model that produced them. A refusal instead follows IMPL §3.6.

## Not decided here

- **Which model and effort are best.** IMPL §3.7 sets the defaults, `claude-opus-5-5` at `medium` effort. Effort is provisional and calibrated in M6 (IMPL §3.9).
- **Other platforms.** Bedrock, Vertex and Foundry need their own packages and aren't in the first slice.

## Sources

Checked on 9 November 2026:

1. npm registry metadata for `@anthropic-ai/sdk`: versions, publication times, dependencies and peer ranges
2. [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
3. [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript): requirements, retries, timeouts, long requests and raw responses
4. [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
5. [Migrating to API version 2026-10-21](https://platform.claude.com/docs/en/api/migration-2026-10-21)
6. [SDK changelog](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md), entries 1.0.0 to 1.7.0

## Changes

- **9 November 2026:** first version, accepted.
- **9 November 2026:** the adapter sets `timeout` itself, because the output limit can now be raised during a session.
- **10 November 2026:** installed in the adapter step. The SDK's type declarations pass under TypeScript 7 with `skipLibCheck` off. Version 1.4.0 sends the API key as an `Authorization: Bearer` header.
- **10 November 2026:** the SDK reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG` and `ANTHROPIC_CUSTOM_HEADERS` from the environment, the last even when a key is given, and custom headers could change `anthropic-version` or add a beta. The adapter passes the key, a null token and the base URL, turns logging off, and wraps `fetch` so that only the SDK's plain headers, `anthropic-version: 2026-10-21` and the key are sent. The wrapper also reads each body, an HTTP error's included, under the SDK's abort signal: the SDK's timer stops when headers arrive, so without it a stalled body would never time out, and an error's body is retained like any response (IMPL §4.8).
- **10 November 2026:** correction to the entry on the environment above. The headers the adapter supplies are fixed values, not copies of the SDK's: `accept`, `content-type`, `anthropic-version: 2026-10-21`, the key and `x-stainless-timeout`, because the SDK merges `ANTHROPIC_CUSTOM_HEADERS` over its own. The HTTP client adds its own headers on the wire, such as `user-agent` and `accept-encoding`, which carry nothing of ours.
- **10 November 2026:** `undici` 8.12.3 added as the HTTP agent, with header and body timeouts equal to the send's timeout, because Node's built-in `fetch` stops waiting for headers after 300 seconds and would cut a raised output limit short at 5 minutes. Installed outside the sandbox with the developer's approval; the tests run inside it.
