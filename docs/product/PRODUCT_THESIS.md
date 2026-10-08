# AI Environment Architect — Product Thesis

**AI Product Studio · 29 September 2026 · Working thesis v0.1**

**Status:** Core direction agreed. Product name, exact MVP scope, delivery interface, and performance claims remain subject to validation.

> **Update, 8 October 2026.** The product is now named **AI Environment Architect**. The delivery interface is decided: a standalone TypeScript CLI ([ADR 0001](../decisions/0001-standalone-typescript-cli.md)). Citizenship Workspace, mentioned below as a dogfooding candidate, is now the target of the frozen evaluation. Product development therefore uses independent repositories, and Citizenship Workspace is used only when the evaluation runs ([Evaluation Requirements §6](EVALUATION_REQUIREMENTS.md#6-isolation-when-starting-the-product-repository)). The rest of this thesis is unchanged.

## 1. Product thesis

Developers using coding agents need a practical way to decide which project knowledge to capture, how to organize it, and when to update it.

Our product analyses a software project, asks the developer about decisions the code cannot reveal, and proposes an AI coding environment tailored to that project. The developer can inspect the evidence, refine the recommendations, and apply a clear set of changes. As the project evolves, the product helps maintain that environment.

**Product promise:** Help developers create and maintain an AI coding environment that reflects how their software actually works.

The central hypothesis is that accurate, appropriately scoped project guidance can reduce repeated corrections and wasted exploration during agent tasks. This benefit must be demonstrated through evaluation.

## 2. First user

The initial user is a hands-on developer who regularly uses coding agents on an established product. They understand the codebase well enough to review recommendations, but configuring and maintaining agent guidance takes time and judgment.

Their software may live in one repository, a monorepo, or several related repositories. They already have conventions, testing practices, architectural boundaries, and recurring workflows worth examining.

Typical motivations include:

- Repeatedly explaining the same project-specific expectations.
- Uncertainty about which instructions, rules, or skills would be useful.
- Existing guidance that has become long, contradictory, or outdated.
- Difficulty expressing relationships between frontend, services, and model repositories.

Citizenship Workspace is a candidate for initial dogfooding. The `dashboard` / `core` / `detect` example provides a more demanding workspace scenario to validate separately.

## 3. Problem

Useful project knowledge is distributed across code, documentation, tests, existing agent configuration, and developers' heads. Turning that knowledge into a useful AI setup requires several decisions:

1. What does the agent need to know before starting a task?
2. What can it discover easily by inspecting the code?
3. Which guidance applies throughout the project?
4. Which guidance belongs to a particular directory or workflow?
5. Which patterns are intentional, and which are historical inconsistencies?
6. Which instructions have become inaccurate?

These decisions become harder when different repositories own different contracts or parts of a workflow. A frontend developer may need the agent to verify a field against a backend schema, while model changes require a separate evaluation process.

**Problem hypothesis:** Developers experience enough repeated setup and maintenance friction to value a tool that helps make these decisions reliably. Its frequency and cost still need user validation.

## 4. Job to be done

When I use a coding agent on an established project, help me identify and organize the project knowledge it needs, so I can apply a clear, maintainable setup and spend less time repeating corrections.

## 5. First-session outcome

**After reviewing a short set of findings and answering targeted questions, the developer can apply an understandable AI setup and knows why each part exists.**

The developer should leave the session with:

- A concise view of relevant project facts and unresolved assumptions.
- Recommendations linked to supporting files or explicit developer decisions.
- An explanation of when each proposed instruction or workflow applies.
- A reviewable diff that preserves deliberate existing guidance.
- A clear account of what was applied and what still needs clarification.

Generating fewer files, shortening an instruction, or removing obsolete guidance can be a successful outcome.

## 6. Product experience

| Stage | Product behaviour | Developer outcome |
|---|---|---|
| Connect | Accept explicit repository paths or a workspace of related repositories. | A clear analysis scope. |
| Inspect | Examine structure, scripts, tests, documentation, contracts, and existing agent configuration. | Findings with supporting evidence. |
| Clarify | Ask about ambiguity, ownership, preferred practices, and recurring workflows. | Intentional decisions distinguished from observed patterns. |
| Recommend | Propose a minimal set of instructions, scoped rules, skills, and workflows. | A configuration whose purpose and scope are understandable. |
| Review and apply | Present changes for selection and editing, then apply the approved result. | A usable setup that fits the developer's expectations. |
| Maintain | Detect specific stale references or changed assumptions and propose updates. | Guidance that remains useful as the project evolves. |

### Example clarification

The scanner finds that older components call `fetch` directly, while newer ones use `src/lib/api/client.ts`.

It asks: “Should new frontend work consistently use the API client?”

Once confirmed, it proposes a frontend-scoped instruction referencing the client and a representative usage example. The instruction records a developer decision; the presence of newer code alone does not establish policy.

## 7. Multiple repositories

The product should be able to represent related repositories as one workspace while keeping each repository's local guidance distinct.

| Repository | Illustrative role | Relevant guidance |
|---|---|---|
| `dashboard` | React/TypeScript frontend | UI conventions, API client usage, accessibility, frontend checks |
| `core` | Backend services | Public API ownership, service patterns, persistence, contract checks |
| `detect` | Python training and inference | Prediction schemas, evaluation procedures, data and model workflows |

These roles are illustrative and require confirmation in a real workspace.

The resulting environment has three levels:

- **Shared system context:** confirmed relationships and contract ownership.
- **Repository guidance:** local architecture, conventions, and verification commands.
- **Focused workflows:** procedures for changes that cross repository boundaries.

For example, frontend guidance might direct an agent to verify transaction fields against a specific schema in `core`. A workflow for exposing model explanations might identify the relevant prediction contract in `detect`, the response mapping in `core`, and the consuming UI in `dashboard`.

The initial product uses these relationships to design the AI environment. Dynamic task assistance is a possible later extension. Unavailable repositories remain explicit external dependencies with visible unknowns.

## 8. Product principles

### Evidence before recommendations

Link findings to files and distinguish observed facts, inferred patterns, and developer-confirmed decisions. Report uncertainty where evidence is incomplete.

### Minimal useful guidance

Every artifact should have a clear purpose and loading scope. Avoid duplicating information or introducing broad requirements without a demonstrated need.

### Ask about intent

Use code analysis to identify patterns and targeted questions. Let developers resolve conventions, ownership, and expectations that code cannot establish.

### Preserve existing work

Inspect current instructions, identify conflicts, and propose reviewable edits. Respect deliberate manual changes and make subsequent updates understandable.

### Keep guidance current

Start with concrete drift such as deleted paths, renamed commands, or changed schemas. Broader claims about architecture freshness need stronger evidence.

### Be precise about capabilities

Generated prose can communicate expectations. Actual permission enforcement depends on the target platform and its configured controls. Each supported adapter must represent those differences accurately.

## 9. Initial product boundary

**Agreed direction:** Analyse existing software, clarify developer intent, and recommend its AI coding environment.

**Proposed starting scope:**

- One coding-agent target; Claude Code is the initial candidate.
- Local repository analysis with an explicit scope.
- Evidence-backed findings and targeted clarification.
- A small set of generated or revised configuration artifacts.
- Diff review and application.
- Concrete checks for stale commands and paths.

Represent related repositories in the project model and validate a few explicit contract relationships before committing to broad cross-language analysis.

New-project scaffolding, several provider adapters, automatic learning from session history, dynamic task context, and organisation-wide administration are later candidates. The delivery interface—CLI, skill, plugin, or companion UI—remains open until the first workflow is tested.

## 10. Assumptions and validation

| Assumption | Validation approach |
|---|---|
| Developers repeatedly explain knowledge that guidance can address. | Collect concrete examples of corrections and inspect their causes. |
| The tool can recommend accurate guidance without inventing conventions. | Have repository maintainers review findings, evidence, and uncertainty. |
| The configuration improves agent work. | Compare representative tasks with and without the proposed setup. |
| Benefits exceed setup and maintenance effort. | Measure review effort, subsequent corrections, and recurring maintenance work. |
| Workspace relationships add value. | Test tasks involving known contracts across two or three repositories. |

For task evaluation, use comparable agent versions, tool access, repository revisions, and budgets. Include existing developer guidance and a straightforward agent-generated setup as baselines where practical. Keep evaluation tasks separate from examples used to tune recommendations, and repeat runs where variability could change the conclusion.

Measure:

- Task correctness and appropriate change scope.
- Number and severity of developer corrections.
- Accuracy and traceability of recommendations.
- Time to review and apply the setup.
- Runtime, token usage, and cost, including setup cost.
- Precision of drift findings and proposed updates.

Recommendation acceptance is useful feedback, but it does not establish improved agent performance. Avoid a generic health score until its components have a defensible connection to outcomes.

## 11. Fit with AI Product Studio

The project can demonstrate product judgment, repository analysis, structured AI outputs, configuration generation, evaluation design, and careful handling of uncertainty. Its review and clarification experience also creates room for strong interaction design.

The portfolio story should show an observed developer problem, a focused product response, and measured results. Using the tool on Citizenship Workspace provides a practical starting point; the related-repository scenario can demonstrate the next level of complexity.

## 12. Next decisions

1. Gather a small set of real setup problems and repeated corrections.
2. Select the first supported agent and delivery interface.
3. Define the exact outputs of a successful first session.
4. Establish baseline tasks and evaluation criteria.
5. Choose which single-repository and workspace capabilities belong in the first release.

**Thesis in one sentence:** Help developers turn verified project knowledge and explicit team decisions into a compact AI coding environment that stays useful as their software evolves.
