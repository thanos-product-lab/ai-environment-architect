# Implementation Specification

**AI Environment Architect · AI Product Studio**  
**Date:** 1 November 2026  
**Version:** 0.39  
**Status:** Proposed specification. Sections 1–4 are proposed.

### Changes from v0.38

- **Retained model exchanges (§4.8, §4.9).** `purge-inputs` saves the `inputs_purged` record, which holds only the envelope, before it deletes `inputs/` and `responses/`, so a crash in between leaves a session that loads. Check 7 also requires a call's `retainedInputRef` to equal its input manifest's, both references to be `null` with `retainModelInputs` off, and the request reference to be set with it on. A purge "comes after the call" when it follows the call's first revision for the request, and the revision that added the response for the response. A retained file that is still there is checked even after a purge.

### Changes from v0.37

- **Load checks (§4.4.1, §4.9).** Each revisable type lists the fields a revision may change, and check 3 rejects a revision that changes, adds or drops any other field; a `generation_config` revision changes only the budget, with the reason `budget_raised` or `budget_confirmed`. Check 4 covers a model call's `inputManifest.snapshotId`, and requires `retryOf` to name a call with the same purpose and the previous attempt. Check 5 allows at most one current effort correction: each later one supersedes it.

### Changes from v0.36

- **Model calls and effort (§4.6).** `CallBudget` is defined: the limits in force and the spend the check counted, cost and tokens, each a total that may be unknown with its known parts. Unknown token usage makes the token check impossible, as an unknown cost estimate does. Raising or confirming the budget appends a `generation_config` revision, with the reason `budget_raised` or `budget_confirmed`, which settles the unknowns before it; a settled call counts its known parts, and any other revision settles nothing. On resume, the `interrupted` session state has status `ready` (§4.9). An effort interval in progress in a session a live process holds makes active effort a lower bound, with `inProgressIntervals`. An `interrupted` call's end, duration, usage and cost are unknown in the file too, and an interval's `leftAt` is never before its `enteredAt` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.24).

### Changes from v0.35

- **Storage location (§4.2).** A relative `$AI_ENVIRONMENT_ARCHITECT_HOME` is refused, not ignored, and an empty variable counts as unset. The storage check uses the native real path, which gives the file system's letter case, and resolves a storage directory that doesn't exist yet through its deepest existing ancestor.
- **Atomic writes, the lock and the data notice (§4.7, §4.9).** A save runs the load checks on what it is about to write and refuses a session that wouldn't load. A save also refuses a header naming another session, and syncs each new directory's parent. The lock is created through a hard link from a synced temporary file, so it never appears empty; a file system that refuses hard links stops the process with a message naming the storage directory, with no fallback. Only `init` creates a session directory. A process that may not be signalled counts as running; an unreadable lock is held by an unknown owner and isn't stale; a stale lock is moved aside and removed only if it is the one reported, otherwise put back; a signal is raised again after the lock is removed. An unreadable `notices.json` reads as no confirmations.

### Changes from v0.34

- **Load checks (§4.9).** Check 1 also rejects a file that isn't UTF-8 JSON, such as a truncated one. Check 5 also rejects superseding a revision whose status isn't current, such as a withdrawn finding, which the record log already refuses (§4.4.1). Check 7 also compares the destination's `hash` with its content. The schema (check 2) enforces how many evidence records a finding has; check 6 checks their kinds. A format refusal from a file that doesn't say which version wrote it names "an unknown version" and asks to update to the latest version.

### Changes from v0.33

- **Which records have `revisedBy` (§4.4.1).** Only findings and conflicts: they are the only records a model call revises. Decisions and selections record the developer as `actor`; questions change by the developer's answer or skip, or are marked unreached by code ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.23).

### Changes from v0.32

- **Expansion settings (§4.4.1).** `generation_config` records `maxExpansionRequests`, `expansionBytes` and `expansionEntryBytes` (§1.8, §1.14), outside `settingsHash`, which covers the initial context only ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.22).

### Changes from v0.31

- **IDs (§4.4.1).** An ID is a prefix, `_` and an opaque suffix from the injected `IdSource`, not necessarily a ULID: order comes from `seq`, never from IDs.
- **Who revised a record (§4.4.1, §4.5).** A revision appended by a model call records that call in `revisedBy`; `producedBy` stays the call that created the lineage. `revisedBy` is never repeated from the revision before ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.21).
- **References (§4.4.1).** The alias table's `F` and `C` targets are record IDs: the revisions sent. A new row in the references table, so load check 4 covers them.
- **Content notices (§4.4.1).** The record's fields: `snapshotId`, `modelCallId`, the `item` alias, and the `path`, `fileHash`, `lineStart` and `lineEnd` code resolves it to, with the `description`.
- **Failed records (§3.5, §4.4.3).** `rejectedBy` holds the one rule that rejected the item: an item stops at its first rejection. Failed sub-items, such as citations, are in the validation events and in `proposed` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.21).
- **Unentered directories (§4.5).** An `absence_check` lists the shown directories in path order, then the withheld ones in hash order, so a hash's place says nothing about the hidden name.

### Changes from v0.30

- **Persistence and export (§4, new).** The storage directory, never inside the target repository; the session file; record and lineage IDs, revisions, superseding and which references name which; every record type and how it changes; derived state, completeness and current records; items that failed validation, kept with status `failed_validation`; conflict and finding revisions and corrected findings; `absence_check` evidence; model-call revisions, interrupted calls and the budget with unknown costs; effort as a lower bound; atomic writes and the lock; retained exchanges; schema versions, with no migrations before v0.1.0, and load checks; the export, with its mapping to the Evaluation Requirements and to completed, partial or failed ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.20).
- **Basis of file-list evidence (§3.2.4).** `absence_check` evidence is `code_observation`, as `entry` evidence is.
- **Retained responses (§1.12).** Response bodies are retained with request bodies, under `retainModelInputs`, for replay only. `purge-inputs` and `delete` remove both (§2.2). The manifest example's retained input is `.json` (§1.13).
- **Failed items persisted (§3.5).** Every item rejected at the item or cross-item stage becomes a record with status `failed_validation`, its text as written and its rule IDs (§4.4.3). Validation events still hold no response text.
- **Current support (§3.3.5, §3.3.6).** `REC-001` also refuses support that the developer corrected or that belongs to an earlier snapshot, and a corrected finding puts its recommendations in the regeneration affected set.
- **Content notices (§3.3.2).** Recorded as their own records referring to the snapshot, not on the snapshot.
- **Session errors (§2.12).** Separate rows for a session saved by a newer version and one saved in an older format.
- **Export command (§2.2).** `--out <dir>`, which refuses a path inside the repository.

### Changes from v0.29

- **Basis of entry evidence (§3.2.4, §3.2.5).** `entry` evidence is always `code_observation`, whatever tier the file belongs to: it only observes that a file exists. A known fact about agent configuration is therefore `code_observation` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.19). `algorithmVersion` is `context-select/1.7.0`, because the rendered known facts change (§1.13).

### Changes from v0.28

- **Withdrawn reasons (§3.3.3).** The values use underscores, as `members_merged` does: `withdrawn_by_model`, `member_withdrawn`, `members_merged` and `sources_not_distinct` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.18 §6.5). They will be stored on conflict records, so they are settled before persistence.
- **Validator (§3.5).** `validatorVersion` is `validate/0.12.0`: the same response records the renamed reasons.

### Changes from v0.27

- **Tree markers (§1.6).** `[L]` marks a `listed_only` file too large to excerpt, which a line-range `read` can still fetch; the new `[N]` marks one that holds a NUL byte or isn't valid UTF-8, which is never sent (`EXP-001`, §1.8). `algorithmVersion` is `context-select/1.6.0`.
- **Conflict outcomes (§3.3.3).** `analyse_expansion` validation returns an outcome for every call-1 conflict: `kept`, `revised` with its new members, `replaced` by a new conflict, or `withdrawn` with its reason. A conflict that falls below two members only because one replacement stands for several of them is withdrawn with the reason `members_merged` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.17 §6.5). A response that fails the schema keeps every call-1 conflict. The call-1 records must be given in alias order.
- **Validator (§3.5).** `validatorVersion` is `validate/0.11.0`: the same response now records different conflict outcomes, so results under the two versions differ.

### Changes from v0.26

- **Ranking (§3.3.4).** Class 1 counts only unresolved conflicts. A question resolving only a resolved conflict and a qualifying finding ranks by the finding.
- **Conflict member changes (§3.3.3).** Any change to a call-1 conflict's member set runs `CONF-001` and then `SUP-005`, not only a replacement. A conflict that passes is revised by a new conflict revision that supersedes the old one ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) v0.16 §6.5).
- **Revision keys (§3.3.3, §3.5).** Revisions are named by position, `revisions/<n>`, so two revisions of one target can be told apart.
- **Call-1 records (§3.3.3).** `analyse_expansion` validation takes every call-1 record as a required input, with its kind and `producedBy`, matching the alias table exactly. Records code produced are always passed forward, so `DUP-001` drops a new gap that restates a deterministic one. `DUP-001` compares new gaps and absence claims with call-1 ones too. A conflict member naming a gap or an absence claim fails `ALIAS-003`. `REV-002` covers every record code produced, deterministic gaps included. One replacement may stand for more than one target.
- **`listed_only` reads (§1.6, §1.8, §1.15).** A file `listed_only` because it is too large needs explicit line ranges (`EXP-006`, new). One `listed_only` because it holds a NUL byte or isn't valid UTF-8 is never readable (`EXP-001`). The `[L]` legend and the passages on range reads say so.
- **Corrected-citation rate (§3.2.2).** The denominator is the citations that reached the citation check; citations proposed are recorded as a separate count.
- **Validator (§3.5).** `validatorVersion` is `validate/0.10.0`, for `EXP-006` and the changes above.

### Changes from v0.25

- **Static expansion checks (§1.8).** Stated as rules: `EXP-001` (each read path is a `read` or `listed_only` entry that is not withheld by name or blocked by its content, after the path normalisation of §1.11), `EXP-002` (a range starts after it ends), `EXP-003` (the request adds nothing the initial context didn't send), `EXP-004` (a search glob is well formed, under a scope root by its literal leading segments, and matches a searchable file directly or through a directory) and `EXP-005` (a search literal is line-safe text). The byte budget and execution stay with the expansion protocol.
- **`LIMIT-002` (§1.8, §3.3.4, §3.5).** New rule for items beyond a session limit: expansion requests beyond `maxExpansionRequests`, in response order, and questions ranked beyond twice the question budget.
- **Duplicates (§3.3.2).** A normalised statement is defined: NFC, every run of `White_Space` replaced by one space, trimmed, case kept. Two scopes are the same when both are `repository`, or both hold the same set of normalised paths. `DUP-001` extends to gaps (same statement, `gapType` and set of related paths) and absence claims (same normalised glob). `DUP-002` is a finding with a known fact's statement and scope.
- **Duplicates before conflicts (§3.3.2).** The duplicate rules run before `CONF-001`, and a reference to a dropped duplicate is redirected to the item kept, so a conflict of `f1` and its duplicate `f2` has one member and fails `CONF-001`. Members count once each.
- **Content notices (§3.3.2).** An unknown item fails `CIT-001`, as a citation does; an alias of another kind, or a local key, fails `ALIAS-003`. Step 2 leaves notice items to step 10.
- **Revisions (§3.3.3).** An `F` target is replaced only by an `f` key and a `C` target only by a `c` key (`ALIAS-003`). A second revision of the same target is rejected (`REV-003`). A replacement takes the replaced finding's place in every conflict that listed it, and `SUP-005` is checked again on such a conflict. New findings are also compared with the call-1 findings still passed forward (`DUP-001`). The cross-item order is `DUP-002`, `DUP-001`, `REV-003`, `CONF-001`, `SUP-005`, `REV-001`.
- **Questions (§3.3.4).** Validation runs first, then ranking of every valid question, then `LIMIT-002` beyond twice the budget, then the cut at the budget. A documented finding in an unresolved conflict is contested, so `Q-001` accepts it. A finding whose basis includes `documentation` is documented. `resolves` sets compare as sets.
- **Event order (§3.5).** Cross-item events follow the order the call's checks run, which the call sections state, not the order of rule IDs.
- **Validator (§3.5).** `validatorVersion` is `validate/0.9.0`, for `LIMIT-002`, `EXP-001` to `EXP-005`, `CONF-001`, `DUP-001` to `DUP-003`, `REV-001` to `REV-003` and `Q-001`.

### Changes from v0.24

- **Path normalisation (§1.11).** One rule for every path the model writes, in path fields (scope paths, gap `relatedPaths`, absence-claim `pathGlob`s) and as tokens in text (`SUP-001`, and the reference detector when it is built): one leading `./` and one trailing `/` are removed, and a path with a `..` segment names nothing. An absence claim on `./src/a.ts` is therefore rejected by `ABS-001` when `src/a.ts` exists.
- **Dot names (§1.11).** `*` and `**` match names that start with a dot.
- **Directories matched by a glob (§1.11).** A directory a glob matches covers everything under it, as a directory named without wildcards does, so `src/*` reaches `src/a/b.ts`.
- **`SCOPE-001` (§1.11).** A scope path or glob is accepted when it matches at least one listed path that is not withheld. Uncovered paths don't satisfy it.
- **Directories capture didn't enter (§1.11).** Defined exactly: symbolic links, and excluded, wholly ignored or unreadable entries that are directories or symbolic links.
- **`ABS-002` (§1.11).** Stated exactly: the glob's leading wildcard-free segments start with such a directory's, and the glob has segments beyond it. Accepted wording is fixed, including withheld directories and ignore rules not applied.
- **`ABS-003` (§1.11).** New rule: an absence-claim `pathGlob` holding a backtick, whitespace, a control or format character, or a `..` segment is rejected before the file list is consulted, because code copies the glob into the claim's statement.
- **Gap coverage (§1.11).** A related path that names a directory capture didn't enter, or a path under it, makes the gap `not_inspected`. A glob that only could reach one does so only when the directory may hide project content: unreadable entries, symbolic links and user exclusions, not default exclusions or ignored directories. So a `**/README.md` gap stays "missing" past `node_modules/`. Such a directory is recorded once, among the directories. Accepted absence wording still names every directory the glob could reach.
- **Sent in full (§1.11).** Every item of a file must agree on its line count. An empty file sent as an item is sent in full.
- **Validator (§3.5).** `validatorVersion` is `validate/0.8.0`, for `SCOPE-001`, `GAP-001`, `GAP-002`, `ABS-001`, `ABS-002` and `ABS-003`, and the path normalisation of path fields. `validate/0.7.0` was a draft of this version and was never released.
- **Analyse validation (§3.3.2).** Step 4 states `SCOPE-001` as §1.11 does, and step 6 includes `ABS-003`.
- **Reference detector (§3.4).** Uses the path normalisation of §1.11.

### Changes from v0.23

- **Known-facts section (§3.2.5, §1.3).** Known facts are rendered as their own section, first in the context, within `knownFactsBytes` (provisionally 10,000, at least the 40-byte frame) inside `initialContextBytes`. The context's gaps are ordered: selection, extraction, budget. Facts are tried in order and one that doesn't fit is left out; a deterministic gap says how many. The section is covered by `contextHash`.
- **Budget (§1.5, §1.14).** `initialContextBytes` is 310,000, so the tier caps are unchanged. The tier caps and `knownFactsBytes` together may not exceed it.
- **Token check (§1.10).** The known-facts section is never removed.
- **Input manifest (§1.13).** A `knownFacts` entry records the cap, bytes used, and facts sent and left out. `manifestVersion` is 2 and `algorithmVersion` `context-select/1.5.0`.
- **Aliases (§3.2.1).** `F` aliases appear in calls 1–5; the known facts sent are numbered first. In call 1 no field accepts them (`ALIAS-003`).
- **Test fixtures (§3.8).** Verification items for the known-facts section.
- **Inspect (§2.4).** The summary has a known facts row.
- **Provisional values (§3.9).** `knownFactsBytes`. **Open points:** which known facts calls 2–5 number first.

### Changes from v0.22

- **Test fixtures (§3.8).** Verification items for evidence basis and known facts.
- **Open points (§3.9).** U+2028 and U+2029 in command names, the justfile `private` word test, and justfile multi-line strings.
- **Known facts (§3.2.5).** Defined in full: which manifests and entries give facts, how commands are read from each format, the code-generated wording, scope, order, import resolution order and evidence. Existence facts carry `entry` evidence ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.2). Package-level manifests are read only in declared workspace members. A manifest that can't be read or parsed, and a fact that matches the secret scan, each give a deterministic gap.

### Changes from v0.21

- **Evidence basis (§3.2.4).** A file's tier for basis is the first tier whose patterns match it, and tier 1 only when no pattern matches and an import resolves to it, as §1.5 already selects. An import counts when it resolves to a `read` or `listed_only` entry. Selection still ignores imports that aren't candidates (§1.5), and a `listed_only` file is never read, so its own imports are not followed.
- **Open points (§3.9).** Documentation outside the tier 2 locations is `code_observation`.

### Changes from v0.20

- **Path tokens (§1.11).** A path written in model text, in a statement or in recommendation content, is matched against the file list after removing one leading `./`; `../` is never resolved. Defined once in §1.11, used by `SUP-001` now and by the reference detector and `REF-002` when they are built (§3.4). Excerpt and quote matching stay exact.
- **`SUP-005` (§3.2.3).** Every member finding must cite at least one file that not every other member cites, so no side rests only on shared sources. Removed from the open points (§3.9).
- **`SUP-002` (§3.2.3).** Any Unicode decimal digit (`Nd`) is a number, matched as written, not only ASCII digits.
- **Open points (§3.9).** The `SUP-002` line no longer mentions non-ASCII digits. Added: substring matching of path tokens in excerpts, and whether `./…` in recommendation content is a path or a command.
- `validatorVersion` is `validate/0.6.0`, because all three change what is accepted.

### Changes from v0.19

- **Support checks (§3.2.3).** The rules apply to finding statements, after provenance, on the evidence of accepted citations. Tokens, numbers and words are defined exactly, and the word lists are stated in full. Inline code and path-like tokens are checked only by `SUP-001`, not by the word and number tests. `SUP-005` counts distinct files, not items, because a context item and an expansion item can be the same file.
- **Provisional values (§3.9).** The `SUP-002` word lists.
- **Open points (§3.9).** Whether `SUP-005` should require each side of a conflict to have a source the other lacks, and counts the `SUP-002` lists miss.
- `validatorVersion` is `validate/0.5.0`.

### Changes from v0.18

- **Corrected-citation rate (§3.2.2).** Defined as `CIT-R01` events divided by citations proposed, per call, regardless of later merges or of the finding being rejected. Merged duplicates are the `CIT-009` entry of the rejections by rule. The rate is unknown, with a reason, when the response failed the schema or proposed no citations.
- **Provisional values (§3.9).** §3.9 is the single list of everything marked provisional, to calibrate against real responses in M6.

### Changes from v0.17

- **Duplicate citations (§3.2.2).** A citation with the same path and final range as an earlier accepted citation of the same finding is merged into it, with the new rule `CIT-009`. Overlapping but different ranges stay separate.
- **Uncounted characters (§3.2.2).** Provisional: format characters and combining marks (Unicode `Cf`, `Mn`, `Me`) don't count towards `CIT-007`'s minimum or its punctuation test, but must still match exactly.
- **Range length (§3.2.2).** Provisional: a final range longer than 40 lines is rejected, with the new rule `CIT-010`. Excerpts are never truncated.
- **Delimiter escape (§1.6).** The wording states the algorithm exactly, with examples, and a property test checks that reversing the escape gives back any text.
- **Unicode version (§3.5).** The test that pins the rule list also pins the runtime's Unicode version, so a Node upgrade that changes it fails until `validatorVersion` increases.
- **Event order (§3.5).** Within an item, a sub-item's events are in sub-item order, each sub-item's in rule order. This states what the pipeline already did.
- `validatorVersion` is `validate/0.4.0`.

### Changes from v0.16

- **Quote rules (§3.2.2).** A quote shorter than 12 code points, or made only of whitespace, punctuation and symbols, is rejected with the new rule `CIT-007`, checked first. Length is counted after the delimiter escape is reversed.
- **Citation aliases (§3.2.1–§3.2.2, §3.3, §3.3.2).** A citation's item not in the call's input is `CIT-001`, not `ALIAS-001`. An alias of the wrong kind, or a defined local key, is `ALIAS-003`. Either rejects the citation alone, and the alias step of `analyse` and `analyse_expansion` leaves citation items to the citation step.
- **File currency (§3.2.2).** Current hashes are read before validation, and a file that can't be read again counts as changed. Each `CIT-002` event records the path, so the session can mark the snapshot unstable.
- **Line-range correction (§3.2.2).** Overlapping occurrences count separately, and an occurrence never spans the omitted lines between two included ranges. A quote starting or ending with `\n` spans the lines on both sides of that break.
- **No citation left (§3.2.2).** A finding whose citations are all rejected is rejected with the new rule `CIT-008`.
- **Excerpts (§3.2.2).** An excerpt is the file's own text for the final range, as decoded for rendering, with lines joined by `\n`. A quote holding a lone surrogate, half of a character, is `CIT-004`.
- `validatorVersion` is `validate/0.3.0`.

### Changes from v0.15

- **Schemas (§3.3, §3.7).** Zod schemas live in `src/schemas/<call>.ts`, because the build compiles `src/` only. The JSON Schema sent to the API is generated by our own code within the subset structured outputs support, committed under `src/schemas/json/` in schema property order, and sent unchanged; `schemaHash` is the SHA-256 of its canonical JSON. A test keeps every released version's hashes. Limits the API can't enforce are checked by Zod after parsing.
- **Per-item limits (§3.3, §3.5).** A string length or array size inside one item rejects only that item, with the new rule `LIMIT-001`. Collection sizes stay at the schema stage. `validatorVersion` is `validate/0.2.0`.
- **Lengths (§3.3).** Lengths count Unicode code points. Every string field has a stated maximum, including paths and globs (512), aliases (16) and reference values (512).
- **Patterns (§3.3).** Response-local keys, line ranges, expansion ranges and `B` targets have patterns, so constrained decoding guarantees their form. Alias references have none, so `ALIAS-001` and `ALIAS-003` still reject single items.
- **Unions for conditional fields (§3.3.3, §3.3.6).** A revision's `replace` and a regeneration's `revise` are their own variants, so a required field can't be missing.
- **Expansion requests (§1.8, §3.3.2).** Their shape is defined. The schema's ceiling of 5 is also the ceiling of `maxExpansionRequests`.
- **Top-level strings (§3.3).** `noChangeReason`, which belongs to no item, is checked at the schema stage.
- **Counts (§3.3).** Arrays without a stated size have one: `support`, `resolves` and `blockedBy` 1–10, `references` at most 20, regeneration `actions` at most 30. `analyse_expansion` absence claims, conflicts and notices take the `analyse` limits.
- **Questions (§3.3.4).** The schema allows at most 20, because a schema can't depend on the session's question budget; the per-call check trims to twice the budget.
- **Regeneration split (§3.3.6).** An affected set larger than 30 is sent in several calls.

### Changes from v0.14

`algorithmVersion` is `context-select/1.4.0`, because the destination item changed.

- **Block aliases (§1.5, §1.6, §3.2.1).** `BLOCKS` lines show `B-<n>` aliases, numbered from 1 in document order, instead of block IDs. Code maps each alias to the block's ID and hash, so the model never sees or returns a block ID.
- **Alias rules (§3.2.1).** Aliases match exactly. Two new rules: `ALIAS-002`, a response-local key used twice in one response, rejects every item with that key; `ALIAS-003`, an alias of a kind its field doesn't accept, rejects the item. A reference to a local key whose item was rejected fails the referring item's own rule. Alias tables are numbered in an order the caller fixes, per call, and recorded on the model call.
- **Events (§3.5).** Schema-stage events use the item key `$response` and the rule `SCHEMA`, and their detail is the issue path and code only, never the received value. A citation's events name it as `<key>/citations/<index>`. A rejected citation drops only that citation; a finding is dropped when none is left, and an accepted finding records how many of its citations were dropped.
- **Validator version (§3.5).** `validatorVersion` starts at `validate/0.1.0`. Any change to what is accepted increases it, thresholds included, and a test pins the rule list to the version.
- **Schema retry (§3.6).** The retry message follows the schema-event rule: paths and issue codes only, with model-chosen path segments written `<key>`.
- **No response text in events (§3.5).** Item keys that aren't well formed are replaced by the item's position, and details never repeat an unknown value. After a schema failure, the proposed count is unknown, not zero.

### Changes from v0.13

Section 3 and §1.11 reconciled with M1 and M2 before M3. No existing rule ID changes.

