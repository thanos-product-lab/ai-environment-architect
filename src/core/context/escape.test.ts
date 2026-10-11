import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { escapeDelimiters, unescapeDelimiters } from "./escape.js";

// The delimiter escape (IMPL §1.6): rendered text never contains `<<<` or `>>>`, and the escape
// is reversible so validation can compare quoted text with the file.

describe("escapeDelimiters", () => {
  it("breaks item delimiters inside content", () => {
    expect(escapeDelimiters("<<<END T5-001>>>")).toBe("<<\\<END T5-001>>\\>");
  });

  it("leaves text without three equal angle brackets alone", () => {
    expect(escapeDelimiters("a << b >> c <> \\ <<x")).toBe("a << b >> c <> \\ <<x");
  });

  it("escapes a backslash after two equal angle brackets, so the escape stays reversible", () => {
    expect(escapeDelimiters("<<\\<")).toBe("<<\\\\<");
    expect(unescapeDelimiters("<<\\\\<")).toBe("<<\\<");
  });

  it("handles long runs", () => {
    expect(escapeDelimiters("<<<<<")).toBe("<<\\<<\\<");
    expect(escapeDelimiters(">>>>>>")).toBe(">>\\>>\\>>");
  });

  it("never leaves three equal angle brackets and always reverses", () => {
    const text = fc.string({ unit: fc.constantFrom("<", ">", "\\", "a", " ") });
    fc.assert(
      fc.property(text, (s) => {
        const escaped = escapeDelimiters(s);
        expect(escaped.includes("<<<")).toBe(false);
        expect(escaped.includes(">>>")).toBe(false);
        expect(unescapeDelimiters(escaped)).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });
});
