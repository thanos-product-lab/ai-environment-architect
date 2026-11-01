import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

// The storage directory (IMPL §4.2). The CLI resolves it once at start, from the environment it
// passes in, and hands core the path; core never reads `process.env`.
//
// 1. `$AI_ENVIRONMENT_ARCHITECT_HOME`, if set. It must be absolute: a relative override is
//    refused rather than ignored, because the developer chose it deliberately.
// 2. `$XDG_DATA_HOME/ai-environment-architect`, if XDG_DATA_HOME is absolute; a relative one is
//    ignored, as the XDG specification requires.
// 3. `~/.local/share/ai-environment-architect`.
//
// An empty variable counts as unset, as in the XDG specification.

export type StorageRoute = "override" | "xdg" | "default";

export const STORAGE_OVERRIDE_VARIABLE = "AI_ENVIRONMENT_ARCHITECT_HOME";

export type StorageResolution =
  | { readonly ok: true; readonly path: string; readonly route: StorageRoute }
  | { readonly ok: false; readonly reason: "relative_override"; readonly value: string };

export function resolveStorageDirectory(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): StorageResolution {
  const override = env[STORAGE_OVERRIDE_VARIABLE];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) return { ok: false, reason: "relative_override", value: override };
    return { ok: true, path: clean(override), route: "override" };
  }
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) {
    return { ok: true, path: clean(join(xdg, "ai-environment-architect")), route: "xdg" };
  }
  return {
    ok: true,
    path: clean(join(home, ".local", "share", "ai-environment-architect")),
    route: "default",
  };
}

function clean(path: string): string {
  const normal = normalize(path);
  return normal.length > 1 && normal.endsWith(sep) ? normal.slice(0, -1) : normal;
}

export type StorageCheck =
  | { readonly inside: false }
  | {
      readonly inside: true;
      /** The storage directory's real path. */
      readonly storage: string;
      /** The repository root's real path. */
      readonly repository: string;
    };

/**
 * Whether the storage directory's real path is the repository root or inside it, by any route
 * (IMPL §4.2). `init` and `resume` call this before anything is read or written, and refuse if
 * it is. Real paths come from the native `realpath`, which also gives the file system's letter
 * case, so a differently cased route on a case-insensitive volume is still caught. A storage
 * directory that doesn't exist yet is resolved through its deepest existing ancestor; nothing
 * is created.
 */
export async function checkStorageOutsideRepository(
  storageDirectory: string,
  repositoryRoot: string,
): Promise<StorageCheck> {
  const repository = await realpath(repositoryRoot);
  const storage = await realPathOfMaybeMissing(storageDirectory);
  const within = storage === repository || storage.startsWith(withSeparator(repository));
  return within ? { inside: true, storage, repository } : { inside: false };
}

function withSeparator(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

async function realPathOfMaybeMissing(path: string): Promise<string> {
  const missing: string[] = [];
  let current = normalize(path);
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
