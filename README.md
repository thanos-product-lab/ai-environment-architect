# AI Environment Architect

A command-line tool that reads your repository and helps you write a better `CLAUDE.md` for it. It shows you where every suggestion comes from, and it doesn't write anything until you've approved the exact file.

## Why I'm building this

I use coding agents every day, and I kept explaining the same things to them: which command runs the tests, where new code should go, which of the three patterns in the codebase is the one we actually want. Most of that knowledge already exists somewhere in the repository. The rest is in my head.

Writing it down in a `CLAUDE.md` helps, but it's surprisingly hard to do well. You have to decide what's worth saying, what the agent can figure out on its own, and which "conventions" are really just old code nobody has cleaned up. And once the file exists, it slowly drifts away from the code.

So I wanted a tool that does the reading for me, tells me what it found and where, asks me about the things it can't know, and then proposes changes I can check line by line.

## How a session works

1. **Inspect.** The tool picks a limited set of files from the repository and shows you exactly what it's about to send before anything leaves your machine. The model then reports what it found, and every finding points to the lines it came from.
2. **Clarify.** Where the evidence is mixed or missing, it asks you a few questions. If you skip one, it stays open. The tool never answers for you.
3. **Recommend.** It proposes specific additions, edits and removals to your `CLAUDE.md`, each with the reason and the evidence behind it.
4. **Review.** You accept or reject each one, then look at the final file and its diff.
5. **Apply.** It checks that nothing relevant changed since it looked, and writes exactly what you approved. It never commits.

A session can also end with no changes. If your current `CLAUDE.md` is already accurate, hearing that is a good result.

## The rules I hold it to

- Code, not the model, checks that every quoted line really exists in the files that were read.
- Something the model notices in the code never becomes a project rule on its own. A rule needs documentation behind it, or your explicit decision.
- Unknowns stay unknown. Gaps and unanswered questions are recorded, not filled in with a guess.
- Accepting a recommendation doesn't write anything. Your approval covers one exact version of the file, and it expires if anything it depends on changes.
- The final file is put together by code from the recommendations you accepted, so every changed line can be traced back to its reason.
- It's honest about its limits. Commands are reported as found, never run. The secret scan blocks known patterns but can't catch everything. And the selected files are sent to the model provider, so this isn't fully local.

## Where things stand

I'm building the first version, and it isn't usable end to end yet. Right now I'm on **milestone 5 of 8**.

Done so far:

- Taking a reproducible snapshot of a repository, and parsing `CLAUDE.md` without losing a single byte.
- Choosing which files the model sees, with a secret scan. You can already try this part: `inspect` prints the "What we read" summary for a repository and sends nothing.
- Validating model output: checking citations, evidence and gaps against what was actually read, tested with recorded responses.
- Sessions that survive interruption and are checked when they're loaded again.

In progress (M5): the write path. That means detecting references to files, putting the new `CLAUDE.md` together from accepted recommendations, review and approval, and applying the result safely. All of it is driven by recorded model responses for now.

Still to come: real Claude API calls (M6), the interactive CLI (M7), and the session export and first release (M8). The full plan is in [Milestones](docs/MILESTONES.md).

I'm not claiming it makes coding agents better yet. That gets measured once there's something to measure.

## What the first version covers

- One local repository at a time.
- One output: the root `CLAUDE.md`, for Claude Code.
- A standalone TypeScript CLI that uses the Claude API.
- Read-only inspection. It never runs the repository's scripts.
- A structured export of each session, for review and evaluation.

Not yet: multiple repositories, scoped rule files, skills and commands, other coding agents, checks for guidance that has gone stale, and a review UI.

## How it will be evaluated

The real question is whether this setup means fewer corrections when you work with a coding agent. That will be tested in a separate evaluation, planned in advance. Its materials were frozen before I started building and live outside this repository, so I can't tune the tool to pass it. What the product has to record for it is in [Evaluation Requirements](docs/product/EVALUATION_REQUIREMENTS.md).

## Trying it

You'll need the Node version in `.node-version` and pnpm through Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node dist/cli/main.js inspect path/to/repo
```

`corepack pnpm check` runs the typecheck, lint, tests and build.

## Further reading

- [Product Thesis](docs/product/PRODUCT_THESIS.md): the problem, who it's for, and what still needs validating
- [Domain Model](docs/architecture/DOMAIN_MODEL.md): records, evidence rules, review, approval and apply
- [Implementation Specification](docs/architecture/IMPLEMENTATION_SPEC.md): context selection, the CLI, model calls and validation, persistence
- [Evaluation Requirements](docs/product/EVALUATION_REQUIREMENTS.md): what each session must record
- [ADR 0001](docs/decisions/0001-standalone-typescript-cli.md): why a standalone CLI and not a Claude Code plugin
- [ADR 0002](docs/decisions/0002-toolchain.md): the toolchain
- [Milestones](docs/MILESTONES.md): the build order and current progress

## Part of Thanos Product Lab

This is the second project in [Thanos Product Lab](https://github.com/thanos-product-lab), after [Citizenship Workspace](https://github.com/thanos-product-lab/citizenship-workspace). Both are about the same question: how to use AI in software where being wrong matters, without letting its output quietly become the truth.
