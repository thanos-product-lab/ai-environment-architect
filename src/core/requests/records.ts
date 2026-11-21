import { escapeDelimiters, jsonString } from "../context/escape.js";
import { scanText } from "../context/secrets.js";
import type { CitedExcerpt } from "../context/token-check.js";
import { comparePaths } from "../paths.js";
import { currentState } from "../session/current.js";
import { activeDestination } from "../session/exclusion.js";
import { blockedEvidenceRules } from "../session/expansion.js";
import { lineageOf, type Revised, type SessionLog } from "../session/log.js";
import type { EvidenceRecord, RecordOf, SessionRecord } from "../session/records.js";
import { resolveTarget } from "../session/targets.js";
import type { AliasSources } from "../validation/aliases.js";
import { blockAlias } from "../validation/aliases.js";

// Rendering validated records for calls 2–5 (IMPL §3.2.6). Code writes the structure, aliases,
// labels, excerpts and absence wording; the text fields are the validated text as recorded.
//
// - `withholdForCall` scans each record's text fields and excerpts before numbering, and
//   appends a `secret_withheld` for each record that matches or is left with no excerpt.
// - `numberRecords` numbers what is current: the known facts sent in call 1 keep their call-1
//   aliases, a withheld one's number unused; the rest follow by the seq of their first revision.
// - The render functions are pure, over the numbered records.

export type RecordsCall =
  | "analyse_expansion"
  | "generate_questions"
  | "recommend"
  | "regenerate_recommendations";

export interface RecordNumbering {
  readonly call: RecordsCall;
  /** The `findingId` of each known fact sent in call 1, in its alias order, `F-1` first. */
  readonly knownFactsSent: readonly string[];
  /** Call 5: the affected recommendations sent, by `recommendationId`, in recommendation order. */
  readonly recommendations?: readonly string[];
}

export interface Aliased<T> {
  readonly alias: string;
  readonly record: T;
}

type Finding = Revised<"finding">;
type Conflict = Revised<"conflict">;
type Question = Revised<"question">;
type Decision = RecordOf<"decision">;
type Recommendation = Revised<"recommendation_revision">;

export interface NumberedRecords {
  readonly call: RecordsCall;
  /** In alias order. */
  readonly findings: readonly Aliased<Finding>[];
  readonly conflicts: readonly Aliased<Conflict>[];
  readonly questions: readonly Aliased<Question>[];
  readonly decisions: readonly Aliased<Decision>[];
  readonly recommendations: readonly Aliased<Recommendation>[];
  /** For `createAliasTable`, by record ID; a `null` finding leaves its number unused. */
  readonly sources: {
    readonly findings: readonly (string | null)[];
    readonly conflicts: readonly string[];
    readonly questions: readonly string[];
    readonly decisions: readonly string[];
    readonly recommendations: readonly string[];
  } & Pick<AliasSources, "findings">;
  /** The alias of a finding, conflict, question or recommendation lineage, or a decision. */
  aliasOf(id: string): string | undefined;
}

const TAKES_QUESTIONS: ReadonlySet<RecordsCall> = new Set([
  "recommend",
  "regenerate_recommendations",
]);

function isKnownFact(finding: Finding): boolean {
  return finding.kind === "claim" && finding.producedBy === "deterministic" && "fact" in finding
    ? finding.fact !== undefined
    : false;
}

/** The seq of each lineage's first revision, or a decision's own. */
function firstSeqs(records: readonly SessionRecord[]): ReadonlyMap<string, number> {
  const seqs = new Map<string, number>();
  for (const record of records) {
    const id = lineageOf(record) ?? record.id;
    if (!seqs.has(id)) seqs.set(id, record.seq);
  }
  return seqs;
}

