# Domain Model

**AI Environment Architect · AI Product Studio**  
**Date:** 13 October 2026  
**Version:** 0.7 — consolidated specification  
**Status:** Proposed specification for the first implementation slice. Not implemented code.

**Supersedes:** the earlier Data Model and Review Decisions v0.1 and Domain Model v0.2 design drafts, which are not kept in this repository. This is the single authoritative domain model.

**Authorities:** [Product Thesis](../product/PRODUCT_THESIS.md) v0.1, [Product Evaluation Requirements](../product/EVALUATION_REQUIREMENTS.md) (5 October 2026), [ADR 0001: Standalone TypeScript CLI](../decisions/0001-standalone-typescript-cli.md) (5 October 2026). The evaluation requirements are a product-facing document outside the frozen evaluation materials; their export requirements are adopted directly in §14.

**Companion:** [Implementation Specification](IMPLEMENTATION_SPEC.md).

### Changes from v0.6

1. **Ignored files (§6.1).** Files the repository's ignore rules match, as git lists them, have the status `ignored`: hashed and listed, but never sent and never expanded. They no longer count as untracked. Without git, ignore rules are not applied. Ignored files are listed after the two observations, so the stability check doesn't cover them.
2. **Personal agent configuration excluded (§6.1).** `CLAUDE.local.md` and `.claude/settings.local.json` are default exclusions.

### Changes from v0.5

1. **Guidance Block parsing made exact (§7).** A line-based CommonMark subset with no Markdown library; spans exclude the final line ending; a top-level list item is one block, nested items included, and records its marker and indentation; the parsed destination records its line endings; the block ID scheme, including how repeated headings stay unique; the round-trip checks, and the fallback to one whole-file `other` block. This settles the parser and block-identifier item in §18.
2. **Destination unavailable for content reasons (§6.1, §7).** A root `CLAUDE.md` that would be `listed_only` because it is not valid UTF-8 or contains a NUL byte is `unavailable`, like one that is too large. It is never parsed.
3. **Open point (§9.1, §18).** An `add` target of `section: headingPath` is ambiguous when sibling sections repeat a heading. To decide in M5.

### Changes from v0.4

1. **Git metadata.** `gitCommit?` and `workingTreeDirty` become one `git` field: known, with the commit, object format and a comparison of the working tree with the commit, or unknown with a reason. "Dirty" is defined as working-tree bytes differing from the commit, and is computed from the snapshot, never by `git status` (§6.1).

### Changes from v0.3

1. **Snapshot statuses and destination states.** Files gain the statuses `excluded` and `symlink`, so excluded paths and symbolic links stay in the coverage list. Symbolic links are never followed. Files ignored by `.gitignore` are not excluded unless an exclusion matches them. A root `CLAUDE.md` that exists but can't be captured safely is `unavailable`, not absent, and the session stops before any model call. Capture compares two full observations of the repository (§6.1).

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
| `git` | Supporting metadata only; never a substitute for file hashes. Either `unknown` with a reason (not inspected, git missing or too old, not a repository, refused as unsafe, or a git error), or known: object format (`sha1` or `sha256`), commit (none when HEAD names a branch with no commits yet; any other HEAD that can't be resolved is a git error), `workingTreeDirty` (`true`, `false` or `unknown`), and the modified, deleted and uncompared paths, the untracked count and the submodules. Git also lists the ignored files (below) |
| `scope` | Included roots and patterns |
| `exclusions` | Default and user exclusions (secrets, dependencies, build output, lockfiles, personal agent configuration, binary files, session storage) |
| `files` | One entry per path under scope: repository-relative path, content hash, byte size, status (`read`, `listed_only`, `ignored`, `unreadable`, `truncated`, `excluded`, `symlink`) |
| `destination` | The captured target file: `absent`; original bytes, hash and parsed Guidance Blocks (§7); or `unavailable` with a reason, when a root `CLAUDE.md` exists but is a symbolic link, not a regular file, unreadable, larger than the readable-file limit, not valid UTF-8, contains a NUL byte, or is present only under another letter case (such as `claude.md`) |
| `readFailures` | Path and reason |
| `stability` | `stable`, or `unstable` with the paths that changed during capture |

**Coverage** is the `files` list itself: every path under the declared scope and exclusions, whether or not its content was sent to the model. Comparing a later file list with this one detects additions and removals.

- An **excluded** path is listed with the rule that matched it, and is never opened: it has no hash or size. An excluded directory is one entry, and nothing inside it is listed.
- A **symbolic link** is listed with its target, and is never followed, whether the target is inside the repository root or outside it. It has no hash or size.
- An **ignored** file is readable, not tracked by the commit, and matched by the repository's ignore rules as git lists them. It is listed with its hash and size, but is never sent to the model and never expanded, unless the developer keeps it as a candidate with the `includeIgnored` setting ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.4). The destination, tracked files, excluded entries and symbolic links are never `ignored`. Without git, ignore rules are not applied: only the default and user exclusions apply, and the inspect summary says so.
- An entry whose name is not valid UTF-8, or a symbolic link whose target is not, is listed as `unreadable` under an escaped name (`\xNN` for each byte outside printable ASCII). If it is a directory, nothing inside it is listed. Every `unreadable` entry records its kind: file, directory, symbolic link or other.
- `truncated` is not produced at capture. Capture reads files whole or not at all.

An `unavailable` destination stops the session before any model call, with the reason ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.5). Recommendation, review and apply therefore only ever see `absent` or a captured destination.

