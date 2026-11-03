# Milestones

**AI Environment Architect · First slice**  
**Last updated:** 2 November 2026

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
| M0 | Scaffold and development repositories | No | Done |
| M1 | Snapshot and destination parsing | No | Done |
| M2 | Context selection and "What we read" | No | Done |
| M3 | Validation core | No (recorded responses) | Done |
| M4 | Sessions and persistence | No | Done |
| M5 | Recommendations, assembly, review and apply | No (recorded responses) | In progress |
| M6 | Claude adapter and model calls | Yes | Not started |
| M7 | Interactive CLI | Yes | Not started |
| M8 | Export and first-slice release | Yes | Not started |

---

## M0 · Scaffold and development repositories

**Goal:** a working toolchain, and real repositories to develop against that are not evaluation materials.

- [x] Decide the toolchain and record it as [ADR 0002](decisions/0002-toolchain.md): Node version, package manager, test runner, linter and formatter, Zod version, module format.
- [x] Create the layout in [`CLAUDE.md`](../CLAUDE.md#layout) with an empty passing test.
- [x] Add CI that runs typecheck, lint and tests on every push.
- [x] Fill in the Commands section of `CLAUDE.md`.
- [x] Add the hooks described in [`.claude/README.md`](../.claude/README.md#hooks).
- [x] Choose two or three development repositories, none of them Citizenship Workspace:
  - one small and well documented;
  - one with mixed conventions and little documentation;
  - one with an existing `CLAUDE.md`.
  Record them, with pinned commits, in `docs/DEVELOPMENT_REPOSITORIES.md`.
- [x] Set up local evaluation isolation if the evaluation materials are on this machine ([`.claude/README.md`](../.claude/README.md#evaluation-isolation-on-your-machine)).

**Done when:** CI passes on a clean clone, the hooks fire on an edit, and the development repositories are recorded.

## M1 · Snapshot and destination parsing

**Goal:** a reproducible record of what is in a repository, and a lossless, addressable parse of its `CLAUDE.md`.

- [x] Synthetic fixture repositories in `test/fixtures/repos/`: empty, no `CLAUDE.md`, empty `CLAUDE.md`, nested packages, secret-named files, large and binary files, unusual Markdown.
- [x] File listing, exclusions, hashing, statuses and stability check. `/implement-spec DM 6.1`, with the candidate rules in `IMPL 1.4`.
- [x] Guidance Block parsing with lossless round trip and fallback. `/implement-spec DM 7`
- [x] Git metadata: commit and dirty flag, as supporting data only.

**Done when:** parsing is byte-for-byte lossless on every fixture, the absent and empty destinations are distinguished, and snapshots are identical under different filesystem enumeration orders.

## M2 · Context selection and "What we read"

**Goal:** the deterministic context the model will see, and a first command that shows it on a real repository.

- [x] Excerpting, outlines and item rendering. `/implement-spec IMPL 1.6`
- [x] Tiers, including the test reserve. `/implement-spec IMPL 1.5`
- [x] Secret scan, with a fixture per rule. `/implement-spec IMPL 1.7`
- [x] The selection pipeline, the directory tree (IMPL §1.6, tier 4), `contextHash` and the input manifest. `/implement-spec IMPL 1.3`, then `IMPL 1.13`
- [x] A minimal command that prints the "What we read" summary (IMPL §2.4) for a repository and sends nothing.
- [x] Run it on each development repository, and record proposed changes to the default caps (IMPL §1.16).

**Done when:** the IMPL §1.15 items that don't need a model pass, and `contextHash` is identical across runs on each development repository.

The token check (IMPL §1.10) waits for M6, because it needs the provider's token count.

## M3 · Validation core

**Goal:** everything that decides whether model output is accepted, built and tested before any model is called.

- [x] Aliases and the validation pipeline with events. `/implement-spec IMPL 3.5`, and IMPL §3.2.1
- [x] Zod schemas for all five calls, with JSON Schema generation (IMPL §3.3, §3.7).
- [x] Citations, provenance and the `CIT-R01` correction. `/implement-spec IMPL 3.2.2`
- [x] Support checks. `/implement-spec IMPL 3.2.3`
- [x] Evidence basis and known facts from manifests. `/implement-spec IMPL 3.2.4`, then `IMPL 3.2.5`
- [x] Coverage-aware gap and absence checks. `/implement-spec IMPL 1.11`
- [x] Item validation for `analyse`, `analyse_expansion` and `generate_questions`, including question ranking and the corrected-citation rate (IMPL §3.3.2–§3.3.4, §3.2.2).
- [x] Adversarial fixtures for every rule of the first three calls (`analyse`, `analyse_expansion`, `generate_questions`), from the `fixture-adversary` agent.

**Done when:** every rule of the first three calls has a rejecting fixture and an accepted near miss, and the property tests in IMPL §3.8 pass.

## M4 · Sessions and persistence

**Goal:** sessions that survive interruption and can be trusted when reloaded.

- [x] **Write IMPL §4, persistence and export,** from DM §14–§15 and the Evaluation Requirements. Review it before coding.
- [x] Record types, IDs and lineage: the session file, the ID prefixes of every record type, the records of IMPL §4.4–§4.5 with their revisions and references, items that failed validation, and the conflict and finding records of the `analyse_expansion` outcomes, with `absence_check` evidence (IMPL §4.3–§4.5; DM §5, §6, §8). `/implement-spec IMPL 4.4`. The other record types get their fields with their own steps: model calls and effort (IMPL §4.6), purges (§4.8), and recommendations, selections, artifacts, reviews and apply (M5).
- [x] Load checks and schema versions, with no migrations before v0.1.0. `/implement-spec IMPL 4.9`. The checks cover the record types the file schema accepts; each later step extends them for its own types.
- [x] Atomic storage and the lock: the storage directory and its refusal inside the target repository, content-addressed files, whole-file atomic writes, the lock and stale locks, and the data-notice state (IMPL §4.2, §4.7). `/implement-spec IMPL 4.7`
- [x] Derived current state: current records, corrected findings, the active snapshot, stage, status and outcome, and completeness. `/implement-spec IMPL 4.4.2`. The derivations over M5's records move to the M5 steps that add them: held-back entries and the no-change reason, selections, the active artifact revision and the usable approval.
- [x] Model-call and effort records with interruption: the `started` and ended revisions, retries as separate calls, the budget with unknown costs, and effort as a lower bound. `/implement-spec IMPL 4.6`. Extend load check 4 to model-call references (`producedBy`, `revisedBy`, `modelCallId`, `retryOf`) and the alias tables (IMPL §4.9).
- [x] Retained inputs and responses, and `purge-inputs` in core and the storage adapter; the command itself comes with the CLI in M7. `/implement-spec IMPL 4.8`. Extend load check 7 to `retainedInputRef` and `retainedResponseRef`, unless purged (IMPL §4.9).

The export (IMPL §4.10) is specified here and built in M8.

**Done when:** a session can be interrupted after any step and reloaded unchanged, a corrupted, older-format or newer-format session is rejected clearly, and a second process cannot open a locked session.

## M5 · Recommendations, assembly, review and apply

**Goal:** the whole write path, driven by recorded recommendations instead of a model.

- [x] Reference detector, with an adversarial fixture and an accepted near miss for each token class and the path normalisation. `/implement-spec IMPL 3.4`. It matches paths through `normalisePath` (`src/core/paths.ts`), the one path normalisation of IMPL §1.11.
- [x] Deterministic assembly as a pure function over the parsed destination and accepted revisions: positions and anchors, section removal, additions anchored to removed content (including inside a section removed together with them), runs of removed blocks, separators copied from the anchor's next block, line-ending conversion, the reparse check, the failed-round-trip prefix check, conflicts between revisions that can't be combined, and attribution. Assembly fixtures in `test/fixtures/destinations/` (IMPL §3.8, "Selection and assembly"). `/implement-spec DM 9.3`
- [ ] `recommend` item validation, with the valid and invalidated recommendation revisions, `held_back` and `no_change_reason` records, the `failed_item` collections `heldBack` and `noChangeReason`, and the current held-back entries and no-change reason (IMPL §4.4.2). Adversarial fixtures for every `REC`, `REF` and `HELD` rule and `DUP-004`, from the `fixture-adversary` agent. `/implement-spec IMPL 3.3.5`. Needs the two steps above: `REC-003` assembles each recommendation alone.
- [ ] Selections and mutual exclusion, section removal included, with the current selections and selections, accepted or rejected, that count only while their revision is current (IMPL §4.4.2). `/implement-spec DM 9.1` for mutual exclusion, then `DM 9.2`
- [ ] Artifact revisions, reviews and the usable approval, with the active artifact revision (IMPL §4.4.2). Extend the load checks (IMPL §4.9) to recommendation, selection, artifact and review references, target blocks (check 4) and artifact content (check 7), test the branches of checks 3–5 these records make reachable, and check the recommendation revision field list (IMPL §4.4.1). `/implement-spec DM 9.4`, then `DM 10`
- [ ] Tiered freshness. `/implement-spec DM 11.1`
- [ ] Apply and recovery, with the apply-attempt field list (IMPL §4.4.1), apply-attempt references (load check 4) and the apply-approval load check (check 8). `/implement-spec DM 11.2`
- [ ] Change propagation and `regenerate_recommendations` validation: the affected set, `target_changed` invalidation and derived target resolution, the trigger for an empty affected set, and the `actions` failed items. Adversarial fixtures for every `REGEN` rule and regeneration's `DUP-004`. `/implement-spec IMPL 3.3.6`, with DM §12.
- [ ] Closing audit, with no `/implement-spec` argument: every `REC`, `REF`, `HELD` and `REGEN` rule and `DUP-004` has a rejecting fixture and an accepted near miss, and the IMPL §3.8 selection and assembly cases and the M5 items of IMPL §4.11 pass.

**Done when:** DM §17 passes for assembly, approval, freshness, apply, recovery and no-change, using recorded responses only.

## M6 · Claude adapter and model calls

**Goal:** real model calls, under the controls built in M2–M5.

- [ ] Claude API adapter: structured outputs, usage, cost basis, requested and returned model. The adapter sends the generated JSON Schema (IMPL §3.7) unchanged as `output_config.format`, never through the SDK's schema helpers.
- [ ] Token check and reduction order. `/implement-spec IMPL 1.10`
- [ ] Retry and failure policy. `/implement-spec IMPL 3.6`
- [ ] Prompts, version 1, for all five calls (IMPL §3.7). The published package includes `prompts/`, and the CLI loads prompts relative to its install location, not the working directory. The `recommend` prompt tells the model to put every command and path in inline code: a plain-text command runs to the end of its clause, so `REF-003` accepts its arguments only from code (IMPL §3.3.5).
- [ ] Expansion protocol. `/implement-spec IMPL 1.8`
- [ ] Generation budget enforcement.
- [ ] Manual live runs on each development repository. Record acceptance, correction and rejection rates by rule, and revise prompts with new versions.
- [ ] Calibrate everything marked provisional in IMPL §3.9 against real responses from the development repositories.

**Done when:** a full session runs end to end on each development repository through the core API, and the live runs' rejection rates are recorded.

Live runs use the development repositories only.

## M7 · Interactive CLI

**Goal:** the experience in IMPL §2, on top of the working core.

- [ ] Commands, start checks and the first-run data notice (IMPL §2.2–§2.3).
- [ ] Inspect, findings and clarify screens (IMPL §2.4–§2.6), including "seen in N cited files" for each finding (IMPL §3.2.3).
- [ ] Recommendation, final review and apply screens (IMPL §2.7–§2.10).
- [ ] An explicit "regenerate recommendations" action on the recommendations screen, which runs `regenerate_recommendations` on demand (IMPL §3.3.6). Specify it in IMPL §2.7 first.
- [ ] Resume, errors and effort measurement (IMPL §2.11–§2.13).
- [ ] Opening a session under the lock: the storage directory resolved once at start and refused inside the repository before anything is read (IMPL §4.2); `init` and `resume` take the lock, release it on exit, `SIGINT` and `SIGTERM` with `releaseOnExit`, and change records only through `HeldSession` (IMPL §4.7); a load failure is shown with its check and record, and an older or newer format with its message (IMPL §2.12, §4.9).
- [ ] `resume` runs recovery after the load checks, in order: apply recovery (DM §11.2, from M5), then `recoverInterruptedWork` for interrupted calls, effort intervals and the `interrupted` state (IMPL §4.6, §4.9).
- [ ] Interruption only by the lock holder: `status` and `sessions` take no lock and write nothing, and show a `started` call or an `open` interval as in progress while a live process holds the session, and as interrupted otherwise (`unfinishedWork`, IMPL §4.6); `sessions` lists a session that fails the load checks as unreadable, with the check (IMPL §4.2).
- [ ] The stale-lock prompt: a held lock names its process ID and host; a stale one on this host is offered for removal, defaulting to no, and removed only through `removeStaleLock`; an unreadable lock names its path for removal by hand (IMPL §4.7, §2.12).
- [ ] `purge-inputs <session-id>`: takes the lock and calls `purgeInputs` (IMPL §4.8); the retention policy is shown at first run and in `status` (IMPL §1.12).
- [ ] `delete <session-id>`: after a confirmation that defaults to no, takes the lock and removes the whole session directory, retained exchanges included, even for a session that fails the load checks; the exit handler then finds no lock to remove. The storage adapter has no session removal yet; add it here (IMPL §2.2, §4.8).
- [ ] Finding the session: `resume` without an ID picks the most recent session whose root matches, loading each with the load checks and skipping unreadable ones (IMPL §4.2, §4.3); a session ID with no directory is reported and nothing is created, since only `init` creates one (IMPL §4.7).
- [ ] Storage and lock refusals: a relative `$AI_ENVIRONMENT_ARCHITECT_HOME` is refused with a message (IMPL §4.2); a file system without hard links stops with `LockUnsupportedError`'s message naming the storage directory (IMPL §4.7).
- [ ] A change that can't be saved: the message of IMPL §2.12, and the step can be repeated (IMPL §4.7).
- [ ] Settle the `cancelled` outcome with the commands, probably a `cancel` command (IMPL §4.12).
- [ ] Decide the command name and replace `<cli>` in the spec.

**Done when:** IMPL §2.14 passes, and a full session on each development repository is completed through the CLI alone.

## M8 · Export and first-slice release

**Goal:** a complete, honest first slice that the evaluation pilot can use.

- [ ] Session export, mapped to the Evaluation Requirements (DM §14, IMPL §4), with retained exchanges only under `--include-inputs`, and saying when they were purged (IMPL §4.8).
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
- **11 October 2026:** M2 reordered: excerpting first, then tiers, the secret scan, and the pipeline with the tree and manifest. Selection needs the excerpt function, and the tree is rendered after selection.
- **14 October 2026:** M2 calibration ran before the "What we read" command existed, through a scratch script that calls the same capture and selection pipeline and sends nothing. It led to the selection changes in IMPL v0.12 and v0.13 and the new default caps. The command step stays open.
- **20 October 2026:** the command is `<cli> inspect [path]` (IMPL §2.2), a preview of the screen `init` will show.
- **21 October 2026:** M3 reordered: the pipeline and schemas come first, so each rule is built on parsed output, and evidence basis and known facts are one step. Before it started, IMPL §3 and §1.11 were reconciled with M1 and M2 (IMPL v0.14, DM v0.9).
- **24 October 2026:** schemas moved to `src/schemas/` (IMPL v0.16). M6 notes that the adapter sends the generated schema unchanged, and that the package ships `prompts/` and loads it relative to its install location.
- **1 November 2026:** M3's fixture step covers the rules of the first three calls only. Fixtures for the `recommend` and regeneration rules and the reference detector move to M5, where those rules are built. M3 is done: every rule of the first three calls has a rejecting fixture and an accepted near miss, and the IMPL §3.8 property tests pass, with a whole-call determinism property added.
- **1 November 2026:** M4 started. IMPL §4 is written (IMPL v0.31, DM v0.20), and the M4 steps now follow its subsections in dependency order, each naming its `/implement-spec` argument. The export stays specified only and is built in M8.
- **1 November 2026:** the first M4 step covers the records of IMPL §4.4–§4.5 only; the other record types get their fields with their own steps. Building it settled `revisedBy`, single-rule `rejectedBy`, opaque ID suffixes, alias targets as record IDs and the content-notice fields (IMPL v0.32, DM v0.21).
- **1 November 2026:** the load-check step covers the record types the file schema accepts so far. The steps that add model calls, retained exchanges and the M5 records each extend the load checks for their types (IMPL v0.35).
- **2 November 2026:** M4 is done. The core and the storage adapter are built and tested; everything that needs a command moves to explicit M7 steps: opening a session under the lock, recovery on `resume`, interruption shown read-only, the stale-lock prompt, `purge-inputs` and `delete`. Records are appended and saved only through `HeldSession`, and load check 4 puts the first `generation_config` before every model call (IMPL v0.39–v0.40).
- **2 November 2026:** M5 started. IMPL §2.7, §2.11, §3.3.5, §3.3.6, §3.4, §3.5, §3.8, §3.9, §4.4, §4.9, §4.11 and §4.12 and DM §7, §9–§12 and §17–§18 were reconciled with M1–M4 (IMPL v0.41, DM v0.25). The M5 steps are reordered by dependency: assembly comes before `recommend` validation, which assembles each recommendation alone, and each rule's fixtures are written in the step that builds it, with a closing audit. M7 gains an explicit "regenerate recommendations" action.
- **3 November 2026:** M6's prompts step notes that the `recommend` prompt asks for commands and paths in inline code, because `REF-003` fails closed for plain-text commands (IMPL v0.46).
