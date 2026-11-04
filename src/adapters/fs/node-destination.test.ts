import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../core/hash.js";
import { openDestination } from "./node-destination.js";

// The root `CLAUDE.md` on disk, for apply (DM §11.2 steps 1, 5 and 6).

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "aea-destination-"));
  directories.push(dir);
  return dir;
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("the destination adapter (DM §11.2)", () => {
  it("reports absent, a regular file by hash, and a symbolic link or directory as unavailable", async () => {
    const root = repository();
    const destination = await openDestination(root);
    expect(await destination.inspect()).toEqual({ state: "absent" });

    writeFileSync(join(root, "CLAUDE.md"), "# Guide\n");
    expect(await destination.inspect()).toEqual({
      state: "present",
      hash: sha256(encode("# Guide\n")),
    });

    rmSync(join(root, "CLAUDE.md"));
    writeFileSync(join(root, "elsewhere.md"), "# Elsewhere\n");
    symlinkSync("elsewhere.md", join(root, "CLAUDE.md"));
    expect(await destination.inspect()).toEqual({ state: "unavailable", reason: "symlink" });

    rmSync(join(root, "CLAUDE.md"));
    mkdirSync(join(root, "CLAUDE.md"));
    expect(await destination.inspect()).toEqual({
      state: "unavailable",
      reason: "not_regular_file",
    });
  });

  it("writes a temporary file beside the destination and renames it into place", async () => {
    const root = repository();
    writeFileSync(join(root, "CLAUDE.md"), "# Old\n");
    const destination = await openDestination(root);
    expect(await destination.writeTemporary(".CLAUDE.md.apply_1.tmp", encode("# New\n"))).toEqual({
      ok: true,
    });
    expect(readFileSync(join(root, ".CLAUDE.md.apply_1.tmp"), "utf8")).toBe("# New\n");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# Old\n");
    expect(await destination.replace(".CLAUDE.md.apply_1.tmp")).toEqual({ ok: true });
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# New\n");
    expect(readdirSync(root)).toEqual(["CLAUDE.md"]);
  });

  it("creates an absent destination", async () => {
    const root = repository();
    const destination = await openDestination(root);
    await destination.writeTemporary(".CLAUDE.md.apply_1.tmp", encode("# New\n"));
    await destination.replace(".CLAUDE.md.apply_1.tmp");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# New\n");
  });

  it("replaces a symbolic link itself, never the file it points to", async () => {
    const root = repository();
    writeFileSync(join(root, "elsewhere.md"), "# Elsewhere\n");
    symlinkSync("elsewhere.md", join(root, "CLAUDE.md"));
    const destination = await openDestination(root);
    await destination.writeTemporary(".CLAUDE.md.apply_1.tmp", encode("# New\n"));
    await destination.replace(".CLAUDE.md.apply_1.tmp");
    expect(readFileSync(join(root, "elsewhere.md"), "utf8")).toBe("# Elsewhere\n");
    expect(lstatSync(join(root, "CLAUDE.md")).isFile()).toBe(true);
  });

  it("keeps the destination's permissions", async () => {
    const root = repository();
    writeFileSync(join(root, "CLAUDE.md"), "# Old\n");
    chmodSync(join(root, "CLAUDE.md"), 0o600);
    const destination = await openDestination(root);
    await destination.writeTemporary(".CLAUDE.md.apply_1.tmp", encode("# New\n"));
    await destination.replace(".CLAUDE.md.apply_1.tmp");
    expect(statSync(join(root, "CLAUDE.md")).mode & 0o777).toBe(0o600);
  });

  it("refuses an existing temporary file, and removes one only by its name", async () => {
    const root = repository();
    const destination = await openDestination(root);
    writeFileSync(join(root, ".CLAUDE.md.apply_1.tmp"), "left over");
    expect(await destination.writeTemporary(".CLAUDE.md.apply_1.tmp", encode("x"))).toEqual({
      ok: false,
      reason: "exists",
    });
    expect(await destination.remove(".CLAUDE.md.apply_1.tmp")).toEqual({ ok: true });
    expect(await destination.remove(".CLAUDE.md.apply_1.tmp")).toEqual({ ok: true });
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a temporary name that isn't one segment, or would be the destination", async () => {
    const destination = await openDestination(repository());
    for (const name of ["../escape.tmp", "sub/x.tmp", "", ".", "..", "CLAUDE.md"]) {
      await expect(destination.writeTemporary(name, encode("x"))).rejects.toThrow(/temporary/);
      await expect(destination.replace(name)).rejects.toThrow(/temporary/);
      await expect(destination.remove(name)).rejects.toThrow(/temporary/);
    }
  });

  it("reports a rename that fails as a result, leaving the destination as it was", async () => {
    const root = repository();
    writeFileSync(join(root, "CLAUDE.md"), "# Old\n");
    const destination = await openDestination(root);
    expect(await destination.replace(".CLAUDE.md.apply_1.tmp")).toEqual({
      ok: false,
      reason: "io_error",
    });
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# Old\n");
  });

  it("reports a write it may not make as permission_denied", async () => {
    if (process.getuid?.() === 0) return;
    const root = repository();
    const destination = await openDestination(root);
    chmodSync(root, 0o500);
    try {
      expect(await destination.writeTemporary(".CLAUDE.md.apply_1.tmp", encode("x"))).toEqual({
        ok: false,
        reason: "permission_denied",
      });
    } finally {
      chmodSync(root, 0o700);
    }
  });
});
