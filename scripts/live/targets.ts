import type { GitReader } from "../../src/core/snapshot/git.js";
import type { Snapshot } from "../../src/core/snapshot/snapshot.js";

// Which repositories a live run may use (M6 live-run protocol, step 1): only one listed in
// docs/DEVELOPMENT_REPOSITORIES.md, at its pinned commit, with a clean working tree. The name
// and `HEAD` are checked before any file is read; the tree, on the snapshot, before anything is
// sent or saved.

export interface DevelopmentRepository {
  readonly name: string;
  readonly url: string;
  /** The full 40-character SHA. */
  readonly commit: string;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The rows of the "Repositories" table: name, URL and pinned commit. A row whose pin isn't a
 * full SHA is refused rather than skipped, since it can only be a mistake in the table.
 */
export function parseDevelopmentRepositories(markdown: string): DevelopmentRepository[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Repositories");
  if (start === -1) throw new Error("DEVELOPMENT_REPOSITORIES.md has no Repositories section");
  const rows: DevelopmentRepository[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] === "Slot" || /^-+$/.test(cells[0] ?? "")) continue;
    const [, name, url, pinned] = cells;
    const commit = pinned?.replace(/^`|`$/g, "");
    if (name === undefined || url === undefined || commit === undefined || !SHA.test(commit))
      throw new Error(`DEVELOPMENT_REPOSITORIES.md has a row without a full pinned SHA: ${line}`);
    rows.push({ name, url, commit });
  }
  if (rows.length === 0) throw new Error("DEVELOPMENT_REPOSITORIES.md lists no repository");
  return rows;
}

export type TargetCheck =
  | { readonly ok: true; readonly repository: DevelopmentRepository }
  | { readonly ok: false; readonly reason: string };

/**
 * The name is listed and the root's `HEAD` is its pin. `HEAD` is read through the git adapter,
 * which writes nothing, runs no hook or fsmonitor and ignores the environment and global config
 * (`src/adapters/git/git-reader.ts`), and which reads only a root that is its repository's top
 * level. Whether the tree is clean is checked on the snapshot (`snapshotProblem`), from the
 * snapshot's own reads, never with `git status`, which can rewrite the index.
 */
export async function checkTarget(
  name: string,
  repositories: readonly DevelopmentRepository[],
  git: Pick<GitReader, "readHead">,
): Promise<TargetCheck> {
  const repository = repositories.find((r) => r.name === name);
  if (repository === undefined)
    return {
      ok: false,
      reason: `${name} isn't listed in docs/DEVELOPMENT_REPOSITORIES.md (listed: ${repositories
        .map((r) => r.name)
        .join(", ")})`,
    };
  const head = await git.readHead();
  if (!head.ok) return { ok: false, reason: `git can't read ${name}'s HEAD (${head.reason})` };
  if (head.commit !== repository.commit)
    return {
      ok: false,
      reason: `${name} is at ${head.commit ?? "no commit"}, not its pinned ${repository.commit}`,
    };
  return { ok: true, repository };
}

/**
 * The same conditions on the snapshot, which is read after the git check: its commit is the pin
 * and it found nothing modified, deleted or untracked. Undefined when they hold.
 */
export function snapshotProblem(snapshot: Snapshot, commit: string): string | undefined {
  const git = snapshot.git;
  if (git.state !== "known") return `the snapshot has no git metadata (${git.reason})`;
  if (git.commit !== commit) return `the snapshot is at ${git.commit}, not ${commit}`;
  if (git.workingTreeDirty !== false || git.untrackedCount > 0 || git.deletedPaths.length > 0)
    return "the snapshot found changes that aren't committed";
  if (snapshot.stability.state !== "stable") return "the repository changed while it was read";
  return undefined;
}
