import type { z } from "zod";
import { recommend } from "../../schemas/recommend.js";
import {
  type AssemblyDestination,
  type AssemblyTarget,
  assemble,
  type BlockRef,
  blockHeadingLevel,
} from "../assembly/assemble.js";
import {
  type BlockType,
  type GuidanceBlock,
  type ListMarker,
  parseGuidanceBlocks,
} from "../destination/guidance-blocks.js";
import { normalisePath } from "../paths.js";
import { type AliasTable, resolveReference } from "./aliases.js";
import type { Basis } from "./citations.js";
import { type CoverageContext, scopeCheck } from "./coverage.js";
import { duplicateCheck } from "./duplicates.js";
import { limitCheck } from "./limits.js";
import {
  accept,
  type CallValidator,
  type CrossItemCheck,
  type ItemCheck,
  reject,
  type ValidationResult,
  validateResponse,
} from "./pipeline.js";
import { type DetectedReference, detectWithSources, walkBlocks } from "./references.js";
import { hasDirective, isListed, type SupportContext } from "./support.js";

// `recommend` (IMPL §3.3.5). Each recommendation is validated on its own: aliases and currency
// (REC-001), operation and target (REC-002), content shape with an assembly of it alone (REC-003),
// the evidence rules of DM §6.4 (REC-004 to REC-006, REC-010), the directive-language guard
// (REC-007), unresolved dependencies (REC-008) and scope. Then duplicates (DUP-004), held-back
// entries (HELD-001) and the no-change reason (REC-009) across items.

type Response = z.infer<typeof recommend.response>;
export type Recommendation = Response["recommendations"][number];
export type HeldBack = Response["heldBack"][number];

/** A reference with what code adds: the evidence that holds it, and its verification (DM §9.1). */
export interface ResolvedReference {
  readonly kind: "path" | "command";
  readonly value: string;
  /** The `F` alias of its supporting finding. */
  readonly support: string;
  readonly evidenceId: string;
  readonly verification: "exists_in_snapshot" | "found_not_run";
}

/**
 * A recommendation as the checks pass it on: code attaches the target's block (REC-002), and the
 * references' evidence and verification (REF-004).
 */
export type RecommendationItem = Recommendation & {
  readonly resolvedTarget?: AssemblyTarget;
  readonly resolvedReferences?: readonly ResolvedReference[];
};

/** The no-change reason with what REC-009 needs: the response's recommendations as proposed. */
export interface NoChangeReasonItem {
  readonly text: string;
  readonly proposedRecommendations: number;
}

export type RecommendEvidence =
  | { readonly id: string; readonly kind: "lines"; readonly path: string; readonly excerpt: string }
  | { readonly id: string; readonly kind: "entry"; readonly path: string }
  | { readonly id: string; readonly kind: "absence_check" };

/** What the call's input says about each `F` alias (§3.2.6). */
export interface RecommendFinding {
  readonly kind: "claim" | "gap" | "absence";
  /** Claims only. */
  readonly mode?: "descriptive" | "prescriptive";
  readonly basis: readonly Basis[];
  /** Still the current revision of its finding, as at validation (REC-001, §4.4.2). */
  readonly current: boolean;
  /** In the finding's evidence order. */
  readonly evidence: readonly RecommendEvidence[];
  /** A command known fact (§3.2.5): the manifest and the command's name. */
  readonly command?: { readonly file: string; readonly name: string };
}

export interface RecommendDecision {
  /** Still a current decision (REC-001). */
  readonly current: boolean;
  readonly statement: string;
  readonly exceptions: readonly string[];
}

export interface RecommendConflict {
  /** Member `F` aliases. */
  readonly members: readonly string[];
  readonly status: "unresolved" | "resolved";
}

export interface RecommendQuestion {
  readonly status: "open" | "answered" | "skipped" | "unreached";
  /** The `F` and `C` aliases it resolves. */
  readonly resolves: readonly string[];
}

