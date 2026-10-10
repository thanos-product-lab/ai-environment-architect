# ADR 0002: Toolchain

**AI Environment Architect · AI Product Studio**

**Date:** 8 October 2026  
**Status:** Accepted (10 October 2026)  
**Context:** M0 needs a toolchain before any code is written. [ADR 0001](0001-standalone-typescript-cli.md) fixed the language (TypeScript) and the shape (a CLI with a reusable core). This record picks the tools and pins their versions.

## What the choices are judged on

1. **Reproducible installs and deterministic behaviour.** The same commit installs the same versions on every machine and in CI, verified by the integrity hashes in the lockfile. Installed bytes are not identical everywhere: some packages (TypeScript 7, Biome) ship a separate native binary for each operating system, and pnpm installs only the one for the current platform. Behaviour is therefore tested on each supported platform rather than assumed. The product promises identical context for the same snapshot, and the toolchain must not undermine that.
2. **Fast tests that suit fixtures and property tests.** Most tests will run small synthetic repositories and recorded model responses. The edit hook runs only the affected tests, so those runs must be quick.
3. **Strict typing.** The records and validators are the core of the product, and the compiler should catch as much as it can.
4. **Few dependencies.** Each package is something to audit and keep up to date.

Versions were checked on 8 October 2026 against the npm registry and the Node.js release index. Every version is pinned exactly, with no `^` or `~`.

## Decisions

| Choice | Recommended | Alternative |
|---|---|---|
| Supported platforms | Linux and macOS; Windows through WSL only | Linux, macOS and native Windows |
| Node | 24.21.0 (LTS) for development; `>=24` at runtime | 26.x, once it becomes LTS |
| Package manager | pnpm 12.8.2 | npm 11 (bundled with Node) |
| TypeScript | 7.0.2 | 6.0.3 |
| TypeScript config | One inline strict `tsconfig.json` | `@tsconfig/strictest` + `@tsconfig/node24` |
| Module format | ESM | CommonJS |
| Test runner | Vitest 5.0.3 | `node:test` |
| Property tests | fast-check 4.10.2 | Hand-written generators |
| Lint and format | Biome 2.5.15 | ESLint 10 + typescript-eslint 8 + Prettier 3 |
| Schemas and JSON Schema | Zod 4.6.5 with `z.toJSONSchema()` | Zod 3 + `zod-to-json-schema` |

### Supported platforms: Linux and macOS

**Recommended.** The first slice supports Linux and macOS. Native Windows is unsupported; Windows users run the CLI under WSL, which is Linux. CI runs the full pipeline on both `ubuntu-latest` and `macos-latest`.

**Alternative.** Also support native Windows from the start.

**Why.** The product hashes file bytes, compares paths bytewise and writes files atomically. Native Windows adds backslash paths, case-insensitive names, CRLF checkouts and different rename semantics, and each of those needs its own design and tests. Two platforms we actually test are worth more than three we claim. Native Windows can be added later with its own ADR and a Windows CI job.

### Node: 24.21.0 for development, `>=24` at runtime

**Recommended.** Two separate settings, for two separate questions:

- **Which Node do we develop and test with?** Exactly 24.21.0, the current release of the 24 LTS line ("Krypton"). It is pinned in `.node-version`, which CI and local version managers (nvm, fnm, mise) read. This keeps everyone on the same Node.
- **Which Node can run the CLI?** `engines.node` in `package.json` is a range, `>=24`. It tells users the minimum, and it doesn't break when 24.22.0 is released.

pnpm always refuses to install this project on a Node outside its own `engines` range, whatever the settings. `engineStrict: true` adds the same check for *dependencies*: pnpm refuses to install a package that declares itself incompatible with the running Node. Neither setting enforces the exact `.node-version` pin; CI does that by installing exactly that version.

**Alternative.** Node 26. It is the Current release today (26.11.1) and becomes LTS on 28 October 2026.

**Why.** Node 24 is a stable LTS line today and is supported until 30 April 2028, which outlasts the first slice. It enters maintenance on 20 October 2026, which means security and critical fixes only. That is acceptable for a CLI. Node 26 would give a longer runway, but it isn't LTS yet, and a pre-LTS major is the wrong base for a determinism-sensitive tool. Move to 26 in a later ADR once it has been LTS for a while.

### Package manager: pnpm 12.8.2

**Recommended.** pnpm 12.8.2, pinned in the `packageManager` field with its integrity hash. Settings go in `pnpm-workspace.yaml`, because pnpm now reads only auth and registry settings from `.npmrc`:

