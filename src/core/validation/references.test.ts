import { describe, expect, it } from "vitest";
import {
  classifySpan,
  DETECTOR_VERSION,
  detectReferences,
  KNOWN_FILE_EXTENSIONS,
  KNOWN_FILE_NAMES,
  RUNNERS,
} from "./references.js";

// The reference detector (IMPL §3.4).

const ref = (kind: "path" | "command", value: string, match = value) => ({ kind, value, match });
const id = (value: string, match = value) => ({ value, match });

describe("detector version and lists", () => {
  it("is references/1.2.0", () => {
    expect(DETECTOR_VERSION).toBe("references/1.2.0");
  });

  it("has the runners, extensions and file names of §3.4", () => {
    expect(RUNNERS).toEqual([
      "npm",
      "pnpm",
      "yarn",
      "npx",
      "bun",
      "make",
      "just",
      "task",
      "python",
      "pytest",
      "uv",
      "poetry",
      "cargo",
      "go",
      "docker",
    ]);
    expect(KNOWN_FILE_EXTENSIONS).toHaveLength(41);
    expect(KNOWN_FILE_EXTENSIONS).toContain("svelte");
    expect(KNOWN_FILE_NAMES).toEqual([
      "Makefile",
      "makefile",
      "GNUmakefile",
      "Dockerfile",
      "justfile",
      "Justfile",
      "Procfile",
      "Gemfile",
      "LICENSE",
    ]);
  });
});

describe("classifySpan", () => {
  it.each([
    ["npm test", "command"],
    ["pnpm run build --filter x", "command"],
    ["go\ttest ./...", "command"],
    ["make ", "command"],
    ["./scripts/build.sh --fast", "command"],
    ["make", "command"],
    ["go", "command"],
    [" npm test ", "command"],
    ["NPM test", "command"],
    ["Make", "command"],
    ["npm\u00a0test", "command"],
  ])("%j is a command", (span, kind) => {
    expect(classifySpan(span)).toBe(kind);
  });

  it.each([
    ["./scripts/build.sh"],
    ["src/a.ts"],
    ["src/"],
    ["README.md"],
    [".md"],
    ["Makefile"],
    ["python/setup.py"],
    ["go/"],
  ])("%j is a path", (span) => {
    expect(classifySpan(span)).toBe("path");
  });

  it.each([
    ["gofmt -w ."],
    ["gofmt"],
    ["npmx install"],
    ["go.mod"],
    ["python3 -m venv"],
    ["README.MD"],
    ["MAKEFILE"],
    [".gitignore"],
    ["foo."],
    ["https://example.com/a.md"],
    ["http://x/y"],
    [""],
    ["useState"],
    ["./ build"],
  ])("%j is an identifier", (span) => {
    expect(classifySpan(span)).toBe("identifier");
  });
});

