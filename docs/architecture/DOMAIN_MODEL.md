# Domain Model

**AI Environment Architect · AI Product Studio**  
**Date:** 4 November 2026  
**Version:** 0.32 — consolidated specification  
**Status:** Proposed specification for the first implementation slice. Not implemented code.

**Supersedes:** the earlier Data Model and Review Decisions v0.1 and Domain Model v0.2 design drafts, which are not kept in this repository. This is the single authoritative domain model.

**Authorities:** [Product Thesis](../product/PRODUCT_THESIS.md) v0.1, [Product Evaluation Requirements](../product/EVALUATION_REQUIREMENTS.md) (5 October 2026), [ADR 0001: Standalone TypeScript CLI](../decisions/0001-standalone-typescript-cli.md) (5 October 2026). The evaluation requirements are a product-facing document outside the frozen evaluation materials; their export requirements are adopted directly in §14.

**Companion:** [Implementation Specification](IMPLEMENTATION_SPEC.md).

### Changes from v0.31

1. **Change propagation (§9.4, §12).** After a refresh every current revision is checked alone again, not only a re-anchored one: a changed neighbour, such as a section's new last block, can make an unchanged target fail alone.
2. **Stale revisions (§9.4).** An accepted revision whose support is no longer current is named and not assembled, so the developer can reject it and continue.

### Changes from v0.30

1. **Apply attempt (§11.2).** A blocking freshness result records one `blocked` attempt, and nothing is written. The temporary file is named after the attempt, `.CLAUDE.md.<applyAttemptId>.tmp`, and recovery removes it before recording the outcome; a file already at that name isn't the attempt's and is left alone. Recovery records the end time as unknown, because the write's real end isn't known. Apply refuses while an earlier attempt is still `started`, until recovery has run.

### Changes from v0.29

1. **Tiered freshness (§11.1).** What a change is: an added or removed path, a different hash, symbolic link target, or status for an entry without a hash, and every path an unstable rescan names. The findings behind a selected revision include those its decisions' questions and conflicts cover, as in §12; a gap's related paths and an absence claim's glob count as their scope. A path reference exists when the rescan lists it, as `REF-002` checks. Warnings are the changed paths no blocking rule names.

### Changes from v0.28

1. **Usable approval (§10).** Only the latest review of an artifact revision counts: a later rejection withdraws an earlier approval of the same revision ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.2).

### Changes from v0.27

1. **Clashing selections (§9.2).** A refresh's re-anchoring, or a hand-edited session, can leave two accepted recommendations that §9.1 makes exclusive. Code derives the clash with the same rules and reasons as accepting; final review is blocked until the developer rejects one, and assembly is never given a clashing set. It is not a load error ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §2.7, §4.4.2).

### Changes from v0.26

1. **Evidence rules (§6.4).** In the first slice, an absence claim and a gap never support a recommendation ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.5, `REC-006`, `REC-010`).

### Changes from v0.25

1. **Assembly (§9.3).** Content placed in a removed run is followed by the separator after the whole run, not the anchor's own, so it takes the run's place. A rendered `newSection` heading is followed by one blank line. In a present file with no blocks, new content follows the byte order mark and precedes the file's other bytes, with one line ending between them unless those bytes start with one. When the round trip failed, new sections are appended after one blank line and the file ends with one line ending.
2. **Order at one position (§9.3).** Other additions come before `newSection` additions, so an addition to a section never lands under a new section's heading.
3. **Attribution (§9.4).** The entries of a run of removed blocks stay together, followed by the additions placed where the run was.
4. **Unassemblable combinations (§9.4).** The revision named with the first failing one is the first earlier revision whose removal lets the rest pass.

### Changes from v0.24

1. **Line endings (§7).** A `mixed` file uses its most frequent ending, ties broken in the order LF, CRLF, CR. `none`, and an absent destination, use LF.
2. **Targets (§9.1).** `section` names the section's heading block, which settles the §18 open point. A heading may be revised as one line at the same level. Removing a heading removes its whole section, as one recommendation; a heading is never removed on its own. `newSection` goes after a heading's whole section, or at the end of the file.
3. **Support and references (§9.1).** Support holds findings and decisions; evidence is reached through the findings. A reference records its supporting finding and the evidence code chose. Each new revision with new content has its own `producedBy`; an invalidation repeats it. A developer edit records its validation events; `validation` is gone.
4. **Mutual exclusion (§9.1).** Between `revise` and `remove` recommendations on one block, and between removing a section and any `revise` or `remove` inside it. Additions are never exclusive.
5. **Selections (§9.2).** A selection, accepted or rejected, counts only while the revision it names is current.
6. **Assembly (§9.3).** Ordered by position, then by the `seq` of each recommendation's first revision, because IDs carry no order. Placement, removal, separators and line-ending conversion are exact. An addition anchored to removed content goes where that content was. The assembled file must parse back into the expected blocks.
7. **Artifact revision (§9.4).** Attribution is a list of entries. `validation` is gone, because a failed assembly creates no artifact revision.
8. **Apply recovery (§11.2).** A `started` attempt whose destination still holds the original is recorded `failed`; a retry is a new attempt.
9. **Reference verification (§9.1).** A path reference is `exists_in_snapshot` when created; `missing` is derived from a later snapshot, never written.
10. **Unassemblable combinations (§9.3, §9.4).** Accepted recommendations that assemble alone but not together are a conflict the developer resolves by rejecting one; only a single revision that fails is an internal error. A destination whose round trip failed is verified by its unchanged prefix.
11. **Verification (§17).** Lines for line endings, list markers, separators, the reparse check, section removal and additions anchored to removed content.
12. **Change propagation (§12).** A changed decision also affects recommendations supported by findings its question or conflict covers. A selection returns to pending by derivation. Re-anchoring is derived, and a target that no longer resolves is invalidated by code. A new decision that affects no recommendation calls the model only if it unblocks a held-back entry.

