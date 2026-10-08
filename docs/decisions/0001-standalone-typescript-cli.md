# ADR 0001: Standalone TypeScript CLI

**AI Environment Architect · AI Product Studio**

**Date:** 5 October 2026  
**Status:** Accepted, with the amendments at the end of this record (8 October 2026)  
**Context:** Stage 0 is complete and frozen, as reported by the project owner. This document records a product implementation decision; it does not change the frozen evaluation materials.

The body below is the original delivery interface recommendation. Where it conflicts with the [amendments](#amendments), the amendments apply.

## Recommendation

Build a standalone TypeScript CLI with a reusable core and a Claude API integration. Start with terminal questions and diff review. Add a local web review interface once the complete workflow works reliably.

The first workflow is:

**Inspect → clarify → recommend → review → apply**

The application should own the session state, evidence, developer answers, recommendations, approved changes, and export. This makes the workflow resumable and gives the evaluation a clear record of how each configuration was produced.

## CLI versus Claude Code plugin

| Consideration | Standalone CLI | Claude Code plugin |
|---|---|---|
| First prototype | More implementation work. | Faster access to an existing agent environment. |
| Workflow control | Explicit stages, validation, and persisted state owned by the application. | Requires constraining and integrating with the host agent's behaviour. |
| Evaluation records | Application defines prompts, inputs, model settings, usage records, and exports. | Feasible, but host session and configuration also need to be accounted for. |
| Review experience | Custom questions, diffs, selections, and recovery behaviour. | Fits naturally into Claude Code's interaction model. |
| Adoption | Requires CLI installation and API credentials. | Convenient for developers already using Claude Code. |
| Later local UI | Can call the same core functions directly. | Usually benefits from an underlying library or service. |
| Maintenance | Application owns context selection, retries, orchestration, and state. | Product depends on the host platform and its plugin interfaces. |

Plugins are capable of more than storing prompts: Claude Code plugins can package skills, agents, hooks, and MCP servers. Claude Code also supports programmatic execution and structured output. The recommendation is therefore based on ownership of the product workflow, rather than an assumption that plugins cannot support instrumentation or exports. [1][2]

## Why the CLI fits this product

The developer should be able to stop after answering questions, reopen the session, inspect the same recommendations, and apply selected changes. Explicit application state supports this experience.

The product also needs traceability: a recommendation should identify the evidence or developer decision behind it. A controlled pipeline makes those relationships easier to validate and export.

Separating the core from terminal rendering preserves a route to a polished local review UI. A later plugin could invoke the same core instead of reimplementing the analysis and application logic.

These are design advantages, not measured claims that a CLI produces better agent outcomes. The evaluation will test the resulting setup's usefulness.

## First complete workflow

| Stage | Initial behaviour | Result |
|---|---|---|
| Inspect | Read selected repository files, manifests, documentation, and existing instructions. Collect source references and hashes. | Snapshot, evidence, and findings. |
| Clarify | Propose targeted questions where evidence cannot establish intent. Record answers and unresolved items. | Questions and developer decisions. |
| Recommend | Request structured recommendations grounded in evidence and confirmed decisions. Validate references and required fields. | Proposed instructions with rationale. |
| Review | Display the proposed root CLAUDE.md and its diff. Allow revision, acceptance, or rejection. | An explicitly approved artifact version. |
| Apply | Verify that reviewed inputs and the destination have not changed, then write the approved content. | Applied artifact and an application record. |

Use ordinary application code for reading files, hashing, validating references, computing diffs, and applying changes. Use the model for interpretation, focused questions, and proposed guidance.

Schema-constrained API output can help produce parseable recommendations. It does not establish the truth of architecture claims or the usefulness of an instruction; those require evidence checks and review. [3]

## Initial implementation choices

| Decision | Proposed choice |
|---|---|
| Interface | Terminal CLI. |
| Language | TypeScript. |
| Core design | Modules independent of terminal rendering. |
| Model integration | One Claude API adapter. |
| Repository scope | One existing local repository. |
| First artifact | A new or revised root CLAUDE.md. |
| Inspection | Read-only file analysis; no repository script execution. |
| Session storage | Local JSON records with an explicit schema version. |
| Review | Artifact content, evidence, rationale, and diff. |
| Apply | Deterministic writes of the approved artifact with stale-input detection. |
| Export | Structured session record plus final configuration and content hashes. |
| Later interfaces | Local web review UI and an optional plugin integration. |

Existing instructions must be considered when recommending changes. A successful session can conclude that no change is justified.

The CLI runs locally, but selected repository content sent to the model leaves the machine. Make the analysis scope visible and exclude secrets and irrelevant generated files from model inputs. Do not describe an API-backed workflow as fully local processing.

## Command execution boundary

For the initial version, discover commands from manifests and documentation and label them **found, not run**.

Do not execute install scripts, builds, tests, migrations, or arbitrary repository commands during inspection. Command execution requires its own consent, isolation, environment, and logging design and can be added as a separate capability later.

Artifact application remains an explicit write operation following review. Read-only inspection does not mean the entire workflow is read-only.

## Minimal domain model to define next

| Concept | Purpose |
|---|---|
| Session | Tracks workflow stage, versions, and resumable progress. |
| Snapshot | Identifies the repository inputs used for analysis. |
| Evidence | References source content and its identity. |
| Finding | Describes an observation, inference, or conflict with supporting evidence. |
| Question | Captures an uncertainty requiring developer input. |
| Decision | Records confirmed intent and its origin. |
| Recommendation | Proposes guidance with its rationale and supporting references. |
| Artifact | Contains a proposed output file and its content. |
| Diff | Represents the exact change presented for review. |
| Export | Captures the resulting configuration and its generation record. |

These concepts can begin as small typed records in one codebase. They do not require separate services or a database.

## Relationship to the frozen evaluation

The product's generation interface and the evaluation's coding agent are separate roles:

- The CLI uses the Claude API to produce the candidate setup.
- Claude Code performs the downstream coding tasks under setups A, B, and C.

Record configuration-generation cost separately from downstream coding-run cost. Capture the requested and returned model identifiers where available, prompt and schema versions, input hashes, questions, answers, manual edits, usage, and exported artifact hashes.

Use the existing frozen handoff as the authority for exact export and runner requirements. Its contents have not been inspected for this recommendation, so compatibility must be checked before committing to the export schema.

Develop against permitted pilot materials. Keep reserved tasks, checks, and reference solutions outside the product development and generation context.

## Definition of done for the first slice

1. A developer can inspect one repository and see evidence-backed findings.
2. The session records focused questions and answers without converting unknowns into project policy.
3. The tool can propose one root CLAUDE.md change with traceable rationale.
4. The developer can review and approve the exact proposed content.
5. Applying the change detects intervening changes and preserves unrelated files.
6. The session can resume after interruption.
7. The configuration and generation record can be exported for evaluation.
8. Focused verification covers broken references, malformed model output, stale review state, and rejected or unchanged artifacts.

Skills, scoped rules, several repositories, dynamic task assistance, and the web UI are follow-on capabilities once this workflow is complete.

## Next step

Write a short **Domain Model and MVP Scope** document defining the records above, stage transitions, failure handling, review behaviour, and export contract. Then implement one end-to-end session for one repository and one artifact type.

*Done:* see the [Domain Model](../architecture/DOMAIN_MODEL.md) and the [Implementation Specification](../architecture/IMPLEMENTATION_SPEC.md).

## Amendments

Recorded 8 October 2026, after review.

1. **Development repositories.** The instruction to "develop against permitted pilot materials" is withdrawn. Pilot tasks are evaluation materials. Product development uses independent repositories chosen by the product team; Citizenship Workspace and its pilot and reserved tasks are used only when the evaluation runs ([Evaluation Requirements §6](../product/EVALUATION_REQUIREMENTS.md#6-isolation-when-starting-the-product-repository)).
2. **Export authority.** The evaluation handoff is not part of the frozen materials, and it has now been inspected. It is included in this repository as [Evaluation Requirements](../product/EVALUATION_REQUIREMENTS.md). Its suggested session export is mapped in [Domain Model §14](../architecture/DOMAIN_MODEL.md#14-export).
3. **Review granularity.** Review happens at two levels: developers accept or reject individual recommendations, then approve the exact assembled file. The diff is the result of review, not the unit of review ([Domain Model §3](../architecture/DOMAIN_MODEL.md#3-three-distinct-decisions)).
4. **Context selection and reference checks.** What the model sees is selected deterministically and recorded, and every cited reference is checked by code before it is shown ([Implementation Specification §1, §3](../architecture/IMPLEMENTATION_SPEC.md)).
5. **Scope field.** Recommendations and artifacts carry a scope from the first slice, even though the only output is the root `CLAUDE.md`.

## Sources

Official documentation checked on 5 October 2026:

1. [Claude Code plugins overview](https://code.claude.com/docs/en/plugins)
2. [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
3. [Claude API structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
4. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