export interface RecommendInput {
  readonly findings: ReadonlyMap<string, RecommendFinding>;
  readonly decisions: ReadonlyMap<string, RecommendDecision>;
  readonly conflicts: ReadonlyMap<string, RecommendConflict>;
  readonly questions: ReadonlyMap<string, RecommendQuestion>;
}

export interface RecommendContext extends CoverageContext, SupportContext {
  readonly aliases: AliasTable;
  /** The captured destination; its blocks are the `B` aliases, in document order. */
  readonly destination: AssemblyDestination;
  readonly input: RecommendInput;
}

/**
 * Verbs that begin an imperative sentence (REC-007), matched whole and case-insensitively, as
 * SUP-004's words are. Versioned with the validator.
 */
export const IMPERATIVE_VERBS = [
  "use",
  "prefer",
  "avoid",
  "always",
  "never",
  "run",
  "do not",
] as const;

type Check = ItemCheck<RecommendationItem, RecommendContext>;

// --- Step 1: aliases and currency -------------------------------------------------------------

const aliasCheck: Check = (value, context, response) => {
  const resolve = (alias: string, kinds: readonly ("F" | "D" | "B")[]) =>
    resolveReference(context.aliases, response.localKeys, alias, { aliases: kinds });
  for (const alias of value.support) {
    const resolved = resolve(alias, ["F", "D"]);
    if (!resolved.ok) return reject(resolved.rule, resolved.detail);
  }
  for (const reference of value.references) {
    const resolved = resolve(reference.support, ["F"]);
    if (!resolved.ok) return reject(resolved.rule, resolved.detail);
  }
  for (const alias of targetAliases(value.target)) {
    const resolved = resolve(alias, ["B"]);
    if (!resolved.ok) return reject(resolved.rule, resolved.detail);
  }
  return accept(value);
};

function targetAliases(target: Recommendation["target"]): string[] {
  if (target.kind === "block" || target.kind === "after") return [target.block];
  if (target.kind === "section") return [target.heading];
  return target.after === undefined ? [] : [target.after];
}

/** REC-001: every `F` and `D` alias names a current revision or a current decision. */
const currencyCheck: Check = (value, context) => {
  const { findings, decisions } = context.input;
  const aliases = [...value.support, ...value.references.map((r) => r.support)];
  for (const alias of aliases) {
    const current = findings.get(alias)?.current ?? decisions.get(alias)?.current ?? false;
    if (!current) return reject("REC-001", `${alias} is no longer current`);
  }
  return accept(value);
};

// --- Step 2: operation and target -------------------------------------------------------------

interface Located {
  readonly ref: BlockRef;
  readonly index: number;
  readonly block: GuidanceBlock;
}

function locate(alias: string, context: RecommendContext): Located | undefined {
  const entry = context.aliases.entries.find((e) => e.alias === alias);
  if (entry?.target.kind !== "block" || context.destination.state !== "present") return undefined;
  const { blockId, hash } = entry.target;
  const blocks = context.destination.parsed.blocks;
  const index = blocks.findIndex((b) => b.blockId === blockId && b.hash === hash);
  const block = blocks[index];
  return block === undefined ? undefined : { ref: { blockId, blockHash: hash }, index, block };
}

/** No blocks to anchor to: an absent destination, or one whose round trip failed (DM §7). */
function onlyNewSections(destination: AssemblyDestination): boolean {
  return destination.state === "absent" || destination.parsed.roundTrip.state === "failed";
}

