import { describe, expect, it } from "vitest";
import { buildExclusionRules, findExclusion, matchesPathOrAncestor } from "./exclusions.js";
import type { EntryKind } from "./repository-fs.js";

const defaults = buildExclusionRules({ userExclusions: [] });
const excludedBy = (path: string, kind: EntryKind = "file"): string | undefined =>
  findExclusion(defaults, path, kind)?.pattern;

describe("default exclusions (IMPL §1.4)", () => {
  it("excludes .git whether it is a directory or a gitdir file", () => {
    expect(excludedBy(".git", "directory")).toBe(".git");
    expect(excludedBy(".git", "file")).toBe(".git");
    expect(excludedBy("libs/ui/.git", "file")).toBe(".git");
  });

  it.each([
    ".hg/",
    ".svn/",
    "node_modules/",
    "vendor/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".pnpm-store/",
    "dist/",
    "build/",
    "out/",
    ".next/",
    "target/",
    "coverage/",
    ".turbo/",
  ])("excludes the directory %s at any depth", (pattern) => {
    const name = pattern.slice(0, -1);
    expect(excludedBy(name, "directory")).toBe(pattern);
    expect(excludedBy(`packages/api/${name}`, "directory")).toBe(pattern);
  });

  it("directory rules don't match a file with the same name", () => {
    expect(excludedBy("dist", "file")).toBeUndefined();
    expect(excludedBy("src/build", "file")).toBeUndefined();
  });

  it("directory rules match a symbolic link with the directory's name", () => {
    expect(excludedBy("packages/web/node_modules", "symlink")).toBe("node_modules/");
  });

  it("directory rules compare case-sensitively", () => {
    expect(excludedBy("Build", "directory")).toBeUndefined();
  });

  it.each([
    ["app.min.js", "*.min.js"],
    ["static/app.js.map", "*.map"],
    ["package-lock.json", "package-lock.json"],
    ["packages/web/pnpm-lock.yaml", "pnpm-lock.yaml"],
    ["yarn.lock", "yarn.lock"],
    ["poetry.lock", "poetry.lock"],
    ["uv.lock", "uv.lock"],
    ["Cargo.lock", "Cargo.lock"],
    ["Gemfile.lock", "Gemfile.lock"],
  ])("excludes build output and lockfile %s", (path, pattern) => {
    expect(excludedBy(path)).toBe(pattern);
  });

  it.each([
    [".env", ".env"],
    ["config/.env", ".env"],
    [".env.local", ".env.*"],
    [".env.production", ".env.*"],
    ["certs/server.pem", "*.pem"],
    ["keys/deploy.key", "*.key"],
    ["keys/client.p12", "*.p12"],
    ["id_rsa", "id_rsa*"],
    ["id_rsa.pub", "id_rsa*"],
    ["app.keystore", "*.keystore"],
    ["config/credentials.json", "credentials*"],
    ["secrets.yaml", "secrets*"],
  ])("excludes the secret-bearing name %s", (path, pattern) => {
    expect(excludedBy(path)).toBe(pattern);
  });

  it("keeps .env.example and .env.sample", () => {
    expect(excludedBy(".env.example")).toBeUndefined();
    expect(excludedBy("app/.env.sample")).toBeUndefined();
  });

  it("secret-bearing names also exclude directories", () => {
    expect(excludedBy("secrets", "directory")).toBe("secrets*");
    expect(excludedBy("deploy/credentials.d", "directory")).toBe("credentials*");
  });

  it("secret-bearing names compare case-insensitively", () => {
    expect(excludedBy("ID_RSA")).toBe("id_rsa*");
    expect(excludedBy("Secrets.yaml")).toBe("secrets*");
    expect(excludedBy("deploy/SECRETS", "directory")).toBe("secrets*");
  });

  it("secret-bearing names match the start of the base name only", () => {
    expect(excludedBy("docs/my-secrets.md")).toBeUndefined();
    expect(excludedBy("src/environment.ts")).toBeUndefined();
    expect(excludedBy(".envrc")).toBeUndefined();
  });

  it.each(["assets/logo.png", "photo.JPG", "fonts/Inter.woff2", "docs/spec.pdf", "lib.so"])(
    "excludes the binary or media type %s, ignoring case",
    (path) => {
      expect(excludedBy(path)).toBeDefined();
    },
  );

  it("excludes personal agent configuration: CLAUDE.local.md anywhere, local settings at the root", () => {
    expect(excludedBy("CLAUDE.local.md")).toBe("CLAUDE.local.md");
    expect(excludedBy("packages/api/CLAUDE.local.md")).toBe("CLAUDE.local.md");
    expect(excludedBy(".claude/settings.local.json")).toBe(".claude/settings.local.json");
    expect(excludedBy("claude.local.md")).toBeUndefined();
    expect(excludedBy(".claude/settings.json")).toBeUndefined();
    expect(excludedBy("CLAUDE.md")).toBeUndefined();
  });

  it("leaves ordinary source and documentation alone", () => {
    for (const path of ["README.md", "src/index.ts", "package.json", "CLAUDE.md", "docs/a.txt"]) {
      expect(excludedBy(path)).toBeUndefined();
    }
  });

  it("records every default rule with source default", () => {
    expect(defaults.every((rule) => rule.source === "default")).toBe(true);
  });
});

