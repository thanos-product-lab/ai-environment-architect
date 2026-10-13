# Implementation Specification

**AI Environment Architect · AI Product Studio**  
**Date:** 13 October 2026  
**Version:** 0.12  
**Status:** Partial specification. Sections 1–3 are proposed. Section 4 is not yet written, so this document does not yet specify the whole implementation.

### Changes from v0.11

Calibration on the development repositories (M2) changed the selection algorithm. `algorithmVersion` is `context-select/1.2.0`.

- **Tier 3 order (§1.5).** Workspace definitions, task runners, package manifests, tooling configuration, then CI last. Reasons renumber to `tier3:group3:package-manifest`, `tier3:group4:tooling` and `tier3:group5:ci`.
- **Scan as selected (§1.3, §1.5, §1.7).** Each item is scanned as it is selected. A blocked file uses no bytes, item ID or source file slot, so the next candidate takes its place, and a blocked test example is replaced by the package's next test file. Before, blocked items were removed after selection without refilling, which let one false positive cost a tier a whole file's budget.
- **Secret rules (§1.7).** `secretRulesVersion` is `secret-scan/1.1.0`. `generic-assignment` also matches names containing `pass`, `pwd`, `key`, `credential`, `auth` or `private`, and requires a high-entropy value: 3.5 bits per character, or 3.0 for 32 or more hex digits. The thresholds miss about 0.1% of random 20-character base62 secrets, and no line in the three development repositories matched the new rule.
- **Ignored files (§1.4, §1.6, §1.8, §1.13, §2.3, §2.4).** The git adapter lists the files the repository's ignore rules match. They stay in the snapshot, hashed, with the status `ignored`, and are candidates for no tier and no expansion. The tree marks them `[I]`, and the manifest lists them and records whether ignore rules were applied. Without git, only the default and user exclusions apply, and the summary says so. Ignored files no longer count as untracked. `CLAUDE.local.md` and `.claude/settings.local.json` are excluded by default, and tier 1 no longer matches `CLAUDE.local.md`.

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
4. Persistence and export *(not yet written)*

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
2. Select and excerpt content for tiers 1, 2, 3 and 5 (§1.5, §1.6), running the secret scan (§1.7) on each item as it is selected. A blocked file is not included and uses no bytes, item ID or source file slot, so the next candidate takes its place. Candidates are tried in a fixed order, so the result is the same as if the blocked file were absent.
3. Scan the selected items and gap statements again (§1.7). This repeats step 2's check, so the guarantee doesn't depend on it; anything it finds is removed without refilling budgets.
4. Render the directory tree (tier 4) from the full file list, with markers reflecting the final selection.
5. Render all items in tier order 1, 2, 3, 4, 5 (§1.6).
6. Assemble the complete request and run the token check (§1.10). Apply deterministic reductions if needed; tree markers are updated for any removed items.

Determinism requirements:

- **Inputs** are only the snapshot (file list, hashes, live content verified against snapshot hashes), settings, and the token count reported for the selected model. Nothing else: no filesystem enumeration order, modification times, environment, locale, randomness or model output.
- **Path order** is bytewise ascending order of repository-relative, forward-slash, UTF-8 paths. Every "in order" in this section means this order unless stated otherwise.
- **Budgets are in bytes** of rendered UTF-8 context. Byte selection is independent of the model. The token check (§1.10) is the only model-dependent step, and it can only remove items, never add them.
- **Settings are versioned.** `settingsHash` is the SHA-256 of the canonical JSON of the effective settings, `algorithmVersion`, `secretRulesVersion` and `declarationPatternsVersion`.
- **Content is verified.** When a file is read for context, its hash must match the snapshot entry. A mismatch aborts construction and reports the snapshot as unstable ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1).
- **Verification:** `contextHash`, the SHA-256 of the rendered context, must be identical across runs for the same snapshot, settings and model. This is a required test.

### 1.4 Candidate set

A file is a **candidate** for content inclusion when all of these hold:

- it is in the snapshot and not matched by an exclusion;
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

**Ignored files.** Files the repository's ignore rules match are not excluded, because capture runs no `git` command and doesn't parse ignore files. They are found afterwards, by the git adapter (below), and recorded as `ignored`:

- An `ignored` file is one that is readable (it would otherwise be `read` or `listed_only`), not tracked by the commit, and matched by git's standard ignore rules: `.gitignore` files at any depth and `.git/info/exclude`. The user's global excludes file is not read, because git runs without the user's configuration or `HOME`.
- It stays in the snapshot with its hash and size, so coverage and freshness still see it, but it is a candidate for no tier and no expansion (§1.8). The tree shows it as `[I]`.
- The destination, tracked files, excluded entries, symbolic links and unreadable entries are never `ignored`. A tracked file that an ignore pattern matches stays a candidate, as it does in git.
- Untracked files that no ignore rule matches stay candidates.
- When git metadata is `unknown` (no repository, git missing or too old, or an error), ignore rules are not applied: only the default and user exclusions apply. The manifest records `ignoreRules: "not_applied"`, and the summary says so (§2.4).

**Patterns.** Default and user exclusions use one grammar:

- A trailing `/` matches directories and symbolic links only. Otherwise any entry matches.
- A pattern that starts with `/` or contains another `/` is anchored at the repository root and matches that path. Otherwise it matches the entry's base name at any depth.
- `*` matches any run of characters except `/`. There are no other wildcards.
- The session storage location is always anchored, because it names one place. It must be relative to the repository root and inside it; a leading `./` is ignored.
- Rules apply in order: defaults, then user exclusions, then the session storage location. The first match is recorded.

