import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.js";

/**
 * Every entry under `dir`, recursively, with its type and mode, size, modification and change
 * times, and content hash (or link target). Equal fingerprints mean nothing was written.
 */
export function fingerprint(dir: string, prefix = ""): string[] {
  const lines: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    const content = stat.isFile()
      ? sha256(readFileSync(path))
      : stat.isSymbolicLink()
        ? `-> ${readlinkSync(path)}`
        : "";
    lines.push(
      `${prefix}${name} ${stat.mode} ${stat.size} ${stat.mtimeMs} ${stat.ctimeMs} ${content}`,
    );
    if (stat.isDirectory()) lines.push(...fingerprint(path, `${prefix}${name}/`));
  }
  return lines;
}