const operationCheck: Check = (value, context) => {
  const { operation, target, content } = value;
  const fits =
    operation === "add"
      ? target.kind !== "block" && content !== undefined
      : target.kind === "block" && (operation === "revise") === (content !== undefined);
  if (!fits) return reject("REC-002", `${operation} doesn't fit a ${target.kind} target`);
  if (onlyNewSections(context.destination) && (target.kind !== "newSection" || target.after))
    return reject("REC-002", "only a new section at the end fits this destination");

  const heading = (alias: string) => {
    const located = locate(alias, context);
    return located?.block.type === "heading" ? located : undefined;
  };
  let resolvedTarget: AssemblyTarget;
  if (target.kind === "block" || target.kind === "after") {
    const located = locate(target.block, context);
    if (located === undefined) return reject("REC-002", `${target.block} names no block`);
    resolvedTarget = { kind: target.kind, ...located.ref };
  } else if (target.kind === "section") {
    const located = heading(target.heading);
    if (located === undefined) return reject("REC-002", `${target.heading} isn't a heading`);
    resolvedTarget = { kind: "section", ...located.ref };
  } else if (target.after !== undefined) {
    const located = heading(target.after);
    if (located === undefined) return reject("REC-002", `${target.after} isn't a heading`);
    resolvedTarget = { kind: "newSection", heading: target.heading, after: located.ref };
  } else resolvedTarget = { kind: "newSection", heading: target.heading };
  return accept({ ...value, resolvedTarget });
};

// --- Step 3: content shape --------------------------------------------------------------------

interface ContentBlock {
  readonly type: BlockType;
  readonly text: string;
  readonly listMarker?: ListMarker;
}

/** Content without blank lines before its first block or after its last, parsed (DM §7). */
function parseContent(content: string): ContentBlock[] | undefined {
  const lines = content.split(/\r\n|\r|\n/);
  const blank = (line: string | undefined) => line !== undefined && /^[ \t]*$/.test(line);
  while (blank(lines[0])) lines.shift();
  while (blank(lines[lines.length - 1])) lines.pop();
  const bytes = new TextEncoder().encode(lines.join("\n"));
  const parsed = parseGuidanceBlocks(bytes);
  if (parsed.roundTrip.state !== "verified" || parsed.blocks.length === 0) return undefined;
  const decoder = new TextDecoder();
  return parsed.blocks.map((b) => ({
    type: b.type,
    text: decoder.decode(bytes.subarray(b.sourceSpan.start, b.sourceSpan.end)),
    ...(b.type === "list_item" ? { listMarker: b.listMarker } : {}),
  }));
}

const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const ADDABLE: ReadonlySet<BlockType> = new Set(["paragraph", "list_item", "code_block"]);
const MAX_ADDED_BLOCKS = 5;

/** A list item placed directly after another: its indentation, and its bullet or delimiter. */
function continuesList(previous: ListMarker, next: ListMarker): boolean {
  if (previous.indent !== next.indent) return false;
  const kind = (marker: string) => (/^[-*+]$/.test(marker) ? marker : marker.slice(-1));
  const bullet = (marker: string) => /^[-*+]$/.test(marker);
  return (
    bullet(previous.marker) === bullet(next.marker) && kind(previous.marker) === kind(next.marker)
  );
}

function contentFailure(value: RecommendationItem, context: RecommendContext): string | undefined {
  const { operation, content, target } = value;
  if (operation === "remove" || content === undefined) return undefined;
  const blocks = parseContent(content);
  if (blocks === undefined) return "content doesn't parse with a verified round trip";
  const destination = context.destination;

  if (operation === "revise" && target.kind === "block") {
    const located = locate(target.block, context);
    if (located === undefined || destination.state !== "present") return "target not found";
    const [only, ...rest] = blocks;
    if (only === undefined || rest.length > 0) return "a revision holds exactly one block";
    if (only.type !== located.block.type) return `a ${located.block.type} is revised as one`;
    if (located.block.type === "heading") {
      const atx = ATX.exec(only.text);
      const level = blockHeadingLevel(destination.bytes, located.block);
      if (/[\r\n]/.test(only.text) || atx === null || (atx[1] ?? "").length !== level)
        return `a heading is revised as one ATX line of level ${level}`;
    }
    if (located.block.type === "list_item") {
      const want = located.block.listMarker;
      const got = only.listMarker;
      if (got === undefined || got.indent !== want.indent || got.marker !== want.marker)
        return "a list item keeps its marker and indentation";
    }
    return undefined;
  }

  if (blocks.length > MAX_ADDED_BLOCKS)
    return `an addition holds at most ${MAX_ADDED_BLOCKS} blocks`;
  if (!blocks.every((b) => ADDABLE.has(b.type)))
    return "an addition holds only paragraphs, list items and code blocks";
  if (target.kind === "newSection") {
    if (/[\r\n]/.test(target.heading) || target.heading.replace(/[ \t]/g, "") === "")
      return "a new section's heading is one line, not empty";
  }
  let previous = anchorBlock(value, context);
  for (const block of blocks) {
    if (block.listMarker !== undefined && previous?.type === "list_item") {
      const marker = previous.listMarker;
      if (marker === undefined || !continuesList(marker, block.listMarker))
        return "a list item after a list item keeps its indentation and bullet";
    }
    previous = block;
  }
  return undefined;
}

