import { z } from "zod";
import { pretty } from "./serialise.js";

// The data-notice state (IMPL §4.9 "Data notice"): `notices.json`, in the storage directory,
// records each repository root whose data notice (IMPL §2.3) was confirmed, with the notice's
// version and the time. A changed notice text increases DATA_NOTICE_VERSION, and the notice is
// shown again. Roots are compared bytewise, like the session's repository identity (IMPL §4.3).
//
// A missing or unreadable file reads as no confirmations: the notice is shown again, and the
// next confirmation replaces the file. That is the cost the spec already accepts for a lost
// confirmation, and it never skips the notice.

export const NOTICES_FORMAT = "ai-environment-architect/notices";

/** Increase whenever the data notice's text changes. */
export const DATA_NOTICE_VERSION = 1;

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

const noticesFile = z.strictObject({
  format: z.literal(NOTICES_FORMAT),
  confirmations: z.record(
    z.string(),
    z.strictObject({ version: z.number().int().positive(), confirmedAt: timestamp }),
  ),
});

export interface NoticeConfirmation {
  readonly version: number;
  readonly confirmedAt: string;
}

export interface NoticeState {
  readonly confirmations: Readonly<Record<string, NoticeConfirmation>>;
}

export const EMPTY_NOTICES: NoticeState = Object.freeze({ confirmations: Object.freeze({}) });

export function parseNotices(bytes: Uint8Array | undefined): NoticeState {
  if (bytes === undefined) return EMPTY_NOTICES;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = noticesFile.safeParse(JSON.parse(text));
    return parsed.success ? { confirmations: parsed.data.confirmations } : EMPTY_NOTICES;
  } catch {
    return EMPTY_NOTICES;
  }
}

export function serialiseNotices(state: NoticeState): string {
  return `${pretty({ format: NOTICES_FORMAT, confirmations: state.confirmations }, "")}\n`;
}

/** Whether the notice must be shown for this repository root before anything is read. */
export function needsNotice(state: NoticeState, root: string, version: number): boolean {
  const confirmation = Object.hasOwn(state.confirmations, root)
    ? state.confirmations[root]
    : undefined;
  return confirmation === undefined || confirmation.version < version;
}

/** A new state with this root's confirmation, replacing any earlier one. */
export function confirmNotice(
  state: NoticeState,
  root: string,
  version: number,
  at: Date,
): NoticeState {
  return {
    confirmations: {
      ...state.confirmations,
      [root]: { version, confirmedAt: at.toISOString() },
    },
  };
}
