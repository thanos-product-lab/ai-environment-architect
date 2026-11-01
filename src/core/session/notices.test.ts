import { describe, expect, it } from "vitest";
import {
  confirmNotice,
  DATA_NOTICE_VERSION,
  EMPTY_NOTICES,
  needsNotice,
  parseNotices,
  serialiseNotices,
} from "./notices.js";

// The data-notice state (IMPL §4.9 "Data notice", §4.11 "`notices.json` holds one confirmation
// per repository root, and a higher notice version shows the notice again").

const encode = (text: string) => new TextEncoder().encode(text);
const at = new Date(Date.UTC(2026, 10, 1, 10, 15, 0));

describe("data notice state (IMPL §4.9)", () => {
  it("needs the notice for a repository root never confirmed", () => {
    expect(needsNotice(EMPTY_NOTICES, "/r/kutt", DATA_NOTICE_VERSION)).toBe(true);
  });

  it("doesn't need it once confirmed at the current version", () => {
    const state = confirmNotice(EMPTY_NOTICES, "/r/kutt", 1, at);
    expect(needsNotice(state, "/r/kutt", 1)).toBe(false);
  });

  it("needs it again when the notice version increases", () => {
    const state = confirmNotice(EMPTY_NOTICES, "/r/kutt", 1, at);
    expect(needsNotice(state, "/r/kutt", 2)).toBe(true);
  });

  it("keeps one confirmation per repository root, the latest replacing the earlier", () => {
    let state = confirmNotice(EMPTY_NOTICES, "/r/kutt", 1, at);
    state = confirmNotice(state, "/r/ofetch", 1, at);
    state = confirmNotice(state, "/r/kutt", 2, new Date(at.getTime() + 1000));
    expect(state.confirmations).toEqual({
      "/r/kutt": { version: 2, confirmedAt: "2026-11-01T10:15:01.000Z" },
      "/r/ofetch": { version: 1, confirmedAt: "2026-11-01T10:15:00.000Z" },
    });
  });

  it("compares roots bytewise: a differently cased root is a different repository", () => {
    const state = confirmNotice(EMPTY_NOTICES, "/r/Kutt", 1, at);
    expect(needsNotice(state, "/r/kutt", 1)).toBe(true);
  });

  it("doesn't change the state it was given", () => {
    confirmNotice(EMPTY_NOTICES, "/r/kutt", 1, at);
    expect(EMPTY_NOTICES.confirmations).toEqual({});
  });

  it("round-trips through bytes with keys in bytewise order and a final newline", () => {
    let state = confirmNotice(EMPTY_NOTICES, "/r/b", 1, at);
    state = confirmNotice(state, "/r/a", 1, at);
    const text = serialiseNotices(state);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf('"/r/a"')).toBeLessThan(text.indexOf('"/r/b"'));
    expect(parseNotices(encode(text))).toEqual(state);
    expect(serialiseNotices(parseNotices(encode(text)))).toBe(text);
  });

  it("reads a missing file as no confirmations", () => {
    expect(parseNotices(undefined)).toEqual(EMPTY_NOTICES);
  });

  it.each([
    ["truncated JSON", '{"format": "ai-environment-architect/notices", "confir'],
    ["the wrong format", '{"format": "other", "confirmations": {}}'],
    [
      "an unknown field",
      '{"format": "ai-environment-architect/notices", "confirmations": {}, "x": 1}',
    ],
    [
      "a bad confirmation",
      '{"format": "ai-environment-architect/notices", "confirmations": {"/r": {"version": "1"}}}',
    ],
    ["not UTF-8", "ÿ"],
  ])("reads %s as no confirmations, so the notice is shown again", (_name, text) => {
    const bytes = text === "ÿ" ? new Uint8Array([0xff, 0xfe]) : encode(text);
    expect(parseNotices(bytes)).toEqual(EMPTY_NOTICES);
  });
});
