# Milestones

**AI Environment Architect · First slice**  
**Last updated:** 8 October 2026

This is the build order for the first slice: inspect → clarify → recommend → review → apply, for one repository and its root `CLAUDE.md`. It says *what to build when*. *How it behaves* is in the specs. Each step points to a spec section rather than repeating it.

The order is set by dependencies. Deterministic parts come first and are tested without a model; the Claude API arrives once there is a validated core to protect. There are no dates; add targets once M0 shows the pace.

## How to use this file

- **One milestone in progress at a time.** Its status is the single place to look for "what's next".
- **Tick a step in the same commit that completes it.** A step is complete when its "done when" condition holds, not when the code is written.
- **Steps that implement a spec section** name the argument for `/implement-spec`, for example `DM 7`.
- **If the plan changes,** edit it and add a line to the change log at the end. Don't leave finished or abandoned steps unticked.
- **Not in this plan:** evaluation tasks and runs. The product only has to produce what [Evaluation Requirements](product/EVALUATION_REQUIREMENTS.md) asks for.

## Overview

| # | Milestone | Model calls? | Status |
|---|---|---|---|
| M0 | Scaffold and development repositories | No | In progress |
| M1 | Snapshot and destination parsing | No | Not started |
| M2 | Context selection and "What we read" | No | Not started |
| M3 | Validation core | No (recorded responses) | Not started |
| M4 | Sessions and persistence | No | Not started |
| M5 | Recommendations, assembly, review and apply | No (recorded responses) | Not started |
| M6 | Claude adapter and model calls | Yes | Not started |
| M7 | Interactive CLI | Yes | Not started |
| M8 | Export and first-slice release | Yes | Not started |

---

## M0 · Scaffold and development repositories

**Goal:** a working toolchain, and real repositories to develop against that are not evaluation materials.

