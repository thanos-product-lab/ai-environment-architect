/**
 * Bytewise order of the UTF-8 encodings (IMPL §1.3). Plain string comparison orders by UTF-16
 * code units, which differs for characters outside the Basic Multilingual Plane.
 */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
