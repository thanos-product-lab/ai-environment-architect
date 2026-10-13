import type { EntryKind } from "./repository-fs.js";

// Default and user exclusions (IMPL §1.4). Files ignored by .gitignore are not excluded: the
// snapshot records them as `ignored` when git can list them.
//
// Pattern grammar, shared by defaults and user exclusions:
// - A trailing `/` matches directories (and symbolic links) only; otherwise any entry matches.
// - A pattern that starts with `/` or contains another `/` is anchored at the repository root
//   and matches that path. Otherwise it matches the entry's base name at any depth.
// - The session storage location is always anchored, because it names one place.
// - `*` matches any run of characters except `/`. There are no other wildcards.

export type ExclusionSource = "default" | "user" | "session_storage";

export interface ExclusionRule {
  readonly pattern: string;
  readonly source: ExclusionSource;
  /** Base names that the pattern would match but are not excluded. */
  readonly except?: readonly string[];
  /** Compare ASCII letters case-insensitively. Used for secret-bearing names and binary types. */
  readonly ignoreCase: boolean;
}

const caseSensitive = (pattern: string): ExclusionRule => ({
  pattern,
  source: "default",
  ignoreCase: false,
});
const caseInsensitive = (pattern: string): ExclusionRule => ({
  pattern,
  source: "default",
  ignoreCase: true,
});

// `.git` matches a file too: in a linked worktree or submodule it is a `gitdir:` file.
const VERSION_CONTROL = [".git", ".hg/", ".svn/"];
const DEPENDENCIES = [
  "node_modules/",
  "vendor/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pnpm-store/",
];
const BUILD_OUTPUT = [
  "dist/",
  "build/",
  "out/",
  ".next/",
  "target/",
  "coverage/",
  ".turbo/",
  "*.min.js",
  "*.map",
];
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "Gemfile.lock",
];
const SECRET_NAMES: readonly ExclusionRule[] = [
  caseInsensitive(".env"),
  { ...caseInsensitive(".env.*"), except: [".env.example", ".env.sample"] },
  ...["*.pem", "*.key", "*.p12", "id_rsa*", "*.keystore", "credentials*", "secrets*"].map(
    caseInsensitive,
  ),
];
// Personal Claude Code files, usually git-ignored: never project guidance. Exact names, as tier 1
// matches them.
const PERSONAL_AGENT_CONFIG = ["CLAUDE.local.md", ".claude/settings.local.json"];
// biome-ignore format: one line per group reads better than one line per extension
const BINARY_EXTENSIONS = [
  // Images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "tif", "tiff", "psd", "heic", "avif", "svg",
  // Audio and video
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "mp4", "m4v", "mov", "avi", "mkv", "webm",
  // Archives
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war",
  // Fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // Documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // Compiled code and data
  "exe", "dll", "so", "dylib", "a", "o", "obj", "class", "pyc", "wasm", "bin", "sqlite", "db",
];

const DEFAULT_RULES: readonly ExclusionRule[] = [
  ...[...VERSION_CONTROL, ...DEPENDENCIES, ...BUILD_OUTPUT, ...LOCKFILES].map(caseSensitive),
  ...SECRET_NAMES,
  ...PERSONAL_AGENT_CONFIG.map(caseSensitive),
  ...BINARY_EXTENSIONS.map((extension) => caseInsensitive(`*.${extension}`)),
];

export function buildExclusionRules(options: {
  readonly userExclusions: readonly string[];
  readonly sessionStoragePath?: string;
}): readonly ExclusionRule[] {
  const rules = [...DEFAULT_RULES];
  for (const pattern of options.userExclusions) {
    rules.push({ pattern, source: "user", ignoreCase: false });
  }
  if (options.sessionStoragePath !== undefined) {
    const path = options.sessionStoragePath.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(
        `The session storage path must be inside the repository and relative to its root: ${options.sessionStoragePath}`,
      );
    }
    rules.push({ pattern: `${path}/`, source: "session_storage", ignoreCase: false });
  }
  return rules;
}

/** The first rule, in rule order, that matches the entry. */
export function findExclusion(
  rules: readonly ExclusionRule[],
  path: string,
  kind: EntryKind,
): ExclusionRule | undefined {
  return rules.find((rule) => matches(rule, path, kind));
}

function matches(rule: ExclusionRule, path: string, kind: EntryKind): boolean {
  const directoryOnly = rule.pattern.endsWith("/");
  if (directoryOnly && kind !== "directory" && kind !== "symlink") return false;
  const trimmed = directoryOnly ? rule.pattern.slice(0, -1) : rule.pattern;
  const pattern = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const anchored = trimmed.includes("/") || rule.source === "session_storage";
  const subject = anchored ? path : path.slice(path.lastIndexOf("/") + 1);
  const fold = (text: string) => (rule.ignoreCase ? asciiLower(text) : text);
  if (!globMatches(fold(pattern), fold(subject))) return false;
  return !(rule.except ?? []).some((name) => fold(name) === fold(subject));
}

/** `*` matches any run of characters except `/`; everything else matches itself. */
function globMatches(pattern: string, subject: string): boolean {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[\\^$.|?+()[\]{}]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u").test(subject);
}

/** Lower-cases ASCII letters only, so the result never depends on locale or Unicode tables. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
