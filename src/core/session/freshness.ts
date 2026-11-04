import { pathHash } from "../context/secrets.js";
import type { Hash } from "../hash.js";
import { comparePaths, normalisePath } from "../paths.js";
import { DESTINATION_PATH, type Snapshot, type SnapshotFile } from "../snapshot/snapshot.js";
import { globMatches } from "../validation/coverage.js";
import { anchorablePaths } from "../validation/support.js";
import { isFailed, lineageOf, type Revised } from "./log.js";
import type { RecordOf, SessionRecord } from "./records.js";

// Tiered freshness (DM §11.1). Before any write, apply rescans the file list and hashes under
// the snapshot's scope; this compares the rescan with the artifact's snapshot.
//
// - Block, so the developer refreshes and reviews again, when the destination changed, a file
//   cited by a supporting finding changed or went, a path reference is no longer listed, or a
//   file was added or removed within a supporting finding's scope.
// - Warn, so the developer acknowledges it, when anything else changed.
//
// The supporting findings are a selected revision's finding support and the findings its
// decisions' questions and conflicts cover, as DM §12 counts them. Nothing is written here: the
// result is recorded on the apply attempt (DM §11.2).

/** The rescan: a capture with the snapshot's settings, whose destination may be any state. */
export interface Rescan {
  readonly files: readonly SnapshotFile[];
  readonly stability: Snapshot["stability"];
  readonly destination:
    | { readonly state: "absent" }
    | { readonly state: "present"; readonly hash: Hash }
    | { readonly state: "unavailable"; readonly reason: string };
}

export type FreshnessBlocker =
  | {
      readonly rule: "destination";
      readonly from: Hash | "absent";
      readonly to: Hash | "absent" | "unavailable";
    }
  | {
      readonly rule: "cited_file";
      readonly path: string;
      readonly change: "changed" | "removed";
      /** The first supporting finding citing it, in selected-revision and support order. */
      readonly findingId: string;
    }
  | { readonly rule: "missing_reference"; readonly value: string; readonly revisionId: string }
  | {
      readonly rule: "scope";
      readonly path: string;
      readonly change: "added" | "removed";
      readonly findingId: string;
    };

export type Freshness =
  | { readonly state: "fresh" }
  /** `changedPaths` are every change no blocking rule names, in bytewise order. */
  | { readonly state: "warn"; readonly changedPaths: readonly string[] }
  | {
      readonly state: "blocked";
      /** In rule order, then by path or reference value, bytewise. */
      readonly blockers: readonly FreshnessBlocker[];
      readonly changedPaths: readonly string[];
    };

/** Warnings the developer acknowledged; recorded on the apply attempt (DM §11.2). */
export interface AcknowledgedFreshness {
  readonly state: "acknowledged";
  readonly changedPaths: readonly string[];
}

type Change = "added" | "removed" | "changed";