Secret-bearing names and binary types compare ASCII letters case-insensitively, so `ID_RSA` and `logo.PNG` are excluded. Other rules are case-sensitive. Secret-bearing names match directories too: `secrets/` and `credentials.d/` are excluded whole. The root `CLAUDE.md` is never excluded, because it is the destination.

**Binary and media types** are these extensions: images `png jpg jpeg gif bmp ico icns webp tif tiff psd heic avif svg`; audio and video `mp3 wav ogg flac m4a aac mp4 m4v mov avi mkv webm`; archives `zip gz tgz bz2 xz zst 7z rar tar jar war`; fonts `woff woff2 ttf otf eot`; documents `pdf doc docx xls xlsx ppt pptx`; compiled code and data `exe dll so dylib a o obj class pyc wasm bin sqlite db`.

**Capture** ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1) is read-only. Files are opened read-only and never through a symbolic link; nothing is written inside the repository, including `.git/`. Symbolic links are recorded with their targets and never followed. Special files such as named pipes are never opened, and are recorded as `unreadable`. A name that is not valid UTF-8 is recorded as `unreadable` and as a read failure. After a file is opened, its parent directory must still resolve to the expected path under the root, or nothing is read; a directory is listed only if it resolves to its expected path before and after listing. One race remains, because Node has no `openat`: a directory swapped for a link and back again between the open and the check. The tool doesn't defend against a repository being changed adversarially while it runs. The repository is observed twice, listing and hashing every file that is not excluded. If any path's entry differs between the two, both observations are repeated once. If they still differ, the snapshot is `unstable` with those paths, and the second observation of the retry is kept.

**Git metadata** ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §6.1) is read after the observations, by an adapter that treats the repository as untrusted:

- Only `git --version`, `git rev-parse` (top level, object format, `HEAD^{commit}`), `git symbolic-ref` and `git show-ref` (to recognise a branch with no commits), `git ls-tree -r -z -l --full-tree <commit>` and `git ls-files -z --others --ignored --exclude-standard --directory` run. None of them refreshes the index, or runs hooks, filters or fsmonitor. Only `ls-files` reads the working tree, and only directory listings and ignore files, never file content; `--directory` reports a wholly ignored directory as one entry. `git status` is never used.
- The environment is built from scratch: `PATH`, `LANG=C`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, and `GIT_CEILING_DIRECTORIES` set to the root's parent unless that path contains `:`. `HOME` and variables such as `GIT_DIR` from the user's shell are dropped. Every command except `--version` also gets `--no-lazy-fetch -c core.fsmonitor=false -c core.untrackedCache=false -c safe.bareRepository=explicit`.
- Git older than 2.44 is refused (`git_too_old`), because it ignores `GIT_NO_LAZY_FETCH` and could fetch missing objects in a partial clone, running a command from the repository's config.
- Git runs only when the root has a `.git` entry, so discovery stops at the root. The work tree git reports must be the root: a subfolder of a larger repository, a bare-repository layout, or a `core.worktree` pointing elsewhere is `not_a_repository`. Discovery is used rather than setting `GIT_DIR`, because git checks `safe.directory` ownership only during discovery.
- `safe.directory` refusals are recorded as `unsafe_repository`. Global config is ignored, so a `safe.directory` entry there doesn't apply.
- The commit is `HEAD^{commit}`. It is absent only when HEAD is a symbolic ref to a branch that doesn't exist yet; any other failure to resolve HEAD is `git_error`.
- Core compares the tree with the snapshot. A file whose size differs is modified without being read again. Otherwise it is read again, streaming, and the adapter computes its blob ID (`blob <size>\0<bytes>`, SHA-1 or SHA-256 to match the repository) without buffering the file; the read must still have the snapshot hash, or the file is uncompared. Symbolic links are compared by their target.

### 1.5 Tiers

Tiers 1, 2, 3 and 5 are filled in that order. Each has a byte cap. Unused bytes from tiers 1, 2 and 3 pass down to the next selected tier. Tier 4's cap is reserved up front and is not reallocated, because the tree is rendered after selection.

Within a tier, every item is tried in the tier's order. An item that exceeds its per-file cap or the remaining budget is excerpted (§1.6) to fit the smaller of the two, if the tier allows it, or skipped and recorded. An item whose rendering matches the secret scan is blocked instead (§1.7), and the next item is tried as if it were absent. Later items that fit are still included. A file whose smallest possible rendering (an empty file's) cannot fit is skipped without being read.

**Each file belongs to one tier:** the first of tiers 1, 2, 3 and 5 that matches it, even if that tier skips it. A file is never sent twice.

**Names.** Tier 1 names match exactly, because agents load those files by exact name. In tiers 2, 3 and 5, names and extensions compare ASCII letters case-insensitively, so `readme.md`, `makefile` and `App.TS` match. *Markdown* means the extensions `.md`, `.markdown` and `.mdx`. These lists and rules are part of `algorithmVersion`; any change to them increases it.

**Reasons.** Items carry `tier1:destination`, `tier1:agent-config`, `tier1:import`, `tier2:group<N>:root-doc|decision-doc|docs|package-readme`, `tier3:group<N>:workspace|task-runner|package-manifest|tooling|ci`, `tier5:test-example` or `tier5:rank<N>:entry-point|boundary-name|other`. A file tried and never included is recorded with `tier<N>:cap-reached`.

