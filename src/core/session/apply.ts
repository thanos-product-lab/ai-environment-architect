import { type Hash, sha256 } from "../hash.js";
import type { Clock } from "../ports.js";
import { DESTINATION_PATH } from "../snapshot/snapshot.js";
import { currentState } from "./current.js";
import { checkFreshness, type Rescan } from "./freshness.js";
import type { ContentReader } from "./load.js";
import { type Changes, isFailed, type Revised, type SessionLog } from "./log.js";
import type { RecordOf, SessionRecord } from "./records.js";
import type { HeldSession } from "./store.js";

// Apply and recovery (DM §11.2). The only write to the target repository.
//
// 1. The destination must be the root `CLAUDE.md` as a regular file, or absent. The adapter
//    resolves it inside the root and never follows a symbolic link.
// 2. A usable approval (DM §10).
// 3. Freshness (DM §11.1) on a new rescan. Blocked: one `blocked` attempt, nothing written.
//    Warned: nothing happens until the developer acknowledges exactly the listed paths.
// 4. `started` is saved before anything touches the repository.
// 5. The approved bytes go to a temporary file beside the destination, named after the attempt.
//    The destination is checked again, then the file is renamed over it.
// 6. The destination is hashed: `succeeded` with that hash, or `failed` with the reason.
//
// The lock keeps out other instances of this CLI, not other editors, hence the re-check in step
// 5. A crash leaves `started`; recovery decides from what the destination holds now.
//
// The adapter reports write failures as results. An exception from it, or a failed save, is a
// stop: the attempt stays `started` for recovery.

/** The destination as found, never following a symbolic link. */
export type DestinationState =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly hash: Hash }
  /** A symbolic link, a directory or anything else that isn't a regular file, or unreadable. */
  | { readonly state: "unavailable"; readonly reason: string };

export type WriteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "exists" | "permission_denied" | "no_space" | "io_error";
    };

/**
 * The root `CLAUDE.md` and its directory, resolved inside the repository root by the adapter
 * (`src/adapters/fs/`). Temporary names are single path segments in the destination's directory.
 */
export interface DestinationFs {
  inspect(): Promise<DestinationState>;
  /** Creates `name` exclusively with `bytes`, and syncs it. */
  writeTemporary(name: string, bytes: Uint8Array): Promise<WriteResult>;
  /** Renames `name` over the destination, or to it when absent, and syncs the directory. */
  replace(name: string): Promise<WriteResult>;
  /** Removes `name` if it is there. */
  remove(name: string): Promise<WriteResult>;
}

export interface ApplyDeps {
  readonly destination: DestinationFs;
  /** A capture with the active snapshot's settings (DM §11.1). */
  readonly rescan: () => Promise<Rescan>;
  /** The session directory, for the approved bytes. */
  readonly content: ContentReader;
  readonly clock: Clock;
}

export interface ApplyRequest {
  /** The changed paths the developer acknowledged, exactly as a warning listed them (IMPL §2.9). */
  readonly acknowledged?: readonly string[];
}

type Attempt = RecordOf<"apply_attempt">;

export type ApplyOutcome =
  | {
      readonly kind: "refused";
      readonly reason: "destination_unsafe";
      readonly destination: DestinationState;
    }
  /** No usable approval (DM §10), or an earlier attempt is still `started` and needs recovery. */
  | { readonly kind: "refused"; readonly reason: "no_usable_approval" | "interrupted_attempt" }
  /** Some files changed that support nothing; the developer acknowledges them, or refreshes. */
  | { readonly kind: "needs_acknowledgement"; readonly changedPaths: readonly string[] }
  | { readonly kind: "blocked"; readonly attempt: Attempt }
  | { readonly kind: "succeeded"; readonly attempt: Attempt }
  | {
      readonly kind: "failed";
      readonly attempt: Attempt;
      /** The temporary file, when it couldn't be removed and is still in the repository. */
      readonly temporaryFileLeft?: string;
    };

/** The temporary file beside the destination, named after the attempt so recovery can find it. */
export function temporaryName(applyAttemptId: string): string {
  return `.${DESTINATION_PATH}.${applyAttemptId}.tmp`;
}

