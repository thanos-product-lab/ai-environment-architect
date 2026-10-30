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

Recorded model responses, one directory per call (IMPL §3.7).
