import { sha256 } from "../hash.js";
import { type ContentReader, type LoadOptions, type LoadResult, loadSession } from "./load.js";
import type { SessionLog } from "./log.js";
import type { SessionFile, SessionRecord } from "./records.js";
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
  /** Deletes `inputs/` and `responses/`, the retained model exchanges (IMPL §4.8). */
  removeExchanges(): Promise<void>;
}

/** A retained request or response body and its content-addressed name (IMPL §4.8). */
export interface RetainedFile {
  readonly ref: string;
  readonly bytes: Uint8Array;
}

/** `content/sha256-<hex>`: the name is the SHA-256 of the exact bytes (IMPL §4.2). */
export function contentRefOf(bytes: Uint8Array): `content/sha256-${string}` {
  return `content/sha256-${sha256(bytes).slice("sha256:".length)}`;
}

export class SaveRefused extends Error {}

/**
 * Writes `contents` (the bytes behind any new `contentRef`) and `retained` (the request and
 * response bodies behind any new retained reference), then the session file.
 */
export async function saveSession(
  session: SessionWriter,
  file: SessionFile,
  contents: readonly Uint8Array[],
  retained: readonly RetainedFile[] = [],
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
  for (const { ref, bytes } of retained) {
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

/** The files a change adds, saved before `session.json` (IMPL §4.7 step 1). */
export interface PendingFiles {
  /** The bytes behind any new `contentRef`. */
  readonly contents: Uint8Array[];
  /** The request and response bodies behind any new retained reference. */
  readonly retained: RetainedFile[];
}

/**
 * A session held under the lock, and the one place records are appended and saved. A change
 * runs on a fork of the saved log; the fork replaces it only once the save succeeds. So a failed
 * or refused save leaves the records in memory exactly as last saved (IMPL §4.7), and nothing
 * appended can be written later by accident. The log itself is never handed out, only its records.
 *
 * - `apply` is synchronous, and one change runs at a time: a change made while another is being
 *   saved, or from inside its `apply`, is refused, so no two forks of the same log race.
 * - A failed change has still drawn IDs and timestamps from the shared ports. They are skipped,
 *   which load allows: only `seq` must be contiguous, and it comes from the record count.
 */
export class HeldSession {
  readonly #writer: SessionWriter;
  readonly #header: Omit<SessionFile, "records">;
  #log: SessionLog;
  #changing = false;

  /**
   * `log` holds the session's records as loaded, or as about to be saved first by `save`. The
   * session keeps a fork: anything appended to `log` afterwards isn't part of it.
   */
  constructor(writer: SessionWriter, header: Omit<SessionFile, "records">, log: SessionLog) {
    this.#writer = writer;
    this.#header = header;
    this.#log = log.fork();
  }

  /** The records as last saved, or as given before the first save. */
  get records(): readonly SessionRecord[] {
    return this.#log.records;
  }

  /** Saves the records as they are, with `files`: for a new session's first save. */
  async save(files: PendingFiles = { contents: [], retained: [] }): Promise<void> {
    await this.#exclusively(() => this.#write(this.#log, files));
  }

  /** Applies `apply` to a fork of the log, saves it with the files it adds, then adopts it. */
  async change<T>(
    apply: (log: SessionLog, files: PendingFiles) => T extends PromiseLike<unknown> ? never : T,
  ): Promise<T> {
    return this.#exclusively(async () => {
      const next = this.#log.fork();
      const files: PendingFiles = { contents: [], retained: [] };
      const result = apply(next, files);
      if (isThenable(result))
        throw new Error("a change's apply must be synchronous: await before calling change");
      await this.#write(next, files);
      this.#log = next;
      return result as T;
    });
  }

  /** Deletes the retained model exchanges (IMPL §4.8), once a purge is saved. */
  async removeExchanges(): Promise<void> {
    await this.#exclusively(() => this.#writer.removeExchanges());
  }

  async #exclusively<R>(run: () => Promise<R>): Promise<R> {
    if (this.#changing) throw new Error("this session is already being changed");
    this.#changing = true;
    try {
      return await run();
    } finally {
      this.#changing = false;
    }
  }

  async #write(log: SessionLog, files: PendingFiles): Promise<void> {
    await saveSession(
      this.#writer,
      { ...this.#header, records: [...log.records] },
      files.contents,
      files.retained,
    );
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
