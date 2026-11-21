import { readFileSync } from "node:fs";
import type { CallPurpose } from "../../src/core/validation/aliases.js";

// The append-only release histories (IMPL §3.7): one JSON object per line, never edited or
// removed. CI's append-only check (`scripts/check-append-only.ts`) compares each file with the
// push's previous commit, so a new release is a new line at the end.

export const SCHEMA_HISTORY = new URL("../../src/schemas/history.jsonl", import.meta.url);
export const PROMPT_HISTORY = new URL("../../src/adapters/prompts/history.jsonl", import.meta.url);

/** Each line's object, grouped by its `call`, in file order; any other line shape throws. */
export function readHistory<K extends string>(
  url: URL,
  keys: readonly K[],
): Record<CallPurpose, Record<K, string>[]> {
  const byCall: Partial<Record<CallPurpose, Record<K, string>[]>> = {};
  const text = readFileSync(url, "utf8");
  if (!text.endsWith("\n")) throw new Error(`${url.pathname}: no final line break`);
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== "object" || entry === null) throw new Error(`line ${index + 1}`);
    const { call, note, ...rest } = entry as Record<string, unknown>;
    const fields = Object.keys(rest).sort();
    if (typeof call !== "string" || (note !== undefined && typeof note !== "string"))
      throw new Error(`${url.pathname} line ${index + 1}: call or note`);
    if (
      fields.join() !== [...keys].sort().join() ||
      fields.some((k) => typeof rest[k] !== "string")
    )
      throw new Error(`${url.pathname} line ${index + 1}: expected ${keys.join(", ")}`);
    const list = byCall[call as CallPurpose] ?? [];
    list.push(rest as Record<K, string>);
    byCall[call as CallPurpose] = list;
  }
  return byCall as Record<CallPurpose, Record<K, string>[]>;
}
