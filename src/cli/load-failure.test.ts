import { describe, expect, it } from "vitest";
import { describeLoadFailure } from "./load-failure.js";

// The messages for a session that fails its load checks (IMPL §2.12, §4.9).

describe("load failure messages (IMPL §2.12, §4.9)", () => {
  it("refuses an older format with the §4.9 message", () => {
    const message = describeLoadFailure(
      {
        check: 1,
        name: "format",
        detail: "older",
        version: { direction: "older", sessionFormat: 1, writtenBy: "0.0.3", readerFormat: 2 },
      },
      "aea",
    );
    expect(message).toBe(
      "This session was saved in session format 1 by version 0.0.3. This version reads only " +
        "format 2, and doesn't convert older sessions before v0.1.0. Start a new session with " +
        "`aea init`.",
    );
  });

  it("refuses a newer format with the §4.9 message", () => {
    const message = describeLoadFailure(
      {
        check: 1,
        name: "format",
        detail: "newer",
        version: { direction: "newer", sessionFormat: 2, writtenBy: "0.3.0", readerFormat: 1 },
      },
      "aea",
    );
    expect(message).toBe(
      "This session was saved in session format 2 by version 0.3.0. This CLI reads format 1. " +
        "Update to 0.3.0 or later.",
    );
  });

  it("names an unknown version when the file doesn't say which wrote it", () => {
    const message = describeLoadFailure(
      {
        check: 1,
        name: "format",
        detail: "newer",
        version: { direction: "newer", sessionFormat: 2, writtenBy: undefined, readerFormat: 1 },
      },
      "aea",
    );
    expect(message).toBe(
      "This session was saved in session format 2 by an unknown version. This CLI reads " +
        "format 1. Update to the latest version.",
    );
  });

  it("names the check and the record of any other failure", () => {
    const message = describeLoadFailure(
      {
        check: 4,
        name: "references",
        recordId: "fndr_0001",
        seq: 4,
        detail: "evidenceIds names ev_9999, which isn't in the session",
      },
      "aea",
    );
    expect(message).toBe(
      "This session failed load check 4 (references) at record fndr_0001 (seq 4): " +
        "evidenceIds names ev_9999, which isn't in the session.",
    );
  });
});
