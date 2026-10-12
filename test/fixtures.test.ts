import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanText } from "../src/core/context/secrets.js";

// Guards the fixtures' exact bytes against accidental normalisation by an editor or Git.
const read = (path: string): Buffer => readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
const isUtf8 = (bytes: Buffer): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const lfOnly = [
  "destinations/bom.md",
  "destinations/fenced-hash-lines.md",
  "destinations/front-matter.md",
  "destinations/html-comments.md",
  "destinations/nested-lists.md",
  "destinations/no-trailing-newline.md",
  "destinations/setext-headings.md",
  "destinations/trailing-whitespace.md",
  "destinations/unclosed-fence.md",
  "repos/unusual-markdown/CLAUDE.md",
];

describe("fixture bytes", () => {
  it("crlf.md uses CRLF on every line", () => {
    const text = read("destinations/crlf.md").toString("latin1");
    expect(text).toContain("\r\n");
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  it.each(lfOnly)("%s uses LF only", (path) => {
    expect(read(path).includes(0x0d)).toBe(false);
  });

  it("mixed-line-endings.md has LF, CRLF and a lone CR", () => {
    const text = read("destinations/mixed-line-endings.md").toString("latin1");
    expect(text).toContain("\r\n");
    expect(text).toMatch(/[^\r]\n/);
    expect(text).toMatch(/\r[^\n]/);
  });

  it("bom-crlf.md starts with a BOM and uses CRLF", () => {
    const bytes = read("destinations/bom-crlf.md");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("latin1").replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  it("unclosed-fence.md opens a fence it never closes", () => {
    const fences = read("destinations/unclosed-fence.md").toString("utf8").match(/^```/gm);
    expect(fences).toHaveLength(1);
  });

  it("bom.md starts with a UTF-8 byte order mark", () => {
    expect([...read("destinations/bom.md").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("no-trailing-newline.md does not end with a newline", () => {
    expect(read("destinations/no-trailing-newline.md").at(-1)).not.toBe(0x0a);
  });

  it("trailing-whitespace.md keeps trailing spaces, a tab and a whitespace-only line", () => {
    const text = read("destinations/trailing-whitespace.md").toString("utf8");
    expect(text).toContain("  \n");
    expect(text).toContain("\t\n");
    expect(text).toContain("\n   \n");
  });

  it("the empty CLAUDE.md is zero bytes", () => {
    expect(read("repos/empty-claude-md/CLAUDE.md").length).toBe(0);
  });

  it("the size boundary files sit either side of maxReadableFileBytes", () => {
    expect(read("repos/large-and-binary/data/at-limit.txt").length).toBe(262_144);
    expect(read("repos/large-and-binary/data/over-limit.txt").length).toBe(262_145);
  });

  it("has-nul.txt is valid UTF-8 with a NUL byte, and latin1.txt is invalid UTF-8 without one", () => {
    const nul = read("repos/large-and-binary/data/has-nul.txt");
    expect(nul.includes(0)).toBe(true);
    expect(isUtf8(nul)).toBe(true);
    const latin1 = read("repos/large-and-binary/data/latin1.txt");
    expect(latin1.includes(0)).toBe(false);
    expect(isUtf8(latin1)).toBe(false);
  });
});

describe("committed fixtures", () => {
  // Fixtures must not look like real credentials: push protection may block the push, and
  // scanners would flag the repository. Tests build matching values from fragments (IMPL §1.7).
  const root = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    );

  it("match no secret-scan rule", () => {
    const matches = files(root)
      .map((path) => ({ path: relative(root, path), rule: scanText(readFileSync(path, "latin1")) }))
      .filter((match) => match.rule !== undefined);
    expect(matches).toEqual([]);
  });
});
