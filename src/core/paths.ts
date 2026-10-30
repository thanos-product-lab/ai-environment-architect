/**
 * Bytewise order of the UTF-8 encodings (IMPL §1.3). Plain string comparison orders by UTF-16
 * code units, which differs for characters outside the Basic Multilingual Plane.
 */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The one normalisation for paths the model writes, in path fields and as tokens in text (IMPL
 * §1.11): one leading `./` and one trailing `/` are removed. A path with a `..` segment is never
 * resolved: it names nothing, so the result is undefined.
 */
export function normalisePath(path: string): string | undefined {
  const relative = path.startsWith("./") ? path.slice(2) : path;
  const trimmed = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  return trimmed.split("/").includes("..") ? undefined : trimmed;
}
