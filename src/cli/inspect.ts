import { isWithheldPath, pathHash, recordedPath } from "../core/context/secrets.js";
import {
  type ContextResult,
  type ContextSelectionSettings,
  type InputManifest,
  type ManifestItem,
  selectContext,
} from "../core/context/select.js";
import type { DestinationStop } from "../core/context/tiers.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../core/context/tiers.js";
import type { ExclusionGroup } from "../core/snapshot/exclusions.js";
import type { GitUnknownReason } from "../core/snapshot/git.js";
import {
  captureSnapshot,
  DEFAULT_SNAPSHOT_SETTINGS,
  type Snapshot,
  type SnapshotDeps,
} from "../core/snapshot/snapshot.js";

// The "What we read" preview (IMPL §2.2, §2.4). It captures the repository and selects the
// context exactly as a session would, then prints what would be sent. It sends nothing, writes
// nothing and starts no session. Rendering only: the data comes from core.

export interface InspectOptions {
  /** Every item with its reason and lines, and every path not sent with its reason. */
  readonly list: boolean;
  /** The input manifest as JSON (IMPL §1.13): paths, hashes and reasons, never content. */
  readonly json: boolean;
}

export interface InspectResult {
  readonly code: number;
  readonly output: string;
}

const WIDTH = 80;

export async function inspect(
  root: string,
  deps: SnapshotDeps,
  options: InspectOptions,
  settings: ContextSelectionSettings = {
    snapshot: DEFAULT_SNAPSHOT_SETTINGS,
    context: DEFAULT_CONTEXT_SETTINGS,
  },
): Promise<InspectResult> {
  const snapshot = await captureSnapshot(deps, settings.snapshot);
  const result = await selectContext(snapshot, settings, deps.fs);
  if (options.json) {
    const data = result.state === "ready" ? result.manifest : recorded(result);
    return { code: result.state === "ready" ? 0 : 1, output: `${JSON.stringify(data, null, 2)}\n` };
  }
  if (result.state !== "ready") {
    return { code: 1, output: render([...header(root, snapshot), ...cannotSend(result)]) };
  }
  const body = options.list ? fileList(snapshot, result) : summary(snapshot, result, settings);
  return { code: 0, output: render([...header(root, snapshot), ...body]) };
}

type Ready = Extract<ContextResult, { state: "ready" }>;
type NotReady = Exclude<ContextResult, { state: "ready" }>;

/** The stop or instability as recorded data: a path that matches the secret scan is a hash. */
function recorded(result: NotReady) {
  if (result.state === "stopped") return result;
  return { state: result.state, changedPaths: result.changedPaths.map(recordedPath) };
}

/**
 * A path as printed. One that matches the secret scan is `<withheld>`: in --list followed by the
 * start of its hash, so entries can still be told apart; in the summary alone.
 */
function shown(path: string, withHash = true): string {
  if (!isWithheldPath(path)) return path;
  return withHash ? `<withheld> ${pathHash(path).slice(0, "sha256:".length + 12)}…` : "<withheld>";
}

