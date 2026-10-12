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

## `responses/`

Recorded model responses, one directory per call (IMPL §3.7).
