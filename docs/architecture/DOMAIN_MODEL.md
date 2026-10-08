# Domain Model

**AI Environment Architect · AI Product Studio**  
**Date:** 5 October 2026  
**Version:** 0.3 — consolidated specification  
**Status:** Proposed specification for the first implementation slice. Not implemented code.

**Supersedes:** the earlier Data Model and Review Decisions v0.1 and Domain Model v0.2 design drafts, which are not kept in this repository. This is the single authoritative domain model.

**Authorities:** [Product Thesis](../product/PRODUCT_THESIS.md) v0.1, [Product Evaluation Requirements](../product/EVALUATION_REQUIREMENTS.md) (5 October 2026), [ADR 0001: Standalone TypeScript CLI](../decisions/0001-standalone-typescript-cli.md) (5 October 2026). The evaluation requirements are a product-facing document outside the frozen evaluation materials; their export requirements are adopted directly in §14.

**Companion:** [Implementation Specification](IMPLEMENTATION_SPEC.md).

### Changes from v0.2

1. **Deterministic assembly.** The existing `CLAUDE.md` is parsed into addressable guidance blocks. Recommendations target blocks; application code assembles the file. The model never writes the assembled file (§7, §9.3).
2. **`existing_guidance` evidence basis.** Current agent configuration can justify preservation but cannot on its own justify new guidance (§6.4).
3. **Structured references.** Recommendations carry machine-checkable path and command references, with command verification state (§9.1).
4. **Gap findings.** Unknowns are first-class findings rather than silent omissions (§6.3).
5. **Handoff fields.** Product version, adapter, generation budget, active developer effort, record-level model-call links and unreached questions are now modelled (§5, §12, §13).
6. **Tiered freshness.** Apply is blocked by relevant changes and warns on unrelated ones, with recorded acknowledgement (§11.1).
7. **Simplifications.** No inter-recommendation dependencies; hashes and excerpts instead of full captured content; coverage as a file list; minimal apply recovery.

---

## 1. Purpose

The model must answer:

1. What did we inspect, and what does it support?
2. What remains unknown?
3. What did the developer confirm?
4. What change did we recommend, and why?
5. What exact content did the developer approve?
6. What happened when we tried to apply it?
7. What did producing it cost, in model usage and developer effort?

## 2. Scope of the first slice

- One existing local repository.
- One target artifact: the repository's root `CLAUDE.md`.
- One target adapter: Claude Code.
- Workflow: inspect → clarify → recommend → review → apply.
- Read-only inspection. No repository scripts are executed. Commands are reported as found, not run.
- A session may complete with no change.

Out of scope: multiple repositories, scoped rule files, skills, commands, direct editing of the assembled file, command execution, maintenance checks (the model prepares for them; §9.1), local web UI.

## 3. Three distinct decisions

| Action | Meaning | Authorises a write? |
|---|---|---|
| Confirm intent | "New frontend requests should use the shared API client." | No |
| Accept a recommendation | "Include that guidance in the proposed file." | No |
| Approve an artifact revision | "Write this exact version of `CLAUDE.md`." | Yes, if freshness and validation checks still pass |

Confirming intent does not include it in the output. Selecting a recommendation does not approve the file. Approval never transfers to different content, different dependencies or a different repository state.

## 4. Domain groups

| Group | Records | Responsibility |
|---|---|---|
| Project understanding | Snapshot, Evidence, Finding, Conflict | What was inspected and what it supports |
| Destination | Guidance Block | Addressable structure of the existing `CLAUDE.md` |
| Developer intent | Question, Decision | Explicit resolution of what sources cannot establish |
| Proposed configuration | Recommendation Revision, Recommendation Selection, Artifact Revision | Proposed changes and their deterministic assembly |
| Review and application | Review, Apply Attempt | Exact approval and recoverable writes |
| Supporting | Model Call, Effort Interval | Generation cost, provenance and developer effort |

A Session connects these groups. Diffs and exports are projections derived from session records, never independent sources of truth.

## 5. Session

One attempt to configure one repository.

