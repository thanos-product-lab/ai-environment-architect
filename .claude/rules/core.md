---
paths:
  - "src/core/**"
---

# Core rules

- No terminal output, prompts, colour or `process.env` here. The CLI renders; core returns data.
- No network. Model calls go through the adapter interface, which tests replace with recorded responses.
- Determinism (IMPL §1.3): compare paths by bytes, never `localeCompare`. Read time and randomness only from injected providers. Never rely on filesystem enumeration order or object key order when hashing; serialise canonically.
- Hashes are SHA-256 over exact bytes, written as `sha256:<hex>`.
- Records are immutable. A change creates a new revision or superseding record (DM §15).
- Every rejection, correction or relabelling of model output produces a validation event with a stable rule ID (IMPL §3.5).
- Text that will leave the machine passes the secret scan immediately before the request is sent (IMPL §1.7), even if it was scanned earlier.