export async function applyArtifact(
  session: HeldSession,
  deps: ApplyDeps,
  request: ApplyRequest = {},
): Promise<ApplyOutcome> {
  const { destination } = deps;

  // Step 1.
  const found = await destination.inspect();
  if (found.state === "unavailable")
    return { kind: "refused", reason: "destination_unsafe", destination: found };

  if (latestAttempts(session.records).some((a) => a.state === "started"))
    return { kind: "refused", reason: "interrupted_attempt" };

  // Step 2.
  const { activeArtifact: artifact, usableApproval: review } = currentState(session.records);
  if (artifact === undefined || review === undefined)
    return { kind: "refused", reason: "no_usable_approval" };
  const bytes = await deps.content.read(artifact.proposedContent);
  if (bytes === undefined || sha256(bytes) !== artifact.proposedHash)
    throw new Error(`${artifact.proposedContent} doesn't match ${artifact.id}'s proposedHash`);

  // Step 3.
  const freshness = checkFreshness(session.records, artifact, await deps.rescan());
  const fields = {
    type: "apply_attempt",
    artifactRevisionId: artifact.id,
    reviewId: review.id,
    expectedOriginal: artifact.original,
    intendedHash: artifact.proposedHash,
  } as const;
  if (freshness.state === "blocked") {
    const now = deps.clock.now().toISOString();
    const attempt = await session.change((log) =>
      log.start({
        ...fields,
        freshness,
        state: "blocked",
        startedAt: now,
        endedAt: { state: "known", value: now },
      }),
    );
    return { kind: "blocked", attempt };
  }
  if (freshness.state === "warn" && !samePaths(freshness.changedPaths, request.acknowledged))
    return { kind: "needs_acknowledgement", changedPaths: freshness.changedPaths };

  // Step 4.
  const started = await session.change((log) =>
    log.start({
      ...fields,
      freshness:
        freshness.state === "warn"
          ? { state: "acknowledged", changedPaths: freshness.changedPaths }
          : { state: "fresh" },
      state: "started",
      startedAt: deps.clock.now().toISOString(),
    }),
  );
  const { applyAttemptId } = started;
  const name = temporaryName(applyAttemptId);
  const end = async (
    changes: Changes<"apply_attempt">,
    cleanup: "remove" | "keep" = "keep",
  ): Promise<ApplyOutcome> => {
    const removed = cleanup === "remove" ? await destination.remove(name) : { ok: true };
    const attempt = await session.change((log) =>
      log.revise("apply_attempt", applyAttemptId, {
        ...changes,
        endedAt: { state: "known", value: deps.clock.now().toISOString() },
      }),
    );
    if (attempt.state === "succeeded") return { kind: "succeeded", attempt };
    return removed.ok
      ? { kind: "failed", attempt }
      : { kind: "failed", attempt, temporaryFileLeft: name };
  };

  // Step 5. A file already at the temporary name isn't this attempt's, so it is left alone.
  const written = await destination.writeTemporary(name, bytes);
  if (!written.ok)
    return end(
      { state: "failed", error: { reason: "write_failed", detail: written.reason } },
      written.reason === "exists" ? "keep" : "remove",
    );
  const before = await destination.inspect();
  if (observed(before) !== artifact.original)
    return end(
      { state: "failed", error: { reason: "destination_changed", destination: observed(before) } },
      "remove",
    );
  const replaced = await destination.replace(name);
  if (!replaced.ok)
    return end(
      { state: "failed", error: { reason: "write_failed", detail: replaced.reason } },
      "remove",
    );

  // Step 6.
  const after = await destination.inspect();
  if (after.state === "present" && after.hash === artifact.proposedHash)
    return end({ state: "succeeded", resultHash: after.hash });
  return end({
    state: "failed",
    error: { reason: "result_mismatch", destination: observed(after) },
  });
}

const INTERRUPTED = { state: "unknown", reason: "interrupted" } as const;

/**
 * The recovery table of DM §11.2 for every attempt still `started`, given what the destination
 * holds now. Pure: the caller reads the destination and removes temporary files. Returns the
 * records appended.
 */
export function recoverApply(log: SessionLog, destination: DestinationState): readonly Attempt[] {
  const now = observed(destination);
  return latestAttempts(log.records)
    .filter((a) => a.state === "started")
    .map((a) => {
      // The write happened.
      if (now === a.intendedHash)
        return log.revise("apply_attempt", a.applyAttemptId, {
          state: "succeeded",
          resultHash: a.intendedHash,
          endedAt: INTERRUPTED,
        });
      // It didn't; a retry is a new attempt, which checks approval and freshness again.
      if (now === a.expectedOriginal)
        return log.revise("apply_attempt", a.applyAttemptId, {
          state: "failed",
          error: { reason: "interrupted_before_write" },
          endedAt: INTERRUPTED,
        });
      return log.revise("apply_attempt", a.applyAttemptId, {
        state: "recovery_required",
        error: { reason: "destination_conflict", destination: now },
        endedAt: INTERRUPTED,
      });
    });
}

export interface Recovery {
  /** The revisions recovery appended. */
  readonly attempts: readonly Attempt[];
  /** Temporary files that couldn't be removed and are still in the repository. */
  readonly temporaryFilesLeft: readonly string[];
}

/**
 * Apply recovery on resume, by the process holding the lock, before the other interrupted-work
 * rules (IMPL §4.9). Removes each started attempt's temporary file, then records the outcome.
 */
export async function recoverInterruptedApply(
  session: HeldSession,
  destination: DestinationFs,
): Promise<Recovery> {
  const started = latestAttempts(session.records).filter((a) => a.state === "started");
  if (started.length === 0) return { attempts: [], temporaryFilesLeft: [] };
  const temporaryFilesLeft: string[] = [];
  for (const attempt of started) {
    const name = temporaryName(attempt.applyAttemptId);
    if (!(await destination.remove(name)).ok) temporaryFilesLeft.push(name);
  }
  const found = await destination.inspect();
  const attempts = await session.change((log) => recoverApply(log, found));
  return { attempts, temporaryFilesLeft };
}

/** The latest revision of each attempt, in the order the attempts started. */
function latestAttempts(records: readonly SessionRecord[]): Revised<"apply_attempt">[] {
  const latest = new Map<string, Revised<"apply_attempt">>();
  for (const r of records)
    if (r.type === "apply_attempt" && !isFailed(r)) latest.set(r.applyAttemptId, r);
  return [...latest.values()];
}

function observed(state: DestinationState): Hash | "absent" | "unavailable" {
  return state.state === "present" ? state.hash : state.state;
}

function samePaths(listed: readonly string[], acknowledged: readonly string[] | undefined) {
  return (
    acknowledged !== undefined &&
    acknowledged.length === listed.length &&
    acknowledged.every((path, i) => path === listed[i])
  );
}