export function checkFreshness(
  records: readonly SessionRecord[],
  artifact: Pick<RecordOf<"artifact_revision">, "snapshotId" | "selectedRevisionIds">,
  rescan: Rescan,
): Freshness {
  const snapshot = records.find(
    (r): r is RecordOf<"snapshot"> => r.type === "snapshot" && r.id === artifact.snapshotId,
  );
  if (snapshot === undefined) throw new Error(`no snapshot ${artifact.snapshotId}`);

  const changes = changesBetween(snapshot.files, rescan);
  const blockers: FreshnessBlocker[] = [];
  const named = new Set<string>([DESTINATION_PATH]);

  const from = snapshot.destination;
  const to = rescan.destination;
  const fromKey = from.state === "present" ? from.hash : from.state;
  const toKey = to.state === "present" ? to.hash : to.state;
  // A snapshot with an unavailable destination never reaches apply (DM §6.1).
  if (fromKey === "unavailable") throw new Error("the snapshot's destination is unavailable");
  if (fromKey !== toKey) blockers.push({ rule: "destination", from: fromKey, to: toKey });

  const revisions = artifact.selectedRevisionIds.map((id) => revisionOf(records, id));
  const findings = supportingFindings(records, revisions);
  const evidence = new Map(
    records.filter((r): r is RecordOf<"evidence"> => r.type === "evidence").map((r) => [r.id, r]),
  );

  const cited = new Map<string, string>();
  for (const finding of findings)
    for (const id of finding.evidenceIds) {
      const ev = evidence.get(id);
      // The destination is checked only by its own rule.
      if (ev === undefined || ev.kind === "absence_check" || ev.path === DESTINATION_PATH) continue;
      if (!cited.has(ev.path)) cited.set(ev.path, finding.findingId);
    }
  for (const [path, findingId] of cited) {
    const change = changes.get(path);
    if (change === "changed" || change === "removed") {
      blockers.push({ rule: "cited_file", path, change, findingId });
      named.add(path);
    }
  }

  const listed = anchorablePaths(rescan.files.map((f) => f.path));
  for (const revision of revisions)
    for (const reference of revision.references) {
      if (reference.kind !== "path") continue;
      const path = normalisePath(reference.value);
      if (path === DESTINATION_PATH || (path !== undefined && listed.has(path))) continue;
      blockers.push({ rule: "missing_reference", value: reference.value, revisionId: revision.id });
      if (path !== undefined) named.add(path);
    }

  for (const [path, change] of changes) {
    if (change === "changed" || named.has(path)) continue;
    const finding = findings.find((f) => inScope(f, path));
    if (finding === undefined) continue;
    blockers.push({ rule: "scope", path, change, findingId: finding.findingId });
    named.add(path);
  }

  const changedPaths = [...changes.keys()].filter((path) => !named.has(path)).sort(comparePaths);
  if (blockers.length === 0)
    return changedPaths.length === 0 ? { state: "fresh" } : { state: "warn", changedPaths };
  return { state: "blocked", blockers: sortBlockers(blockers), changedPaths };
}

/** The developer's typed acknowledgement of a warning (IMPL §2.9). */
export function acknowledgeWarnings(freshness: Freshness): AcknowledgedFreshness {
  if (freshness.state !== "warn")
    throw new Error(`only warnings are acknowledged, not a ${freshness.state} result`);
  return { state: "acknowledged", changedPaths: freshness.changedPaths };
}

/** Every path the rescan differs on (DM §11.1), in no particular order. */
function changesBetween(before: readonly SnapshotFile[], rescan: Rescan): Map<string, Change> {
  const old = new Map(before.map((f) => [f.path, fingerprint(f)]));
  const now = new Map(rescan.files.map((f) => [f.path, fingerprint(f)]));
  const changes = new Map<string, Change>();
  for (const [path, print] of old) {
    const next = now.get(path);
    if (next === undefined) changes.set(path, "removed");
    else if (next !== print) changes.set(path, "changed");
  }
  for (const path of now.keys()) if (!old.has(path)) changes.set(path, "added");
  // A path an unstable rescan names has changed, whatever its hashes say (DM §11.1).
  if (rescan.stability.state === "unstable")
    for (const path of rescan.stability.changedPaths)
      if (!changes.has(path)) changes.set(path, "changed");
  return changes;
}

/** What identifies an entry's content: its hash, a link's target, otherwise status and kind. */
function fingerprint(file: SnapshotFile): string {
  if ("hash" in file) return file.hash;
  switch (file.status) {
    case "symlink":
      return `symlink:${file.target}`;
    case "unreadable":
      return `unreadable:${file.kind}:${file.reason}`;
    case "excluded":
      return `excluded:${file.kind}:${file.rule}`;
    case "ignored":
      return `ignored:${file.kind}`;
  }
}