export function numberRecords(
  records: readonly SessionRecord[],
  numbering: RecordNumbering,
): NumberedRecords {
  const state = currentState(records);
  const seq = firstSeqs(records);
  const bySeq =
    <T>(id: (record: T) => string) =>
    (a: T, b: T) =>
      (seq.get(id(a)) ?? 0) - (seq.get(id(b)) ?? 0);
  const aliases = new Map<string, string>();

  const findings: Aliased<Finding>[] = [];
  const findingSources: (string | null)[] = [];
  const sent = new Set(numbering.knownFactsSent);
  numbering.knownFactsSent.forEach((findingId, index) => {
    const finding = state.findings.get(findingId);
    findingSources.push(finding?.id ?? null);
    if (finding === undefined) return;
    const alias = `F-${index + 1}`;
    findings.push({ alias, record: finding });
    aliases.set(findingId, alias);
  });
  const others = [...state.findings.values()]
    .filter((finding) => !sent.has(finding.findingId) && !isKnownFact(finding))
    .sort(bySeq((finding) => finding.findingId));
  for (const finding of others) {
    const alias = `F-${findingSources.length + 1}`;
    findingSources.push(finding.id);
    findings.push({ alias, record: finding });
    aliases.set(finding.findingId, alias);
  }

  const numbered = <T extends SessionRecord>(
    list: readonly T[],
    kind: string,
    id: (record: T) => string,
  ): Aliased<T>[] =>
    list.map((record, index) => {
      const alias = `${kind}-${index + 1}`;
      aliases.set(id(record), alias);
      return { alias, record };
    });

  const conflicts = numbered(
    [...state.conflicts.values()].sort(bySeq((c) => c.conflictId)),
    "C",
    (c) => c.conflictId,
  );
  const questions = TAKES_QUESTIONS.has(numbering.call)
    ? numbered(
        [...state.questions.values()].sort(bySeq((q) => q.questionId)),
        "Q",
        (q) => q.questionId,
      )
    : [];
  const decisions = TAKES_QUESTIONS.has(numbering.call)
    ? numbered(
        [...state.decisions.values()].sort((a, b) => a.seq - b.seq),
        "D",
        (d) => d.id,
      )
    : [];
  const recommendations =
    numbering.call === "regenerate_recommendations"
      ? numbered(
          (numbering.recommendations ?? [])
            .map((id) => {
              const revision = state.recommendations.get(id);
              if (revision === undefined) throw new Error(`${id} has no current revision`);
              return revision;
            })
            .sort(bySeq((r) => r.recommendationId)),
          "R",
          (r) => r.recommendationId,
        )
      : [];

  return {
    call: numbering.call,
    findings,
    conflicts,
    questions,
    decisions,
    recommendations,
    sources: {
      findings: findingSources,
      conflicts: conflicts.map((c) => c.record.id),
      questions: questions.map((q) => q.record.id),
      decisions: decisions.map((d) => d.record.id),
      recommendations: recommendations.map((r) => r.record.id),
    },
    aliasOf: (id) => aliases.get(id),
  };
}

// --- Withholding before aliases -------------------------------------------------------------

export interface Withholding {
  readonly withheld: readonly RecordOf<"secret_withheld">[];
  /** Evidence IDs whose excerpts render `(excerpt withheld)`, in rendering order. */
  readonly withheldExcerpts: ReadonlySet<string>;
  /** The rule each withheld excerpt matched, or its blocked file's (§1.8). */
  readonly excerptRules: ReadonlyMap<string, string>;
}

/**
 * Scans what the call would send (IMPL §3.2.6, §1.7): each record's text fields, and each
 * excerpt on its own. Appends a `secret_withheld` for a record whose text matches, and for a
 * finding left with no excerpt that isn't withheld. Excerpts of files the expansion round
 * blocked are withheld too (§1.8). Running it again appends nothing.
 */