- **Sent lines (§3.2.2, §3.3.2).** Only numbered `CONTENT` lines in an item's `included` ranges can be cited; header attributes, outline labels, `BLOCKS` lines and `…` lines can't. A citation or content notice on an item with no sent lines, such as an outline-only item, is rejected with the new rule `CIT-006`.
- **Path resolution and globs (§1.11).** Every path or glob in model output resolves as `listed`, `uncovered` (under a directory capture didn't enter, or through a symbolic link) or `unlisted`. Globs use the workspace pattern grammar of §1.5. `SUP-001`, `SCOPE-001`, `GAP-001`, `not_inspected` relabelling and absence claims all use this.
- **Gaps (§1.11, §3.3.2).** `GAP-001` rejects only unlisted related paths; uncovered ones make the gap `not_inspected`. A gap stays "missing" only if every file its related paths match was sent in full; otherwise it is relabelled with the new rule `GAP-002`, and code records the uninspected paths.
- **Absence claims (§1.11).** New rules `ABS-001` (an entry of any status matches) and `ABS-002` (the glob can match only inside uncovered directories). Accepted claims name the uncovered directories the glob could reach.
- **Excerpt awareness (§1.11).** Enforced by the citation rules: an outline entry is never evidence.
- **Evidence basis (§3.2.4).** Basis follows the tier the file belongs to, through the initial context or expansion, so imported tier 1 files and expanded agent configuration are `existing_guidance`.
- **Withheld paths (§1.11).** A path withheld by the secret scan doesn't satisfy `SUP-001` or `SCOPE-001`, and absence wording counts withheld directories without naming them.
- **Deterministic gaps (§1.11).** The tier 1 budget gap and the outside-repository import gap are `not_inspected` from the start.
- **Basis for `listed_only` files (§3.2.4).** Tier membership for basis is decided by pattern, whether or not the file is a candidate.
- **Content notices (§3.3.2).** Checked with `CIT-006` and `CIT-003`, like citations.
- **Known facts (§3.2.5).** Existing agent configuration includes imported files.
- **Verification and fixtures (§1.15, §3.8).** New cases for outline-only citations, coverage relabelling, absence claims, withheld paths and basis.
- **Open points (§1.16, §3.9).** Coverage of symbolic links and excluded directories is decided. Two checks are now open points instead of requirements: absence asserted in free text, and claims about omitted parts of a file that cite only sent lines. Neither had a deterministic check.

### Changes from v0.12

`algorithmVersion` is `context-select/1.3.0`, because ignored directories change capture and the tree.

- **Inspect preview (§2.2, §2.4).** `<cli> inspect [path] [--list | --json] [--debug]` prints the "What we read" summary without a session and sends nothing. The summary's rows note files not read for budget, and the mock-up's destination note is `CLAUDE.md (41 blocks)`. Exclusion rules record their group, so the "Not sent" line can count excluded files by kind.
- **Default caps (§1.5, §1.14), calibrated on the development repositories (M2).** `initialContextBytes` 240,000 → 300,000; tier 2 cap 60,000 → 70,000; tier 5 cap 80,000 → 130,000; tier 5 per-file cap 6,000 → 12,000; `maxSourceFiles` 24 → 32. Tiers 1, 3 and 4 are unchanged. The evidence:
  - The two smaller repositories used 48 KB and 88 KB of 240 KB. Only the per-file cap and the file limit bound them: a library's core file sent only its imports and one small declaration, and a web app stopped at 24 files with 136 KB of budget left.
  - The third repository filled tiers 1, 2, 3 and 5, skipping its main usage document and 100 source files.
  - These are settings, not algorithm, changes: `settingsHash` changes, `algorithmVersion` does not.

- **Ignored directories (§1.4, §1.6, §1.13).** Git lists ignored entries before capture. A wholly ignored directory is one `ignored` entry that capture doesn't enter, like an excluded directory, and the tree shows it as `name/ [ignored]`. Capture enters one only when an `includeIgnored` pattern could match inside it. Ignored files outside such directories are still hashed.
- **Git version (§1.4).** The minimum is 2.38. Git 2.38 to 2.43 can't be told not to fetch missing objects, so it runs without `--no-lazy-fetch` and refuses only a partial clone, detected from `extensions.partialClone` or a `remote.*.promisor` key. Git 2.44 or later reads partial clones as before.
- **Ignore rules in the snapshot and manifest (§1.4, §1.13, §2.4).** The snapshot records whether ignore rules were applied, or why not, separately from the git metadata. The manifest's `ignoreRules` is that record, and the summary names the reason.

### Changes from v0.11

Calibration on the development repositories (M2) changed the selection algorithm. `algorithmVersion` is `context-select/1.2.0`.

- **Inspect summary wording (§2.4).** The "Not sent" line names excluded directories as `node_modules (not entered)` instead of counting their files, which capture never does.
- **Tier 5 ranking and extensions (§1.5).** Files under `test`, `tests`, `__tests__`, `examples` or `fixtures`, and `*.d.ts` files, are rank 4 (`tier5:rank4:supporting`), taken in a second round-robin pass after every package's other source files. `.vue`, `.svelte`, `.astro`, `.hbs`, `.handlebars`, `.ejs` and `.njk` are source extensions, excerpted by whole lines.
- **Outline-only code items (§1.5, §1.6).** A source excerpt that would contain no declaration, only the import block or nothing, is sent as its outline alone, with every entry omitted. It takes no source file slot. On the development repositories, several excerpts held only imports, including the core file of a library.
- **Tier 3 order (§1.5).** Workspace definitions, task runners, package manifests, tooling configuration, then CI last. Reasons renumber to `tier3:group3:package-manifest`, `tier3:group4:tooling` and `tier3:group5:ci`.
- **Scan as selected (§1.3, §1.5, §1.7).** Each item is scanned as it is selected. A blocked file uses no bytes, item ID or source file slot, so the next candidate takes its place, and a blocked test example is replaced by the package's next test file. Before, blocked items were removed after selection without refilling, which let one false positive cost a tier a whole file's budget.
- **Secret rules (§1.7).** `secretRulesVersion` is `secret-scan/1.1.0`. `generic-assignment` also matches names containing `pass`, `pwd`, `key`, `credential`, `auth` or `private`, and requires a high-entropy value: 3.5 bits per character, or 3.0 for 32 or more hex digits. The thresholds miss about 0.1% of random 20-character base62 secrets, and no line in the three development repositories matched the new rule.
- **Ignored files (§1.4, §1.6, §1.8, §1.13, §2.3, §2.4).** The git adapter lists the files the repository's ignore rules match. They stay in the snapshot, hashed, with the status `ignored`, and are candidates for no tier and no expansion. The tree marks them `[I]`, and the manifest lists them and records whether ignore rules were applied. The setting `includeIgnored` keeps chosen ignored files as candidates. Without git, only the default and user exclusions apply, and the summary says so. Ignored files no longer count as untracked. `CLAUDE.local.md` and `.claude/settings.local.json` are excluded by default, and tier 1 no longer matches `CLAUDE.local.md`.

### Changes from v0.10

- **Destination blocks (§1.5, §1.6).** The destination item has a BLOCKS section listing each Guidance Block's lines and ID. Hashes are not sent, because code supplies them and the model never does. The section counts against `maxDestinationBytes`.
- **Tree format (§1.6).** The tree has a fixed format. A readable file that wasn't selected is marked `[-]`, and `[L]` is only for `listed_only` files. If even depth 1 doesn't fit, a one-line summary at depth 0 is used.
- **Secret paths and labels (§1.7).** A path that matches a rule is never sent: its tree names are withheld, including every segment a match spans, it is recorded as secret-blocked even when unselected, and records hold its hash (`pathHash`, `relatedPathHashes`). The scan also reads the raw item path and the uncut text of every cut outline label.
- **Selection version (§1.3).** `algorithmVersion` is `context-select/1.1.0`, because the destination item and the tree changed.
- **Manifest (§1.13).** Tier 4 has its own entry. Tier entries record `budgetBytes`. Withheld paths are recorded as `pathHash`. `retainedInputRef`, `tokenCheck` and `expansion` are `null` until those steps run.

### Changes from v0.9

- **Secret rules (§1.7).** The rule set is concrete: nine rule IDs in a fixed order, with their patterns. The first matching rule is recorded. A generic-assignment value is at least 20 characters with a digit and a letter, and an unquoted one has no dot unless it is a JWT. A connection-string password that starts with `$`, `{`, `<` or `%` is a reference, not a literal. Every rule works within one line, and the scan covers the whole rendered item.
- **Blocked items (§1.7).** Removing a blocked item keeps the other items' IDs, and tier usage counts only what remains. Gap statements are scanned, and an import is scanned before it is cut.
- **Fixtures (§1.7).** Committed fixtures must not look like real credentials. Tests build matching values from fragments.

### Changes from v0.8

- **Tier filling (§1.5).** A tier tries every item in its order; later items that fit are still included. Each file belongs to the first tier that matches it. A file whose smallest possible rendering can't fit is skipped without being read. The five tier caps may not add up to more than `initialContextBytes`.
- **Destination size (§1.5).** `maxDestinationBytes` limits the rendered item. A destination larger than the tier 1 cap is still included, and tier 1 passes nothing down.
- **`@path` imports (§1.5).** Only Markdown files are scanned. The import syntax is defined, and code spans are ignored as well as code blocks. An imported file that a later tier matches stays in that tier.
- **Name lists (§1.5).** Tier 2, 3 and 5 names, Markdown extensions, excluded documentation, test patterns and ranking stems are fixed, and part of `algorithmVersion`. Names in tiers 2, 3 and 5 match ASCII case-insensitively; tier 1 names match exactly.
- **Packages (§1.5).** Workspace members are read from `package.json`, `lerna.json` and `pnpm-workspace.yaml`, with a defined glob syntax. A member directory must contain a `package.json`, as in npm and pnpm. Source files outside every package form a root package.
- **Reasons (§1.5).** Item and skip reason strings are fixed.
- **Import gaps (§1.5).** The import named in the gap statement is cut to 80 code points.
- **Verification (§1.15).** The destination rule has four causes, not three.

### Changes from v0.7

- **Declaration patterns are versioned (§1.3, §1.6, §1.13).** They have their own `declarationPatternsVersion`, part of `settingsHash` and the manifest, because changing them changes the context.
- **Excerpts fit rendered bytes (§1.6).** A cap or budget limits the whole rendered item: header, outline, line numbers and content.
- **Nested Markdown sections (§1.6).** A section that doesn't fit is split into its own text and its subsections, each tried in turn.
- **Line-prefix outline (§1.6).** Excerpts taken as whole lines from the start have an outline of two line ranges.
- **Rendering details (§1.6).** Lines, labels, quoted attributes, `…` lines and the reversible delimiter escape are fixed. The rendering example now follows them.
- **Blank leading lines (§1.6).** All-blank lines before the first heading or declaration are neither outlined nor sent. A decorated declaration is outlined at its first decorator line.
- **Verification (§1.15).** The excerpt item matches the split-section and blank-line rules.
- **Open point (§1.16).** Where the destination's Guidance Block IDs and hashes go in the rendered item.

### Changes from v0.6

- **Tree markers (§1.6).** `[>]` marks a symbolic link, shown with its target. `[U]` marks an unreadable entry. Removed from the open points.
- **`@path` imports (§1.5).** Imports in tier 1 files are followed recursively, inside the repository only, ignoring imports in code blocks, and safely through cycles. Imported files join tier 1 as `existing_guidance`. An import that points outside the repository creates a deterministic `gap` finding. Removed from the open points.

### Changes from v0.5

- **List item shape (§3.3.5).** `REC-003`: a `revise` of a `list_item` block must keep the target's marker and indentation, which the snapshot records ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §7).
- **`listed_only` reasons (§1.4).** Files containing a NUL byte or not valid UTF-8 are `listed_only` with that reason, as the snapshot already records them. A destination in that state is `unavailable`.
- **Open point (§1.16).** Files that the root `CLAUDE.md` imports with `@path` are existing guidance, but tier 1 doesn't select them.

### Changes from v0.4

- **Git metadata (§1.4).** How capture reads the commit and tree without trusting the repository: which commands run, the environment, the minimum git version, and how the working tree is compared.

### Changes from v0.3

- **Exclusion rules made exact (§1.4).** A pattern grammar, the binary and media extension list, case rules, secret-bearing names matching directories too, and no exclusion by `.gitignore`. The root `CLAUDE.md` is never excluded. Excluded directories are listed once and not entered, so the tree shows no count for them.
- **Snapshot capture (§1.4).** The repository is observed twice and compared, with one retry, and is never written to. Symbolic links are listed, never followed. The remaining symbolic-link race is stated.
- **Unavailable destination (§1.5).** A fourth reason to stop before any model call: the snapshot records the destination as `unavailable`.

### Changes from v0.2

- Section 3, model calls and schemas, is new. It defines the split between model judgement and code-established facts, citation provenance with a narrow recorded line-range correction, support checks that are separate from provenance, per-call contracts for five calls, the validation pipeline, and retry policy.

**Builds on:** [Domain Model](DOMAIN_MODEL.md) v0.6, [ADR 0001: Standalone TypeScript CLI](../decisions/0001-standalone-typescript-cli.md), [Product Evaluation Requirements](../product/EVALUATION_REQUIREMENTS.md).

**Command name:** `<cli>` is a placeholder until the command name is chosen.

### Changes from v0.1

Section 1:

- **Structure-aware excerpts.** Documents are included as complete sections, and code as complete top-level declarations, each with an outline of what was left out. Expansion can request line ranges (§1.6, §1.8).
- **Full-request token check.** The complete request is checked against the model's input limit before sending, with a deterministic reduction order (§1.10).
- **Narrow absence claims.** Accepted absence claims are worded by code as "no files matched this pattern within the inspected scope" (§1.11).
- **Secret scan scope.** Narrower promise; the scan now covers every source sent in every call (§1.7).
- **Destination size rule.** One explicit rule: if the full destination cannot be included safely, the session stops (§1.5).
- **Tree after selection.** The tree is rendered after content selection, so its markers are accurate (§1.3).
- **Replay defined.** Exact model inputs are retained locally under an explicit policy (§1.12).
- **Test reserve.** Tier 5 reserves space for one test example per package (§1.5).

Section 2, CLI interaction, is new.

## Contents

1. Context selection
2. CLI interaction
3. Model calls and schemas
4. Persistence and export

---

## 1. Context selection

### 1.1 Goals

1. **Reproducible:** the same snapshot, settings and model produce byte-identical initial context.
2. **Explainable:** every included item has a recorded reason, and every omission is visible.
3. **Bounded:** selection has a fixed byte budget, and every request is checked against the model's token limit.
4. **Careful with secrets:** excluded paths never leave the machine, and content matching known secret patterns is blocked before every call. Pattern matching cannot detect every credential; the product says so.
5. **Honest about coverage:** something the model did not read is never treated as something that does not exist.

### 1.2 Call sequence

| # | Call | Receives | Produces |
|---|---|---|---|
| 1 | `analyse` | Initial context (§1.4–§1.6) | Candidate findings, gaps, conflicts, absence claims, optional expansion requests |
| 2 | `analyse_expansion` *(optional, at most once)* | Initial context, validated results of call 1, expansion results (§1.8) | Additional or revised candidate findings, gaps, conflicts, absence claims |
| 3 | `generate_questions` | Validated findings, gaps, conflicts; their cited excerpts; directory tree; destination blocks | Candidate questions |
| 4 | `recommend` | Validated findings, gaps, conflicts; cited excerpts; confirmed decisions; question statuses; directory tree; destination blocks with IDs (code supplies their hashes) | Candidate recommendation revisions |

Rules:

- Deterministic validation ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.2, §9.1, and §1.11 below) runs after every call. Calls 2–4 receive **only validated material**. Rejected output is recorded on the model call and never passed forward.
- Calls 3 and 4 do not receive the raw initial context. Their source content is limited to excerpts cited by validated evidence, plus the destination blocks.
- Every call passes through the secret scan (§1.7) and the token check (§1.10) before it is sent.
- Prompt caching may be used for the repeated initial context in call 2. It does not change what is sent.

### 1.3 Construction order and determinism

Context construction is a pure function:

```text
context = select(snapshot, settings, algorithmVersion, modelTokenCount)
```

It runs in this order:

1. Build the candidate set (§1.4).
2. Select and excerpt content for tiers 1, 2, 3 and 5 (§1.5, §1.6), running the secret scan (§1.7) on each item as it is selected. A blocked file is not included and uses no bytes, item ID or source file slot, so the next candidate in that tier's order takes its place. Tier membership, packages and `@path` imports are planned from the snapshot before any item is scanned, so a blocked file can still shape them: a blocked `package.json` still defines its package, and the imports of a blocked tier 1 file are still followed. Every file they bring in is scanned on its own before it is included.
3. Scan the selected items and gap statements again (§1.7). This repeats step 2's check, so the guarantee doesn't depend on it; anything it finds is removed without refilling budgets.
4. Extract the known facts (§3.2.5), using the tier membership, imports and declared workspace members planned in step 2, and render the known-facts section within `knownFactsBytes`. Each fact's statement and excerpt is scanned as the fact is made; step 3 doesn't repeat that, and the scan of the complete request before it is sent covers the section like everything else (§1.7).
5. Render the directory tree (tier 4) from the full file list, with markers reflecting the final selection.
6. Join the known-facts section and all items in tier order 1, 2, 3, 4, 5 (§1.6).
7. Assemble the complete request and run the token check (§1.10). Apply deterministic reductions if needed; tree markers are updated for any removed items.

Determinism requirements:

- **Inputs** are only the snapshot (file list, hashes, live content verified against snapshot hashes), settings, and the token count reported for the selected model. Nothing else: no filesystem enumeration order, modification times, environment, locale, randomness or model output.
- **Path order** is bytewise ascending order of repository-relative, forward-slash, UTF-8 paths. Every "in order" in this section means this order unless stated otherwise.
- **Budgets are in bytes** of rendered UTF-8 context. Byte selection is independent of the model. The token check (§1.10) is the only model-dependent step, and it can only remove items, never add them.
- **Settings are versioned.** `settingsHash` is the SHA-256 of the canonical JSON of the effective settings, `algorithmVersion`, `secretRulesVersion` and `declarationPatternsVersion`.
- **Content is verified.** When a file is read for context, its hash must match the snapshot entry. A mismatch aborts construction and reports the snapshot as unstable ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1).
- **Verification:** `contextHash`, the SHA-256 of the rendered context, must be identical across runs for the same snapshot, settings and model. This is a required test.

### 1.4 Candidate set

A file is a **candidate** for content inclusion when all of these hold:

- it is in the snapshot, not matched by an exclusion, and not `ignored` (below);
- it decodes as UTF-8 and contains no NUL bytes;
- its size is at most `maxReadableFileBytes` (default 262,144). Larger files are `listed_only`: they appear in the tree, but their content is included only through a line-range expansion (§1.8).

A file that is not excluded but fails the size or content rules is `listed_only`, with the reason `too_large`, `contains_nul` or `not_utf8`, checked in that order. A root `CLAUDE.md` that would be `listed_only` is recorded as an `unavailable` destination instead ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §7).

**Default exclusions** (user exclusions are added to these):