**Default budget:** `initialContextBytes` = 240,000. The five tier caps may not add up to more than it; settings that do are rejected.

| Tier | Contents | Default cap | Per-file cap | Excerpting |
|---|---|---|---|---|
| 1 | Existing agent configuration | 40,000 | Destination: `maxDestinationBytes`; others: none | Never |
| 2 | Project documentation | 60,000 | 12,000 | By document section |
| 3 | Manifests and tooling configuration | 40,000 | 8,000 | By whole lines from the start |
| 4 | Directory tree (reserved) | 20,000 | n/a | By depth reduction |
| 5 | Representative source, including test reserve | 80,000 | 6,000 | By top-level declaration |

#### Tier 1 — Existing agent configuration

Matched paths:

- `CLAUDE.md` at any depth (`CLAUDE.local.md` is excluded, §1.4)
- `.claude/**` (text files only)
- `AGENTS.md` at any depth
- `.cursorrules`, `.cursor/rules/**`
- `.github/copilot-instructions.md`

**Destination rule.** The root `CLAUDE.md`, if present, is the destination. It is selected first and must be included in full, with its Guidance Block IDs ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §7) in a BLOCKS section (§1.6). Block hashes are not sent: code supplies them, never the model. The session **stops with an explanation** before any model call if any of these is true:

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
- An import that does not resolve to a candidate file is ignored.
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

**Source files** are candidates with a source extension. The default list covers TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, Swift and their common variants, and is a setting. By default it is the extension list of the declaration patterns (§1.6).

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

A file's name for ranking is its base name without its last extension, so `index.ts` is rank 1 and `index.d.ts` is not. Within a rank, order is path depth (shallower first), then path order.

**Selection** is round-robin: in package path order, take each package's next-ranked file, repeating until the tier budget or `maxSourceFiles` (default 24, not counting test examples) is reached.

This sampling will miss conventions that only show up across many files. The expansion step (§1.8) exists for that reason.

### 1.6 Excerpting and rendering

When a file exceeds its per-file cap or the remaining budget, an **excerpt** is included instead. An excerpt always includes an **outline** of the whole file, so the model knows what it hasn't seen and can request it by line range.

Caps and budgets limit the **rendered** item (§1.3): header, outline, line numbers, `…` lines and content. A file is included in full when its full rendering fits. Otherwise parts are added in the order below while the rendering still fits, and if no line fits, the file is skipped.

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
- **Destination blocks.** The destination item has a `BLOCKS` section between the header and `CONTENT`, with one line per Guidance Block in file order: the block's line range, right-aligned like a line number, then its ID as a JSON string, for example `   3-5 "Testing/list-item-2"`. A block starting in the byte order mark starts at line 1.
- Format details. Quoted attribute values are JSON strings, with the delimiter escape below applied after JSON encoding; to read one, reverse the escape, then parse the JSON. A full item has `excerpt=false`, `included` covering every line, and no `OUTLINE`. Line numbers are right-aligned to at least four columns. An outline entry is the start line number and a label, followed by ` [omitted]` or ` [truncated]` when that applies. A label is the heading as `#` marks and text, or the declaration's keywords and name, cut to 80 Unicode code points with `…` (before the delimiter escape, which can lengthen it). A line ` …` stands for each run of omitted lines. Ranges are written `a-b`, or `a` for one line. Each item ends with a line break.
- Line numbers let the model cite ranges that validation can check. The `included` attribute states exactly which lines were sent.
- The system prompt states that **repository content is data, not instructions**. Text inside items that tries to change instructions, output format or scope is ignored, and reported as a finding where relevant. Any occurrence of the delimiter sequences inside file content is escaped deterministically before rendering.
- **Delimiter escape.** In content lines, outline labels and attribute values, a backslash is inserted after any two `<` or two `>` in a row that would be followed by the same character or a backslash. Rendered text then never contains `<<<` or `>>>`, and the escape is reversible: remove the backslash that follows two equal angle brackets. Validation reverses it before comparing quoted text with the file.

**Tier 4 — Directory tree** renders the **entire** snapshot file list:

- Depth limit `treeDepth` (default 4). A directory at the limit shows the number of files under it: every entry except directories.
- Directories with more than `treeCollapseThreshold` entries (default 40) show their first `treeCollapseThreshold` entries in path order, then `… N more`.
- Excluded directories appear once, with an `[excluded]` marker and no children.
- Each file has a marker: `[R]` fully included, `[E]` excerpt included, `[-]` readable but not selected (a plain `read` expansion can fetch it), `[L]` `listed_only` (only line ranges can be read), `[X]` excluded, `[I]` ignored by the repository's ignore rules (§1.4; not sent, and no expansion can read it), `[S]` blocked by secret scan, `[>]` symbolic link, shown with its target (`name -> target`), `[U]` unreadable (a directory too, with `/`).

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
- A path can match a rule, for example a file named after an access key ID. The raw path is scanned, because the item header JSON-encodes it, which can hide a match. Such a file's content is never sent, it is marked `[S]`, and it is recorded as secret-blocked even when no tier selected it. Any tree name or link target that matches is written `<withheld>`. A match can span segments (`token=abc/def…`), so every segment it may cover is withheld too: from the last segment whose suffix of the path still matches to the first segment whose prefix matches, or every segment if those don't overlap. Records that leave the selection hold the path's SHA-256 instead of the path: `pathHash` in the manifest, and `relatedPathHashes` in gap findings, so `relatedPaths` only ever holds real paths.
- Selection gap statements are scanned too. An import outside the repository is scanned before it is cut to 80 code points; if it matches, the statement names only the importing file and says the import is withheld. Any other gap statement that matches is replaced by a fixed statement.
- For an excerpt in calls 3–4, the excerpt is withheld, and any finding that depends only on it is marked `evidence_withheld` and not passed forward.
- For the destination, the session stops (§1.5).
- The manifest records the path (or its `pathHash`) and the rule ID, never the matched text. The tree marks the file `[S]`.