/** The block an addition's first block follows directly: none for a new section (DM §9.3). */
function anchorBlock(
  value: RecommendationItem,
  context: RecommendContext,
): { readonly type: BlockType; readonly listMarker?: ListMarker } | undefined {
  const { target } = value;
  if (target.kind === "after") return locate(target.block, context)?.block;
  if (target.kind !== "section" || context.destination.state !== "present") return undefined;
  const located = locate(target.heading, context);
  if (located === undefined) return undefined;
  const blocks = context.destination.parsed.blocks;
  let index = located.index;
  while (blocks[index + 1] !== undefined && blocks[index + 1]?.type !== "heading") index++;
  return blocks[index];
}

/** REC-003: the content's shape, then the recommendation assembled alone (DM §9.3). */
const contentCheck: Check = (value, context) => {
  const failure = contentFailure(value, context);
  if (failure !== undefined) return reject("REC-003", failure);
  if (value.resolvedTarget === undefined) throw new Error("REC-003 runs after REC-002");
  const assembled = assemble(context.destination, [
    {
      revisionId: "candidate",
      firstSeq: 0,
      operation: value.operation,
      target: value.resolvedTarget,
      ...(value.content === undefined ? {} : { content: value.content }),
    },
  ]);
  if (!assembled.ok) {
    const check =
      assembled.failure.kind === "internal_error" ? assembled.failure.check : "conflict";
    return reject("REC-003", `assembled alone, it fails the ${check} check`);
  }
  return accept(value);
};

// --- Step 4: evidence rules (DM §6.4) ---------------------------------------------------------

interface Support {
  readonly findings: readonly (readonly [string, RecommendFinding])[];
  readonly decisions: number;
}

function supportOf(value: Recommendation, context: RecommendContext): Support {
  const findings: (readonly [string, RecommendFinding])[] = [];
  let decisions = 0;
  for (const alias of value.support) {
    const finding = context.input.findings.get(alias);
    if (finding !== undefined) findings.push([alias, finding]);
    else if (context.input.decisions.has(alias)) decisions++;
  }
  return { findings, decisions };
}

/** Members of a conflict still unresolved, which no decision has resolved (§4.5). */
function contested(context: RecommendContext): ReadonlySet<string> {
  return new Set(
    [...context.input.conflicts.values()]
      .filter((c) => c.status === "unresolved")
      .flatMap((c) => c.members),
  );
}

const evidenceCheck: Check = (value, context) => {
  const { findings, decisions } = supportOf(value, context);

  // REC-004: existing guidance can't justify itself.
  const guidanceOnly = (f: RecommendFinding) =>
    f.kind === "claim" && f.basis.length > 0 && f.basis.every((b) => b === "existing_guidance");
  if (decisions === 0 && findings.every(([, f]) => guidanceOnly(f)))
    return reject("REC-004", "supported by existing guidance alone");

  // REC-005: policy needs intent the developer confirmed, or uncontested documented policy.
  if (value.kind === "policy" && decisions === 0) {
    const disputed = contested(context);
    const documented = findings.some(
      ([alias, f]) =>
        f.kind === "claim" &&
        f.mode === "prescriptive" &&
        f.basis.includes("documentation") &&
        !disputed.has(alias),
    );
    if (!documented)
      return reject("REC-005", "policy without a decision or uncontested documented policy");
  }

  // REC-006: a gap is never support; a fact describes, so its findings do.
  for (const [alias, f] of findings) {
    if (f.kind === "gap") return reject("REC-006", `${alias} is a gap`);
    if (value.kind === "fact" && f.kind === "claim" && f.mode !== "descriptive")
      return reject("REC-006", `a fact cites the prescriptive finding ${alias}`);
  }

  // REC-010: an absence claim supports only its own narrow statement (§1.11).
  for (const [alias, f] of findings)
    if (f.kind === "absence") return reject("REC-010", `${alias} is an absence claim`);

  return accept(value);
};

