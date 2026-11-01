import { resolveReference } from "./aliases.js";
import { type CitationContext, locateSentRange } from "./citations.js";
import { accept, type ItemCheck, reject } from "./pipeline.js";

// Content notices (IMPL §3.3.2 step 10): text in the repository that reads as instructions to
// the model. The notice cites sent lines as a citation does, without a quote. Valid notices are
// recorded and shown; they never change behaviour.

export interface ContentNotice {
  readonly item: string;
  readonly lines: string;
  readonly description: string;
}

export function noticeCheck<V extends ContentNotice, C extends CitationContext>(): ItemCheck<V, C> {
  return (value, context, response) => {
    const resolved = resolveReference(context.aliases, response.localKeys, value.item, {
      aliases: ["T", "E"],
    });
    if (!resolved.ok)
      return resolved.rule === "ALIAS-003"
        ? reject("ALIAS-003", resolved.detail)
        : reject("CIT-001", "an item not in this call's input");
    const item = context.items.get(value.item);
    if (item === undefined) throw new Error(`no citable item for ${value.item}`);
    const located = locateSentRange(item, value.item, value.lines);
    return located.ok ? accept(value) : reject(located.rule, located.detail);
  };
}
