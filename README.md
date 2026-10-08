# AI Environment Architect

Inspect your repository and create evidence-backed AI coding guidance, with developer review before changes are applied.

> **Status: design stage.** The domain model and most of the implementation specification are written. There is no working code yet. No improvement in coding-agent performance is claimed until the evaluation is complete.

## What it does

Coding agents work better when they know how a project actually works: which commands to run, where things belong, and which conventions the team really follows. That knowledge is spread across code, documentation, existing agent instructions and developers' heads.

AI Environment Architect reads a repository, shows what it found and where it found it, asks about the things code can't tell it, and proposes changes to the project's `CLAUDE.md`. Nothing is written until you have reviewed and approved the exact result.

A session can end with no changes. If the existing guidance is accurate, saying so is a good outcome.

## Workflow

| Stage | What happens |
|---|---|
| **Inspect** | Selects a bounded, reproducible set of files and shows you exactly what will be sent before anything leaves your machine. Produces findings, each tied to the lines it came from. |
| **Clarify** | Asks a small number of questions where the evidence is mixed or missing. Skipped questions stay unresolved; the tool never picks an answer for you. |
| **Recommend** | Proposes individual additions, revisions and removals, each with its rationale and support. |
| **Review** | You accept or reject each recommendation, then approve the exact assembled file and its diff. |
| **Apply** | Checks that nothing relevant changed since inspection, then writes the approved bytes. It never commits. |

## Principles

- **Evidence before recommendations.** Every finding cites specific lines. Code, not the model, checks that the cited text exists in what was actually read.
- **The model proposes; the developer decides.** An observed pattern never becomes project policy on its own. Policy comes from documentation or from your explicit decision.
- **Unknowns stay visible.** Gaps and unanswered questions are recorded, not filled in by assumption.
- **Nothing is written without exact approval.** Accepting recommendations doesn't write anything. Approval applies to one specific file content and expires if anything it depends on changes.
- **Every change is attributable.** The final file is assembled by code from accepted recommendations, so each changed line traces to one recommendation and its evidence.
- **Honest about limits.** Commands are reported as found, not run. Secret scanning blocks known patterns and can't catch everything. Selected content is sent to the model provider, so this is not fully local processing.

## First version scope

- One local repository at a time.
- One output: the repository's root `CLAUDE.md`, for Claude Code.
- A standalone TypeScript CLI using the Claude API.
- Read-only inspection: no repository scripts are executed.
- A structured session export for review and evaluation.

Not yet: multiple repositories, scoped rule files, skills, commands, other coding agents, maintenance checks for stale guidance, and a local review UI.

## Evaluation

The product's central claim, that this setup reduces the corrections developers make to coding agents, is tested by a separate, pre-registered evaluation. Its materials were frozen before product development began and are kept outside this repository. The product-facing requirements are in [Evaluation Requirements](docs/product/EVALUATION_REQUIREMENTS.md).

## Documentation

| Document | What it covers |
|---|---|
| [Product Thesis](docs/product/PRODUCT_THESIS.md) | The problem, the first user, product principles and assumptions to validate |
| [Evaluation Requirements](docs/product/EVALUATION_REQUIREMENTS.md) | What the product must record and support for evaluation, and the isolation rules |
| [ADR 0001: Standalone TypeScript CLI](docs/decisions/0001-standalone-typescript-cli.md) | Why a CLI with a reusable core rather than a Claude Code plugin |
| [Domain Model](docs/architecture/DOMAIN_MODEL.md) | Records, evidence rules, review and approval, application and recovery, export |
| [Implementation Specification](docs/architecture/IMPLEMENTATION_SPEC.md) | Context selection, CLI interaction, model calls and validation. Persistence and export are still to be written. |
| [Milestones](docs/MILESTONES.md) | Build order for the first slice, and current progress |

## Part of Thanos Product Lab

This is the second project in [Thanos Product Lab](https://github.com/thanos-product-lab), after [Citizenship Workspace](https://github.com/thanos-product-lab/citizenship-workspace). Both explore the same question: how to use AI in software where being wrong matters, without letting its output quietly become the truth.
