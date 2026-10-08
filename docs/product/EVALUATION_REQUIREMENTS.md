# AI Environment Architect — Product Evaluation Requirements

Prepared 5 October 2026 for the new product repository.

**Status:** Product-facing handoff derived from Evaluation Plan v0.2 and Product Thesis v0.1. This is outside the frozen study materials. It does not amend the evaluation design or settle the product's interface, technology stack or exact MVP scope.

> **Note for this repository.** Section references of the form "plan §…" point to the Evaluation Plan, which is held by the evaluation maintainer and deliberately not included here. This document is the product's authority for evaluation-related requirements. Apart from the product name, its text is unchanged from the 5 October 2026 handoff.

## 1. What we are building

Help developers turn verified project knowledge and explicit developer decisions into a compact AI coding environment that stays useful as their software evolves.

The first workflow is:

**Connect a repository → inspect → clarify → recommend → review and apply.**

Maintenance extends that workflow by identifying specific stale guidance and proposing evidence-backed updates.

The hypothesis is that this reduces repeated corrections and wasted exploration during coding work. More generated files, longer instructions or high recommendation acceptance do not establish that benefit.

## 2. Why development can begin now

The evaluation plan required the assessment materials to be fixed before configuration-generator development began. That Stage 0 freeze was completed on 5 October 2026.

Product development can now begin. The complete evaluation cannot precede the product: it needs the product workflow to produce a configuration to test. Prepare the first usable workflow, assess it in the pilot, then conduct the reserved comparison under the evaluation team's controls.

## 3. Product requirements derived from the plan

### Evidence and uncertainty

- Link each factual finding and recommendation to repository evidence or an explicit developer decision.
- Keep documented requirements, observed patterns, developer-confirmed intent, conflicts and unknowns distinguishable.
- Record enough source identity to locate the evidence in the inspected snapshot: repository revision, path and relevant location. Changed or uncommitted content needs its own recorded identity.
- Do not turn a repeated implementation pattern into project policy without supporting documentation or developer confirmation.
- Report an unverified command as unverified. Finding a script is different from successfully running it.
- Preserve the complete findings and recommendations, including rejected ones, so reviewers can assess errors and omissions.

These requirements support command accuracy, reference validity, recovery of documented decisions and the evaluation's invented-policy measure (plan §§4–4.2).

### Targeted clarification

- Ask about ambiguity, conflicting conventions, ownership and intent that repository evidence cannot establish.
- Record each question, answer and its scope, including unanswered questions.
- Connect a confirmed decision to the recommendations it supports.
- Preserve manual edits made during configuration creation.

The clarification experience is part of the product being evaluated, including the developer effort it requires (plan §§3.1, 3.3, 8.2).

### Minimal, scoped guidance

- Explain what each proposed artifact is for and when it should apply.
- Inspect existing guidance before proposing additions, edits or removals.
- Surface contradictions and preserve deliberate existing guidance until the developer reviews a change.
- Keep unresolved assumptions visible instead of presenting them as established rules.
- Do not describe generated instructions as enforced permissions unless the target platform actually enforces them.

The product should make a smaller, clearer setup possible. File count and instruction length are not success measures (plan §§1, 2.1, 4; thesis §§5, 8).

### Review and application

- Present a reviewable diff and record which recommendations were accepted, edited or rejected.
- Apply the developer-approved changes and record the resulting configuration.
- Preserve the initial configuration and enough information to identify the final applied files precisely.
- Keep project documentation available. In the first study, documentation is held constant across setups; the generated treatment consists of agent configuration.

General product editing scope remains a product decision. The documentation constraint above is a condition of the first evaluation (plan §§2.1, 3.3).

### Reproducibility and measurement

- Identify the inspected repository snapshot, existing configuration, product version, target adapter, model and generation settings.
- Retain generation instructions and budgets in a sanitized record.
- Record configuration content hashes before downstream evaluation.
- Measure generation duration and available input, output and cached token usage and cost. Mark unavailable measurements explicitly; never substitute zero for unknown.
- Allow active developer review and clarification time to be recorded separately from elapsed generation time. A manual record is sufficient initially.
- Keep generation and maintenance measurements separate from downstream coding-run measurements.

Reproducibility here means traceable inputs and outputs, not a promise that a model will generate identical text on every run (plan §§3.3, 7, 8.2, 12).

### Maintenance