- `minimumReleaseAge: 10080` (7 days, in minutes). pnpm refuses versions published less than 7 days ago, and this is strict because the setting is explicit.
- `allowBuilds` stays empty. Dependency install scripts are blocked unless listed, and `strictDepBuilds` (the default) fails the install if an unreviewed one appears.
- `engineStrict: true`. pnpm refuses dependencies whose own `engines` field excludes the running Node (see the Node section for what this does and doesn't cover).
- CI installs with `pnpm install --frozen-lockfile`.

If the running pnpm differs from the declared version, pnpm's default behaviour (`pmOnFail: download`) is to download and run the declared version. Every machine therefore runs the same pnpm.

**Urgent security fixes.** Sometimes a fix has to be installed before it is 7 days old. To do that:

1. Add the exact version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, for example `- some-package@1.2.4`. Use the exact version, never the bare package name, so the exemption doesn't cover future releases.
2. Install it and commit the lockfile, the exclusion and a line in the "Changes" list below together. The line names the package, the version, the advisory and the date.
3. Once the version is older than 7 days, remove the exclusion in a later commit.

**Alternative.** npm 11, which ships with Node 24. It needs no extra tool, and `npm ci` with a committed `package-lock.json` is reproducible.

**Why.** pnpm's strict `node_modules` means code can only import packages it declares, so a missing dependency fails here rather than for a user. The release-age rule and blocked install scripts protect against a freshly compromised package. npm has neither by default. The version is 12.8.2, not the newest (12.10.1, published 6 October), so that the package manager follows the same 7-day rule as everything it installs. One caveat: pnpm 12.0.0 was released on 26 August 2026, so the major is young. If it causes trouble, fall back to the last 11.x without changing anything else in this record.

### TypeScript: 7.0.2

**Recommended.** TypeScript 7.0.2, the native compiler. It typechecks everything (`tsc --noEmit`) and compiles `src/` to `dist/` for the build (see "How the code runs").

**Alternative.** TypeScript 6.0.3, the last JavaScript-based release.

**Why.** TypeScript 7 is several times faster. That makes it practical to typecheck the whole project in the edit hook after every change, instead of guessing which files are affected. Its cost is ecosystem reach: typescript-eslint 8.71.1 declares `typescript >=4.8.4 <6.1.0`, so it can't be used with TypeScript 7. That cost decides the lint choice below. If a tool we need later requires the TypeScript 6 API, dropping to 6.0.3 is a one-line change.

### TypeScript config: one inline strict file

**Recommended.** One `tsconfig.json` with no `extends`. It sets:

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`;
- `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`;
- `module` and `moduleResolution` set to `nodenext`, and `target` and `lib` set to `es2024`.

**Alternative.** Extend `@tsconfig/strictest` and `@tsconfig/node24`.

A second file, `tsconfig.build.json`, extends it and emits only `src/` to `dist/`.

**Why.** Every flag is visible in one file, and there are no packages to add. `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` matter most for this product: records with optional fields and lookups by ID are everywhere, and these flags make "missing" a type the code must handle instead of a silent `undefined`. `erasableSyntaxOnly` rules out enums and parameter properties. Both generate runtime code from type syntax, so a reader can't tell from a type what code exists. Plain unions of string literals and explicit fields do the same jobs without that.

### Module format: ESM

**Recommended.** ES modules (`"type": "module"`), with `.ts` sources and `.js` import specifiers as `nodenext` requires. No bundler.

**Alternative.** CommonJS.

**Why.** Node 24, Vitest 5 and Zod 4 are all ESM-first, and `nodenext` makes the compiler check import paths the same way Node resolves them. A CLI doesn't need a bundler, and leaving one out removes a tool and a build-only behaviour that tests wouldn't cover.

### How the code runs

- **The CLI runs as compiled JavaScript.** `pnpm build` runs `tsc -p tsconfig.build.json`, which emits `dist/`. The `bin` entry in `package.json` points to `dist/cli/main.js`.
- **Tests run the TypeScript sources.** Vitest compiles them in memory, so no build is needed to test.
- **Scripts run from `dist/` after a build.** Nothing runs `.ts` files directly with Node.

CI checks the build too: it builds `dist/` and runs the built CLI with `--version` as a smoke test. That catches a broken `bin` path, a bad import specifier or a missing file that the tests, which never touch `dist/`, would miss.

### Test runner: Vitest 5.0.3

**Recommended.** Vitest 5.0.3 in a Node environment, without global test functions (tests import `describe`, `it` and `expect` explicitly).

**Alternative.** Node's built-in `node:test`, which needs no dependency.

**Why.** `vitest related <files>` runs only the tests that import the changed files, through the module graph. That gives the edit hook "affected tests only" without writing our own dependency tracking. Vitest also handles TypeScript without configuration and has inline snapshots, which suit fixtures and recorded responses, and it reports clearly. `node:test` is the lighter choice and is worth reconsidering if Vitest's dependency tree becomes a problem, but it has no affected-test mode.

### Property tests: fast-check 4.10.2

**Recommended.** fast-check 4.10.2. CI runs with a fixed seed, and a failure prints its seed and path so it can be replayed exactly. It is added with the first property test (M1 or M3), not in M0.

**Alternative.** Hand-written generators driven by a seeded random function.

**Why.** The specs ask for property tests: identical snapshots under any enumeration order, and validation properties. fast-check shrinks a failure to a small counterexample, which hand-written generators don't do. It has a single dependency.

### Lint and format: Biome 2.5.15

**Recommended.** Biome 2.5.15, one native binary that both lints and formats from one `biome.json`. CI runs `biome ci`, which checks without writing.

**Alternative.** ESLint 10.12.0 with typescript-eslint 8.71.1 and Prettier 3.9.9.

**Why.** Biome is a single package with no dependency tree, it is fast enough to run on every edit, and it doesn't depend on the TypeScript compiler API, so it works with TypeScript 7. The alternative is the more mature type-aware linter, but it would hold us on TypeScript 6.0 and add dozens of packages. What we lose is typescript-eslint's type-aware rules. Biome has its own type inference for some of them, for example `noFloatingPromises`, but that rule is in the nursery group, documented as experimental. Enable it, and treat it as a helpful check, not a guarantee.

### Schemas and JSON Schema: Zod 4.6.5

**Recommended.** Zod 4.6.5 for runtime validation. JSON Schema for the model calls (IMPL §3.7) is generated with Zod's built-in `z.toJSONSchema()`.

**Alternative.** Zod 3 with the separate `zod-to-json-schema` package.

**Why.** One library defines each schema once, and from it we get the TypeScript type, the runtime validator and the JSON Schema sent to the API. Zod 4 generates JSON Schema itself, so there is no second package to keep in step. The generated schemas still have to be checked against the subset of JSON Schema that Claude structured outputs accept. That happens in M6, when the adapter is built.

## Not decided here

- **Terminal prompt library:** M7, with the CLI screens.
- **Claude API SDK:** M6, with the adapter.
- **Coverage tool:** add when a coverage target is set.

## Continuous integration

GitHub Actions runs on every push and pull request, on both `ubuntu-latest` and `macos-latest`, with Node from `.node-version`:

1. `pnpm install --frozen-lockfile`
2. Typecheck, then lint (`biome ci`)
3. The test suite, with the runner's default time zone and locale
4. The test suite again with `TZ=Pacific/Chatham` and `LANG=tr_TR.UTF-8`. Chatham has a UTC+12:45 offset, and Turkish has unusual rules for upper and lower case `i`. Code that leaks the local time zone or locale into output will fail here.
5. `pnpm build`, then the built CLI with `--version`

## Keeping it reproducible

- The lockfile (`pnpm-lock.yaml`) is committed, and CI never resolves versions.
- **Line endings.** `.gitattributes` sets `* text=auto eol=lf`, so sources check out with LF everywhere. It also sets `test/fixtures/** -text`, so Git never converts fixture bytes: a fixture is exactly the bytes committed. M1 needs a `CLAUDE.md` destination fixture with CRLF line endings, and this rule is what keeps it CRLF.
- Versions change only deliberately: update the pin and the lockfile in one commit, and add a line to the "Changes" list below. A new major version of anything in the table needs a new ADR.
- **A determinism guard, noted for later:** `src/core` must not use `Date.now`, `Math.random` or locale comparison directly (see `CLAUDE.md`). A lint rule or a test should enforce this once `src/core` has real code. Biome's restricted-globals rules or a small test that scans the source are both candidates.

## Sources

Checked on 8 October 2026:

1. [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) and [release index](https://nodejs.org/dist/index.json)
2. [pnpm settings](https://pnpm.io/settings): [dependency resolution](https://pnpm.io/settings/dependency-resolution), [build](https://pnpm.io/settings/build), [CLI](https://pnpm.io/settings/cli)
3. [Biome `noFloatingPromises`](https://biomejs.dev/linter/rules/no-floating-promises/)
4. npm registry metadata (`npm view`) for every version, engine range and peer range quoted above

## Changes

- **8 October 2026:** first version.
- **9 October 2026:** before acceptance. The CLI runs from compiled `dist/`, not with type stripping. Reproducibility means the same versions verified by hashes, not the same bytes. Added supported platforms, the CI matrix with a second time zone and locale run, the build smoke test, `.gitattributes`, the separation of the development Node pin from the runtime range, the correct scope of `engineStrict`, and the release-age bypass procedure.
- **10 October 2026:** accepted.
