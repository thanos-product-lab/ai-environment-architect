# Live runs

The rates of each manual live run (M6 live-run protocol in `docs/MILESTONES.md`), appended by
`pnpm live-rates` from the run's saved session. The numbers are never edited by hand: fill in
only the Console fields.

## ses_dd088742-387c-4d19-9a1b-a905eff40db9 · 2026-11-27 · ofetch

- Commit: `1dbc37fd1ceab832fc7c90cad81b1091c95ba563`
- Model: `claude-opus-5-5`, effort `medium`
- Call 2: sent
- Budget: not reached
- Expansion round: 3 requests, 3 executed

### Sends

| Seq | Call | Attempt | State | Error | Proposed | Accepted | Corrected | Relabelled | Rejected | Input | Output | Cache read | Cache write | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 18 | analyse | 1 | completed |  | 33 | 21 | 0 | 3 | 12 | 32375 | 6234 | 0 | 0 | $0.2542 |
| 73 | analyse_expansion | 1 | completed |  | 4 | 2 | 0 | 0 | 2 | 39094 | 1644 | 0 | 0 | $0.1893 |
| 82 | generate_questions | 1 | completed |  | 7 | 7 | 0 | 0 | 0 | 6789 | 1310 | 0 | 0 | $0.0534 |
| 99 | recommend | 1 | completed |  | 7 | 4 | 0 | 0 | 3 | 9566 | 4459 | 0 | 0 | $0.1274 |

### By call

| Call | Sends | Retries | Schema failures | Refusals | Truncated | Truncation rate | Corrected citations |
|---|---|---|---|---|---|---|---|
| analyse | 1 | 0 | 0 | 0 | 0 | 0.0% | 0 of 42 |
| analyse_expansion | 1 | 0 | 0 | 0 | 0 | 0.0% | 0 of 8 |
| generate_questions | 1 | 0 | 0 | 0 | 0 | 0.0% |  |
| recommend | 1 | 0 | 0 | 0 | 0 | 0.0% |  |

### Rejections and corrections by rule

| Call | Rule | Rejected | Corrected | Relabelled |
|---|---|---|---|---|
| analyse | CONF-001 | 1 | 0 | 0 |
| analyse | GAP-002 | 0 | 0 | 3 |
| analyse | SUP-001 | 8 | 0 | 0 |
| analyse | SUP-003 | 3 | 0 | 0 |
| analyse_expansion | SUP-001 | 2 | 0 | 0 |
| recommend | REF-001 | 3 | 0 | 0 |

### Cost

- Estimated before each send, summed: $1.5513
- Priced from reported usage, summed: $0.6242
- Tokens reported, summed: 101471
- Console spend limit: 20 USD, set on 27 Nov 2026
- Console spend for this run: 0.62 USD

### Across saved runs

- Call 2 ran in 1 of 1 saved sessions where it is known whether it was needed.

### Observations

Changed after this run (IMPL v0.70, `validate/0.19.0`): the detector, `references/1.3.0`, finds an inline code span naming a snapshot file or directory as a path, and `.ts` or `*.ts` as an identifier, so `r1`–`r3` now pass `REF-001`; and `REF-003` accepts a command a current decision states in inline code, as `stated_by_developer`.

Calibration candidates, to weigh once all three development repositories have run. No prompt or word list is changed for them yet.

- **`SUP-001`, tokens beyond the cited lines (prompt).** All 10 `SUP-001` rejections in calls 1–2 are findings whose statement names inline code that no cited excerpt holds. Most of it is in a cited file, outside the cited lines: for example `f9`'s `pnpm lint` and `pnpm build`, cited only for the matrix and the `vitest` line, and `f15`'s `src/types.ts` and `createFetch` beyond its three citations. The fix is probably in the prompt: cite every line a code token comes from, or leave the token out.
- **`SUP-003`, "only" in single-file facts.** `f1` ("ESM-only", "publishes only `dist`"), `f5` ("type-only imports") and `f6` ("type-checks only `src` and `test`") were rejected as universal claims from code. `f1` and `f6` state what one cited file says, which a single excerpt can establish; `f5`'s only match, and one of `f1`'s, is a hyphenated compound, not a quantifier. Candidates: exempting a claim scoped to the one file it cites, and not matching "only" inside a hyphenated compound.
- **The lost `ufo` conflict (absence within a file).** `c1`, README's `ufo` against the local URL helpers, failed `CONF-001` because its member `f18` failed `SUP-001`: "`ufo` is not listed in `package.json`" names a token that, being absent, no excerpt can hold. An absence within one file has no form that passes today; an absence claim covers only whole paths (IMPL §1.11). The README/code mismatch never reached a question.
- **A withdrawal kept when its replacement failed.** Call 2 withdrew `F-21`, the gap that `.editorconfig` wasn't read, with the reason that a new finding records its settings; that finding, call 2's `f1`, failed `SUP-001`. The withdrawal stood alone, so the session lost the gap and gained nothing. The model used `withdraw`, not `replace`, so the revision rules couldn't tie the two together. Candidates: a prompt line to use `replace` when a new finding takes a withdrawn one's place, or a rule that refuses a withdrawal whose reason names a rejected item.
- **Snapshot names that are also other names (`references/1.3.0`).** Kept failing closed on purpose: a span naming a snapshot entry is a path even when it means something else. `.git`, listed as excluded, fails `REF-001` undeclared and `REF-004` declared. Count how often this rejects real recommendations. Since IMPL v0.71, a name that is also a command known fact's, such as ofetch's `test` directory and `test` script, passes either way.
- **The decision route isn't in the prompt yet.** D-3, "Run `pnpm tsc --noEmit`", now qualifies under `REF-003`, but `recommend` 1.0.0 still says a reference's `support` is an `F` alias, and this run made no recommendation from D-3. D-2 states `pnpm automd` in plain text, so it wouldn't qualify.

## Prompt versions for the next runs

`recommend` 1.0.1 adds one thing to 1.0.0: a command reference may name a `D` alias when that decision's statement contains the command in inline code (`REF-003`, IMPL v0.70). The other prompts stay at 1.0.0. The ofetch run above used `recommend` 1.0.0; the kutt and claude-code-action runs use `recommend` 1.0.1, so their `recommend` rates aren't directly comparable with ofetch's on that point.

Caveats for those runs:

- `regenerate_recommendations` 1.0.0 still says a reference's `support` is one `F` alias, but call 5 now shows the model a decision-supported command with its `D` alias (IMPL §3.2.6). A regeneration may drop such a command, or move it to an `F` alias, which fails `REF-004`. Watch call 5 for this; a matching `regenerate_recommendations` 1.0.1 is not released.
- `recommend` 1.0.1 says "whose statement contains", without "current" or "not its exceptions". A command cited from a decision's exceptions fails `REF-003`; count it if it happens.
