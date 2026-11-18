import type { ExpansionRound } from "../context/expansion.js";
import { expansionRoundFields } from "../context/expansion.js";
import { isWithheldPath, pathHash } from "../context/secrets.js";
import { currentState } from "./current.js";
import type { SessionLog } from "./log.js";
import type { RecordOf, SessionRecord } from "./records.js";

// The expansion record (IMPL §1.8, §1.13, §4.4.1). Appended once the round has run, after
// call 1's records and before call 2's token check, whether or not call 2 is then sent. Call 2's
// manifest names it by `expansionRoundId`.

export function recordExpansionRound(
  log: SessionLog,
  round: ExpansionRound,
  ids: { readonly snapshotId: string; readonly modelCallId: string },
): RecordOf<"expansion_round"> {
  if (log.records.some((r) => r.type === "expansion_round"))
    throw new Error("the session already has an expansion round: there is one in the first slice");
  return log.append({
    type: "expansion_round",
    snapshotId: ids.snapshotId,
    modelCallId: ids.modelCallId,
    ...expansionRoundFields(round),
  }) as RecordOf<"expansion_round">;
}

// A file a secret match blocked during expansion is blocked for the rest of the session, as in
// IMPL §1.7: its excerpts accepted in call 1 are never sent again, and a finding left with no
// evidence outside the blocked files is withheld.

/** Each blocked file's rule, keyed by its path or, for a withheld name, the path's hash. */
function blockedFiles(records: readonly SessionRecord[]): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const r of records)
    if (r.type === "expansion_round")
      for (const file of r.blocked)
        files.set("path" in file ? file.path : file.pathHash, file.secretRuleId);
  return files;
}

function ruleOf(path: string, blocked: ReadonlyMap<string, string>): string | undefined {
  return blocked.get(path) ?? (isWithheldPath(path) ? blocked.get(pathHash(path)) : undefined);
}

/** The evidence of every blocked file: left out of every later call's cited excerpts. */
export function blockedEvidenceIds(records: readonly SessionRecord[]): ReadonlySet<string> {
  const blocked = blockedFiles(records);
  const ids = new Set<string>();
  if (blocked.size === 0) return ids;
  for (const r of records)
    if (r.type === "evidence" && "path" in r && ruleOf(r.path, blocked) !== undefined)
      ids.add(r.id);
  return ids;
}

/**
 * Appends a `secret_withheld` for each current finding whose evidence is all from blocked files,
 * with the rule of the first such file in evidence order. A finding with no evidence, such as a
 * gap, keeps nothing from a blocked file and is left as it is. Run after the round is recorded;
 * running it again appends nothing.
 */
export function withholdBlockedFiles(log: SessionLog): RecordOf<"secret_withheld">[] {
  const blocked = blockedFiles(log.records);
  if (blocked.size === 0) return [];
  const evidence = new Map(
    log.records.flatMap((r) => (r.type === "evidence" ? [[r.id, r] as const] : [])),
  );
  const appended: RecordOf<"secret_withheld">[] = [];
  for (const [findingId, finding] of currentState(log.records).findings) {
    if (!("evidenceIds" in finding) || finding.evidenceIds.length === 0) continue;
    const rules = finding.evidenceIds.map((id) => {
      const item = evidence.get(id);
      return item !== undefined && "path" in item ? ruleOf(item.path, blocked) : undefined;
    });
    if (rules.some((rule) => rule === undefined)) continue;
    appended.push(
      log.append({
        type: "secret_withheld",
        itemId: findingId,
        secretRuleId: rules[0] as string,
      }) as RecordOf<"secret_withheld">,
    );
  }
  return appended;
}
