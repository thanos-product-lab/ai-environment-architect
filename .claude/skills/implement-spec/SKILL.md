---
name: implement-spec
description: Implement one numbered section of the implementation specification or domain model, tests first, keeping code and spec in step. Use when starting work on a section such as "IMPL 1.6" or "DM 9.3".
argument-hint: [spec section, e.g. "IMPL 1.6"]
disable-model-invocation: true
---

Implement $ARGUMENTS.

1. **Locate.** Read the section in full, plus every section it cites in `docs/architecture/DOMAIN_MODEL.md` and `docs/architecture/IMPLEMENTATION_SPEC.md`. Read the matching verification list: IMPL §1.15, §2.14 or §3.8, or DM §17.

2. **Extract requirements.** Write a numbered checklist covering every required behaviour, default value, rule ID and applicable verification item. Show it before writing any code. Flag anything ambiguous or contradictory, and ask rather than guess.

3. **Tests first.** Write one test per testable checklist item. For validators or model contracts, ask the `fixture-adversary` agent for adversarial fixtures; it hasn't seen your implementation. Run the tests and confirm they fail.

4. **Implement** the smallest code that passes. Keep `src/core` free of I/O beyond injected interfaces.

5. **Divergence.** If the spec is wrong or impractical, stop and propose the spec change in words. Once the developer agrees, edit the spec in the same change, add a line to its "Changes" list, and bump its version.

6. **Verify.** Run the typecheck and tests listed in `CLAUDE.md`. Then ask the `spec-reviewer` agent to review the section and the diff. Fix what it finds, or explain why a finding doesn't apply.

7. **Report:**
   - the checklist, each item mapped to a test name or "not testable: reason";
   - any spec changes;
   - open questions.