### Changes from v0.23

1. **Effort (§13.2).** An interval still open while another live process holds the session is in progress, and makes active effort a lower bound too, counted apart from interrupted ones ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.6).

### Changes from v0.22

1. **`revisedBy` (§6.3, §6.5).** Only findings and conflicts have it, the only records a model call revises. Decisions and selections carry `actor`.

### Changes from v0.21

1. **Generation config (§5).** It holds the expansion settings too ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.8, §1.14).

### Changes from v0.20

1. **Who revised a record (§6.3, §6.5).** Findings and conflicts gain `revisedBy`: the model call that appended a revision after the first. `producedBy` stays the call that created the record ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1).
2. **Failed items (§6.3, §9.1).** A failed item keeps the rule that rejected it: an item stops at its first rejection.
3. **Unentered directories (§6.2).** Shown directories in path order, then withheld ones in hash order.
4. **Generation config (§5).** Prompt and schema versions are recorded on each model call (§13.1), not in `generationConfig`.

### Changes from v0.19

1. **Session (§5).** The outcome is `applied`, `no_change`, `failed` or `cancelled`; `partial` is gone. `completeness` is separate: `complete`, or `incomplete` with the reasons `budget_reached` (only while the stopped call is still unsent), `stage_skipped` and `questions_unreached`. Stage, status, outcome and configuration change by appended records; completeness and the active references are derived.
2. **Absence evidence (§6.2, §6.3).** Evidence gains the kind `absence_check`, always `code_observation`. Findings gain the kind `absence`, so every finding that isn't a gap has evidence.
3. **Revisions (§6.3, §6.5, §8.1, §8.2, §9.1, §11.2, §13).** Findings, conflicts, questions, apply attempts, model calls and effort intervals have a stable lineage ID and numbered revisions; `supersedesId` becomes `supersedes`, a list. Conflicts carry their snapshot, and only findings and conflicts of the active snapshot are current. A decision can name the finding it corrects (`findingId`); a corrected finding is not current. The note for M4 in §6.5 is replaced by the rule it settled ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.5).
4. **Items that failed validation (§6.3, §6.5, §8.1, §9.1).** Findings, conflicts, questions and recommendation revisions that fail validation are kept with status `failed_validation`, their text and their rules. Recommendation revisions have a status: `valid`, `failed_validation` or `invalidated` with a reason.
5. **Model calls and effort (§13).** A model call has a state, an attempt number, an estimated cost and a retained-response reference, and no longer lists `outcome` and `validationErrors`. Interrupted calls and effort intervals are recorded by the process that resumes the session, with unknown values, never zero.
6. **Export and persistence (§14, §15, §17, §18).** Items that failed validation and held-back entries are exported; excerpts and the quotes in failed items are off by default. Storage is the XDG data directory, with one override, and never inside the target repository; the data-notice state lives there; content files are content-addressed; responses are retained for replay. No migrations before v0.1.0. A verification line for failed items is added. "Export option defaults" is settled.

### Changes from v0.18

1. **Entry evidence (§6.2, §6.4).** `entry` evidence is always `code_observation`, because it only observes the file list ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.4). That an agent configuration file exists is a fact about the snapshot; what it says remains existing guidance.

### Changes from v0.17

1. **Withdrawn reasons (§6.5).** Written with underscores, as `members_merged` and the §8.1 reasons are: `withdrawn_by_model`, `member_withdrawn`, `members_merged`, `sources_not_distinct`.

### Changes from v0.16

1. **Withdrawn reasons (§6.5).** `members_merged`: a conflict that falls below two members only because one replacement stands for several of them.
2. **Note for M4 (§6.5).** The direction for conflict records: every change is a new revision, the latest holds the current status, withdrawal is a revision with status `withdrawn`, and a replacement is a new conflict whose `supersedesId` points at the old one.

### Changes from v0.15

1. **Conflict status (§6.5).** A conflict is `unresolved`, `resolved` or `withdrawn`, with `withdrawnReason` when withdrawn. A change to its members creates a new conflict revision that supersedes the old one; the old one is kept unchanged ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.3).
2. **Unreached questions (§8.1).** `unreached` means not presented to the developer, with the reason `session_ended` or `budget`. Ranking puts unresolved conflicts first, not every conflict.

### Changes from v0.14

1. **Gap coverage (§6.3).** A `not_inspected` gap records the directories capture didn't enter that count under [`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.11: those a related path names explicitly, and those it could reach that may hide project content. A default exclusion or ignored directory a glob could only reach is not recorded.

### Changes from v0.13

1. **Entry evidence (§6.2).** Evidence is `lines` or `entry`. Entry evidence records a file in the snapshot by path and hash, with no lines or excerpt; only code creates it, for known facts about files. Evidence the model cites must target lines sent in that call; evidence code creates must come from content verified against the snapshot hash ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.5).

### Changes from v0.12

1. **Finding basis (§6.3).** A finding's basis is the set of its citations' bases; "mixed" means a set with more than one entry ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.4).

### Changes from v0.11

1. **Excerpts and dropped citations (§6.2, §6.3).** An excerpt holds at most 40 cited lines, provisionally, and is never truncated: a longer citation is rejected. `droppedCitations` includes duplicate citations merged into an earlier one ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.2).

### Changes from v0.10