- [x] Decide the toolchain and record it as [ADR 0002](decisions/0002-toolchain.md): Node version, package manager, test runner, linter and formatter, Zod version, module format.
- [x] Create the layout in [`CLAUDE.md`](../CLAUDE.md#layout) with an empty passing test.
- [ ] Add CI that runs typecheck, lint and tests on every push. *(Workflow added; tick after the first green run on both platforms.)*
- [x] Fill in the Commands section of `CLAUDE.md`.
- [x] Add the hooks described in [`.claude/README.md`](../.claude/README.md#hooks).
- [x] Choose two or three development repositories, none of them Citizenship Workspace:
  - one small and well documented;
  - one with mixed conventions and little documentation;
  - one with an existing `CLAUDE.md`.
  Record them, with pinned commits, in `docs/DEVELOPMENT_REPOSITORIES.md`.
- [ ] Set up local evaluation isolation if the evaluation materials are on this machine ([`.claude/README.md`](../.claude/README.md#evaluation-isolation-on-your-machine)).

**Done when:** CI passes on a clean clone, the hooks fire on an edit, and the development repositories are recorded.

## M1 · Snapshot and destination parsing

**Goal:** a reproducible record of what is in a repository, and a lossless, addressable parse of its `CLAUDE.md`.

- [ ] Synthetic fixture repositories in `test/fixtures/repos/`: empty, no `CLAUDE.md`, empty `CLAUDE.md`, nested packages, secret-named files, large and binary files, unusual Markdown.
- [ ] File listing, exclusions, hashing, statuses and stability check. `/implement-spec DM 6.1`, with the candidate rules in `IMPL 1.4`.
- [ ] Guidance Block parsing with lossless round trip and fallback. `/implement-spec DM 7`
- [ ] Git metadata: commit and dirty flag, as supporting data only.

**Done when:** parsing is byte-for-byte lossless on every fixture, the absent and empty destinations are distinguished, and snapshots are identical under different filesystem enumeration orders.

## M2 · Context selection and "What we read"

**Goal:** the deterministic context the model will see, and a first command that shows it on a real repository.

- [ ] Construction order and determinism. `/implement-spec IMPL 1.3`
- [ ] Tiers, including the test reserve. `/implement-spec IMPL 1.5`
- [ ] Excerpting, outlines, rendering and the directory tree. `/implement-spec IMPL 1.6`
- [ ] Secret scan, with a fixture per rule. `/implement-spec IMPL 1.7`
- [ ] Input manifest. `/implement-spec IMPL 1.13`
- [ ] A minimal command that prints the "What we read" summary (IMPL §2.4) for a repository and sends nothing.
- [ ] Run it on each development repository, and record proposed changes to the default caps (IMPL §1.16).

**Done when:** the IMPL §1.15 items that don't need a model pass, and `contextHash` is identical across runs on each development repository.

The token check (IMPL §1.10) waits for M6, because it needs the provider's token count.

## M3 · Validation core

**Goal:** everything that decides whether model output is accepted, built and tested before any model is called.

- [ ] Aliases and the validation pipeline with events. `/implement-spec IMPL 3.5`, and IMPL §3.2.1
- [ ] Citations, provenance and the `CIT-R01` correction. `/implement-spec IMPL 3.2.2`
- [ ] Support checks. `/implement-spec IMPL 3.2.3`
- [ ] Evidence basis. `/implement-spec IMPL 3.2.4`
- [ ] Known facts from manifests. `/implement-spec IMPL 3.2.5`
- [ ] Coverage-aware gap and absence checks. `/implement-spec IMPL 1.11`
- [ ] Zod schemas for all five calls, with JSON Schema generation (IMPL §3.3, §3.7).
- [ ] Item validation for `analyse`, `analyse_expansion` and `generate_questions`, including question ranking (IMPL §3.3.2–§3.3.4).
- [ ] Adversarial fixtures for every rule, from the `fixture-adversary` agent.

**Done when:** every rule has a rejecting fixture and an accepted near miss, and the property tests in IMPL §3.8 pass.

## M4 · Sessions and persistence

**Goal:** sessions that survive interruption and can be trusted when reloaded.

- [ ] **Write IMPL §4, persistence and export,** from DM §14–§15 and the Evaluation Requirements. Review it before coding.
- [ ] Session records, stages, statuses and outcomes (DM §5).
- [ ] Storage, atomic writes, lock file, schema version and reference checks on load. `/implement-spec DM 15`
- [ ] Questions, decisions and supersession (DM §8).
- [ ] Model-call and effort-interval records (DM §13), with unknown never stored as zero.
- [ ] Retained inputs policy. `/implement-spec IMPL 1.12`

**Done when:** a session can be interrupted after any step and reloaded unchanged, a corrupted or newer-version session is rejected clearly, and a second process cannot open a locked session.

## M5 · Recommendations, assembly, review and apply

**Goal:** the whole write path, driven by recorded recommendations instead of a model.

- [ ] Reference detector. `/implement-spec IMPL 3.4`
- [ ] `recommend` item validation: evidence rules, `fact` and `policy`, directive-language guard, references, held back. `/implement-spec IMPL 3.3.5`
- [ ] Selections and mutual exclusion (DM §9.1–§9.2).
- [ ] Deterministic assembly with attribution. `/implement-spec DM 9.3`
- [ ] Artifact revisions and reviews; approval validity (DM §9.4, §10).
- [ ] Tiered freshness. `/implement-spec DM 11.1`
- [ ] Apply and recovery. `/implement-spec DM 11.2`
- [ ] Change propagation and `regenerate_recommendations` validation (DM §12, IMPL §3.3.6).

**Done when:** DM §17 passes for assembly, approval, freshness, apply, recovery and no-change, using recorded responses only.

## M6 · Claude adapter and model calls

**Goal:** real model calls, under the controls built in M2–M5.

- [ ] Claude API adapter: structured outputs, usage, cost basis, requested and returned model.
- [ ] Token check and reduction order. `/implement-spec IMPL 1.10`
- [ ] Retry and failure policy. `/implement-spec IMPL 3.6`
- [ ] Prompts, version 1, for all five calls (IMPL §3.7).
- [ ] Expansion protocol. `/implement-spec IMPL 1.8`
- [ ] Generation budget enforcement.
- [ ] Manual live runs on each development repository. Record acceptance, correction and rejection rates by rule, and revise prompts with new versions.

**Done when:** a full session runs end to end on each development repository through the core API, and the live runs' rejection rates are recorded.

Live runs use the development repositories only.

## M7 · Interactive CLI

**Goal:** the experience in IMPL §2, on top of the working core.

- [ ] Commands, start checks and the first-run data notice (IMPL §2.2–§2.3).
- [ ] Inspect, findings and clarify screens (IMPL §2.4–§2.6).
- [ ] Recommendation, final review and apply screens (IMPL §2.7–§2.10).
- [ ] Resume, errors and effort measurement (IMPL §2.11–§2.13).
- [ ] Decide the command name and replace `<cli>` in the spec.

**Done when:** IMPL §2.14 passes, and a full session on each development repository is completed through the CLI alone.

## M8 · Export and first-slice release

**Goal:** a complete, honest first slice that the evaluation pilot can use.

- [ ] Session export, mapped to the Evaluation Requirements (DM §14, IMPL §4).
- [ ] Check every item of ADR 0001's definition of done.
- [ ] Dogfood: run the tool on this repository and compare its proposal with the hand-written setup. Write up the comparison.
- [ ] Update the README status, and tag `v0.1.0`.
- [ ] Hand the release to the evaluation maintainer for the pilot.

**Done when:** all of the above, with no open serious defects.

---

## Later (not scheduled)

Maintenance checks for stale paths and commands; scoped rule files; a local web review UI; additional coding agents; multiple repositories. Each needs its own spec before it is scheduled.

## Change log

- **8 October 2026:** first version.
