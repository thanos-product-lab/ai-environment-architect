import { sha256 } from "../hash.js";
import type { RecordOf, SessionRecord } from "./records.js";
import type { HeldSession, RetainedFile } from "./store.js";

// Retained model exchanges (IMPL §4.8, §1.12). With `retainModelInputs` on, the exact request
// body of every call is stored as `inputs/sha256-<hex>.json` and the exact response body as
// `responses/sha256-<hex>.json`, each named by the SHA-256 of its bytes. With it off, both
// references are null. They are for replay only: nothing reads them to build records.
//
// `purge-inputs` saves an `inputs_purged` record first and only then deletes the files, so a
// crash in between leaves a session that loads: load check 7 lets a reference made before a purge
// point at a missing file, and still checks any file that is left.

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

/**
 * `purge-inputs`, for the process holding the lock: appends and saves an `inputs_purged`
 * record, then deletes `inputs/` and `responses/`. Returns the record.
 */
export async function purgeInputs(session: HeldSession): Promise<RecordOf<"inputs_purged">> {
  const record = await session.change((log) => log.append({ type: "inputs_purged" }));
  await session.removeExchanges();
  return record;
}
