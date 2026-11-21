import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_HISTORY, SCHEMA_HISTORY } from "./support/history.js";

// CI's append-only check (IMPL §3.7), run as CI runs it, in a scratch git repository: a history
// may gain lines at its end, and fails when a line changed or was removed, or the file was.

const SCRIPT = fileURLToPath(new URL("../scripts/check-append-only.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCHEMAS = fileURLToPath(SCHEMA_HISTORY).slice(ROOT.length);
const PROMPTS = fileURLToPath(PROMPT_HISTORY).slice(ROOT.length);
let repo: string | undefined;

function git(...args: string[]): string {
  if (repo === undefined) throw new Error("no scratch repository");
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: repo, encoding: "utf8" },
  ).trim();
}

function write(path: string, text: string): void {
  if (repo === undefined) throw new Error("no scratch repository");
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function commit(): string {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "c");
  return git("rev-parse", "HEAD");
}

function check(base: string) {
  const result = spawnSync(process.execPath, [SCRIPT, base], { cwd: repo, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

function start(): string {
  repo = mkdtempSync(join(tmpdir(), "append-only-"));
  git("init", "-q");
  write(SCHEMAS, '{"v":1}\n{"v":2}\n');
  write(PROMPTS, '{"v":1}\n');
  return commit();
}

afterEach(() => {
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

const inRepo = (path: string) => {
  if (repo === undefined) throw new Error("no scratch repository");
  return join(repo, path);
};

describe("the append-only history check (IMPL §3.7)", () => {
  it("checks exactly the history files the tests read", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const list = /HISTORY_FILES = \[([^\]]*)\]/.exec(script)?.[1] ?? "";
    expect([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([SCHEMAS, PROMPTS]);
  });

  it("passes when lines are only appended, or a file is new", () => {
    const base = start();
    write(SCHEMAS, '{"v":1}\n{"v":2}\n{"v":3}\n');
    commit();
    expect(check(base).code).toBe(0);

    rmSync(inRepo(PROMPTS));
    const empty = commit();
    write(PROMPTS, '{"v":1}\n');
    commit();
    expect(check(empty).code).toBe(0);
  });

  it("fails when an existing line changed, naming it", () => {
    const base = start();
    write(SCHEMAS, '{"v":1}\n{"v":"edited"}\n{"v":3}\n');
    commit();
    expect(check(base)).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${SCHEMAS}:2: changed`),
    });
  });

  it("fails when a line was removed, or the file was", () => {
    const base = start();
    write(SCHEMAS, '{"v":1}\n');
    rmSync(inRepo(PROMPTS));
    commit();
    const { code, stderr } = check(base);
    expect(code).toBe(1);
    expect(stderr).toContain(`${SCHEMAS}:2: removed`);
    expect(stderr).toContain(`${PROMPTS}: removed`);
  });

  it("refuses a base commit it can't find, rather than passing", () => {
    start();
    expect(check("0000000000000000000000000000000000000000").code).toBe(2);
  });
});
