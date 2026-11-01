# Fixtures

Small, invented inputs for tests. Their bytes are exact: `.gitattributes` marks `test/fixtures/**` as `-text`, so Git never converts line endings, and Biome, `tsc` and Vitest skip this directory. `test/fixtures.test.ts` checks the properties that matter.

No committed fixture may look like a real credential. Secret-scan fixtures are built from fragments at test time in `test/support/secret-fixtures.ts`, and `test/fixtures.test.ts` checks that no file here matches a secret-scan rule (IMPL §1.7).

## `repos/`

Synthetic repositories for snapshot and listing tests (DM §6.1, IMPL §1.4).

- `empty`: not committed, because Git cannot store an empty directory. Tests create it in a temporary directory.
- `no-claude-md`: a tiny project with no `CLAUDE.md`, so the destination is `absent`.
- `empty-claude-md`: a zero-byte `CLAUDE.md`, so the destination is `present` with no blocks.
- `nested-packages`: a workspace with two packages, a package-level test and a nested `CLAUDE.md` that is not the destination.
- `secret-names`: files excluded by name (`.env`, `.env.local`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `*.keystore`, `credentials*`, `secrets*`), plus `.env.example` and `.env.sample`, which are exempt. Contents are placeholders that match no secret-scan rule.
- `large-and-binary`: `at-limit.txt` is exactly 262,144 bytes (a candidate) and `over-limit.txt` is 262,145 bytes (`listed_only`); a PNG, a `.txt` file with a NUL byte, and a `.txt` file that is not valid UTF-8.
- `unusual-markdown`: a `CLAUDE.md` mixing setext headings, a fenced block with `#` lines, an HTML comment and a nested list.

The root `.gitignore` drops `node_modules/`, `dist/` and `coverage/` at any depth, so a fixture directory with one of those names is silently not committed. Create such directories at test time, or add a negation to `.gitignore` and check `git ls-files` afterwards.

## `destinations/`

Standalone `CLAUDE.md` inputs for Guidance Block parsing (DM §7). Each isolates one feature: `crlf`, `bom`, `no-trailing-newline`, `setext-headings`, `fenced-hash-lines`, `nested-lists`, `html-comments`, `front-matter` and `trailing-whitespace`. Three combine the cases most likely to break a lossless round trip: `mixed-line-endings` (LF, CRLF and a lone CR), `bom-crlf` and `unclosed-fence`. All use LF except `crlf`, `bom-crlf` and `mixed-line-endings`.

## `citations/`

Citation provenance cases (IMPL §3.2.2), tested without context selection. `context.json` is one shared synthetic call context: each item's `sent` runs hold the file's raw line text (delimiter escape not applied), and `unsent` holds some omitted lines for property checks. The call's alias table is every item ID in it plus `F-1`.

Every other file is one finding's citations, with `expect` parallel to `citations`, the finding's outcome, the spec section and a note. An entry in `expect` may name `duplicateOf`, the earlier citation it repeats; the finding merges it (`CIT-009`).

## `support/`

Support-check cases (IMPL §3.2.3, `SUP-001` to `SUP-005`), run after provenance. `context.json` lists the snapshot's entry paths for the listed-path test. One entry is a withheld path written with the placeholder `{{aws-access-key-id}}`: tests replace it, in `context.json` and in case statements, with AWS's documented example key ID, so no committed file matches a secret-scan rule.

Every other file is one case: a `finding` with its accepted evidence (path, basis, code-extracted excerpt), or a `conflict` with its members' evidence paths, plus `expect` (outcome and the first failing rule, or `null`), the spec section and a note. Files are named after the rule that must reject them; `accepted-*` files are near misses that must pass every rule, and name the rule they nearly fail in `nearMissOf`.

## `coverage/`

Coverage-aware validation cases (IMPL §1.11: `SCOPE-001`, `GAP-001`, `GAP-002`, `ABS-001`, `ABS-002`, `ABS-003`). `context.json` is one shared snapshot:

- `files`: path, status, and kind, target or exclusion `rule` where the status has one;
- `userExclusions`: patterns that are user exclusions (none in the shared snapshot), so the runner can tell them from defaults;
- `ignoreRules`: whether ignore rules were applied;
- `sent`: the line ranges each item of the call sent, initial and expansion alike, with the item's ID for reference. A path missing from `sent` was not sent.

The withheld placeholder works as in `support/`.

Every other file is one `scope`, `gap` or `absenceClaim` with `expect`: the outcome (`accepted`, `relabelled` or `rejected`), the rule, and the gap's coverage or the absence claim's code-generated statement, `null` when the item is rejected. `detailExcludes` lists text the rejection detail must not contain. A withheld path in an expected coverage is written `{"pathHash":"withheld:<path>"}`; the test hashes it. A case may override `ignoreRules`, or replace `files`, `sent` and `userExclusions` when it needs a repository of its own. Naming follows `support/`.

## `responses/`

Recorded model responses, one directory per call (IMPL §3.7). Each call directory's `valid.json` is a representative response that schema tests accept completely.

## `responses/`: call validation cases

Whole-call item validation cases for `analyse`, `analyse_expansion` and `generate_questions` (IMPL §1.8, §1.11, §3.2.1–§3.2.3, §3.3.2–§3.3.4, §3.5): each case runs one complete recorded response through the call's validation sequence, item and cross-item stages together, and checks every event, every accepted item and the call-level results. They cover `LIMIT-002`, `EXP-001` to `EXP-005`, `DUP-001` to `DUP-003`, `CONF-001`, `REV-001` to `REV-003`, `Q-001`, replacement kinds (`ALIAS-003`), call-1 conflict outcomes, content notices, ranking and the corrected-citation rate. Rules with their own fixture directories (`CIT-*`, `SUP-*`, `SCOPE-*`, `GAP-*`, `ABS-*`) appear only where they interact with these.