**Git metadata** never fails a snapshot: when git can't answer, it is `unknown` with the reason.

The working tree is **dirty** when its bytes differ from the commit: a tracked path's content (or link target) differs or has changed between file and link, a tracked path is missing, or a file the commit doesn't track is present. The comparison covers the snapshot's non-excluded paths only:

- Excluded paths are never opened, so they are not compared, even when tracked. A changed lockfile doesn't make the tree dirty.
- Submodules are listed but not compared, and files inside them are not counted as untracked.
- A tracked path that can't be compared (unreadable, or changed since capture) is listed as uncompared, and so is any unreadable directory, tracked or not, because it may hide changes. If nothing else differs, `workingTreeDirty` is then `unknown`, never `false`.
- `ignored` files are not untracked, as in `git status`, even when `includeIgnored` keeps one as a candidate. Without git there is no comparison at all.
- Only bytes are compared. The executable bit and the index (staged changes) are not.
- `.git` is excluded whether it is a directory or, in a linked worktree, a `gitdir:` file.

Because the comparison uses the bytes on disk, not git's view of them, a checkout can read as dirty when `git status` would call it clean: files git converted on the way out (line-ending conversion through `core.autocrlf` or `eol` attributes, other clean/smudge filters, Git LFS pointers), and paths a sparse checkout or `skip-worktree` leaves out of the working tree, which read as deleted. A partial clone whose committed blobs aren't all present locally gives a git error, because missing objects are never fetched.

**Content retention:** full file content is not stored. The snapshot keeps hashes for every file, excerpts for cited evidence (§6.2), and the full bytes of the destination file only. Line ranges are validated against the live file at capture time. This keeps sensitive source out of session storage.

A working-tree snapshot may include permitted uncommitted files. Capture is not atomic: the repository is observed twice, and if any path differs between the two, both observations are repeated once. If they still differ, the snapshot is recorded as unstable with those paths, and shown ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.4).

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
| `blockId` | Stable within the snapshot: heading path plus type and ordinal, for example `Testing/list-item-2` (below) |
| `type` | `heading`, `paragraph`, `list_item`, `code_block`, `other` |
| `headingPath` | Text of the enclosing headings, outermost first. A heading block's path excludes the heading itself |
| `sourceSpan` | Byte offsets in the original file, start inclusive and end exclusive. A block runs from the start of its first line to the end of its last line's content: it includes its indentation, its list marker and the line endings inside it, but not its final line ending |
| `hash` | Hash of the block's exact bytes |
| `listMarker` | `list_item` only: the exact indentation and marker of its first line, such as `-`, `*` or `2.` |

The parsed destination also records its **line endings**: the number of LF, CRLF and lone CR endings, and the style (`lf`, `crlf`, `cr`, `mixed`, or `none` when there are none). Assembly (§9.3) converts new content to this style; how it treats `mixed` and `none` is decided with assembly.

**Parsing** is a line-based subset of CommonMark, read on bytes, with no Markdown library:

- LF, CRLF and a lone CR each end a line. A UTF-8 byte order mark at the start of the file belongs to no block.
- Bytes outside every block are **separators**: the byte order mark, line endings, and blank lines (spaces and tabs only). A block never starts or ends with a blank line.
- `heading`: ATX headings (`#` to `######`) and setext headings, where the paragraph lines and the `=` or `-` underline form one block.
- `code_block`: fenced (backticks or tildes, closed only by the same character at least as long) or indented by four columns. A fence that is never closed runs to the end of the file. `#` lines inside a fence are not headings.
- `list_item`: a **top-level item**, with everything nested in it: sub-items, continuation and lazy lines, and code inside it. Nested items are not separate blocks, so a `revise` replaces the whole item.
- `paragraph`: consecutive lines that no other block interrupts.
- `other`: front matter (a first line of exactly `---`, closed by `---` or `...`, with no blank line in between), HTML blocks, thematic breaks, block quotes and GFM tables.
- HTML blocks follow CommonMark's start and end conditions. Comments, processing instructions, declarations, CDATA and `pre`, `script`, `style` and `textarea` run to their closing marker, even across blank lines. Block-level tags such as `div` or `details`, and a line holding only one complete tag, run to a blank line. A line that merely starts with inline HTML, such as `<b>Never</b> push`, is a paragraph. A line holding only one complete tag doesn't interrupt a paragraph; the other HTML blocks do.
- A GFM table (a line containing `|`, followed by a delimiter row) is recognised only where a block starts. It does not interrupt a paragraph, so a table directly under a paragraph line stays part of that paragraph.

**Block IDs.** A block's ID is its heading segments followed by `<type>-<n>`, joined with `/`. The type token is `paragraph`, `list-item`, `code-block` or `other`, and `n` counts blocks of that type directly in the section, from 1. Blocks before the first heading have no segments (`paragraph-1`). A heading block's ID is the segments of the section it opens, followed by `heading` (`Rules/Testing/heading`).

- A **segment** is the heading's text, with an ATX closing sequence removed, setext lines joined by one space and surrounding spaces and tabs trimmed. `%`, `/`, `[`, `]` and control characters (C0, DEL and C1) are percent-encoded (`a/b` → `a%2Fb`).
- **Repeated headings:** a heading whose segment matches an earlier sibling's, meaning a heading under the same parent section, gets `[k]` for its k-th occurrence: `Notes`, `Notes[2]`, `Notes[3]`. The same heading under different parents is already distinguished by its path.
- IDs are therefore unique. Segment boundaries and suffixes are unambiguous because `/`, `[` and `]` are encoded. Every ID ends in a type token or `heading`, and each subsection adds a segment, so a section's own blocks never collide with its subsections' blocks. A repeated ID still fails the round trip (below), as a safeguard.

Rules:

- An absent destination has no blocks and is represented explicitly as `absent`. An existing empty file has zero blocks and is `present`. So does a file containing only separators.
- The destination is `unavailable`, and is never parsed, whenever the candidate rules ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.4) would make it `listed_only`: for a content reason (`not_utf8`, `contains_nul`), as well as when it is too large (§6.1).
- Parsing must be lossless: concatenating untouched blocks with their original surrounding bytes reproduces the original file byte for byte. This is verified at capture: the file is rebuilt from the separators and each block's bytes and compared byte for byte, spans must be in order and must not overlap, each hash must match its span, separators must contain nothing but the byte order mark, spaces, tabs and line endings, and IDs must be unique.
- If verification fails, or the parser fails, the round trip is recorded as failed with the reason, and the blocks are replaced by one `other` block (`other-1`) covering the whole file, byte order mark included, so the destination can still be shown and sent in full. An empty file has no fallback block. Revisions and removals are then disabled for that session, and only additions in a new section at the end are allowed.
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
| Inputs | Snapshot identity (git metadata as recorded, including `unknown` states and their reasons; file hashes, scope, exclusions), initial destination state and hash, `generationConfig`, prompt and schema versions |
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

- Default exclusion patterns and snapshot size limits.
- Excerpt length limit and export option defaults.
- Context selection for model calls: which files and excerpts are sent within the budget. It must be deterministic and recorded in each call's `inputManifest`.
- CLI interaction for answering questions, editing recommendation wording and reviewing the diff.
- Handling of unsupported encodings.
- **For M5:** how an `add` names its section (§9.1). `section: headingPath` is ambiguous when sibling sections repeat a heading, such as two `## Notes` under `# A`, which §7 tells apart only by block ID (`A/Notes`, `A/Notes[2]`). Probably target the section's heading block ID, or require the path to match exactly one section.

Resolve these in the implementation specification without expanding the first slice to multiple repositories, other configuration files or a general policy engine.