| Field | Notes |
|---|---|
| `id`, `schemaVersion` | Stable ID; persistence schema version |
| `productVersion` | Version of this CLI and core |
| `adapter` | `claude-code` in the first slice |
| `outputScope` | `["root CLAUDE.md"]` in the first slice |
| `repository` | Identity and resolved local root |
| `targetPath` | Fixed to root `CLAUDE.md` |
| `generationConfig` | Requested model, prompt/template set version, output schema versions, generation budget (token and/or cost ceiling), question budget |
| `stage` | `inspect`, `clarify`, `recommend`, `review`, `apply`, `complete` |
| `status` | `ready`, `running`, `awaiting_user`, `blocked`, `failed`, `completed`, `cancelled` |
| `outcome` | `applied`, `no_change`, `partial`, `failed`, `cancelled`, or unset while in progress |
| Active references | Active snapshot, current decisions, current selections, active artifact revision, review and apply-attempt references |
| Timestamps | Created, updated, completed |

Stage records where the developer is in the workflow. Status records whether work can proceed. A stored stage is never sufficient authorisation to write.

## 6. Project understanding

### 6.1 Snapshot

The bounded capture of repository content used for one analysis. Snapshots are immutable; refreshing creates a new snapshot and keeps the old one for traceability.

| Field | Notes |
|---|---|
| `id`, `capturedAt` | |
| `gitCommit?`, `workingTreeDirty` | Supporting metadata only; never a substitute for file hashes |
| `scope` | Included roots and patterns |
| `exclusions` | Default and user exclusions (secrets, dependencies, build output, lockfiles, binary files, session storage) |
| `files` | One entry per file under scope: repository-relative path, content hash, byte size, status (`read`, `listed_only`, `unreadable`, `truncated`) |
| `destination` | The captured target file: `absent`, or original bytes, hash and parsed Guidance Blocks (§7) |
| `readFailures` | Path and reason |
| `stability` | `stable`, or `unstable` with the paths that changed during capture |

**Coverage** is the `files` list itself: every path under the declared scope and exclusions, whether or not its content was sent to the model. Comparing a later file list with this one detects additions and removals.

**Content retention:** full file content is not stored. The snapshot keeps hashes for every file, excerpts for cited evidence (§6.2), and the full bytes of the destination file only. Line ranges are validated against the live file at capture time. This keeps sensitive source out of session storage.

A working-tree snapshot may include permitted uncommitted files. Capture is not atomic: if a file's hash changes between listing and reading, retry once, then record the snapshot as unstable and show it.

### 6.2 Evidence

A reference to specific captured content.

| Field | Notes |
|---|---|
| `id`, `snapshotId` | |
| `path`, `fileHash` | Must match a `read` entry in the snapshot |
| `lineStart`, `lineEnd` | Validated at capture time |
| `excerpt` | The cited lines, bounded in length |
| `basis` | `documentation`, `code_observation`, `existing_guidance` (§6.4) |

Evidence is created by code, never by the model. The model cites a context item, a line range and a verbatim quote. Code verifies the quote against the content actually sent, may correct the line range under a narrow recorded rule, derives the basis from the item's source, and extracts the excerpt itself ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.2–§3.2.4). A corrected range records both the original and corrected lines. Citations that fail are discarded, and the model call records the failure. A valid citation proves where the quote came from, not that it supports the claim; support is checked separately ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.3).

### 6.3 Finding

One claim about the repository, or one explicit unknown.

| Field | Notes |
|---|---|
| `id`, `snapshotId` | |
| `kind` | `claim` or `gap` |
| `statement` | Plain language |
| `mode` | `descriptive` ("tests live under `tests/`") or `prescriptive` ("docs require the generated client") |
| `basis` | Derived from evidence: `documentation`, `code_observation`, `existing_guidance`, or mixed |
| `scope` | `repository` or an explicit list of paths |
| `evidenceIds` | Required for `claim`; may be empty for `gap` |
| `uncertainty` | Short explanation; no numeric confidence score |
| `producedBy` | Model call ID, or `deterministic` |

A **gap** records something the product looked for and could not establish, for example: "No test command could be determined for `services/api`", or "Ownership of `shared/` is not documented." A gap may:

- raise a Question;
- appear in the review as an unresolved item;
- block recommendations that would depend on the missing information.

A gap must never be filled by a model assumption.

Deterministic inspection produces findings directly where possible: manifest scripts, existing agent configuration files, documented commands. Those findings record `producedBy: deterministic`.

### 6.4 Evidence rules

| Basis | Can support a new recommendation? | Can support preserving content? |
|---|---|---|
| `documentation` (prescriptive) | Yes, unless contradicted by a code observation; then it becomes a Conflict | Yes |
| `documentation` (descriptive) | Yes, as a fact | Yes |
| `code_observation` (descriptive) | Yes, as a fact (for example, a path or command exists) | Yes |
| `code_observation` presented as policy | No; requires a confirmed Decision | — |
| `existing_guidance` | No, not on its own | Yes |
| Confirmed Decision | Yes | Yes |

