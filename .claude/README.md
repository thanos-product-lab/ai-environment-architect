# Claude Code setup for this repository

This folder configures Claude Code for developing AI Environment Architect. It is hand-written and deliberately small, following the product's own principle of minimal, scoped guidance.

| File | Loaded | Purpose |
|---|---|---|
| `../CLAUDE.md` | Every session | What the project is, where the specs are, evaluation isolation, invariants, layout, working style |
| `rules/core.md` | When working in `src/core/` | Determinism, no I/O, immutable records, validation events |
| `rules/model-contracts.md` | When working on validators, schemas, prompts or recorded responses | Stable rule IDs, versioning, no repair beyond `CIT-R01` |
| `rules/cli.md` | When working in `src/cli/` | Screen conventions and approval safety from IMPL §2 |
| `rules/tests.md` | When working on tests | Synthetic fixtures, no live model, verification items mapped to tests |
| `skills/implement-spec/` | `/implement-spec IMPL 1.6` | Tests-first workflow for one spec section |
| `skills/validation-rule/` | `/validation-rule CIT-004`, or automatically | Procedure for changing validators, schemas and prompts |
| `agents/spec-reviewer.md` | Delegated | Read-only review of a change against the specs |
| `agents/fixture-adversary.md` | Delegated | Adversarial fixtures written from the spec, without reading `src/` |
| `settings.json` | Always | Auto memory off; file reads blocked outside the working directory; `.env` reads denied |
| `hooks/after-edit.sh` | After every Edit or Write | For a `.ts` file in `src/`, `test/` or `schemas/`: typechecks and runs `vitest related` for the file. For `tsconfig*.json`, `vitest.config.ts` or `package.json`: typechecks and runs the full suite. Other files are skipped. A failure is shown to Claude (exit 2) |
| `hooks/on-stop.sh` | When Claude finishes a turn | Typechecks and runs the full test suite. A failure sends Claude back to fix it, once (`stop_hook_active` prevents a loop) |
| `hooks/node-env.sh` | Sourced by both hooks | Uses the Node from `.node-version` (active, or installed by nvm, fnm or mise) even if Claude Code started under another Node |

## Evaluation isolation on your machine

`settings.json` blocks Claude's file tools from reading outside this repository. That doesn't cover every route: a script Claude runs outside the sandbox can still open any file your user account can read. On a machine that also has the evaluation materials:

1. Copy `settings.local.example.json` to `settings.local.json` (git-ignored) and replace the placeholder paths. Read and Edit rules use `//` for absolute paths; sandbox paths use a single `/`.
2. The sandbox in that file also restricts what shell commands can read. It runs on macOS, Linux and WSL2. It may need `sandbox.network.allowedDomains` for the npm registry once dependencies are installed.
3. Check that `~/.claude/CLAUDE.md` and any user-level skills contain nothing about the evaluation.

The strongest boundary is to keep the evaluation materials off the account you develop with.

## Why auto memory is off

Guidance for this repository lives in reviewed, versioned files. That keeps development reproducible, and it gives a clean baseline for dogfooding: once the first slice works, run the tool on this repository and compare its proposal with this hand-written setup.

## Hooks

Both hooks call `node_modules/.bin` directly, not pnpm, so they stay fast: the edit hook takes under a second on the scaffold. They need dependencies installed (`corepack pnpm install --frozen-lockfile`) and say so if they aren't. Fixture files under `test/fixtures/` never trigger the edit hook.
