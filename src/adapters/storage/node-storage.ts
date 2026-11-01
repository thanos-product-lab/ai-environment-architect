import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { sha256 } from "../../core/hash.js";
import { pretty } from "../../core/session/serialise.js";
import type { SessionReader, SessionWriter } from "../../core/session/store.js";
import { STORAGE_OVERRIDE_VARIABLE } from "./location.js";

// Session storage on disk (IMPL §4.2, §4.7): the session directory, content-addressed files,
// whole-file atomic writes, the lock, and the data-notice file. Core decides what to write
// (`src/core/session/store.ts`); this module only does the I/O.
//
// - Every file is written to a temporary file in its own directory, synced, renamed into place,
//   and the directory synced. A crash leaves the old file or the new one, never a mix.
// - Writes exist only on a LockedSession, which only `lock` returns. Readers take no lock.
// - The lock is `session.lock`. It is created exclusively and never appears without its content:
//   the owner is written to a synced temporary file, which `link` puts in place and which fails
//   if a lock exists, like O_CREAT | O_EXCL. It is stale when its host is this machine and its
//   process isn't running; a lock from another host never is, and neither is an unreadable one
//   (its owner is unknown). A stale lock is removed only on request, after the CLI's
//   confirmation, and only if the file removed is the one reported.
// - New directories are created one level at a time, each parent synced, so a saved session's
//   directory entries survive a crash.

const SESSION_ID = /^ses_[0-9A-Za-z-]+$/;
const REFERENCE =
  /^(?:content\/sha256-([0-9a-f]{64})|(?:inputs|responses)\/sha256-([0-9a-f]{64})\.json)$/;

export interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly productVersion: string;
}

const lockOwner = z.strictObject({
  pid: z.number().int().positive(),
  hostname: z.string(),
  startedAt: z.string(),
  productVersion: z.string(),
});

export interface LockedSession extends SessionWriter {
  /** Removes the lock if it is still this process's. The session can't write after this. */
  release(): Promise<void>;
  /** The same, synchronously, for exit handlers. */
  releaseSync(): void;
}

export type LockResult =
  | { readonly state: "acquired"; readonly session: LockedSession }
  | {
      readonly state: "held";
      /** Undefined when the lock file can't be read as a lock. */
      readonly owner: LockOwner | undefined;
      readonly stale: boolean;
      /** For the message, which names the lock to remove by hand when its owner is unknown. */
      readonly lockPath: string;
    }
  /** The session directory doesn't exist, and the lock wasn't asked to create it. */
  | { readonly state: "missing" };

export interface StorageOptions {
  readonly pid?: number;
  readonly hostname?: string;
  /** Whether a process on this host is running. Default: signal 0, with EPERM counted as running. */
  readonly isRunning?: (pid: number) => boolean;
  /** The random part of temporary file names. */
  readonly random?: () => string;
  /**
   * Called at each point of an atomic write: after the temporary file is written and before it
   * is synced, after the sync and before the rename, and after the rename and before the
   * directory sync. Tests throw here to simulate a crash; the write then stops without cleaning
   * up, as a crashed process would.
   */
  readonly faultPoint?: (point: FaultPoint, path: string) => void;
  /** The file system's hard link. Tests replace it to show a file system that refuses links. */
  readonly link?: (existingPath: string, newPath: string) => Promise<void>;
}

export type FaultPoint = "written" | "synced" | "renamed";

/** The storage directory's file system refused the hard link the lock is created with. */
export class LockUnsupportedError extends Error {
  readonly storageDirectory: string;
  readonly code: string;
  constructor(storageDirectory: string, code: string) {
    super(
      `The file system holding the storage directory ${storageDirectory} refused to create a ` +
        `hard link (${code}), which the session lock needs. Set ${STORAGE_OVERRIDE_VARIABLE} ` +
        "to a directory on a local file system.",
    );
    this.storageDirectory = storageDirectory;
    this.code = code;
  }
}

export interface NodeStorage {
  reader(sessionId: string): SessionReader;
  /** Takes the session's lock. Only `init` passes `create`, to make the session directory. */
  lock(
    sessionId: string,
    info: Pick<LockOwner, "startedAt" | "productVersion">,
    options?: { readonly create?: boolean },
  ): Promise<LockResult>;
  /** Removes a lock reported stale, if it is unchanged and still stale. True if removed. */
  removeStaleLock(sessionId: string, seen: LockOwner): Promise<boolean>;
  readNotices(): Promise<Uint8Array | undefined>;
  writeNotices(bytes: Uint8Array): Promise<void>;
}

