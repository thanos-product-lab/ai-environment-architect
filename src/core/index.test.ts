import { describe, expect, it } from "vitest";
import { area } from "./index.js";

describe("core placeholder", () => {
  it("is wired into the test runner", () => {
    expect(area).toBe("core");
  });
});