function revisionOf(
  records: readonly SessionRecord[],
  id: string,
): Revised<"recommendation_revision"> {
  const record = records.find((r) => r.id === id);
  if (record?.type !== "recommendation_revision" || isFailed(record))
    throw new Error(`no recommendation revision ${id}`);
  return record as unknown as Revised<"recommendation_revision">;
}

type Claim = Extract<Revised<"finding">, { kind: "claim" }>;
type Gap = Extract<Revised<"finding">, { kind: "gap" }>;
type Absence = Extract<Revised<"finding">, { kind: "absence" }>;
type Finding = Revised<"finding">;

/**
 * The findings behind the revisions, once each, in revision and support order: finding support,
 * then for decision support the findings its question resolves, directly or through a conflict,
 * and its conflict's members (DM §11.1, §12). The latest revision of each lineage.
 */
function supportingFindings(
  records: readonly SessionRecord[],
  revisions: readonly Revised<"recommendation_revision">[],
): Finding[] {
  const latest = <T extends "finding" | "question" | "conflict">(type: T) => {
    const map = new Map<string, Revised<T>>();
    for (const r of records)
      if (r.type === type && !isFailed(r))
        map.set(lineageOf(r) as string, r as unknown as Revised<T>);
    return map;
  };
  const findings = latest("finding");
  const questions = latest("question");
  const conflicts = latest("conflict");
  const decisions = new Map(
    records.filter((r): r is RecordOf<"decision"> => r.type === "decision").map((r) => [r.id, r]),
  );

  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  const addConflict = (id: string) => {
    for (const member of conflicts.get(id)?.findingIds ?? []) add(member);
  };
  for (const revision of revisions)
    for (const entry of revision.support) {
      if (entry.kind === "finding") {
        add(entry.findingId);
        continue;
      }
      const decision = decisions.get(entry.decisionId);
      if (decision === undefined) throw new Error(`no decision ${entry.decisionId}`);
      const question =
        decision.questionId === undefined ? undefined : questions.get(decision.questionId);
      if (question !== undefined) {
        for (const id of question.findingIds) add(id);
        for (const id of question.gapIds) add(id);
        for (const id of question.conflictIds) addConflict(id);
      }
      if (decision.conflictId !== undefined) addConflict(decision.conflictId);
    }
  return ids.map((id) => {
    const finding = findings.get(id);
    // Load check 4 rules this out; a missing lineage would leave its files unprotected.
    if (finding === undefined) throw new Error(`no finding ${id}`);
    return finding;
  });
}

/**
 * Whether a path is within a finding's scope (DM §11.1): a claim's scope, anywhere for
 * `repository`; a gap's related paths, withheld ones by hash; an absence claim's glob. A pattern
 * covers what it matches and everything under a directory it matches (IMPL §1.11).
 */
function inScope(finding: Finding, path: string): boolean {
  const segments = path.split("/");
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  const covers = (glob: string) => prefixes.some((prefix) => globMatches(glob, prefix));
  switch (finding.kind) {
    case "claim": {
      const { scope } = finding as Claim;
      return scope.kind === "repository" || scope.paths.some(covers);
    }
    case "gap": {
      const gap = finding as Gap;
      const hashes = new Set(gap.relatedPathHashes ?? []);
      return (
        gap.relatedPaths.some(covers) || prefixes.some((prefix) => hashes.has(pathHash(prefix)))
      );
    }
    case "absence":
      return covers((finding as Absence).pathGlob);
  }
}

const RULE_ORDER: Record<FreshnessBlocker["rule"], number> = {
  destination: 0,
  cited_file: 1,
  missing_reference: 2,
  scope: 3,
};

function sortBlockers(blockers: readonly FreshnessBlocker[]): FreshnessBlocker[] {
  const key = (b: FreshnessBlocker) =>
    b.rule === "destination" ? "" : b.rule === "missing_reference" ? b.value : b.path;
  return [...blockers].sort(
    (a, b) => RULE_ORDER[a.rule] - RULE_ORDER[b.rule] || comparePaths(key(a), key(b)),
  );
}
