import { describe, expect, it } from "vitest";
import { hashOf, newLog } from "../../../test/support/session.js";
import {
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  sessionFile,
} from "./records.js";
import { pretty, serialiseSession } from "./serialise.js";

// The session file's bytes (IMPL §4.3, §4.11 "keys are in bytewise order").

function file(): SessionFile {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:02.000Z",
      scope: { roots: ["."] },
      exclusions: [
        { pattern: ".git", source: "default", group: "version_control", ignoreCase: false },
      ],
      files: [{ path: "CLAUDE.md", status: "read", size: 12, hash: hashOf("c") }],
      destination: {
        state: "present",
        contentRef: `content/sha256-${"c".repeat(64)}`,
        hash: hashOf("c"),
        blocks: [
          {
            blockId: "paragraph-1",
            type: "paragraph",
            headingPath: [],
            sourceSpan: { start: 0, end: 11 },
            hash: hashOf("d"),
          },
        ],
        lineEndings: { style: "lf", counts: { lf: 1, crlf: 0, cr: 0 } },
        roundTrip: { state: "verified" },
      },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "git_missing" },
      ignoreRules: { state: "not_applied", reason: "git_missing" },
    },
    { id: "snap_0001" },
  );
  return {
    format: SESSION_FORMAT,
    schemaVersion: SESSION_SCHEMA_VERSION,
    writtenBy: "0.1.0",
    session: {
      id: "ses_0001",
      createdAt: "2026-11-01T10:15:00.000Z",
      productVersion: "0.1.0",
      adapter: "claude-code",
      outputScope: ["root CLAUDE.md"],
      repository: { name: "kutt", root: "/Users/dev/kutt" },
      targetPath: "CLAUDE.md",
    },
    records: [...log.records],
  };
}

describe("session file bytes (IMPL §4.3)", () => {
  it("sorts keys bytewise at every level, indents by two spaces and ends with one LF", () => {
    const text = serialiseSession(file());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text.split("\n").slice(0, 3)).toEqual([
      "{",
      '  "format": "ai-environment-architect/session",',
      '  "records": [',
    ]);
    expect(text).toContain(
      '      "createdAt": "2026-11-01T10:15:00.000Z",\n      "id": "st_0001",',
    );
  });

  it("orders keys by UTF-8 bytes, not UTF-16 code units or locale", () => {
    // U+FFFF is EF BF BF in UTF-8 and sorts before U+1F600 (F0 …), though its UTF-16 unit is higher.
    expect(pretty({ "\u{1F600}": 1, "￿": 2, B: 3, a: 4 }, "")).toBe(
      '{\n  "B": 3,\n  "a": 4,\n  "￿": 2,\n  "\u{1F600}": 1\n}',
    );
  });

  it("keeps array order and drops undefined properties", () => {
    expect(pretty({ list: [3, 1, 2], gone: undefined, empty: [], none: {} }, "")).toBe(
      '{\n  "empty": [],\n  "list": [\n    3,\n    1,\n    2\n  ],\n  "none": {}\n}',
    );
  });

  it("round-trips: the parsed file gives the same records and the same bytes", () => {
    const original = file();
    const text = serialiseSession(original);
    const parsed = sessionFile.parse(JSON.parse(text));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(original)));
    expect(serialiseSession(parsed)).toBe(text);
  });

  it("the same records give the same bytes whatever order their keys were built in", () => {
    const a = file();
    const b = JSON.parse(JSON.stringify(a), (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    );
    expect(serialiseSession(b)).toBe(serialiseSession(a));
  });

  it("refuses a value JSON can't hold exactly", () => {
    expect(() => pretty({ n: Number.NaN }, "")).toThrow(/finite/);
  });
});
