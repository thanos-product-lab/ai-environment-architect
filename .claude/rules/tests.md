---
paths:
  - "test/**"
  - "**/*.test.ts"
---

# Test rules

- Fixture repositories are small and invented. Never copy content from a real repository, and never from Citizenship Workspace or evaluation materials.
- Tests never call a live model. Use recorded responses from `test/fixtures/responses/`.
- Each spec verification item (IMPL §1.15, §2.14, §3.8; DM §17) maps to a named test, or is listed as not testable with a reason.
- Tests that rely on file order, time or locale run under at least two orders or settings, to prove they don't depend on them.
- Name a validator test after its rule ID, for example `CIT-005 rejects a quote that appears twice`.
