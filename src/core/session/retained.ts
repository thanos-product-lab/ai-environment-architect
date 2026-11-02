import { sha256 } from "../hash.js";
import type { SessionRecord } from "./records.js";
import type { RetainedFile } from "./store.js";

// Retained model exchanges (IMPL §4.8, §1.12). With `retainModelInputs` on, the exact request
// body of every call is stored as `inputs/sha256-<hex>.json` and the exact response body as
// `responses/sha256-<hex>.json`, each named by the SHA-256 of its bytes. With it off, both
// references are null. They are for replay only: nothing reads them to build records.

export type { RetainedFile } from "./store.js";

export type RetainedKind = "inputs" | "responses";

/** The content-addressed name and bytes of a request or response body. */
export function retainedFile(kind: RetainedKind, bytes: Uint8Array): RetainedFile {
  return { ref: `${kind}/sha256-${sha256(bytes).slice("sha256:".length)}.json`, bytes };
}

/** The reference to record and the file to save, or a null reference with retention off. */
export function retainedExchange(
  retain: boolean,
  kind: RetainedKind,
  bytes: Uint8Array,
): { readonly ref: string | null; readonly file?: RetainedFile } {
  if (!retain) return { ref: null };
  const file = retainedFile(kind, bytes);
  return { ref: file.ref, file };
}

/**
 * The session's `retainModelInputs`, from its latest `generation_config`. A revision changes
 * only the budget (§4.4.1), so every revision agrees.
 */
export function retainsModelInputs(records: readonly SessionRecord[]): boolean {
  const config = records.findLast((r) => r.type === "generation_config");
  if (config === undefined) throw new Error("the session has no generation_config yet");
  return config.retainModelInputs;
}
