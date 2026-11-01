import { comparePaths } from "../paths.js";
import type { SessionFile } from "./records.js";

// The session file's bytes (IMPL §4.3): UTF-8 JSON with object keys sorted bytewise, never by
// locale, two-space indentation, LF line endings and a final newline. Array order is kept. So
// the same records always give the same bytes.

export function serialiseSession(file: SessionFile): string {
  return `${pretty(file, "")}\n`;
}

/** Pretty JSON with keys in bytewise order at every level; undefined properties are dropped. */
export function pretty(value: unknown, indent: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a session holds only finite numbers");
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${pretty(item === undefined ? null : item, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => comparePaths(a, b));
    if (entries.length === 0) return "{}";
    const fields = entries.map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${pretty(item, inner)}`,
    );
    return `{\n${fields.join(",\n")}\n${indent}}`;
  }
  throw new Error(`a session can't hold a ${typeof value}`);
}