function render(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Header

function header(root: string, snapshot: Snapshot): string[] {
  const lines = ["INSPECT · preview · no session · nothing is sent", ""];
  lines.push(`Repository  ${root}`);
  lines.push(`Git         ${gitLine(snapshot)}`);
  if (snapshot.stability.state === "unstable") {
    lines.push(
      ...wrap(
        `Warning     ${count(snapshot.stability.changedPaths.length, "file")} changed while the repository was being read, so this may not match it. Run again when nothing is writing to it.`,
        12,
      ),
    );
  }
  lines.push("");
  return lines;
}

function gitLine(snapshot: Snapshot): string {
  const git = snapshot.git;
  if (git.state === "unknown") {
    return git.reason === "not_inspected" ? "not used" : `not used: ${gitReason(git.reason)}`;
  }
  const commit = git.commit === null ? "no commits yet" : `commit ${git.commit.slice(0, 7)}`;
  const changes =
    git.workingTreeDirty === "unknown"
      ? "uncommitted changes unknown"
      : git.workingTreeDirty
        ? "uncommitted changes"
        : "no uncommitted changes";
  return `${commit}, ${changes}`;
}

function gitReason(reason: GitUnknownReason): string {
  switch (reason) {
    case "not_inspected":
      return "git not used";
    case "git_missing":
      return "git not found";
    case "git_too_old":
      return "git is too old, or a partial clone needs git 2.44 or later";
    case "not_a_repository":
      return "not a git repository";
    case "unsafe_repository":
      return "git refused the repository (safe.directory)";
    case "git_error":
      return "git reported an error";
  }
}

// ---------------------------------------------------------------------------------------------
// Summary

const LABEL_WIDTH = 31;
const COUNT_WIDTH = 10;
const SIZE_WIDTH = 6;
const NOTES_COLUMN = 2 + LABEL_WIDTH + COUNT_WIDTH + SIZE_WIDTH + 3;

function summary(snapshot: Snapshot, result: Ready, settings: ContextSelectionSettings): string[] {
  const m = result.manifest;
  const lines = [
    `What would be sent for analysis  (${kb(m.budget.usedBytes)} of ${kb(settings.context.initialContextBytes)})`,
    "",
  ];
  const tierOf = (tier: number) => m.tiers.find((t) => t.tier === tier);
  const itemsOf = (tier: number) => m.items.filter((item) => item.id.startsWith(`T${tier}-`));

  const tier1Notes = [destinationNote(snapshot), ...skippedNote(tierOf(1))];
  lines.push(...row("Existing agent configuration", itemsOf(1), tierOf(1), tier1Notes));
  lines.push(...row("Documentation", itemsOf(2), tierOf(2), excerptNotes(itemsOf(2), tierOf(2))));
  lines.push(
    ...row("Manifests and tooling", itemsOf(3), tierOf(3), excerptNotes(itemsOf(3), tierOf(3))),
  );
  const tree = result.tree;
  lines.push(
    `  ${"Directory tree".padEnd(LABEL_WIDTH)}${count(tree.files, "file")} listed, depth ${tree.depth}`,
  );
  const tier5 = tierOf(5);
  const tests = tier5 !== undefined && "testExamples" in tier5 ? (tier5.testExamples ?? 0) : 0;
  const tier5Notes = [
    ...(tests > 0 ? [count(tests, "test example")] : []),
    ...excerptNotes(itemsOf(5), tier5),
  ];
  lines.push(...row("Source samples", itemsOf(5), tier5, tier5Notes));
  lines.push("");
  lines.push(...wrap(`Not sent: ${notSent(snapshot, m)}`, 2, 4));
  lines.push(...ignoredLine(snapshot, m));
  lines.push("");
  lines.push("  Run with --list to see every file and the reason for each.");
  return lines;
}

type ManifestTierEntry = InputManifest["tiers"][number];

function row(
  label: string,
  items: readonly ManifestItem[],
  tier: ManifestTierEntry | undefined,
  notes: readonly string[],
): string[] {
  const used = tier?.usedBytes ?? 0;
  const left =
    `  ${label.padEnd(LABEL_WIDTH)}${count(items.length, "file").padEnd(COUNT_WIDTH)}` +
    kb(used).padStart(SIZE_WIDTH);
  if (notes.length === 0) return [left];
  // Whole notes move to the next line, so "2 not read (budget)" is never split.
  const lines: string[] = [];
  let current = `${left}   `;
  notes.forEach((note, index) => {
    const text = index < notes.length - 1 ? `${note},` : note;
    const fresh = current.trim() === "" || current.endsWith("   ");
    const candidate = fresh ? `${current}${text}` : `${current} ${text}`;
    if ([...candidate].length > WIDTH && !fresh) {
      lines.push(current);
      current = `${" ".repeat(NOTES_COLUMN)}${text}`;
    } else {
      current = candidate;
    }
  });
  lines.push(current);
  return lines;
}

function destinationNote(snapshot: Snapshot): string {
  const destination = snapshot.destination;
  if (destination.state === "present") {
    return `CLAUDE.md (${count(destination.blocks.length, "block")})`;
  }
  return "no CLAUDE.md yet";
}

function excerptNotes(
  items: readonly ManifestItem[],
  tier: ManifestTierEntry | undefined,
): string[] {
  const outlineOnly = items.filter((item) => item.excerpt && item.includedLines === "").length;
  const excerpted = items.filter((item) => item.excerpt).length - outlineOnly;
  return [
    ...(excerpted > 0 ? [`${excerpted} excerpted`] : []),
    ...(outlineOnly > 0 ? [`${outlineOnly} outline only`] : []),
    ...skippedNote(tier),
  ];
}

function skippedNote(tier: ManifestTierEntry | undefined): string[] {
  const skipped = tier !== undefined && "skipped" in tier ? tier.skipped : 0;
  return skipped > 0 ? [`${skipped} not read (budget)`] : [];
}

const DIRECTORIES_SHOWN = 4;

const GROUP_LABELS: Record<ExclusionGroup, readonly [string, string]> = {
  version_control: ["version control file", "version control files"],
  dependencies: ["dependency file", "dependency files"],
  build_output: ["build output file", "build output files"],
  lockfiles: ["lockfile", "lockfiles"],
  secret_names: ["secret-named file", "secret-named files"],
  personal_agent_config: ["personal Claude file", "personal Claude files"],
  binary_and_media: ["binary or media file", "binary or media files"],
  user: ["file you excluded", "files you excluded"],
  session_storage: ["session storage file", "session storage files"],
};
const GROUP_ORDER = Object.keys(GROUP_LABELS) as ExclusionGroup[];

/**
 * Excluded directories by path, as not entered; excluded files counted by kind; then
 * secret-blocked files. Withheld paths are never shown.
 */
function notSent(snapshot: Snapshot, m: InputManifest): string {
  const parts: string[] = [];
  const directories = snapshot.files.flatMap((file) =>
    file.status === "excluded" && file.kind === "directory"
      ? [`${shown(file.path, false)} (not entered)`]
      : [],
  );
  parts.push(...directories.slice(0, DIRECTORIES_SHOWN));
  if (directories.length > DIRECTORIES_SHOWN) {
    const more = directories.length - DIRECTORIES_SHOWN;
    parts.push(`${count(more, "more directory", "more directories")} (not entered)`);
  }

  const byGroup = new Map<ExclusionGroup, number>();
  for (const file of snapshot.files) {
    if (file.status !== "excluded" || file.kind === "directory") continue;
    const group = snapshot.exclusions.find((rule) => rule.pattern === file.rule)?.group ?? "user";
    byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
  }
  for (const group of GROUP_ORDER) {
    const n = byGroup.get(group) ?? 0;
    const [one, many] = GROUP_LABELS[group];
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  }

  const blocked = m.excluded.filter((entry) => "reason" in entry).length;
  if (blocked > 0) parts.push(`${count(blocked, "file")} blocked (secret pattern)`);
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

const IGNORED_SHOWN = 3;

function ignoredLine(snapshot: Snapshot, m: InputManifest): string[] {
  if (m.ignoreRules.state === "not_applied") {
    return wrap(
      `Ignored files couldn't be identified (${gitReason(m.ignoreRules.reason)}): only the default exclusions were used.`,
      2,
      4,
    );
  }
  const ignored = ignoredEntries(snapshot);
  if (ignored.length === 0) return ["  Ignored by .gitignore: none"];
  const more = ignored.length > IGNORED_SHOWN ? ", … (--list shows all)" : "";
  return wrap(
    `Ignored by .gitignore: ${count(ignored.length, "entry", "entries")}   ${ignored.slice(0, IGNORED_SHOWN).join(", ")}${more}`,
    2,
    4,
  );
}

/** Ignored entries as shown, in path order; a directory as `name/ (not entered)`. */
function ignoredEntries(snapshot: Snapshot): string[] {
  return snapshot.files.flatMap((file) => {
    if (file.status !== "ignored") return [];
    const path = shown(file.path, false);
    return [file.kind === "directory" ? `${path}/ (not entered)` : path];
  });
}

// ---------------------------------------------------------------------------------------------
// --list

function fileList(snapshot: Snapshot, result: Ready): string[] {
  const m = result.manifest;
  const lines = ["Sent", ""];
  const entry = (text: string) => lines.push(...wrap(text, 2, 4));
  for (const item of m.items) {
    entry(`${item.id}  ${item.path}`);
    lines.push(
      ...wrap(`${item.reason} · ${linesNote(item)} · ${grouped(item.bytes)} bytes`, 10, 10),
    );
  }
  entry(
    `TREE    ${count(result.tree.files, "file")} listed, depth ${result.tree.depth} · ${grouped(result.tree.bytes)} bytes`,
  );

  if (m.skipped.length > 0) {
    lines.push("", "Not read (budget)", "");
    for (const skipped of m.skipped) entry(`${recordedShown(skipped)}  ${skipped.reason}`);
  }

  lines.push("", "Not sent", "");
  for (const file of snapshot.files) {
    if (file.status !== "excluded") continue;
    entry(`${shown(file.path)}${file.kind === "directory" ? "/" : ""}  excluded (${file.rule})`);
  }
  for (const blocked of m.excluded) {
    if ("reason" in blocked) {
      entry(
        `${recordedShown(blocked)}  blocked (secret pattern: ${blocked.reason.slice("secret-scan:".length)})`,
      );
    }
  }
  const blockedPaths = new Set(
    m.excluded.flatMap((e) => ("reason" in e && "path" in e ? [e.path] : [])),
  );
  for (const file of snapshot.files) {
    if (
      file.status === "listed_only" &&
      !blockedPaths.has(file.path) &&
      !isWithheldPath(file.path)
    ) {
      entry(`${file.path}  listed only (${file.reason.replaceAll("_", " ")})`);
    }
    if (file.status === "unreadable") {
      entry(`${shown(file.path)}  unreadable (${file.reason.replaceAll("_", " ")})`);
    }
    if (file.status === "symlink") {
      entry(`${shown(file.path)} -> ${shown(file.target)}  symbolic link, not followed`);
    }
  }
  for (const file of snapshot.files) {
    if (file.status !== "ignored") continue;
    entry(
      `${shown(file.path)}${file.kind === "directory" ? "/  ignored (not entered)" : "  ignored"}`,
    );
  }
  if (m.ignoreRules.state === "not_applied") {
    entry(`Ignored files couldn't be identified (${gitReason(m.ignoreRules.reason)}).`);
  }

  if (result.gaps.length > 0) {
    lines.push("", "Gaps", "");
    for (const gap of result.gaps) {
      entry(gap.statement);
      for (const path of gap.relatedPaths) lines.push(...wrap(path, 4, 6));
      const hidden = gap.relatedPathHashes?.length ?? 0;
      if (hidden > 0) lines.push(`    and ${count(hidden, "withheld path")}`);
    }
  }
  return lines;
}

function linesNote(item: ManifestItem): string {
  if (!item.excerpt) return item.totalLines === 0 ? "empty" : `lines ${item.includedLines}`;
  if (item.includedLines === "") return `outline only, of ${item.totalLines} lines`;
  return `excerpt, lines ${item.includedLines} of ${item.totalLines}`;
}

function recordedShown(entry: { readonly path: string } | { readonly pathHash: string }): string {
  return "path" in entry
    ? entry.path
    : `<withheld> ${entry.pathHash.slice(0, "sha256:".length + 12)}…`;
}

// ---------------------------------------------------------------------------------------------
// When nothing can be sent

function cannotSend(result: NotReady): string[] {
  const lines =
    result.state === "unstable"
      ? [
          `${result.changedPaths.map((path) => shown(path)).join(", ")} changed while it was being read, so its content no longer matches what was captured. Run again when nothing is writing to the repository.`,
        ]
      : stopExplanation(result.stop);
  return [...lines.flatMap((line) => wrap(line, 0, 0)), "", "Nothing was sent."];
}

function stopExplanation(stop: DestinationStop): string[] {
  switch (stop.reason) {
    case "destination_too_large":
      return [
        `CLAUDE.md, with its block list, is ${grouped(stop.renderedBytes)} bytes: more than maxDestinationBytes (${grouped(stop.maxDestinationBytes)}). It is always sent whole, never cut.`,
        "Shorten CLAUDE.md, or raise maxDestinationBytes.",
      ];
    case "destination_secret":
      return [
        `CLAUDE.md matches the secret scan (${stop.ruleId}). It would be sent in every call, so the session can't start.`,
        "Remove the secret from CLAUDE.md, then run again.",
      ];
    case "destination_unavailable":
      return [unavailable(stop.detail)];
  }
}

function unavailable(
  detail: Extract<DestinationStop, { reason: "destination_unavailable" }>["detail"],
): string {
  switch (detail) {
    case "symlink":
      return "CLAUDE.md is a symbolic link. Links are never followed. Replace it with the file itself.";
    case "too_large":
      return "CLAUDE.md is larger than maxReadableFileBytes (262,144). Shorten it, or raise the setting.";
    case "contains_nul":
      return "CLAUDE.md contains a NUL byte, so it isn't text. Remove the byte, then run again.";
    case "not_utf8":
      return "CLAUDE.md isn't valid UTF-8. Save it as UTF-8, then run again.";
    case "case_variant":
      return "There is no CLAUDE.md, but there is a file with the same name in another letter case. Rename it to CLAUDE.md, or move it away.";
    case "not_found":
      return "CLAUDE.md disappeared while it was being read. Run again.";
    case "permission_denied":
      return "CLAUDE.md can't be read: permission denied. Make it readable, then run again.";
    case "not_regular_file":
      return "CLAUDE.md isn't a regular file. Replace it with a file.";
    case "io_error":
      return "CLAUDE.md couldn't be read because of an input/output error. Run again.";
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting. No locale: output must not depend on where it runs.

function kb(bytes: number): string {
  if (bytes === 0) return "0 KB";
  if (bytes < 1_000) return "<1 KB";
  return `${grouped(Math.round(bytes / 1_000))} KB`;
}

function grouped(n: number): string {
  return `${n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${grouped(n)} ${n === 1 ? one : many}`;
}

/**
 * Wraps `text` at spaces so no line exceeds WIDTH. The first line keeps the indent already in
 * `text` (or `firstIndent` spaces are added if it has none); later lines get `indent` spaces.
 */
function wrap(text: string, firstIndent: number, indent = firstIndent): string[] {
  const start = text.startsWith(" ") ? text : `${" ".repeat(firstIndent)}${text}`;
  const lines: string[] = [];
  let current = "";
  const words = start.match(/^ */)?.[0] ?? "";
  current = words;
  for (const word of start.slice(words.length).split(" ")) {
    const candidate = current.trim() === "" ? `${current}${word}` : `${current} ${word}`;
    if ([...candidate].length > WIDTH && current.trim() !== "") {
      lines.push(current);
      current = `${" ".repeat(indent)}${word}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}