### Contexts

Each call directory has a shared `context.json`. A case may name another context file in the same directory with `"context": "context-<name>.json"`; a context file is always complete, never a patch.

`analyse/context.json`:

- `files`: the snapshot's entries, with `status` (`read`, `listed_only`, `ignored`, `excluded`, `symlink`, `unreadable`), and `kind`, `rule`, `target` or `reason` where the status has one. A `listed_only` entry states its `reason` (`too_large`, `contains_nul`, `not_utf8`), because `EXP-001` and `EXP-006` depend on it. Directories that only contain entries (`src`, `docs`, `test`) are implied.
- `userExclusions`: exclusion patterns that are user rules; `ignoreRules`: `{ "state": "applied" }` or not; `scopeRoots`: the snapshot's scope roots.
- `items`: the context items, each with its `alias`, `path`, `basis`, `totalLines`, `sent` (runs of consecutive sent lines, `first` being the first line's number and `lines` the file's text exactly; `[]` is an outline-only item) and `changed` (`true` means the file's current hash differs from the snapshot's, for `CIT-002`).
- `knownFacts`: the known facts sent, with their `F` aliases, statements, scopes and evidence paths.
- `blocks`: how many destination aliases (`B-1` to `B-n`) the table holds.
- `maxExpansionRequests`: the session setting.

The other `analyse` contexts are `context-limit2.json` (`maxExpansionRequests` 2), `context-scope-src.json` (scope root `src`, with a root `package.json` listed outside it), `context-long.json` (a 42-line item for `CIT-010`) and `context-unreadable-content.json` (`listed_only` files that aren't UTF-8 or hold a NUL byte).

`analyse_expansion/context.json` has the same fields, with expansion items `E-1` (lines 7–12 of `src/client.ts`) and `E-2` (lines 1–3 of the outline-only `src/util.ts`), plus `findings` (the call-1 records `F-2` to `F-6`, with their evidence paths; the known fact `F-1` stays in `knownFacts`). A record is a model claim unless it says otherwise: `kind` may be `gap` (with `statement`, `gapType` and `relatedPaths`) or `absenceClaim` (with `pathGlob`), and `producedBy` may be `deterministic`; together they are the call's required call-1 records (IMPL §3.3.3) and `conflicts` (the call-1 conflicts `C-1` to `C-3` with their members).

`generate_questions/context.json` has `files`, `userExclusions` and `ignoreRules` for `SCOPE-001`; `findings`, each with `alias`, `kind` (`claim` or `gap`), `basis` (a set; a gap's may be `[]`) and, for gaps, `gapType`; `conflicts` with members and `status` (`unresolved` or `resolved`); `blocks`; and `questionBudget`.

A path holding `{{aws-access-key-id}}` is withheld by the secret scan: tests replace the placeholder, in contexts and responses, with AWS's documented example key ID, as in `support/`.

### Cases

Every other file is one case:

- `description`: one sentence; `section`: the spec sections it tests;
- `context`: optional, another context file;
- `response`: the full model response object, every collection present; or `responseText`, a raw string, for a response that isn't valid JSON;
- `nearMissOf`: for a near miss, the case it nearly repeats. Every rejecting case has at least one near miss that must be accepted, to catch over-rejection;
- `expect`:
  - `status`: `validated` or `schema_failed`;
  - `events`: the complete, ordered event list of IMPL §3.5 (`itemKey`, `stage`, `rule`, `outcome`, and `original` where a correction records one); `[]` when there are none. `detail` is not compared, except that `detailExcludes`, when present, lists text no detail may contain;
  - `accepted`: per collection, the items accepted, in response order, named as `itemKey` names them: the local key, or `<collection>/<index>` for an item with no key of its own (expansion requests, content notices, revisions);
  - `acceptedConflictMembers`: optional, the members of an accepted conflict after redirection and after carrying through revisions;
  - `acceptedRevisions`: optional, which revision was kept when two name the same target (`index` in `revisions`), and for a replacement, the item it resolves to after duplicate redirection;
  - `correctedCitationRate` (`analyse`, `analyse_expansion`): `{ "state": "known", "corrected", "checked" }`, where `checked` counts the citations that reached the citation check, or `{ "state": "unknown", "reason": "no_citations" | "schema_failed" }`; `citationsProposed`: `{ "state": "known", "count" }`, every citation in the response;
  - `conflictOutcomes` (`analyse_expansion`): the call-1 conflicts whose status changes because of carried members, in alias order, with `status` and `withdrawnReason` (`member withdrawn` or `sources not distinct`); `revisedConflicts`, optional, the call-1 conflicts revised with new members, `{ "alias", "status": "revised", "members" }`. A call-1 conflict withdrawn or replaced by a revision is listed in `accepted.revisions`, not here;
  - `presented` and `unreached` (`generate_questions`): question keys in ranked order.

Files are named `<rule>-<description>.json` after the rule that must reject them, and near misses `<rule>-near-<description>.json`. Cases about the corrected-citation rate start with `rate-`, cases about call-1 conflict outcomes with `outcome-`, cases about content notices that must be accepted with `notice-near-`, and cases about question ranking with `ranking-`.

`test/call-fixtures.test.ts` runs every case twice, with the context's inputs listed in two orders, and requires the same result. `conflictOutcomes` is compared with the withdrawn outcomes, and `revisedConflicts`, when present, with the revised ones.
