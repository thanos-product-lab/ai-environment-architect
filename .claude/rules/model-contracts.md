---
paths:
  - "src/core/validation/**"
  - "schemas/**"
  - "prompts/**"
  - "test/fixtures/responses/**"
---

# Model contract rules

Changing a validator, schema or prompt? Use the `/validation-rule` skill. In short:

- Rule IDs are permanent. Never reuse or renumber one.
- Prompts are versioned files. Add a new version; never edit a released one.
- Changing what is accepted bumps `validatorVersion`. Changing the reference detector bumps `detectorVersion`.
- A schema-failure retry reports schema errors only, never semantic validation results (IMPL §3.6).
- The only repair of model output is the `CIT-R01` line-range correction. Quotes, statements and claims are never changed.
- Quote matching is exact. No whitespace, case or punctuation normalisation.