export function withholdForCall(log: SessionLog, numbering: RecordNumbering): Withholding {
  const records = log.records;
  const candidates = numberRecords(records, numbering);
  const evidence = evidenceById(records);
  const blocked = blockedEvidenceRules(records);
  const excerptRules = new Map<string, string>();
  const withheld: RecordOf<"secret_withheld">[] = [];
  const withhold = (itemId: string, secretRuleId: string) => {
    withheld.push(
      log.append({ type: "secret_withheld", itemId, secretRuleId }) as RecordOf<"secret_withheld">,
    );
  };

  for (const { record: finding } of candidates.findings) {
    const textRule = firstMatch(findingTexts(finding));
    if (textRule !== undefined) {
      withhold(finding.findingId, textRule);
      continue;
    }
    if (!("evidenceIds" in finding)) continue;
    // Excerpts only: `entry` evidence sends no content. No producer mixes the two in one claim
    // (known facts are all entries or one excerpt, model claims cite lines), so this agrees
    // with `withholdBlockedFiles`, which looks at all evidence.
    const rules: (string | undefined)[] = [];
    for (const id of finding.evidenceIds) {
      const item = evidence.get(id);
      if (item?.kind !== "lines") continue;
      const rule = blocked.get(id) ?? scanText(item.excerpt);
      if (rule !== undefined && !excerptRules.has(id)) excerptRules.set(id, rule);
      rules.push(rule);
    }
    if (rules.length > 0 && rules.every((rule) => rule !== undefined))
      withhold(finding.findingId, rules[0] as string);
  }
  for (const { record } of candidates.conflicts) {
    const rule = scanText(record.description);
    if (rule !== undefined) withhold(record.conflictId, rule);
  }
  for (const { record } of candidates.questions) {
    const rule = firstMatch([record.prompt, ...scopeTexts(record.scope)]);
    if (rule !== undefined) withhold(record.questionId, rule);
  }
  for (const { record } of candidates.decisions) {
    const rule = firstMatch([record.statement, ...record.exceptions, ...scopeTexts(record.scope)]);
    if (rule !== undefined) withhold(record.id, rule);
  }
  return { withheld, withheldExcerpts: new Set(excerptRules.keys()), excerptRules };
}

function firstMatch(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const rule = scanText(text);
    if (rule !== undefined) return rule;
  }
  return undefined;
}

type Scope =
  | { readonly kind: "repository" }
  | { readonly kind: "paths"; readonly paths: readonly string[] };

function scopeTexts(scope: Scope): readonly string[] {
  return scope.kind === "repository" ? [] : scope.paths;
}

function findingTexts(finding: Finding): readonly string[] {
  if (finding.kind === "claim")
    return [
      finding.statement,
      ...(finding.uncertainty === undefined ? [] : [finding.uncertainty]),
      ...scopeTexts(finding.scope),
    ];
  if (finding.kind === "gap") return [finding.statement, ...finding.relatedPaths];
  return [finding.statement, finding.pathGlob];
}

function evidenceById(records: readonly SessionRecord[]): ReadonlyMap<string, EvidenceRecord> {
  return new Map(
    records.flatMap((r) => (r.type === "evidence" ? [[r.id, r as EvidenceRecord] as const] : [])),
  );
}

// --- Rendering -------------------------------------------------------------------------------

export interface RenderContext {
  readonly records: readonly SessionRecord[];
  /** The active destination's bytes, verified against its hash, or undefined when absent. */
  readonly destination: Uint8Array | undefined;
  /** From `withholdForCall`. */
  readonly withheldExcerpts: ReadonlySet<string>;
  /** Excerpts the token check removed (IMPL §1.10). */
  readonly removedExcerpts: ReadonlySet<string>;
}

export interface RecordSections {
  readonly findings: string;
  readonly conflicts: string;
  readonly questions: string;
  readonly decisions: string;
  readonly recommendations: string;
}

/** A framed section; the frame is rendered even when the body is empty. */
export function section(name: string, body: string): string {
  return `<<<${name}>>>\n${body}<<<END ${name}>>>\n`;
}

export function renderRecordSections(
  numbered: NumberedRecords,
  context: RenderContext,
): RecordSections {
  const bodies = recordBodies(numbered, context);
  return {
    findings: section("FINDINGS", bodies.findings.join("")),
    conflicts: section("CONFLICTS", bodies.conflicts),
    questions: section("QUESTIONS", bodies.questions),
    decisions: section("DECISIONS", bodies.decisions),
    recommendations: section("RECOMMENDATIONS", bodies.recommendations),
  };
}

/**
 * Call 2's known-facts section (IMPL §3.2.6): the facts sent in call 1 that are still current,
 * with their call-1 aliases, in the frame call 1 sent.
 */
export function renderKnownFactsAgain(
  numbered: NumberedRecords,
  context: RenderContext,
): { readonly text: string; readonly bytes: number; readonly facts: number } {
  const bodies = recordBodies(numbered, context);
  const facts = bodies.findings.filter((_, i) =>
    isKnownFact(numbered.findings[i]?.record as Finding),
  );
  const text = section("KNOWN FACTS", facts.join(""));
  return { text, bytes: Buffer.byteLength(text, "utf8"), facts: facts.length };
}