// --- Step 5: directive-language guard ---------------------------------------------------------

// A letter, digit or underscore next to a match means it is part of a longer word (§3.2.3).
const WORD = "[\\p{L}\\p{N}_]";
const IMPERATIVE = new RegExp(
  `^(?:${IMPERATIVE_VERBS.map((verb) => verb.replace(" ", "[ \\t]+")).join("|")})(?!${WORD})`,
  "iu",
);
const INLINE_CODE = /`[^`]*`/g;
const HEADING_MARKS = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
// The start of the text, or `.`, `!` or `?` and whitespace.
const SENTENCE_START = /(?:^|[.!?]\p{White_Space}+)\p{White_Space}*[*_("']*/gu;

/** The first rule a fact's prose breaks, if any. Code spans are masked, so never checked. */
export function directiveFailure(content: string): string | undefined {
  let failure: string | undefined;
  walkBlocks(content, (block) => {
    if (failure !== undefined || block.kind === "code") return;
    let text = block.text.replace(INLINE_CODE, (span) => "\0".repeat(span.length));
    if (block.type === "heading") text = text.replace(HEADING_MARKS, "");
    if (hasDirective(text)) {
      failure = "directive language in a fact";
      return;
    }
    for (const start of text.matchAll(SENTENCE_START)) {
      const rest = text.slice(start.index + start[0].length);
      if (IMPERATIVE.test(rest)) {
        failure = "a sentence begins with an imperative verb";
        return;
      }
    }
  });
  return failure;
}

const directiveCheck: Check = (value) => {
  if (value.kind !== "fact" || value.content === undefined) return accept(value);
  const failure = directiveFailure(value.content);
  return failure === undefined ? accept(value) : reject("REC-007", failure);
};

// --- Step 6: unresolved dependencies ----------------------------------------------------------

const dependencyCheck: Check = (value, context) => {
  const { findings, decisions } = supportOf(value, context);
  const disputed = contested(context);
  for (const [alias] of findings)
    if (disputed.has(alias)) return reject("REC-008", `${alias} is in an unresolved conflict`);
  const unanswered = new Set(
    [...context.input.questions.values()]
      .filter((q) => q.status === "skipped" || q.status === "unreached")
      .flatMap((q) => q.resolves),
  );
  if (decisions === 0 && findings.length > 0 && findings.every(([alias]) => unanswered.has(alias)))
    return reject("REC-008", "its only support awaits a skipped or unreached question");
  return accept(value);
};

// --- Step 7: references (§3.4) --------------------------------------------------------------

const WHITESPACE = /\p{White_Space}/u;

/** The runner forms of a command known fact, chosen by its file's name (§3.2.5). */
export function runnerForms(file: string, name: string): string[] {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (base === "package.json")
    return [
      `npm run ${name}`,
      ...(name === "test" || name === "start" ? [`npm ${name}`] : []),
      `pnpm ${name}`,
      `pnpm run ${name}`,
      `yarn ${name}`,
      `yarn run ${name}`,
      `bun run ${name}`,
    ];
  if (base === "makefile") return [`make ${name}`];
  if (base === "justfile") return [`just ${name}`];
  if (base === "taskfile.yml" || base === "taskfile.yaml") return [`task ${name}`];
  if (base === "pyproject.toml") return [`uv run ${name}`, `poetry run ${name}`];
  return [];
}

/**
 * Whether a command value is a known command of the fact: a runner form and the name, with
 * arguments after whitespace only when every occurrence was found in code (REF-003).
 */
function isKnownCommand(value: string, finding: RecommendFinding, arguments_: boolean): boolean {
  const fact = finding.command;
  if (fact === undefined) return false;
  return runnerForms(fact.file, fact.name).some(
    (form) =>
      value === form ||
      (arguments_ && value.startsWith(form) && WHITESPACE.test(value.charAt(form.length))),
  );
}

const excerpts = (finding: RecommendFinding | undefined): string[] =>
  (finding?.evidence ?? []).flatMap((e) => (e.kind === "lines" ? [e.excerpt] : []));

/** The first evidence of the finding that holds the value (REF-004), in evidence order. */
function holdingEvidence(
  reference: Recommendation["references"][number],
  finding: RecommendFinding,
  known: boolean,
): string | undefined {
  if (known) return finding.evidence[0]?.id;
  const path = reference.kind === "path" ? normalisePath(reference.value) : undefined;
  for (const evidence of finding.evidence) {
    if (evidence.kind === "lines" && evidence.excerpt.includes(reference.value)) return evidence.id;
    if (
      path !== undefined &&
      evidence.kind !== "absence_check" &&
      (evidence.path === path || evidence.path.startsWith(`${path}/`))
    )
      return evidence.id;
  }
  return undefined;
}

const referenceCheck: Check = (value, context) => {
  const detection = detectWithSources(value.content ?? "");
  const detected = detection.references;
  const declared = value.references;
  const same = (d: DetectedReference, r: (typeof declared)[number]) =>
    d.kind === r.kind && d.match === r.value;

  // REF-001: what the content mentions is declared, and what is declared is in the content.
  if (!detected.every((d) => declared.some((r) => same(d, r))))
    return reject("REF-001", "a path or command in the content is not declared");
  if (!declared.every((r) => detected.some((d) => same(d, r))))
    return reject("REF-001", "a declared reference is not in the content");

  // REF-002: paths are listed and not withheld, after normalisation (§1.11).
  for (const r of declared)
    if (r.kind === "path" && !isListed(r.value, context))
      return reject("REF-002", "a path not in the file list");

  // REF-003: commands are known commands of their fact, or in an excerpt as written.
  const known = declared.map((r) => {
    if (r.kind !== "command") return false;
    const finding = context.input.findings.get(r.support);
    if (finding === undefined) return false;
    const fromProse = detected.some((d) => same(d, r) && detection.proseCommands.has(d));
    return isKnownCommand(r.value, finding, !fromProse);
  });
  for (const [index, r] of declared.entries()) {
    if (r.kind !== "command" || known[index]) continue;
    if (!excerpts(context.input.findings.get(r.support)).some((e) => e.includes(r.value)))
      return reject("REF-003", "a command that is neither a known command nor in an excerpt");
  }

  // REF-004: the supporting finding is in support, and has evidence holding the value.
  const resolvedReferences: ResolvedReference[] = [];
  for (const [index, r] of declared.entries()) {
    const finding = context.input.findings.get(r.support);
    if (finding === undefined || !value.support.includes(r.support))
      return reject("REF-004", `${r.support} is not in the recommendation's support`);
    const evidenceId = holdingEvidence(r, finding, known[index] === true);
    if (evidenceId === undefined)
      return reject("REF-004", `no evidence of ${r.support} holds the reference`);
    resolvedReferences.push({
      kind: r.kind,
      value: r.value,
      support: r.support,
      evidenceId,
      verification: r.kind === "path" ? "exists_in_snapshot" : "found_not_run",
    });
  }

  // REF-005: identifiers appear in a supporting excerpt, or a supporting decision.
  const texts = value.support.flatMap((alias) => {
    const decision = context.input.decisions.get(alias);
    if (decision !== undefined) return [decision.statement, ...decision.exceptions];
    return excerpts(context.input.findings.get(alias));
  });
  for (const identifier of detection.identifiers)
    if (!texts.some((text) => text.includes(identifier.match)))
      return reject("REF-005", "an identifier not in the support");

  return accept({ ...value, resolvedReferences });
};

