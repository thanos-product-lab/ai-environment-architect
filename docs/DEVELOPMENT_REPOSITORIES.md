# Development repositories

**AI Environment Architect · First slice**

These are the real repositories we develop and run the tool against (M0, and the live runs in M2 and M6). They are chosen by the developer, not by Claude.

## Rules

- **None of them is evaluation material.** Citizenship Workspace, the evaluation repository, and its tasks, checks, rubrics and reference solutions are never used here ([Evaluation Requirements §6](product/EVALUATION_REQUIREMENTS.md#6-isolation-when-starting-the-product-repository)).
- **Each is pinned to a commit**, so runs on different days see the same snapshot. Change a pin only on purpose, and add a line to the change log below.
- **The tool never writes to them** except through apply with an approved content hash, and never commits, stages or pushes in them (CLAUDE.md invariants).
- Clone them outside this repository.

## The three slots

M0 asks for one repository of each kind:

1. **Small and well documented:** a clear README and docs, a consistent style.
2. **Mixed conventions, little documentation:** the tool has to infer from code and ask questions.
3. **Has an existing `CLAUDE.md`:** tests revising existing guidance rather than writing it from scratch.

## Repositories

| Slot | Name | URL | Pinned commit | Why it was chosen | Documentation level | Has `CLAUDE.md` |
|---|---|---|---|---|---|---|
| 1. Small, well documented | ofetch | https://github.com/unjs/ofetch | `1dbc37fd1ceab832fc7c90cad81b1091c95ba563` | A very small TypeScript library (33 files, 19 source), so a full session is cheap and its findings are easy to check by hand. | Good: README and CHANGELOG | No |
| 2. Mixed, little documentation | kutt | https://github.com/thedevs-network/kutt | `279b491b53bbd01fbae70f603222526962772061` | A JavaScript web app (server, templates, database; 221 files) whose only Markdown file is the README, so most conventions must be inferred from code or asked about. | Minimal: README only | No |
| 3. Existing `CLAUDE.md` | claude-code-action | https://github.com/anthropics/claude-code-action | `1d6de8cb0c237e7c15e9e1bdf973826ebae490cc` | A small TypeScript project (225 files) with a root `CLAUDE.md` and several other docs, which tests revising existing guidance, including the outcome that no change is justified. | Good: README, CONTRIBUTING, ROADMAP, SECURITY and more | Yes (root) |

- **Pinned commit:** the full 40-character SHA.
- **Documentation level:** one of *good*, *partial* or *minimal*, with a few words on what exists, for example "README and docs/ folder" or "README only".
- **Has `CLAUDE.md`:** *yes (root)*, *yes (nested only)* or *no*.

## Change log

- **10 October 2026:** template created. Entries chosen by the developer from a shortlist; each pinned to its default branch's head on this date, found with `git ls-remote`. Facts above come from public GitHub metadata; none of the repositories has been cloned or read yet.
