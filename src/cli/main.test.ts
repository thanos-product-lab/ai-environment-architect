import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint } from "../../test/support/fingerprint.js";
import { run } from "./main.js";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/repos");

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "aea-cli-"));
  temporaryDirectories.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: { PATH: process.env["PATH"], GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

describe("arguments", () => {
  it("prints the package version for --version", async () => {
    expect(await run(["--version"])).toEqual({ code: 0, output: "0.0.0\n", stream: "stdout" });
  });

  it.each([[[]], [["frobnicate"]], [["inspect", "--nope"]], [["inspect", "a", "b"]]])(
    "rejects %j with usage help and code 2",
    async (args) => {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.output).toContain("Usage:");
      expect(result.output).toContain("inspect [path] [--list | --json] [--debug]");
    },
  );

  it("rejects --list and --json together", async () => {
    expect((await run(["inspect", "--list", "--json"])).code).toBe(2);
  });
});

describe("inspect (IMPL §2.2, §2.4)", () => {
  it("prints the summary for a repository and writes nothing to it", async () => {
    const root = join(FIXTURES, "no-claude-md");
    const before = fingerprint(root);
    const result = await run(["inspect", root]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("INSPECT · preview · no session · nothing is sent");
    expect(result.output).toContain(`Repository  ${root}`);
    expect(result.output).toContain("no CLAUDE.md yet");
    expect(fingerprint(root)).toEqual(before);
  });

  it("reads git, and lists what .gitignore ignores", async () => {
    const root = temporaryDirectory();
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), "logs/\n");
    writeFileSync(join(root, "README.md"), "# App\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    mkdirSync(join(root, "logs"));
    writeFileSync(join(root, "logs/app.log"), "x\n");
    const result = await run(["inspect", root]);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/\nGit {9}commit [0-9a-f]{7}, no uncommitted changes\n/);
    expect(result.output).toContain("Ignored by .gitignore: 1 entry   logs/ (not entered)");
  });

  it("writes nothing to a git repository, .git included", async () => {
    const root = temporaryDirectory();
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "README.md"), "# App\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    writeFileSync(join(root, "x.log"), "x\n");
    const before = fingerprint(root);
    expect((await run(["inspect", root, "--list"])).code).toBe(0);
    expect(fingerprint(root)).toEqual(before);
  });

  it("prints a stop as JSON on stdout, with code 1", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "target.md"), "# x\n");
    symlinkSync("target.md", join(root, "CLAUDE.md"));
    const result = await run(["inspect", root, "--json"]);
    expect(result).toMatchObject({ code: 1, stream: "stdout" });
    expect(JSON.parse(result.output)).toMatchObject({ state: "stopped" });
  });

  it.skipIf(process.getuid?.() === 0)(
    "says plainly when the repository can't be read, with the stack only under --debug",
    async () => {
      const root = temporaryDirectory();
      chmodSync(root, 0o000);
      try {
        const result = await run(["inspect", root]);
        expect(result).toEqual({
          code: 1,
          output: `Couldn't read the repository at ${root}.\n`,
          stream: "stderr",
        });
        const debug = await run(["inspect", root, "--debug"]);
        expect(debug.output).toMatch(/^Couldn't read the repository at .*\.\n\n\w*Error: /);
      } finally {
        chmodSync(root, 0o755);
      }
    },
  );

  it("says plainly when the path doesn't exist, without a stack trace", async () => {
    const missing = join(temporaryDirectory(), "nope");
    const result = await run(["inspect", missing]);
    expect(result.code).toBe(1);
    expect(result.output).toBe(`No directory at ${missing}.\n`);
  });

  it("says plainly when the path is a file", async () => {
    const file = join(temporaryDirectory(), "file.txt");
    writeFileSync(file, "x");
    const result = await run(["inspect", file]);
    expect(result).toEqual({
      code: 1,
      output: `${file} is a file, not a directory.\n`,
      stream: "stderr",
    });
  });

  it("adds the stack trace with --debug", async () => {
    const missing = join(temporaryDirectory(), "nope");
    const result = await run(["inspect", missing, "--debug"]);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^No directory at .*\.\n\nError: /);
  });

  it("prints the manifest with --json", async () => {
    const result = await run(["inspect", join(FIXTURES, "nested-packages"), "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ manifestVersion: 1 });
  });
});