// --- Held-back entries ------------------------------------------------------------------------

const blockedByCheck: ItemCheck<HeldBack, RecommendContext> = (value, context, response) => {
  for (const alias of value.blockedBy) {
    const resolved = resolveReference(context.aliases, response.localKeys, alias, {
      aliases: ["Q", "C"],
    });
    if (!resolved.ok) return reject(resolved.rule, resolved.detail);
  }
  return accept(value);
};

// --- Cross-item -------------------------------------------------------------------------------

type Items = {
  recommendations: RecommendationItem;
  heldBack: HeldBack;
  noChangeReason: NoChangeReasonItem;
};

/** The target after alias resolution, and the content after line-ending conversion. */
function recommendationIdentity(value: RecommendationItem): string {
  const target = value.resolvedTarget;
  const resolved =
    target === undefined
      ? null
      : target.kind === "newSection"
        ? [
            target.kind,
            target.heading.replace(/^[ \t]+|[ \t]+$/g, ""),
            target.after?.blockId ?? null,
          ]
        : [target.kind, target.blockId];
  return JSON.stringify([
    value.operation,
    resolved,
    value.content === undefined ? null : value.content.replace(/\r\n|\r/g, "\n"),
  ]);
}

/** HELD-001: every blocker is a skipped or unreached question, or an unresolved conflict. */
const heldBackCheck: CrossItemCheck<Items, RecommendContext> = (surviving, context) =>
  surviving.heldBack.flatMap((item) => {
    const blocked = item.value.blockedBy.every((alias) => {
      const question = context.input.questions.get(alias);
      if (question !== undefined)
        return question.status === "skipped" || question.status === "unreached";
      return context.input.conflicts.get(alias)?.status === "unresolved";
    });
    return blocked
      ? []
      : [
          {
            collection: "heldBack" as const,
            index: item.index,
            rule: "HELD-001",
            detail: "a blocker is answered or resolved",
          },
        ];
  });