1. **Schema hash (§13.1).** The Model Call records `schemaHash` with `schemaVersion`, as [`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.7 already required.

### Changes from v0.9

1. **Alias mapping (§13.1).** The Model Call records its alias table ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.1).
2. **Dropped citations (§6.3).** A finding records how many of its proposed citations were rejected, so the findings view can show it.

### Changes from v0.8

1. **Evidence from `listed_only` files (§6.2).** Evidence may point at a `listed_only` entry, through a line-range expansion, as long as the cited lines were sent in that call.
2. **Basis wording (§6.2).** Basis is derived from the tier the cited file belongs to.
3. **Gap coverage (§6.3).** A gap records whether its related paths were inspected, or which ones weren't, set by code ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.11).

### Changes from v0.7

1. **Ignored directories (§6.1).** Ignored entries are listed before capture. A wholly ignored directory is one `ignored` entry that capture doesn't enter, like an excluded directory.
2. **Ignore rules recorded (§6.1).** The snapshot records whether ignore rules were applied, or the reason they weren't, separately from the git metadata. Git 2.38 to 2.43 is used except in a partial clone.

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
| `generationConfig` | Requested model, context selection settings and their hash, expansion settings, generation budget (token and/or cost ceiling), question budget, `retainModelInputs`. The prompt and output schema versions are recorded on each model call (§13.1) |
| `stage` | `inspect`, `clarify`, `recommend`, `review`, `apply`, `complete` |
| `status` | `ready`, `running`, `awaiting_user`, `blocked`, `failed`, `completed`, `cancelled` |
| `outcome` | `applied`, `no_change`, `failed`, `cancelled`, or unset while in progress |
| `completeness` | `complete`, or `incomplete` with its reasons: `budget_reached`, `stage_skipped`, `questions_unreached`. Separate from the outcome: an applied session can be incomplete |
| Active references | Active snapshot, current decisions, current selections, active artifact revision, review and apply-attempt references |
| Timestamps | Created, updated, completed |

Stage records where the developer is in the workflow. Status records whether work can proceed. A stored stage is never sufficient authorisation to write.

Stage, status and outcome change by appending session state records, and `generationConfig` by appending configuration records. Completeness and the active references are derived from the records, never stored ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.2). Completeness counts `budget_reached` only while the call the budget stopped is still unsent.

## 6. Project understanding

### 6.1 Snapshot

The bounded capture of repository content used for one analysis. Snapshots are immutable; refreshing creates a new snapshot and keeps the old one for traceability.

| Field | Notes |
|---|---|
| `id`, `capturedAt` | |
| `git` | Supporting metadata only; never a substitute for file hashes. Either `unknown` with a reason (not inspected, git missing or too old, not a repository, refused as unsafe, or a git error), or known: object format (`sha1` or `sha256`), commit (none when HEAD names a branch with no commits yet; any other HEAD that can't be resolved is a git error), `workingTreeDirty` (`true`, `false` or `unknown`), and the modified, deleted and uncompared paths, the untracked count and the submodules. Ignored entries are listed separately, before capture (`ignoreRules`, below) |
| `scope` | Included roots and patterns |
| `exclusions` | Default and user exclusions (secrets, dependencies, build output, lockfiles, personal agent configuration, binary files, session storage) |
| `files` | One entry per path under scope: repository-relative path, content hash, byte size, status (`read`, `listed_only`, `ignored`, `unreadable`, `truncated`, `excluded`, `symlink`) |
| `destination` | The captured target file: `absent`; original bytes, hash and parsed Guidance Blocks (§7); or `unavailable` with a reason, when a root `CLAUDE.md` exists but is a symbolic link, not a regular file, unreadable, larger than the readable-file limit, not valid UTF-8, contains a NUL byte, or is present only under another letter case (such as `claude.md`) |
| `readFailures` | Path and reason |
| `stability` | `stable`, or `unstable` with the paths that changed during capture |
| `ignoreRules` | `applied`, or `not_applied` with the git reason, when git couldn't list ignored entries ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.4) |

**Coverage** is the `files` list itself: every path under the declared scope and exclusions, whether or not its content was sent to the model. Comparing a later file list with this one detects additions and removals.

- An **excluded** path is listed with the rule that matched it, and is never opened: it has no hash or size. An excluded directory is one entry, and nothing inside it is listed.
- A **symbolic link** is listed with its target, and is never followed, whether the target is inside the repository root or outside it. It has no hash or size.
- An **ignored** entry is untracked and matched by the repository's ignore rules, as git lists them before capture. A wholly ignored directory is one entry and is not entered, like an excluded directory. An ignored file is listed with its hash and size, but is never sent to the model and never expanded, unless the developer keeps it as a candidate with the `includeIgnored` setting ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.4). The destination, excluded entries and symbolic links are never `ignored`. Without git, ignore rules are not applied: only the default and user exclusions apply, and the inspect summary says so.
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
| `kind` | `lines`; `entry` for evidence that a file exists; or `absence_check` for the file-list check behind an accepted absence claim. Only code creates `entry` and `absence_check` evidence |
| `path`, `fileHash` | `lines` and `entry` only. Must match a `read` or `listed_only` entry in the snapshot |
| `pathGlob`, `unenteredDirectories` | `absence_check` only: the glob after path normalisation, and the directories capture didn't enter that it could reach: shown ones in path order, then withheld ones by hash, in hash order |
| `lineStart`, `lineEnd` | `lines` only. Validated at capture time |
| `excerpt` | `lines` only. The cited lines: at most 40, provisionally, and never truncated, so a citation of a longer range is rejected ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.2, `CIT-010`) |
| `basis` | `documentation`, `code_observation`, `existing_guidance` (§6.4). `entry` and `absence_check` evidence is always `code_observation`, because it only observes the file list ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.4) |

Evidence cited by the model must target lines sent in that call. Evidence created by code without a citation, for known facts ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.5), must come from content verified against the snapshot hash; its excerpt passes the secret scan like any text sent to the model.

Evidence is created by code, never by the model. The model cites a context item, a line range and a verbatim quote. Code verifies the quote against the content actually sent, may correct the line range under a narrow recorded rule, derives the basis from the tier the cited file belongs to, and extracts the excerpt itself ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.2–§3.2.4). A corrected range records both the original and corrected lines. Citations that fail are discarded, and the model call records the failure. A valid citation proves where the quote came from, not that it supports the claim; support is checked separately ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.3).

### 6.3 Finding

One claim about the repository, or one explicit unknown.

| Field | Notes |
|---|---|
| `id`, `findingId`, `snapshotId` | `id` names one revision; `findingId` is stable across revisions |
| `kind` | `claim`, `gap`, or `absence` for an accepted absence claim, whose statement code writes ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.11) |
| `status` | `active`, `withdrawn` or `failed_validation` |
| `withdrawnReason?` | Set when withdrawn, for example `withdrawn_by_model` |
| `revision`, `supersedes?` | The revision number within `findingId`; and the revisions this one supersedes: the previous revision, or, for a replacement, the current revision of every finding it stands for ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1) |
| `statement` | Plain language |
| `mode` | `descriptive` ("tests live under `tests/`") or `prescriptive` ("docs require the generated client") |
| `basis` | Derived from evidence: the set of its evidence's bases (`documentation`, `code_observation`, `existing_guidance`), so a mixed basis has more than one ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.4) |
| `scope` | `repository` or an explicit list of paths |
| `evidenceIds` | Required for `claim` (`lines` or `entry` evidence) and `absence` (one `absence_check`); may be empty for `gap`. Every finding that isn't a gap has evidence |
| `droppedCitations`, `failedCitations` | Model-produced findings only: how many proposed citations failed validation or were merged into an earlier duplicate, and those citations as proposed, with the rules that rejected them ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.5). Shown in the findings view |
| `coverage` | Gaps only, set by code: `inspected`, or `not_inspected` with what wasn't read: the entries the gap's related paths match that weren't sent in full (withheld ones by hash), and the directories capture didn't enter that count: those the paths name explicitly, and those they could reach that may hide project content (unreadable, symbolic links, user exclusions), withheld ones by hash ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.11, §3.3.2). The review shows a `not_inspected` gap as "not inspected", not "missing" |
| `uncertainty` | Short explanation; no numeric confidence score |
| `producedBy` | Model call ID, or `deterministic`: what created the finding, repeated on every revision |
| `revisedBy?` | The model call that appended this revision, when one did; never on a first revision ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1) |

A **gap** records something the product looked for and could not establish, for example: "No test command could be determined for `services/api`", or "Ownership of `shared/` is not documented." A gap may:

- raise a Question;
- appear in the review as an unresolved item;
- block recommendations that would depend on the missing information.

A gap must never be filled by a model assumption.

A finding with status `failed_validation` is an item the model proposed that validation rejected. It is kept with its text as written and the ID of the rule that rejected it, so reviewers can assess errors. It is never current, never shown as a finding and never supports anything ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.3). A withdrawn or replaced finding is kept too, with its status.

Only findings of the active snapshot are current. A finding named by a current `developer_correction` decision is **corrected**: it is shown, marked as corrected, but is not current and supports nothing ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.5).

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
- That an agent configuration file exists is a fact about the snapshot; what it says remains existing guidance, and cannot justify new guidance on its own.
- A gap records what isn't known, so it never supports a recommendation. In the first slice, neither does an absence claim: it supports only its narrow statement, and guidance built on it would state a broader absence that code can't check ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.5).

### 6.5 Conflict

Links findings that appear inconsistent.

| Field | Notes |
|---|---|
| `id`, `conflictId`, `snapshotId` | `id` names one revision; `conflictId` is stable across revisions. Only conflicts of the active snapshot are current |
| `findingIds` | At least two |
| `description` | What disagrees |
| `status` | `unresolved`, `resolved`, `withdrawn`, or `failed_validation` for a proposed conflict that validation rejected |
| `withdrawnReason?` | Set when withdrawn: `withdrawn_by_model`, `member_withdrawn`, `members_merged` (one replacement now stands for several members) or `sources_not_distinct` ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.3) |
| `revision`, `supersedes?` | The revision number within `conflictId`; and the revisions this one supersedes: the previous revision, for changed members, withdrawal or resolution; or, for a replacing conflict, the current revision of every conflict it replaces, since one replacement may stand for several |
| `resolvingDecisionId?` | Set when resolved |
| `producedBy`, `revisedBy?` | The model call that created the conflict, and the one that appended this revision, when one did |

Example: architecture documentation requires the shared client, the existing `CLAUDE.md` says to use `fetch`, and some components bypass the client. The conflict records this without choosing a policy.

An unresolved conflict blocks only the recommendations whose content depends on its resolution. Resolving a conflict never removes its evidence.

Records are never changed in place (§15). When the members of a conflict change, because a member finding is withdrawn or replaced, a new conflict revision with the new `findingIds` supersedes the old one, which is kept for history. A conflict left with fewer than two members, or whose members no longer have distinct sources, is withdrawn instead, with its reason. A withdrawn or superseded conflict is no longer passed to later calls and blocks nothing; only the latest revision of a conflict is current.

Every change to a conflict is a new revision of the same `conflictId`, and the current revision holds its status: a withdrawal is a revision with status `withdrawn` and its reason. A replacement is a new conflict whose `supersedes` names the conflicts it replaces. The validation outcomes map onto these, and `kept` creates nothing ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.5).

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

The parsed destination also records its **line endings**: the number of LF, CRLF and lone CR endings, and the style (`lf`, `crlf`, `cr`, `mixed`, or `none` when there are none). Assembly (§9.3) converts new content to this style. A `mixed` file uses its most frequent ending, ties broken in the order LF, CRLF, CR; `none`, and an absent destination, use LF.

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
| `id`, `questionId`, `revision` | `id` names one revision; `questionId` is stable across status changes |
| `prompt`, `reason` | Wording and why it is asked |
| `findingIds`, `conflictIds`, `gapIds` | What it resolves |
| `options?` | Suggested answers; always presented as suggestions |
| `scope` | `repository` or explicit paths |
| `status` | `open`, `answered`, `skipped`, `unreached`, or `failed_validation` for a proposed question that validation rejected, which is never presented |
| `unreachedReason?` | Set when unreached: `session_ended` or `budget` |
| `producedBy` | Model call ID |

- The session's question budget caps how many questions are asked (default: five). Questions are ranked deterministically: unresolved conflicts first, then gaps about commands or ownership, then other gaps, then observed conventions ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.4). Questions beyond the budget are recorded as `unreached` with reason `budget`.
- `skipped` means the developer chose not to answer. `unreached` means the question was not presented to the developer: the session ended first (`session_ended`), or it ranked beyond the budget (`budget`). Both leave the matter unresolved, and both appear in the export.
- A skipped or unreached question never selects a default. Recommendations that depend on it are withheld; independent recommendations continue.

### 8.2 Decision

| Field | Notes |
|---|---|
| `id` | |
| `statement` | The developer's confirmed intent, in their words or an explicitly accepted wording |
| `scope`, `exceptions` | Scope as above; exceptions in plain language |
| `questionId?`, `conflictId?`, `findingId?` | What it answers. `findingId` is set on a `developer_correction` of a finding, which is then marked corrected and no longer supports recommendations |
| `origin` | `answered_question`, `developer_correction` |
| `actor`, `decidedAt` | |
| `supersedes?` | Corrections create a new decision, which names the one it supersedes |

Choosing a suggested option is a confirmation; the option itself was not one. A decision can establish new guidance that the code does not show; its origin records that, so it is not presented as a discovered fact.

## 9. Proposed configuration

### 9.1 Recommendation Revision

One understandable operation on the target file. Stable `recommendationId`, immutable `revisionId` (the revision's record ID, [`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1).

