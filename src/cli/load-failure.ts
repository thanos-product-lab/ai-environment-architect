import type { LoadFailure } from "../core/session/load.js";

/**
 * The message for a session that failed its load checks (IMPL §2.12, §4.9). `cli` is the
 * command name. A file that doesn't say which version wrote it names "an unknown version".
 */
export function describeLoadFailure(failure: LoadFailure, cli: string): string {
  const v = failure.version;
  if (v?.direction === "older")
    return (
      `This session was saved in session format ${v.sessionFormat} by ${savedBy(v.writtenBy)}. ` +
      `This version reads only format ${v.readerFormat}, and doesn't convert older sessions ` +
      `before v0.1.0. Start a new session with \`${cli} init\`.`
    );
  if (v?.direction === "newer")
    return (
      `This session was saved in session format ${v.sessionFormat} by ${savedBy(v.writtenBy)}. ` +
      `This CLI reads format ${v.readerFormat}. ` +
      (v.writtenBy === undefined
        ? "Update to the latest version."
        : `Update to ${v.writtenBy} or later.`)
    );
  const where =
    failure.recordId === undefined ? "" : ` at record ${failure.recordId} (seq ${failure.seq})`;
  return `This session failed load check ${failure.check} (${failure.name})${where}: ${failure.detail}.`;
}

const savedBy = (writtenBy: string | undefined) =>
  writtenBy === undefined ? "an unknown version" : `version ${writtenBy}`;