describe("detectReferences", () => {
  it("finds inline commands, paths and identifiers in document order", () => {
    expect(detectReferences("Run `npm test` before editing `src/a.ts`, see `useState`.")).toEqual({
      references: [ref("command", "npm test"), ref("path", "src/a.ts")],
      identifiers: [id("useState")],
    });
  });

  it("keeps every occurrence", () => {
    expect(detectReferences("`make` then `make` and src/a.ts and src/a.ts").references).toEqual([
      ref("command", "make"),
      ref("command", "make"),
      ref("path", "src/a.ts"),
      ref("path", "src/a.ts"),
    ]);
  });

  it("pairs backticks from the left, drops empty spans, and a last unpaired backtick is text", () => {
    expect(detectReferences("`` then `make` then `  ` and ` src/a.ts")).toEqual({
      references: [ref("command", "make"), ref("path", "src/a.ts")],
      identifiers: [],
    });
  });

  it("classifies a span trimmed and stores it as written", () => {
    expect(detectReferences("Run ` npm test ` or `make `, see `\u00a0useState\u3000`.")).toEqual({
      references: [ref("command", " npm test ", "npm test"), ref("command", "make ", "make")],
      identifiers: [id("\u00a0useState\u3000", "useState")],
    });
  });

  it("pairs backticks within one block only", () => {
    expect(detectReferences("An unpaired ` here.\n\n- `npm test` runs src/a.ts\n")).toEqual({
      references: [ref("command", "npm test"), ref("path", "src/a.ts")],
      identifiers: [],
    });
  });

  it("pairs a span across the lines of one paragraph", () => {
    expect(detectReferences("Use `npm\ntest` here.").references).toEqual([
      ref("command", "npm\ntest"),
    ]);
  });

  it("finds bare path-like tokens, stripped of punctuation, but not URLs", () => {
    expect(
      detectReferences(
        'See ("docs/guide.md"), src/a.ts. https://example.com/x.md and docs/notes and a.md',
      ).references,
    ).toEqual([ref("path", "docs/guide.md"), ref("path", "src/a.ts"), ref("path", "a.md")]);
  });

  it("doesn't detect a path in inline code again as bare text", () => {
    expect(detectReferences("Edit `src/a.ts` only.").references).toEqual([ref("path", "src/a.ts")]);
  });

  it("classifies fenced lines trimmed, keeping only commands as written", () => {
    const content = "```bash\n  npm test  \ngofmt -w .\n\nsrc/a.ts\n`make`\n```\n";
    expect(detectReferences(content)).toEqual({
      references: [ref("command", "  npm test  ", "npm test")],
      identifiers: [],
    });
  });

  it("handles tilde fences, longer closing fences and unclosed fences", () => {
    expect(detectReferences("~~~\nmake build\n~~~~\n\n```\ncargo test\n").references).toEqual([
      ref("command", "make build"),
      ref("command", "cargo test"),
    ]);
  });

  it("doesn't close a fence with the other character or a shorter run", () => {
    expect(detectReferences("````\n```\n~~~~\nsrc/a.ts\nmake x\n````\n").references).toEqual([
      ref("command", "make x"),
    ]);
  });

  it("treats a fence nested in a list item as a fenced code block", () => {
    const content =
      "- Run:\n\n    ```sh\n    pnpm test\n    docs/guide.md\n    ```\n- Then src/a.ts\n";
    expect(detectReferences(content).references).toEqual([
      ref("command", "  pnpm test", "pnpm test"),
      ref("path", "src/a.ts"),
    ]);
  });

  it("gives nothing for an indented code block", () => {
    expect(detectReferences("Intro.\n\n    npm test\n    src/a.ts\n\nAfter.\n")).toEqual({
      references: [],
      identifiers: [],
    });
  });

  it("finds references in headings and list items", () => {
    expect(detectReferences("## Tests in src/a.ts\n\n1. `pytest -q`\n").references).toEqual([
      ref("path", "src/a.ts"),
      ref("command", "pytest -q"),
    ]);
  });

  it("reads a 4-space fence-like line inside a paragraph as paragraph text", () => {
    // Left pairing (§3.2.3) swallows the path into an identifier, which REF-005 then checks,
    // so nothing escapes validation.
    expect(detectReferences("See this\n    ```\nsrc/a.ts and `npm test`\n")).toEqual({
      references: [ref("command", "npm test`")],
      identifiers: [id("\nsrc/a.ts and ", "src/a.ts and")],
    });
  });

  it("gives nothing for an indented code block nested in a list item", () => {
    expect(detectReferences("- item\n\n      src/a.ts\n      npm test\n").references).toEqual([]);
    expect(detectReferences("-     npm test src/a.ts\n").references).toEqual([]);
  });

  it("gives nothing for a fence indented four spaces at the top level", () => {
    expect(detectReferences("Intro.\n\n    ```\n    npm test\n    ```\n").references).toEqual([]);
    expect(detectReferences("Intro.\n\n\t```\n\tnpm test\n\t```\n").references).toEqual([]);
  });

  it("reads a fenced block inside a block quote", () => {
    expect(detectReferences("> ```\n> npm test\n> ```\n> see src/a.ts\n")).toEqual({
      references: [ref("command", "npm test"), ref("path", "src/a.ts")],
      identifiers: [],
    });
  });

  it("pairs separately in two paragraphs of one list item", () => {
    expect(detectReferences("- Run `npm\n\n  test` now src/a.ts\n")).toEqual({
      references: [ref("path", "src/a.ts")],
      identifiers: [],
    });
  });

  it("reads nested list items", () => {
    expect(
      detectReferences("- a\n  - `make lint`\n    ```\n    cargo test\n    ```\n").references,
    ).toEqual([ref("command", "make lint"), ref("command", "cargo test")]);
  });

  it("strips a $ prompt from fenced lines", () => {
    expect(
      detectReferences("```\n  $ npm test\n$npm x\n$\n$ gofmt -w .\n```\n").references,
    ).toEqual([ref("command", "  $ npm test", "npm test")]);
  });

  it("removes a prompt with all the whitespace after it", () => {
    expect(detectReferences("```\n$  \tnpm test\n```\n").references).toEqual([
      ref("command", "$  \tnpm test", "npm test"),
    ]);
  });

  it("finds plain-text commands to the end of the clause (1.1.0)", () => {
    expect(
      detectReferences(
        "Run npm test before pushing, then pnpm run build; see src/a.ts.\nUse (uv run app) or **cargo test**\nThen docker compose up `x` and python -m app\n",
      ).references,
    ).toEqual([
      ref("command", "npm test before pushing"),
      ref("command", "pnpm run build"),
      ref("path", "src/a.ts"),
      ref("command", "uv run app"),
      ref("command", "cargo test"),
      ref("command", "docker compose up"),
      ref("command", "python -m app"),
    ]);
  });

  it("gives no plain-text command for a runner alone, a prose-only word or a capital", () => {
    expect(
      detectReferences(
        "It uses npm. Run make build, just test, task x and go test.\nPython 3.12 and Npm test. npm\ntest. npmrc x and npm's cache.\n",
      ).references,
    ).toEqual([]);
  });

  it("doesn't read a plain-text command's words again as paths", () => {
    expect(detectReferences("Run npx tsc -p src/a.ts. Then docs/guide.md").references).toEqual([
      ref("command", "npx tsc -p src/a.ts"),
      ref("path", "docs/guide.md"),
    ]);
  });

  it("splits plain text on Unicode whitespace", () => {
    expect(detectReferences("Run\u00a0npm\u3000test, see\u00a0src/a.ts").references).toEqual([
      ref("command", "npm\u3000test"),
      ref("path", "src/a.ts"),
    ]);
  });

  it("reads link targets as paths, without fragments, and URLs as identifiers", () => {
    expect(
      detectReferences(
        'See [the guide](docs/guide.md#setup), ![x](./src/a.ts "t"), [c](CONTRIBUTING), [h](#top), [u](https://x.dev/a.md) and [m](mailto:a@b.c).',
      ),
    ).toEqual({
      references: [
        ref("path", "docs/guide.md#setup", "docs/guide.md"),
        ref("path", "./src/a.ts"),
        ref("path", "CONTRIBUTING"),
      ],
      identifiers: [id("https://x.dev/a.md"), id("mailto:a@b.c")],
    });
  });

  it("reads link text as bare text, with its inline code", () => {
    expect(detectReferences("[`npm test` in src/a.ts](docs/guide.md)")).toEqual({
      references: [
        ref("command", "npm test"),
        ref("path", "src/a.ts"),
        ref("path", "docs/guide.md"),
      ],
      identifiers: [],
    });
  });

  it("ends a plain-text command before a link", () => {
    expect(detectReferences("Run npm test [see](docs/guide.md)").references).toEqual([
      ref("command", "npm test"),
      ref("path", "docs/guide.md"),
    ]);
  });

  it("removes emphasis around a bare path", () => {
    expect(
      detectReferences("See **src/index.ts**, _src/a.ts_ and (**docs/guide.md**). _x/__init__.py")
        .references,
    ).toEqual([
      ref("path", "src/index.ts"),
      ref("path", "src/a.ts"),
      ref("path", "docs/guide.md"),
      ref("path", "_x/__init__.py"),
    ]);
  });

  it("finds root files in plain text by known extension or file name (1.2.0)", () => {
    expect(
      detectReferences(
        "Edit package.json, README.md and **tsconfig.json**; see Makefile and ./Makefile (or CONTRIBUTING.md).",
      ).references,
    ).toEqual([
      ref("path", "package.json"),
      ref("path", "README.md"),
      ref("path", "tsconfig.json"),
      ref("path", "Makefile"),
      ref("path", "./Makefile"),
      ref("path", "CONTRIBUTING.md"),
    ]);
  });

  it("gives no root-file path for a bare extension or a glob, but does for a dotfile (1.2.0)", () => {
    expect(
      detectReferences("Convert .js files to .ts, name tests *.test.ts, and keep .eslintrc.json.")
        .references,
    ).toEqual([ref("path", ".eslintrc.json")]);
  });

  it("gives no root-file path for other extensions, abbreviations or case variants (1.2.0)", () => {
    expect(
      detectReferences(
        "See e.g. notes.xyz, README.MD, MAKEFILE, and/or docs/notes, at https://x.dev/a.md.",
      ).references,
    ).toEqual([]);
  });

  it("finds nothing in empty content", () => {
    expect(detectReferences("")).toEqual({ references: [], identifiers: [] });
  });

  it("keeps a span's line ending as written", () => {
    expect(detectReferences("Use `npm\r\ntest` here.").references).toEqual([
      ref("command", "npm\r\ntest"),
    ]);
  });

  it("handles CRLF content", () => {
    expect(detectReferences("```\r\nnpm test\r\n```\r\nsee src/a.ts\r\n").references).toEqual([
      ref("command", "npm test"),
      ref("path", "src/a.ts"),
    ]);
  });
});
