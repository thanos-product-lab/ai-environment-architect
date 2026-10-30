# Build this case in code

Committed fixtures must not match any secret rule (IMPL §1.7), so the secret
values here are placeholders. Before running the case, the test copies the
repository and replaces each placeholder with a value joined from fragments
at test time.

`__AWS_KEY_ID__` is the join of these three fragments, matching `aws-access-key-id`:

- `AKIA`
- `IOSFODNN7`
- `EXAMPLE`

`__CONN_STRING__` is the join of these four fragments, matching `connection-string`:

- `postgres`
- `://app:`
- `s3cr3tpass`
- `@db.internal/app`

The test also creates an empty file `.claude/<AWS key>.md`, where `<AWS key>` is
the joined `__AWS_KEY_ID__` value. The secret scan withholds its path, so it gives
no agent-configuration fact and no gap (IMPL §3.2.5, last paragraph of Gaps).

Expected, after substitution (see `../expected.json`):

- `Makefile` line 3 defines a target whose name matches, so both the statement
  and the excerpt match. That fact is withheld, giving one gap for `Makefile`.
- `package.json` lines 4 and 5 match in the excerpt only. Both facts are withheld,
  but the file gives only one gap.
- `package.json` line 6 holds a publishable `pk_test_` key. It is not a secret,
  so the `pay` fact is created.
- With the placeholders left in place, every fact is created and there are no gaps.
  The test should assert that it substituted the values.

This file is Markdown at the root, outside the tier 2 locations, so it gives no fact.