/** Call 2's call-1 results (IMPL §3.2.6): the `F` records other than known facts, then the `C`. */
export function renderCallOneResults(numbered: NumberedRecords, context: RenderContext): string {
  const bodies = recordBodies(numbered, context);
  const findings = bodies.findings.filter(
    (_, i) => !isKnownFact(numbered.findings[i]?.record as Finding),
  );
  return section("CALL 1 RESULTS", findings.join("") + bodies.conflicts);
}

function recordBodies(numbered: NumberedRecords, context: RenderContext) {
  const evidence = evidenceById(context.records);
  const alias = numbered.aliasOf;
  const aliasList = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const a = alias(id);
      return a === undefined ? [] : [a];
    });
  const labelled = (label: string, values: readonly string[]) =>
    values.length === 0 ? "" : `  ${label}: ${values.join(", ")}`;

  const findings = numbered.findings.map(({ alias: a, record }) =>
    renderFinding(a, record, evidence, context),
  );

  const resolvedBy = new Map<string, string>();
  for (const { alias: a, record } of numbered.decisions)
    if (record.conflictId !== undefined) resolvedBy.set(record.conflictId, a);
  const conflicts = numbered.conflicts
    .map(({ alias: a, record }) => {
      // A correction supersedes the decision the conflict names, so look for the current one.
      const decision = resolvedBy.get(record.conflictId);
      const status =
        record.status === "resolved"
          ? decision === undefined
            ? "resolved"
            : `resolved · ${decision}`
          : "unresolved";
      return renderLines([
        `${a}  [${status}]${labelled("members", aliasList(record.findingIds))}`,
        `     ${field(record.description)}`,
      ]);
    })
    .join("");

  const answeredBy = new Map<string, string>();
  for (const { alias: a, record } of numbered.decisions)
    if (record.questionId !== undefined) answeredBy.set(record.questionId, a);
  const questions = numbered.questions
    .map(({ alias: a, record }) => {
      const decision = answeredBy.get(record.questionId);
      const status =
        record.status === "answered" && decision !== undefined
          ? `answered · ${decision}`
          : record.status;
      const resolves = [
        ...sortAliases(aliasList([...record.findingIds, ...record.gapIds])),
        ...sortAliases(aliasList(record.conflictIds)),
      ];
      return renderLines([
        `${a}  [${status}]${labelled("resolves", resolves)}  scope: ${scopeText(record.scope)}`,
        `     ${field(record.prompt)}`,
      ]);
    })
    .join("");

  const decisions = numbered.decisions
    .map(({ alias: a, record }) => {
      const origin = record.origin === "answered_question" ? "answered" : "correction";
      const question = record.questionId === undefined ? [] : aliasList([record.questionId]);
      const conflict = record.conflictId === undefined ? [] : aliasList([record.conflictId]);
      return renderLines([
        `${a}  [${origin}]${labelled("question", question)}${labelled("conflict", conflict)}  scope: ${scopeText(record.scope)}`,
        `     ${field(record.statement)}`,
        ...record.exceptions.map((exception) => `     except: ${field(exception)}`),
      ]);
    })
    .join("");

  const blocks =
    numbered.recommendations.length === 0
      ? []
      : activeDestination(context.records, context.destination).blocks;
  const blockOf = (ref: { blockId: string; blockHash: string }) => {
    const index = blocks.findIndex((b) => b.blockId === ref.blockId && b.hash === ref.blockHash);
    if (index < 0) throw new Error(`block ${ref.blockId} isn't in the active destination`);
    return blockAlias(index + 1);
  };
  const recommendations = numbered.recommendations
    .map(({ alias: a, record }) => {
      const target = resolveTarget(record.target, blocks);
      if (target === undefined)
        throw new Error(`${record.id}: invalidate it as target_changed before rendering`);
      const targetText =
        target.kind === "newSection"
          ? `new section ${json(target.heading)}${target.after === undefined ? "" : ` after ${blockOf(target.after)}`}`
          : `${target.kind === "block" ? "block" : target.kind} ${blockOf(target)}`;
      const support = aliasList(
        record.support.map((s) => (s.kind === "finding" ? s.findingId : s.decisionId)),
      );
      return renderLines([
        `${a}  [${record.operation} · ${record.kind}]  target: ${targetText}  scope: ${scopeText(record.scope)}`,
        ...(support.length === 0 ? [] : [`     support: ${support.join(", ")}`]),
        ...record.references.map((reference) => {
          const by = alias(reference.supportingFindingId);
          return `     reference: ${reference.kind} ${json(reference.value)}${by === undefined ? "" : ` (${by})`}`;
        }),
        `     rationale: ${field(record.rationale)}`,
        ...(record.content === undefined ? [] : record.content.split(/\r\n|\r|\n/)).map(
          (text) => `       | ${text}`,
        ),
      ]);
    })
    .join("");

  return {
    findings,
    conflicts,
    questions,
    decisions,
    recommendations,
  };
}