/** REC-009: a no-change reason only when the response proposed no recommendation. */
const noChangeCheck: CrossItemCheck<Items, RecommendContext> = (surviving) =>
  surviving.noChangeReason
    .filter((item) => item.value.proposedRecommendations > 0)
    .map((item) => ({
      collection: "noChangeReason" as const,
      index: item.index,
      rule: "REC-009",
      detail: "a no-change reason alongside recommendations",
    }));

export const recommendValidator: CallValidator<Response, RecommendContext, Items> = {
  schema: recommend.response,
  order: ["recommendations", "heldBack", "noChangeReason"],
  collections: {
    recommendations: {
      items: (response) => response.recommendations,
      key: (item) => ({ kind: "local", key: item.key }),
      checks: [
        limitCheck(recommend.items.recommendations),
        aliasCheck,
        currencyCheck,
        operationCheck,
        contentCheck,
        evidenceCheck,
        directiveCheck,
        dependencyCheck,
        referenceCheck,
        scopeCheck(),
      ],
    },
    heldBack: {
      items: (response) => response.heldBack,
      key: () => ({ kind: "position" }),
      checks: [limitCheck(recommend.items.heldBack), blockedByCheck],
    },
    noChangeReason: {
      items: (response) =>
        response.noChangeReason === undefined
          ? []
          : [
              {
                text: response.noChangeReason,
                proposedRecommendations: response.recommendations.length,
              },
            ],
      key: () => ({ kind: "named", key: "noChangeReason" }),
      checks: [],
    },
  },
  crossItem: [
    duplicateCheck<Items, RecommendContext, "recommendations">({
      collection: "recommendations",
      rule: "DUP-004",
      identity: recommendationIdentity,
    }),
    heldBackCheck,
    noChangeCheck,
  ],
};

export type RecommendItems = Items;

export interface RecommendValidation {
  readonly result: ValidationResult<Items, Response>;
}

export function validateRecommend(text: string, context: RecommendContext): RecommendValidation {
  return { result: validateResponse(recommendValidator, text, context) };
}
