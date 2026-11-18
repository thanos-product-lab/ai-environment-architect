import type { SelectionGap } from "../context/tiers.js";
import { claimLines, renderLines } from "../requests/records.js";
import type { KnownFact } from "./known-facts.js";

// The known-facts section (IMPL §3.2.5): sent first in the context, within its own byte cap.
// Facts are tried in order, and one that doesn't fit is left out while later ones may still fit,
// as in the tiers. The frame is always rendered, so the section has a fixed shape.

const OPEN = "<<<KNOWN FACTS>>>\n";
const CLOSE = "<<<END KNOWN FACTS>>>\n";

/** The frame's bytes: the smallest section, and so the smallest `knownFactsBytes` allowed. */
export const KNOWN_FACTS_FRAME_BYTES = byteLength(OPEN) + byteLength(CLOSE);

export interface KnownFactsSection {
  readonly text: string;
  /** UTF-8 bytes, frame included. */
  readonly bytes: number;
  /** Parallel to the facts: each one's alias, or null when it was left out. */
  readonly aliases: readonly (string | null)[];
  readonly leftOut: number;
  /** Set when any fact was left out. */
  readonly gap: SelectionGap | undefined;
}

export function renderKnownFacts(facts: readonly KnownFact[], capBytes: number): KnownFactsSection {
  let body = "";
  let bytes = KNOWN_FACTS_FRAME_BYTES;
  const aliases: (string | null)[] = [];
  for (const fact of facts) {
    const block = renderFact(fact, `F-${aliases.filter((a) => a !== null).length + 1}`);
    const size = byteLength(block);
    if (bytes + size > capBytes) {
      aliases.push(null);
      continue;
    }
    body += block;
    bytes += size;
    aliases.push(`F-${aliases.filter((a) => a !== null).length + 1}`);
  }
  const leftOut = aliases.filter((alias) => alias === null).length;
  return {
    text: OPEN + body + CLOSE,
    bytes,
    aliases,
    leftOut,
    gap:
      leftOut === 0
        ? undefined
        : {
            gapType: "other",
            statement:
              leftOut === 1
                ? "1 known fact was left out because of the known-facts budget."
                : `${leftOut} known facts were left out because of the known-facts budget.`,
            relatedPaths: [],
          },
  };
}

/** One fact in the §3.2.6 record format, as calls 2–5 render it too. */
function renderFact(fact: KnownFact, alias: string): string {
  return renderLines(
    claimLines(
      alias,
      { basis: fact.basis, scope: fact.scope, statement: fact.statement },
      fact.evidence,
    ),
  );
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
