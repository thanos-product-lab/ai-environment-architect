import { type AssemblyFailure, assemble } from "../assembly/assemble.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { assemblyRevisionsOf, decisionIdsOf } from "./artifact-input.js";
import { type Clash, currentState } from "./current.js";
import { activeDestination } from "./exclusion.js";
import type { SessionLog } from "./log.js";
import type { RecordOf } from "./records.js";
import { affectedRecommendations } from "./regeneration.js";
import { contentRefOf } from "./store.js";

// Artifact revisions and reviews (DM §9.4, §10; IMPL §4.4.2 "Active artifact revision",
// "Usable approval").
//
// - An artifact revision is the current accepted revisions assembled into the active snapshot's
//   destination, with targets resolved there. It is created only when assembly passes.
// - Assembly is never given a clashing set (DM §9.2), and nothing is created when nothing is
//   accepted, so the session can end as `no_change`.
// - A review records the exact content hash the developer was shown. An approval is usable only
//   as the latest review of the active artifact revision, so it never transfers to a new one.

type Artifact = RecordOf<"artifact_revision">;

export type ProposeOutcome =
  /** Appended. The caller saves `content` as the content file `proposedContent` names. */
  | { readonly kind: "created"; readonly artifact: Artifact; readonly content: Uint8Array }
  /** Nothing changed since the active artifact revision, so nothing was written. */
  | { readonly kind: "active"; readonly artifact: Artifact }
  /** No recommendation is accepted: no artifact revision, and the session can be `no_change`. */
  | { readonly kind: "nothing_accepted" }
  /** Accepted recommendations exclude each other; the developer rejects one (DM §9.2). */
  | { readonly kind: "clash"; readonly clashes: readonly Clash[] }
  /**
   * Accepted recommendations whose support is no longer current, left so by a regeneration that
   * failed or hasn't run (DM §12). The developer rejects them, or regenerates, and proposes again.
   */
  | { readonly kind: "stale"; readonly recommendationIds: readonly string[] }
  /** A conflict the developer resolves by rejecting one, or an internal error (DM §9.4). */
  | { readonly kind: "assembly_failed"; readonly failure: AssemblyFailure };

/**
 * Assembles the current accepted revisions into a new artifact revision, unless the active one
 * already records them. `destinationBytes` are the bytes the caller read for the active
 * snapshot's destination, checked against its hash, or undefined when it isn't present.
 *
 * An accepted revision whose support is no longer current is refused as `stale`, by name. One
 * whose target resolves to nothing is a bug in the caller: after a refresh, code invalidates it
 * as `target_changed` first (DM §12).
 */
export function proposeArtifact(
  log: SessionLog,
  destinationBytes: Uint8Array | undefined,
): ProposeOutcome {
  const snapshot = log.records.filter((r) => r.type === "snapshot").at(-1);
  if (snapshot === undefined) throw new Error("the session has no snapshot");
  const { destination } = snapshot;
  if (destination.state === "unavailable")
    throw new Error(`the destination is unavailable (${destination.reason})`);
  const { bytes } = activeDestination(log.records, destinationBytes);

  const state = currentState(log.records, { destination: destinationBytes });
  const accepted = [...state.recommendations.values()].filter(
    (r) => state.selections.get(r.recommendationId)?.state === "accepted",
  );
  if (accepted.length === 0) return { kind: "nothing_accepted" };
  const acceptedIds = new Set(accepted.map((r) => r.recommendationId));
  const stale = affectedRecommendations(log.records, []).filter((id) => acceptedIds.has(id));
  if (stale.length > 0) return { kind: "stale", recommendationIds: stale };
  const clashes = state.clashes ?? [];
  if (clashes.length > 0) return { kind: "clash", clashes };
  if (state.activeArtifact !== undefined) return { kind: "active", artifact: state.activeArtifact };

  const decisionIds = decisionIdsOf(accepted);

  const blocks = destination.state === "present" ? parseGuidanceBlocks(bytes) : undefined;
  const input = assemblyRevisionsOf(log.records, accepted, blocks?.blocks ?? []);
  if ("unresolved" in input)
    throw new Error(
      `${input.unresolved}: its target resolves to no block; invalidate it as target_changed first`,
    );
  const result = assemble(
    blocks === undefined ? { state: "absent" } : { state: "present", bytes, parsed: blocks },
    input.revisions,
  );
  if (!result.ok) return { kind: "assembly_failed", failure: result.failure };

  const artifact = log.append({
    type: "artifact_revision",
    revision: log.records.filter((r) => r.type === "artifact_revision").length + 1,
    snapshotId: snapshot.id,
    targetPath: "CLAUDE.md",
    original: destination.state === "present" ? destination.hash : "absent",
    proposedContent: contentRefOf(result.content),
    proposedHash: result.hash,
    selectedRevisionIds: accepted.map((r) => r.id),
    decisionIds,
    attribution: result.attribution.map((entry) => ({ ...entry })),
  });
  return { kind: "created", artifact, content: result.content };
}

export interface ReviewRequest {
  readonly artifactRevisionId: string;
  /** The hash of the content the developer was shown. */
  readonly contentHash: string;
  readonly outcome: RecordOf<"review">["outcome"];
  readonly actor: string;
  readonly reviewedAt: string;
  readonly comment?: string;
}

/**
 * Appends the developer's review of the active artifact revision. Reviewing another revision,
 * or a hash other than its proposed one, is a bug in the caller: only the active revision is
 * shown for review, with its hash.
 */
export function recordReview(log: SessionLog, request: ReviewRequest): RecordOf<"review"> {
  const { activeArtifact } = currentState(log.records);
  if (activeArtifact?.id !== request.artifactRevisionId)
    throw new Error(`${request.artifactRevisionId} isn't the active artifact revision`);
  if (request.contentHash !== activeArtifact.proposedHash)
    throw new Error(`${request.contentHash} isn't the proposed content of ${activeArtifact.id}`);
  return log.append({
    type: "review",
    artifactRevisionId: request.artifactRevisionId,
    contentHash: request.contentHash as RecordOf<"review">["contentHash"],
    outcome: request.outcome,
    actor: request.actor,
    reviewedAt: request.reviewedAt,
    ...(request.comment === undefined ? {} : { comment: request.comment }),
  });
}
