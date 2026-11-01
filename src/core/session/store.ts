import { sha256 } from "../hash.js";
import { type ContentReader, type LoadOptions, type LoadResult, loadSession } from "./load.js";
import type { SessionFile } from "./records.js";
import { serialiseSession } from "./serialise.js";

// The storage port and the save order (IMPL §4.1 "Layout", §4.7 "Writing"). Core decides what
// is written and in what order; the adapter (`src/adapters/storage/`) does the file I/O, the
// atomic renames and the lock. Tests use an in-memory store.
//
// Saving writes new content files first and `session.json` last, so a crash leaves either the
// old session file or the new one, and every content file the session file names already
// exists. A save also runs the load checks (IMPL §4.9) on what it is about to write, and
// refuses to write a session that wouldn't load.

/** Reads a session directory. Read-only commands use this and take no lock (IMPL §4.7). */
export interface SessionReader extends ContentReader {
  /** The session whose directory this is. */
  readonly sessionId: string;
  readSessionFile(): Promise<Uint8Array | undefined>;
}

/** A session directory held under the lock. Only a lock holder gets one. */
export interface SessionWriter extends SessionReader {
  /** Writes a content-addressed file atomically. An existing file isn't rewritten. */
  writeContent(ref: string, bytes: Uint8Array): Promise<void>;
  /** Replaces `session.json` atomically and durably; resolves only once it is saved. */
  replaceSessionFile(bytes: Uint8Array): Promise<void>;
}

/** `content/sha256-<hex>`: the name is the SHA-256 of the exact bytes (IMPL §4.2). */
export function contentRefOf(bytes: Uint8Array): `content/sha256-${string}` {
  return `content/sha256-${sha256(bytes).slice("sha256:".length)}`;
}

export class SaveRefused extends Error {}

/** Writes `contents` (the bytes behind any new `contentRef`), then the session file. */
export async function saveSession(
  session: SessionWriter,
  file: SessionFile,
  contents: readonly Uint8Array[],
): Promise<void> {
  if (file.session.id !== session.sessionId)
    throw new SaveRefused(
      `session ${file.session.id} can't be saved in ${session.sessionId}'s directory`,
    );
  const written = new Set<string>();
  for (const bytes of contents) {
    const ref = contentRefOf(bytes);
    if (written.has(ref)) continue;
    written.add(ref);
    await session.writeContent(ref, bytes);
  }
  const bytes = new TextEncoder().encode(serialiseSession(file));
  const check = await loadSession(bytes, session);
  if (!check.ok) {
    const { check: number, name, detail } = check.failure;
    throw new SaveRefused(
      `refusing to save a session that fails check ${number} (${name}): ${detail}`,
    );
  }
  await session.replaceSessionFile(bytes);
}

/** Loads a session with the load checks, or reports that it has no session file. */
export async function openSession(
  session: SessionReader,
  options: LoadOptions = {},
): Promise<LoadResult | { readonly ok: false; readonly missing: true }> {
  const bytes = await session.readSessionFile();
  if (bytes === undefined) return { ok: false, missing: true };
  return loadSession(bytes, session, options);
}