describe("matchesPathOrAncestor (includeIgnored)", () => {
  it("matches the file itself, or any directory above it, with the exclusion grammar", () => {
    expect(matchesPathOrAncestor(["config.js"], "server/config.js")).toBe(true);
    expect(matchesPathOrAncestor(["logs/"], "logs/old/x.log")).toBe(true);
    expect(matchesPathOrAncestor(["/server/*.js"], "server/config.js")).toBe(true);
    expect(matchesPathOrAncestor(["logs/"], "logs")).toBe(false);
    expect(matchesPathOrAncestor(["config.js"], "server/config.json")).toBe(false);
    expect(matchesPathOrAncestor([], "a.txt")).toBe(false);
  });
});

describe("user exclusions and session storage", () => {
  const rules = buildExclusionRules({
    userExclusions: ["*.generated.ts", "docs/private/", "notes/todo.md"],
    sessionStoragePath: ".architect/sessions",
  });
  const match = (path: string, kind: EntryKind = "file") => findExclusion(rules, path, kind);

  it("adds user patterns after the defaults", () => {
    const user = rules.filter((rule) => rule.source === "user").map((rule) => rule.pattern);
    expect(user).toEqual(["*.generated.ts", "docs/private/", "notes/todo.md"]);
    expect(rules.slice(0, defaults.length)).toEqual(defaults);
  });

  it("matches a base-name glob at any depth", () => {
    expect(match("src/api.generated.ts")?.source).toBe("user");
  });

  it("anchors a pattern that contains a slash", () => {
    expect(match("docs/private", "directory")?.pattern).toBe("docs/private/");
    expect(match("other/docs/private", "directory")).toBeUndefined();
    expect(match("notes/todo.md")?.pattern).toBe("notes/todo.md");
    expect(match("x/notes/todo.md")).toBeUndefined();
  });

  it("excludes the session storage directory inside the repository (DM §15)", () => {
    const rule = match(".architect/sessions", "directory");
    expect(rule).toMatchObject({ pattern: ".architect/sessions/", source: "session_storage" });
  });

  it("an anchored pattern can have several wildcards, each within one path segment", () => {
    const multi = buildExclusionRules({ userExclusions: ["src/*/gen/*.ts"] });
    expect(findExclusion(multi, "src/x/gen/y.ts", "file")?.source).toBe("user");
    expect(findExclusion(multi, "src/x/z/gen/y.ts", "file")).toBeUndefined();
    expect(findExclusion(multi, "src/x/gen/sub/y.ts", "file")).toBeUndefined();
  });

  it("treats regular-expression characters in a pattern literally", () => {
    const literal = buildExclusionRules({ userExclusions: ["a+b.(1).txt"] });
    expect(findExclusion(literal, "a+b.(1).txt", "file")?.source).toBe("user");
    expect(findExclusion(literal, "aab.(1).txt", "file")).toBeUndefined();
  });

  it("a leading slash anchors a pattern at the root", () => {
    const leading = buildExclusionRules({ userExclusions: ["/generated/"] });
    expect(findExclusion(leading, "generated", "directory")?.source).toBe("user");
    expect(findExclusion(leading, "src/generated", "directory")).toBeUndefined();
  });

  it("normalises the session storage path and anchors it", () => {
    for (const path of ["./.sessions", ".sessions/", ".sessions"]) {
      const storage = buildExclusionRules({ userExclusions: [], sessionStoragePath: path });
      expect(findExclusion(storage, ".sessions", "directory")?.source).toBe("session_storage");
      expect(findExclusion(storage, "a/.sessions", "directory")).toBeUndefined();
    }
  });

  it("rejects a session storage path outside the repository", () => {
    for (const path of ["/home/me/.sessions", "../sessions", ""]) {
      expect(() => buildExclusionRules({ userExclusions: [], sessionStoragePath: path })).toThrow();
    }
  });

  it("returns the first matching rule in rule order", () => {
    const both = buildExclusionRules({ userExclusions: ["*.pem"] });
    expect(findExclusion(both, "a.pem", "file")?.source).toBe("default");
  });
});