function renderFinding(
  alias: string,
  finding: Finding,
  evidence: ReadonlyMap<string, EvidenceRecord>,
  context: RenderContext,
): string {
  if (finding.kind === "gap") {
    const coverage = finding.coverage.state === "not_inspected" ? " · not inspected" : "";
    const related =
      finding.relatedPaths.length === 0
        ? ""
        : `  related: ${finding.relatedPaths.map(pathText).join(", ")}`;
    return renderLines([
      `${alias}  [gap · ${finding.gapType}${coverage}]${related}`,
      `     ${field(finding.statement)}`,
    ]);
  }
  if (finding.kind === "absence")
    return renderLines([
      `${alias}  [absence]  glob: ${pathText(finding.pathGlob)}`,
      `     ${field(finding.statement)}`,
    ]);
  return renderLines(
    claimLines(
      alias,
      finding,
      finding.evidenceIds.map((id): EvidenceLine => {
        const item = evidence.get(id);
        if (item === undefined) throw new Error(`no evidence ${id}`);
        if (item.kind === "entry") return { kind: "entry", path: item.path };
        if (item.kind !== "lines") throw new Error(`a claim's evidence ${id} has no path`);
        const shown = {
          kind: "lines" as const,
          path: item.path,
          lineStart: item.lineStart,
          lineEnd: item.lineEnd,
        };
        if (context.withheldExcerpts.has(id)) return { ...shown, marker: "excerpt withheld" };
        if (context.removedExcerpts.has(id)) return { ...shown, marker: "excerpt not sent" };
        return { ...shown, excerpt: item.excerpt };
      }),
    ),
  );
}

/** One claim's evidence as rendered: an entry, or lines with their excerpt or a marker. */
export type EvidenceLine =
  | { readonly kind: "entry"; readonly path: string }
  | {
      readonly kind: "lines";
      readonly path: string;
      readonly lineStart: number;
      readonly lineEnd: number;
      readonly excerpt?: string;
      readonly marker?: "excerpt not sent" | "excerpt withheld";
    };

const LABELS = {
  documentation: "documented",
  code_observation: "observed",
  existing_guidance: "existing guidance",
} as const;

/**
 * A claim's lines, unescaped, as known facts and later calls render them (IMPL §3.2.5, §3.2.6).
 * A descriptive claim says nothing of its mode, so known facts render the same in every call.
 */
export function claimLines(
  alias: string,
  claim: {
    readonly basis: readonly (keyof typeof LABELS)[];
    readonly scope: Scope;
    readonly statement: string;
    readonly mode?: "descriptive" | "prescriptive";
    readonly uncertainty?: string | undefined;
  },
  evidence: readonly EvidenceLine[],
): string[] {
  const labels = claim.basis.map((basis) => LABELS[basis]).join(", ");
  const mode = claim.mode === "prescriptive" ? "  mode: prescriptive" : "";
  const lines = [
    `${alias}  [${labels} · ${claim.basis.join(", ")}]  scope: ${scopeText(claim.scope)}${mode}`,
    `     ${field(claim.statement)}`,
  ];
  if (claim.uncertainty !== undefined) lines.push(`     uncertainty: ${field(claim.uncertainty)}`);
  for (const item of evidence) {
    if (item.kind === "entry") {
      lines.push(`     evidence: ${pathText(item.path)} (file)`);
      continue;
    }
    const where = `${pathText(item.path)}:${item.lineStart}-${item.lineEnd}`;
    if (item.excerpt === undefined) {
      lines.push(`     evidence: ${where} (${item.marker ?? "excerpt not sent"})`);
      continue;
    }
    lines.push(`     evidence: ${where}`);
    for (const text of item.excerpt.split("\n")) lines.push(`       | ${text}`);
  }
  return lines;
}

