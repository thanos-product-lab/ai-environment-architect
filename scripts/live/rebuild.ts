import {
  type ContextSelectionSettings,
  canonicalJson,
  reduceContext,
  selectContext,
} from "../../src/core/context/select.js";
import type { RecordCallRun } from "../../src/core/run/clarify.js";
import { SessionLog } from "../../src/core/session/log.js";
import type { RecordOf, SessionRecord } from "../../src/core/session/records.js";
import { recordSnapshot } from "../../src/core/session/snapshot.js";
import { captureSnapshot, type SnapshotDeps } from "../../src/core/snapshot/snapshot.js";

// Rebuilding, in a later process, the context call 1 sent (`AnalyseOutcome.sent`), which calls
// 3–5 start from (IMPL §3.2.6). Live-run tooling only: M7's resume specifies its own.
//
// The repository is at its pinned commit and clean, and selection is deterministic (IMPL §1.3),
// so capturing it again under the recorded snapshot's ID and time, selecting with call 1's
// settings and removing what call 1's token check removed gives the same context. It is used
// only if that holds: the snapshot must equal the recorded one, and the context's manifest call
// 1's recorded manifest, `contextHash` included. Otherwise the phase is refused.

export type Rebuilt =
  | { readonly ok: true; readonly run: RecordCallRun }
  | { readonly ok: false; readonly reason: string };

type ModelCall = RecordOf<"model_call">;

/** Call 1's last completed send: the one whose context calls 3–5 start from. */
export function completedCallOne(records: readonly SessionRecord[]): ModelCall | undefined {
  return records
    .filter((r): r is ModelCall => r.type === "model_call")
    .filter((r) => r.purpose === "analyse" && r.state === "completed")
    .at(-1);
}

/** A record without the fields of its place in the log. */
function placeless(record: Record<string, unknown>): string {
  const { seq: _seq, createdAt: _createdAt, ...rest } = record;
  return canonicalJson(rest);
}

export async function rebuildRun(
  records: readonly SessionRecord[],
  deps: Omit<SnapshotDeps, "clock" | "ids">,
): Promise<Rebuilt> {
  const callOne = completedCallOne(records);
  if (callOne === undefined) return { ok: false, reason: "call 1 hasn't completed" };
  const recorded = callOne.inputManifest;
  const snapshotRecord = records.find(
    (r): r is RecordOf<"snapshot"> => r.type === "snapshot" && r.id === recorded.snapshotId,
  );
  if (snapshotRecord === undefined) throw new Error(`no snapshot ${recorded.snapshotId}`);
  const config = records
    .filter((r): r is RecordOf<"generation_config"> => r.type === "generation_config")
    .filter((r) => r.seq < callOne.seq)
    .at(-1);
  if (config === undefined) throw new Error("no generation_config before call 1");
  // As parsed, an absent optional field is typed as possibly undefined.
  const settings = config.settings as ContextSelectionSettings;

  const snapshot = await captureSnapshot(
    {
      ...deps,
      clock: { now: () => new Date(snapshotRecord.capturedAt) },
      ids: { next: () => snapshotRecord.id },
    },
    settings.snapshot,
  );
  const scratch = new SessionLog({
    clock: { now: () => new Date(snapshotRecord.createdAt) },
    ids: { next: (prefix) => `${prefix}_rebuild` },
  });
  const again = recordSnapshot(scratch, snapshot).record;
  if (placeless(again) !== placeless(snapshotRecord))
    return { ok: false, reason: "the repository differs from the snapshot call 1 was sent from" };

  const selected = await selectContext(snapshot, settings, deps.fs);
  if (selected.state !== "ready")
    return { ok: false, reason: `selecting the context again gave ${selected.state}` };
  const removed = new Set(
    (recorded.tokenCheck?.reductions ?? []).flatMap((r) => ("id" in r ? [r.id] : [])),
  );
  const reduced = removed.size === 0 ? selected : reduceContext(selected, removed);
  const sent = { ...reduced, manifest: { ...reduced.manifest, tokenCheck: recorded.tokenCheck } };
  if (
    canonicalJson({ ...sent.manifest, retainedInputRef: null }) !==
    canonicalJson({ ...recorded, retainedInputRef: null })
  )
    return { ok: false, reason: "the context selected again isn't the one call 1 sent" };

  // The known facts call 1 sent, by `findingId`, in alias order (IMPL §3.2.6).
  const byId = new Map(records.map((r) => [r.id, r]));
  const knownFactsSent = callOne.aliases.entries.flatMap((entry) => {
    if (entry.kind !== "F" || entry.target.kind !== "record") return [];
    const finding = byId.get(entry.target.recordId);
    return finding?.type === "finding" && "findingId" in finding ? [finding.findingId] : [];
  });
  const destination =
    snapshot.destination.state === "present" ? snapshot.destination.bytes : undefined;
  return {
    ok: true,
    run: { sent, inspection: { snapshotId: snapshotRecord.id, knownFactsSent }, destination },
  };
}
