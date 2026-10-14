import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  GitHead,
  GitIgnoredList,
  GitReader,
  GitTreeEntry,
  GitUnknownReason,
  ObjectFormat,
} from "../../core/snapshot/git.js";
import { decodeName } from "../fs/node-repository-fs.js";

// Lists ignored entries before capture, and reads the commit and its tree after it, for snapshot
// metadata (DM §6.1). The repository is untrusted:
//
// - Only `git --version`, `rev-parse`, `config --get-regexp` (below 2.44 only), `symbolic-ref`,
//   `show-ref`, `ls-tree` and `ls-files --others --ignored --exclude-standard --directory` run. None of them refreshes the
//   index or runs hooks, clean/smudge filters or fsmonitor. Only `ls-files` reads the working
//   tree, and only its directory listings and ignore files, never file content. The working
//   tree is compared in core, from the snapshot's own reads.
// - `GIT_OPTIONAL_LOCKS=0`, and nothing is written.
// - The environment is rebuilt from scratch, so variables such as GIT_DIR can't redirect git.
//   Global and system config are ignored. fsmonitor and the untracked cache are forced off.
// - `GIT_NO_LAZY_FETCH=1` and `--no-lazy-fetch` stop a partial clone fetching missing objects,
//   which could run a command from the repository's config. A missing object then fails the read
//   (git_error) instead of being fetched. Both need git 2.44. Older git, down to 2.38, is used
//   without them, except in a partial clone, the only kind of repository it could fetch into.
// - Git runs only when the root has a `.git` entry, so discovery finds it at once and never
//   climbs into an enclosing repository. GIT_CEILING_DIRECTORIES backs this up when the parent
//   path can be expressed (it is colon-separated). A bare-repository layout at the root has no
//   `.git` and is not read; `safe.bareRepository=explicit` refuses it as well.
// - Discovery is kept, rather than setting GIT_DIR, because git checks safe.directory ownership
//   only during discovery.
// - HOME is not passed, so a repository config that includes `~/…` makes git fail: git_error,
//   or git_too_old below 2.44, where the partial-clone check fails closed.

/** safe.bareRepository arrived in 2.38; safe.directory in 2.35.2. */
const MINIMUM_VERSION = [2, 38] as const;
/** GIT_NO_LAZY_FETCH and --no-lazy-fetch arrived in 2.44. */
const NO_LAZY_FETCH_VERSION = [2, 44] as const;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1 << 30;

export interface GitReaderOptions {
  /** The git executable. Default: `git` from PATH. */
  readonly gitPath?: string;
}

/** A GitReader for the repository at `root`. */
export function openGitReader(root: string, options: GitReaderOptions = {}): GitReader {
  const gitPath = options.gitPath ?? "git";
  return {
    async readIgnored(): Promise<GitIgnoredList> {
      const ready = await prepare(gitPath, root);
      if (!ready.ok) return ready;
      // `--directory` lists a wholly ignored directory once, so node_modules/ is one entry.
      const listed = await ready.run([
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ]);
      return listed.ok ? { ok: true, paths: splitNul(listed.stdout) } : listed;
    },

    async readHead(): Promise<GitHead> {
      const ready = await prepare(gitPath, root);
      if (!ready.ok) return ready;
      const { run, objectFormat } = ready;
      const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      if (!head.ok) {
        return (await isUnborn(run)) ? { ok: true, objectFormat, commit: null, tree: [] } : head;
      }
      const commit = withoutNewline(head.stdout);

      const tree = await run(["ls-tree", "-r", "-z", "-l", "--full-tree", commit]);
      if (!tree.ok) return tree;
      const entries = parseTree(tree.stdout, objectFormat);
      return entries === undefined
        ? { ok: false, reason: "git_error" }
        : { ok: true, objectFormat, commit, tree: entries };
    },
  };
}

type Prepared =
  | { readonly ok: true; readonly run: Run; readonly objectFormat: ObjectFormat }
  | { readonly ok: false; readonly reason: GitUnknownReason };

/**
 * The checks every read starts with: a git new enough, a repository whose top level is the root,
 * its object format, and, for git older than 2.44, that it is not a partial clone. Run for each
 * read, never cached, so a later snapshot sees the repository as it is then.
 */