A revision's `status` is `valid`, `failed_validation`, or `invalidated` with a reason: `revalidation_failed`, `not_reconsidered`, `dropped_by_model` or `target_changed` ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1).

| Field | Notes |
|---|---|
| `operation` | `add`, `revise`, `remove` |
| `kind` | `fact` (describes the repository) or `policy` (states what agents should do). Policy needs a decision or uncontested documented prescriptive support ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.5) |
| `target` | For `revise`/`remove`: `{ blockId, blockHash }` of one captured block. For `add`: an insertion point: `after: { blockId, blockHash }`; `section: { blockId, blockHash }` of the section's heading block; or `newSection: { heading, after? }`, where `after` names a heading block. Code resolves these from block aliases; the model never sees an ID or a hash ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.5) |
| `content` | Proposed wording for `add`/`revise` |
| `rationale` | Why this helps an agent working in this repository |
| `support` | Finding and decision IDs; at least one, satisfying §6.4. Evidence is reached through the findings |
| `references` | Structured references (below) |
| `scope` | `repository` or explicit paths; the scope the instruction describes, even though the file is root-level |
| `producedBy` | The model call that wrote this revision's content, or `developer_edit`. A new revision with new content has its own; an invalidation repeats it, and the call that caused it, if any, is recorded separately ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1) |
| `validationEvents?` | On a `developer_edit` revision, valid or failed, the events of its validation. A model-produced revision's events are on its model call (§13.1) |