Placeholder values in `.env.example` and similar files are not exempt from the scan; those files are only exempt from the name-based exclusion.

**Fixtures.** Each rule has fixtures that must match and near misses that must not. Committed files must not look like real credentials: push protection may block the push, and scanners would flag the repository. Tests build matching values from fragments at test time, or use documented example values such as `AKIAIOSFODNN7EXAMPLE`. A test checks that no committed fixture matches any rule.

**What the product claims:** content matching known secret patterns is blocked. Credentials in unrecognised formats may not be detected. The first-run notice (§2.3) states that selected repository content is sent to the model provider and that the scan reduces, but does not eliminate, the risk of sending secrets. Developers can add exclusions before any content is sent.

### 1.8 Expansion protocol

The `analyse` call may return up to `maxExpansionRequests` (default 5) requests. There are two kinds:

| Kind | Parameters | Limits |
|---|---|---|
| `read` | Up to 10 entries, each a path with optional line ranges (for example `apps/web/src/lib/api/client.ts:20-39,97-140`), plus a reason | Per-entry cap `expansionEntryBytes` (default 8,000) |
| `search` | A literal string (no regular expressions in the first slice), an optional path glob, and a reason | At most 30 matches, 3 lines of context each |

A `read` without line ranges returns the file excerpted by the rules in §1.6. A `read` with line ranges returns exactly those lines, which must be within the file. Line-range reads are the way to see omitted outline entries and `listed_only` files.

Each request is validated deterministically:

- every path is in the snapshot, not excluded, not `ignored` (§1.4), and not secret-blocked;
- requested ranges are not already fully included;
- globs resolve only within scope;
- the total expansion stays within `expansionBytes` (default 60,000).

Invalid requests are rejected with a recorded reason. Valid ones are executed by application code:

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

Tier 3 manifests and the destination are never removed. If the request still does not fit, the call is not sent, and the session stops with an explanation (for calls 1–2, this triggers the destination rule in §1.5 if the destination is the cause).

Every reduction is recorded in the manifest, and the tree markers are updated. The token check is the only model-dependent part of construction. Because it can only remove items, the byte selection stays reproducible across models, and the final context is reproducible for a fixed model.

### 1.11 Coverage-aware validation

These checks run after calls 1 and 2, in addition to the evidence validation in the domain model.

**Gap findings** must include:

- `gapType`: `no_command`, `no_documentation`, `undetermined_ownership`, `undetermined_convention`, or `other`;
- `relatedPaths`: the paths or globs the gap concerns.

If any related path exists in the snapshot but its relevant content was not sent (`[-]`, `[L]`, omitted outline entries, or outside the context and expansion), the gap is relabelled `not_inspected`. The review shows it as "not inspected", not "missing".

**Absence claims** must be expressed as `absenceClaim: { pathGlob, reason }`. Application code evaluates the glob against the **full snapshot file list**:

- If matching files exist, the claim is rejected and the rejection recorded.
- If none exist, the claim is accepted. Its statement is **generated by code, not the model**: "No files matched `<pathGlob>` within the inspected scope," followed by the scope and exclusions that applied.

An accepted absence claim records a narrow fact about one pattern. It can support a gap or a question ("No files matched `**/*.test.ts`. How are frontend changes tested?"). It **cannot** support a recommendation that states a broader absence, such as "this project has no tests". Absence asserted in free text, without an `absenceClaim`, fails validation.

**Excerpt awareness:** a claim citing an excerpted file is accepted only if its cited range lies within the lines actually sent. A claim about what omitted parts of a file do or don't contain is rejected.

### 1.12 Retained model inputs and replay

Hashes identify content but cannot recreate it. To make a session replayable, the exact inputs are retained under an explicit policy:

- **`retainModelInputs`** (default `true`): the exact rendered request body of every model call is stored in the session directory as a content-addressed file, referenced from the model-call record. This content has already been sent to the provider; retaining it locally adds no new exposure beyond local storage.
- Retained inputs are **never included in exports by default**. Including them is an explicit export option.
- Retained inputs are deleted when the session is deleted, and can be purged separately while keeping the rest of the session. The CLI shows the policy at first run and in session status.
- With retention on, a session is **replayable**: every request can be re-sent exactly, even if repository files have since changed.
- With retention off, replay requires the original files at the recorded hashes. Any mismatch is reported, and replay stops.

The initial context is **reproducible** from the snapshot, settings and model. A session that used expansion is **replayable** but not reproducible, because the expansion requests were model output.

*Domain model note:* this adds a retained-input reference to the Model Call record ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13.1) and a retention rule to persistence (§15). The snapshot itself still stores no full source content.

### 1.13 Input manifest

Every model call records an input manifest ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §13.1). It contains paths, hashes and reasons, never source content:

