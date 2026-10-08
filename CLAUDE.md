# AI Environment Architect

A TypeScript CLI that inspects a repository, asks the developer about intent the code can't establish, and proposes evidence-backed changes to its root `CLAUDE.md`. It writes only content the developer has approved exactly. Overview: `README.md`.

## The specs are the source of truth

Read the relevant section before changing behaviour:

- `docs/architecture/DOMAIN_MODEL.md` (DM): records, evidence rules (§6.4), assembly (§9.3), review and apply (§10–§11), export (§14)
- `docs/architecture/IMPLEMENTATION_SPEC.md` (IMPL): context selection (§1), CLI screens (§2), model calls and validation (§3). §4 is not written yet.
- `docs/product/EVALUATION_REQUIREMENTS.md`: what every session must record
- `docs/decisions/`: architecture decision records

If the code needs to differ from the spec, stop and say so. Once the developer agrees, change the spec in the same commit and add a line to its "Changes" list. Code and spec must never drift apart silently.

## Evaluation isolation: hard boundary

This product is evaluated on a separate repository with frozen tasks. Never read, search for or ask for Citizenship Workspace, the evaluation repository, or any reference sheet, task, rubric, check or reference solution. If any of it appears in context, stop and tell the developer. Never tune prompts, rules or defaults against it. Use the synthetic fixtures in `test/fixtures/` and the development repositories the developer names.

## Invariants

- The model never supplies what code can establish: paths, hashes, excerpts, evidence basis, block IDs and hashes, record IDs, absence wording.
- An observed pattern never becomes policy without documentation or a confirmed decision.
- Nothing is written to a target repository except by apply, with an approval of the exact content hash. Never commit, stage or push in a target repository.
- Records are appended, never mutated. An approval never transfers to a new revision.
- The same snapshot and settings produce identical context. In `src/core`, sort paths bytewise, and never use `Date.now`, `Math.random` or locale comparison directly; inject the clock and filesystem.
- Unknown is never zero: missing cost, tokens or effort are recorded as unknown, with a reason.

## Layout

Created by the scaffold commit:

- `src/core/`: domain logic. No terminal I/O, no network.
- `src/adapters/claude/`: the only code that calls the Claude API.
- `src/cli/`: rendering and prompts only.
- `schemas/<call>.ts` and `prompts/<call>/<version>.md` (IMPL §3.7).
- `test/fixtures/repos/`: small synthetic repositories. `test/fixtures/responses/<call>/`: recorded model responses.

## Commands

None yet. They are added with the scaffold commit. Don't guess commands.

## Working style

- `docs/MILESTONES.md` has the build order and the current step. Read it at the start of a task, and tick a step in the same commit that completes it.
- One spec subsection per change. Start from its verification list and write the tests first.
- Unit and contract tests never call a live model. Live runs are manual, against development repositories only.
- Before finishing a change, have the `spec-reviewer` agent review the diff.
- Commit messages cite the spec section, for example `context: tier 5 test reserve (IMPL §1.5)`.