Rules:

- Frequency of a pattern never upgrades an observation to policy.
- Existing agent configuration cannot justify itself. If it disagrees with documentation or code, a Conflict is created.
- Documentation is enough for a recommendation unless a code observation contradicts it.

### 6.5 Conflict

Links findings that appear inconsistent.

| Field | Notes |
|---|---|
| `id` | |
| `findingIds` | At least two |
| `description` | What disagrees |
| `status` | `unresolved`, `resolved` |
| `resolvingDecisionId?` | Set when resolved |

Example: architecture documentation requires the shared client, the existing `CLAUDE.md` says to use `fetch`, and some components bypass the client. The conflict records this without choosing a policy.

An unresolved conflict blocks only the recommendations whose content depends on its resolution. Resolving a conflict never removes its evidence.

## 7. Destination: Guidance Blocks

The captured `CLAUDE.md` is parsed into an ordered list of blocks so that recommendations can target content precisely and assembly can be deterministic.

| Field | Notes |
|---|---|
| `blockId` | Stable within the snapshot: heading path plus ordinal, for example `Testing/list-item-2` |
| `type` | `heading`, `paragraph`, `list_item`, `code_block`, `other` |
| `headingPath` | Enclosing headings |
| `sourceSpan` | Byte offsets in the original file |
| `hash` | Hash of the block's exact bytes |

Rules:

- An absent destination has no blocks and is represented explicitly as `absent`. An existing empty file has zero blocks and is `present`.
- Parsing must be lossless: concatenating untouched blocks with their original surrounding bytes reproduces the original file byte for byte. This is verified at capture; if it fails, revisions and removals are disabled for that session, and only additions in a new section at the end are allowed.
- Content the parser cannot classify is kept as `other` blocks and preserved untouched.

## 8. Developer intent

### 8.1 Question

| Field | Notes |
|---|---|
| `id` | |
| `prompt`, `reason` | Wording and why it is asked |
| `findingIds`, `conflictIds`, `gapIds` | What it resolves |
| `options?` | Suggested answers; always presented as suggestions |
| `scope` | `repository` or explicit paths |
| `status` | `open`, `answered`, `skipped`, `unreached` |
| `producedBy` | Model call ID |

- The session's question budget caps how many questions are asked (default: five). Questions are ranked deterministically: conflicts first, then gaps about commands or ownership, then other gaps, then observed conventions ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.4). Questions beyond the budget are recorded as `unreached` with reason `budget`.
- `skipped` means the developer chose not to answer. `unreached` means the session ended before the question was presented. Both leave the matter unresolved, and both appear in the export.
- A skipped or unreached question never selects a default. Recommendations that depend on it are withheld; independent recommendations continue.

### 8.2 Decision

| Field | Notes |
|---|---|
| `id` | |
| `statement` | The developer's confirmed intent, in their words or an explicitly accepted wording |
| `scope`, `exceptions` | Scope as above; exceptions in plain language |
| `questionId?`, `conflictId?` | What it answers |
| `origin` | `answered_question`, `developer_correction` |
| `actor`, `decidedAt` | |
| `supersedesId?` | Corrections create a new decision |

Choosing a suggested option is a confirmation; the option itself was not one. A decision can establish new guidance that the code does not show; its origin records that, so it is not presented as a discovered fact.

## 9. Proposed configuration

### 9.1 Recommendation Revision

One understandable operation on the target file. Stable `recommendationId`, immutable `revisionId`.

| Field | Notes |
|---|---|
| `operation` | `add`, `revise`, `remove` |
| `kind` | `fact` (describes the repository) or `policy` (states what agents should do). Policy needs a decision or uncontested documented prescriptive support ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.5) |
| `target` | For `revise`/`remove`: `{ blockId, blockHash }`, which must match exactly one captured block. For `add`: an insertion point (`after: blockId`, or `section: headingPath`, or `newSection: heading`) |
| `content` | Proposed wording for `add`/`revise` |
| `rationale` | Why this helps an agent working in this repository |
| `support` | Evidence, finding and decision IDs; at least one, satisfying §6.4 |
| `references` | Structured references (below) |
| `scope` | `repository` or explicit paths; the scope the instruction describes, even though the file is root-level |
| `producedBy` | Model call ID, or `developer_edit` |
| `validation` | Result of deterministic checks |

