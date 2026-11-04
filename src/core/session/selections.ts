import { currentState } from "./current.js";
import {
  type ActiveDestination,
  activeDestination,
  type ExclusionReason,
  exclusionBetween,
} from "./exclusion.js";
import type { Revised, SessionLog } from "./log.js";
import type { RecordOf, SessionRecord } from "./records.js";

// Selections (DM §9.2, IMPL §4.4.2 "Current selections") under mutual exclusion (DM §9.1).
//
// - A selection names the current revision of its recommendation; history is kept, and the
//   latest per recommendation is current while that revision stays current.
// - Accepting is refused while an exclusive recommendation is accepted, and nothing else changes:
//   the system never selects or deselects a recommendation for the developer.
// - A refresh can still make two accepted recommendations clash; `currentState` reports it.
//
// Every function takes the bytes the caller read for the active snapshot's destination, checked
// against its hash, or undefined when that destination isn't present.

export { changedBlocks } from "./exclusion.js";

type Revision = Revised<"recommendation_revision">;

/** Another recommendation, and why the two can't both be accepted. */
export type Exclusion = { readonly recommendationId: string } & ExclusionReason;

export interface SelectionRequest {
  readonly recommendationId: string;
  readonly revisionId: string;
  readonly state: RecordOf<"selection">["state"];
  readonly actor: string;
  readonly selectedAt: string;
}

export type SelectOutcome =
  | { readonly selected: true; readonly selection: RecordOf<"selection"> }
  /** Accepting was refused; nothing was written. Names every accepted one it excludes. */
  | { readonly selected: false; readonly exclusions: readonly Exclusion[] };

/**
 * Every other current recommendation that `recommendationId`'s current revision excludes,
 * selected or not, in the order of their current revisions: the candidates the CLI names.
 */
export function exclusions(
  records: readonly SessionRecord[],
  destinationBytes: Uint8Array | undefined,
  recommendationId: string,
): readonly Exclusion[] {
  const destination = activeDestination(records, destinationBytes);
  const { recommendations } = currentState(records);
  const revision = recommendations.get(recommendationId);
  if (revision === undefined) throw new Error(`${recommendationId} has no current revision`);
  return excludedBy(revision, [...recommendations.values()], destination);
}

function excludedBy(
  revision: Revision,
  others: readonly Revision[],
  destination: ActiveDestination,
): Exclusion[] {
  const found: Exclusion[] = [];
  for (const other of others) {
    if (other.recommendationId === revision.recommendationId) continue;
    const reason = exclusionBetween(revision, other, destination);
    if (reason !== undefined) found.push({ recommendationId: other.recommendationId, ...reason });
  }
  return found;
}

/**
 * Appends the developer's selection of a recommendation's current revision. Accepting is refused,
 * with nothing written, while it excludes an accepted recommendation whose selection counts.
 * Rejecting and `pending` are never refused. Naming a revision that isn't current is a bug in
 * the caller: such a recommendation is never shown for selection.
 */
export function select(
  log: SessionLog,
  destinationBytes: Uint8Array | undefined,
  request: SelectionRequest,
): SelectOutcome {
  const destination = activeDestination(log.records, destinationBytes);
  const { recommendations, selections } = currentState(log.records);
  const revision = recommendations.get(request.recommendationId);
  if (revision?.id !== request.revisionId)
    throw new Error(
      `${request.revisionId} isn't the current revision of ${request.recommendationId}`,
    );
  if (request.state === "accepted") {
    const accepted = [...recommendations.values()].filter(
      (r) => selections.get(r.recommendationId)?.state === "accepted",
    );
    const found = excludedBy(revision, accepted, destination);
    if (found.length > 0) return { selected: false, exclusions: found };
  }
  const selection = log.append({ type: "selection", ...request });
  return { selected: true, selection };
}
