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

Setup: Node from `.node-version` (for example `nvm install 24.21.0`), and pnpm through Corepack, which reads the pinned version from `package.json`. Use `corepack pnpm …`, or run `corepack enable pnpm` once and then plain `pnpm`. Don't use an older global pnpm (ADR 0002).

- `corepack pnpm install --frozen-lockfile`: install exactly what the lockfile says
- `corepack pnpm typecheck`: `tsc --noEmit` over sources and tests
- `corepack pnpm lint`: Biome lint and format check, no writes
- `corepack pnpm format`: apply Biome fixes and formatting
- `corepack pnpm test`: the full Vitest suite
- `corepack pnpm test:related <file>`: only the tests affected by a file
- `corepack pnpm build`: compile `src/` to `dist/`
- `corepack pnpm check`: typecheck, lint, test and build. CI also repeats the tests under another time zone and locale, and runs the `--version` smoke test
- `node dist/cli/main.js --version`: the built CLI, after a build

Hooks in `.claude/settings.json` typecheck and run the related tests after each edit to a `.ts` file in `src/`, `test/` or `schemas/` (the full suite after edits to `tsconfig*.json`, `vitest.config.ts` or `package.json`), and typecheck and run the full suite when Claude stops. They find the pinned Node if it is active or installed by nvm, fnm or mise.

## Working style

- `docs/MILESTONES.md` has the build order and the current step. Read it at the start of a task, and tick a step in the same commit that completes it.
- One spec subsection per change. Start from its verification list and write the tests first.
- Unit and contract tests never call a live model. Live runs are manual, against development repositories only.
- Before finishing a change, have the `spec-reviewer` agent review the diff.
- Commit messages cite the spec section, for example `context: tier 5 test reserve (IMPL §1.5)`.

## Commits

- One short, plain sentence per commit message. No body unless something truly needs explaining.
- The developer is the only author. Never add `Co-Authored-By` or any other attribution line.
- Keep commits small and focused: one logical change each. Split unrelated changes into separate commits.

## Explaining the work

- After finishing a milestone or an important task, explain the implementation in simple language: what was built, how the pieces fit together, and why it was done that way.
- The goal is that the developer understands everything in the codebase. Prefer plain words and short examples over jargon.