**Structured references** list every concrete path, command or named file the wording mentions:

| Field | Notes |
|---|---|
| `kind` | `path`, `command` |
| `value` | For example `src/lib/api/client.ts`, or `pnpm test` |
| `evidenceId` | Where it was found |
| `verification` | Paths: `exists_in_snapshot` or `missing`. Commands: `found_not_run` in the first slice |

Deterministic validation runs on every revision:

- every path reference exists in the snapshot;
- every command reference resolves to a manifest script or a documented command in evidence;
- every reference value actually appears in `content`, and no path- or command-like token in `content` is missing from `references`;
- the support satisfies the evidence rules;
- the target block exists and its hash matches.

A revision that fails validation is not shown for selection. The failure is recorded.

These references are also the basis for later maintenance checks: stale paths and commands are detected by comparing stored references with a new snapshot.

**No dependencies between recommendations.** If two changes only make sense together, they are one recommendation. Two recommendations that target the same block are mutually exclusive: accepting one blocks accepting the other, and the reason is shown. The system never selects or deselects a recommendation for the developer.

Editing a recommendation's wording creates a new revision with `producedBy: developer_edit`. It is revalidated and must be selected again.

### 9.2 Recommendation Selection

The current selection is **one per stable `recommendationId`**, pointing at one exact revision.

| Field | Notes |
|---|---|
| `recommendationId`, `revisionId` | |
| `state` | `pending`, `accepted`, `rejected` |
| `actor`, `selectedAt` | |

Selecting a new revision replaces the previous selection for that recommendation. Selection history is retained. Rejecting a proposed addition never removes similar existing guidance; removal happens only through an accepted `remove` recommendation.

### 9.3 Assembly

Assembly is application code, not a model call.

1. Start from the captured destination blocks (or an empty document if `absent`).
2. Apply accepted revisions in a deterministic order: by target position in the original file, then by `recommendationId`.
   - `revise` replaces the target block's bytes with the new content.
   - `remove` deletes the target block.
   - `add` inserts content at the insertion point. A `newSection` addition creates its heading.
3. Serialise. Untouched blocks keep their original bytes, including surrounding whitespace.
4. Verify:
   - every changed, inserted or removed block maps to exactly one accepted revision;
   - every accepted revision produced exactly one change;
   - untouched blocks are byte-identical to the original.

If any check fails, assembly fails and no artifact revision is created. The resulting file may read as slightly stitched together. That is the intended trade: every line of change is attributable.

### 9.4 Artifact Revision

| Field | Notes |
|---|---|
| `id`, `revision` | Immutable |
| `snapshotId` | |
| `targetPath` | |
| `original` | `absent`, or hash (bytes are in the snapshot) |
| `proposedContent`, `proposedHash` | |
| `selectedRevisionIds` | Accepted recommendation revisions used |
| `decisionIds` | Current decision versions those revisions depend on |
| `attribution` | Map from changed block to recommendation revision (from §9.3) |
| `validation` | Assembly checks result |

If no revision is accepted, no artifact revision is created, and the session can complete as `no_change`. The diff shown at review is computed from the original and proposed content; it is not stored as a separate record.

## 10. Review

| Field | Notes |
|---|---|
| `id`, `artifactRevisionId`, `contentHash` | |
| `outcome` | `approved`, `rejected` |
| `actor`, `reviewedAt`, `comment?` | |

The review screen shows the full proposed file, the diff from the original, and, for each change, its recommendation, rationale and support. It also lists unresolved gaps, conflicts and skipped questions.

An approval is usable only while all of these hold:

- its artifact revision is the active one;
- the selected revisions and decision versions it records are still current;
- freshness checks pass (§11.1).

Old reviews remain as history and never transfer to a new revision, even if the bytes happen to be identical.

## 11. Application

### 11.1 Tiered freshness

Before any write, rescan the file list and hashes under the snapshot's scope. Compare the result with the snapshot.

**Block** (refresh and re-review required) if any of the following holds:

- the destination changed, including absent → present or present → absent;
- a file cited by evidence supporting any selected revision, or its findings, changed or was removed;
- a path reference in a selected revision no longer exists;
- files were added or removed within the scope of a finding that supports a selected revision (a repository-wide finding means anywhere in scope).

**Warn** (explicit acknowledgement required) if any other file in scope changed. The acknowledgement lists the changed paths and is recorded on the apply attempt.