**Structured references** list every concrete path, command or named file the wording mentions:

| Field | Notes |
|---|---|
| `kind` | `path`, `command` |
| `value` | As written in `content`, for example `src/lib/api/client.ts`, or `pnpm test` |
| `supportingFindingId` | The finding whose evidence contains the value; it is in the recommendation's `support` |
| `evidenceId` | The first evidence of that finding that contains the value, chosen by code |
| `verification` | Paths: `exists_in_snapshot`, recorded when created. `missing` is derived, never written: a path a later snapshot or the freshness check (§11.1) no longer finds. Commands: `found_not_run` in the first slice |

Deterministic validation runs on every revision:

- every path reference exists in the snapshot;
- every command reference resolves to a manifest script or a documented command in evidence;
- every reference value actually appears in `content`, and no path- or command-like token in `content` is missing from `references`;
- the support satisfies the evidence rules;
- the target block exists and its hash matches.

**Headings.** A `revise` of a heading replaces it with one ATX heading line of the same level. A `remove` of a heading removes its whole **section**: the heading and every block after it up to the next heading of the same or a higher level, or the end of the file. A heading's level is its number of `#`, or 1 for a setext `=` underline and 2 for `-`. It is one recommendation and one change. A heading is never removed on its own.

A revision that fails validation is not shown for selection. It is recorded with status `failed_validation`, its text as written and the rule that rejected it ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.3).

These references are also the basis for later maintenance checks: stale paths and commands are detected by comparing stored references with a new snapshot.

**No dependencies between recommendations.** If two changes only make sense together, they are one recommendation. Two `revise` or `remove` recommendations that target the same block are mutually exclusive, and so are a `remove` of a heading and any `revise` or `remove` of a block in its section, the heading included: accepting one blocks accepting the other, and the reason is shown. Additions are never exclusive: an addition anchored to removed content goes where that content was (§9.3). The system never selects or deselects a recommendation for the developer.

Editing a recommendation's wording creates a new revision with `producedBy: developer_edit`. It is revalidated and must be selected again.

### 9.2 Recommendation Selection

The current selection is **one per stable `recommendationId`**, pointing at one exact revision.

| Field | Notes |
|---|---|
| `recommendationId`, `revisionId` | |
| `state` | `pending`, `accepted`, `rejected` |
| `actor`, `selectedAt` | |

Selecting a new revision replaces the previous selection for that recommendation. Selection history is retained. A selection, accepted or rejected, counts only while the revision it names is current: when a regeneration or an edit creates a new revision, the recommendation is pending again, without any selection being written for the developer (§12). A recommendation with no current revision, such as an invalidated one, is not shown for selection. Rejecting a proposed addition never removes similar existing guidance; removal happens only through an accepted `remove` recommendation.

