// The workspace pattern grammar (IMPL §1.5), shared by workspace members and the coverage checks
// of §1.11: `*` matches within one path segment, `**` matches zero or more whole segments.
// Everything else matches itself, case-sensitively.
//
// Patterns can come from model output (§1.11), so matching is a table over segment positions,
// quadratic at worst, never a backtracking search that a run of `**` could make exponential.

/** Whether the pattern's segments match the path's segments. */
export function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  // rest[j]: pattern[i..] matches path[j..], for the current i, filled from the end.
  let rest = path.map(() => false).concat(true);
  for (let i = pattern.length - 1; i >= 0; i--) {
    const head = pattern[i] ?? "";
    const next: boolean[] = new Array(path.length + 1).fill(false);
    for (let j = path.length; j >= 0; j--) {
      if (head === "**")
        next[j] = (rest[j] ?? false) || (j < path.length && (next[j + 1] ?? false));
      else
        next[j] = j < path.length && segmentMatches(head, path[j] ?? "") && (rest[j + 1] ?? false);
    }
    rest = next;
  }
  return rest[0] ?? false;
}

/**
 * Whether some path below `directory` could match the pattern: the directory's segments match the
 * pattern's leading segments, where `**` may absorb any number of them, and at least one pattern
 * segment is left over, or the pattern ends in `**` (IMPL §1.11).
 */
export function couldMatchBelow(pattern: readonly string[], directory: readonly string[]): boolean {
  // rest[j]: pattern[i..] could match below directory[j..], for the current i.
  let rest = directory.map(() => false).concat(false);
  for (let i = pattern.length - 1; i >= 0; i--) {
    const head = pattern[i] ?? "";
    const next: boolean[] = new Array(directory.length + 1).fill(false);
    for (let j = directory.length; j >= 0; j--) {
      if (j === directory.length) next[j] = true;
      else if (head === "**") next[j] = (rest[j] ?? false) || (next[j + 1] ?? false);
      else next[j] = segmentMatches(head, directory[j] ?? "") && (rest[j + 1] ?? false);
    }
    rest = next;
  }
  return rest[0] ?? false;
}

export function segmentMatches(pattern: string, segment: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === segment;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!segment.startsWith(first) || segment.length < first.length + last.length) return false;
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = segment.indexOf(part, position);
    if (found === -1 || found + part.length > segment.length - last.length) return false;
    position = found + part.length;
  }
  return segment.endsWith(last);
}
