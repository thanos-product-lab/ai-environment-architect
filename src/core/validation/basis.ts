import { type TierMembership, tierOf } from "../context/tiers.js";
import type { Basis, Evidence } from "./citations.js";
import { accept, type ItemCheck } from "./pipeline.js";

// Evidence basis (IMPL §3.2.4). Code derives it from the tier the cited file belongs to, whether
// the file reached the model through the initial context or through expansion. The model never
// chooses it.

/** The order a finding's bases are listed in. */
const BASES: readonly Basis[] = ["documentation", "code_observation", "existing_guidance"];

/**
 * Tier 1 is existing guidance, tier 2 documentation, and anything else, tier 3, tier 5 or no tier,
 * a code observation. So a code comment saying "always use X" can raise a question, but can't
 * support a prescriptive finding (SUP-004) until the developer confirms it.
 */
export function basisOf(path: string, membership: TierMembership): Basis {
  switch (tierOf(path, membership)) {
    case 1:
      return "existing_guidance";
    case 2:
      return "documentation";
    default:
      return "code_observation";
  }
}

/** A finding's basis: the set of its citations' bases, once each, in a fixed order. */
export function findingBasis(evidence: readonly Evidence[]): Basis[] {
  const found = new Set(evidence.map((e) => e.basis));
  return BASES.filter((basis) => found.has(basis));
}

/** Fields a finding gains when its basis is derived. */
export interface WithBasis {
  readonly evidence?: readonly Evidence[];
  readonly basis?: readonly Basis[];
}

/** Basis derivation as an item check, after support (§3.3.2 step 3). It never rejects. */
export function basisDerivation<V extends WithBasis, C>(): ItemCheck<V, C> {
  return (value) => {
    const evidence = value.evidence;
    if (evidence === undefined) throw new Error("basis derivation runs after citations");
    return accept({ ...value, basis: findingBasis(evidence) });
  };
}