**Clashes.** Exclusion is checked when a recommendation is accepted, on targets resolved in the active snapshot (§12). A refresh can still re-anchor two accepted recommendations so that they exclude each other, and a hand-edited session can hold such a pair. Code derives every such **clash** from the current accepted selections, with the same rules and reasons as accepting, and writes nothing. While a clash exists, final review is blocked and the CLI names the pair; the developer rejects one. Assembly is never given a clashing set. A clash is not a load error.

### 9.3 Assembly

Assembly is application code, not a model call.

1. Start from the captured destination blocks (or an empty document if `absent`).
2. Resolve each accepted revision to a **position** in the original file, and, for an addition, an **anchor**:
   - `revise` and `remove`: the target block; for a `remove` of a heading, its whole section (§9.1).
   - `add` with `after`: directly after the named block, which is the anchor.
   - `add` with `section`: after the section's own blocks, before its first subsection heading. The anchor is the last of those blocks, or the heading if it has none.
   - `add` with `newSection` and `after`: after the named heading's whole section, subsections included, at the heading's level. The anchor is the section's last block.
   - `add` with `newSection` and no `after`: at the end of the file, at level 2. The anchor is the file's last block, if any.
   An anchor that an accepted `remove` deletes keeps its position: the addition goes where the block was, or, for an anchor inside a removed section, where the section was.
3. Apply accepted revisions in a deterministic order: by position in the original file; at one position, a `revise` or `remove` of the block before any addition after it, and other additions before `newSection` additions, so an addition never lands under a new section's heading; then by the `seq` of each recommendation's first revision. IDs carry no order ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.4.1).
   - `revise` replaces the target block's bytes with the new content.
   - `remove` deletes the target block, or the whole section. Consecutive removed blocks, from one revision or several, are deleted as one run: from the start of the run's first block to the start of the next remaining block. When no block remains after the run, the deletion runs from the end of the last remaining block before it to the end of the run's last block, so the bytes after the last block are kept. When no block remains at all, only the byte order mark, if any, and those trailing bytes are kept.
   - `add` inserts content at its position. A `newSection` addition creates its heading: `#` repeated for its level, a space and the heading text, trimmed of spaces and tabs, followed by one blank line and the content.
4. **Separators and line endings.** Untouched blocks keep their original bytes, including the separators around them. Inserted content is separated from its neighbours by a copy of the separator between its anchor and the block after the anchor in the original file, so a loose list stays loose. A removed anchor keeps its place in the separators: the separator before it stays with the untouched block before it, and the inserted content is followed by the separator after the removed run that contains the anchor, before the next remaining block. So removing `B` from `A s1 B s2 C` and adding `X` after `B` gives `A s1 X s2 C`, and an addition anchored inside a removed section is followed by the separator that followed the section. When there is no such block, as at the end of the file, or no anchor, as in an empty or absent file, the separator is one blank line, or one line ending between a list item and the list item it follows. Content keeps its own separators between its blocks. Every line ending in new content, including a rendered heading, is converted to the file's style (§7). A new file ends with one line ending. In a present file with no blocks, new content goes after the byte order mark, if any, and before the file's other bytes, with one line ending between them unless those bytes start with one; an empty file ends with one line ending.
5. Serialise.
6. Verify:
   - every changed, inserted or removed block maps to exactly one accepted revision;
   - every accepted revision produced exactly one change; removing a section is one change spanning its blocks;
   - untouched blocks are byte-identical to the original, and in their original order;
   - unless the destination's round trip failed (below), the assembled file parses, with a verified round trip (§7), into the untouched blocks and the new blocks, with the types validated for each revision. Block IDs are not compared, because an insertion shifts the ordinals after it.
   - when the destination's round trip failed (§7), this check replaces the reparse above. Only a new section at the end is possible. It is appended after one blank line, with a line ending first if the file doesn't end with one, and the file ends with one line ending. The original bytes must be an unchanged prefix of the result, and the appended bytes, parsed alone, must give the new section's blocks.

If any check fails, assembly fails and no artifact revision is created. The resulting file may read as slightly stitched together. That is the intended trade: every line of change is attributable.

### 9.4 Artifact Revision

| Field | Notes |
|---|---|
| `id`, `revision` | Immutable. `revision` numbers the session's artifact revisions from 1 |
| `snapshotId` | |
| `targetPath` | |
| `original` | `absent`, or hash (bytes are in the snapshot) |
| `proposedContent`, `proposedHash` | The content is in a content-addressed file (§15) |
| `selectedRevisionIds` | Accepted recommendation revisions used |
| `decisionIds` | Current decision versions those revisions depend on |
| `attribution` | One entry per change, in file order: the recommendation revision; the operation; for a `revise` or `remove`, the original block, with one entry per removed block of a section; and for new content, its byte span in the proposed content (§9.3). The entries of a run of removed blocks stay together, followed by the additions placed where the run was |

If assembly fails, no artifact revision is created. When every accepted revision passes assembly alone but some cannot be combined, such as an indented code block that would merge into a list item added before it, the failure is a conflict between the revisions involved: the developer is asked to reject one ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §2.7). Code finds them deterministically: it adds the accepted revisions one at a time in the order of §9.3, and names the first whose addition makes the checks fail, together with the revision whose block it merges into or breaks: the first earlier revision whose removal lets the rest pass. After a refresh, every current revision is checked alone again, with its target resolved, whether or not it was re-anchored, and, if it fails, invalidated as `target_changed` (§12), so failing alone is never a conflict. Any other failure is reported as an internal error. An accepted revision whose support is no longer current, because the regeneration that should follow the change failed or hasn't run (§12), is never assembled: nothing is created, and code names those revisions, so the developer can reject them, or regenerate, and propose again. If no revision is accepted, no artifact revision is created, and the session can complete as `no_change`. The diff shown at review is computed from the original and proposed content; it is not stored as a separate record.