async function prepare(gitPath: string, root: string): Promise<Prepared> {
  const realRoot = await realpath(root);
  const bare = runner(gitPath, realRoot, false);
  // Without the safety flags: git before 2.44 rejects --no-lazy-fetch.
  const version = await bare(["--version"], { bare: true });
  if (!version.ok) return version;
  const versionText = version.stdout.toString("utf8");
  if (!isAtLeast(versionText, MINIMUM_VERSION)) return { ok: false, reason: "git_too_old" };
  const lazyFetchFlag = isAtLeast(versionText, NO_LAZY_FETCH_VERSION);
  const run = runner(gitPath, realRoot, lazyFetchFlag);

  try {
    await lstat(join(realRoot, ".git"));
  } catch {
    return { ok: false, reason: "not_a_repository" };
  }

  const topLevel = await run(["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return topLevel;
  if ((await realpath(withoutNewline(topLevel.stdout))) !== realRoot) {
    return { ok: false, reason: "not_a_repository" };
  }

  // Before 2.44, git can't be told not to fetch missing objects. Only a partial clone has a
  // promisor remote to fetch them from, so only a partial clone is refused.
  if (!lazyFetchFlag && (await isPartialClone(run))) return { ok: false, reason: "git_too_old" };

  const format = await run(["rev-parse", "--show-object-format"]);
  if (!format.ok) return format;
  const objectFormat = withoutNewline(format.stdout);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    return { ok: false, reason: "git_error" };
  }
  return { ok: true, run, objectFormat };
}

/**
 * Git fetches lazily only from a promisor remote: one named by `extensions.partialClone`, or a
 * remote with `promisor` set. Any such key counts, whatever its value. `git config` reads config
 * only, with include files, and exits 1 when nothing matches.
 */
async function isPartialClone(run: Run): Promise<boolean> {
  const found = await run([
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
  ]);
  if (found.ok) return found.stdout.length > 0;
  // Exit 1 means no key matched; anything else is treated as a partial clone, to be safe.
  return found.exitCode !== 1;
}

type RunResult =
  | { readonly ok: true; readonly stdout: Buffer }
  | {
      readonly ok: false;
      readonly reason: GitUnknownReason;
      readonly exitCode: number | null;
      readonly stderr: Buffer;
    };

type Run = (args: readonly string[], options?: { bare?: boolean }) => Promise<RunResult>;

/**
 * True only when HEAD names a branch that doesn't exist yet. A HEAD that can't be resolved for
 * any other reason (a missing object, a detached HEAD at a non-commit) is an error, not "no
 * commits". `show-ref --verify` exits 1 for a missing ref and 128 for a broken one.
 */
async function isUnborn(run: Run): Promise<boolean> {
  const symbolic = await run(["symbolic-ref", "--quiet", "HEAD"]);
  if (!symbolic.ok) return false;
  const ref = await run(["show-ref", "--verify", "--quiet", withoutNewline(symbolic.stdout)]);
  return !ref.ok && ref.exitCode === 1;
}

function withoutNewline(output: Buffer): string {
  const text = output.toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function runner(gitPath: string, root: string, lazyFetchFlag: boolean): Run {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  if (!dirname(root).includes(":")) env["GIT_CEILING_DIRECTORIES"] = dirname(root);
  const fixed = [
    ...(lazyFetchFlag ? ["--no-lazy-fetch"] : []),
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "safe.bareRepository=explicit",
    // The repository's own config could point ls-files at any readable file, or a FIFO that
    // stalls it. Only .gitignore files and .git/info/exclude apply.
    "-c",
    "core.excludesFile=/dev/null",
  ];
  return (args, options = {}) =>
    new Promise((resolve) => {
      execFile(
        gitPath,
        options.bare === true ? [...args] : [...fixed, ...args],
        { cwd: root, env, encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, stdout });
            return;
          }
          const exitCode = typeof error.code === "number" ? error.code : null;
          resolve({ ok: false, reason: classify(error.code, stderr), exitCode, stderr });
        },
      );
    });
}

function classify(code: unknown, stderr: Buffer): GitUnknownReason {
  if (code === "ENOENT" || code === "EACCES") return "git_missing";
  const message = stderr.toString("utf8");
  if (/dubious ownership|safe\.directory/.test(message)) return "unsafe_repository";
  if (/not a git repository/i.test(message)) return "not_a_repository";
  return "git_error";
}

function isAtLeast(versionOutput: string, minimum: readonly [number, number]): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

/** NUL-terminated paths, decoded and escaped as in the snapshot. */
function splitNul(output: Buffer): string[] {
  const paths: string[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    paths.push(decodeName(output.subarray(start, end === -1 ? output.length : end)).name);
    start = end === -1 ? output.length : end + 1;
  }
  return paths;
}

/** Parses `ls-tree -r -z -l`: `<mode> <type> <id> <size>\t<path>\0` per entry. */
function parseTree(output: Buffer, format: ObjectFormat): GitTreeEntry[] | undefined {
  const idLength = format === "sha1" ? 40 : 64;
  const entries: GitTreeEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const record = output.subarray(start, end === -1 ? output.length : end);
    start = end === -1 ? output.length : end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) return undefined;
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]+) +(\d+|-)$/.exec(
      record.subarray(0, tab).toString("utf8"),
    );
    if (match === null || match[3]?.length !== idLength) return undefined;
    entries.push({
      path: decodeName(record.subarray(tab + 1)).name,
      mode: match[1] as string,
      objectId: match[3],
      size: match[4] === "-" ? null : Number(match[4]),
    });
  }
  return entries;
}