This keeps application safe without blocking a developer who is editing unrelated files. Narrowing the blocking rules further requires evidence from use.

### 11.2 Apply Attempt

| Field | Notes |
|---|---|
| `id`, `artifactRevisionId`, `reviewId` | |
| `expectedOriginal` | Hash or `absent` |
| `intendedHash` | |
| `freshness` | Result of §11.1, including acknowledged warnings |
| `state` | `started`, `succeeded`, `blocked`, `failed`, `recovery_required` |
| `error?`, timestamps | |

Procedure:

1. Resolve the destination inside the repository root; reject path traversal and symlinked destinations.
2. Confirm a usable approval (§10).
3. Run freshness checks (§11.1).
4. Persist the attempt as `started`.
5. Write the approved bytes to a temporary file in the same directory. Re-check the destination hash, then rename over the destination (or create it, if `absent`).
6. Hash the destination and record `succeeded`, or `failed` with the reason.

A session lock prevents two instances of this CLI from operating on one session. It cannot stop other editors, which is why step 5 re-checks the hash.

**Recovery** for a `started` attempt found on resume:

| Destination now | Action |
|---|---|
| Matches the intended hash | Record `succeeded`; do not write again |
| Matches the expected original | Allow a checked retry |
| Matches neither | Record `recovery_required`; report a conflict |

## 12. Change propagation

Currency is determined by the versions of dependencies, not by timestamps.

| Change | Consequence |
|---|---|
| Decision answered, corrected or superseded | Recommendations depending on affected findings, conflicts or decisions are regenerated as new revisions. Their selections return to `pending`. The active artifact becomes outdated. |
| Recommendation edited | New revision; selection required |
| Selection changed | New assembly and artifact revision; fresh review required |
| Blocking freshness failure | New snapshot; affected findings refreshed; recommendations revalidated or regenerated; new review |
| Destination changed | New snapshot with re-parsed blocks. Revisions targeting changed blocks become invalid; others are re-anchored only if their block hash still matches exactly one block. |
| All recommendations rejected | Session completes as `no_change` |

In the first slice, invalidating the whole proposal is acceptable wherever the narrower impact cannot be established reliably.

## 13. Supporting records

### 13.1 Model Call

| Field | Notes |
|---|---|
| `id`, `purpose` | `analyse`, `analyse_expansion`, `generate_questions`, `recommend`, `regenerate_recommendations` |
| `validatorVersion`, `detectorVersion` | Validation rules and reference detector in force ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.4–§3.5) |
| `validationEvents` | Every rejection, correction and relabelling, with stable rule IDs; no source content |
| `requestedModel`, `returnedModel?` | |
| `promptVersion`, `schemaVersion` | |
| `inputManifest` | Snapshot ID and hashes of included files and excerpts; excluded files listed; no source content |
| `retainedInputRef?` | Content-addressed reference to the exact request body, when `retainModelInputs` is on ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.12) |
| `budget` | Limits applied to this call |
| `usage` | Input, output and cached tokens where available |
| `cost?`, `costBasis` | `reported`, `estimated`, or `unknown`. Unknown is never recorded as zero |
| `outcome`, `validationErrors` | |
| timestamps, `durationMs` | |

Every model-produced record carries `producedBy`, linking each finding, question and recommendation revision to the prompt and schema version that created it. Calls stop when the session's generation budget is reached. The session then continues with whatever is validated, and records the reason.

### 13.2 Effort Interval

Active developer effort is recorded separately from elapsed generation time.

| Field | Notes |
|---|---|
| `enteredAt`, `leftAt` | Period with status `awaiting_user` |
| `stage` | Which stage the developer was working on |

Active effort is the sum of these intervals. This is an approximation: a developer may step away while the tool is waiting. The CLI allows a manual correction, recorded with a reason. The export states which method produced the number.

## 14. Export

A versioned projection generated from session records. It is never edited directly. It maps to the handoff's suggested session export:

| Handoff section | Source records |
|---|---|
| Identity | Session ID, timestamps, `productVersion`, `adapter`, `outputScope` |
| Inputs | Snapshot identity (commit, dirty flag, file hashes, scope, exclusions), initial destination state and hash, `generationConfig`, prompt and schema versions |
| Reasoning evidence | Findings (claims and gaps), evidence references and excerpts, conflicts, questions with every status, decisions including superseded ones |
| Review | All recommendation revisions, including rejected and invalid ones; selection history; developer edits; reviews |
| Outputs | Final diff, artifact revisions, applied file list, final configuration hash, unresolved gaps, conflicts and questions |
| Measurements | Elapsed time, active developer effort and its method, model usage and cost with `costBasis`, explicit reasons for missing values |
| Outcome | Session `outcome`, apply attempts and failure details |

