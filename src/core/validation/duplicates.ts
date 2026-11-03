import { comparePaths, normalisePath } from "../paths.js";
import type { AcceptedItems, CrossItemCheck, CrossItemRejection } from "./pipeline.js";

// Duplicates (IMPL §3.3.2 step 7, §3.3.3, §3.3.4 step 4). Each rule compares one identity per
// item; the first item with an identity is kept, and a later one is dropped and redirected to it,
// so references to the duplicate count as references to the item kept.

export type Scope =
  | { readonly kind: "repository" }
  | { readonly kind: "paths"; readonly paths: readonly string[] };

/** NFC, every run of `White_Space` as one space, the ends trimmed; case is kept. */
export function normaliseStatement(statement: string): string {
  return statement
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .replace(/^ | $/g, "");
}

/** A set of paths after the path normalisation of IMPL §1.11, once each, in bytewise order. */
function pathSet(paths: readonly string[]): string[] {
  // A path naming nothing has been rejected by its own rule; keep it as written regardless.
  return [...new Set(paths.map((path) => normalisePath(path) ?? path))].sort(comparePaths);
}

// JSON keeps the parts apart, so no statement can be mistaken for a statement and a scope.
export function findingIdentity(statement: string, scope: Scope): string {
  return JSON.stringify([
    normaliseStatement(statement),
    scope.kind === "repository" ? null : pathSet(scope.paths),
  ]);
}

export function gapIdentity(
  statement: string,
  gapType: string,
  relatedPaths: readonly string[],
): string {
  return JSON.stringify([normaliseStatement(statement), gapType, pathSet(relatedPaths)]);
}

export function claimIdentity(pathGlob: string): string {
  return normalisePath(pathGlob) ?? pathGlob;
}

/** A `resolves` set, compared as a set (DUP-003). Aliases match exactly (IMPL §3.2.1). */
export function resolvesIdentity(resolves: readonly string[]): string {
  return JSON.stringify([...new Set(resolves)].sort(comparePaths));
}

/** A record outside the response that an item may restate, such as a known fact. */
export interface PriorIdentity {
  readonly alias: string;
  readonly identity: string;
}

export interface DuplicateSpec<A, C, K extends keyof A & string> {
  readonly collection: K;
  readonly rule: "DUP-001" | "DUP-002" | "DUP-003" | "DUP-004";
  readonly identity: (value: A[K]) => string;
  /** Records the items are also compared with, before any earlier item. */
  readonly prior?: (context: C, surviving: AcceptedItems<A>) => readonly PriorIdentity[];
  /** Whether an earlier item in the response counts. Default true; false for DUP-002. */
  readonly withinResponse?: boolean;
}

export function duplicateCheck<A, C, K extends keyof A & string>(
  spec: DuplicateSpec<A, C, K>,
): CrossItemCheck<A, C> {
  return (surviving, context) => {
    const kept = new Map<string, string>();
    for (const prior of spec.prior?.(context, surviving) ?? [])
      if (!kept.has(prior.identity)) kept.set(prior.identity, prior.alias);
    const rejections: CrossItemRejection<A>[] = [];
    for (const item of surviving[spec.collection]) {
      const identity = spec.identity(item.value);
      const earlier = kept.get(identity);
      if (earlier !== undefined) {
        rejections.push({
          collection: spec.collection,
          index: item.index,
          rule: spec.rule,
          // Keys and aliases are well formed by now, so they hold no text from the response.
          detail: `duplicate of ${earlier}`,
          mergedInto: earlier,
        });
        continue;
      }
      if (spec.withinResponse ?? true) kept.set(identity, item.key);
    }
    return rejections;
  };
}