```json
{
  "manifestVersion": 1,
  "algorithmVersion": "context-select/1.2.0",
  "secretRulesVersion": "secret-scan/1.0.0",
  "declarationPatternsVersion": "declarations/1.0.0",
  "settingsHash": "sha256:…",
  "snapshotId": "snap_…",
  "contextHash": "sha256:…",
  "retainedInputRef": "inputs/sha256-….txt",
  "budget": { "initialContextBytes": 240000, "usedBytes": 228410 },
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
  "ignoreRules": "applied",
  "ignored": [
    { "path": "logs/app.log" },
    { "path": "server/config.js" }
  ],
  "expansion": null
}
```

When expansion is used, `expansion` lists each request, its validation outcome, the items returned and their bytes.

Details:

- Tiers are listed 1 to 5. Tiers 1, 2, 3 and 5 also record `budgetBytes`: the cap plus bytes passed down. Tier 4 records `capBytes`, `usedBytes` and `treeDepth`.
- `budget.usedBytes` is the rendered context's size, tree included.
- `ignoreRules` is `applied` when git metadata is known, and `not_applied` otherwise (§1.4). `ignored` lists the snapshot's `ignored` files in path order.
- `excluded` lists the snapshot's excluded entries with their rule, in path order, then secret-blocked files with `secret-scan:<rule ID>`, in path order. Secret-blocked files include files whose path matches, whether or not a tier selected them.
- A path that matches the secret scan is recorded as `pathHash` instead of `path` (§1.7).
- `retainedInputRef` is `null` until inputs are retained for a call (§1.12), `tokenCheck` until the token check runs (§1.10), and `expansion` when there was no expansion.

### 1.14 Settings

| Setting | Default |
|---|---|
| `initialContextBytes` | 240,000 |
| Tier caps (1, 2, 3, 4, 5) | 40,000 / 60,000 / 40,000 / 20,000 / 80,000 |
| `maxDestinationBytes` | 40,000 |
| Per-file caps (tiers 2, 3, 5) | 12,000 / 8,000 / 6,000 |
| `testReserveBytes`, `testExampleBytes` | 15,000, 3,000 |
| `maxReadableFileBytes` | 262,144 |
| `maxSourceFiles` | 24 |
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
- A file blocked by the secret scan gives its place to the next candidate: the items, IDs and tier usage are those of a selection without that file.
- Markdown excerpts contain only complete units, a section or the own text of a split section, except the first unit, which may be cut before a blank line; code excerpts contain only complete declarations and the import block; outlines list everything omitted except blank lines before the first heading or declaration.
- Tree markers match the final selection, including after token-check reductions.
- The destination is included in full, or the session stops before any call with a stated reason, for each of the four causes in §1.5.
- The secret scan runs on every outgoing request and blocks each rule's fixtures. The manifest never contains matched text.
- Excluded, `ignored`, `listed_only` (except requested ranges) and secret-blocked content never appears in a request.
- Ignored files are recorded as `ignored` only when git lists them: never tracked files, the destination, excluded entries or links. Without git, the manifest says ignore rules were not applied.
- Delimiter sequences inside file content are escaped.
- Line-range expansion returns exactly the requested lines; out-of-range or already-included requests are rejected.
- A file changed after the snapshot fails expansion with "changed since snapshot".
- A request that exceeds the token limit is reduced in the specified order, or not sent.
- Gap findings concerning unsent content become `not_inspected`.
- Absence claims contradicted by the file list are rejected; accepted ones use the code-generated narrow wording and cannot support broader recommendations.
- Claims about omitted parts of excerpted files are rejected.
- Calls 2–4 receive only validated material, and calls 3–4 no raw initial context.
- A retained session replays byte-identical requests after repository files change.
- A prompt-injection fixture inside a repository file does not change output schema, scope or behaviour.

### 1.16 Open points for this section

- Calibrating the default caps on two or three development repositories of different sizes and documentation levels.
- Declaration patterns for languages beyond the default families.
- Whether `search` should support a restricted regular-expression syntax after the first slice.
- Whether tier 2 should prefer recently changed documents. This is excluded for now, because it would make the result depend on Git history.
- How coverage-aware validation (§1.11) treats paths under a symbolic link or an excluded directory, which capture never enters. Probably `not_inspected`. To decide in M3.

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
| `<cli> export <session-id> [--include-excerpts] [--include-inputs]` | Write the session export ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §14) |
| `<cli> delete <session-id>` | Delete a session and its retained inputs, after confirmation |
| `<cli> purge-inputs <session-id>` | Delete retained model inputs only |

`status`, `sessions` and `export` support `--json`. Interactive steps require a TTY; run in a non-TTY environment, `init` and `resume` print an explanation and exit without changing anything.

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
  keys, personal Claude settings, and files your .gitignore ignores
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

What will be sent for analysis  (228 KB of 240 KB)

  Existing agent configuration   2 files     6 KB   CLAUDE.md (current, 41 blocks)
  Documentation                  7 files    58 KB   2 excerpted
  Manifests and tooling         12 files    31 KB
  Directory tree                1,284 files listed, depth 3
  Source samples                21 files    79 KB   4 test examples, 9 excerpted

  Not sent: 18,233 dependency files, 3 lockfiles, 1 file blocked (secret pattern)
  Ignored by .gitignore: 6 files   logs/app.log, server/config.js, … ([v] lists all)

  [Enter] Send for analysis   [v] View file list   [a] Add paths
  [x] Add exclusions   [q] Save and quit
