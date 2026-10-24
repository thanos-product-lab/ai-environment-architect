import type { z } from "zod";
import { accept, type ItemCheck, reject } from "./pipeline.js";

// LIMIT-001 (IMPL §3.5): an item's own lengths and sizes, which the API can't enforce during
// generation. The item is rejected alone; the detail names the field and the limit, never the
// value.

export function limitCheck<C>(schema: z.ZodType): ItemCheck<unknown, C> {
  return (item) => {
    const result = schema.safeParse(item);
    if (result.success) return accept(item);
    const issue = result.error.issues[0];
    return reject("LIMIT-001", issue === undefined ? "limit exceeded" : describeIssue(issue));
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path.map((segment) => String(segment)).join(".");
  const field = at === "" ? "(item)" : at;
  if (issue.code === "too_big") return `${field}: at most ${String(issue.maximum)} items`;
  if (issue.code === "too_small") return `${field}: at least ${String(issue.minimum)} items`;
  if (issue.code === "custom") {
    const maximum = (issue.params as { maximum?: unknown } | undefined)?.maximum;
    if (typeof maximum === "number") return `${field}: at most ${maximum} characters`;
  }
  return `${field}: ${issue.code}`;
}