- Version control and tooling state: `.git` (a directory, or the `gitdir:` file of a linked worktree or submodule), `.hg/`, `.svn/`
- Dependencies: `node_modules/`, `vendor/`, `.venv/`, `venv/`, `__pycache__/`, `.pnpm-store/`
- Build output: `dist/`, `build/`, `out/`, `.next/`, `target/`, `coverage/`, `.turbo/`, `*.min.js`, `*.map`
- Lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `Gemfile.lock`
- Secret-bearing names: `.env`, `.env.*` (except `.env.example` and `.env.sample`), `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `*.keystore`, `credentials*`, `secrets*`
- Personal agent configuration: `CLAUDE.local.md` (at any depth) and `.claude/settings.local.json` (at the root). These are a developer's own files, usually git-ignored, and never project guidance.
- The product's own session storage, if located inside the repository
- Binary and media types by extension

Exclusions are recorded in the snapshot and the manifest. Excluded directories appear in the tree once, with no children and never by content (tier 4, §1.6); capture does not enter them, so there is no count.

**Ignored files.** Files the repository's ignore rules match are not excluded, because capture doesn't parse ignore files itself. Before capture, the git adapter (below) lists the untracked entries git's ignore rules match, with `--directory`, so a directory whose whole content is ignored is one entry. Capture then records them as `ignored`:

- An `ignored` entry is an untracked path matched by git's standard ignore rules: `.gitignore` files at any depth and `.git/info/exclude`. No excludes file is read, neither the user's global one (git runs without the user's configuration or `HOME`) nor one the repository's config names (`core.excludesFile` is overridden, below).
- A wholly ignored **directory** is one entry, like an excluded directory: capture doesn't enter it, so its contents are neither listed nor counted. The tree shows it as `name/ [ignored]`.
- An ignored **file** that git lists on its own (outside a wholly ignored directory) is readable, and would otherwise be `read` or `listed_only`. It stays in the snapshot with its hash and size, so coverage and freshness still see it, but it is a candidate for no tier and no expansion (§1.8). The tree shows it as `[I]`.
- The destination, excluded entries, symbolic links and unreadable entries are never `ignored`; exclusions are applied first. A tracked file that an ignore pattern matches stays a candidate, as it does in git.
- Untracked files that no ignore rule matches stay candidates.
- The setting `includeIgnored` (§1.14) lists patterns, in the exclusion grammar below, for ignored files to keep as candidates: such a file keeps its `read` or `listed_only` status. A pattern matches the file's path, or, with a trailing `/`, any directory above it, so `logs/` keeps every file under `logs`. It is a snapshot setting, so it is part of `settingsHash`. Capture enters a wholly ignored directory when a pattern could match inside it: an unanchored pattern, which can match at any depth; a pattern that covers the directory or a directory above it; or an anchored pattern whose leading segments match the directory's path. Inside, files the patterns don't keep are `ignored` and hashed.
- Ignored entries are listed once, before capture's observations, so the stability check doesn't cover them: an ignore file edited during capture can give an `ignored` set that doesn't match the ignore file's hash in the snapshot, and an ignored file or directory created during capture, such as a log a running process writes, is not identified and stays a candidate. It is still secret-scanned before anything is sent.
- Files git lists as ignored never count as untracked (DM §6.1), even when `includeIgnored` keeps them as candidates.
- When git can't list ignored entries (no repository, git missing or too old, a partial clone on git older than 2.44, or an error), ignore rules are not applied: only the default and user exclusions apply. The snapshot and manifest record `ignoreRules` as `not_applied` with that reason, and the summary says that ignored files couldn't be identified (§2.4).

**Patterns.** Default and user exclusions use one grammar:

- A trailing `/` matches directories and symbolic links only. Otherwise any entry matches.
- A pattern that starts with `/` or contains another `/` is anchored at the repository root and matches that path. Otherwise it matches the entry's base name at any depth.
- `*` matches any run of characters except `/`. There are no other wildcards.
- The session storage location is always anchored, because it names one place. It must be relative to the repository root and inside it; a leading `./` is ignored.
- Rules apply in order: defaults, then user exclusions, then the session storage location. The first match is recorded.

Secret-bearing names and binary types compare ASCII letters case-insensitively, so `ID_RSA` and `logo.PNG` are excluded. Other rules are case-sensitive. Secret-bearing names match directories too: `secrets/` and `credentials.d/` are excluded whole. The root `CLAUDE.md` is never excluded, because it is the destination.

**Binary and media types** are these extensions: images `png jpg jpeg gif bmp ico icns webp tif tiff psd heic avif svg`; audio and video `mp3 wav ogg flac m4a aac mp4 m4v mov avi mkv webm`; archives `zip gz tgz bz2 xz zst 7z rar tar jar war`; fonts `woff woff2 ttf otf eot`; documents `pdf doc docx xls xlsx ppt pptx`; compiled code and data `exe dll so dylib a o obj class pyc wasm bin sqlite db`.

**Capture** ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1) is read-only. Files are opened read-only and never through a symbolic link; nothing is written inside the repository, including `.git/`. Symbolic links are recorded with their targets and never followed. Special files such as named pipes are never opened, and are recorded as `unreadable`. A name that is not valid UTF-8 is recorded as `unreadable` and as a read failure. After a file is opened, its parent directory must still resolve to the expected path under the root, or nothing is read; a directory is listed only if it resolves to its expected path before and after listing. One race remains, because Node has no `openat`: a directory swapped for a link and back again between the open and the check. The tool doesn't defend against a repository being changed adversarially while it runs. The repository is observed twice, listing and hashing every file that is not excluded. If any path's entry differs between the two, both observations are repeated once. If they still differ, the snapshot is `unstable` with those paths, and the second observation of the retry is kept.

**Git metadata** ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1) is read by an adapter that treats the repository as untrusted. Ignored entries are listed before the observations, and the commit and tree are read after them. Each read repeats the version, repository and object-format checks:

- Only `git --version`, `git rev-parse` (top level, object format, `HEAD^{commit}`), `git config --get-regexp` (the partial-clone check, below 2.44 only), `git symbolic-ref` and `git show-ref` (to recognise a branch with no commits), `git ls-tree -r -z -l --full-tree <commit>` and `git ls-files -z --others --ignored --exclude-standard --directory` run. None of them refreshes the index, or runs hooks, filters or fsmonitor. Only `ls-files` reads the working tree, and only directory listings and ignore files, never file content; `--directory` reports a wholly ignored directory as one entry. `git status` is never used.
- The environment is built from scratch: `PATH`, `LANG=C`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, and `GIT_CEILING_DIRECTORIES` set to the root's parent unless that path contains `:`. `HOME` and variables such as `GIT_DIR` from the user's shell are dropped. Every command except `--version` also gets `--no-lazy-fetch` (git 2.44 or later only) and `-c core.fsmonitor=false -c core.untrackedCache=false -c safe.bareRepository=explicit -c core.excludesFile=/dev/null`. The last stops the repository's own config pointing `ls-files` at any file the user can read, or at a FIFO that would stall it.
- Git older than 2.38 is refused (`git_too_old`): 2.38 added `safe.bareRepository`, and 2.35.2 the `safe.directory` ownership check. The floor is set by feature, not patch level; the known flaws in 2.38.0–2.39.0 (CVE-2022-23521 in attribute parsing, CVE-2022-41903 in pretty formats) are in features none of these commands use.
- Git 2.38 to 2.43 ignores `GIT_NO_LAZY_FETCH` and has no `--no-lazy-fetch`, so in a partial clone it could fetch missing objects, running the network, credential helpers and commands from the repository's config. Git fetches lazily only from a promisor remote, so this git refuses only a repository whose config, include files included, has `extensions.partialClone` or any `remote.<name>.promisor` key, whatever its value (`git_too_old`). Any other failure of that check, such as a config whose `~/` include can't be resolved without `HOME`, is treated as a partial clone: the read is refused as `git_too_old`, not `git_error`. On macOS, `/usr/bin/git` reports the version of the installed Command Line Tools, which can be 2.39.
- Git runs only when the root has a `.git` entry, so discovery stops at the root. The work tree git reports must be the root: a subfolder of a larger repository, a bare-repository layout, or a `core.worktree` pointing elsewhere is `not_a_repository`. Discovery is used rather than setting `GIT_DIR`, because git checks `safe.directory` ownership only during discovery.
- `safe.directory` refusals are recorded as `unsafe_repository`. Global config is ignored, so a `safe.directory` entry there doesn't apply.
- The commit is `HEAD^{commit}`. It is absent only when HEAD is a symbolic ref to a branch that doesn't exist yet; any other failure to resolve HEAD is `git_error`.
- Core compares the tree with the snapshot. A file whose size differs is modified without being read again. Otherwise it is read again, streaming, and the adapter computes its blob ID (`blob <size>\0<bytes>`, SHA-1 or SHA-256 to match the repository) without buffering the file; the read must still have the snapshot hash, or the file is uncompared. Symbolic links are compared by their target.

### 1.5 Tiers

Tiers 1, 2, 3 and 5 are filled in that order. Each has a byte cap. Unused bytes from tiers 1, 2 and 3 pass down to the next selected tier. Tier 4's cap is reserved up front and is not reallocated, because the tree is rendered after selection.

Within a tier, every item is tried in the tier's order. An item that exceeds its per-file cap or the remaining budget is excerpted (§1.6) to fit the smaller of the two, if the tier allows it, or skipped and recorded. An item whose rendering matches the secret scan is blocked instead (§1.7), and the next item is tried. Later items that fit are still included. A file whose smallest possible rendering (an empty file's) cannot fit is skipped without being read.

**Each file belongs to one tier:** the first of tiers 1, 2, 3 and 5 that matches it, even if that tier skips it. A file is never sent twice.

**Names.** Tier 1 names match exactly, because agents load those files by exact name. In tiers 2, 3 and 5, names and extensions compare ASCII letters case-insensitively, so `readme.md`, `makefile` and `App.TS` match. *Markdown* means the extensions `.md`, `.markdown` and `.mdx`. These lists and rules are part of `algorithmVersion`; any change to them increases it.

**Reasons.** Items carry `tier1:destination`, `tier1:agent-config`, `tier1:import`, `tier2:group<N>:root-doc|decision-doc|docs|package-readme`, `tier3:group<N>:workspace|task-runner|package-manifest|tooling|ci`, `tier5:test-example` or `tier5:rank<N>:entry-point|boundary-name|other|supporting`. A file tried and never included is recorded with `tier<N>:cap-reached`.

**Default budget:** `initialContextBytes` = 310,000. The five tier caps and `knownFactsBytes` (§3.2.5) may not add up to more than it; settings that do are rejected. Bytes the known-facts section doesn't use are not passed to any tier. `knownFactsBytes` may not be less than the section's frame, 40 bytes.

| Tier | Contents | Default cap | Per-file cap | Excerpting |
|---|---|---|---|---|
| 1 | Existing agent configuration | 40,000 | Destination: `maxDestinationBytes`; others: none | Never |
| 2 | Project documentation | 70,000 | 12,000 | By document section |
| 3 | Manifests and tooling configuration | 40,000 | 8,000 | By whole lines from the start |
| 4 | Directory tree (reserved) | 20,000 | n/a | By depth reduction |
| 5 | Representative source, including test reserve | 130,000 | 12,000 | By top-level declaration |

#### Tier 1 — Existing agent configuration

Matched paths:

- `CLAUDE.md` at any depth (`CLAUDE.local.md` is excluded, §1.4)
- `.claude/**` (text files only)
- `AGENTS.md` at any depth
- `.cursorrules`, `.cursor/rules/**`
- `.github/copilot-instructions.md`

**Destination rule.** The root `CLAUDE.md`, if present, is the destination. It is selected first and must be included in full, with its Guidance Blocks ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §7) listed by alias in a BLOCKS section (§1.6). Block IDs and hashes are not sent: code maps each alias to them, never the model. The session **stops with an explanation** before any model call if any of these is true:

- the destination's rendered item, BLOCKS section included, is larger than `maxDestinationBytes` (default 40,000);
- the destination matches the secret scan (§1.7);
- the destination cannot fit within the model's input limit after all permitted reductions (§1.10);
- the snapshot records the destination as `unavailable` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1).

The explanation names the reason and the options (shorten the file, or raise the setting). The destination is never truncated, skipped or partially sent. Its rendered bytes count against tier 1. If they exceed the tier 1 cap, the destination is still included, and tier 1 passes nothing down.

**Other agent configuration**, in order of path depth then path order, fills the remaining tier 1 budget. It is included as `existing_guidance` evidence and is never a target. Items that don't fit are skipped. A deterministic `gap` finding is then created: "Some existing agent configuration was not read because of the analysis budget," listing the skipped paths.

**`@path` imports.** Tier 1 Markdown files, the destination included, can import other files with `@path`. Imports are resolved before tier 1 is filled:

- An import is `@` at the start of a line or after whitespace, followed by a run of non-whitespace characters, with trailing `.,;:!?)]}"'` removed.
- Each import is resolved relative to the file that contains it, and resolution is recursive: imports in imported Markdown files are followed too. Other files are not scanned.
- Imports inside code blocks and inline code spans are ignored, as Claude Code ignores them.
- Only paths inside the repository are followed, and only to files in the snapshot. Imports are never followed through a symbolic link, and an imported file is still subject to exclusions and the secret scan (§1.7).
- Resolution is cycle-safe: each path is visited at most once, so a file that imports itself, directly or through others, ends the chain.
- Imported files join tier 1 as other agent configuration, `existing_guidance` evidence that is never a target, and are ordered and budgeted like it. A file that is already in tier 1 by its path is not added twice. A file that tier 2, 3 or 5 matches stays in that tier, so `@package.json` is still a tier 3 manifest and command evidence.
- An import that does not resolve to a candidate file is ignored. One that resolves to a `listed_only` file still counts for evidence basis (§3.2.4).
- An import that points outside the repository, including absolute and home-directory paths, is not read. A deterministic `gap` finding is created that names the importing file and the import as written, cut to 80 code points like an outline label (§1.6).

#### Tier 2 — Project documentation

Ranked groups, in this order:

1. Root `README*`, `CONTRIBUTING*`, `ARCHITECTURE*`, `DEVELOPMENT*`
2. Markdown files under directories named `adr`, `adrs`, `decisions` or `architecture` (anywhere)
3. Other Markdown under the root `docs/` directory, in path order
4. Package-level `README*` files, chosen round-robin across packages (§1.5, tier 5)

Groups 1 to 3 are in path order. Group 1 matches any extension; groups 2 and 3 only Markdown. A package-level README is directly inside a package directory other than the root.

Changelogs, licences and generated API reference directories are excluded from this tier by name: base names starting with `CHANGELOG`, `CHANGES`, `HISTORY`, `LICENSE`, `LICENCE`, `COPYING` or `NOTICE`, and anything under a directory named `api-reference`, `api-docs`, `apidocs`, `typedoc` or `javadoc`.

#### Tier 3 — Manifests and tooling configuration

Matched files, in this order:

1. Workspace definitions: root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, root `pyproject.toml`, `Cargo.toml`, `go.work`, `go.mod`
2. Task runners: `Makefile`, `justfile`, `Taskfile.yml`, `Procfile`
3. Package-level manifests (`package.json`, `pyproject.toml`, `Cargo.toml`), round-robin across packages
4. Tooling configuration: `tsconfig*.json`, `eslint.config.*`, `.eslintrc*`, `.prettierrc*`, `prettier.config.*`, `biome.json`, `biome.jsonc`, `ruff.toml`, `.ruff.toml`, `mypy.ini`, `.mypy.ini`, `pytest.ini`, `vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `docker-compose*.yml`, `docker-compose*.yaml`, `compose.yml`, `compose.yaml`, `Dockerfile*`
5. CI: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`

Groups 1, 2 and 5 match at the repository root only; CI also matches `.github/workflows/*.yaml`. Groups 3 and 4 match at any depth; a package-level manifest is one not at the root. Each group is in path order, except group 3. CI comes last because workflows are often large: on a development repository, ten workflows used the whole tier before the root `tsconfig.json` and `.prettierrc` were reached.

These files are the source of command evidence. Commands are always reported as `found_not_run`.

#### Tier 5 — Representative source

**Source files** are candidates with a source extension. The default list covers TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, Swift and their common variants, and is a setting. By default it is the extension list of the declaration patterns (§1.6), plus components and templates: `.vue`, `.svelte`, `.astro`, `.hbs`, `.handlebars`, `.ejs` and `.njk`. These have no declaration patterns, so they are excerpted by whole lines from the start.

**Packages** are determined in this order:

1. workspace members declared in tier 3 manifests: the root `package.json` `workspaces` (an array, or an object with `packages`), `lerna.json` `packages`, and the `packages:` list in `pnpm-workspace.yaml`. Patterns match directories that contain a `package.json`, as in npm and pnpm: `*` matches within one path segment, `**` matches any number of segments, and a pattern starting with `!` removes what it matches. Other workspace formats, and files that don't parse, contribute nothing;
2. otherwise, top-level directories that contain source files;
3. otherwise, the repository root as one package.

A file belongs to the deepest package that contains it. Source files in no package form a root package, which comes first in package path order.

**Test reserve.** Tier 5 first fills a reserved sub-budget, `testReserveBytes` (default 15,000). In package path order, each package contributes one test example: the first file in path order, not blocked by the secret scan, matching common test patterns (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`, files under `tests/`, `test/` or `__tests__/`). Each example is capped at `testExampleBytes` (default 3,000) and excerpted by declaration. Unused reserve passes to the main tier 5 pool. Test files already chosen are excluded from the ranking below; a test file the reserve could not fit is ranked like any other. Test files must be source files, and the directory patterns match at any depth.

**Ranking within a package.** Each remaining source file gets the first matching rank:

| Rank | Rule | Rationale |
|---|---|---|
| 1 | Entry-point names: `index`, `main`, `app`, `server`, `cli`, `mod`, `lib`, `__main__` | Shows structure and wiring |
| 2 | Boundary names: `client`, `api`, `routes`, `router`, `schema`, `schemas`, `model`, `models`, `service`, `config` | Where conventions and contracts live |
| 3 | All remaining source files | Fallback |
| 4 | Supporting files: anything under a directory named `test`, `tests`, `__tests__`, `examples` or `fixtures` (at any depth), and `*.d.ts` files. This rank is checked first, so `test/index.ts` is rank 4 | Show less of the project's own code |

A file's name for ranking is its base name without its last extension, so `index.ts` is rank 1 and `index.d.ts` is rank 4. Within a rank, order is path depth (shallower first), then path order.

**Selection** is round-robin: in package path order, take each package's next-ranked file of ranks 1 to 3, repeating until every package's are tried; then the same for rank 4. Both passes stop when the tier budget or `maxSourceFiles` (default 32, not counting test examples or outline-only items, §1.6) is reached. Rank 4 has its own pass because a top-level `test/` or `examples/` directory is a package of its own, and would otherwise get a turn in every round.

This sampling will miss conventions that only show up across many files. The expansion step (§1.8) exists for that reason.

### 1.6 Excerpting and rendering

When a file exceeds its per-file cap or the remaining budget, an **excerpt** is included instead. An excerpt always includes an **outline** of the whole file, so the model knows what it hasn't seen and can request it by line range.

Caps and budgets limit the **rendered** item (§1.3): header, outline, line numbers, `…` lines and content. A file is included in full when its full rendering fits. Otherwise parts are added in the order below while the rendering still fits, and if no line fits, the file is skipped. Source code is the exception: an excerpt with no declaration is sent as its outline alone (below).

**Lines.** LF, CRLF and a lone CR each end a line. A final line ending does not start another line, and a leading BOM is not part of line 1. Line numbers start at 1.

**Markdown documents (tier 2):**

- The outline lists every heading with its line number.
- Headings are found as in Guidance Block parsing ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §7): ATX and setext headings, not inside code blocks or front matter.
- Content is included as **complete sections** (a heading through the line before the next heading of the same or higher level), in document order, until the cap. Lines before the first heading that are not all blank form a `preamble` section. If they are all blank, they have no outline entry and are not sent.
- A section that does not fit is split: its own text (the heading through the line before its first subheading) is tried as one unit, then each subsection in the same way. A unit that does not fit is skipped, and later units that fit are still included. The outline marks each heading whose own text was skipped.
- If the first unit in document order does not fit, it is cut before the last blank line that lets it fit, and marked as truncated. If no blank line allows that, it is skipped.

**Source code (tier 5 and test examples):**

- The outline lists each top-level declaration with its line number. Declarations are detected with a fixed set of line patterns per language family, chosen by file extension, for example `export`, `function`, `class`, `interface`, `type`, `const … =` at column zero, `def`, `async def`, `func`, `fn`, `impl`, `struct`. A run of decorator or attribute lines (`@…`, `#[…]`) directly above a declaration starts it, and the outline gives that first decorator line. CommonJS `require` assignments are not declarations.
- The patterns have their own version, `declarationPatternsVersion` (for example `declarations/1.0.0`), recorded in `settingsHash` and the manifest. Any change to the patterns or the extension mapping increases it, because it changes the context. A test pins the pattern set to its version.
- Content is the import block (every line before the first declaration, outlined as `imports`; if those lines are all blank, they have no outline entry and are not sent), followed by **complete top-level declarations** in file order until the cap. A declaration runs from its start line to the line before the next top-level declaration.
- A declaration that does not fit is skipped, and later ones that fit are included. Skipped declarations are marked in the outline. The import block is skipped in the same way.
- **Outline alone.** If no declaration fits, so the excerpt would hold at most the import block, the item is the outline alone: every entry marked `[omitted]`, `included=""`, and a single ` …` line as its content. An import block on its own shows nothing of the code's shape; the outline shows every declaration and its line, for fewer bytes, and the model can request lines by range (§1.8). If even the outline doesn't fit, the file is skipped. An outline-only item does not use a source file slot (§1.5).
- If no declarations are detected, whole lines are taken from the start of the file.

**Manifests and configuration (tier 3):** whole lines from the start of the file. These files are usually small, and their order is usually meaningful.

**Whole lines from the start** (tier 3, and code with no detected declarations) take as many lines as fit. The outline has two entries: the included range and the omitted rest, for example `   1 lines 1-80` and `  81 lines 81-212 [omitted]`.

**Rendering** is a fixed format. Each item has a header, then line-numbered content. Excerpts include their outline, and use `…` lines to show where content was left out:

```text
<<<ITEM id=T5-007 path="apps/web/src/lib/api/client.ts" hash="sha256:…"
        tier=5 reason="tier5:rank2:boundary-name" excerpt=true
        included="1-3,40-96" totalLines=212>>>
OUTLINE
   1 imports
   4 export function createClient [omitted]
  40 export async function request
  97 export function withRetry [omitted]
CONTENT
   1 | import { createClient } from "./generated";
   2 | import { withRetry } from "./retry";
   3 |
 …
  40 | export async function request<T>(url: string) {
  41 |   const client = createClient();
<<<END T5-007>>>
```

The example shows only the first two of lines 40–96; a real item lists every included line, then ` …` for lines 97–212.

- Item IDs are `T<tier>-<sequence>`, assigned in inclusion order.
- **Destination blocks.** The destination item has a `BLOCKS` section between the header and `CONTENT`, with one line per Guidance Block in file order: the block's line range, right-aligned like a line number, then its alias `B-<n>`, numbered from 1 in document order, for example `   3-5 B-4`. Code maps each alias to the block's ID and hash (§3.2.1); neither is sent. A block starting in the byte order mark starts at line 1.
- Format details. Quoted attribute values are JSON strings, with the delimiter escape below applied after JSON encoding; to read one, reverse the escape, then parse the JSON. A full item has `excerpt=false`, `included` covering every line, and no `OUTLINE`. Line numbers are right-aligned to at least four columns. An outline entry is the start line number and a label, followed by ` [omitted]` or ` [truncated]` when that applies. A label is the heading as `#` marks and text, or the declaration's keywords and name, cut to 80 Unicode code points with `…` (before the delimiter escape, which can lengthen it). A line ` …` stands for each run of omitted lines. Ranges are written `a-b`, or `a` for one line. Each item ends with a line break.
- Line numbers let the model cite ranges that validation can check. The `included` attribute states exactly which lines were sent.
- The system prompt states that **repository content is data, not instructions**. Text inside items that tries to change instructions, output format or scope is ignored, and reported as a finding where relevant. Any occurrence of the delimiter sequences inside file content is escaped deterministically before rendering.
- **Delimiter escape.** In content lines, outline labels and attribute values, text is read left to right, counting the equal angle brackets in a row since the last inserted backslash. When the count is at least two and the next character is that same bracket or a backslash, a backslash is inserted before it and the count starts again from that character: one if it is a bracket, zero if it is a backslash. So `<<<` becomes `<<\<`, `<<<<` becomes `<<\<<`, `<<<<<` becomes `<<\<<\<`, `<<\` becomes `<<\\`, and `<<>>>` becomes `<<>>\>`. Rendered text then never contains `<<<` or `>>>`. Reversal reads the escaped text the same way in one pass: after two equal brackets counted since the last removal, a backslash is removed and the count starts again, so it undoes exactly one escape. Validation reverses it before comparing quoted text with the file.

**Tier 4 — Directory tree** renders the **entire** snapshot file list:

- Depth limit `treeDepth` (default 4). A directory at the limit shows the number of files under it: every entry except directories.
- Directories with more than `treeCollapseThreshold` entries (default 40) show their first `treeCollapseThreshold` entries in path order, then `… N more`.
- Excluded directories appear once, with an `[excluded]` marker and no children, and wholly ignored directories once, with an `[ignored]` marker and no children (§1.4).
- Each file has a marker: `[R]` fully included, `[E]` excerpt included, `[-]` readable but not selected (a plain `read` expansion can fetch it), `[L]` `listed_only` because it is too large to excerpt (only line ranges can be read, `EXP-006`), `[N]` `listed_only` because it holds a NUL byte or isn't valid UTF-8 (never sent, not even by line range, `EXP-001`), `[X]` excluded, `[I]` an ignored file (§1.4; not sent, and no expansion can read it), `[S]` blocked by secret scan, `[>]` symbolic link, shown with its target (`name -> target`), `[U]` unreadable (a directory too, with `/`).

**Format.** A header `<<<TREE depth=<d> files=<n>>>>`, one line per entry, and `<<<END TREE>>>`, each ending with a line break. `n` counts every entry except directories. Entries are indented two spaces per level, and siblings are in bytewise name order. A directory is its name and `/`; a file is its marker, a space and its name. A name containing a control character (C0, DEL, C1, U+2028 or U+2029) is written as a JSON string, and the delimiter escape applies to names and link targets. A name or link target that matches the secret scan is written `<withheld>` (§1.7).

```text
<<<TREE depth=4 files=123>>>
[R] CLAUDE.md
node_modules/ [excluded]
src/
  [E] index.ts
  lib/ (17 files)
  … 3 more
<<<END TREE>>>
```

If the rendering exceeds its cap, `treeDepth` is reduced by one until it fits. If even depth 1 doesn't fit, the tree is the header at depth 0 and the single line `… N more`, counting the root's entries; this smallest form is used even if a very small cap can't hold it. The final depth is recorded. The tree is how the model knows what exists that it has not read.

### 1.7 Secret scan

A fixed, versioned rule set detects **known secret patterns**:

- private key headers (`-----BEGIN … PRIVATE KEY-----`);
- known credential prefixes (for example AWS access key IDs, GitHub, Slack, Stripe, OpenAI and Anthropic key formats);
- assignments whose name contains `secret`, `token`, `password`, `api_key`, `apikey`, `pass`, `pwd`, `key`, `credential`, `auth` or `private`, and whose value is a long, high-entropy literal;
- connection strings with embedded credentials.

**Rules.** `secretRulesVersion` is `secret-scan/1.1.0`. Rules are tried in this order, and the first that matches anywhere is recorded. Every rule works within one line; line ends are LF, CR, U+2028 and U+2029.

| Rule ID | Matches |
|---|---|
| `private-key` | `-----BEGIN `, then upper-case letters, digits and spaces, then `PRIVATE KEY-----` or `PRIVATE KEY BLOCK-----` |
| `aws-access-key-id` | `AKIA`, `ASIA`, `ABIA` or `ACCA`, then exactly 16 upper-case letters or digits, not followed by a letter or digit |
| `github-token` | Not after a letter, digit or `_`: `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 36 or more letters or digits; or `github_pat_` and 22 or more letters, digits or `_` |
| `slack-token` | `xoxa-`, `xoxb-`, `xoxp-`, `xoxo-`, `xoxs-` or `xoxr-`, then 10 or more letters, digits or `-` |
| `stripe-key` | `sk_` or `rk_`, then `live_` or `test_`, then 16 or more letters or digits. Publishable `pk_` keys are not secrets |
| `anthropic-key` | `sk-ant-`, a kind of lower-case letters and digits, `-`, then 20 or more letters, digits, `_` or `-` |
| `openai-key` | `sk-proj-`, `sk-svcacct-` or `sk-admin-`, then 20 or more letters, digits, `_` or `-`; or the legacy form: `sk-`, 20 letters or digits, `T3BlbkFJ`, 20 letters or digits |
| `connection-string` | A scheme (a letter, then letters, digits, `+`, `.` or `-`), `://`, an optional user, `:`, a password, `@` and a host. User, password and host contain no whitespace, `@` or `/`, and the user no `:`. A password starting with `$`, `{` or `<`, or with `%` not followed by two hex digits, is a reference such as `${DB_PASSWORD}` or `%s`, not a literal |
| `generic-assignment` | A name of letters, digits, `_`, `.` and `-` containing `secret`, `token`, `password`, `api_key`, `apikey`, `pass`, `pwd`, `key`, `credential`, `auth` or `private` (ASCII case-insensitive), optionally in quotes; then `=`, `:`, `:=` or `=>`, never a comparison; then a literal of at least 20 characters from `A–Z a–z 0–9 _ + / . -`, with up to two `=` at the end, containing a digit and a letter. A quoted literal ends at its closing quote. An unquoted literal has no `.` unless it starts with `eyJ` (a JWT), because a dotted value such as `process.env.KEY_V2` is a code reference; it is followed by whitespace, a quote, `,`, `;` or the end of the line. The literal must be **high-entropy**: without its trailing `=` padding, its Shannon entropy is at least 3.5 bits per character, or, if it is hex digits only (all lower-case or all upper-case), it is at least 32 digits long with at least 3.0 bits per character. A low-entropy literal doesn't end the search: a later assignment on the same line can still match |

Unless stated, credential prefixes must not follow a letter or digit. Patterns must scan in time linear in the text's length: a hostile file can't stall the scan. Any change to the rules or their order increases `secretRulesVersion`.

**Scope.** The scan runs on the final rendered source content of **every model call**, immediately before the request is sent:

- initial context items (calls 1 and 2);
- expansion results (call 2);
- destination blocks (all calls that include them);
- cited excerpts passed to calls 3 and 4;
- any developer-edited text that will be sent.

Excerpts and blocks were already scanned when first selected. They are scanned again anyway: the cost is small, and the guarantee then doesn't depend on every earlier path having been correct.

**On a match:**

- During selection, the **whole file** is excluded from that and all later calls in the session. Redaction is not attempted in the first slice: partially redacted content is easy to get wrong. The scan covers the whole rendered item, header and outline included, because a heading in an outline can carry a secret from an omitted section. The scan runs as each item is selected (§1.3, §1.5): the blocked file uses no budget, item ID or source file slot, and the next candidate takes its place. A test example that is blocked is replaced by the package's next test file.
- The scan also reads the uncut text of every outline label that was cut to 80 code points (§1.6), so a cut can't leave part of a secret behind. A match blocks the file.
- A path can match a rule, for example a file named after an access key ID. The raw path is scanned, because the item header JSON-encodes it, which can hide a match. Such a file's content is never sent, it is marked `[S]`, and it is recorded as secret-blocked even when no tier selected it. This includes `listed_only` and `ignored` files (§1.4); an `ignored` one is listed under both `ignored` and `excluded` in the manifest (§1.13). Any tree name or link target that matches is written `<withheld>`. A match can span segments (`token=abc/def…`), so every segment it may cover is withheld too: from the last segment whose suffix of the path still matches to the first segment whose prefix matches, or every segment if those don't overlap. Records that leave the selection hold the path's SHA-256 instead of the path: `pathHash` in the manifest, and `relatedPathHashes` in gap findings, so `relatedPaths` only ever holds real paths.
- Selection gap statements are scanned too. An import outside the repository is scanned before it is cut to 80 code points; if it matches, the statement names only the importing file and says the import is withheld. Any other gap statement that matches is replaced by a fixed statement.
- For an excerpt in calls 3–4, the excerpt is withheld, and any finding that depends only on it is marked `evidence_withheld` and not passed forward.
- For the destination, the session stops (§1.5).
- The manifest records the path (or its `pathHash`) and the rule ID, never the matched text. The tree marks the file `[S]`.

Placeholder values in `.env.example` and similar files are not exempt from the scan; those files are only exempt from the name-based exclusion.

**Fixtures.** Each rule has fixtures that must match and near misses that must not. Committed files must not look like real credentials: push protection may block the push, and scanners would flag the repository. Tests build matching values from fragments at test time, or use documented example values such as `AKIAIOSFODNN7EXAMPLE`. A test checks that no committed fixture matches any rule.

**What the product claims:** content matching known secret patterns is blocked. Credentials in unrecognised formats may not be detected. The first-run notice (§2.3) states that selected repository content is sent to the model provider and that the scan reduces, but does not eliminate, the risk of sending secrets. Developers can add exclusions before any content is sent.

### 1.8 Expansion protocol

The `analyse` call may return up to `maxExpansionRequests` (default 5) requests. The setting can't exceed the schema's ceiling of 5 (§3.3.2); requests beyond a lower setting are rejected in response order. There are two kinds:

| Kind | Parameters | Limits |
|---|---|---|
| `read` | Up to 10 entries, each a path with optional line ranges (for example `apps/web/src/lib/api/client.ts:20-39,97-140`), plus a reason | Per-entry cap `expansionEntryBytes` (default 8,000) |
| `search` | A literal string (no regular expressions in the first slice), an optional path glob, and a reason | At most 30 matches, 3 lines of context each |

A `read` without line ranges returns the file excerpted by the rules in §1.6. A `read` with line ranges returns exactly those lines, which must be within the file. Line-range reads are the way to see omitted outline entries and `listed_only` files that are too large to excerpt (`EXP-006`); a `listed_only` file that holds a NUL byte or isn't valid UTF-8 can't be read (`EXP-001`).

Each request is validated deterministically. The static checks run with the `analyse` item validation (§3.3.2 step 9), in this order; the first failure rejects the whole request:

| Rule | Check |
|---|---|
| `LIMIT-002` | The request is among the first `maxExpansionRequests` in response order. |
| `EXP-001` | Every `read` path, after the path normalisation of §1.11, is a `read` entry, or a `listed_only` entry that is too large, that is not withheld by name and not blocked by its content (§1.7). A file `listed_only` because it holds a NUL byte or isn't valid UTF-8 is never readable, with or without ranges. So it is in the snapshot, not excluded, not `ignored` (§1.4), not a symbolic link or unreadable, and not secret-blocked. The detail names the entry's position in the request, never the path. |
| `EXP-006` | A `listed_only` entry has explicit line ranges: a file too large to excerpt can be read only by range. |
| `EXP-002` | Every requested line range starts at or before its end. |
| `EXP-003` | The request adds something: a `read` entry with ranges asks for at least one line the initial context didn't send of that file, and a `read` entry without ranges names a file not sent in full (§1.11). A request whose every entry adds nothing is rejected. |
| `EXP-004` | A search `glob`, when given, holds no backtick, whitespace, or control or format character (`Cc`, `Cf`), names something after the path normalisation of §1.11, lies under one of the snapshot's scope roots (its leading segments are the root's segments, written without wildcards, so `**/*.ts` is not under `src`; the root `.` covers everything), and matches at least one searchable file, a `read` entry that is not withheld or blocked by its content, directly or through a directory it matches, as in §1.11. |
| `EXP-005` | A search `literal` is line-safe text: it holds no control character (`Cc`), so no line break, is at least 3 code points long, and is not only `White_Space`, punctuation or symbols. Matches are found within one line, so a line break could never match. |

Whether a requested range lies within the file, and the total expansion staying within `expansionBytes` (default 60,000), are checked when the request is executed, because they need the file's content. Invalid requests are rejected with a recorded reason. Valid ones are executed by application code:

- File content is read live, and its hash must match the snapshot. A mismatch fails that request with "changed since snapshot".
- Search runs over candidate files only, never `ignored` ones, in path order. Matches are ordered by path, then line, and the result is capped.
- Results are rendered in the same item format, with IDs `E-<sequence>` and reason `expansion:<request-id>`, and pass the secret scan before inclusion.

**One expansion round** in the first slice. Call 2 cannot request further expansion.

### 1.9 Reserved

*(Intentionally empty, so that section numbers stay stable for references from other documents.)*

### 1.10 Token check

Byte budgets do not guarantee that a request fits: the system prompt, instructions, earlier validated results, output schema and the response itself also need room. Before every call:

1. Assemble the **complete request**: system prompt, instructions, rendered context or excerpts, prior validated results, decisions and output schema.
2. Count its input tokens using the provider's token-counting facility for the selected model. If that is unavailable, use a conservative estimate of 1 token per 3 bytes, and record that the estimate was used.
3. Require: `inputTokens + reservedOutputTokens(call) + safetyMargin ≤ modelContextLimit`.
   - `reservedOutputTokens` is a per-call setting (defaults: `analyse` 16,000; `analyse_expansion` 12,000; `generate_questions` 4,000; `recommend` 16,000).
   - `safetyMargin` defaults to 5% of the model's context limit.

If the request does not fit, items are removed in this **deterministic reduction order**, re-checking after each step:

1. tier 5 source files, last selected first (test examples last within tier 5);
2. tier 2 documentation sections, last selected first;
3. other tier 1 agent configuration, last selected first;
4. for calls 3–4: cited excerpts for findings not referenced by any open question or candidate recommendation, then the directory tree depth.

The known-facts section (§3.2.5), tier 3 manifests and the destination are never removed. If the request still does not fit, the call is not sent, and the session stops with an explanation (for calls 1–2, this triggers the destination rule in §1.5 if the destination is the cause).

Every reduction is recorded in the manifest, and the tree markers are updated. The token check is the only model-dependent part of construction. Because it can only remove items, the byte selection stays reproducible across models, and the final context is reproducible for a fixed model.

### 1.11 Coverage-aware validation

These checks run after calls 1 and 2, in addition to the evidence validation in the domain model.

**Globs.** Gap `relatedPaths`, absence-claim `pathGlob`s and scope paths use the workspace pattern grammar (§1.5): `*` matches within one path segment, `**` matches zero or more whole segments, and there is no `!`. Patterns are anchored at the repository root, compare case-sensitively, and match entry paths, directories included. `*` and `**` match names that start with a dot, so `**/*.yml` matches `.github/workflows/ci.yml`. A directory a path matches, whether named without wildcards or matched by a glob, also covers everything under it, so `src` and `src/*` both reach `src/a/b.ts`. Paths are normalised first (below). Expansion paths and search globs keep their own rules (§1.8).

**Path normalisation.** Every path the model writes is normalised the same way before it is matched against the file list, whether it is in a path field (scope paths, gap `relatedPaths`, absence-claim `pathGlob`s) or a token in text (below): one leading `./` and one trailing `/` are removed, so `./src/a.ts` names `src/a.ts`, `src/` names `src`, and `././src/a.ts` and `src//` name nothing. `..` is never resolved: a path with a `..` segment names nothing, so it is unlisted, fails `SCOPE-001`, `GAP-001` and `SUP-001`, and rejects an absence claim (`ABS-003`).

A glob **could match inside** a directory `D` when some path under `D` could match it: code matches `D`'s segments, in order, against the glob's leading segments, where `*` matches one segment and `**` may absorb any number of them, and the glob must have at least one segment left over, or end in `**`. So `**/*.test.ts` and `src/**/foo.ts` could match inside `src/a/node_modules/`, and `docs/*.md` could not.

**Path resolution.** Each of these paths and globs resolves to one of three classes:

- **listed:** it matches a snapshot entry of any status (`read`, `listed_only`, `ignored`, `excluded`, `symlink`, `unreadable`; capture never produces `truncated`), or a directory that contains entries. An excluded or wholly ignored directory is itself an entry, so `node_modules/` is listed.
- **uncovered:** it doesn't match a listed entry, but lies under, or could match inside, a directory that capture didn't enter: an excluded directory, a wholly ignored directory, an unreadable directory, or a path through a symbolic link. Exactly: an entry with status `symlink`, or an `excluded`, `ignored` or `unreadable` entry whose kind is directory or symbolic link. Whether it exists is unknown.
- **unlisted:** neither. Capture would have listed it, and didn't.

A path withheld because its name matched the secret scan (§1.7) is listed for gaps and absence claims. The model never saw its name, so it does not anchor a statement (`SUP-001`) or satisfy a scope (`SCOPE-001`): those two rules accept only listed paths that are not withheld. A scope glob satisfies `SCOPE-001` when it matches at least one listed path that is not withheld; an uncovered scope path does not.

**Path tokens in model text.** A path the model writes inside text, rather than in a path field, is a token: in a finding statement (`SUP-001`, §3.2.3) or in recommendation content (§3.4, `REF-002`). It is matched against the file list after the path normalisation above. Matching a token against an excerpt uses the token as written, and quotes are always matched exactly (§3.2.2).

**Gap findings** must include:

- `gapType`: `no_command`, `no_documentation`, `undetermined_ownership`, `undetermined_convention`, or `other`;
- `relatedPaths`: the paths or globs the gap concerns.

Each related path must be listed or uncovered. An unlisted one rejects the gap: a gap about something that doesn't exist must be an absence claim instead (`GAP-001`).

A gap keeps the label "missing" only if every file its related paths match is **sent in full** in that call, and no related path counts a directory capture didn't enter. A file is sent in full when the sent lines of its items, initial and expansion, together cover every line; every item of a file must agree on its line count, and an empty file sent as an item is sent in full. A related path counts a directory capture didn't enter when:

- it names the directory explicitly: its leading wildcard-free segments are the directory's, or a path under it, as `node_modules`, `node_modules/react/index.js` and `broken/*.ts` are; or
- it could only reach the directory, by matching it, covering it, or being able to match inside it, as `**/README.md` and `src` can, and the directory may hide project content: an unreadable entry, a symbolic link, or an entry excluded by a user exclusion (the first rule with its pattern, in rule order, is a user rule). Default exclusions, including session storage, and wholly ignored directories don't count this way: they hold dependencies, build output and other content that isn't the project's own, so a `**/README.md` gap stays "missing" past `node_modules/`.

Otherwise it is relabelled `not_inspected` (`GAP-002`, outcome `relabelled`), and code records on the finding ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.3) the matched files that weren't sent in full, withheld ones by `pathHash`, and the directories that count. Such a directory is recorded once, among the directories, never among the entries. That covers files not selected (`[-]`), excerpted or outline-only, `listed_only` (`[L]` and `[N]`), `ignored` (`[I]`), excluded (`[X]`), secret-blocked (`[S]`), symbolic links (`[>]`), unreadable entries (`[U]`), and the directories above when they count. The review shows it as "not inspected", not "missing". A gap on a whole directory is therefore usually `not_inspected`; the prompt asks the model to name the specific files a gap concerns.

The deterministic gaps of §1.5 are `not_inspected` from the start: agent configuration skipped by the tier 1 budget records the skipped paths, and an import outside the repository records the importing file, because the imported file was never read.

**Absence claims** must be expressed as `absenceClaim: { pathGlob, reason }`. Code copies the glob into the claim's statement, so a glob holding a backtick, whitespace, or a control or format character (Unicode `Cc`, `Cf`) is rejected first (`ABS-003`), as is one with a `..` segment, which names nothing. The glob is then normalised (above), so `./src/a.ts` is rejected by `ABS-001` when `src/a.ts` exists. Application code then evaluates the glob against the **full snapshot file list**, in this order:

1. If any entry matches, of any status, the claim is rejected (`ABS-001`). The rejection detail never names a withheld path.
2. If the glob can match only inside uncovered directories, the claim is rejected (`ABS-002`): it is entirely about content that wasn't inspected. With only `*` and `**`, that holds exactly when the glob's leading wildcard-free segments start with the segments of a directory capture didn't enter, and the glob has segments beyond it: `node_modules/**/*.js` can match only inside `node_modules/`, and `node_*/x.js` can match elsewhere.
3. Otherwise the claim is accepted. Its statement is **generated by code, not the model**: "No files matched `<pathGlob>` within the inspected scope.", quoting the glob as the model wrote it. If the glob could match inside uncovered directories, code adds every one of them, whatever its kind, for example "Not inspected: `node_modules/` (excluded), `logs/` (ignored), `vendor -> ../shared` (symbolic link)." Directories are listed in bytewise order; an excluded, ignored or unreadable symbolic link is shown without a trailing `/`, and a symbolic link target that matches the secret scan is shown as `<withheld>`. Withheld names are never shown; code counts them instead ("and 1 withheld directory", or "Not inspected: 2 withheld directories." when no other is named). When ignore rules were not applied, code adds: "Ignore rules were not applied, so ignored files could not be identified." The `reason` the model wrote is kept, but never shown as the claim.

An accepted absence claim records a narrow fact about one pattern. It can support a gap or a question ("No files matched `**/*.test.ts`. How are frontend changes tested?"). It **cannot** support a recommendation that states a broader absence, such as "this project has no tests". Absence asserted in free text, without an `absenceClaim`, is not yet detected (§3.9).

**Excerpt awareness** is enforced by the citation rules: a citation is checked only against sent lines (§3.2.2, `CIT-003`, `CIT-006`). An outline entry shows that a declaration or section exists, not what it contains, so it is never evidence. A claim about what omitted parts contain that cites only sent lines is not detected by code (§3.9).

### 1.12 Retained model inputs and replay

Hashes identify content but cannot recreate it. To make a session replayable, the exact inputs are retained under an explicit policy:

- **`retainModelInputs`** (default `true`): the exact rendered request body of every model call is stored in the session directory as a content-addressed file, referenced from the model-call record. This content has already been sent to the provider; retaining it locally adds no new exposure beyond local storage. The exact response body is retained the same way, under the same setting, for replay only (§4.8).
- Retained inputs and responses are **never included in exports by default**. Including them is an explicit export option.
- Retained inputs and responses are deleted when the session is deleted, and can be purged separately while keeping the rest of the session. The CLI shows the policy at first run and in session status.
- With retention on, a session is **replayable**: every request can be re-sent exactly, even if repository files have since changed.
- With retention off, replay requires the original files at the recorded hashes. Any mismatch is reported, and replay stops.

The initial context is **reproducible** from the snapshot, settings and model. A session that used expansion is **replayable** but not reproducible, because the expansion requests were model output.

*Domain model note:* this adds retained-input and retained-response references to the Model Call record ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13.1) and a retention rule to persistence (§15). The snapshot itself still stores no full source content.

### 1.13 Input manifest

Every model call records an input manifest ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13.1). It contains paths, hashes and reasons, never source content:

```json
{
  "manifestVersion": 2,
  "algorithmVersion": "context-select/1.7.0",
  "secretRulesVersion": "secret-scan/1.1.0",
  "declarationPatternsVersion": "declarations/1.0.0",
  "settingsHash": "sha256:…",
  "snapshotId": "snap_…",
  "contextHash": "sha256:…",
  "retainedInputRef": "inputs/sha256-….json",
  "budget": { "initialContextBytes": 310000, "usedBytes": 231020 },
  "knownFacts": { "capBytes": 10000, "usedBytes": 2610, "facts": 14, "leftOut": 0 },
  "tokenCheck": {
    "model": "…",
    "method": "provider_count",
    "inputTokens": 61204,
    "reservedOutputTokens": 16000,
    "contextLimit": 200000,
    "reductions": []
  },
  "tiers": [
    { "tier": 1, "capBytes": 40000, "usedBytes": 6120, "items": 2, "skipped": 0 },
    { "tier": 4, "capBytes": 20000, "usedBytes": 17300, "treeDepth": 3 },
    { "tier": 5, "capBytes": 80000, "usedBytes": 79120, "items": 21, "testExamples": 4 }
  ],
  "items": [
    {
      "id": "T5-007",
      "path": "apps/web/src/lib/api/client.ts",
      "fileHash": "sha256:…",
      "reason": "tier5:rank2:boundary-name",
      "excerpt": true,
      "includedLines": "1-3,40-96",
      "totalLines": 212,
      "bytes": 4312
    }
  ],
  "skipped": [
    { "path": "docs/guide/long.md", "reason": "tier2:cap-reached" }
  ],
  "excluded": [
    { "path": "node_modules", "rule": "node_modules/" },
    { "path": "config/local.ts", "reason": "secret-scan:generic-assignment" }
  ],
  "ignoreRules": { "state": "applied" },
  "ignored": [
    { "path": "logs" },
    { "path": "server/config.js" }
  ],
  "expansion": null
}
```

When expansion is used, `expansion` lists each request, its validation outcome, the items returned and their bytes.

Details:

- Tiers are listed 1 to 5. Tiers 1, 2, 3 and 5 also record `budgetBytes`: the cap plus bytes passed down. Tier 4 records `capBytes`, `usedBytes` and `treeDepth`.
- `budget.usedBytes` is the rendered context's size, known-facts section and tree included.
- `knownFacts` records the section's cap, its rendered bytes, frame included, and how many facts were sent and left out (§3.2.5).
- `ignoreRules` is the snapshot's record: `{ "state": "applied" }`, or `{ "state": "not_applied", "reason": … }` with the git reason (§1.4). `ignored` lists the snapshot's `ignored` entries in path order: files, and wholly ignored directories as one path each.
- `excluded` lists the snapshot's excluded entries with their rule, in path order, then secret-blocked files with `secret-scan:<rule ID>`, in path order. Secret-blocked files include files whose path matches, whether or not a tier selected them.
- A path that matches the secret scan is recorded as `pathHash` instead of `path` (§1.7).
- `retainedInputRef` is `null` until inputs are retained for a call (§1.12), `tokenCheck` until the token check runs (§1.10), and `expansion` when there was no expansion.

### 1.14 Settings

| Setting | Default |
|---|---|
| `initialContextBytes` | 310,000 |
| `knownFactsBytes` | 10,000, provisional; at least 40, the frame (§3.2.5) |
| Tier caps (1, 2, 3, 4, 5) | 40,000 / 70,000 / 40,000 / 20,000 / 130,000 |
| `maxDestinationBytes` | 40,000 |
| Per-file caps (tiers 2, 3, 5) | 12,000 / 8,000 / 12,000 |
| `testReserveBytes`, `testExampleBytes` | 15,000, 3,000 |
| `maxReadableFileBytes` | 262,144 |
| `includeIgnored` | none (§1.4) |
| `maxSourceFiles` | 32 |
| `treeDepth`, `treeCollapseThreshold` | 4, 40 |
| `maxExpansionRequests`, `expansionBytes`, `expansionEntryBytes` | 5, 60,000, 8,000 |
| `reservedOutputTokens` per call | 16,000 / 12,000 / 4,000 / 16,000 |
| `safetyMargin` | 5% of context limit |
| `retainModelInputs` | `true` |
| Source extensions, exclusions | Default lists above, plus user additions |

All defaults are starting points. They are calibrated on the product-development repositories, never on evaluation materials. Calibration changes increase `algorithmVersion` or change settings, and are recorded.

### 1.15 Verification

- The same snapshot, settings and model produce an identical `contextHash` across runs, machines and locales.
- Changing filesystem enumeration order or modification times does not change the context.
- Each tier respects its cap; unused budget passes down correctly; tier 4's reserve is not reallocated.
- Each package with a test file contributes a test example when the reserve allows.
- A file blocked by the secret scan gives its place to the next candidate in its tier's order: it uses no bytes, item ID or source file slot.
- Markdown excerpts contain only complete units, a section or the own text of a split section, except the first unit, which may be cut before a blank line; code excerpts contain only complete declarations and the import block, with at least one declaration, or are the outline alone; outlines list everything omitted except blank lines before the first heading or declaration.
- Tree markers match the final selection, including after token-check reductions. A `listed_only` file too large to excerpt is `[L]`, and one that holds a NUL byte or isn't valid UTF-8 is `[N]`, unless its name is withheld (`[S]`).
- The destination is included in full, or the session stops before any call with a stated reason, for each of the four causes in §1.5.
- The secret scan runs on every outgoing request and blocks each rule's fixtures. The manifest never contains matched text.
- Excluded, `ignored`, `listed_only` (except requested ranges of a file too large to excerpt) and secret-blocked content never appears in a request.
- Ignored files are recorded as `ignored` only when git lists them: never tracked files, the destination, excluded entries or links. Without git, the manifest says ignore rules were not applied, with the reason.
- A wholly ignored directory is one entry that capture never lists or reads inside, unless an `includeIgnored` pattern could match there.
- Git 2.38 to 2.43 reads an ordinary repository without `--no-lazy-fetch`, and refuses a partial clone.
- Delimiter sequences inside file content are escaped.
- Line-range expansion returns exactly the requested lines; out-of-range or already-included requests are rejected.
- A file changed after the snapshot fails expansion with "changed since snapshot".
- A request that exceeds the token limit is reduced in the specified order, or not sent.
- Gap findings concerning unsent content become `not_inspected`, including gaps on paths under an excluded or wholly ignored directory or through a symbolic link; gaps on unlisted paths are rejected.
- Absence claims contradicted by the file list are rejected, including by an `ignored`, excluded or `listed_only` entry; a claim that can match only inside uncovered directories is rejected; accepted ones use the code-generated narrow wording, name the uncovered directories the glob could reach, and cannot support broader recommendations.
- Citations of omitted outline entries, outline labels, `BLOCKS` lines or outline-only items are rejected.
- A gap stays "missing" when expansion completes a file, and becomes `not_inspected` for an excerpted or outline-only file, a symbolic link, an unreadable directory, or a related path that names an excluded directory explicitly; it stays "missing" when a glob could only reach a default-excluded or ignored directory. The §1.5 deterministic gaps are `not_inspected`.
- A withheld path neither anchors `SUP-001` nor satisfies `SCOPE-001`, and never appears in an absence-claim rejection or wording; accepted wording counts withheld directories, and says when ignore rules were not applied.
- Basis follows the file's tier: an imported tier 1 file and expanded `.claude/` configuration are `existing_guidance`, `@package.json` is `code_observation`, and a `listed_only` tier 2 document read by line range is `documentation`.
- Calls 2–4 receive only validated material, and calls 3–4 no raw initial context.
- A retained session replays byte-identical requests after repository files change.
- A prompt-injection fixture inside a repository file does not change output schema, scope or behaviour.

### 1.16 Open points for this section

- Recalibrating the default caps once the token check (§1.10) gives real token counts, and on a larger repository than the three development repositories, which have fewer than 230 files each. Tiers 1, 3 and 4 were left unchanged for that reason: tier 4 never used more than 6,135 bytes, which says nothing about a large repository.
- Declaration patterns for languages beyond the default families.
- Whether `search` should support a restricted regular-expression syntax after the first slice.
- Whether tier 2 should prefer recently changed documents. This is excluded for now, because it would make the result depend on Git history.

---

## 2. CLI interaction

### 2.1 Principles

- **One decision at a time.** Each screen asks for one kind of input. Information that supports a decision is one keystroke away, not printed by default.
- **Always oriented.** Every screen starts with the stage, its position in the workflow, and the session ID.
- **Nothing is written without final approval.** Accepting recommendations never writes. The only write is the apply step after explicit, exact approval, and the default answer is no.
- **No automatic approval.** There is no `--yes` flag or non-interactive approval path in the first slice. Approval must be a person.
- **Save and quit anywhere.** Every prompt accepts `q`. Progress up to the last completed action is kept, and `resume` returns to the same point.
- **Readable without colour.** Status is always shown with a text label or symbol as well as colour. `NO_COLOR` and non-TTY output are respected.
- **Plain language.** Basis labels, statuses and errors use the words in this section. Internal record names appear only in IDs.

The command name is a placeholder: `<cli>`.

### 2.2 Commands

| Command | Purpose |
|---|---|
| `<cli> init [path]` | Start a session for the repository at `path` (default: current directory) |
| `<cli> resume [session-id]` | Continue a session (default: most recent for this repository) |
| `<cli> status [session-id]` | Show stage, status, unresolved items, cost and effort so far |
| `<cli> sessions` | List sessions, with repository, stage, outcome and last update |
| `<cli> export <session-id> [--include-excerpts] [--include-inputs] [--out <dir>]` | Write the session export (§4.10, [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §14) |
| `<cli> delete <session-id>` | Delete a session and its retained inputs and responses, after confirmation |
| `<cli> purge-inputs <session-id>` | Delete retained model inputs and responses only (§4.8) |
| `<cli> inspect [path] [--list \| --json] [--debug]` | Show the "What we read" summary (§2.4) for the repository at `path` without starting a session. Nothing is sent or written |

`status`, `sessions`, `export` and `inspect` support `--json`. Interactive steps require a TTY; run in a non-TTY environment, `init` and `resume` print an explanation and exit without changing anything.

### 2.3 Start

`init` performs checks before anything is read or sent:

1. Resolve the repository root (Git root if present, otherwise the given path). Show it.
2. Report Git state: commit and whether the working tree has uncommitted changes. Uncommitted changes are allowed and will be included; the screen says so.
3. Check the API key environment variable. If it is missing, explain how to set it and exit.
4. Show the model, the generation budget and the question budget, with how to change them.
5. **First run for this repository:** show the data notice and require explicit confirmation:

```text
Before we start

Selected files from this repository will be sent to the model provider
for analysis. You'll see exactly which files before anything is sent.

• Excluded by default: dependencies, build output, lockfiles, .env files,
  keys and personal Claude settings. Files your .gitignore ignores are
  not sent either, when git is available to list them.
• Files matching known secret patterns are blocked. Pattern matching
  can't detect every kind of credential.
• What's sent is kept locally with the session so it can be replayed.
  You can delete it at any time.

Continue? [y/N]
```

If a session is already in progress for this repository, `init` offers to resume it or start a new one.

### 2.4 Inspect

Deterministic steps print short progress lines: listing files, hashing, parsing the existing `CLAUDE.md`, selecting context. Then the **"What we read"** summary (§1.13) is shown before anything is sent:

```text
INSPECT · step 1 of 5 · session ses_01J…

What will be sent for analysis  (231 KB of 310 KB)

  Known facts                    14 facts    3 KB
  Existing agent configuration   2 files     6 KB   CLAUDE.md (41 blocks)
  Documentation                  7 files    58 KB   2 excerpted
  Manifests and tooling         12 files    31 KB
  Directory tree                1,284 files listed, depth 3
  Source samples                21 files    79 KB   4 test examples, 9 excerpted

  Not sent: node_modules (not entered), 3 lockfiles, 1 file blocked (secret pattern)
  Ignored by .gitignore: 6 entries   logs/ (not entered), server/config.js, … ([v] lists all)

  [Enter] Send for analysis   [v] View file list   [a] Add paths
  [x] Add exclusions   [q] Save and quit
```

- `v` lists each item with its reason and excerpt range, and every skipped or blocked path with its reason.
- `a` and `x` change the settings, recompute the selection, and show the summary again with the new size. Adding an `ignored` path with `a` adds it to `includeIgnored` (§1.4, §1.14), so a new snapshot keeps that file as a candidate; it then belongs to a tier as usual.
- The "Not sent" line names each excluded directory followed by `(not entered)`, because capture never enters it and has no count of its contents (§1.4). Excluded files are counted by kind, and secret-blocked files are counted.
- The ignored line lists `ignored` entries (§1.4), first in path order, with the count; an ignored directory is shown as `logs/ (not entered)`. When ignore rules were not applied, it reads instead `Ignored files couldn't be identified (<reason>): only the default exclusions were used.`
- The known facts row counts the facts sent (§3.2.5), with `N not sent (budget)` when the section's cap left some out.
- Each row's notes count what was excerpted, sent as an outline alone (§1.6), and not read because the budget ran out (`N not read (budget)`). The agent configuration row names the destination with its block count, or says `no CLAUDE.md yet`.
- If the destination rule (§1.5) stops the session, this screen explains why and what to do, and nothing is sent.

After **Enter**, analysis runs. Progress shows the current call, elapsed time and cost so far. If the model requests expansion, the CLI shows what was requested and what was accepted or rejected, then continues automatically: expansion has already been validated against scope, exclusions and budget.

**Preview without a session.** `<cli> inspect [path]` runs the same capture and selection and prints the same summary, then exits. It is not interactive and starts no session, so it differs from the screen above in three places: the header reads `INSPECT · preview · no session · nothing is sent`, followed by the repository path and the git state (the commit and whether there are uncommitted changes, or why git wasn't used); the heading reads "What would be sent for analysis"; and the key prompts are replaced by `Run with --list to see every file and the reason for each.` and these options:

- `--list` prints what `v` shows: every item with its ID, path, reason, lines sent and bytes; the tree's size; every path not read for budget; and every path not sent, with the rule, the secret rule, `listed only`, `unreadable`, symbolic link or `ignored`. Any path or link target that matches the secret scan is shown as `<withheld>` with the start of its hash; the summary shows `<withheld>` alone.
- `--json` prints the input manifest (§1.13), or the stop or instability as JSON, with changed paths recorded like manifest paths (`pathHash` when they match the secret scan). It goes to standard output even when the command exits with 1.
- When the destination rule stops the session, or a file changes after capture, it prints the explanation and `Nothing was sent.`, and exits with 1. Usage errors exit with 2. Errors are one plain sentence; `--debug` adds the stack trace.
- Lines stay within 80 columns, except where a single path is longer than the line.

### 2.5 Findings

A grouped overview, shown once, before questions:

```text
INSPECT · findings

Commands  (found in manifests, not run)
  ● pnpm test         package.json:12
  ● pnpm lint         package.json:14
  ● just migrate      justfile:8

Structure
  ● Frontend in apps/web, API in services/api      documented · 2 sources
  ● Generated API client in packages/api-client    observed · 3 sources

Conventions
  ● New UI components live in apps/web/src/features   observed · 5 sources

Conflicts  (1)
  ▲ API requests: CLAUDE.md says fetch; docs/architecture.md says
    generated client; code uses both

Gaps  (2)
  ○ No lint command found for services/api
  ○ Not inspected: services/worker (listed, not read)

  [Enter] Continue to questions   [e] Show evidence for an item
  [w] Mark a finding as wrong   [q] Save and quit
```

- Basis labels are always words: **documented**, **observed**, **existing guidance**, **your decision**.
- Symbols: `●` finding, `▲` conflict, `○` gap or not inspected. Each is paired with its group name, so colour and symbol are never the only signal.
- `e` shows the cited excerpts with paths and line numbers.
- `w` records a **correction**: the developer says what is wrong in a short note. It becomes a `developer_correction` decision. The finding is kept, marked "corrected by you", and is not used to support recommendations.

### 2.6 Clarify

Questions are asked one at a time, up to the question budget:

```text
CLARIFY · step 2 of 5 · question 1 of 4

How should new frontend code make API requests?

Why we're asking: your existing CLAUDE.md, your architecture doc and
the code disagree (see conflict above).

  1  Always use the generated client in packages/api-client
  2  Use the generated client, with exceptions (you'll describe them)
  3  Direct fetch is fine
  4  Something else (type your answer)

  [1-4] Answer   [e] Show evidence   [s] Skip   [q] Save and quit
```

- Options are suggestions. Choosing one, or typing an answer, leads to a **confirmation** of the decision as it will be recorded:

```text
Record this decision?

  "New frontend code uses the generated client in packages/api-client,
   except for streaming requests."
  Applies to: apps/web

  [y] Record   [e] Edit wording   [p] Change scope   [b] Back
```

- **Skip** leaves the question unresolved. The screen says so: "Recommendations that depend on this will be held back."
- After the last question, or when the budget is reached, a summary lists recorded decisions and skipped questions. Questions not presented are recorded as `unreached`, with reason `budget` if they ranked beyond it (§3.3.4) and `session_ended` otherwise ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §8.1).

### 2.7 Recommendations

**Overview first:**

```text
RECOMMEND · step 3 of 5

7 recommendations for CLAUDE.md
  4 add · 2 revise · 1 remove
  2 held back: they depend on a skipped question or an unresolved conflict

  [Enter] Review one by one   [h] Show held-back items   [q] Save and quit
```

**Then one recommendation at a time:**

```text
RECOMMEND · 2 of 7 · revise

Section: Conventions › item 3

  Current:   Use fetch for API requests.
  Proposed:  Use the generated client in packages/api-client for API
             requests in apps/web. Streaming requests may use fetch.

Why: replaces outdated guidance with your recorded decision.

Based on
  • your decision (question 1)
  • documented: docs/architecture.md:42-51
  • existing guidance being replaced: CLAUDE.md, Conventions item 3

References
  • packages/api-client      exists

  [a] Accept   [r] Reject   [e] Edit wording   [v] View evidence
  [n] Next   [p] Previous   [q] Save and quit
```

- Commands are always labelled **found, not run**.
- **Edit** opens the wording in `$EDITOR` (or an inline editor if it is unset). On save, the new revision is validated ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §9.1). Failures are shown with the reason, for example "Mentions `src/api.ts`, which doesn't exist in this repository". The developer can edit again or discard the edit.
- If two recommendations target the same block, accepting one shows: "This replaces the same text as recommendation 5, which can't also be accepted," and leaves recommendation 5 unchanged.
- **Accept remaining:** after at least one item has been reviewed individually, `A` accepts all remaining **add** recommendations, after showing a list of them. Revisions and removals always need individual decisions, because they change existing guidance.
- When all items have a decision, the CLI moves to final review. If none were accepted, it offers to finish without changes (§2.10).

### 2.8 Final review

```text
REVIEW · step 4 of 5

CLAUDE.md · 5 accepted changes · +18 −3 lines

Still unresolved (not included in this file)
  ○ No lint command found for services/api
  ○ Skipped: "Which checks must run before changing migrations?"

  [d] Show diff   [f] Show full file   [Enter] Approve and write
  [b] Back to recommendations   [q] Save and quit
```

- The diff marks each change with its recommendation number, for example `[R2]`, so every changed line can be traced. The full file view shows the complete proposed content.
- **Approve** shows a final confirmation with the exact target and content:

```text
Write CLAUDE.md?

  Path:    /Users/thanos/code/acme/CLAUDE.md  (replaces existing file)
  Size:    3,912 bytes
  Content: sha256:9f2c…41ab

  [y/N]
```

The default is **no**. `y` records the review and starts the apply step. `N` returns to the review screen.

### 2.9 Apply

The CLI runs the freshness checks ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §11.1) and reports the result.

**Blocked:**

```text
Can't write yet: the repository changed in ways that affect this proposal.

  • CLAUDE.md was edited since inspection
  • packages/api-client/src/index.ts changed (cited as evidence)

  [r] Refresh analysis   [q] Save and quit
```

Refresh takes a new snapshot and re-runs analysis. Existing decisions are carried forward and revalidated against the new snapshot. Decisions that no longer apply are shown for review.

**Warning:**

```text
Some files changed since inspection. None of them support this proposal.

  apps/web/src/features/search/SearchBar.tsx
  apps/web/src/features/search/useSearch.ts

Type "acknowledge" to write anyway, or [r] to refresh first.
```

The acknowledgement and the listed paths are recorded on the apply attempt.

**Success:**

```text
DONE · step 5 of 5

Wrote CLAUDE.md (3,912 bytes, sha256:9f2c…41ab)

  5 changes applied · 2 recommendations rejected · 2 items unresolved
  Model usage: 92,410 input / 11,830 output tokens · cost $0.41 (reported)
  Your time: about 14 min answering and reviewing   [c] Correct this

The file has not been committed. Review it in your editor and
commit when you're ready.

  [x] Export session   [Enter] Exit
```

The tool never commits, stages or pushes.

### 2.10 No change

If every recommendation is rejected, or none are justified:

```text
DONE · no changes

Your existing CLAUDE.md was kept as it is.

  0 changes · 4 recommendations rejected · 1 item unresolved
```

No write occurs, and the session outcome is `no_change`. Findings, decisions and rejected recommendations remain in the session and the export.

### 2.11 Resume

`resume` shows where the session stopped and checks for changes before continuing:

```text
Resuming ses_01J… · stage: REVIEW · last active 2 hours ago

Repository check: 3 files changed since inspection, none cited.
```

- If a blocking change is found, the developer is offered a refresh before continuing.
- **Interrupted apply:** the destination is checked against the recovery table ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §11.2). The CLI reports one of: "The write had completed. Nothing more to do." / "The write didn't happen. You can approve and write again." / "CLAUDE.md now contains something else. Review it before continuing."

### 2.12 Errors and limits

| Situation | What the developer sees |
|---|---|
| Model call fails (network, rate limit, server error) | Plain explanation, automatic retries (bounded), then `[r] Retry` or `[q] Save and quit`. Progress is kept. |
| Model output fails validation | "Some results couldn't be verified against your repository and were left out," with a count and `[v] Details`. Never shown as findings. |
| All output from a call fails validation | Retry offered once, then the stage can be skipped (no findings or recommendations from it) or the session saved. |
| Generation budget reached | What was completed is kept; what remains is listed; the developer can raise the budget and continue, or proceed with what exists. |
| Session locked by another process | Names the process ID, if available, and exits without changes. |
| Session saved by a newer version | Names the session format, the version that wrote it, and the version to update to (§4.9). |
| Session saved in an older format | Before v0.1.0, says older sessions aren't converted and tells the developer to start a new one with `init` (§4.9). |

Messages state what happened, what was kept, and what the developer can do. They never print stack traces by default; `--debug` adds them.

### 2.13 Measuring effort

Every prompt that waits for the developer records an effort interval ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13.2): entered when the prompt is shown, left when it is answered. Time spent in `$EDITOR` counts as effort.

At completion, the total is shown with the method, and `[c]` lets the developer correct it. A correction is recorded with its reason, and the export reports both values.

### 2.14 Verification

- Nothing is sent before the data notice is confirmed (first run) and the "What we read" summary is accepted.
- Every screen shows stage, position and session ID; `q` works on every prompt; `resume` returns to the same point.
- Status is never conveyed by colour alone; output is readable with `NO_COLOR` and at 80 columns.
- No path writes the destination without an approval of the exact content hash, and the confirmation defaults to no.
- Bulk acceptance never includes `revise` or `remove`, and is available only after one individual decision.
- Edited wording is revalidated, and invalid edits cannot be accepted.
- Skipped questions hold back dependent recommendations, and the screen says so.
- Blocked freshness offers refresh only; warnings require the typed acknowledgement.
- The tool never runs Git commands that change the repository.
- Interrupted applies show the correct recovery message for each destination state.
- Interactive commands exit without changes when not attached to a TTY.

### 2.15 Open points for this section

- Prompt library choice (for example a lightweight prompt library versus a full terminal UI framework). The screens above should drive the choice, not the reverse.
- Diff rendering in narrow terminals.
- Whether `w` (mark a finding as wrong) should also be offered from the recommendation screen.
- Product and command name.

---

## 3. Model calls and schemas

### 3.1 Principles

1. **The model never asserts what code can establish.** Every output field is either model judgement or a fact that code determines and attaches.

   | Model judgement | Established by code |
   |---|---|
   | Finding statements, uncertainty notes | Record IDs and alias mapping |
   | Which lines to cite, and a verbatim quote | Path, file hash, excerpt text, evidence basis |
   | Gap and absence-claim proposals | Absence wording, `not_inspected` relabelling |
   | Questions, options, reasons | Question priority and budget trimming |
   | Recommendation wording, rationale, `fact`/`policy` declaration | Block IDs and hashes, reference verification, command status |
   | Proposed expansion requests | Expansion validation and execution |

2. **Shape is guaranteed; truth is checked.** Structured outputs constrain the response to the schema. They say nothing about whether a citation is real or a claim is supported. Every response passes the full validation pipeline (§3.5).

3. **Provenance and support are different checks.**
   - *Provenance:* the quoted text exists, at the stated place, in content that was actually sent (§3.2.2).
   - *Support:* the cited content justifies the claim made about it (§3.2.3).

   Finding the quote proves where it came from. It does not prove the claim. Code checks what it can about support. The rest is checked by the developer at review, and measured in evaluation.

4. **No item-level repair.** Items that fail validation are dropped and recorded, never sent back to the model to be fixed. The single exception is the line-range correction in §3.2.2, which changes only line numbers and is recorded.

5. **Repository content is data, not instructions.** Every prompt says so. Suspected instructions found in content are reported, never followed (§3.3.2).

### 3.2 Shared conventions

#### 3.2.1 Aliases

The model refers to records only by short aliases. Code maps each alias to a real ID and records the mapping on the model call.

| Alias | Refers to | Appears in |
|---|---|---|
| `T<tier>-<n>`, `E-<n>` | Context items and expansion items (§1.6, §1.8) | Calls 1–2 |
| `F-<n>` | Validated findings, including gaps and accepted absence claims; in call 1, the known facts sent (§3.2.5) | Calls 1–5 |
| `C-<n>` | Validated conflicts | Calls 2–5 |
| `Q-<n>` | Questions | Calls 4–5 |
| `D-<n>` | Current decisions | Calls 4–5 |
| `R-<n>` | Existing recommendations | Call 5 |
| `B-<n>` | Destination Guidance Blocks | Calls 1–5 |

**Alias tables.** Code builds one table per call and records it on the model call ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13.1). `T` aliases are the item IDs as rendered (`T5-007`, §1.6). The others are numbered from 1 without padding, in an order the caller fixes, so the same input always gives the same table: `B` in document order (§1.6), `E` in expansion order (§1.8), and records in the order of §3.2.6, except that `F` numbers the known facts sent first, in their order (§3.2.5). A table holds only the kinds its call accepts, except that call 1's holds the `F` aliases of the known facts sent, which no call-1 field accepts: using one fails `ALIAS-003`.

New items in a response use response-local keys: `f1`, `g1`, `a1`, `c1`, `q1`, `r1`. A local key is valid only inside that response, and is never in the alias table.

Aliases and keys match exactly: no change of case, no trimming, no change of padding, so `T5-7` is not `T5-007`.

| Rule | Check | On failure |
|---|---|---|
| `ALIAS-001` | Every alias in a response exists in that call's table, and every local key it refers to is defined in the same response. | Reject the item that uses it |
| `ALIAS-002` | No local key is defined twice in one response. | Reject every item with that key |
| `ALIAS-003` | Every alias is of a kind its field accepts, for example `F` or `D` in `recommend` `support`. | Reject the item that uses it; for a citation's `item`, the citation alone (§3.2.2) |

A reference to a local key whose item was rejected fails the referring item's own rule, for example `CONF-001`, not an alias rule.

Block IDs and hashes are never sent to or returned by the model. Code maps each `B` alias to the block ID and hash from the snapshot.

#### 3.2.2 Citations and provenance

Only calls 1 and 2 create citations. Later calls refer to validated findings by alias.

```ts
type Citation = {
  item: string;   // "T5-007" or "E-2"
  lines: string;  // "40-52"; a single line is "40-40"
  quote: string;  // verbatim text from within those lines
};
```

**Quote rules.** The quote is at least 12 characters and not only whitespace, punctuation or symbols (Unicode `White_Space`, `P` and `S`), counted in code points after the delimiter escape is reversed (`CIT-007`). Provisionally, format characters and combining marks (Unicode `Cf`, `Mn`, `Me`) are left out of both tests, because they are invisible on their own; they still count for matching. It is at most 200 characters (`LIMIT-001`), and may span lines using `\n`. It must match the sent content **exactly**: no normalisation of whitespace, case or punctuation. The quote is compared with the file's own text: the delimiter escape is reversed on the quote (§1.6), and the cited lines are joined with `\n` whatever the file's line endings.

**Sent lines** are an item's numbered `CONTENT` lines within its `included` ranges. Header attributes, `OUTLINE` labels, the destination's `BLOCKS` lines and `…` lines are never sent lines: they can't be cited, and the search in step 7 doesn't cover them. Ignored, excluded, secret-blocked, unreadable and symbolic-link entries have no item at all, so a citation of one fails `CIT-001`.

**Validation**, in order:

1. **Quote.** The quote rules above (`CIT-007`).
2. **Item.** The item alias exists in this call's input (`CIT-001`). An alias in the table that isn't a `T` or `E` alias, or a local key the response defines, fails `ALIAS-003`, as in §3.2.1. Either rejects the citation, not the finding.
3. **File currency.** The cited file's current hash matches the snapshot hash recorded for the item (`CIT-002`). Code reads the current hashes before validation; a file that can't be read again counts as changed. A mismatch rejects the citation, and its event records the path, so the session marks the snapshot as unstable.
4. **Sent content.** The item has at least one sent line (`CIT-006`). An outline-only item (§1.6) has none: its outline shows what exists, not what it contains.
5. **Range.** `start ≤ end`, and the whole range lies within the item's sent lines, not omitted outline entries (`CIT-003`).
6. **Quote in range.** If the quote occurs exactly within the text of the cited lines, the citation is accepted. A quote holding a lone surrogate, half of a character, occurs nowhere (`CIT-004`).
7. **Line-range correction.** Otherwise, code counts exact occurrences of the quote in **all sent lines of that same item in this call**. It searches no other item, no other file, and no unsent content. Overlapping occurrences count separately, and an occurrence lies within one run of consecutive sent lines: it never spans the omitted lines between two included ranges. A `\n` in a quote stands for the break between two lines, so an occurrence that starts or ends with one spans both of them; a line ending after the last line of a run is not part of the text, so a quote ending with `\n` there doesn't occur.
   - **Exactly one occurrence:** the range is corrected to the lines that occurrence spans. The quote and the claim are not changed. Both ranges are recorded: `{ originalLines, correctedLines, rule: "CIT-R01" }`.
   - **Zero occurrences** (including text that is only slightly different, or present only in unsent parts of the file): reject (`CIT-004`).
   - **Two or more occurrences:** reject (`CIT-005`).
8. **Range length.** Provisionally, the final range, after any correction, is at most 40 lines (`CIT-010`). Excerpts are never truncated, so a longer range is rejected rather than cut.
9. **Evidence creation.** Code creates the Evidence record: path, file hash, final line range, basis (§3.2.4), and an excerpt **extracted by code** from the sent lines of that range: the file's text for those lines, joined with `\n`. The model never supplies excerpt text.

**Duplicates.** A citation with the same path and final range as an earlier accepted citation of the same finding is merged into it: the earlier one is kept, and the later one is rejected as a sub-item (`CIT-009`) after its own events, such as a `CIT-R01` correction. Overlapping but different ranges are kept. A merged citation counts towards the finding's `droppedCitations`.

A rejected citation drops only itself (§3.5). A finding whose citations are all rejected is rejected with `CIT-008`, after the events of its citations.

The corrected-citation rate is recorded per call, with the `analyse` and `analyse_expansion` item validation (§3.3.2–§3.3.3): the number of `CIT-R01` events divided by the number of citations that reached the citation check, across all the call's findings. A finding rejected before its citations are checked, by `ALIAS-002` or `LIMIT-001`, contributes none. The citations proposed in the call, across all its findings, are recorded as a separate count, unknown with the reason `schema_failed` when the response failed the schema. A corrected citation counts even if it is later merged as a duplicate or its finding is rejected; a citation whose correction would exceed 40 lines is a `CIT-010` rejection, not a correction. Merged duplicates are counted separately, as the `CIT-009` entry of the call's rejections by rule (§3.5). The rate is not the §3.5 `corrected` count, which counts accepted findings, not citations. Unknown is never zero: if the response failed the schema the rate is unknown with the reason `schema_failed`, and if no citation reached the check it is unknown with the reason `no_citations`. A rising rate is a signal to investigate the prompt or the rendering format.

#### 3.2.3 Support checks

These run after provenance and check what code can about whether citations justify the claim. They don't prove a claim is right. They catch claims that clearly go beyond their evidence.

They apply to each finding's `statement`, using the evidence of its accepted citations (§3.2.2), in rule order; the first failure rejects the finding. Gaps, absence claims and conflict descriptions are not checked by `SUP-001` to `SUP-004`.

| Rule | Check | On failure |
|---|---|---|
| `SUP-001` Anchoring | Every inline-code token and path-like token in a statement appears in at least one cited excerpt, or is a listed path (§1.11). | Reject |
| `SUP-002` No model counts | A statement contains no quantity or frequency the model counted ("5 components", "most files"). Numbers are allowed only if they appear in a cited excerpt. Code computes and displays "seen in N cited files". | Reject |
| `SUP-003` No universal claims from samples | A `descriptive` finding whose citations are all `code_observation` must not use universal quantifiers (*all*, *every*, *always*, *never*, *none*, *only*). Samples support "some" or "in the files inspected", not "all". | Reject |
| `SUP-004` Prescriptive needs a prescriptive source | A `prescriptive` finding needs at least one citation with basis `documentation` or `existing_guidance` whose excerpt contains directive language (versioned word list: *must, should, always, never, do not, don't, required, prefer, use … instead*). | Reject |
| `SUP-005` Conflicts need distinct sources | Every member finding of a conflict cites at least one file that not every other member cites, so no side rests only on sources the others share. With at least two members (`CONF-001`), that means at least two files. A context item and an expansion item of the same file are one source. | Reject the conflict |

**Tokens.** An inline-code token is the text between a pair of backticks, pairing from the left, so two adjacent backticks are an empty token; a last unpaired backtick is plain text. A path-like token is a whitespace-separated word, after removing any leading `(`, `"` or `'` and any trailing `.,;:!?)"'`, that contains `/` and whose last segment ends in a file extension: a dot and 1–10 ASCII letters or digits (§3.4). A URL ending in a file extension is path-like. A token appears in an excerpt when it is an exact, case-sensitive substring of any cited excerpt. It is a listed path when, after the path normalisation of §1.11, it equals a listed entry or a directory containing entries, ignoring one trailing `/`, and is not itself withheld; a directory whose only entries are withheld is listed, because its own name is not.

**Words and numbers.** `SUP-002` and `SUP-003` check the statement without its inline-code and path-like tokens, which `SUP-001` has already checked. Words match whole, case-insensitively: a letter, digit or underscore next to a match makes it part of another word, so *install* doesn't hold *all* and *fewer* isn't *few*. Inflections don't match.

- `SUP-002`, numbers: each run of Unicode decimal digits (`Nd`) must occur in a cited excerpt as a whole run, not inside a longer one, so `500` isn't found in `5000`. Digits match as written: `５` (fullwidth) is not `5`. Spelled numbers (*two* to *twelve*, *dozen*, *dozens*, *hundred*, *hundreds*, *thousand*, *thousands*) are allowed when a cited excerpt holds the same word. *One* is not on the list, because it is too often a pronoun.
- `SUP-002`, quantities, always rejected: *most, many, several, few, numerous, majority, minority, half, mostly, usually, often, typically, frequently, rarely, seldom, multiple*.
- `SUP-004`: *do not* matches with spaces or tabs between the words, and *don't* with `'` or `’`. *Use … instead* matches when the word *use* is followed by the word *instead* on the same excerpt line.

Event details name the rule's list entry, such as `counted quantity "most"`, never text from the statement.

Anything these rules can't check is shown to the developer. Every finding is displayed with its excerpts, labelled **"source checked"**, never "verified". The developer can mark a finding as wrong (§2.5). Evaluation measures support accuracy separately. A model-based support check is a possible later addition, adopted only if evaluation shows it helps.

#### 3.2.4 Evidence basis

Basis is derived by code from the tier the cited file belongs to (§1.5), whether it reached the model through the initial context or through expansion. The model never chooses it. For basis, a file belongs to the first tier whose patterns match its path, whether or not it is a candidate; failing that, to tier 1 if an `@path` import resolves to it. So a `listed_only` `docs/architecture.md` read by line range is `documentation`, and a `listed_only` file under `.claude/` is `existing_guidance`. An import counts when it resolves, as in §1.5, to a `read` or `listed_only` entry. Selection ignores the `listed_only` ones, because they aren't candidates, and their own imports are never followed, because they are never read.

| File belongs to | Basis |
|---|---|
| Tier 1 (agent configuration, including the destination and `@path` imports) | `existing_guidance` |
| Tier 2 (documentation) | `documentation` |
| Tier 3, tier 5, or no tier | `code_observation` |

The table applies to `lines` evidence. Evidence that only shows what the file list holds, `entry` evidence (§3.2.5) and `absence_check` evidence (§4.5), is always `code_observation`, whatever tier the file belongs to: it observes that a file exists, or that none matches, and says nothing about what a document or configuration file prescribes.

An imported file that tier 2, 3 or 5 matches stays in that tier (§1.5), so `@package.json` is `code_observation`. A file that matches no tier's patterns and isn't imported, such as a changelog or a Markdown file under `src/`, is `code_observation`; an imported changelog is `existing_guidance`.

A finding's basis is the set of its citations' bases.

Consequence: a code comment such as "always use X" is a `code_observation`. It can raise a question, but it cannot support a `prescriptive` finding until the developer confirms it. This is deliberately conservative.

#### 3.2.5 Known facts

Before call 1, code extracts facts it can determine without a model, and records them as `claim` findings with `mode: descriptive`, `producedBy: deterministic`, code-generated wording, and evidence that code creates from content verified against the snapshot hash ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.2). Each evidence's basis follows §3.2.4, so `entry` evidence is `code_observation`. If a file's content no longer matches its hash, the snapshot is unstable, as in selection (§1.3).

| Fact | From | Statement | Scope | Evidence |
|---|---|---|---|---|
| Agent configuration | Each `read` or `listed_only` entry that tier 1's patterns match (§1.5), the destination included | `` `X` is existing agent configuration. `` | repository | `entry` for `X` |
| Imported agent configuration | Each entry that belongs to tier 1 only through an import (§3.2.4) | `` `X` is imported by `Y`. ``, where `Y` is the first file found importing it in resolution order (§1.5) | repository | `entry` for `X` |
| Workspace package | Each declared workspace member (§1.5, packages, step 1); inferred packages are not facts | `` `P` is a workspace package declared in `S`. ``, where `S` is the first of the root `package.json`, `lerna.json` and `pnpm-workspace.yaml` whose own patterns, without `!`, match `P` | `P` | `entry` for `S` and for `P/package.json` |
| Command | The manifests below | `` `F` defines the script `N`. ``, or *target*, *recipe* or *task* | The declared member that contains `F`, or repository | `lines`: the lines that define `N` |

**Commands** are read from `read` entries:

- **`package.json`**, at the root and directly inside each declared member: each member of the top-level `scripts` object whose value is a string (*script*). A key that appears twice counts once, at its last occurrence, which is the one `JSON.parse` keeps. A leading byte order mark is ignored. The evidence runs from the key's line to the line where its value ends.
- **`pyproject.toml`**, at the root and directly inside each declared member: each key in the tables `[project.scripts]` and `[tool.poetry.scripts]` (*script*), written `key = …` on a line of its own, bare (ASCII letters, digits, `_` and `-`) or quoted without escapes, with optional indentation and spaces around `=`. A table header may have spaces just inside its brackets and a trailing comment, and the table ends at the next line starting with `[`, a subtable such as `[project.scripts.more]` included. Inline tables and dotted keys are not read.
- **Makefile**: a root file named `makefile`, ASCII letters compared case-insensitively (*target*). A target line starts with a character other than a tab, a space or `#`, is outside `define` … `endef` (a `define` line may be indented and prefixed with `override`, `export` or `private`), doesn't start with a directive (`include`, `-include`, `sinclude`, `vpath`, `export`, `unexport`, `override`, `private`, `define`, `undefine`, `ifeq`, `ifneq`, `ifdef`, `ifndef`, `else`, `endif`) followed by whitespace or the end of the line, and has a `:` with no `=` before it and no `=`, `:=` or `::=` straight after it, which would make it an assignment. Each whitespace-separated word before the `:` is a target, except special targets starting with `.`, pattern rules holding `%`, names holding `$`, and the grouped-target marker `&`. A line continued with `\` is read from its first line only.
- **`justfile`**: a root file named `justfile`, compared the same way (*recipe*). Lines starting with `mod` or `import`, with an optional `?`, followed by a space or tab, are not recipes. A recipe line starts with an optional `@` and a name of ASCII letters, digits, `_` and `-` that starts with a letter or `_`, then optional parameters after whitespace, then the first `:` after the name, which must not be followed by `=`. A recipe whose name starts with `_` is left out, and so is one directly after a run of attribute lines (lines starting with `[`) one of which holds `private` with no ASCII letter, digit, `_` or `-` next to it. Any other line, blank or comment included, ends the run.
- **Taskfile**: a root file named `taskfile.yml` or `taskfile.yaml`, compared the same way (*task*). After a line `tasks:` at the start of a line, with optional trailing spaces and comment, the tasks are the keys at the indentation of the first following line that isn't blank or a comment, written `name:` and followed by the end of the line, a space or a tab: plain, holding no `:` or `#` and not ending with whitespace, or quoted without escapes. The merge key `<<` is not a task, and deeper lines are not keys. The mapping ends at the next such line with no indentation.

A name or path that is empty, starts or ends with whitespace, or holds a backtick or a control character (Unicode `Cc`) can't be written as one inline code span, so it gives no fact: no command with that name, and no fact naming that entry or importer. Each name gives one fact per file, at its first defining line except in `package.json`. Outside `package.json`, the evidence is that one line: no recipe body, and only the first line of a continued line. Commands always have the status `found_not_run`.

**Gaps.** Deterministic `gap` findings, `gapType: other`:

- a manifest above that is `listed_only`, isn't valid UTF-8, or, for `package.json`, isn't valid JSON: `` `F` could not be read or parsed, so its commands are not known facts. ``;
- each fact's statement and excerpt pass the secret scan (§1.7). A fact that matches isn't created, and one gap per file says `` A known fact from `F` was withheld because it matched the secret scan. ``

An entry whose path the secret scan withholds gives no fact and no gap.

**Order.** Facts with repository scope come first, then the others by scope path. Within a scope: agent configuration, imported or not, by path depth then path order; then workspace packages; then commands, by file path, then by first evidence line, then in order along the line, as in `build test:`. Gaps follow the file path order.

*Resolution order*, for "the first file found importing it": imports are followed breadth-first, from the destination and then the other tier 1 files in path order, each file's imports in the order they appear (§1.5).

**Section.** The facts are sent first in the context, before tier 1, in a section of their own within `knownFactsBytes` (default 10,000, provisional), counted in rendered UTF-8 bytes, frame included. The frame is rendered even when there are no facts. Facts are tried in order; one whose rendering doesn't fit the remaining bytes is left out, and later facts that fit are still sent, as in the tiers (§1.5). The context's gaps are listed in this order: selection's (§1.5), then extraction's in file path order, then the budget gap. If any fact is left out, the budget gap, `gapType: other` with no related paths, says `` 3 known facts were left out because of the known-facts budget. `` (`1 known fact was` for one). The facts sent are numbered `F-1`, `F-2`, … in order (§3.2.1). Every fact is still recorded as a finding, sent or not.

```text
<<<KNOWN FACTS>>>
F-1  [observed · code_observation]  scope: repository
     `CLAUDE.md` is existing agent configuration.
     evidence: CLAUDE.md (file)
F-2  [observed · code_observation]  scope: repository
     `package.json` defines the script `test`.
     evidence: package.json:5-5
       | "test": "vitest run",
<<<END KNOWN FACTS>>>
```

Each fact follows §3.2.6: its alias, its basis as label words and values, each joined with `, ` (§2.5), and its scope; its statement; then one `evidence:` line per evidence, `path (file)` for `entry` evidence, or `path:a-b` followed by the excerpt lines, each after `       | `. Every line ends with a line break, and the delimiter escape (§1.6) applies to every line between the frame lines. The section is part of the rendered context, so `contextHash` covers it.

The model must not restate them as new findings; restatements are dropped as duplicates (`DUP-002`).

#### 3.2.6 Rendering validated records

Calls 2–5 receive validated records in a compact, fixed format:

```text
F-3  [observed · code_observation]  scope: apps/web
     Some components in apps/web call fetch directly.
     evidence: apps/web/src/features/search/useSearch.ts:14-22
       | const res = await fetch(`/api/search?q=${q}`);
```

Records are ordered by alias. Excerpts are code-extracted and pass the secret scan before each call (§1.7).

### 3.3 Calls

Every call has a fixed purpose, input, output schema, validation sequence and output limit. Schemas below are written as TypeScript types. Implementation defines them in Zod and generates JSON Schema from them (§3.7). Unknown fields are rejected everywhere.

- **Lengths** count Unicode code points. Every string has a maximum: the one stated, or for a path or glob 512, for an alias or alias reference 16, for a reference `value` 512, for a line range 32, for an expansion range list 512, for a `B` target 16. A local key's pattern limits it to five characters.
- **Patterns.** Response-local keys match their letter and a number from 1 to 9999 (`^f[1-9][0-9]{0,3}$` for findings, and `g`, `a`, `c`, `q`, `r`). Line ranges are `^[1-9][0-9]*-[1-9][0-9]*$`. Expansion ranges are one or more line ranges separated by commas. `B` targets are `^B-[1-9][0-9]*$`. Alias references (`support`, `resolves`, `blockedBy`, a citation's `item`, a conflict's `findings`, a revision's `target`) have no pattern, so a wrong alias rejects one item (`ALIAS-001`, `ALIAS-003`), or for a citation's `item` one citation (`CIT-001`, `ALIAS-003`, §3.2.2), not the response.
- **Where limits apply.** The size of a top-level collection, such as at most 40 findings, and the length of a top-level string that belongs to no item, such as `noChangeReason`, are checked at the schema stage, and fail the response. A length or size inside one item, such as a statement's 300 characters or a finding's 1–6 citations, rejects only that item (`LIMIT-001`, §3.5).

#### 3.3.1 Overview

| Call | Purpose | Creates |
|---|---|---|
| `analyse` | Understand the repository from the initial context | Findings, gaps, absence claims, conflicts, expansion requests |
| `analyse_expansion` | Refine understanding with expansion results | New findings, withdrawals and replacements |
| `generate_questions` | Ask about intent the evidence cannot establish | Questions |
| `recommend` | Propose changes to `CLAUDE.md` | Recommendation revisions, held-back topics |
| `regenerate_recommendations` | Reconsider recommendations affected by a change | Keep, revise or drop decisions; new recommendations |

#### 3.3.2 `analyse`

**Input:** system prompt; known facts (§3.2.5); destination blocks `B-*`; the initial context (§1.5–§1.6).

**Output:**

```ts
type AnalyseOutput = {
  findings: Array<{            // max 40
    key: string;               // "f1"
    statement: string;         // ≤ 300
    mode: "descriptive" | "prescriptive";
    scope: { kind: "repository" } | { kind: "paths"; paths: string[] };  // 1–10 paths
    citations: Citation[];     // 1–6
    uncertainty?: string;      // ≤ 200
  }>;
  gaps: Array<{                // max 15
    key: string;               // "g1"
    statement: string;         // ≤ 300
    gapType: "no_command" | "no_documentation" | "undetermined_ownership"
           | "undetermined_convention" | "other";
    relatedPaths: string[];    // 1–10 paths or globs
  }>;
  absenceClaims: Array<{       // max 10
    key: string;               // "a1"
    pathGlob: string;
    reason: string;            // ≤ 200; not shown as the claim (§1.11)
  }>;
  conflicts: Array<{           // max 10
    key: string;               // "c1"
    description: string;       // ≤ 300
    findings: string[];        // 2–10 local keys
  }>;
  expansionRequests: ExpansionRequest[];  // max 5 (§1.8)
  contentNotices: Array<{      // max 10
    item: string;
    lines: string;
    description: string;       // ≤ 200; e.g. "text instructs the reader to ignore prior rules"
  }>;
};

type ExpansionRequest =
  | {
      kind: "read";
      entries: Array<{         // 1–10
        path: string;
        lines?: string;        // "20-39,97-140"; absent reads the file excerpted (§1.8)
      }>;
      reason: string;          // ≤ 200
    }
  | {
      kind: "search";
      literal: string;         // ≤ 200; no regular expressions
      glob?: string;
      reason: string;          // ≤ 200
    };
```

A `Citation`'s `quote` is at most 200 characters in the schema; its other quote rules are checked as citations (§3.2.2). The schema allows five expansion requests, the default and ceiling of `maxExpansionRequests` (§1.8): a lower setting rejects the requests beyond it in response order, and a higher one needs a new schema version.

**Validation**, in order:

1. Schema (§3.5), then per-item limits (`LIMIT-001`).
2. Aliases (`ALIAS-001`, `ALIAS-002`, `ALIAS-003`), except citation items, which step 3 checks one citation at a time (§3.2.2), and content-notice items, which step 10 checks.
3. Citations: provenance (§3.2.2), then support (§3.2.3), then basis derivation (§3.2.4).
4. Scope paths: each path or glob matches a listed path that is not withheld (§1.11, `SCOPE-001`).
5. Gaps: each `relatedPath` is listed or uncovered; an unlisted one rejects the gap, which must be an absence claim instead (`GAP-001`). Then the coverage check: a related file not sent in full → relabel `not_inspected` (`GAP-002`, §1.11).
6. Absence claims: a glob holding a backtick, whitespace, a control or format character, or a `..` segment is rejected (`ABS-003`); then evaluated against the full file list (`ABS-001`, `ABS-002`), with code-generated wording (§1.11).
7. Duplicates, among the items that survived the item stage, in response order. A finding with the same normalised statement and the same scope as a known fact is dropped (`DUP-002`); otherwise one with the same normalised statement and scope as an earlier finding is dropped (`DUP-001`). A gap with the same normalised statement, `gapType` and set of normalised related paths as an earlier gap, and an absence claim with the same normalised glob as an earlier claim, are dropped (`DUP-001`). A **normalised statement** is the statement in Unicode NFC, with every run of `White_Space` replaced by one space and the ends trimmed; case is kept. Two scopes are the same when both are `repository`, or both hold the same set of paths after the path normalisation of §1.11, in any order. A reference to a dropped duplicate is redirected to the item kept: the earlier finding, or the known fact's `F` alias.
8. Conflicts: after redirection, each member counts once; at least two members are findings that survived validation, or `F` aliases; otherwise the conflict is rejected (`CONF-001`). Then `SUP-005`, over the members after redirection.
9. Expansion requests: the static checks of §1.8 (`LIMIT-002`, `EXP-001`, `EXP-006`, `EXP-002` to `EXP-005`). The byte budget and execution follow validation (§1.8).
10. Content notices: the item alias is a `T` or `E` item in this call's input (`CIT-001`, or `ALIAS-003` for an alias of another kind or a local key the response defines), and the cited lines must be sent lines of the item (`CIT-006`, `CIT-003`; §3.2.2). Valid notices are recorded as content-notice records that refer to the snapshot, which stays immutable (§4.4), and are shown in the findings view. They never change behaviour.

Steps 7 and 8 are the cross-item stage (§3.5), in that order; the others are item checks. The corrected-citation rate (§3.2.2) is recorded with the result.

#### 3.3.3 `analyse_expansion`

**Input:** everything from `analyse`, plus validated call-1 records as `F-*` and `C-*`, plus expansion items `E-*`.

**Output:**

```ts
type AnalyseExpansionOutput = {
  findings: AnalyseOutput["findings"];       // new findings, max 20
  gaps: AnalyseOutput["gaps"];               // max 10
  absenceClaims: AnalyseOutput["absenceClaims"];  // max 10
  conflicts: Array<{                         // max 10
    key: string;
    description: string;                     // ≤ 300
    findings: string[];                      // 2–10 local keys or F aliases
  }>;
  revisions: Array<                          // max 20
    | { target: string; action: "withdraw"; reason: string }   // target "F-3" or "C-1"
    | { target: string; action: "replace"; replacement: string; reason: string }
  >;                                         // replacement: a local key; reason ≤ 200
  contentNotices: AnalyseOutput["contentNotices"];  // max 10
};
```

There is no `expansionRequests` field; one expansion round only.

**Validation:** as for `analyse`, with these additions. The call-1 records are a required input: every `F` record the call-1 validation accepted and every known fact, in alias order, each with its kind (claim, gap or absence claim) and `producedBy`; and every call-1 conflict with its members. Validation can't run without them, so the duplicate and revision rules never depend on what a caller chose to pass. The records must be exactly the `F` and `C` aliases of the call's table; a mismatch is a bug in the caller, and validation refuses to run.

- Citations may target both `T*` and `E*` items.
- Conflict members are `f` keys or `F` aliases of claims. An `F` alias of a gap or an absence claim fails `ALIAS-003`, because it has no evidence to compare. An `F` member's sources, for `SUP-005`, are the paths of its validated evidence.
- A revision's `target` is an `F` or `C` alias. An `F` target is replaced only by an `f` key, and a `C` target only by a `c` key; a replacement of the other kind fails `ALIAS-003`. One replacement may stand for more than one target.
- Records produced by code (`producedBy: deterministic`), known facts and deterministic gaps alike, cannot be withdrawn or replaced by the model (`REV-002`, item stage).
- Revisions have no key of their own, so events and accepted lists name them by position, `revisions/<n>`.
- Duplicates (`DUP-001`) also compare new items with the call-1 records still passed forward, those no revision that survived the item stage withdraws or replaces; records code produced can't be revised, so they are always passed forward, and known facts are left to `DUP-002`, which runs first: findings with call-1 claims, gaps with call-1 gaps, and absence claims with call-1 absence claims, by the identities of §3.3.2 step 7. A new item that restates one is dropped, and references to it are redirected to that `F` alias.
- A second revision of the same target is rejected; the first is kept (`REV-003`, cross-item, after the duplicates).
- A `replace` requires its replacement to pass validation; otherwise the original is kept and the revision rejected (`REV-001`, cross-item, last, after `SUP-005`). A replacement dropped as a duplicate of another new item counts as that item; one redirected to an `F` alias fails `REV-001`.
- Withdrawn and replaced records are kept for history with their status, and are no longer passed forward. A call-1 conflict a surviving revision withdraws has the reason `withdrawn_by_model` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.5).
- Members are carried through the revisions that survived `REV-003`, for the new conflicts (before `CONF-001`) and for the call-1 conflicts no surviving revision withdraws or replaces: a withdrawn member is lost, and a replaced member's place goes to its replacement when that replacement is a surviving finding; otherwise the member is kept, since `REV-001` will keep the original.
- Any change to a call-1 conflict's member set, a member lost or replaced, runs `CONF-001` and then `SUP-005` on the new set. Failing `CONF-001` withdraws the conflict with reason `member_withdrawn` when a member was withdrawn, and `members_merged` when none was and one replacement now stands for several members; failing `SUP-005` withdraws it with reason `sources_not_distinct`. A conflict that passes both is revised: a new conflict revision with the new members supersedes the old one ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.5).
- Validation returns one outcome for every call-1 conflict, in alias order, the order in which the call-1 records must be given; a response that fails the schema accepts nothing, so every conflict is `kept`. The outcomes are: `kept` when nothing touches it; `revised`, with its new members; `replaced`, with the key of the new conflict that replaces it; or `withdrawn`, with its reason (`withdrawn_by_model` for a surviving `withdraw` revision). These are outcomes for call-1 records, not rejections of the response, so they are returned with the result rather than as validation events. The records themselves are created with persistence (§4.5).

#### 3.3.4 `generate_questions`

**Input:** validated findings, gaps and conflicts with their excerpts (§3.2.6); destination blocks; directory tree; the question budget.

**Output:**

```ts
type GenerateQuestionsOutput = {
  questions: Array<{          // max 20; trimmed to 2 × question budget below
    key: string;              // "q1"
    prompt: string;           // ≤ 200
    reason: string;           // ≤ 300
    resolves: string[];       // 1–10 F or C aliases
    scope: { kind: "repository" } | { kind: "paths"; paths: string[] };  // 1–10 paths
    options: Array<{ label: string }>;   // 0–4, each ≤ 120
  }>;
};
```

Every question accepts a typed answer and a skip; the schema doesn't model those. The schema's ceiling is fixed, because a schema can't depend on a session setting without changing its hash; valid questions ranked beyond twice the question budget are dropped and recorded (`LIMIT-002`).

**Validation:**

1. Schema and aliases.
2. **Asks about intent, not documented policy** (`Q-001`): `resolves` must include at least one unresolved conflict, gap, or finding without `documentation` basis. A question linked only to documented, uncontested findings is rejected. A finding whose basis includes `documentation` is documented; a documented finding that is a member of an unresolved conflict in the input is contested, and qualifies.
3. Scope paths are listed (§1.11, `SCOPE-001`).
4. Duplicates: questions with an identical `resolves` set, compared as a set, keep the first (`DUP-003`, cross-item).
5. Ranking (below), over every question that survived, then `LIMIT-002` (cross-item) on those ranked beyond twice the question budget, then the cut at the budget.

**Ranking**, by code:

1. questions that resolve an unresolved conflict;
2. questions that resolve a gap of type `no_command` or `undetermined_ownership`;
3. questions that resolve other gaps;
4. questions about observed conventions: every other valid question, which `Q-001` ties to a finding;
5. within each class, the model's order (recorded).

A question belongs to the first class it qualifies for. The top questions up to the budget are presented. The rest are recorded with status `unreached` and reason `budget`.

When the developer answers, code creates the Decision; the model is not called. Choosing an option or typing an answer goes through the confirmation step (§2.6).

#### 3.3.5 `recommend`

**Input:** validated findings with excerpts; conflicts with status; current decisions `D-*`; questions with status, including skipped and unreached; destination blocks with content (hashes are not sent); known facts; directory tree; limits.

**Output:**

```ts
type Target =
  | { kind: "block"; block: string }                    // revise, remove
  | { kind: "after"; block: string }                    // add after a block
  | { kind: "section"; heading: string }                // add at end of section; heading block alias
  | { kind: "newSection"; heading: string; after?: string };  // heading text ≤ 80

type RecommendOutput = {
  recommendations: Array<{    // max 15
    key: string;              // "r1"
    kind: "fact" | "policy";
    operation: "add" | "revise" | "remove";
    target: Target;
    content?: string;         // add, revise; ≤ 1,200
    rationale: string;        // ≤ 400
    support: string[];        // 1–10 F or D aliases
    references: Array<{       // 0–20
      kind: "path" | "command";
      value: string;
      support: string;        // F alias whose evidence contains the value
    }>;
    scope: { kind: "repository" } | { kind: "paths"; paths: string[] };  // 1–10 paths
  }>;
  heldBack: Array<{           // max 10
    topic: string;            // ≤ 200
    blockedBy: string[];      // 1–10 Q or C aliases
  }>;
  noChangeReason?: string;    // ≤ 400; only when recommendations is empty
};
```

**Validation**, in order:

1. Schema and aliases. All support must be current: not withdrawn, not superseded, not corrected by the developer, and of the active snapshot (`REC-001`, §4.4.2, §4.5).
2. **Operation and target.** `revise` and `remove` need a `block` target; `add` needs `after`, `section` or `newSection`; `remove` has no content (`REC-002`). Code attaches block IDs and hashes.
3. **Content shape**, by parsing the content (`REC-003`):
   - `revise`: exactly one block, of the same type as the target block; for a `list_item`, with the same marker and indentation as the target ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §7);
   - `add` with `after` or `section`: one to five blocks, of types paragraph, list item or code block, with no headings;
   - `add` with `newSection`: the same, plus the heading, which code renders from `heading`.
4. **Evidence rules** ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.4):
   - support from `existing_guidance` alone cannot justify a new recommendation (`REC-004`);
   - a `policy` recommendation needs a current decision, or a `prescriptive` finding with `documentation` basis that is not part of an unresolved conflict (`REC-005`);
   - a `fact` recommendation may cite only `descriptive` findings (`REC-006`).
5. **Directive-language guard** (`REC-007`). A `fact` recommendation whose content contains directive language (§3.2.3 word list), or a sentence beginning with an imperative verb from a versioned list (*Use, Prefer, Avoid, Always, Never, Run, Do not*), is rejected. This is the check against policy presented as fact. It is imperfect, and its misses are measured in evaluation through the invented-policy rate.
6. **Unresolved dependencies** (`REC-008`). A recommendation is rejected if any supporting finding is part of an unresolved conflict that no decision resolves, or if its only support is resolved by a skipped or unreached question. Such recommendations belong in `heldBack`.
7. **References**, using the detector (§3.4):
   - every path and command the detector finds in the content is declared, and every declared reference appears in the content (`REF-001`);
   - paths exist in the snapshot (`REF-002`);
   - commands match a known command or appear in a cited excerpt of the reference's supporting finding (`REF-003`);
   - each reference's supporting finding is in the recommendation's support (`REF-004`).
   Code sets each command's verification to `found_not_run`.
8. Scope paths are listed (§1.11, `SCOPE-001`).
9. **Duplicates:** identical target and content keep the first (`DUP-004`).
10. **Held back:** each `blockedBy` alias must refer to a skipped or unreached question, or an unresolved conflict. Entries that fail are dropped (`HELD-001`).
11. **No change:** `noChangeReason` is accepted only when `recommendations` is empty (`REC-009`). If every recommendation fails validation, the session shows that results couldn't be verified (§2.12). This is never presented as a no-change outcome.

Two recommendations targeting the same block are allowed in the output. Mutual exclusion is handled at selection ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §9.1).

#### 3.3.6 `regenerate_recommendations`

**When:** a decision is added, corrected or superseded after recommendations exist; or a refresh withdraws findings or changes blocks that recommendations depend on.

**Affected set**, computed by code: current recommendations whose support includes a changed or superseded decision, or a withdrawn or corrected finding (§4.5), or whose target block no longer matches its hash. Unaffected recommendations are not sent, and their selections are unchanged. An affected set larger than 30, the schema's `actions` ceiling, is split by code into calls of at most 30, in recommendation order; each call is validated on its own, and `REGEN-001` applies to the part each call was sent.

**Input:** everything `recommend` receives, plus the affected recommendations as `R-*` (target, content, support), plus a code-generated summary of what changed.

**Output:**

```ts
type RegenerateOutput = {
  actions: Array<             // max 30; every affected R exactly once
    | { target: string; action: "keep" | "drop"; reason: string }   // target "R-4"
    | {
        target: string;
        action: "revise";
        reason: string;                                          // ≤ 200
        revision: Omit<RecommendOutput["recommendations"][number], "key">;
      }
  >;
  additions: RecommendOutput["recommendations"];   // max 5
  heldBack: RecommendOutput["heldBack"];           // max 10
};
```

**Validation and effect:**

- Every affected recommendation must appear exactly once (`REGEN-001`). One that is missing is marked invalid, with reason "not reconsidered". It is never kept by default.
- **keep:** the existing revision is revalidated against the current state. If it fails, it is marked invalid. Its selection is unchanged only if it passes.
- **revise:** a new revision of the same `recommendationId`, fully validated as in §3.3.5. Its selection returns to `pending`.
- **drop:** the recommendation is withdrawn, and its selection history kept.
- **additions:** validated as in §3.3.5, with new IDs.

Any change creates a new artifact revision and requires fresh review ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §12).

### 3.4 Reference detector

A small deterministic component, versioned (`detectorVersion`), with its own fixtures. It finds references in recommendation content:

- **Inline code spans:**
  - path-like (contains `/`, or ends in a known file extension, and has no spaces) → `path`;
  - command-like (starts with a known runner: `npm`, `pnpm`, `yarn`, `npx`, `bun`, `make`, `just`, `task`, `python`, `pytest`, `uv`, `poetry`, `cargo`, `go`, `docker`, `./`) → `command`;
  - anything else is an identifier. Identifiers are not declared as references, but must appear in at least one excerpt of the recommendation's supporting findings (`REF-005`).
- **Fenced code blocks:** each non-empty line starting with a known runner → `command`.
- **Bare text:** tokens matching a path pattern (segments separated by `/`, ending in a file extension) → `path`.

The detector is deliberately conservative. Content it can't classify is left alone, not guessed at.

Paths it finds are matched against the snapshot (`REF-002`) after the path normalisation of §1.11: one leading `./` and one trailing `/` removed, and a path with a `..` segment naming nothing.

### 3.5 Validation pipeline and recording

For every call:

1. **Transport:** the response arrives (§3.6).
2. **Schema:** structured-output parse and Zod validation, with unknown fields rejected.
3. **Items:** the per-call sequence above, starting with the item's own limits: a string longer than its maximum, or an array inside the item outside its size, rejects the item (`LIMIT-001`), with a detail naming the field and the limit, never the value. Each item is validated independently. An item that fails one rule is dropped, and later rules are not run on it. A rule may instead correct an item (`CIT-R01`) or relabel it (`GAP-002`); the item continues with the changed value. A citation is a sub-item: a rejected citation drops only itself (§3.2.2), a finding is dropped when no citation is left, and an accepted finding records how many of its citations were dropped ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.3).
4. **Cross-item:** duplicates, conflicts, revisions, question ranking limits, held-back entries, regeneration coverage. These run only on items that passed the item stage, and may reject some of them.
5. **Persist:** accepted records, with `producedBy` pointing at the model call, and one record for every item rejected at the item or cross-item stage, with its text as written and the ID of the rule that rejected it (§4.4.3).

Every rejection or correction is recorded on the model call:

```ts
type ValidationEvent = {
  itemKey: string;     // response-local key or alias; "$response" at the schema stage;
                       // "f1/citations/2" for a citation (0-based index)
  stage: "schema" | "item" | "cross_item";
  rule: string;        // stable ID, e.g. "CIT-004"
  outcome: "rejected" | "corrected" | "relabelled";
  detail: string;      // code-generated; no source content
  original?: unknown;  // e.g. originalLines for CIT-R01
};
```

A schema failure rejects the whole response with one event per issue, in the order the schema reports them: `itemKey` is `$response`, `rule` is `SCHEMA`, and `detail` is the issue's path and code only, never the value received, because the model may have copied source text into it. A path segment that isn't a field name the schema defines, such as a record key, is written `<key>`. The proposed count is then unknown, with the reason `schema_failed`, never zero.

No event repeats text from the response. An `itemKey` is a local key or alias only when it is well formed (a local key is one or two lowercase letters and a number, an alias as in §3.2.1); otherwise the item is named by its position, `<collection>/<index>`, and a malformed local key defines nothing. An item with no key of its own, such as an expansion request, a content notice or a revision, is always named by its position. A detail names only code-made values, such as an alias from the table, never an unknown value the model wrote. A rejected item keeps the events of its sub-items, such as each failed citation. Events are ordered by stage. In the item stage they follow the response's item order, collections in schema order, and within an item the rule order, except that a sub-item's events are in sub-item order, each sub-item's in rule order; `ALIAS-002` is checked first, for each item in turn. In the cross-item stage they follow the order in which the call's cross-item checks run (§3.3.2–§3.3.4), then item order.

Each call also records counts: proposed, accepted, corrected and relabelled items, and rejections by rule. An item counts as corrected or relabelled if it was accepted with such an event. Rule IDs are stable across versions. The validator has its own version (`validatorVersion`, `validate/0.12.0` since the withdrawn reasons of v0.29), recorded with every call, because changing a rule changes what is accepted even when the model output is identical. Any change to what is accepted increases it, changed thresholds and word lists included. A test pins the list of rule IDs to the version, together with the runtime's Unicode version (`process.versions.unicode`), because `CIT-007`'s and `SUP-002`'s character classes follow it.

### 3.6 Retry and failure policy

| Failure | Handling |
|---|---|
| Network error, server error, timeout | Retry the identical request up to 3 times with exponential backoff. Then fail the call (§2.12). |
| Rate limit | Honour the provider's retry-after; counts towards the 3 retries. |
| Schema failure (including output truncated at the token limit, or a refusal) | One retry: the identical request plus a short message listing **schema errors only**. A second failure fails the call. |
| Item-level validation failure | No retry. Item dropped and recorded. |
| Every item rejected | The call is recorded as completed with zero accepted items. The CLI offers one fresh retry of the identical request (§2.12). |
| Generation budget would be exceeded | Before each call, the estimated cost is checked against the remaining budget. If it would be exceeded, the call is not sent, and the session stops at that point (§2.12). |

The schema-retry message lists each issue's path and code, as schema events do (§3.5), never the value received. It never includes semantic validation results. Telling the model which citations failed would teach it to make citations pass rather than be accurate.

Truncation is never fixed by raising the output limit automatically. Raising it is a settings change, and is recorded.

### 3.7 Prompts, schemas and versions

- **Prompts** are files in the repository, `prompts/<call>/<version>.md`, with semantic versions. Each call records `promptVersion` and `promptHash`.
- **Schemas** are Zod definitions in `src/schemas/<call>.ts`, each exporting a version and its limits, which the prompts quote. Each call records `schemaVersion` and `schemaHash`. Any change to a schema, including a limit only Zod checks or how lengths are counted, increases its version. A test keeps every released version with its `schemaHash` and limits fingerprint, append-only, and fails if the current schema matches no entry or one version appears with two fingerprints.
- **JSON Schema sent to the API** is generated by our own code from the Zod schema, committed under `src/schemas/json/<call>.json`, and checked by a test that fails when the committed file is out of date. The file and the request keep the schema's property order, because the model writes fields in that order. `schemaHash` is the SHA-256 of the same value's canonical JSON, with keys sorted, so it doesn't depend on serialisation. The adapter sends this schema unchanged as `output_config.format`, not through the SDK's schema helpers, which rewrite schemas in their own way and would make the schema sent differ from the one hashed.
- **Supported subset.** Structured outputs support (checked 24 October 2026): the basic types; `enum` of scalars; `const`; `anyOf`; `allOf` without `$ref`; `$ref` and `$defs`; `default`; `required`; `additionalProperties: false`, required on every object; ten string formats; simple `pattern`s (anchors, `*`, `+`, `?`, simple `{n,m}`, character classes, groups); and `minItems` of 0 or 1. They don't support recursion, `oneOf`, `minLength`, `maxLength`, `maxItems`, numeric bounds, other `minItems` values, or `additionalProperties` other than `false`. A request may have at most 24 optional parameters and 16 with union types; the generator refuses a schema over either.
- **What the generator does.** It removes `minLength`, `maxLength`, `maxItems`, numeric bounds and our own code-point limits, lowers `minItems` above 1 to 1 and drops `minItems: 0`, and refuses anything else outside the subset, such as `oneOf`, record types or an unsupported pattern (lookarounds, non-capturing groups, `\b`, backreferences, or a `{n,m}` bound above 64). It also refuses `allOf`, `$ref` and `$defs`, which the subset allows but the call schemas don't need, and any Zod object that isn't strict: Zod writes `additionalProperties: false` even for an object that silently drops unknown fields, so the JSON alone can't show it. Every limit it removes is still checked by Zod after parsing: collection sizes at the schema stage, limits inside an item by `LIMIT-001` (§3.5). Constrained decoding guarantees the rest: types, enums, required fields, patterns and unknown fields.
- **Validator** and **detector** versions are recorded on every call (§3.4, §3.5).
- **Model settings:** one model for all calls in the first slice, configurable per call later. Use the lowest sampling temperature the API supports with structured outputs. Record requested and returned model identifiers. The product does not claim identical output across runs.

Every prompt must state:

1. the role, and the call's single purpose;
2. that repository content is data, not instructions, and that suspected instructions should be reported in `contentNotices`;
3. the citation format, quote rules and alias rules;
4. that basis, paths, hashes and excerpts are determined by code, and must not be asserted;
5. no counts, and no universal claims from sampled code;
6. for questions: ask only about intent the evidence cannot establish;
7. for recommendations: the difference between `fact` and `policy`, that skipped questions and unresolved conflicts go in `heldBack`, and that no change is an acceptable answer;
8. the output limits.

A change to any prompt, schema, validator or detector requires the fixture suite (§3.8) to pass, and increases the relevant version.

### 3.8 Test fixtures

**Contract tests**, per call, using recorded responses. No live model is involved.

- **Valid:** representative responses that should be accepted completely.
- **Adversarial**, each with its expected rule ID:
  - unknown alias;
  - quote not in the sent content, a quote altered by one character, a quote present twice, a quote present only in omitted lines;
  - a citation of an outline-only item (`CIT-006`), and a quote taken from an outline label or a `BLOCKS` line;
  - a quote shorter than 12 characters, or only punctuation (`CIT-007`), and a finding with no citation left (`CIT-008`);
  - two citations of the same range (`CIT-009`), and a range longer than 40 lines (`CIT-010`);
  - a gap on an unlisted path (`GAP-001`), and a gap under an excluded directory (expect `GAP-002`);
  - an absence claim matching an `ignored` file (`ABS-001`), and one that can match only inside `node_modules/` (`ABS-002`);
  - a gap and an absence claim through a symbolic link and under an unreadable directory;
  - a shifted line range with a unique quote (expect `CIT-R01`, with quote and claim unchanged);
  - a model-asserted count, and a universal claim from samples;
  - a prescriptive finding citing only code;
  - a policy labelled as fact;
  - a recommendation supported only by existing guidance;
  - an invented path, an undeclared command, a declared reference missing from the content;
  - content of the wrong shape for its target;
  - a recommendation depending on a skipped question;
  - `noChangeReason` alongside recommendations;
  - a regeneration response that omits an affected recommendation;
  - instructions embedded in repository content;
  - an expansion request beyond `maxExpansionRequests` (`LIMIT-002`), on an excluded, ignored, withheld or unlisted path, or a file that isn't valid UTF-8 (`EXP-001`), a whole-file read of a file too large to excerpt (`EXP-006`), with a reversed range (`EXP-002`), asking only for lines already sent (`EXP-003`), with a search glob outside the scope roots or matching no searchable file (`EXP-004`), and with a literal holding a line break (`EXP-005`);
  - a conflict whose members are a finding and its duplicate (`DUP-001`, then `CONF-001`), a duplicate gap and absence claim, and a restated known fact (`DUP-002`);
  - a revision of a known fact (`REV-002`), two revisions of one target (`REV-003`), a replacement that failed validation (`REV-001`), and a call-1 conflict that loses a member or whose replacement member shares its sources (`SUP-005` again);
  - a question tied only to documented, uncontested findings (`Q-001`), one tied to a documented finding in an unresolved conflict (accepted), duplicate `resolves` sets in another order (`DUP-003`), more valid questions than twice the budget (`LIMIT-002`) with the rest `unreached`, and a question resolving a resolved conflict, which doesn't rank first;
  - a call-1 conflict that loses one of three members and is revised, and a conflict member naming a call-1 gap (`ALIAS-003`);
  - an outcome for every call-1 conflict: `kept`, `revised`, `replaced` (naming the kept conflict when the replacement was a duplicate), `withdrawn` with `withdrawn_by_model`, `withdrawn` with `members_merged` when one replacement stands for both members, and every conflict `kept` after a schema failure.

**Evidence basis and known facts** (§3.2.4–§3.2.5), with no model involved:

- each tier gives its basis, for files that are and aren't candidates, including `listed_only` files and imports that only count for basis;
- the tier used for basis agrees with selection for every file selection tried, under two enumeration orders;
- each fact type has its wording, scope, evidence kind and place in the order, and commands have the status `found_not_run`;
- each manifest format's reader, with an adversarial fixture per rule and accepted near misses;
- the section's format, delimiter escape and frame, rendered even with no facts; `F` aliases over the facts sent only; a fact that doesn't fit left out while later ones are still sent, with the budget gap's wording;
- the facts' unused bytes pass to no tier, a `knownFactsBytes` below the frame or over the remaining budget is rejected, and the manifest's `knownFacts` entry matches the section;
- the context's gaps in the order of §3.2.5, and the inspect row's "not sent (budget)" note;
- a manifest that can't be read or parsed gives its gap, and a fact matching the secret scan gives the withheld gap;
- the first importer follows resolution order;
- a manifest or workspace definition changed after capture makes the snapshot unstable;
- facts and gaps don't depend on enumeration order.

**Property tests:**

- No citation is ever accepted whose quote is absent from the content sent in that call.
- Range correction changes only the line range, never the quote, the claim or the item.
- The same response, input and validator version always produce identical accepted records and validation events.
- No accepted evidence excerpt contains text that wasn't sent in that call.
- Reversing the delimiter escape gives back any text (§1.6).

**Live suite:** manual runs against the product-development repositories, recording rejection and correction rates per rule. It is never run against evaluation repositories or materials.

### 3.9 Open points for this section

**Provisional values.** This is the single list of values marked provisional anywhere in this specification or the domain model. Each is calibrated against real responses from the development repositories (M6).

- Leaving `Cf`, `Mn` and `Me` characters out of `CIT-007`'s length and punctuation tests (§3.2.2).
- `CIT-010`'s limit of 40 lines for a cited range (§3.2.2, DM §6.2).
- `SUP-002`'s spelled-number and quantity word lists, and leaving out *one* (§3.2.3).
- `knownFactsBytes` of 10,000 for the known-facts section (§3.2.5, §1.14).

**Other open points.**

- Calibrating the directive-language and imperative-verb lists on development repositories, and measuring how often `REC-007` misses.
- How to detect absence asserted in free text, without an `absenceClaim` (§1.11). No deterministic check is defined yet.
- How to detect a claim about the omitted parts of an excerpted file when it cites only sent lines (§1.11). The citation rules catch citations of omitted lines, not claims about them.
- Minimum quote length: 12 characters may allow unhelpfully generic quotes in code.
- Output limits per call (finding, question and recommendation counts).
- `SUP-002` misses counts outside its lists, such as *once*, *twice*, *a couple* and ordinals.
- `SUP-001` matches a token in an excerpt as a substring, so `./format.ts` is anchored by an excerpt holding `../format.ts`, which names another file. A path-aware excerpt match would be stricter.
- In recommendation content, `` `./scripts/build.sh` `` is both path-like and command-like (§3.4). Which class wins is settled when the detector is built.
- Which known facts calls 2–5 number first: those sent in call 1, or every known fact, including those left out (§3.2.1). Settle when the alias tables are built.
- A command name holding a line or paragraph separator (U+2028, U+2029) gives a statement that spans lines, because only `Cc` is refused (§3.2.5). Calibrate with the rendering of known facts.
- The justfile reader is line-based, so a column-0 `name:` inside a multi-line string (`'''`, `"""`) reads as a recipe (§3.2.5).
- The justfile `private` test matches the word anywhere in an attribute line, so `[doc('private builds')]` hides a public recipe (§3.2.5).
- Documentation outside the tier 2 locations, such as `documentation/` or `wiki/`, is `code_observation` (§3.2.4). This is conservative: it can't support a `prescriptive` finding. Watch how often it happens in the M6 live runs.
- Whether a model-based support check is worth adding after the first slice. Adopt only if evaluation shows it reduces unsupported findings without excessive false rejections.

---

## 4. Persistence and export

This section turns [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13–§15 and the [Evaluation Requirements](../product/EVALUATION_REQUIREMENTS.md) §3–§4 into a file format, load rules and an export format. M4 builds §4.1–§4.9. M8 builds the export (§4.10).

### 4.1 Principles

- **One append-only log per session.** The session file is a header and an ordered list of immutable records. Nothing in a record changes after it is written. Changes are new records.
- **Current state is derived.** "The current decisions", "the active snapshot" and similar are computed by pure functions over the records (§4.4.2). They are never stored, so they can't drift from the records.
- **Code checks everything on load.** A file that fails a check is rejected and left untouched. Load never repairs.
- **No source content beyond what DM §6.1 allows.** File hashes for everything, excerpts for cited evidence, the full bytes of the destination and of each artifact revision. Two additions hold text that came from source: the quotes the model wrote into items that failed validation (§4.4.3), and retained model exchanges, under an explicit policy (§4.8).
- **Unknown is never zero.** Every measurement that can be missing is `{ "state": "known", "value": … }` or `{ "state": "unknown", "reason": … }` (`Known<T>`, §4.6), the shape the validation code already uses (§3.2.2). Active effort adds one more state, a lower bound (§4.6).
- **Layout.** Pure logic (record types, Zod schemas, derivations, load checks, export projection) lives in `src/core/session/` and `src/core/export/`. File I/O, the lock and atomic rename live in `src/adapters/storage/`, behind a port, so core tests use an in-memory store.

### 4.2 Storage location

The storage directory is the XDG data directory, on both supported platforms (ADR 0002):

1. `$AI_ENVIRONMENT_ARCHITECT_HOME`, if set: the one override. It must be an absolute path; a relative one is refused with a message, not ignored, because the developer set it deliberately;
2. otherwise `$XDG_DATA_HOME/ai-environment-architect`, if `XDG_DATA_HOME` is set to an absolute path (a relative one is ignored, as the XDG specification requires);
3. otherwise `~/.local/share/ai-environment-architect`.

An empty variable counts as unset, as in the XDG specification.

- The CLI resolves it once at start and passes it to core as a path. Core never reads `process.env`. There is no command-line option for it.
- Sessions and the data-notice state (§4.9) both live there.
- **Never inside the target repository.** If the storage directory's real path is the repository root or inside it, by any route (the override, `XDG_DATA_HOME`, or a repository at the home directory), `init` and `resume` refuse before anything is read or written, and say which setting to change. There is no exception: nothing is written inside the target repository except by apply (DM §11.2). The snapshot exclusion for session storage (§1.4) stays as a second safeguard; with this refusal it never matches. Real paths come from the native `realpath`, which also gives the file system's letter case, so a differently cased route on a case-insensitive volume is caught. A storage directory that doesn't exist yet is resolved through its deepest existing ancestor; the check creates nothing.

```text
<storage directory>/
  notices.json                     data-notice confirmations (§4.9)
  sessions/
    <sessionId>/
      session.json                 header and records (§4.3)
      session.lock                 present while a process holds the session (§4.7)
      content/sha256-<hex>         destination bytes and artifact revision content
      inputs/sha256-<hex>.json     retained request bodies (§4.8)
      responses/sha256-<hex>.json  retained response bodies, for replay (§4.8)
      exports/<timestamp>/         exports written by default (§4.10)
```

Files under `content/`, `inputs/` and `responses/` are **content-addressed**: the name is the SHA-256 of the file's exact bytes. Identical content is stored once, and load can verify every file against its name.

There is no index of sessions. `sessions`, and `resume` without an ID, load each session in turn, with the load checks (§4.9). A session that fails them is listed as unreadable, with the check that failed. That is fast enough for the first slice and leaves no second file to fall out of step.

### 4.3 Session file

`session.json` is UTF-8 JSON, written with object keys sorted bytewise (by their UTF-8 bytes, never by locale), two-space indentation, LF line endings and a final newline, so the same records always give the same bytes. The order of array elements is kept.

```json
{
  "format": "ai-environment-architect/session",
  "records": [
    { "createdAt": "2026-11-01T10:15:00.000Z", "id": "st_01J…", "productVersion": "0.1.0", "revision": 1, "seq": 1, "stage": "inspect", "status": "running", "type": "session_state" },
    { "createdAt": "2026-11-01T10:15:00.000Z", "id": "gc_01J…", "revision": 1, "seq": 2, "type": "generation_config" },
    { "createdAt": "2026-11-01T10:15:02.000Z", "id": "snap_01J…", "seq": 3, "type": "snapshot" }
  ],
  "schemaVersion": 1,
  "session": {
    "adapter": "claude-code",
    "createdAt": "2026-11-01T10:15:00.000Z",
    "id": "ses_01J…",
    "outputScope": ["root CLAUDE.md"],
    "productVersion": "0.1.0",
    "repository": { "name": "kutt", "root": "/Users/dev/kutt" },
    "targetPath": "CLAUDE.md"
  },
  "writtenBy": "0.1.0"
}
```

The example leaves out most record fields.

- **Header.** The fields of DM §5 that never change. `writtenBy` is the product version that last wrote the file; `session.productVersion` is the version that created it.
- **`repository.root`** is the real path of the resolved root (§2.3, symbolic links resolved). It is the session's repository identity: `resume` without an ID picks the most recent session whose root matches the current one, compared bytewise. A moved repository needs the session ID.
- **Records** share an envelope: `type`, `id`, `seq` and `createdAt`. `seq` starts at 1 and increases by one per record, so the order doesn't depend on the clock. `createdAt` comes from the injected clock, in ISO 8601 UTC with milliseconds.
- **Bytes** are never inlined. The destination and artifact content are referenced by `contentRef` (`content/sha256-<hex>`).

### 4.4 Records

#### 4.4.1 IDs, revisions and references

**Two kinds of ID.** Every record has its own **record ID**, `id`. A record that can change has a **lineage ID** as well, such as `findingId`, shared by all its revisions, and a `revision` number: 1, 2, 3… within the lineage. Both kinds come from the injected `IdSource` (`src/core/ports.ts`): a prefix, `_`, and an opaque suffix of letters, digits and `-`. Nothing reads order from an ID; `seq` gives the order. Code assigns every ID; the model never does (§3.2.1).

**Revising.** A change to a lineage appends its next revision. That revision repeats every field of the one before, changes what changed, and lists the one before in `supersedes`, by record ID. The one exception is a recommendation revision that fails validation, which supersedes nothing (below). A **replacement** starts a new lineage, with revision 1, whose `supersedes` also lists the current revision of every lineage it replaces; one replacement may stand for several (§3.3.3).

**What a revision may change.** Each revisable type lists the fields a revision may change; every other field repeats the revision it supersedes exactly, and may neither appear nor disappear. The envelope, `revision`, `supersedes` and `revisedBy` aren't compared.

| Type | Fields a revision may change |
|---|---|
| `session_state` | `productVersion`, `stage`, `status`, `outcome`, `reason`, `unsentPurpose` |
| `generation_config` | `budget`, `reason` (raising or confirming the budget, §4.6) |
| `finding` | `status`, `withdrawnReason` |
| `conflict` | `findingIds`, `status`, `withdrawnReason`, `resolvingDecisionId` |
| `question` | `status`, `unreachedReason` |
| `model_call` | the fields the end adds (§4.6): `state`, `returnedModel`, `retainedResponseRef`, `usage`, `cost`, `validationEvents`, `counts`, `correctedCitationRate`, `citationsProposed`, `questionOrder`, `error`, `endedAt`, `durationMs` |
| `effort_interval` | `state`, `leftAt` |
| `recommendation_revision`, `apply_attempt` | listed with their records in M5 |

**Who revised it.** `producedBy` names what created the lineage, and every revision repeats it. A revision appended by a model call, such as an `analyse_expansion` withdrawal or a conflict whose members changed, also records that call's lineage ID in `revisedBy`. A revision the developer causes names its decision instead, as `resolvingDecisionId` does. `revisedBy` is never repeated from the revision before, and never set on a first revision. Only findings and conflicts have it, because they are the only records a model call revises (§4.5). Decisions and selections record the developer as `actor` (DM §8.2, §9.2); a question changes by the developer's answer or skip, or is marked unreached by code, never by a model call.

**Current.** A revision is current when no other record supersedes it and its status is a current one (the table's last column). So a lineage has at most one current revision, and a withdrawn or replaced one has none. Immutable records and records with status `failed_validation` (§4.4.3) supersede nothing and are never superseded.

**References.** A reference names a **lineage ID** when it means "this thing, in whatever state it is now", and a **record ID** when it means "exactly this version":

| Field | Names |
|---|---|
| `findingIds`, `findingId`, `conflictIds`, `conflictId`, `gapIds`, `questionId`, `recommendationId`, `blockedBy`, `modelCallId`, `retryOf`, `producedBy` (a model call) | Lineage IDs |
| `supersedes`, `snapshotId`, `evidenceIds`, `decisionIds`, `resolvingDecisionId`, `revisionId`, `selectedRevisionIds`, `artifactRevisionId`, `reviewId` | Record IDs |
| A recommendation revision's `support` | Each entry is typed: a finding by lineage ID, so `REC-001` sees its current state; a decision or evidence by record ID, so a superseded decision makes the recommendation affected (DM §12) |
| A reference's `supportingFindingId` and `evidenceId` (DM §9.1) | The finding by lineage ID; the evidence by record ID |
| An artifact revision's `attribution` (DM §9.4) | Recommendation revisions by record ID |
| `revisedBy` | A model call by lineage ID |
| A model call's alias table (§3.2.1): the target of each `F`, `C`, `Q`, `D` and `R` alias | Record IDs: the exact revisions sent. Code maps one to its lineage through the record |

The lineage of `session_state` and `generation_config` is the session itself, so they have no lineage field: their revisions are numbered and chained within the session. Decisions have no lineage: a correction is a new decision that supersedes the old one (DM §8.2), so a decision is always referred to by its record ID. A recommendation revision's record ID is DM §9.1's `revisionId`.

| Record (`type`) | Lineage ID (prefix) | Record ID prefix | How it changes | Current status |
|---|---|---|---|---|
| `session_state` | the session | `st_` | A revision per change of stage, status or outcome, with `reason` when it isn't a normal step: `interrupted`, `budget_reached` (with the purpose of the call left unsent), `stage_skipped`. Carries `productVersion` | the latest |
| `generation_config` | the session | `gc_` | The settings of DM §5 `generationConfig` and §1.14: the context selection settings with their `settingsHash`, the expansion settings (§1.8), which `settingsHash` doesn't cover, the requested model, the generation and question budgets and `retainModelInputs`. Raising a budget (§2.12) appends a revision with a reason | the latest |
| `snapshot` | — | `snap_` | Immutable. A refresh appends a new snapshot (DM §6.1). The destination's bytes are in `content/`; its Guidance Blocks are stored | the latest is active |
| `content_notice` | — | `cn_` | Immutable. One per valid notice (§3.3.2 step 10), with `snapshotId`, `modelCallId`, the `item` alias, the `path`, `fileHash`, `lineStart` and `lineEnd` code resolves it to, and the `description` | those of the active snapshot |
| `evidence` | — | `ev_` | Immutable. Created for accepted findings only (§4.4.3); `absence_check` evidence for each accepted absence claim (§4.5) | — |
| `finding` | `findingId` (`fnd_`) | `fndr_` | Withdrawal: a revision with status `withdrawn` and `withdrawnReason`. Replacement: a new lineage (§4.5) | `active`, of the active snapshot, and not corrected (§4.5) |
| `conflict` | `conflictId` (`conf_`) | `confr_` | §4.5. Carries `snapshotId` | `unresolved` or `resolved`, of the active snapshot, with every member finding current |
| `question` | `questionId` (`q_`) | `qr_` | `open` → `answered`, `skipped` or `unreached`. A skipped question answered later gets another revision | `open`, `answered`, `skipped`, `unreached`, while at least one finding, gap or conflict it resolves is current |
| `decision` | — | `dec_` | A correction is a new decision whose `supersedes` names the old one (DM §8.2) | not superseded |
| `recommendation_revision` | `recommendationId` (`rec_`) | `rrev_` | DM §9.1. A new revision per regeneration `revise` or developer edit. Invalidation: a revision with status `invalidated` and `invalidatedReason` (below) | `valid` |
| `held_back` | — | `hb_` | Immutable. One per accepted `heldBack` entry (§3.3.5), with its `topic`, `blockedBy` and `modelCallId` | §4.4.2 |
| `no_change_reason` | — | `ncr_` | Immutable. An accepted `noChangeReason` (§3.3.5, `REC-009`), with its `modelCallId` | §4.4.2 |
| `selection` | — | `sel_` | Immutable. DM §9.2. A new selection per change, naming its `recommendationId` and `revisionId` | the latest per `recommendationId` |
| `artifact_revision` | — | `art_` | Immutable. Content in `content/` | §4.4.2 |
| `review` | — | `revw_` | Immutable. DM §10 | — |
| `apply_attempt` | `applyAttemptId` (`apply_`) | `applyr_` | `started` is written, and synced, before the temporary file (DM §11.2 step 4). Each later state is a new revision, recovery included | the latest |
| `model_call` | `modelCallId` (`call_`) | `callr_` | `started` before the request is sent; then `completed`, `failed` or `interrupted` (§4.6) | the latest |
| `effort_interval` | `effortIntervalId` (`eff_`) | `effr_` | `open` when a prompt is shown; `closed` when it is answered (§4.6) | the latest |
| `effort_correction` | — | `effc_` | The developer's corrected total, with a reason (§2.13); a later one supersedes it | not superseded |
| `failed_item` | — | `fail_` | Immutable. An item that failed validation, from a collection with no record type of its own (§4.4.3) | never |
| `inputs_purged` | — | `pur_` | Immutable, with only the envelope. Written by `purge-inputs` (§4.8) | — |

**Recommendation statuses.** `valid`, `failed_validation` (§4.4.3), or `invalidated` with one of these reasons:

| `invalidatedReason` | When |
|---|---|
| `revalidation_failed` | A regeneration `keep` whose revision fails revalidation (§3.3.6) |
| `not_reconsidered` | An affected recommendation the regeneration response left out (`REGEN-001`) |
| `dropped_by_model` | A regeneration `drop` |
| `target_changed` | A refresh changed or removed its target block, and it couldn't be re-anchored (DM §12) |

An `invalidated` revision supersedes the valid one before it. A `failed_validation` revision supersedes nothing, so a failed regeneration `revise` or developer edit leaves the earlier valid revision current.

#### 4.4.2 Derived state

These are pure functions over the records, in `src/core/session/`. DM §5's "active references" are these functions, not stored fields.

- **Stage, status, outcome:** the latest `session_state`. The outcome is `applied`, `no_change`, `failed` or `cancelled`, or unset while the session is in progress (DM §5).
- **Completeness:** `complete`, or `incomplete` with every reason that holds, in this order:
  - `budget_reached`: the generation budget stopped a call (§3.6, §2.12) and that call is still unsent. It holds when, after the last `session_state` with reason `budget_reached`, no model call with the purpose it names was started. Raising the budget and sending the call clears it;
  - `stage_skipped`: a `session_state` has the reason `stage_skipped`, written when the developer skips a stage whose output all failed validation (§2.12);
  - `questions_unreached`: a current question has status `unreached`, for either reason (DM §8.1). A question about findings that are no longer current, for example after a refresh, doesn't count.

  Completeness is separate from the outcome: an `applied` session can be `incomplete`. It is derived, never stored, and can be computed at any point.
- **Active snapshot:** the latest `snapshot`.
- **Current findings, conflicts, questions, decisions and recommendations:** the current revisions, as in §4.4.1. Findings and conflicts from an earlier snapshot are not current, so a refresh leaves only the new snapshot's (DM §12). A conflict is current only while all its member findings are, so a conflict with a corrected or earlier-snapshot member is neither aliased nor sent; a question is current only while at least one finding, gap or conflict it resolves is current. These follow from the records, and no record is written for them.
- **Current held-back entries and no-change reason:** those of the latest completed `recommend` call, plus those of every later completed `regenerate_recommendations` call. How regeneration replaces earlier held-back entries is settled in M5 (§4.12).
- **Current selections:** the latest `selection` per `recommendationId`.
- **Active artifact revision:** the latest `artifact_revision`, if its `snapshotId` is the active snapshot, its `selectedRevisionIds` equal the current accepted selections, and its `decisionIds` are all current. Otherwise there is none, and the review screen says the proposal is out of date (DM §12).
- **Usable approval:** an `approved` review of the active artifact revision whose `contentHash` equals the revision's `proposedHash` (DM §10). Freshness (DM §11.1) is checked at apply, not here.

Records with status `failed_validation`, and `failed_item` records, are left out of every set above. They are never current, never given an alias, never sent to a later call, never support anything and are never shown as findings (§2.12).

#### 4.4.3 Items that failed validation

The Evaluation Requirements ask to "preserve the complete findings and recommendations, including rejected ones". So every item the validation pipeline rejects at the item or cross-item stage (§3.5) becomes a record, as well as the validation events it produced. The status is `failed_validation`, not "rejected", because a selection and a review can also be `rejected` (DM §9.2, §10).

- **Which record.** An item from a collection with a record type of its own is stored as that type: findings, gaps and absence claims as `finding` (with the matching `kind`), conflicts as `conflict`, questions as `question`, and recommendations, additions and regeneration `revise` revisions as `recommendation_revision`. Items from every other collection (`analyse_expansion` revisions, expansion requests, content notices, held-back entries, regeneration `keep` and `drop` actions) are `failed_item` records, with their `collection`.
- **Shape.** A failed record holds only the envelope, for a recommendation revision its lineage fields (below), and these fields: `status: "failed_validation"`; `producedBy`, the model call or `developer_edit`; `itemKey`, named as the item's validation events name it (§3.5); `rejectedBy`, a list holding the ID of the rule that rejected it, since an item stops at its first rejection (§3.5), whose events also hold its failed sub-items; and `proposed`, the item exactly as written after the schema stage, with its aliases and local keys unresolved. Nothing in it is corrected or rewritten, and none of the type's other fields is filled in: a failed absence claim has no code-written statement, and a failed finding has no evidence or basis.
- **Lineage.** Only recommendation revisions keep one: a new `recommendationId` for a new recommendation, the existing one for a regeneration `revise` or a developer edit, so the history of one recommendation stays together. Other failed records have no lineage ID or revision.
- **Evidence** is created only for accepted findings. Evidence code made while checking a finding that is later rejected, at the item or cross-item stage, is discarded; its citations stay in `proposed`.
- **Failed citations of an accepted finding** are kept on that finding as `failedCitations`, each the citation as proposed with its `rejectedBy`, merged duplicates (`CIT-009`) included. `droppedCitations` stays their count (DM §6.3).
- **A response that fails the schema** has no items, so it creates no failed records: only its `SCHEMA` events, with the proposed count unknown (§3.5). Its text is kept only in the retained response, for replay (§4.8).
- **Validation events still hold no response text** (§3.5). The text lives only in the failed records, so it can be controlled in one place.
- **Quoted source.** A failed item's citations may quote repository content. In the export these quotes follow the excerpt option (§4.10): without `--include-excerpts`, each `quote` is replaced by its `quoteHash`.

### 4.5 Conflicts, findings and the `analyse_expansion` outcomes

This settles the direction for conflict records that [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.5 gave M4, and the records §3.3.3 leaves to persistence. Each outcome of §3.3.3 maps onto records like this:

| Outcome | Records appended |
|---|---|
| `kept` | Nothing |
| `revised` | The next revision of the same `conflictId`, with the new `findingIds`, status `unresolved` and `revisedBy`, superseding the old revision |
| `replaced` | A new conflict lineage, from the replacement `c` key, superseding the current revision of every conflict it replaces |
| `withdrawn` | The next revision of the same `conflictId`, with status `withdrawn`, its `withdrawnReason` and `revisedBy` |
| resolved by a decision (§2.6) | The next revision, with status `resolved` and `resolvingDecisionId` |

Findings follow the same pattern. A `withdraw` revision of an `F` target appends the finding's next revision, with status `withdrawn`, the reason `withdrawn_by_model` and `revisedBy`. A `replace` appends the replacement as a new finding lineage that supersedes the target's current revision. The withdrawn and replaced findings stay in the file and the export, with their status (§3.3.3: "kept for history").

**Corrected findings.** A finding the developer marks wrong (§2.5, `w`) is not withdrawn. The correction is a `developer_correction` decision that names the finding in `findingId` ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §8.2). While a current decision names it, the finding is **corrected**:

- it is not current, so it gets no alias, isn't sent to later calls and can't be cited as support (`REC-001`, §3.3.5);
- the findings view still shows it, marked "corrected by you" (§2.5);
- a recommendation whose support includes it is in the regeneration affected set (§3.3.6).

If the correcting decision is superseded by one that no longer names the finding, the finding is current again, and the change propagates as any decision change does (DM §12).

**Absence claims** are stored as findings with `kind: "absence"` and the code-generated statement (§1.11). Every finding that isn't a gap has evidence, so an accepted absence claim has one evidence record of kind `absence_check`, created by code:

| Field | Notes |
|---|---|
| `snapshotId` | The snapshot whose file list was checked |
| `pathGlob` | The glob after the path normalisation of §1.11 |
| `unenteredDirectories` | The directories capture didn't enter that the glob could reach (§1.11): the shown ones in path order, then the withheld ones by `pathHash`, in hash order, so a hash's place says nothing about the name |
| `basis` | `code_observation`, as for `entry` evidence (§3.2.4): both read the file list, which is an observation, not documentation |

An `absence_check` has no path, file hash, lines or excerpt. It supports only the narrow statement it was made for (§1.11).

**Known facts** are findings with `producedBy: "deterministic"` and entry or line evidence (§3.2.5).

### 4.6 Model calls and effort

**Model call.** Every request sent is its own call, with its own `modelCallId`, because each one can cost money: a transport retry of the identical request, the schema retry with its message, and the fresh retry after every item was rejected (§3.6, §2.12). `attempt` counts the sends for one step, from 1, and `retryOf` names the previous attempt's `modelCallId`.

The `started` revision is written before the request is sent:

```ts
type Known<T> = { state: "known"; value: T } | { state: "unknown"; reason: string };
// A total of parts, any of which may be unknown (§4.10 "Totals and unknowns").
type Total = { state: "known"; value: number }
  | { state: "unknown"; reason: string; knownPartsSum: number };

// The limits in force when the call was sent, and the spend the §3.6 check counted.
type CallBudget = {
  maxTokens?: number; maxCostUsd?: number;   // from the latest generation_config
  spentCostUsd: Total;                       // as "Budget with unknown costs" counts it
  spentTokens: Total;
};

type ModelCallStarted = {
  type: "model_call"; id: string; seq: number; createdAt: string;
  modelCallId: string; revision: 1; state: "started";
  purpose: CallPurpose;
  attempt: number; retryOf?: string;
  requestedModel: string;
  promptVersion: string; promptHash: Hash;
  schemaVersion: string; schemaHash: Hash;
  validatorVersion: string; detectorVersion: string;
  inputManifest: InputManifest;          // §1.13
  retainedInputRef: string | null;       // §4.8
  aliases: AliasTable;                   // §3.2.1
  budget: CallBudget;
  estimatedCost: Known<number>;          // the §3.6 check before sending, in USD
  startedAt: string;
};
```

The next revision repeats those fields, supersedes the `started` revision, and adds the result:

```ts
type ModelCallEnded = Omit<ModelCallStarted, "revision" | "state"> & {
  revision: 2; supersedes: [string];
  state: "completed" | "failed" | "interrupted";
  returnedModel: Known<string>;
  retainedResponseRef: string | null;    // §4.8
  usage: { input: Known<number>; output: Known<number>;
           cacheRead: Known<number>; cacheWrite: Known<number> };
  cost: Known<{ amount: number; currency: "USD"; basis: "reported" | "estimated" }>;
  validationEvents: ValidationEvent[];   // §3.5
  counts: { proposed: Known<number>; accepted: number; corrected: number;
            relabelled: number; rejectedByRule: Record<string, number> };
  correctedCitationRate?: CorrectedCitationRate;   // analyse, analyse_expansion (§3.2.2)
  citationsProposed?: CitationsProposed;
  questionOrder?: string[];              // the model's order, for ranking class 5 (§3.3.4)
  error?: { kind: string; message: string };       // code-generated, no source content
  endedAt: Known<string>;
  durationMs: Known<number>;
};
```

- **Interrupted.** A call still `started` when its session is resumed was interrupted. The process that holds the lock (§4.7) appends an `interrupted` revision, with `endedAt`, `durationMs`, `usage` and `cost` unknown for the reason `interrupted`. It may have been billed, so it is never counted as zero. Read-only commands, which take no lock, show such a call as in progress if the session is locked by a live process, and as interrupted otherwise, without writing anything.
- **Budget with unknown costs.** For the §3.6 check, the spend so far is the sum of known costs plus, for each call whose cost is unknown, its `estimatedCost`. That estimate is used for the budget only, and is never reported as the call's cost. If an estimate is unknown too, the check can't be made, and the next call is not sent until the developer raises or confirms the budget (§2.12).
- **Tokens.** The tokens spent so far are the sum of every call's four usage counts. A call with any usage unknown makes the token check impossible, as an unknown estimate does for cost: there is no token estimate to stand in for it. The check before sending compares the spend plus the call's own estimate, of cost and of tokens, with each ceiling that is set; an unset ceiling is never checked.
- **Raising or confirming.** Either appends a `generation_config` revision: raising with the new limits and the reason `budget_raised`, confirming with the same limits and the reason `budget_confirmed`. These are the only reasons a `generation_config` revision may give, and it changes nothing but the budget (§4.4.1). It settles every unknown before it: the unknown parts of calls started before it count as their known parts only (`knownPartsSum`), and the next call may be sent with an unknown estimate. A call started after it, with unknown parts, makes the check impossible again.
- `costBasis: "unknown"` in DM §13.1 is `cost.state: "unknown"` here.

**Effort intervals.** An `open` revision is written when a prompt that waits for the developer is shown, and a `closed` revision with `leftAt` when it is answered (§2.13). An interval still `open` when its session is resumed was interrupted: the process holding the lock closes it with `leftAt` unknown, reason `interrupted`. Read-only commands treat it as they treat calls (above).

**Active effort** is the sum of the closed intervals. When any interval was interrupted, it is reported as `{ "state": "lower_bound", "value": …, "interruptedIntervals": n, "inProgressIntervals": 0 }`. A read-only command that finds an interval open in a session a live process holds reports it in progress: the effort is a lower bound with `inProgressIntervals` counting them, because more is being spent. This is the one exception to the rule for totals (§4.10): effort the developer certainly spent is a real lower bound, not an unknown. An `effort_correction` holds the developer's corrected total and reason; the export reports both values (§2.13).

### 4.7 Atomic writes and the lock

**Writing.** Every change appends records in memory and writes the whole file:

1. Write any new `content/`, `inputs/` or `responses/` files first, each to a temporary file in the same directory, synced and renamed into place. A file that already exists is not rewritten.
2. Serialise `session.json` (§4.3) to `session.json.tmp-<random>` in the session directory, sync it, rename it over `session.json`, and sync the directory.
3. Only then report the change as saved.

Before step 2, the save runs the load checks (§4.9) on the bytes it is about to write, and refuses to write a session that wouldn't load, or whose header names another session, leaving the saved one in place. New directories are created one level at a time, and each parent is synced after its new entry.

A crash therefore leaves either the old file or the new one, never a mix. Content files without a referring record may be left behind; they are harmless and are removed with the session. The random part of the temporary name comes from the storage adapter, not core.

**When to write.** After every record that matters for recovery: each `session_state`, each `model_call` revision, each `apply_attempt` revision, each developer action (answer, skip, decision, selection, edit, review, acknowledgement) and each effort revision. The developer never loses an answer to a crash.

**Lock.** A process that changes a session (`init`, `resume`, `delete`, `purge-inputs`) first creates `session.lock` exclusively, holding `{ pid, hostname, startedAt, productVersion }`. The owner is written to a synced temporary file first, which a hard link puts in place: the link fails if a lock exists, as `O_CREAT | O_EXCL` would, and the lock never appears without its content. If the storage directory's file system refuses hard links, the process stops with a message naming the storage directory; there is no fallback to another way of locking. Only `init` creates the session directory; a process given a session ID with no directory says so and creates nothing. It removes the lock on exit, including on `SIGINT` and `SIGTERM`.

- If the lock exists, the process exits without changes and names the process ID and host (§2.12).
- A lock is **stale** when its host is this machine and its process is not running. A process that exists but may not be signalled (another user's) counts as running. The CLI says so and offers to remove it, defaulting to no; it is removed only if it is unchanged since it was reported and still stale. The lock is first moved aside and the moved file checked, so a lock another process took meanwhile is put back, never deleted. A lock from another host is never removed automatically.
- A lock file that can't be read as a lock, such as one altered by hand, is held by an unknown owner. It isn't stale, so the developer removes it by hand; the message names its path. A lock that disappears before it can be read was just released, and the process tries again.
- On `SIGINT` or `SIGTERM` the process removes the lock and raises the signal again, so it still ends the way the signal asks.
- Read-only commands (`status`, `sessions`, `export`) take no lock. They read `session.json`, which atomic rename keeps whole.

As DM §11.2 says, the lock can't stop other editors from changing `CLAUDE.md`; apply's hash re-check does that.

### 4.8 Retained model exchanges

This implements §1.12, which covers responses as well as requests.

- With `retainModelInputs` on (default), the exact request body of every model call is stored as `inputs/sha256-<hex>.json` and referenced by `retainedInputRef` on the call and in its input manifest (§1.13). The exact response body is stored as `responses/sha256-<hex>.json`, referenced by `retainedResponseRef`.
- Retained responses are for replay only. Nothing reads them to build records, the export or the review: items that failed validation have their own records (§4.4.3).
- Retained exchanges are never in an export unless `--include-inputs` is given.
- `purge-inputs` appends an `inputs_purged` record and saves it, and only then deletes `inputs/` and `responses/`, so a crash in between leaves a session that loads. Load then allows those references to point at missing files. `delete` removes the whole session directory.
- With retention off, both references are `null`, and replay needs the original files at their recorded hashes (§1.12). With it on, the request reference is always set; the response reference is `null` when there is no response body, as after a transport failure or an interruption.

### 4.9 Schema versions and load validation

**Versions.** `schemaVersion` is an integer, 1 for now. Any change to a record type, field or derived rule that an older reader would misread increases it.

- **Until v0.1.0 there are no migrations.** A session saved with an **older** format is refused: "This session was saved in session format 1 by version 0.0.3. This version reads only format 2, and doesn't convert older sessions before v0.1.0. Start a new session with `<cli> init`." Nothing is written, and the old session stays on disk until the developer deletes it. From v0.1.0 on, each format change needs a migration, specified with the change.
- A session saved with a **newer** format is refused too: "This session was saved in session format 2 by version 0.3.0. This CLI reads format 1. Update to 0.3.0 or later." (§2.12). If the file doesn't say which version wrote it, either message names "an unknown version" instead, and the newer-format one ends "Update to the latest version."

**Load checks**, in order. The first failure rejects the session with a message naming the check and the record, and the file is left untouched:

1. The file is UTF-8 JSON, and its `format` and `schemaVersion` are this reader's (above). A truncated file fails here.
2. The Zod schema for the whole file. Unknown fields are rejected, as in §3.3.
3. Envelope: record IDs unique; lineage IDs never used as record IDs; `seq` is 1, 2, 3… in file order; each lineage's revisions are numbered 1, 2, 3… in `seq` order; each revision after the first supersedes the latest earlier revision of its lineage that isn't `failed_validation`, and a `failed_validation` revision supersedes nothing; a revision changes only the fields its type may change (§4.4.1), compared as canonical JSON, and repeats the rest of the revision it supersedes.
4. References (§4.4.1): every record ID a record names belongs to a record of the right type with a lower `seq`; every lineage ID it names belongs to a lineage of the right type whose first revision has a lower `seq`. This covers every field in the references table, and a model call's `inputManifest.snapshotId`. A record that isn't `failed_validation` never refers to one that is. A model call's `retryOf` names a call with the same purpose whose `attempt` is one less.
5. Superseding: a record supersedes only records of its own type, each at most once; failed and immutable records are never superseded, except decisions and effort corrections by their own type; every effort correction after the first supersedes the current one, so at most one is current; a revision whose status isn't current (§4.4.1), such as a withdrawn finding, is never superseded.
6. Evidence: every accepted finding that isn't a gap has evidence; an `absence` finding's is one `absence_check`, and a `claim`'s are `lines` or `entry`. The schema (check 2) already enforces the count, so a finding without evidence fails there; this check covers the kinds.
7. Content: every `contentRef` exists and its bytes hash to its name; the destination's `hash` and its Guidance Block hashes match its bytes; each artifact revision's `proposedHash` matches its content. A call's `retainedInputRef` equals its input manifest's; with `retainModelInputs` off both references are `null`, and with it on `retainedInputRef` isn't. Every `retainedInputRef` and `retainedResponseRef` exists and matches, unless an `inputs_purged` record comes after the call: after its first revision for the request, after the revision that added it for the response. A file that is still there is checked either way.
8. State: at most one `session_state` has an outcome, and it is the last one; every `apply_attempt` names an `approved` review of its artifact revision whose `contentHash` equals the revision's `proposedHash`.

A session that passes is loaded as a list of typed records. On resume, the process holding the lock then runs the interrupted-work rules, in this order: apply recovery (DM §11.2), interrupted model calls and effort intervals (§4.6), and a `session_state` with the reason `interrupted` and status `ready`, at the same stage, if the last state was `running`.

**Data notice.** `notices.json`, in the storage directory (§4.2), records each repository root whose data notice (§2.3) was confirmed, with the notice's version and the time. A changed notice text increases its version and is shown again. Two processes writing it at once can lose one confirmation; the cost is that the notice is shown once more. A missing or unreadable `notices.json` reads as no confirmations, at the same cost: the notice is shown again, and the next confirmation replaces the file.

### 4.10 Export

`<cli> export <session-id> [--include-excerpts] [--include-inputs] [--out <dir>] [--json]` writes a directory. By default it is `sessions/<id>/exports/<timestamp>/`, in the storage directory, which is never inside the repository (§4.2). `--out` refuses any path inside the session's repository root.

```text
export.json            the record below
diff/final.diff        unified diff from the original to the final content, if any
files/original/CLAUDE.md          the destination as captured, if present
files/artifact-<n>/CLAUDE.md      each artifact revision's content
inputs/, responses/    only with --include-inputs
```

- `export.json` has `exportFormat: "ai-environment-architect/export"`, `exportVersion: 1`, the session's `schemaVersion`, `generatedAt` from the injected clock, and the options used.
- `contentState` is `applied` if the latest apply attempt succeeded, `approved` if there is a usable approval, `proposed` if there is an active artifact revision, and `none` otherwise. Every artifact revision in the export carries its own state too (DM §14).
- **Excerpts are off by default.** Without `--include-excerpts`, each evidence item keeps its path, file hash, line range and an `excerptHash`, which is enough to locate the evidence in the snapshot (Evaluation Requirements §3, "source identity"). The quotes in failed items and failed citations follow the same option: without it, each `quote` is replaced by its `quoteHash` (§4.4.3). The rest of a failed item's model-written text is always included. The original and artifact `CLAUDE.md` files are always included: they are agent configuration, the product's input and output, not private source.
- The export is a projection: the same session, options and `generatedAt` give the same bytes.
- Before anything is written, the whole export passes the secret scan (§1.7), because it may leave the machine. A match stops the export and names the rule and file, never the text.

**Mapping.** Each section of the Evaluation Requirements §4 is a top-level key of `export.json`:

| Key | Evaluation Requirements §4 | Contents, from records |
|---|---|---|
| `identity` | Identity | Session ID, `createdAt`, `completedAt`, `productVersion` (creating and last writing), `adapter`, `outputScope` |
| `inputs` | Inputs | Each snapshot: ID, `capturedAt`, `git` as recorded (unknown states with reasons), scope, exclusions, ignore rules, stability, file list with hashes; initial destination state and hash, with its Guidance Blocks; each `generation_config`; for each call, the requested and returned model, prompt, schema, validator and detector versions and hashes, budget, input manifest (§1.13) and alias table (§3.2.1) |
| `reasoningEvidence` | Reasoning evidence | Findings of every kind and status, failed and corrected ones included, with uncertainty, basis, coverage, `droppedCitations` and `failedCitations`; evidence references (excerpts only if included), `absence_check` evidence included; conflicts with every revision; content notices; questions with every revision and status, with `unreachedReason`; decisions including superseded ones and corrections; `failed_item` records; validation events and counts per call |
| `review` | Review | Every recommendation revision, with its status (`valid`, `failed_validation` with `rejectedBy`, `invalidated` with its reason), developer edits (`producedBy: developer_edit`); held-back entries and no-change reasons; selection history, `rejected` selections included; reviews |
| `outputs` | Outputs | The final diff, artifact revisions with state, applied file list (the destination path and its hash after apply, or empty), the final configuration hash, and the unresolved gaps, conflicts and questions (open, skipped, unreached) |
| `measurements` | Measurements | Elapsed time (created to completed, unknown while in progress); generation time, the sum of call durations; active effort with its method (`awaiting_user_intervals`), as a value or a lower bound (§4.6), and the correction; tokens and cost per call and in total, with `costBasis` |
| `outcome` | Outcome | `evaluationStatus` (below), the session `outcome` and `completeness` with its reasons, final stage and status, apply attempts with every revision, and failure details from `error` fields |

The alias tables and input manifests are what make a failed item's `proposed` readable: its aliases, such as `F-3` or `T5-007`, resolve through its call's table.

**Outcome mapping.** The Evaluation Requirements ask for "completed, partial or failed". The session's outcome and completeness are kept separate (§4.4.2), and the export maps them to `evaluationStatus`, with `evaluationStatusReasons`:

| Session outcome | Completeness | `evaluationStatus` | `evaluationStatusReasons` |
|---|---|---|---|
| `applied` or `no_change` | `complete` | `completed` | none |
| `applied` or `no_change` | `incomplete` | `partial` | the completeness reasons |
| `failed` | either | `failed` | `failed`, then any completeness reasons |
| `cancelled` | either | `partial` | `cancelled`, then any completeness reasons |
| unset (in progress) | either | `partial` | `in_progress`, then any completeness reasons |

A `failed` session's failure details come from the `error` fields of its failed model calls and apply attempts, and are written so the developer can act on them (§2.12).

**Totals and unknowns.** A total is known only when every part is known. Otherwise it is unknown, with the reason naming the parts that are unknown, plus the sum of the known parts labelled `knownPartsSum`. Missing values are never zero, in any field. Active effort is the one exception (§4.6).

### 4.11 Verification

- Every record type round-trips: write, load, and derive the same current state; the bytes are identical when nothing changed, and keys are in bytewise order.
- A session interrupted after any write (simulated by stopping before each rename) loads as either the previous or the next state, never a mix, and resume continues from it.
- Corrupted files are rejected with the check that failed: truncated JSON, an unknown field, a duplicate ID, a gap in `seq`, a revision that doesn't supersede the one before, a dangling record or lineage reference, a reference to a later record, a record superseded twice, a reference to a failed record, a missing or altered content file, a block hash that doesn't match, an outcome that isn't on the last state, an apply attempt without a matching approved review.
- An older and a newer `schemaVersion` are each refused with their message; nothing is written.
- Storage resolution: the override, then an absolute `XDG_DATA_HOME`, a relative one ignored, then the default; a storage directory inside the repository, by each route, is refused before anything is read or written.
- `notices.json` holds one confirmation per repository root, and a higher notice version shows the notice again.
- A second process can't open a locked session; a stale lock on this host is reported and removed only after confirmation; the lock is removed on normal exit, `SIGINT` and `SIGTERM`.
- Current state: a withdrawn, replaced, corrected or earlier-snapshot finding is not current; a resolved conflict is current with status `resolved`; an invalidated recommendation has no current revision, and a failed revision leaves the earlier valid one current.
- Each `analyse_expansion` outcome creates exactly the records of §4.5, and `kept` creates none. A finding withdrawal and replacement, and a conflict resolution, create theirs.
- A developer correction removes the finding from aliases, later calls and support, and puts dependent recommendations in the affected set; superseding the correction restores it.
- Every item rejected at the item or cross-item stage becomes exactly one failed record holding its text as written and its rule IDs, with no evidence created; a schema failure creates none. No failed record is ever current, aliased, sent or used as support.
- Every accepted absence claim has one `absence_check` evidence record, and load rejects a non-gap finding without evidence.
- Load rejects a recommendation whose `support`, reference or attribution names a missing finding lineage, decision, evidence or recommendation revision.
- A conflict with a corrected or earlier-snapshot member is not current; a question whose targets are all not current is not current and doesn't count towards `questions_unreached`.
- Completeness gives each reason in its case; `budget_reached` clears when the stopped call is later sent; an `applied` session can be `incomplete`.
- A `started` model call and an `open` effort interval are made `interrupted` only by the process holding the lock, never count as zero, and give an effort lower bound; read-only commands write nothing.
- The budget check counts an interrupted call's `estimatedCost`, and never reports it as cost.
- With retention on, request and response files are written and referenced; with it off, both references are `null`. After `purge-inputs`, the session still loads, and the export says the exchanges were purged.
- Derived state never reads a stored "current" field.
- The export: each section contains its records, alias tables, input manifests and returned models included; `contentState` is right in the proposed, approved, applied and no-change cases; `evaluationStatus` follows every row of the outcome mapping; excerpts, failed items' quotes and exchanges appear only with their options; hashes match the session; unknown totals carry reasons; a seeded secret stops the export; `--out` inside the repository is refused.
- Nothing in `src/core/session/` or `src/core/export/` reads the clock, randomness or the filesystem directly.

### 4.12 Open points for this section

- **`cancelled`.** No command produces the outcome `cancelled` yet: "Save and quit" leaves a session in progress, and `delete` removes it. Settle with the commands in M7, probably a `cancel` command.
- **Held-back entries across regeneration.** Whether a `regenerate_recommendations` call's held-back entries replace earlier ones or add to them. Settle with regeneration in M5.
- **Performance of whole-file writes.** Every write rewrites `session.json`. Snapshot file lists on the development repositories are under 230 entries, so this is cheap; a large repository may need snapshots in their own content-addressed files. Measure in M6.
- **Repository identity.** A root path identifies a repository only on one machine, and not after a move. Enough for the first slice.
