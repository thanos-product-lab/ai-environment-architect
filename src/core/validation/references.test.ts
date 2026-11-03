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

describe("detector version and lists", () => {
  it("is references/1.0.0", () => {
    expect(DETECTOR_VERSION).toBe("references/1.0.0");
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
    [" npm test"],
    ["useState"],
    ["./ build"],
  ])("%j is an identifier", (span) => {
    expect(classifySpan(span)).toBe("identifier");
  });
});

describe("detectReferences", () => {
  it("finds inline commands, paths and identifiers in document order", () => {
    expect(detectReferences("Run `npm test` before editing `src/a.ts`, see `useState`.")).toEqual({
      references: [
        { kind: "command", value: "npm test" },
        { kind: "path", value: "src/a.ts" },
      ],
      identifiers: ["useState"],
    });
  });

  it("keeps every occurrence", () => {
    expect(detectReferences("`make` then `make` and src/a.ts and src/a.ts").references).toEqual([
      { kind: "command", value: "make" },
      { kind: "command", value: "make" },
      { kind: "path", value: "src/a.ts" },
      { kind: "path", value: "src/a.ts" },
    ]);
  });

  it("pairs backticks from the left, an empty pair is a span, a last unpaired backtick is text", () => {
    expect(detectReferences("`` then `make` then ` src/a.ts")).toEqual({
      references: [
        { kind: "command", value: "make" },
        { kind: "path", value: "src/a.ts" },
      ],
      identifiers: [""],
    });
  });

  it("pairs backticks within one block only", () => {
    expect(detectReferences("An unpaired ` here.\n\n- `npm test` runs src/a.ts\n")).toEqual({
      references: [
        { kind: "command", value: "npm test" },
        { kind: "path", value: "src/a.ts" },
      ],
      identifiers: [],
    });
  });

  it("pairs a span across the lines of one paragraph", () => {
    expect(detectReferences("Use `npm\ntest` here.").references).toEqual([
      { kind: "command", value: "npm\ntest" },
    ]);
  });

  it("finds bare path-like tokens, stripped of punctuation, but not URLs", () => {
    expect(
      detectReferences(
        'See ("docs/guide.md"), src/a.ts. https://example.com/x.md and docs/notes and a.md',
      ).references,
    ).toEqual([
      { kind: "path", value: "docs/guide.md" },
      { kind: "path", value: "src/a.ts" },
    ]);
  });

  it("doesn't detect a path in inline code again as bare text", () => {
    expect(detectReferences("Edit `src/a.ts` only.").references).toEqual([
      { kind: "path", value: "src/a.ts" },
    ]);
  });

  it("classifies fenced lines, trimmed, keeping only commands", () => {
    const content = "```bash\n  npm test  \ngofmt -w .\n\nsrc/a.ts\n`make`\n```\n";
    expect(detectReferences(content)).toEqual({
      references: [{ kind: "command", value: "npm test" }],
      identifiers: [],
    });
  });

  it("handles tilde fences, longer closing fences and unclosed fences", () => {
    expect(detectReferences("~~~\nmake build\n~~~~\n\n```\ncargo test\n").references).toEqual([
      { kind: "command", value: "make build" },
      { kind: "command", value: "cargo test" },
    ]);
  });

  it("doesn't close a fence with the other character or a shorter run", () => {
    expect(detectReferences("````\n```\n~~~~\nsrc/a.ts\nmake x\n````\n").references).toEqual([
      { kind: "command", value: "make x" },
    ]);
  });

  it("treats a fence nested in a list item as a fenced code block", () => {
    const content =
      "- Run:\n\n    ```sh\n    pnpm test\n    docs/guide.md\n    ```\n- Then src/a.ts\n";
    expect(detectReferences(content).references).toEqual([
      { kind: "command", value: "pnpm test" },
      { kind: "path", value: "src/a.ts" },
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
      { kind: "path", value: "src/a.ts" },
      { kind: "command", value: "pytest -q" },
    ]);
  });

  it("reads a 4-space fence-like line inside a paragraph as paragraph text", () => {
    // Left pairing (§3.2.3) swallows the path into an identifier, which REF-005 then checks,
    // so nothing escapes validation.
    expect(detectReferences("See this\n    ```\nsrc/a.ts and `npm test`\n")).toEqual({
      references: [],
      identifiers: ["", "\nsrc/a.ts and "],
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
      references: [
        { kind: "command", value: "npm test" },
        { kind: "path", value: "src/a.ts" },
      ],
      identifiers: [],
    });
  });

  it("pairs separately in two paragraphs of one list item", () => {
    expect(detectReferences("- Run `npm\n\n  test` now src/a.ts\n")).toEqual({
      references: [{ kind: "path", value: "src/a.ts" }],
      identifiers: [],
    });
  });

  it("reads nested list items", () => {
    expect(
      detectReferences("- a\n  - `make lint`\n    ```\n    cargo test\n    ```\n").references,
    ).toEqual([
      { kind: "command", value: "make lint" },
      { kind: "command", value: "cargo test" },
    ]);
  });

  it("finds nothing in empty content", () => {
    expect(detectReferences("")).toEqual({ references: [], identifiers: [] });
  });

  it("keeps a span's line ending as written", () => {
    expect(detectReferences("Use `npm\r\ntest` here.").references).toEqual([
      { kind: "command", value: "npm\r\ntest" },
    ]);
  });

  it("handles CRLF content", () => {
    expect(detectReferences("```\r\nnpm test\r\n```\r\nsee src/a.ts\r\n").references).toEqual([
      { kind: "command", value: "npm test" },
      { kind: "path", value: "src/a.ts" },
    ]);
  });
});