- Begin with supported checks such as missing referenced paths and renamed or removed commands.
- Show the evidence for a reported problem and any proposed replacement. Do not invent a destination when none is supported.
- Preserve still-valid guidance and surface relevant conflicts with manual edits for review.
- Record maintenance findings, proposed changes, review decisions and effort.
- State coverage limits. Semantic schema or architecture changes need stronger analysis than path and command checks provide.

The evaluation assesses finding precision and recall, repair accuracy, unnecessary changes and review effort independently (plan §9).

## 4. Suggested session export

The following is a proposed implementation contract, not a mandated file format. A simple versioned JSON record with companion diffs and configuration files is enough to start; no analytics service or dashboard is required.

Each session should export:

- **Identity:** session ID, timestamps, product version, target adapter and supported output scope.
- **Inputs:** repository snapshot identity, initial configuration inventory and hashes, model identifier, generation settings, prompt/template identity and budget.
- **Reasoning evidence:** findings, evidence references, uncertainty, questions, answers and scoped decisions.
- **Review:** recommendations, acceptance/rejection decisions and manual edits.
- **Outputs:** proposed diff, applied file list, final configuration hashes and unresolved issues.
- **Measurements:** elapsed time, separately recorded active developer effort, usage and cost where available, with explicit missing-value reasons.
- **Outcome:** completed, partial or failed, with actionable failure details.

Exclude credentials and secret values. Do not automatically export private source content or raw model transcripts when references and sanitized records suffice. Exact storage and retention policies remain product decisions.

## 5. Responsibilities of the separate evaluation

The product produces its configuration and supporting session record. The evaluation system owns:

- The comparison with existing configuration and a fixed, simple generation prompt.
- Coding tasks, independent acceptance checks, reference solutions and scoring rubrics.
- Isolated coding runs, budgets, patch collection, blind review and result records.
- Measurements of task success, correction-requiring mistakes and serious regressions.
- Study design, decision thresholds, maintenance fixtures and final conclusions.

The primary comparison is the complete product workflow versus simple non-interactive generation. The secondary comparison is versus the project's existing setup. The simple generator receives no answers from the product's clarification session (plan §§3–3.3).

The product does not need task IDs, task-specific rules, scoring logic or a built-in evaluation runner.

## 6. Isolation when starting the product repository

Copy this handoff and the Product Thesis into the new product repository. Start product development in a fresh conversation with only approved product materials.

Do not carry over the study reference sheet, maintainer answers collected for scoring, task candidates, task prompts, specifications, rubrics, checks, reference solutions, validation logs or prior evaluation conversations. The product should inspect the target repository and elicit intent through its own workflow.

Prevent configuration generators and future evaluated coding agents from accessing hidden study materials through the filesystem, tools, retrieval, shared memory or transcripts. A separate repository or fresh chat alone does not enforce that boundary.

Use independent product-development examples. Changes to frozen study materials are handled by the evaluation maintainer; a reserved task changed after the generator exists moves to the development set (plan §§3.3, 6.1, 7).

## 7. Recommended first implementation

These are scope recommendations from the thesis, not additional evaluation requirements:

1. Choose one supported coding agent and one delivery interface. Claude Code is the thesis's initial candidate; confirm that choice before implementation.
2. Build a complete single-repository workflow from inspection through reviewed application.
3. Include evidence links, clarification records and the session export from the beginning.
4. Add concrete stale-path and stale-command maintenance checks.
5. Use the pilot to assess mechanics, review burden and cost before the reserved comparison.

Broader multi-repository analysis, additional adapters and dynamic task assistance can follow. The evaluation does not establish developer demand; continue collecting real setup problems and feedback on the review experience.

## 8. Claims and interpretation

Do not claim improved coding performance until comparative results support it. The initial study uses autonomous runs as a proxy for corrections during interactive development. Its result applies to the studied repository and conditions; it does not establish effectiveness across typical projects.

Setup effort and maintenance burden matter alongside correctness. Any claim that the setup pays for itself must state the assumptions behind that estimate (plan §§2.2, 8.2, 8.5, 11).

## Source provenance

- **AI Environment Architect — Product Thesis**, working v0.1, 29 September 2026: product purpose, workflow and proposed scope.
- **AI Environment Architect — Evaluation Plan**, working v0.2, 29 September 2026: sections cited above. Authoritative plan SHA-256: `9cb7f54a3dcd7fa0c5666f8d57cfd42216de25262b47e9c6cffdb4c6faafbe7f`.
- Stage 0 freeze verified on 5 October 2026. This handoff contains no task-specific study content and can travel separately from the evaluation repository. The evaluation maintainer retains the authoritative plan; this document is a product-facing extraction, not a replacement for it.
