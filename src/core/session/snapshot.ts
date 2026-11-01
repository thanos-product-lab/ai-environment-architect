import type { Snapshot } from "../snapshot/snapshot.js";
import type { SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";

// A snapshot record (IMPL §4.4.1, DM §6.1): immutable, with the snapshot's own ID. The
// destination's bytes are never inlined: they go to `content/`, named by their hash, and the
// record keeps the reference with the parsed Guidance Blocks (§4.3).

export interface RecordedSnapshot {
  readonly record: RecordOf<"snapshot">;
  /** The destination's bytes, for the store to write under `content/`; none if not present. */
  readonly content?: { readonly ref: string; readonly bytes: Uint8Array };
}

export function contentRefOf(hash: `sha256:${string}`): string {
  return `content/sha256-${hash.slice("sha256:".length)}`;
}

export function recordSnapshot(log: SessionLog, snapshot: Snapshot): RecordedSnapshot {
  const { id, destination, ...rest } = snapshot;
  if (destination.state !== "present") {
    const record = log.append({ type: "snapshot", ...rest, destination }, { id });
    return { record };
  }
  const { bytes, ...parsed } = destination;
  const ref = contentRefOf(destination.hash);
  const record = log.append(
    { type: "snapshot", ...rest, destination: { ...parsed, contentRef: ref } },
    { id },
  );
  return { record, content: { ref, bytes } };
}
