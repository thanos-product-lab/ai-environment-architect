import { createHash } from "node:crypto";

/** A SHA-256 over exact bytes, written as `sha256:<hex>`. */
export type Hash = `sha256:${string}`;

export function sha256(bytes: Uint8Array): Hash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