## 10. Review

| Field | Notes |
|---|---|
| `id`, `artifactRevisionId`, `contentHash` | |
| `outcome` | `approved`, `rejected` |
| `actor`, `reviewedAt`, `comment?` | |

The review screen shows the full proposed file, the diff from the original, and, for each change, its recommendation, rationale and support. It also lists unresolved gaps, conflicts and skipped questions.

An approval is usable only while all of these hold:

- its artifact revision is the active one;
- it is the latest review of that artifact revision, so a later rejection withdraws it;
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

Comparing the rescan with the snapshot:

- A path is **added** or **removed** when only one of them lists it, and **changed** when both do and its content differs: its hash, for an entry that has one; its target, for a symbolic link; otherwise its status or kind. A file that becomes unreadable has changed. The same bytes under another hashed status are unchanged. If the rescan is unstable (§6.1), every path it names has changed, whatever its hashes.
- The **findings supporting** a selected revision are its `finding` support, and the findings its decision support covers: those its question resolves, directly or through a conflict, and the members of its conflict, as in §12. Their `lines` and `entry` evidence gives the cited files. Their scopes are a claim's `scope`, a gap's related paths and an absence claim's glob. A scope path covers a path it matches and everything under a directory it matches, with the glob rules of [`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.11.
- A **path reference** no longer exists when the rescan doesn't list it, as a file or as a directory holding one, after the path normalisation `REF-002` uses.
- The destination is checked only by the first blocking rule. A warning lists every changed, added or removed path that no blocking rule names, in bytewise order.

This keeps application safe without blocking a developer who is editing unrelated files. Narrowing the blocking rules further requires evidence from use.

### 11.2 Apply Attempt

| Field | Notes |
|---|---|
| `id`, `applyAttemptId`, `artifactRevisionId`, `reviewId` | `id` names one revision; `applyAttemptId` is stable across states |
| `expectedOriginal` | Hash or `absent` |
| `intendedHash` | |
| `resultHash?` | The destination's hash after the write, recorded with `succeeded` |
| `freshness` | Result of §11.1, including acknowledged warnings |
| `state` | `started`, `succeeded`, `blocked`, `failed`, `recovery_required`. `blocked` is the only revision of an attempt whose freshness check blocked |
| `error?`, timestamps | `startedAt`; `endedAt`, unknown when recovery records it |

Procedure:

1. Resolve the destination inside the repository root; reject path traversal and symlinked destinations. Refuse while an earlier attempt is still `started`: recovery runs first.
2. Confirm a usable approval (§10).
3. Run freshness checks (§11.1). If they block, record the attempt as `blocked` and stop; nothing is written. A warning waits for its acknowledgement.
4. Persist the attempt as `started`.
5. Write the approved bytes to a temporary file in the same directory, named `.CLAUDE.md.<applyAttemptId>.tmp`; a file already there isn't this attempt's and is left alone. Re-check the destination hash, then rename over the destination (or create it, if `absent`).
6. Hash the destination and record `succeeded`, or `failed` with the reason.

A session lock prevents two instances of this CLI from operating on one session. It cannot stop other editors, which is why step 5 re-checks the hash.

**Recovery** for a `started` attempt found on resume. First remove the attempt's temporary file, if it is there; then:

| Destination now | Action |
|---|---|
| Matches the intended hash | Record `succeeded`; do not write again |
| Matches the expected original | Record `failed` with the reason `interrupted_before_write`. A retry is a new apply attempt, which confirms a usable approval and runs the freshness checks again |
| Matches neither | Record `recovery_required`; report a conflict |

## 12. Change propagation

Currency is determined by the versions of dependencies, not by timestamps.

| Change | Consequence |
|---|---|
| Decision answered, corrected or superseded | Recommendations whose support includes a changed or superseded decision, a finding that is no longer current, or a finding that the decision's question or conflict covers, are regenerated as new revisions. Their selections no longer count, so they are pending again (§9.2). The active artifact becomes outdated. A new decision that affects no recommendation calls the model only if it unblocks a held-back entry ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.3.6). |
| Recommendation edited | New revision; selection required |
| Selection changed | New assembly and artifact revision; fresh review required |
| Blocking freshness failure | New snapshot; affected findings refreshed; recommendations revalidated or regenerated; new review |
| Destination changed | New snapshot with re-parsed blocks. A target resolves to the block with the same ID and hash, otherwise to the only block with that hash; this re-anchoring is derived, never written. A revision whose target resolves to no block, or that no longer passes the content checks alone with its target resolved, re-anchored or not, is invalidated by code (`target_changed`), and the next regeneration's summary names it; it is not sent for reconsideration. |
| All recommendations rejected | Session completes as `no_change` |

In the first slice, invalidating the whole proposal is acceptable wherever the narrower impact cannot be established reliably.

## 13. Supporting records

### 13.1 Model Call

| Field | Notes |
|---|---|
| `id`, `modelCallId`, `purpose` | `id` names one revision; `modelCallId` is stable from start to end. Purpose: `analyse`, `analyse_expansion`, `generate_questions`, `recommend`, `regenerate_recommendations` |
| `validatorVersion`, `detectorVersion` | Validation rules and reference detector in force ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.4–§3.5) |
| `validationEvents` | Every rejection, correction and relabelling, with stable rule IDs; no source content |
| `aliases` | The call's alias table: each alias and the record, item or block it stands for ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.1) |
| `requestedModel`, `returnedModel?` | |
| `promptVersion`, `schemaVersion`, `schemaHash` | `schemaHash` is the SHA-256 of the JSON Schema sent ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.7) |
| `inputManifest` | Snapshot ID and hashes of included files and excerpts; excluded files listed; no source content |
| `state`, `attempt`, `retryOf?` | `started`, `completed`, `failed` or `interrupted`; each retry is its own call, linked to the previous attempt |
| `retainedInputRef?`, `retainedResponseRef?` | Content-addressed references to the exact request and response bodies, for replay, when `retainModelInputs` is on ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.12) |
| `budget` | Limits applied to this call |
| `usage` | Input, output and cached tokens where available |
| `cost?`, `costBasis` | `reported`, `estimated`, or `unknown`. Unknown is never recorded as zero |
| `estimatedCost` | The estimate checked against the budget before sending; used for the budget when the cost is unknown, never reported as cost |
| `counts` | Proposed (unknown after a schema failure), accepted, corrected, relabelled, and rejections by rule; for `analyse` and `analyse_expansion`, the corrected-citation rate and citations proposed ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §3.2.2, §3.5) |
| `startedAt`, `endedAt`, `durationMs` | `endedAt` and `durationMs` are unknown, with a reason, for an interrupted call |

