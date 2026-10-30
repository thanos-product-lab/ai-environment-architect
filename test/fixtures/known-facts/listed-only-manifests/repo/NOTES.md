# Build this case in code

A plain fixture can't hold these bytes, so the test writes the files below into a
copy of this repository before capture. `CLAUDE.md` and `Taskfile.yml` are
committed as they are.

| Path | Bytes | Status (IMPL §1.4) |
|---|---|---|
| `package.json` | `{"scripts":{"build":"tsc"}}` with one NUL byte (0x00) inserted after `{` | `listed_only`, `contains_nul` |
| `Makefile` | `build:\n\techo caf` + byte 0xE9 + `\n` (Latin-1 `é`, not valid UTF-8) | `listed_only`, `not_utf8` |
| `justfile` | `build:\n    echo build\n`, padded with comment lines `# pad\n` to more than 262,144 bytes | `listed_only`, `too_large` |
| `.claude/notes.md` | `Agent notes` + one NUL byte + `\n` | `listed_only`, `contains_nul` |
| `docs/blob.txt` | `data` + one NUL byte + `\n` | `listed_only`, `contains_nul` |

Expected (see `../expected.json`):

- Each of the three manifests gives the gap "could not be read or parsed", in
  bytewise path order: `Makefile`, `justfile`, `package.json`.
- `.claude/notes.md` is `listed_only` and matches tier 1's patterns, so it is
  agent configuration with `entry` evidence (IMPL §3.2.4: a `listed_only` file
  under `.claude/` is `existing_guidance`).
- `docs/blob.txt` matches no tier's patterns (`.txt` is not Markdown), and the
  import in `CLAUDE.md` resolves to a `listed_only` entry. That counts for basis
  (§1.5, §3.2.4), so it is imported agent configuration even though selection
  never reads it.
- `Taskfile.yml` is readable and still gives its task.

This file is Markdown at the root, outside the tier 2 locations, so it gives no fact.