```

- `v` lists each item with its reason and excerpt range, and every skipped or blocked path with its reason.
- `a` and `x` change the settings, recompute the selection, and show the summary again with the new size. Adding an `ignored` path with `a` makes that file a candidate again (§1.4); it then belongs to a tier as usual.
- The ignored line lists `ignored` files (§1.4), first in path order, with the count. When ignore rules were not applied, because git metadata is `unknown`, it reads instead `Ignore rules not applied (<reason>): only the default exclusions were used.`
- If the destination rule (§1.5) stops the session, this screen explains why and what to do, and nothing is sent.

After **Enter**, analysis runs. Progress shows the current call, elapsed time and cost so far. If the model requests expansion, the CLI shows what was requested and what was accepted or rejected, then continues automatically: expansion has already been validated against scope, exclusions and budget.

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
- After the last question, or when the budget is reached, a summary lists recorded decisions and skipped questions. Unasked questions are recorded as `unreached`.

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
| Unsupported session schema version | Names the version and the required CLI version. |

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
| `F-<n>` | Validated findings, including gaps and accepted absence claims | Calls 2–5 |
| `C-<n>` | Validated conflicts | Calls 2–5 |
| `Q-<n>` | Questions | Calls 4–5 |
| `D-<n>` | Current decisions | Calls 4–5 |
| `R-<n>` | Existing recommendations | Call 5 |
| `B-<n>` | Destination Guidance Blocks | Calls 1–5 |

New items in a response use response-local keys: `f1`, `g1`, `a1`, `c1`, `q1`, `r1`. A local key is valid only inside that response.

An alias in a response must exist in that call's input. An unknown alias rejects the item that uses it (rule `ALIAS-001`).

Block hashes are never sent back by the model. Code attaches the block ID and hash from the snapshot.

#### 3.2.2 Citations and provenance

Only calls 1 and 2 create citations. Later calls refer to validated findings by alias.

```ts
type Citation = {
  item: string;   // "T5-007" or "E-2"
  lines: string;  // "40-52"; a single line is "40-40"
  quote: string;  // verbatim text from within those lines
};
```

**Quote rules.** The quote is at least 12 characters and not only whitespace or punctuation. It is at most 200 characters, and may span lines using `\n`. It must match the sent content **exactly**: no normalisation of whitespace, case or punctuation.

**Validation**, in order:

1. **Item.** The item alias exists in this call's input (`CIT-001`).
2. **File currency.** The cited file's current hash matches the snapshot hash recorded for the item (`CIT-002`). A mismatch rejects the citation and marks the snapshot as unstable.
3. **Range.** `start ≤ end`, and the whole range lies within the lines actually sent for that item: its `included` lines, not omitted outline entries (`CIT-003`).
4. **Quote in range.** If the quote occurs exactly within the text of the cited lines, the citation is accepted.
5. **Line-range correction.** Otherwise, code counts exact occurrences of the quote in **all lines of that same item that were sent in this call**. It searches no other item, no other file, and no unsent content.
   - **Exactly one occurrence:** the range is corrected to the lines that occurrence spans. The quote and the claim are not changed. Both ranges are recorded: `{ originalLines, correctedLines, rule: "CIT-R01" }`.
   - **Zero occurrences** (including text that is only slightly different, or present only in unsent parts of the file): reject (`CIT-004`).
   - **Two or more occurrences:** reject (`CIT-005`).
6. **Evidence creation.** Code creates the Evidence record: path, file hash, final line range, basis (§3.2.4), and an excerpt **extracted by code** from the sent lines of that range. The model never supplies excerpt text.

The rate of corrected citations is recorded per call. A rising rate is a signal to investigate the prompt or the rendering format.

#### 3.2.3 Support checks

These run after provenance and check what code can about whether citations justify the claim. They don't prove a claim is right. They catch claims that clearly go beyond their evidence.

| Rule | Check | On failure |
|---|---|---|
| `SUP-001` Anchoring | Every inline-code token and path-like token in a statement appears in at least one cited excerpt, or is a path that exists in the snapshot. | Reject |
| `SUP-002` No model counts | A statement contains no quantity or frequency the model counted ("5 components", "most files"). Numbers are allowed only if they appear in a cited excerpt. Code computes and displays "seen in N cited files". | Reject |
| `SUP-003` No universal claims from samples | A `descriptive` finding whose citations are all `code_observation` must not use universal quantifiers (*all*, *every*, *always*, *never*, *none*, *only*). Samples support "some" or "in the files inspected", not "all". | Reject |
| `SUP-004` Prescriptive needs a prescriptive source | A `prescriptive` finding needs at least one citation with basis `documentation` or `existing_guidance` whose excerpt contains directive language (versioned word list: *must, should, always, never, do not, don't, required, prefer, use … instead*). | Reject |
| `SUP-005` Conflicts need distinct sources | A conflict links findings whose citations come from at least two different items. | Reject the conflict |

Anything these rules can't check is shown to the developer. Every finding is displayed with its excerpts, labelled **"source checked"**, never "verified". The developer can mark a finding as wrong (§2.5). Evaluation measures support accuracy separately. A model-based support check is a possible later addition, adopted only if evaluation shows it helps.

#### 3.2.4 Evidence basis

Basis is derived by code from where the cited item came from. The model never chooses it.

| Source | Basis |
|---|---|
| Tier 1 (agent configuration) | `existing_guidance` |
| Tier 2 (documentation) | `documentation` |
| Tiers 3 and 5, expansion items from source or configuration files | `code_observation` |
| Expansion items from documentation files (tier 2 patterns) | `documentation` |

A finding's basis is the set of its citations' bases.

Consequence: a code comment such as "always use X" is a `code_observation`. It can raise a question, but it cannot support a `prescriptive` finding until the developer confirms it. This is deliberately conservative.

#### 3.2.5 Known facts

Before call 1, code extracts facts it can determine without a model, and records them as findings with `producedBy: deterministic` and code-generated wording:

- commands from manifests: `package.json` scripts, Makefile targets, justfile recipes, Taskfile tasks, `pyproject.toml` script entries;
- existing agent configuration files and their paths;
- workspace packages.

They are sent to the model under a **known facts** heading, with aliases. The model must not restate them as new findings; restatements are dropped as duplicates (`DUP-002`). Commands from these facts always have the status `found_not_run`.

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

Every call has a fixed purpose, input, output schema, validation sequence and output limit. Schemas below are written as TypeScript types. Implementation defines them in Zod and generates JSON Schema from them (§3.7). Unknown fields are rejected everywhere. All string fields have the stated maximum lengths.

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
    scope: { kind: "repository" } | { kind: "paths"; paths: string[] };  // ≤ 10 paths
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
    findings: string[];        // ≥ 2 local keys
  }>;
  expansionRequests: ExpansionRequest[];  // max 5 (§1.8)
  contentNotices: Array<{      // max 10
    item: string;
    lines: string;
    description: string;       // ≤ 200; e.g. "text instructs the reader to ignore prior rules"
  }>;
};
```

