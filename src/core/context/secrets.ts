import type {
  DestinationStop,
  SelectedItem,
  SelectedTier,
  SelectionGap,
  TierSelection,
  TierUsage,
} from "./tiers.js";

// The secret scan (IMPL §1.7).
//
// A fixed, versioned set of patterns for known secret formats. Every rule works within one line,
// so a rendered item can be scanned as it is: line numbers, header and outline included. A match
// reports only the rule's ID, never the matched text or where it was.

/** Increase with any change to the rules or their order; a test pins the set to its version. */
export const SECRET_RULES_VERSION = "secret-scan/1.0.0";

export type SecretRuleId =
  | "private-key"
  | "aws-access-key-id"
  | "github-token"
  | "slack-token"
  | "stripe-key"
  | "anthropic-key"
  | "openai-key"
  | "connection-string"
  | "generic-assignment";

export interface SecretRule {
  readonly id: SecretRuleId;
  /** No `g` or `y` flag, so a test leaves no state behind. */
  readonly pattern: RegExp;
}

// generic-assignment's parts. A value is base64, URL-safe base64, hex or a JWT: `=` appears only
// as up to two padding characters at the end. A value therefore never contains an operator, so
// value runs never overlap and the scan stays linear in the length of the text. An unquoted value
// with a dot is a code reference such as `process.env.KEY_V2`, unless it is a JWT (`eyJ…`).
const NAME = "[A-Za-z0-9_.-]";
const VALUE = "[A-Za-z0-9_+/.-]";
const LITERAL = `${VALUE}{20,}={0,2}`;
const UNQUOTED = `(?:eyJ${VALUE}{17,}|[A-Za-z0-9_+/-]{20,})={0,2}`;

/** In order: when several rules match, the first one is reported. */
export const SECRET_RULES: readonly SecretRule[] = [
  { id: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  {
    id: "aws-access-key-id",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  },
  {
    id: "github-token",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  { id: "slack-token", pattern: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: "stripe-key", pattern: /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { id: "anthropic-key", pattern: /(?<![A-Za-z0-9])sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}/ },
  {
    id: "openai-key",
    pattern:
      /(?<![A-Za-z0-9])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/,
  },
  {
    // A scheme and "://", an optional user, a colon, a password, "@" and a host. A password
    // starting with $, { or <, or with % not followed by two hex digits, is a reference such as
    // ${DB_PASSWORD} or %s, not a literal.
    id: "connection-string",
    pattern:
      /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]*:(?![${<]|%(?![0-9A-Fa-f]{2}))[^\s@/]+@[^\s@/]+/,
  },
  {
    // A name containing secret, token, password, api_key or apikey; then =, :, := or => (never a
    // comparison); then a literal of at least 20 value characters with a digit and a letter,
    // quoted, or unquoted and followed by whitespace, a quote, a comma, a semicolon or the end of
    // the line. Line ends are LF, CR, U+2028 and U+2029, as in the `m` flag. The keyword is
    // found by a lazy lookahead, so a long name is not backtracked over.
    id: "generic-assignment",
    pattern: new RegExp(
      `(?<!${NAME})["'\`]?(?=${NAME}*?(?:secret|token|password|api_key|apikey))${NAME}+["'\`]?` +
        `[ \\t]*(?:=>|:=|:|(?<![=!<>])=(?!=))[ \\t]*` +
        `(?=["'\`]?${VALUE}*[0-9])(?=["'\`]?${VALUE}*[A-Za-z])` +
        `(?:"${LITERAL}"|'${LITERAL}'|\`${LITERAL}\`|${UNQUOTED}(?=[\\s,;"'\`]|$))`,
      "im",
    ),
  },
];

/** The first rule that matches anywhere in `text`, or undefined. */
export function scanText(text: string): SecretRuleId | undefined {
  return SECRET_RULES.find((rule) => rule.pattern.test(text))?.id;
}

// ---------------------------------------------------------------------------------------------
// Applying the scan to a tier selection (IMPL §1.3 step 3).

type Selected = Extract<TierSelection, { state: "selected" }>;

/** A selected file the scan removed. The tree marks it `[S]`; the manifest records the rule. */
export interface BlockedFile {
  readonly path: string;
  readonly tier: SelectedTier;
  readonly ruleId: SecretRuleId;
}

export type ScannedSelection =
  | (Selected & { readonly blocked: readonly BlockedFile[] })
  /** The destination matched: the session stops before any model call (IMPL §1.5). */
  | { readonly state: "stopped"; readonly stop: DestinationStop };

/**
 * Removes every item whose rendering matches a rule. Budgets are not refilled and item IDs are
 * not reassigned, so the result doesn't depend on scan order. Tier usage counts what remains.
 */
export function applySecretScan(selection: Selected): ScannedSelection {
  const kept: SelectedItem[] = [];
  const blocked: BlockedFile[] = [];
  for (const item of selection.items) {
    const ruleId = scanText(item.rendered.text);
    if (ruleId === undefined) {
      kept.push(item);
    } else if (item.reason === "tier1:destination") {
      return { state: "stopped", stop: { reason: "destination_secret", ruleId } };
    } else {
      blocked.push({ path: item.path, tier: item.tier, ruleId });
    }
  }
  // Gap statements reach the model too. Import gaps were scanned before the import was cut; this
  // scans them again, so the guarantee doesn't depend on that.
  const gaps = selection.gaps.map(withheldIfSecret);
  return {
    ...selection,
    items: kept,
    tiers: blocked.length === 0 ? selection.tiers : selection.tiers.map((u) => recount(u, kept)),
    gaps,
    blocked,
  };
}

/** The statement for an import outside the repository whose text matched the scan. */
export function importWithheld(importer: string): string {
  return `\`${importer}\` imports a file outside the repository, which was not read. The import is not shown because it matched the secret scan.`;
}

export const GAP_WITHHELD = "A gap statement is not shown because it matched the secret scan.";

function withheldIfSecret(gap: SelectionGap): SelectionGap {
  return scanText(gap.statement) === undefined ? gap : { ...gap, statement: GAP_WITHHELD };
}

function recount(usage: TierUsage, kept: readonly SelectedItem[]): TierUsage {
  const items = kept.filter((item) => item.tier === usage.tier);
  const counted: TierUsage = {
    ...usage,
    usedBytes: items.reduce((sum, item) => sum + item.rendered.bytes, 0),
    items: items.length,
  };
  if (usage.testExamples === undefined) return counted;
  return {
    ...counted,
    testExamples: items.filter((item) => item.reason === "tier5:test-example").length,
  };
}
