import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStorageOutsideRepository, resolveStorageDirectory } from "./location.js";

// The storage directory and its refusal inside the target repository (IMPL §4.2, §4.11
// "Storage resolution").

const HOME = "/home/dev";

describe("storage resolution (IMPL §4.2)", () => {
  it("uses the override first", () => {
    expect(
      resolveStorageDirectory(
        { AI_ENVIRONMENT_ARCHITECT_HOME: "/data/aea", XDG_DATA_HOME: "/xdg" },
        HOME,
      ),
    ).toEqual({ ok: true, path: "/data/aea", route: "override" });
  });

  it("then an absolute XDG_DATA_HOME", () => {
    expect(resolveStorageDirectory({ XDG_DATA_HOME: "/xdg" }, HOME)).toEqual({
      ok: true,
      path: "/xdg/ai-environment-architect",
      route: "xdg",
    });
  });

  it("ignores a relative XDG_DATA_HOME, as the XDG specification requires", () => {
    expect(resolveStorageDirectory({ XDG_DATA_HOME: "data" }, HOME)).toEqual({
      ok: true,
      path: "/home/dev/.local/share/ai-environment-architect",
      route: "default",
    });
  });

  it("then the default under the home directory", () => {
    expect(resolveStorageDirectory({}, HOME)).toEqual({
      ok: true,
      path: "/home/dev/.local/share/ai-environment-architect",
      route: "default",
    });
  });

  it("treats an empty variable as unset", () => {
    expect(
      resolveStorageDirectory({ AI_ENVIRONMENT_ARCHITECT_HOME: "", XDG_DATA_HOME: "" }, HOME),
    ).toMatchObject({ ok: true, route: "default" });
  });

  it("refuses a relative override rather than ignoring a deliberate setting", () => {
    expect(resolveStorageDirectory({ AI_ENVIRONMENT_ARCHITECT_HOME: "store" }, HOME)).toEqual({
      ok: false,
      reason: "relative_override",
      value: "store",
    });
  });

  it("normalises the path", () => {
    expect(
      resolveStorageDirectory({ AI_ENVIRONMENT_ARCHITECT_HOME: "/data//aea/" }, HOME),
    ).toMatchObject({ path: "/data/aea" });
  });
});

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aea-location-")));
  temporary.push(dir);
  return dir;
}

describe("storage never inside the target repository (IMPL §4.2)", () => {
  it("allows a storage directory outside the repository", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo"));
    mkdirSync(join(dir, "store"));
    expect(await checkStorageOutsideRepository(join(dir, "store"), join(dir, "repo"))).toEqual({
      inside: false,
    });
  });

  it("allows a sibling whose name starts with the repository's name", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo"));
    mkdirSync(join(dir, "repo-store"));
    expect(await checkStorageOutsideRepository(join(dir, "repo-store"), join(dir, "repo"))).toEqual(
      { inside: false },
    );
  });

  it("refuses the repository root itself", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo"));
    expect(await checkStorageOutsideRepository(join(dir, "repo"), join(dir, "repo"))).toEqual({
      inside: true,
      storage: join(dir, "repo"),
      repository: join(dir, "repo"),
    });
  });

  it("refuses a directory inside the repository that doesn't exist yet, without creating it", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo"));
    const storage = join(dir, "repo", ".local", "share", "ai-environment-architect");
    expect(await checkStorageOutsideRepository(storage, join(dir, "repo"))).toMatchObject({
      inside: true,
    });
    expect(readdirSync(join(dir, "repo"))).toEqual([]);
  });

  it("refuses a route through a symbolic link into the repository", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo", "data"), { recursive: true });
    symlinkSync(join(dir, "repo", "data"), join(dir, "link"));
    expect(
      await checkStorageOutsideRepository(join(dir, "link", "aea"), join(dir, "repo")),
    ).toMatchObject({ inside: true, storage: join(dir, "repo", "data", "aea") });
  });

  it("refuses a repository reached through a symbolic link", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo"));
    symlinkSync(join(dir, "repo"), join(dir, "repo-link"));
    expect(
      await checkStorageOutsideRepository(join(dir, "repo", "aea"), join(dir, "repo-link")),
    ).toMatchObject({ inside: true });
  });

  it("refuses the default route when the repository is the home directory", async () => {
    const home = scratch();
    const resolved = resolveStorageDirectory({}, home);
    if (!resolved.ok) throw new Error("expected a path");
    expect(await checkStorageOutsideRepository(resolved.path, home)).toMatchObject({
      inside: true,
    });
  });

  it("refuses the XDG route into the repository", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "repo"));
    const resolved = resolveStorageDirectory({ XDG_DATA_HOME: join(dir, "repo") }, "/nowhere");
    if (!resolved.ok) throw new Error("expected a path");
    expect(await checkStorageOutsideRepository(resolved.path, join(dir, "repo"))).toMatchObject({
      inside: true,
    });
  });

  it.runIf(process.platform === "darwin")(
    "compares real paths with the file system's letter case, so a differently cased route is caught",
    async () => {
      const dir = scratch();
      mkdirSync(join(dir, "Repo"));
      expect(
        await checkStorageOutsideRepository(join(dir, "repo", "aea"), join(dir, "Repo")),
      ).toMatchObject({ inside: true });
    },
  );
});