/** Each line escaped (IMPL §1.6) and ending with a line break. */
export function renderLines(lines: readonly string[]): string {
  return lines.map((line) => `${escapeDelimiters(line)}\n`).join("");
}

/** The excerpts calls 3–5 may remove (IMPL §1.10, §3.2.6), in rendering order. */
export function citedExcerpts(numbered: NumberedRecords, context: RenderContext): CitedExcerpt[] {
  const evidence = evidenceById(context.records);
  const excerpts = new Map<string, { path: string; bytes: number; findings: string[] }>();
  for (const { alias, record } of numbered.findings) {
    if (!("evidenceIds" in record)) continue;
    for (const id of record.evidenceIds) {
      const item = evidence.get(id);
      if (item?.kind !== "lines" || context.withheldExcerpts.has(id)) continue;
      const existing = excerpts.get(id);
      if (existing !== undefined) {
        existing.findings.push(alias);
        continue;
      }
      const bytes = Buffer.byteLength(
        renderLines(item.excerpt.split("\n").map((text) => `       | ${text}`)),
        "utf8",
      );
      excerpts.set(id, { path: item.path, bytes, findings: [alias] });
    }
  }
  return [...excerpts].map(([id, excerpt]) => ({ id, ...excerpt }));
}

// --- The change summary and limits ----------------------------------------------------------

export interface ChangeLines {
  /** Each changed decision with an alias, in alias order. */
  readonly decisions: readonly { readonly alias: string; readonly replaces: boolean }[];
  /** Distinct findings in the sent recommendations' support that have no alias. */
  readonly staleFindings: number;
  /** `target_changed` invalidations since the last completed regeneration (§3.3.6). */
  readonly targetChanged: number;
}

export function renderChanges(changes: ChangeLines): string {
  const lines = changes.decisions.map(({ alias, replaces }) =>
    replaces
      ? `- ${alias} replaces an earlier decision, which is no longer sent.`
      : `- ${alias} is new.`,
  );
  if (changes.staleFindings === 1)
    lines.push("- 1 finding that the recommendations below cite is no longer current.");
  else if (changes.staleFindings > 1)
    lines.push(
      `- ${changes.staleFindings} findings that the recommendations below cite are no longer current.`,
    );
  if (changes.targetChanged === 1)
    lines.push("- 1 recommendation was withdrawn because its target changed.");
  else if (changes.targetChanged > 1)
    lines.push(
      `- ${changes.targetChanged} recommendations were withdrawn because their target changed.`,
    );
  return section("CHANGES", renderLines(lines));
}

export function renderLimits(limits: readonly (readonly [string, number])[]): string {
  return section("LIMITS", renderLines(limits.map(([name, value]) => `${name}: ${value}`)));
}

// --- Text ------------------------------------------------------------------------------------

const UNSAFE = /[\p{Cc}\u2028\u2029]/u;

const json = jsonString;

/** A text field (IMPL §3.2.6): a JSON string when it could start a line of its own. */
function field(text: string): string {
  return UNSAFE.test(text) || text.startsWith('"') ? json(text) : text;
}

/** A path, as tree names are written (IMPL §1.6). */
function pathText(path: string): string {
  return UNSAFE.test(path) ? json(path) : path;
}

function scopeText(scope: Scope): string {
  return scope.kind === "repository" ? "repository" : scope.paths.map(pathText).join(", ");
}

/** `F-2, F-10` by number, not by text. */
function sortAliases(aliases: readonly string[]): string[] {
  return [...aliases].sort(
    (a, b) =>
      Number(a.slice(a.indexOf("-") + 1)) - Number(b.slice(b.indexOf("-") + 1)) ||
      comparePaths(a, b),
  );
}