**Validation**, in order:

1. Schema (§3.5).
2. Aliases (`ALIAS-001`).
3. Citations: provenance (§3.2.2), then support (§3.2.3), then basis derivation (§3.2.4).
4. Scope paths: each path or path prefix exists in the snapshot (`SCOPE-001`).
5. Gaps: each `relatedPath` matches at least one snapshot path. A gap about something that doesn't exist must be an absence claim instead (`GAP-001`). Then the coverage check: related content not sent → relabel `not_inspected` (§1.11).
6. Absence claims: evaluated against the full file list, with code-generated wording (§1.11).
7. Conflicts: at least two member findings survived validation; otherwise rejected (`CONF-001`). Then `SUP-005`.
8. Duplicates: identical normalised statements with the same scope keep the first (`DUP-001`). Restatements of known facts are dropped (`DUP-002`).
9. Expansion requests (§1.8).
10. Content notices: the cited lines must be sent lines of the item. Valid notices are recorded on the snapshot and shown in the findings view. They never change behaviour.

#### 3.3.3 `analyse_expansion`

**Input:** everything from `analyse`, plus validated call-1 records as `F-*` and `C-*`, plus expansion items `E-*`.

**Output:**

```ts
type AnalyseExpansionOutput = {
  findings: AnalyseOutput["findings"];       // new findings, max 20
  gaps: AnalyseOutput["gaps"];               // max 10
  absenceClaims: AnalyseOutput["absenceClaims"];
  conflicts: Array<{
    key: string;
    description: string;
    findings: string[];                      // local keys or F aliases, ≥ 2
  }>;
  revisions: Array<{                         // max 20
    target: string;                          // "F-3" or "C-1"
    action: "withdraw" | "replace";
    replacement?: string;                    // local key, required for "replace"
    reason: string;                          // ≤ 200
  }>;
  contentNotices: AnalyseOutput["contentNotices"];
};
```

There is no `expansionRequests` field; one expansion round only.

**Validation:** as for `analyse`, with these additions:

- Citations may target both `T*` and `E*` items.
- A `replace` requires its replacement to pass validation; otherwise the original is kept and the revision rejected (`REV-001`).
- Withdrawn and replaced records are kept for history with their status, and are no longer passed forward.
- Conflicts that lose a member below two are marked withdrawn with reason "member withdrawn".
- Known facts (`producedBy: deterministic`) cannot be withdrawn by the model (`REV-002`).

#### 3.3.4 `generate_questions`

**Input:** validated findings, gaps and conflicts with their excerpts (§3.2.6); destination blocks; directory tree; the question budget.

**Output:**

```ts
type GenerateQuestionsOutput = {
  questions: Array<{          // max 2 × question budget
    key: string;              // "q1"
    prompt: string;           // ≤ 200
    reason: string;           // ≤ 300
    resolves: string[];       // F or C aliases, ≥ 1
    scope: { kind: "repository" } | { kind: "paths"; paths: string[] };
    options: Array<{ label: string }>;   // 0–4, each ≤ 120
  }>;
};
```

Every question accepts a typed answer and a skip; the schema doesn't model those.

**Validation:**

1. Schema and aliases.
2. **Asks about intent, not documented policy** (`Q-001`): `resolves` must include at least one unresolved conflict, gap, or finding without `documentation` basis. A question linked only to documented, uncontested findings is rejected.
3. Scope paths exist (`SCOPE-001`).
4. Duplicates: questions with an identical `resolves` set keep the first (`DUP-003`).

**Ranking**, by code:

1. questions that resolve a conflict;
2. questions that resolve a gap of type `no_command` or `undetermined_ownership`;
3. questions that resolve other gaps;
4. questions about observed conventions;
5. within each class, the model's order (recorded).