export function openStorage(directory: string, options: StorageOptions = {}): NodeStorage {
  const pid = options.pid ?? process.pid;
  const host = options.hostname ?? osHostname();
  const isRunning = options.isRunning ?? processIsRunning;
  const random = options.random ?? (() => randomBytes(6).toString("hex"));
  const faultPoint = options.faultPoint ?? (() => {});
  const linkFile = options.link ?? link;

  function sessionDirectory(sessionId: string): string {
    if (!SESSION_ID.test(sessionId))
      throw new Error(`not a session ID: ${JSON.stringify(sessionId)}`);
    return join(directory, "sessions", sessionId);
  }

  async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
    const folder = dirname(path);
    await ensureDirectory(folder);
    const temporary = `${path}.tmp-${random()}`;
    let renamed = false;
    let crashed = false;
    const fault = (point: FaultPoint, at: string) => {
      try {
        faultPoint(point, at);
      } catch (error) {
        crashed = true;
        throw error;
      }
    };
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        fault("written", temporary);
        await handle.sync();
      } finally {
        await handle.close();
      }
      fault("synced", temporary);
      await rename(temporary, path);
      renamed = true;
      fault("renamed", path);
      await syncDirectory(folder);
    } finally {
      if (!renamed && !crashed) await unlink(temporary).catch(() => {});
    }
  }

  function readerFor(sessionId: string): SessionReader {
    const root = sessionDirectory(sessionId);
    return {
      sessionId,
      read: async (ref) => readIfPresent(join(root, checkedReference(ref).path)),
      readSessionFile: () => readIfPresent(join(root, "session.json")),
    };
  }

  function isStale(owner: LockOwner | undefined): boolean {
    return owner !== undefined && owner.hostname === host && !isRunning(owner.pid);
  }

  /** Creates the lock with its content already in it: a synced temporary file, linked into place. */
  async function createLock(lockPath: string, bytes: Uint8Array): Promise<boolean> {
    const temporary = `${lockPath}.tmp-${random()}`;
    try {
      await writeSynced(temporary, bytes);
      try {
        await linkFile(temporary, lockPath);
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        if (refusesLinks(error)) throw new LockUnsupportedError(directory, errorCode(error));
        throw error;
      }
      await syncDirectory(dirname(lockPath));
      return true;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  return {
    reader: readerFor,

    async lock(sessionId, info, lockOptions = {}) {
      const root = sessionDirectory(sessionId);
      const lockPath = join(root, "session.lock");
      if (lockOptions.create === true) await ensureDirectory(root);
      else if (!(await exists(root))) return { state: "missing" };
      const owner: LockOwner = { pid, hostname: host, ...info };
      const ownerBytes = lockBytes(owner);

      // A lock that disappears between the failed link and the read was just released: try again.
      let acquired = false;
      for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
        acquired = await createLock(lockPath, ownerBytes);
        if (acquired) break;
        const bytes = await readIfPresent(lockPath);
        if (bytes === undefined) continue;
        const held = parseLock(bytes);
        return { state: "held", owner: held, stale: isStale(held), lockPath };
      }
      if (!acquired) return { state: "held", owner: undefined, stale: false, lockPath };

      const reader = readerFor(sessionId);
      let released = false;
      const ensureHeld = () => {
        if (released) throw new Error("this session's lock was released; it can't be written");
      };
      const ours = (bytes: Uint8Array | undefined) =>
        bytes !== undefined && Buffer.from(bytes).equals(Buffer.from(ownerBytes));
      const session: LockedSession = {
        ...reader,
        async writeContent(ref, bytes) {
          ensureHeld();
          const { path, hex } = checkedReference(ref);
          if (sha256(bytes) !== `sha256:${hex}`)
            throw new Error(`${ref}: the bytes don't hash to the file's name`);
          if (await exists(join(root, path))) return;
          await writeAtomically(join(root, path), bytes);
        },
        async replaceSessionFile(bytes) {
          ensureHeld();
          await writeAtomically(join(root, "session.json"), bytes);
        },
        async release() {
          if (released) return;
          released = true;
          if (ours(await readIfPresent(lockPath))) await unlink(lockPath).catch(ignoreMissing);
        },
        releaseSync() {
          if (released) return;
          released = true;
          let bytes: Uint8Array | undefined;
          try {
            bytes = readFileSync(lockPath);
          } catch {
            return;
          }
          if (ours(bytes)) {
            try {
              unlinkSync(lockPath);
            } catch {
              // Already gone.
            }
          }
        },
      };
      return { state: "acquired", session };
    },

    async removeStaleLock(sessionId, seen) {
      // Move the lock aside first and check the file that was moved, so a lock another process
      // took after the check is never deleted. If the moved file isn't the stale lock that was
      // reported, it goes back; `link` refuses to overwrite a lock created meanwhile.
      const lockPath = join(sessionDirectory(sessionId), "session.lock");
      const aside = `${lockPath}.stale-${random()}`;
      try {
        await rename(lockPath, aside);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
      try {
        const bytes = await readIfPresent(aside);
        const owner = bytes === undefined ? undefined : parseLock(bytes);
        const unchanged =
          bytes !== undefined && Buffer.from(bytes).equals(Buffer.from(lockBytes(seen)));
        if (unchanged && isStale(owner)) return true;
        await linkFile(aside, lockPath).catch((error: unknown) => {
          if (!hasCode(error, "EEXIST")) throw error;
        });
        return false;
      } finally {
        await unlink(aside).catch(() => {});
        await syncDirectory(dirname(lockPath));
      }
    },

    readNotices: () => readIfPresent(join(directory, "notices.json")),
    writeNotices: (bytes) => writeAtomically(join(directory, "notices.json"), bytes),
  };
}

/** The process events releaseOnExit listens to; `process` is one. */
export interface ExitSignals {
  readonly pid: number;
  on(event: "exit" | "SIGINT" | "SIGTERM", listener: (arg: unknown) => void): unknown;
  off(event: "exit" | "SIGINT" | "SIGTERM", listener: (arg: unknown) => void): unknown;
  kill(pid: number, signal: string): unknown;
}

/**
 * Removes the lock on exit, SIGINT and SIGTERM (IMPL §4.7). On a signal it removes its handlers
 * and raises the signal again, so the process still ends the way the signal asks. Returns a
 * function that removes the handlers.
 */
export function releaseOnExit(session: LockedSession, proc: ExitSignals = process): () => void {
  const onExit = () => session.releaseSync();
  const onSignal = (signal: unknown) => {
    stop();
    session.releaseSync();
    proc.kill(proc.pid, String(signal));
  };
  function stop() {
    proc.off("exit", onExit);
    proc.off("SIGINT", onSignal);
    proc.off("SIGTERM", onSignal);
  }
  proc.on("exit", onExit);
  proc.on("SIGINT", onSignal);
  proc.on("SIGTERM", onSignal);
  return stop;
}

function checkedReference(ref: string): { path: string; hex: string } {
  const match = REFERENCE.exec(ref);
  const hex = match?.[1] ?? match?.[2];
  if (hex === undefined) throw new Error(`not a content reference: ${JSON.stringify(ref)}`);
  return { path: ref, hex };
}

function lockBytes(owner: LockOwner): Uint8Array {
  const { pid, hostname, startedAt, productVersion } = owner;
  return new TextEncoder().encode(`${pretty({ pid, hostname, startedAt, productVersion }, "")}\n`);
}

function parseLock(bytes: Uint8Array): LockOwner | undefined {
  try {
    const parsed = lockOwner.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return !hasCode(error, "ESRCH");
  }
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Creates the directory and any missing parents, syncing each parent after its new entry. */
async function ensureDirectory(path: string): Promise<void> {
  if (await exists(path)) return;
  const parent = dirname(path);
  if (parent !== path) await ensureDirectory(parent);
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    return;
  }
  await syncDirectory(parent);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Errors by which a file system says it doesn't do hard links. */
function refusesLinks(error: unknown): boolean {
  return ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].some((code) =>
    hasCode(error, code),
  );
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown error";
}

function ignoreMissing(error: unknown): void {
  if (!hasCode(error, "ENOENT")) throw error;
}