A call still `started` when its session is resumed was interrupted: the process holding the session lock records it so, with its end, usage and cost unknown, never zero ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.6). Every model-produced record carries `producedBy`, linking each finding, question and recommendation revision to the prompt and schema version that created it. Calls stop when the session's generation budget is reached. The session then continues with whatever is validated, and records the reason.

### 13.2 Effort Interval

Active developer effort is recorded separately from elapsed generation time.

| Field | Notes |
|---|---|
| `id`, `effortIntervalId` | `id` names one revision; `effortIntervalId` is stable from open to closed |
| `enteredAt`, `leftAt` | Period with status `awaiting_user` |
| `stage` | Which stage the developer was working on |

An interval is recorded as open when the prompt is shown and closed when it is answered. One still open when its session is resumed was interrupted: its end is unknown, and active effort is then reported as a lower bound with the number of interrupted intervals. One still open while another live process holds the session is in progress, and also makes the effort a lower bound, counted separately ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.6).

Active effort is the sum of these intervals. This is an approximation: a developer may step away while the tool is waiting. The CLI allows a manual correction, recorded with a reason. The export states which method produced the number.

## 14. Export

A versioned projection generated from session records. It is never edited directly. It maps to the handoff's suggested session export:

| Handoff section | Source records |
|---|---|
| Identity | Session ID, timestamps, `productVersion`, `adapter`, `outputScope` |
| Inputs | Snapshot identity (git metadata as recorded, including `unknown` states and their reasons; file hashes, scope, exclusions), initial destination state and hash, `generationConfig`, prompt and schema versions |
| Reasoning evidence | Findings (claims, absence claims and gaps), evidence references and excerpts, conflicts, questions with every status, decisions including superseded ones, items that failed validation |
| Review | All recommendation revisions, including those that failed validation or were invalidated; held-back entries; selection history, rejected selections included; developer edits; reviews |
| Outputs | Final diff, artifact revisions, applied file list, final configuration hash, unresolved gaps, conflicts and questions |
| Measurements | Elapsed time, active developer effort and its method, model usage and cost with `costBasis`, explicit reasons for missing values |
| Outcome | Session `outcome` and `completeness`, mapped to completed, partial or failed; apply attempts and failure details |

The export always states whether its artifact content is proposed, approved or applied. It includes the findings, conflicts, questions and recommendation revisions that failed validation, with their text and rules. It contains no credentials and no source content beyond cited excerpts. Including excerpts, and the quotes in items that failed validation, is a visible export option, off by default, because they may be sensitive. The format and the mapping to the evaluation requirements are in [`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.10.

## 15. Persistence

- Sessions live outside the repository, under the XDG data directory: `$XDG_DATA_HOME/ai-environment-architect/sessions/<id>/`, or `~/.local/share/ai-environment-architect/sessions/<id>/` when `XDG_DATA_HOME` isn't set. One product environment variable overrides the location. The data-notice state lives there too. A storage directory inside the target repository, by any route, is refused before anything is read or written ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.2).
- Each session is one versioned JSON file of appended records, plus content-addressed files for the destination's original bytes and each artifact revision's content.
- Writes use temporary files and atomic rename. A lock file prevents two CLI processes from opening one session.
- Load validates the schema version and all internal references. Unsupported versions are rejected with a clear message. Until v0.1.0 there are no migrations: a session in an older format is refused, and the developer starts a new one ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §4.9).
- Revisions are appended, never mutated. No event-sourcing framework is needed.
- Exact model request and response bodies may be retained in the session directory, for replay, under the `retainModelInputs` policy ([`IMPLEMENTATION_SPEC.md`](IMPLEMENTATION_SPEC.md) §1.12). They are excluded from exports by default, deleted with the session, and can be purged separately. The snapshot itself still stores no full source content.

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
- Assembly converts new content to the file's line endings, keeps list markers, and copies separators, so a loose list stays loose; the assembled file parses back into the expected blocks.
- Removing a heading removes its whole section as one change, and an addition anchored to removed content goes where that content was.
- Two recommendations revising or removing one block, or one removing a section and one revising or removing a block in it, cannot both be accepted.
- Changed decisions, selections or content invalidate earlier approval.
- Freshness blocks relevant changes, warns on unrelated ones, and records acknowledgement.
- Absent and empty destinations are distinguished.
- An interrupted apply recovers without repeating the write.
- `no_change` performs no write.
- Unknown cost is never exported as zero.
- Every model item that fails validation is kept with its text and rules, and never treated as current.
- The export distinguishes proposed, approved and applied content, and its hashes match the session.

## 18. Remaining implementation choices

- Default exclusion patterns and snapshot size limits.
- Excerpt length limit.
- Context selection for model calls: which files and excerpts are sent within the budget. It must be deterministic and recorded in each call's `inputManifest`.
- CLI interaction for answering questions, editing recommendation wording and reviewing the diff.
- Handling of unsupported encodings.

Resolve these in the implementation specification without expanding the first slice to multiple repositories, other configuration files or a general policy engine.