The export always states whether its artifact content is proposed, approved or applied. It contains no credentials and no source content beyond cited excerpts. Including excerpts is a visible export option, because they may be sensitive.

## 15. Persistence

- Sessions live outside the repository, under the user's application data directory (for example `~/.config/ai-environment-architect/sessions/<id>/`). If a user configures a location inside the repository, it is added to the snapshot exclusions automatically.
- Each session is one versioned JSON file, plus separate files for the destination's original bytes and each artifact revision's content.
- Writes use temporary files and atomic rename. A lock file prevents two CLI processes from opening one session.
- Load validates the schema version and all internal references. Unsupported versions are rejected with a clear message.
- Revisions are appended, never mutated. No event-sourcing framework is needed.
- Exact model request bodies may be retained in the session directory under the `retainModelInputs` policy ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.12). They are excluded from exports by default, deleted with the session, and can be purged separately. The snapshot itself still stores no full source content.

## 16. Scenario walkthroughs

**A. New configuration.** The destination is `absent`. Inspection finds manifest scripts and an architecture document. A gap is recorded: no documented lint command for the API package. Two questions are asked; one is skipped. The developer accepts four `add` recommendations; one that depended on the skipped question was withheld. Assembly creates a new file. Approval and apply confirm the destination is still absent.
*Invariant:* if `CLAUDE.md` appears before apply, freshness blocks the write.

**B. Existing guidance conflicts with documentation.** Block `Conventions/list-item-3` says to use `fetch`. Architecture documentation requires the shared client, and code shows both patterns. A Conflict links the three findings. The developer decides: shared client, except for streaming. A `revise` recommendation targets that block and hash. Assembly changes only that block.
*Invariant:* existing guidance does not justify itself, and nothing is removed without an accepted `remove` or `revise`.

**C. Answer changed after approval.** The developer adds the streaming exception after approving the file. A new decision supersedes the old one. The dependent recommendation is regenerated, its selection returns to `pending`, and a new artifact revision needs a new review.
*Invariant:* the earlier approval stays in history and cannot authorise the new file.

**D. Repository changes before apply.** The developer edits an unrelated component. Apply warns and records the acknowledgement. Separately, the API client file is moved. Its path reference is now `missing`, so apply blocks. A new snapshot is taken, the reference fails validation, and a new recommendation is proposed for review.
*Invariant:* an outdated reference is never written, and unrelated edits don't force a full refresh.

**E. Nothing to change.** Existing guidance is accurate and documentation agrees with it. No recommendation passes the evidence rules with a material improvement, or the developer rejects all of them. The session completes as `no_change` with no write. The export records the findings that support that conclusion.

## 17. First-slice verification

- Evidence validation rejects invented paths, invalid ranges and mismatched excerpts.
- An observed pattern cannot become policy without a confirmed decision.
- Existing guidance cannot support a new recommendation on its own.
- Gaps are recorded and never filled by assumption.
- Skipped and unreached questions withhold dependent recommendations.
- Structured references match the wording; missing paths fail validation.
- Commands are labelled found, not run.
- Block parsing is lossless for every destination fixture.
- Assembly attributes every change to exactly one accepted revision and leaves untouched blocks byte-identical.
- Two recommendations targeting one block cannot both be accepted.
- Changed decisions, selections or content invalidate earlier approval.
- Freshness blocks relevant changes, warns on unrelated ones, and records acknowledgement.
- Absent and empty destinations are distinguished.
- An interrupted apply recovers without repeating the write.
- `no_change` performs no write.
- Unknown cost is never exported as zero.
- The export distinguishes proposed, approved and applied content, and its hashes match the session.

## 18. Remaining implementation choices

- Markdown parser selection and the exact block-identifier scheme. The losslessness test (§7) is the acceptance criterion.
- Default exclusion patterns and snapshot size limits.
- Excerpt length limit and export option defaults.
- Context selection for model calls: which files and excerpts are sent within the budget. It must be deterministic and recorded in each call's `inputManifest`.
- CLI interaction for answering questions, editing recommendation wording and reviewing the diff.
- Handling of unsupported encodings.

Resolve these in the implementation specification without expanding the first slice to multiple repositories, other configuration files or a general policy engine.
