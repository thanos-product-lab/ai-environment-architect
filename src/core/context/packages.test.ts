import { describe, expect, it } from "vitest";
import { matchWorkspaceMembers, packageOf, workspacePatterns } from "./packages.js";

// Workspace members and package membership (IMPL §1.5, tier 5).

describe("workspace patterns", () => {
  it("reads package.json `workspaces` as an array or as `{ packages }`", () => {
    expect(workspacePatterns({ packageJson: '{"workspaces":["apps/*","libs/x"]}' })).toEqual([
      "apps/*",
      "libs/x",
    ]);
    expect(workspacePatterns({ packageJson: '{"workspaces":{"packages":["a/*"]}}' })).toEqual([
      "a/*",
    ]);
  });

  it("reads lerna.json `packages`", () => {
    expect(workspacePatterns({ lernaJson: '{"packages":["modules/*"]}' })).toEqual(["modules/*"]);
  });

  it("reads the `packages:` block list in pnpm-workspace.yaml, quoted or not, with comments", () => {
    const yaml = [
      "# workspace",
      "packages:",
      "  - 'apps/*'",
      '  - "libs/**"   # all libraries',
      "  - tools/cli",
      "  - '!**/fixtures/**'",
      "catalog:",
      "  - not-a-package",
      "",
    ].join("\n");
    expect(workspacePatterns({ pnpmWorkspace: yaml })).toEqual([
      "apps/*",
      "libs/**",
      "tools/cli",
      "!**/fixtures/**",
    ]);
  });

  it("reads a compact block list at column zero in pnpm-workspace.yaml", () => {
    expect(
      workspacePatterns({ pnpmWorkspace: "packages:\n- 'apps/*'\n- libs\ncatalog:\n" }),
    ).toEqual(["apps/*", "libs"]);
  });

  it("reads a flow list in pnpm-workspace.yaml", () => {
    expect(workspacePatterns({ pnpmWorkspace: "packages: ['a/*', \"b\"]\n" })).toEqual([
      "a/*",
      "b",
    ]);
  });

  it("ignores what it cannot parse", () => {
    expect(workspacePatterns({ packageJson: "{not json", lernaJson: '{"packages":"x"}' })).toEqual(
      [],
    );
    expect(workspacePatterns({ packageJson: '{"workspaces":[1,"a"]}' })).toEqual(["a"]);
  });
});

describe("matching workspace members", () => {
  const directories = ["apps", "apps/web", "apps/api", "apps/api/src", "libs", "libs/a/b"];

  it("matches `*` within one segment and `**` across any number", () => {
    expect(matchWorkspaceMembers(["apps/*"], directories)).toEqual(["apps/api", "apps/web"]);
    expect(matchWorkspaceMembers(["libs/**"], directories)).toEqual(["libs", "libs/a/b"]);
  });

  it("ignores a leading `./` and a trailing `/`", () => {
    expect(matchWorkspaceMembers(["./apps/web/"], directories)).toEqual(["apps/web"]);
  });

  it("removes members matched by a `!` pattern", () => {
    expect(matchWorkspaceMembers(["apps/*", "!apps/api"], directories)).toEqual(["apps/web"]);
  });

  it("returns only existing directories, sorted bytewise", () => {
    expect(matchWorkspaceMembers(["missing/*", "apps/web", "apps/api"], directories)).toEqual([
      "apps/api",
      "apps/web",
    ]);
  });
});

describe("package membership", () => {
  it("places a file in the deepest package that contains it, or the root package", () => {
    const packages = ["apps", "apps/web"];
    expect(packageOf(packages, "apps/web/src/a.ts")).toBe("apps/web");
    expect(packageOf(packages, "apps/x.ts")).toBe("apps");
    expect(packageOf(packages, "appsx/a.ts")).toBe("");
    expect(packageOf(packages, "main.go")).toBe("");
  });
});
