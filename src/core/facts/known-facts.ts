import { lineTexts } from "../context/item.js";
import { matchWorkspaceMembers, workspacePatterns } from "../context/packages.js";
import { isWithheldPath, scanText } from "../context/secrets.js";
import {
  type ImportRecord,
  type SelectionGap,
  type TierMembership,
  tierOf,
} from "../context/tiers.js";
import { type Hash, sha256 } from "../hash.js";
import { comparePaths } from "../paths.js";
import type { RepositoryFs } from "../snapshot/repository-fs.js";
import type { Snapshot } from "../snapshot/snapshot.js";
import { basisOf, findingBasis } from "../validation/basis.js";
import type { Basis, EntryEvidence, Evidence } from "../validation/citations.js";
import {
  type CommandDefinition,
  justfileRecipes,
  makefileTargets,
  packageJsonScripts,
  pyprojectScripts,
  taskfileTasks,
} from "./manifests.js";

// Known facts (IMPL §3.2.5): what code can establish before call 1, recorded as deterministic
// findings with code-made wording and evidence. Agent configuration and workspace packages are
// facts about entries, with `entry` evidence; commands cite the lines that define them. Content
// is read again and checked against the snapshot hash, so a fact never rests on changed bytes.

export type FactScope =
  | { readonly kind: "repository" }
  | { readonly kind: "paths"; readonly paths: readonly string[] };

export type CommandKind = "script" | "target" | "recipe" | "task";

export type KnownFactDetail =
  | { readonly type: "agent_configuration"; readonly path: string; readonly importedBy?: string }
  | { readonly type: "workspace_package"; readonly path: string; readonly declaredIn: string }
  | {
      readonly type: "command";
      readonly file: string;
      readonly kind: CommandKind;
      readonly name: string;
      /** Commands are found, never run, in the first slice (DM §10). */
      readonly status: "found_not_run";
    };

/** A deterministic `claim` finding (DM §6.3). IDs are assigned when it is persisted. */
export interface KnownFact {
  readonly kind: "claim";
  readonly mode: "descriptive";
  readonly producedBy: "deterministic";
  readonly statement: string;
  readonly scope: FactScope;
  readonly evidence: readonly (Evidence | EntryEvidence)[];
  readonly basis: readonly Basis[];
  readonly fact: KnownFactDetail;
}

export type KnownFactsResult =
  | {
      readonly state: "extracted";
      /** In the order of IMPL §3.2.5. */
      readonly facts: readonly KnownFact[];
      /** Deterministic `gap` findings, in file path order. */
      readonly gaps: readonly SelectionGap[];
    }
  /** A file's content no longer matches the snapshot (IMPL §1.3). */
  | { readonly state: "unstable"; readonly changedPaths: readonly string[] };

export const MANIFEST_UNREADABLE = (path: string): string =>
  `\`${path}\` could not be read or parsed, so its commands are not known facts.`;

export const FACT_WITHHELD = (path: string): string =>
  `A known fact from \`${path}\` was withheld because it matched the secret scan.`;

/** What extraction needs from the selection: tiers for basis, imports and declared members. */
export interface FactSources {
  readonly membership: TierMembership;
  readonly importers: readonly ImportRecord[];
  readonly declaredMembers: readonly string[];
}

interface Entry {
  readonly path: string;
  readonly hash: Hash;
  readonly size: number;
  readonly status: "read" | "listed_only";
}

/**
 * A name or path that can't be written as one inline code span: empty, with whitespace at either
 * end, or holding a backtick or a control character.
 */
