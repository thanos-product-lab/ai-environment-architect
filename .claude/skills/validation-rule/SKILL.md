---
name: validation-rule
description: Add or change a model-output validation rule, output schema or prompt (rule IDs such as CIT-004 or REC-007), keeping IDs stable, versions bumped and fixtures complete. Use whenever changing validators, files under schemas/ or prompts/, or recorded model responses.
argument-hint: [rule ID or call name]
---

Apply this procedure to $ARGUMENTS.

1. **IDs are permanent.** A new rule gets the next ID in its family: ALIAS, CIT, SUP, SCOPE, GAP, CONF, DUP, REV, Q, REC, REF, HELD or REGEN. Never reuse or renumber an ID. A retired rule is marked retired in the spec, not deleted.

2. **Spec first.** Update the rule's definition in IMPL §3.2–§3.5 in the same change.

3. **Fixtures.** For each affected rule, add at least one response that must be rejected (or corrected, or relabelled) and one near miss that must be accepted, in `test/fixtures/responses/<call>/`, named by rule ID. Ask the `fixture-adversary` agent for more. For `CIT-R01`, assert the original and corrected ranges, and that the quote and the statement are unchanged.

4. **Versions:**
   - a change to what is accepted bumps `validatorVersion`;
   - a change to the reference detector bumps `detectorVersion`;
   - a prompt change is a new file, `prompts/<call>/<version>.md`; released versions are never edited;
   - a schema change bumps that schema's version.

5. **Never:**
   - include semantic validation results in a model retry (IMPL §3.6);
   - repair any part of an item other than the `CIT-R01` line range;
   - normalise quotes before matching.

6. **Run the full contract suite,** not only the new fixtures. The property tests in IMPL §3.8 must still pass.