The top questions up to the budget are presented. The rest are recorded with status `unreached` and reason `budget`.

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
    support: string[];        // F or D aliases, ≥ 1
    references: Array<{
      kind: "path" | "command";
      value: string;
      support: string;        // F alias whose evidence contains the value
    }>;
    scope: { kind: "repository" } | { kind: "paths"; paths: string[] };
  }>;
  heldBack: Array<{           // max 10
    topic: string;            // ≤ 200
    blockedBy: string[];      // Q or C aliases, ≥ 1
  }>;
  noChangeReason?: string;    // ≤ 400; only when recommendations is empty
};
```

**Validation**, in order:

1. Schema and aliases. All support must be current: not withdrawn, not superseded (`REC-001`).
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
8. Scope paths exist (`SCOPE-001`).
9. **Duplicates:** identical target and content keep the first (`DUP-004`).
10. **Held back:** each `blockedBy` alias must refer to a skipped or unreached question, or an unresolved conflict. Entries that fail are dropped (`HELD-001`).
11. **No change:** `noChangeReason` is accepted only when `recommendations` is empty (`REC-009`). If every recommendation fails validation, the session shows that results couldn't be verified (§2.12). This is never presented as a no-change outcome.

Two recommendations targeting the same block are allowed in the output. Mutual exclusion is handled at selection ([`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) §9.1).

#### 3.3.6 `regenerate_recommendations`

**When:** a decision is added, corrected or superseded after recommendations exist; or a refresh withdraws findings or changes blocks that recommendations depend on.

**Affected set**, computed by code: current recommendations whose support includes a changed or superseded decision, or a withdrawn finding, or whose target block no longer matches its hash. Unaffected recommendations are not sent, and their selections are unchanged.

**Input:** everything `recommend` receives, plus the affected recommendations as `R-*` (target, content, support), plus a code-generated summary of what changed.

**Output:**

```ts
type RegenerateOutput = {
  actions: Array<{
    target: string;            // "R-4"; every affected R exactly once
    action: "keep" | "revise" | "drop";
    reason: string;            // ≤ 200
    revision?: Omit<RecommendOutput["recommendations"][number], "key">;  // required for "revise"
  }>;
  additions: RecommendOutput["recommendations"];   // max 5
  heldBack: RecommendOutput["heldBack"];
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

### 3.5 Validation pipeline and recording

For every call:

1. **Transport:** the response arrives (§3.6).
2. **Schema:** structured-output parse and Zod validation, with unknown fields rejected.
3. **Items:** the per-call sequence above. Each item is validated independently. An item that fails one rule is dropped, and later rules are not run on it.
4. **Cross-item:** conflicts, duplicates, held-back entries, regeneration coverage.
5. **Persist:** accepted records, with `producedBy` pointing at the model call.

Every rejection or correction is recorded on the model call:

```ts
type ValidationEvent = {
  itemKey: string;     // response-local key or alias
  stage: "schema" | "item" | "cross_item";
  rule: string;        // stable ID, e.g. "CIT-004"
  outcome: "rejected" | "corrected" | "relabelled";
  detail: string;      // code-generated; no source content
  original?: unknown;  // e.g. originalLines for CIT-R01
};
```

Each call also records counts: proposed, accepted, corrected and relabelled items, and rejections by rule. Rule IDs are stable across versions. The validator has its own version (`validatorVersion`), recorded with every call, because changing a rule changes what is accepted even when the model output is identical.

### 3.6 Retry and failure policy

| Failure | Handling |
|---|---|
| Network error, server error, timeout | Retry the identical request up to 3 times with exponential backoff. Then fail the call (§2.12). |
| Rate limit | Honour the provider's retry-after; counts towards the 3 retries. |
| Schema failure (including output truncated at the token limit, or a refusal) | One retry: the identical request plus a short message listing **schema errors only**. A second failure fails the call. |
| Item-level validation failure | No retry. Item dropped and recorded. |
| Every item rejected | The call is recorded as completed with zero accepted items. The CLI offers one fresh retry of the identical request (§2.12). |
| Generation budget would be exceeded | Before each call, the estimated cost is checked against the remaining budget. If it would be exceeded, the call is not sent, and the session stops at that point (§2.12). |

The schema-retry message never includes semantic validation results. Telling the model which citations failed would teach it to make citations pass rather than be accurate.

Truncation is never fixed by raising the output limit automatically. Raising it is a settings change, and is recorded.

### 3.7 Prompts, schemas and versions

- **Prompts** are files in the repository, `prompts/<call>/<version>.md`, with semantic versions. Each call records `promptVersion` and `promptHash`.
- **Schemas** are Zod definitions in `schemas/<call>.ts`, each exporting a version. JSON Schema is generated at build time; each call records `schemaVersion` and `schemaHash`.
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
  - instructions embedded in repository content.

**Property tests:**

- No citation is ever accepted whose quote is absent from the content sent in that call.
- Range correction changes only the line range, never the quote, the claim or the item.
- The same response, input and validator version always produce identical accepted records and validation events.
- No accepted evidence excerpt contains text that wasn't sent in that call.

**Live suite:** manual runs against the product-development repositories, recording rejection and correction rates per rule. It is never run against evaluation repositories or materials.

### 3.9 Open points for this section

- Calibrating the directive-language and imperative-verb lists on development repositories, and measuring how often `REC-007` misses.
- Minimum quote length: 12 characters may allow unhelpfully generic quotes in code.
- Output limits per call (finding, question and recommendation counts).
- Whether a model-based support check is worth adding after the first slice. Adopt only if evaluation shows it reduces unsupported findings without excessive false rejections.