function unsafe(text: string): boolean {
  return text === "" || /^\s|\s$|[`\p{Cc}]/u.test(text);
}

export async function extractKnownFacts(
  snapshot: Snapshot,
  sources: FactSources,
  fs: RepositoryFs,
): Promise<KnownFactsResult> {
  const membership = sources.membership;
  const entries = new Map<string, Entry>();
  for (const file of snapshot.files) {
    if (
      (file.status === "read" || file.status === "listed_only") &&
      !isWithheldPath(file.path) &&
      !unsafe(file.path)
    ) {
      entries.set(file.path, {
        path: file.path,
        hash: file.hash,
        size: file.size,
        status: file.status,
      });
    }
  }
  const facts: Ordered[] = [];
  const gaps = new Map<string, SelectionGap>();
  const changed: string[] = [];

  const entryEvidence = (entry: Entry): EntryEvidence => ({
    kind: "entry",
    path: entry.path,
    fileHash: entry.hash,
    basis: basisOf(entry.path, membership),
  });
  const add = (
    scope: string,
    rank: number,
    sortKey: readonly (string | number)[],
    statement: string,
    evidence: readonly (Evidence | EntryEvidence)[],
    fact: KnownFactDetail,
    file: string,
  ) => {
    const excerpts = evidence.flatMap((e) => (e.kind === "lines" ? [e.excerpt] : []));
    if ([statement, ...excerpts].some((text) => scanText(text) !== undefined)) {
      gaps.set(file, { gapType: "other", statement: FACT_WITHHELD(file), relatedPaths: [file] });
      return;
    }
    facts.push({
      scope,
      rank,
      sortKey,
      fact: {
        kind: "claim",
        mode: "descriptive",
        producedBy: "deterministic",
        statement,
        scope: scope === "" ? { kind: "repository" } : { kind: "paths", paths: [scope] },
        evidence,
        basis: findingBasis(evidence),
        fact,
      },
    });
  };

  // Agent configuration: tier 1 by its patterns, or only through an import (IMPL §3.2.4).
  const byPattern: TierMembership = { ...membership, imports: [] };
  const importedBy = new Map(sources.importers.map((record) => [record.path, record.importer]));
  for (const entry of entries.values()) {
    if (tierOf(entry.path, membership) !== 1) continue;
    const importer = tierOf(entry.path, byPattern) === 1 ? undefined : importedBy.get(entry.path);
    if (importer !== undefined && unsafe(importer)) continue;
    add(
      "",
      0,
      [depthOf(entry.path), entry.path],
      importer === undefined
        ? `\`${entry.path}\` is existing agent configuration.`
        : `\`${entry.path}\` is imported by \`${importer}\`.`,
      [entryEvidence(entry)],
      {
        type: "agent_configuration",
        path: entry.path,
        ...(importer === undefined ? {} : { importedBy: importer }),
      },
      entry.path,
    );
  }

  // Workspace packages: declared members only, each attributed to the first source whose own
  // patterns, without `!`, match it.
  const read = async (entry: Entry): Promise<string[] | undefined> => {
    if (entry.status !== "read") return undefined;
    const result = await fs.read(entry.path, entry.size);
    if (!result.ok || result.bytes === undefined || sha256(result.bytes) !== entry.hash) {
      changed.push(entry.path);
      return undefined;
    }
    // A `read` entry is valid UTF-8; capture lists any other file as `listed_only` (§1.4).
    return lineTexts(result.bytes);
  };
  const workspaceSources = [
    ["package.json", "packageJson"],
    ["lerna.json", "lernaJson"],
    ["pnpm-workspace.yaml", "pnpmWorkspace"],
  ] as const;
  const texts: { path: string; key: (typeof workspaceSources)[number][1]; text: string }[] = [];
  for (const [path, key] of workspaceSources) {
    const entry = entries.get(path);
    const lines = entry === undefined ? undefined : await read(entry);
    if (lines !== undefined) texts.push({ path, key, text: lines.join("\n") });
  }
  const members = sources.declaredMembers;
  for (const member of members) {
    const declaredIn = texts.find(({ key, text }) => {
      const own = workspacePatterns({ [key]: text }).filter((p) => !p.startsWith("!"));
      return matchWorkspaceMembers(own, [member]).length > 0;
    });
    const declaring = declaredIn === undefined ? undefined : entries.get(declaredIn.path);
    const manifest = entries.get(`${member}/package.json`);
    if (declaring === undefined || manifest === undefined || isWithheldPath(member)) continue;
    add(
      member,
      1,
      [],
      `\`${member}\` is a workspace package declared in \`${declaring.path}\`.`,
      [entryEvidence(declaring), entryEvidence(manifest)],
      { type: "workspace_package", path: member, declaredIn: declaring.path },
      declaring.path,
    );
  }

  // Commands, from the root manifests and those directly inside declared members.
  const manifests: { path: string; scope: string; kind: CommandKind; reader: Reader }[] = [];
  for (const path of entries.keys()) {
    if (path.includes("/")) continue;
    const name = asciiLower(path);
    if (name === "makefile") manifests.push({ path, scope: "", kind: "target", reader: make });
    if (name === "justfile") manifests.push({ path, scope: "", kind: "recipe", reader: just });
    if (name === "taskfile.yml" || name === "taskfile.yaml")
      manifests.push({ path, scope: "", kind: "task", reader: task });
  }
  for (const scope of ["", ...members]) {
    const prefix = scope === "" ? "" : `${scope}/`;
    manifests.push({ path: `${prefix}package.json`, scope, kind: "script", reader: npm });
    manifests.push({ path: `${prefix}pyproject.toml`, scope, kind: "script", reader: python });
  }
  for (const manifest of manifests) {
    const entry = entries.get(manifest.path);
    if (entry === undefined) continue;
    const before = changed.length;
    const lines = await read(entry);
    if (changed.length > before) continue;
    const commands = lines === undefined ? undefined : manifest.reader(lines);
    if (lines === undefined || commands === undefined) {
      gaps.set(manifest.path, {
        gapType: "other",
        statement: MANIFEST_UNREADABLE(manifest.path),
        relatedPaths: [manifest.path],
      });
      continue;
    }
    const seen = new Set<string>();
    for (const command of commands) {
      if (seen.has(command.name) || unsafe(command.name)) continue;
      seen.add(command.name);
      add(
        manifest.scope,
        2,
        [manifest.path, command.lineStart],
        `\`${manifest.path}\` defines the ${manifest.kind} \`${command.name}\`.`,
        [
          {
            kind: "lines",
            path: entry.path,
            fileHash: entry.hash,
            lineStart: command.lineStart,
            lineEnd: command.lineEnd,
            excerpt: lines.slice(command.lineStart - 1, command.lineEnd).join("\n"),
            basis: basisOf(entry.path, membership),
          },
        ],
        {
          type: "command",
          file: manifest.path,
          kind: manifest.kind,
          name: command.name,
          status: "found_not_run",
        },
        manifest.path,
      );
    }
  }

  if (changed.length > 0) {
    return { state: "unstable", changedPaths: [...new Set(changed)].sort(comparePaths) };
  }
  // A stable sort: definitions on one line keep their order.
  facts.sort(
    (a, b) =>
      (a.scope === "" ? 0 : 1) - (b.scope === "" ? 0 : 1) ||
      comparePaths(a.scope, b.scope) ||
      a.rank - b.rank ||
      compareKeys(a.sortKey, b.sortKey),
  );
  return {
    state: "extracted",
    facts: facts.map((entry) => entry.fact),
    gaps: [...gaps.values()].sort((a, b) =>
      comparePaths(a.relatedPaths[0] ?? "", b.relatedPaths[0] ?? ""),
    ),
  };
}

interface Ordered {
  readonly scope: string;
  readonly rank: number;
  readonly sortKey: readonly (string | number)[];
  readonly fact: KnownFact;
}

/** Undefined when the manifest doesn't parse. */
type Reader = (lines: readonly string[]) => readonly CommandDefinition[] | undefined;

const npm: Reader = (lines) => {
  const result = packageJsonScripts(lines);
  return result.ok ? result.commands : undefined;
};
const python: Reader = pyprojectScripts;
const make: Reader = makefileTargets;
const just: Reader = justfileRecipes;
const task: Reader = taskfileTasks;

function compareKeys(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return comparePaths(String(x ?? ""), String(y ?? ""));
  }
  return 0;
}

function depthOf(path: string): number {
  return path.split("/").length - 1;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
