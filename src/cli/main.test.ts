import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("CLI placeholder", () => {
  it("prints the package version for --version", () => {
    expect(run(["--version"])).toEqual({ code: 0, output: "0.0.0\n" });
  });

  it("rejects anything else", () => {
    expect(run([]).code).toBe(2);
  });
});
